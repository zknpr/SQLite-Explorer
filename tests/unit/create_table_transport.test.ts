import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { buildCreateTableSql } from '../../src/core/schema-ddl';
import type { ColumnDefinition, CreateTableOptions } from '../../src/core/types';

type Envelope = { content: { messageId: string; targetMethod: string; payload: unknown[] } };
const columns: ColumnDefinition[] = [{ name: 'id', type: 'INTEGER', primaryKey: true, notNull: false }];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalApi = Object.getOwnPropertyDescriptor(globalThis, 'acquireVsCodeApi');
let respond: (message: unknown) => void;
const received: unknown[][] = [];
function postMessage(envelope: Envelope) {
    // VS Code serializes webview messages as JSON. An undefined array slot
    // reaches the host as null, not as an omitted optional argument.
    const wire = JSON.parse(JSON.stringify(envelope)) as Envelope;
    received.push(wire.content.payload);
    respond({ kind: 'response', messageId: wire.content.messageId, success: true });
}
Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: () => ({ postMessage }) });
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    parent: { postMessage }, location: { ancestorOrigins: ['https://fixture.example'] }, addEventListener() {}
} });
after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalApi) Object.defineProperty(globalThis, 'acquireVsCodeApi', originalApi);
    else Reflect.deleteProperty(globalThis, 'acquireVsCodeApi');
});

for (const name of ['api', 'web-api']) it(`${name} omits absent Create Table options across JSON transport`, async () => {
    const modulePath = `../../core/ui/modules/${name}.js`;
    const client = await import(modulePath);
    respond = client.handleRpcResponse;
    received.length = 0;
    await client.backendApi.createTable('ordinary', columns);
    assert.deepEqual(received[0], ['ordinary', columns]);
    assert.doesNotMatch(buildCreateTableSql(received[0][0] as string, received[0][1] as ColumnDefinition[], received[0][2] as CreateTableOptions), /WITHOUT ROWID/);
    await client.backendApi.createTable('keyed', columns, { withoutRowid: true });
    assert.deepEqual(received[1], ['keyed', columns, { withoutRowid: true }]);
});
