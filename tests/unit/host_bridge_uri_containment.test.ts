import './vscode_mock_setup';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as vscode from 'vscode';

import { HostBridge } from '../../src/hostBridge';

interface FakeUri {
    scheme: string;
    authority: string;
    path: string;
    query: string;
    fragment: string;
    fsPath: string;
    with: () => FakeUri;
    toString: () => string;
    toJSON: () => string;
}

/**
 * The shared vscode mock's Uri.parse hardcodes a single scheme; containment logic
 * needs real scheme/authority/path decomposition, so this file installs a faithful
 * parser for its duration. fsPath is the raw path (POSIX hosts only), which matches
 * how these tests exercise path.resolve-based containment.
 */
function parseUriForTest(value: string): FakeUri {
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!match) throw new Error(`Test URI parser cannot parse: ${value}`);
    const [, scheme = '', authority = '', uriPath = '', query = '', fragment = ''] = match;
    const uri: FakeUri = {
        scheme,
        authority,
        path: uriPath,
        query,
        fragment,
        fsPath: uriPath,
        with: () => uri,
        toString: () => value,
        toJSON: () => value
    };
    return uri;
}

function createBridge(documentUriString: string): HostBridge {
    const document = {
        uri: parseUriForTest(documentUriString),
        documentKey: Promise.resolve('test-key'),
        databaseOperations: {},
        isReadOnlyMode: false
    };
    const provider = {
        webviews: new Map(),
        context: {},
        isReadOnly: false
    };
    return new HostBridge(provider as never, document as never);
}

type MutableWorkspace = {
    getWorkspaceFolder: (uri: unknown) => unknown;
    fs: { readFile: (uri: unknown) => Promise<Uint8Array> };
};

const uriApi = vscode.Uri as unknown as { parse: (value: string) => unknown };
const workspaceApi = vscode.workspace as unknown as MutableWorkspace;

const FILE_PAYLOAD = new Uint8Array([0xDB, 0x01]);

