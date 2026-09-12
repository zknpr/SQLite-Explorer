import './vscode_mock_setup';
import assert from 'node:assert/strict';
import path from 'node:path';
import { it } from 'node:test';
import { NativeWorkerProcess } from '../../src/nativeWorker';
import { prepareReadQuery } from '../../src/core/sql-workspace';

it('cancels dispatched native Explain on the primary connection and restores its state and limits', async context => {
    const target = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
        : process.platform === 'linux' ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
        : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
    if (!target) { context.skip('No bundled runtime for this platform'); return; }
    const root = process.cwd();
    const directory = path.join(root, 'natives', target);
    const suffix = process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so';
    const worker = new NativeWorkerProcess(path.join(directory, process.platform === 'win32' ? 'tjs.exe' : 'tjs'), path.join(root, 'natives/native-worker.js'));
    const library = path.join(directory, `query-plan.${suffix}`);
    const plan = (sql: string, timeoutMs = 10000) => worker.call<string>('workspaceQueryPlan', [
        'SELECT sqlite_explorer_query_plan(?) AS plan', [sql], library, timeoutMs
    ], 12000);
    const query = async (sql: string) => (await worker.call<{ values: unknown[][] }>('query', [sql])).values;
    await worker.start();
    try {
        await worker.call('openMemory');
        await worker.call('run', ['CREATE TABLE plan_main(value INTEGER)']);
        await worker.call('run', ['CREATE TEMP TABLE plan_temp(value INTEGER)']);
        await worker.call('run', ['INSERT INTO plan_temp VALUES (7)']);
        await worker.call('run', ['BEGIN']);
        await worker.call('run', ['INSERT INTO plan_main VALUES (7)']);
        await worker.call('run', ['CREATE INDEX plan_pending ON plan_main(value)']);
        const sql = 'SELECT abs(-9223372036854775808) FROM plan_main INDEXED BY plan_pending JOIN temp.plan_temp USING (value)';
        assert.deepEqual(JSON.parse(await plan(sql)), await query(`EXPLAIN QUERY PLAN ${sql}`),
            'Explain sees TEMP and pending DDL without evaluating the overflowing SELECT');

        const wideSql = 'SELECT ' + Array.from({ length: 1400 }, (_, index) => `(SELECT max(value) FROM plan_main) AS c${index}`).join(',');
        assert.doesNotThrow(() => prepareReadQuery(wideSql), 'the cancellation fixture must fit the SQL workspace input policy');
        assert.equal(JSON.parse(await plan(wideSql)).length, 1001);
        let accepted = false;
        // A fast machine can finish before the cancellation reaches the worker.
        // Retry that benign race, but require a positive acknowledgement from an
        // active request; aborting an already-resolved promise proves nothing.
        for (let attempt = 0; attempt < 8 && !accepted; attempt++) {
            const pending = plan(wideSql);
            const result = pending.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
            const correlationId = (worker as unknown as { messageId: number }).messageId;
            await new Promise(resolve => setTimeout(resolve, 1));
            const started = performance.now();
            const cancellation = await worker.call<{ cancelled: boolean }>('cancel', [correlationId]);
            const settled = await result;
            if (!cancellation.cancelled) {
                assert.equal(settled.error, undefined);
                continue;
            }
            accepted = true;
            assert.ok(settled.error instanceof Error);
            assert.equal(settled.error.name, 'AbortError');
            const elapsed = performance.now() - started;
            assert.ok(elapsed < 2000, `cancellation took ${elapsed} ms with a 10000 ms deadline`);
            context.diagnostic(`Acknowledged in-flight Explain cancellation settled in ${elapsed.toFixed(3)} ms`);
        }
        assert.equal(accepted, true, 'must cancel an active Explain, not only pre-aborted or completed work');
        assert.deepEqual(await query('SELECT value FROM plan_main'), [[7]]);
        assert.deepEqual(await query('SELECT value FROM temp.plan_temp'), [[7]]);
        assert.deepEqual(await query("SELECT name FROM main.sqlite_schema WHERE name = 'plan_pending'"), [['plan_pending']]);
        assert.deepEqual(await query('SELECT length(zeroblob(2097152))'), [[2097152]], 'cancellation restores the length limit');

        await assert.rejects(plan(wideSql, 1), /timed out/i);
        assert.deepEqual(await query('SELECT length(zeroblob(2097152))'), [[2097152]], 'the deadline is cleared and limits are restored');
        await worker.call('run', ['ROLLBACK']);
        assert.deepEqual(await query('SELECT value FROM plan_main'), [], 'cancellation and deadline preserve the pending transaction for rollback');
        assert.deepEqual(await query("SELECT name FROM main.sqlite_schema WHERE name = 'plan_pending'"), []);
        assert.deepEqual(await query('SELECT value FROM temp.plan_temp'), [[7]]);
        assert.deepEqual(JSON.parse(await plan('SELECT 42')), await query('EXPLAIN QUERY PLAN SELECT 42'));
    } finally { worker.stop(); }
});
