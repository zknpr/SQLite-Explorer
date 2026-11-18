import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { mockVscode } from './mocks/vscode';
import {
    captureWorkspaceFileGeneration,
    replaceWorkspaceFile
} from '../../src/atomicWorkspaceWrite';

// A save through vscode.workspace.fs, as VS Code Web and virtual workspaces
// make it. The provider below behaves like VS Code's file service where it
// matters: rename(..., { overwrite: true }) onto an existing file deletes that
// file first and then renames, so for a moment the destination does not exist.

interface Uri { scheme: string; path: string; fragment: string; with(change: { path?: string }): Uri; toString(): string }
const uri = (path: string): Uri => ({
    scheme: 'vscode-vfs',
    path,
    fragment: '',
    with: change => uri(change.path ?? path),
    toString: () => `vscode-vfs://${path}`
});

const TARGET = uri('/repo/data.db');
const OLD = new TextEncoder().encode('old database image');
const NEW = new TextEncoder().encode('new database image, longer than the old one');

interface Hooks {
    beforeWrite?: (path: string) => void;
    beforeRename?: () => void;
    beforeDelete?: (path: string) => void;
}

function provider(hooks: Hooks = {}) {
    const files = new Map<string, { bytes: Uint8Array; mtime: number }>();
    const operations: string[] = [];
    let clock = 1;
    const missing = (path: string) => Object.assign(new Error(`FileNotFound: ${path}`), { code: 'FileNotFound' });
    const fs = {
        stat: async (target: Uri) => {
            const file = files.get(target.path);
            if (!file) throw missing(target.path);
            return { type: 1, ctime: 1, mtime: file.mtime, size: file.bytes.byteLength, permissions: undefined };
        },
        readFile: async (target: Uri) => {
            const file = files.get(target.path);
            if (!file) throw missing(target.path);
            return file.bytes.slice();
        },
        writeFile: async (target: Uri, bytes: Uint8Array) => {
            operations.push(`write ${target.path === TARGET.path ? 'destination' : 'sibling'}`);
            hooks.beforeWrite?.(target.path);
            files.set(target.path, { bytes: bytes.slice(), mtime: ++clock });
        },
        rename: async (from: Uri, to: Uri, options?: { overwrite?: boolean }) => {
            operations.push(`rename overwrite=${String(options?.overwrite)}`);
            hooks.beforeRename?.();
            if (files.has(to.path)) {
                if (!options?.overwrite) throw Object.assign(new Error(`FileExists: ${to.path}`), { code: 'FileExists' });
                files.delete(to.path);
                operations.push('destination deleted');
            }
            const file = files.get(from.path);
            if (!file) throw missing(from.path);
            files.delete(from.path);
            files.set(to.path, file);
        },
        delete: async (target: Uri) => {
            operations.push(`delete ${target.path === TARGET.path ? 'destination' : 'sibling'}`);
            hooks.beforeDelete?.(target.path);
            if (!files.delete(target.path)) throw missing(target.path);
        }
    };
    const siblings = () => [...files.keys()].filter(path => path !== TARGET.path);
    return { fs, files, operations, siblings };
}