describe('HostBridge.readWorkspaceFileUri containment', () => {
    const original = {
        parse: uriApi.parse,
        getWorkspaceFolder: workspaceApi.getWorkspaceFolder,
        readFile: workspaceApi.fs.readFile
    };
    let readUris: string[];

    beforeEach(() => {
        readUris = [];
        uriApi.parse = parseUriForTest;
        workspaceApi.getWorkspaceFolder = () => undefined;
        workspaceApi.fs.readFile = async (uri: unknown) => {
            readUris.push(String((uri as { toString(): string }).toString()));
            return FILE_PAYLOAD;
        };
    });

    afterEach(() => {
        uriApi.parse = original.parse;
        workspaceApi.getWorkspaceFolder = original.getWorkspaceFolder;
        workspaceApi.fs.readFile = original.readFile;
    });

    it('allows a file: URI inside a workspace folder', async () => {
        workspaceApi.getWorkspaceFolder = () => ({ name: 'workspace' });
        const bridge = createBridge('file:///home/user/data/main.db');

        const result = await bridge.readWorkspaceFileUri('file:///home/user/elsewhere/blob.bin');
        assert.strictEqual(result, FILE_PAYLOAD);
        assert.deepStrictEqual(readUris, ['file:///home/user/elsewhere/blob.bin']);
    });

    it('allows a non-file URI inside a workspace folder (remote/virtual workspaces)', async () => {
        workspaceApi.getWorkspaceFolder = () => ({ name: 'repo' });
        const bridge = createBridge('vscode-vfs://github/owner/repo/main.db');

        const result = await bridge.readWorkspaceFileUri('vscode-vfs://github/owner/repo/assets/logo.png');
        assert.strictEqual(result, FILE_PAYLOAD);
        assert.strictEqual(readUris.length, 1);
    });

    it('allows a file: URI inside the document directory without a workspace', async () => {
        const bridge = createBridge('file:///home/user/data/main.db');

        const result = await bridge.readWorkspaceFileUri('file:///home/user/data/sub/blob.bin');
        assert.strictEqual(result, FILE_PAYLOAD);
        assert.strictEqual(readUris.length, 1);
    });

    it('rejects a file: URI outside workspace and document directory', async () => {
        const bridge = createBridge('file:///home/user/data/main.db');

        await assert.rejects(
            bridge.readWorkspaceFileUri('file:///etc/passwd'),
            /Access denied/
        );
        assert.strictEqual(readUris.length, 0);
    });

    it('rejects file: path traversal escaping the document directory', async () => {
        const bridge = createBridge('file:///home/user/data/main.db');

        await assert.rejects(
            bridge.readWorkspaceFileUri('file:///home/user/data/../../../etc/passwd'),
            /Access denied/
        );
        assert.strictEqual(readUris.length, 0);
    });

    it('rejects file: prefix spoofing of the document directory', async () => {
        const bridge = createBridge('file:///home/user/data/main.db');

        await assert.rejects(
            bridge.readWorkspaceFileUri('file:///home/user/data-evil/blob.bin'),
            /Access denied/
        );
        assert.strictEqual(readUris.length, 0);
    });

    it('rejects vscode-userdata: URIs (settings.json disclosure)', async () => {
        const bridge = createBridge('file:///home/user/data/main.db');

        await assert.rejects(
            bridge.readWorkspaceFileUri('vscode-userdata:/User/settings.json'),
            /Access denied/
        );
        assert.strictEqual(readUris.length, 0);
    });

    it('rejects the extension\'s own virtual scheme outright', async () => {
        const bridge = createBridge('file:///home/user/data/main.db');

        await assert.rejects(
            bridge.readWorkspaceFileUri('sqlite-explorer://other.db%20%3Cabc123%3E/cell/users/1/secret'),
            /Cannot read from scheme "sqlite-explorer"/
        );
        assert.strictEqual(readUris.length, 0);
    });

    it('still blocks http, https and data schemes', async () => {
        const bridge = createBridge('file:///home/user/data/main.db');

        for (const target of ['http://evil.example/x', 'https://evil.example/x', 'data:text/plain,x']) {
            await assert.rejects(
                bridge.readWorkspaceFileUri(target),
                /Cannot read from scheme/
            );
        }
        assert.strictEqual(readUris.length, 0);
    });

    it('allows remote explorer drags inside the remote document directory', async () => {
        const bridge = createBridge('vscode-remote://ssh-remote+box/home/user/data/main.db');

        const result = await bridge.readWorkspaceFileUri('vscode-remote://ssh-remote+box/home/user/data/img.png');
        assert.strictEqual(result, FILE_PAYLOAD);
        assert.strictEqual(readUris.length, 1);
    });

    it('rejects remote URIs outside the remote document directory', async () => {
        const bridge = createBridge('vscode-remote://ssh-remote+box/home/user/data/main.db');

        await assert.rejects(
            bridge.readWorkspaceFileUri('vscode-remote://ssh-remote+box/etc/passwd'),
            /Access denied/
        );
        assert.strictEqual(readUris.length, 0);
    });

    it('rejects a matching path on a different remote authority', async () => {
        const bridge = createBridge('vscode-remote://ssh-remote+box/home/user/data/main.db');

        await assert.rejects(
            bridge.readWorkspaceFileUri('vscode-remote://ssh-remote+other/home/user/data/img.png'),
            /Access denied/
        );
        assert.strictEqual(readUris.length, 0);
    });

    it('rejects a matching path on a different scheme than the document', async () => {
        const bridge = createBridge('vscode-remote://ssh-remote+box/home/user/data/main.db');

        await assert.rejects(
            bridge.readWorkspaceFileUri('vscode-test://ssh-remote+box/home/user/data/img.png'),
            /Access denied/
        );
        assert.strictEqual(readUris.length, 0);
    });

    it('rejects virtual-path traversal escaping the remote document directory', async () => {
        const bridge = createBridge('vscode-remote://ssh-remote+box/home/user/data/main.db');

        await assert.rejects(
            bridge.readWorkspaceFileUri('vscode-remote://ssh-remote+box/home/user/data/../../../etc/shadow'),
            /Access denied/
        );
        assert.strictEqual(readUris.length, 0);
    });

    it('rejects virtual-path prefix spoofing of the remote document directory', async () => {
        const bridge = createBridge('vscode-remote://ssh-remote+box/home/user/data/main.db');

        await assert.rejects(
            bridge.readWorkspaceFileUri('vscode-remote://ssh-remote+box/home/user/data-evil/img.png'),
            /Access denied/
        );
        assert.strictEqual(readUris.length, 0);
    });
});

describe('HostBridge history-replay surface removal', () => {
    // webviewMessageHandler dispatches any function-valued property by name, so the
    // security property is that these names are not functions on the bridge at all.
    it('exposes no applyEdits/undo/redo/commit/rollback methods over RPC', () => {
        const bridge = createBridge('file:///home/user/data/main.db') as unknown as Record<string, unknown>;

        for (const method of ['applyEdits', 'undo', 'redo', 'commit', 'rollback']) {
            assert.notStrictEqual(
                typeof bridge[method],
                'function',
                `HostBridge.${method} must not be RPC-dispatchable`
            );
        }
        // Sanity: the intentional undo entry points are still present.
        assert.strictEqual(typeof bridge['triggerUndo'], 'function');
        assert.strictEqual(typeof bridge['triggerRedo'], 'function');
    });
});
