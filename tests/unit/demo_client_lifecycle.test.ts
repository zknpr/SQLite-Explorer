import assert from 'node:assert';
import path from 'node:path';
import { describe, it } from 'node:test';
import esbuild from 'esbuild';

let demoLifecycleModulePromise: Promise<Record<string, any>> | undefined;

function loadDemoLifecycleModule(): Promise<Record<string, any>> {
    demoLifecycleModulePromise ??= (async () => {
        // Bundle only the framework-free lifecycle boundary. The resolver
        // guard keeps root unit tests independent of website-only packages.
        const rendered = await esbuild.build({
            entryPoints: [path.resolve(process.cwd(), 'website/app/demo/lifecycle.ts')],
            bundle: true,
            platform: 'node',
            format: 'esm',
            target: 'node20',
            plugins: [{
                name: 'reject-demo-ui-dependencies',
                setup(build) {
                    build.onResolve(
                        { filter: /^(?:react(?:\/jsx-runtime)?|lucide-react)$/ },
                        args => ({
                            errors: [{
                                text: `Demo lifecycle helpers must not depend on ${args.path}`
                            }]
                        })
                    );
                }
            }],
            write: false
        });
        assert.strictEqual(rendered.outputFiles.length, 1);
        const source = Buffer.from(rendered.outputFiles[0].text).toString('base64');
        return import(`data:text/javascript;base64,${source}`);
    })();
    return demoLifecycleModulePromise;
}

describe('DemoClient worker lifecycle', () => {
    it('cleans up a failed browser download and revokes its object URL', async () => {
        const DemoClientModule = await loadDemoLifecycleModule();
        const originalUrl = globalThis.URL;
        const originalDocument = (globalThis as any).document;
        let appended = false;
        let removals = 0;
        const revoked: string[] = [];
        (globalThis as any).URL = {
            createObjectURL() { return 'blob:demo-download'; },
            revokeObjectURL(url: string) { revoked.push(url); }
        };
        (globalThis as any).document = {
            createElement() {
                return {
                    href: '',
                    download: '',
                    click() { throw new Error('download blocked'); }
                };
            },
            body: {
                appendChild() { appended = true; },
                removeChild() {
                    removals++;
                    appended = false;
                }
            }
        };

        try {
            assert.throws(
                () => DemoClientModule.triggerBrowserDownload({}, 'demo.db'),
                /download blocked/
            );
            assert.strictEqual(appended, false);
            assert.strictEqual(removals, 1);
            assert.deepStrictEqual(revoked, ['blob:demo-download']);
        } finally {
            (globalThis as any).URL = originalUrl;
            if (originalDocument === undefined) delete (globalThis as any).document;
            else (globalThis as any).document = originalDocument;
        }
    });

    it('rejects every pending RPC before terminating a retired worker', async () => {
        const DemoClientModule = await loadDemoLifecycleModule();
        const pending = new Map<string, any>();
        const first = new Promise((resolve, reject) => {
            pending.set('first', { method: 'fetchSchema', resolve, reject });
        });
        const second = new Promise((resolve, reject) => {
            pending.set('second', { method: 'fetchTableData', resolve, reject });
        });
        const events: string[] = [];
        const worker = {
            terminate() {
                events.push('terminate');
            }
        };
        for (const call of pending.values()) {
            const reject = call.reject;
            call.reject = (error: Error) => {
                events.push(`reject:${call.method}`);
                reject(error);
            };
        }
        const retire = (DemoClientModule as any).retireDemoWorker;

        retire(worker, pending, new Error('Database worker was replaced'));

        assert.deepStrictEqual(events, [
            'reject:fetchSchema',
            'reject:fetchTableData',
            'terminate'
        ]);
        assert.strictEqual(pending.size, 0);
        await assert.rejects(first, /worker was replaced/i);
        await assert.rejects(second, /worker was replaced/i);
    });

    it('reloads from the retained source and propagates initialization failure', async () => {
        const DemoClientModule = await loadDemoLifecycleModule();
        const source = new Uint8Array([1, 2, 3]);
        const calls: unknown[][] = [];
        const reload = (DemoClientModule as any).reloadDemoDatabase;

        await reload(source, 'retained.db', async (...args: unknown[]) => {
            calls.push(args);
        });
        assert.deepStrictEqual(calls, [[source, 'retained.db']]);

        await assert.rejects(
            reload(source, 'retained.db', async () => {
                throw new Error('authoritative reopen failed');
            }),
            /authoritative reopen failed/
        );
        await assert.rejects(
            reload(null, 'retained.db', async () => {}),
            /original database source is unavailable/i
        );
    });
});
