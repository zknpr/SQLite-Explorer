
import { EventEmitter } from 'events';

class classEventEmitter {
    private _listeners: Function[] = [];
    event = (listener: Function) => {
        this._listeners.push(listener);
        return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    }
    fire(data: any) {
        this._listeners.forEach(l => l(data));
    }
}

export const mockVscode = {
    Uri: {
        parse: (path: string) => {
            // Simple mock: assumes path starts with scheme or is just a path string
            // For this test, we mostly care about the 'path' property
            const uri = {
                scheme: 'vscode-sqlite',
                authority: '',
                path: path.startsWith('vscode-sqlite://') ? path.substring(16) : path,
                query: '',
                fragment: '',
                fsPath: path,
                with: () => uri,
                toString: () => path
            };
            return uri;
        },
        file: (path: string) => ({
            scheme: 'file',
            authority: '',
            path,
            query: '',
            fragment: '',
            fsPath: path,
            with: () => ({}),
            toString: () => `file://${path}`
        }),
        joinPath: (uri: any, ...parts: string[]) => ({
            scheme: uri.scheme,
            authority: uri.authority,
            path: uri.path + '/' + parts.join('/'),
            query: '',
            fragment: '',
            fsPath: uri.fsPath + '/' + parts.join('/'),
            with: () => ({}),
            toString: () => uri.toString() + '/' + parts.join('/')
        })
    },
    FileSystemError: {
        FileNotFound: (uri: any) => {
            const err = new Error(`FileNotFound: ${uri?.path || uri}`);
            (err as any).code = 'FileNotFound';
            return err;
        },
        FileExists: (uri: any) => new Error(`FileExists: ${uri?.path || uri}`),
        FileNotADirectory: (uri: any) => new Error(`FileNotADirectory: ${uri?.path || uri}`),
        FileIsADirectory: (uri: any) => new Error(`FileIsADirectory: ${uri?.path || uri}`),
        NoPermissions: (msg?: string) => new Error(msg || 'NoPermissions'),
        Unavailable: (msg: string) => new Error(msg || 'Unavailable')
    },
    FileChangeType: {
        Changed: 1,
        Created: 2,
        Deleted: 3
    },
    FileType: {
        Unknown: 0,
        File: 1,
        Directory: 2,
        SymbolicLink: 64
    },
    FilePermission: {
        Readonly: 1
    },
    EventEmitter: classEventEmitter,
    Disposable: class {
        constructor(callBack: () => void) {}
        dispose() {}
    },
    window: {
        showErrorMessage: async (msg: string) => console.log('Mock showErrorMessage:', msg),
        showInformationMessage: async (msg: string) => console.log('Mock showInformationMessage:', msg),
        showQuickPick: async (items: any[], options: any) => items[0], // Return first item by default
        showSaveDialog: async (options: any) => mockVscode.Uri.file('/tmp/mock_export.csv') // Return a mock file URI
    },
    workspace: {
        fs: {
            writeFile: async (uri: any, content: Uint8Array) => console.log('Mock writeFile:', uri.toString(), content.length)
        },
        getWorkspaceFolder: (uri: any) => ({ uri: { fsPath: '/mock/workspace' } })
    },
    l10n: {
        t: (key: string) => key
    }
};
