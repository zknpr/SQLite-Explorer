
import Module from 'module';
import { mockVscode } from './mocks/vscode';

// @ts-ignore
const originalLoad = Module._load;

// @ts-ignore
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return mockVscode;
    }
    return originalLoad(request, parent, isMain);
};
