const fs = require('fs');
let content = fs.readFileSync('tests/unit/databaseModel.test.ts', 'utf8');

const additionalTestCode = `
describe('DatabaseDocument error paths', () => {
    let DatabaseDocument: any;
    let originalShowErrorMessage: any;
    let errorMessage: string = '';
    let loggedError: any;
    let originalConsoleError: any;

    before(() => {
        const moduleCache = require('module')._cache;
        const workerFactoryPath = require('node:path').resolve(__dirname, '../../src/workerFactory.ts');
        moduleCache[workerFactoryPath] = {
            id: workerFactoryPath,
            filename: workerFactoryPath,
            loaded: true,
            exports: {
                createDatabaseConnection: () => {}
            }
        };

        const dbModel = require('../../src/databaseModel');
        DatabaseDocument = dbModel.DatabaseDocument;
    });

    beforeEach(() => {
        originalShowErrorMessage = mockVscode.window.showErrorMessage;
        errorMessage = '';
        (mockVscode as any).window.showErrorMessage = (msg: string) => {
            errorMessage = msg;
            return Promise.resolve();
        };
        (mockVscode as any).l10n = {
            t: (str: string, arg?: string) => arg ? str.replace('{0}', arg) : str
        };

        originalConsoleError = console.error;
        loggedError = undefined;
        console.error = (...args: any[]) => { loggedError = args; };
    });

    afterEach(() => {
         mockVscode.window.showErrorMessage = originalShowErrorMessage;
         console.error = originalConsoleError;
    });

    it('should show error message and log when redo fails with Error object', async () => {
        const uri = { toString: () => 'file:///test_redo_error.db', scheme: 'file' } as any;
        const dbOps = {
            undoModification: async () => {},
            redoModification: async () => { throw new Error('redo failed mock'); },
            dispose: () => {},
            isClosed: false
        } as any;

        let viewerProvider = {} as any;
        let establishConnection = () => ({ databaseOps: dbOps, isReadOnly: false });
        let workerMethods = { [Symbol.dispose]: () => {} };

        const doc = new DatabaseDocument(
            viewerProvider,
            uri,
            null,
            false,
            { databaseOps: dbOps },
            workerMethods,
            establishConnection
        );

        let undoCb: any;
        let redoCb: any;

        doc.onDidChange((e: any) => {
             undoCb = e.undo;
             redoCb = e.redo;
        });

        doc.recordModification({ label: 'test', description: 'test', modificationType: 'row_insert', targetTable: 't1' });

        if (undoCb) {
            await undoCb();
        }

        if (redoCb) {
            await redoCb();
        }

        assert.strictEqual(errorMessage, 'Redo failed: redo failed mock');
        assert.ok(loggedError);
        assert.strictEqual(loggedError[0], '[Redo] Failed:');
    });

    it('should show error message and log when redo fails with non-Error object', async () => {
        const uri = { toString: () => 'file:///test_redo_error2.db', scheme: 'file' } as any;
        const dbOps = {
            undoModification: async () => {},
            redoModification: async () => { throw 'string error mock'; },
            dispose: () => {},
            isClosed: false
        } as any;

        let viewerProvider = {} as any;
        let establishConnection = () => ({ databaseOps: dbOps, isReadOnly: false });
        let workerMethods = { [Symbol.dispose]: () => {} };

        const doc = new DatabaseDocument(
            viewerProvider,
            uri,
            null,
            false,
            { databaseOps: dbOps },
            workerMethods,
            establishConnection
        );

        let undoCb: any;
        let redoCb: any;

        doc.onDidChange((e: any) => {
             undoCb = e.undo;
             redoCb = e.redo;
        });

        doc.recordModification({ label: 'test', description: 'test', modificationType: 'row_insert', targetTable: 't1' });

        if (undoCb) {
            await undoCb();
        }

        if (redoCb) {
            await redoCb();
        }

        assert.strictEqual(errorMessage, 'Redo failed: string error mock');
        assert.ok(loggedError);
        assert.strictEqual(loggedError[0], '[Redo] Failed:');
    });
});
`;

content = content.replace("import { describe, it, before, after, beforeEach } from 'node:test';", "import { describe, it, before, after, beforeEach, afterEach } from 'node:test';");

fs.writeFileSync('tests/unit/databaseModel.test.ts', content + '\n\n' + additionalTestCode);
