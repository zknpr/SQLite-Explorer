
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createWorkerEndpoint } from '../../src/core/sqlite-db';
import { DatabaseInitConfig } from '../../src/core/types';

describe('Worker Endpoint Serialization', () => {
    it('should return serializable operations object from initializeDatabase', async () => {
        const endpoint = createWorkerEndpoint();
        const config: DatabaseInitConfig = {
            content: null,
            maxSize: 0,
            readOnlyMode: false
        };

        const result = await endpoint.initializeDatabase('test.db', config);

        // Verify that operations object is either empty or undefined
        // This ensures it is clonable via structured clone (postMessage) or omitted

        if (result.operations) {
             const funcProps = Object.keys(result.operations).filter(key => typeof (result.operations as any)[key] === 'function');
             assert.strictEqual(funcProps.length, 0, `Expected 0 function properties, found ${funcProps.length}: ${funcProps.join(', ')}`);
             assert.strictEqual(Object.keys(result.operations).length, 0, 'Expected operations object to be empty');
        } else {
            // It is undefined, which is also fine (and preferred now)
            assert.ok(true, 'operations is undefined');
        }
    });
});