describe('replacing a database through a workspace file system provider', () => {
    let originalFs: unknown;
    const install = (fs: unknown) => Object.defineProperty(mockVscode.workspace, 'fs', {
        value: fs, writable: true, configurable: true
    });
    beforeEach(() => { originalFs = mockVscode.workspace.fs; });
    afterEach(() => { install(originalFs); });

    it('writes an existing destination in place and never removes it', async () => {
        const store = provider();
        store.files.set(TARGET.path, { bytes: OLD, mtime: 1 });
        install(store.fs);
        const generation = await captureWorkspaceFileGeneration(TARGET as never);
        store.operations.length = 0;

        await replaceWorkspaceFile(TARGET as never, NEW, generation);

        assert.deepEqual(store.files.get(TARGET.path)?.bytes, NEW);
        assert.deepEqual(store.siblings(), []);
        assert.deepEqual(store.operations, ['write sibling', 'write destination', 'delete sibling']);
    });

    it('keeps the complete copy and names it when the destination write fails part-way', async () => {
        const failure = new Error('provider went away');
        const store = provider({
            beforeWrite: path => {
                if (path !== TARGET.path) return;
                // A provider may truncate before it rejects.
                store.files.set(TARGET.path, { bytes: new Uint8Array(0), mtime: 99 });
                throw failure;
            }
        });
        store.files.set(TARGET.path, { bytes: OLD, mtime: 1 });
        install(store.fs);
        const generation = await captureWorkspaceFileGeneration(TARGET as never);

        await assert.rejects(
            replaceWorkspaceFile(TARGET as never, NEW, generation),
            (error: Error) => {
                const [sibling] = store.siblings();
                assert.ok(sibling, 'the sibling copy must remain');
                assert.ok(error.message.includes(`vscode-vfs://${sibling}`), error.message);
                assert.equal(error.cause, failure);
                assert.deepEqual(store.files.get(sibling)?.bytes, NEW);
                return true;
            }
        );
        assert.equal(store.operations.includes('delete sibling'), false);
    });

    it('leaves the destination alone and removes its copy when the destination changed meanwhile', async () => {
        const store = provider({
            beforeWrite: path => {
                if (path !== TARGET.path) store.files.set(TARGET.path, { bytes: new TextEncoder().encode('someone else'), mtime: 50 });
            }
        });
        store.files.set(TARGET.path, { bytes: OLD, mtime: 1 });
        install(store.fs);
        const generation = await captureWorkspaceFileGeneration(TARGET as never);

        await assert.rejects(
            replaceWorkspaceFile(TARGET as never, NEW, generation),
            /destination changed while the database was being saved/i
        );
        assert.deepEqual(new TextDecoder().decode(store.files.get(TARGET.path)?.bytes), 'someone else');
        assert.deepEqual(store.siblings(), []);
        assert.equal(store.operations.includes('write destination'), false);
    });

    it('creates a new destination with a rename that cannot overwrite', async () => {
        const store = provider();
        install(store.fs);
        const generation = await captureWorkspaceFileGeneration(TARGET as never);
        assert.deepEqual(generation, { exists: false });

        await replaceWorkspaceFile(TARGET as never, NEW, generation);

        assert.deepEqual(store.files.get(TARGET.path)?.bytes, NEW);
        assert.deepEqual(store.siblings(), []);
        assert.deepEqual(store.operations, ['write sibling', 'rename overwrite=false']);
    });

    it('does not overwrite a destination that appears just before the rename', async () => {
        const store = provider({
            beforeRename: () => { store.files.set(TARGET.path, { bytes: OLD, mtime: 7 }); }
        });
        install(store.fs);
        const generation = await captureWorkspaceFileGeneration(TARGET as never);

        await assert.rejects(replaceWorkspaceFile(TARGET as never, NEW, generation), /FileExists/);
        assert.deepEqual(store.files.get(TARGET.path)?.bytes, OLD);
        assert.deepEqual(store.siblings(), []);
        assert.equal(store.operations.includes('destination deleted'), false);
    });

    it('reports a save as done when its copy cannot be removed afterwards', async () => {
        const busy = new Error('busy');
        const store = provider({ beforeDelete: () => { throw busy; } });
        store.files.set(TARGET.path, { bytes: OLD, mtime: 1 });
        install(store.fs);
        const generation = await captureWorkspaceFileGeneration(TARGET as never);
        const warnings: Array<{ message: string; error: unknown }> = [];

        await replaceWorkspaceFile(TARGET as never, NEW, generation, undefined, (message, error) => {
            warnings.push({ message, error });
        });

        assert.deepEqual(store.files.get(TARGET.path)?.bytes, NEW);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].error, busy);
        assert.ok(warnings[0].message.includes(`vscode-vfs://${store.siblings()[0]}`), warnings[0].message);
    });
});
