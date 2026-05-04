import Module from 'module';
import { mockVscode } from './mocks/vscode';

(mockVscode as any).extensions = {
    getExtension: () => ({ extensionKind: 2 })
};

// We must also mock workerFactory globally so any import from any module will grab the mock
// before TSX tries to transform it and eval it.
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    if (request === 'vscode') {
        return mockVscode;
    }
    if (request.includes('workerFactory')) {
        return {
            createDatabaseConnection: () => {}
        };
    }
    return originalLoad(request, parent, isMain);
};
