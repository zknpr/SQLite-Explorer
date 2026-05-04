import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import Module from 'module';

const originalLoad = (Module as any)._load;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;

describe('databaseWorker', () => {
    let mockParentPort: any = null;

    before(() => {
        // Mock the imports before loading the module
        (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
            if (request === './platform/threadPool') {
                return {
                    get parentPort() { return mockParentPort; }
                };
            }
            if (request === './core/rpc') {
                return {
                    processProtocolMessage: (envelope: any, endpoint: any, postResponse: any) => {
                        if (envelope === 'handled') return true;
                        if (envelope === 'unhandled') return false;
                        if (envelope === 'respond') {
                            postResponse('response', []);
                            return true;
                        }
                        return false;
                    }
                };
            }
            if (request === './core/sqlite-db') {
                return {
                    createWorkerEndpoint: () => ({ mockedEndpoint: true })
                };
            }
            return originalLoad(request, parent, isMain);
        };
    });

    after(() => {
        // Restore original loader
        (Module as any)._load = originalLoad;
    });

    test('with parentPort', async () => {
        let messages: any[] = [];
        let messageHandler: any;
        let errorHandler: any;

        mockParentPort = {
            postMessage: (msg: any) => messages.push(msg),
            on: (event: string, handler: any) => {
                if (event === 'message') messageHandler = handler;
                if (event === 'error') errorHandler = handler;
            }
        };

        // Load the worker
        require('../../src/databaseWorker.ts');

        assert.ok(messages.some(m => m.kind === 'log' && m.level === 'log' && m.args.includes('[DatabaseWorker] Starting...')));
        assert.ok(messages.some(m => m.kind === 'log' && m.level === 'log' && m.args.includes('[DatabaseWorker] Ready for connections')));

        // Handled message test
        assert.ok(messageHandler);
        messageHandler('handled');

        // Unhandled message test (warning log should be sent via postMessage)
        messages = [];
        messageHandler({ kind: 'unknown' });
        assert.ok(messages.some(m => m.kind === 'log' && m.level === 'warn' && m.args.includes('[DatabaseWorker] Unrecognized message:')));

        // Respond message test
        messages = [];
        messageHandler('respond');
        assert.ok(messages.includes('response'));

        // Error handling test
        assert.ok(errorHandler);
        messages = [];
        errorHandler(new Error('test error'));
        assert.ok(messages.some(m => m.kind === 'log' && m.level === 'error' && m.args.includes('test error')));
    });

    test('without parentPort', async () => {
        mockParentPort = null;
        let errorLogs: any[] = [];
        let warnLogs: any[] = [];
        let logLogs: any[] = [];

        console.error = (...args: any[]) => errorLogs.push(args);
        console.warn = (...args: any[]) => warnLogs.push(args);
        console.log = (...args: any[]) => logLogs.push(args);

        try {
            // Clear module cache to re-evaluate top level code
            delete require.cache[require.resolve('../../src/databaseWorker.ts')];

            require('../../src/databaseWorker.ts');

            assert.ok(logLogs.some(l => l.includes('[DatabaseWorker] Starting...')));
            assert.ok(errorLogs.some(l => l.includes('[DatabaseWorker] No parent port - invalid execution context')));
        } finally {
            console.error = originalConsoleError;
            console.warn = originalConsoleWarn;
            console.log = originalConsoleLog;
        }
    });
});
