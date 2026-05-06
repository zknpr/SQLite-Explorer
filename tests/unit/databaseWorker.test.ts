import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { setupWorkerMessageHandlers } from '../../src/databaseWorker';

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;

describe('databaseWorker', () => {
    test('with parentPort: routes unhandled messages and errors', async () => {
        let messages: any[] = [];
        let messageHandler: any;
        let errorHandler: any;

        const mockParentPort = {
            postMessage: (msg: any) => messages.push(msg),
            on: (event: string, handler: any) => {
                if (event === 'message') messageHandler = handler;
                if (event === 'error') errorHandler = handler;
            }
        };

        const mockEndpoint: Record<string, (...args: any[]) => any> = {
            someMethod: () => 'result'
        };

        // Note: we can't fully mock processProtocolMessage easily since it's imported inside databaseWorker.ts directly.
        // But processProtocolMessage checks if the method exists on the endpoint.
        // Wait, processProtocolMessage requires the envelope to be in `{ id, method, args }` format.
        // Let's pass an invalid envelope to test the unhandled route.

        setupWorkerMessageHandlers(mockParentPort, mockEndpoint);

        // Handled message test is hard because processProtocolMessage needs exact format.
        // Let's just test what the PR reviewer asked for:
        // "the error/unhandled-message routing branches"

        assert.ok(messageHandler, 'Message handler should be registered');

        // Unhandled message test (warning log should be sent via postMessage)
        messages = [];
        messageHandler({ kind: 'unknown' });
        assert.ok(messages.some(m => m.kind === 'log' && m.level === 'warn' && m.args.includes('[DatabaseWorker] Unrecognized message:')));

        // Error handling test
        assert.ok(errorHandler, 'Error handler should be registered');
        messages = [];
        errorHandler(new Error('test port error'));
        assert.ok(messages.some(m => m.kind === 'log' && m.level === 'error' && m.args.includes('test port error')));
    });

    test('without parentPort: falls back to console.error', async () => {
        let errorLogs: any[] = [];
        let warnLogs: any[] = [];
        let logLogs: any[] = [];

        console.error = (...args: any[]) => errorLogs.push(args);
        console.warn = (...args: any[]) => warnLogs.push(args);
        console.log = (...args: any[]) => logLogs.push(args);

        try {
            setupWorkerMessageHandlers(null, {});

            assert.ok(errorLogs.some(l => l.includes('[DatabaseWorker] No parent port - invalid execution context')));
        } finally {
            console.error = originalConsoleError;
            console.warn = originalConsoleWarn;
            console.log = originalConsoleLog;
        }
    });
});
