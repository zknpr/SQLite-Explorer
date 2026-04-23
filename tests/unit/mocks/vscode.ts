
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
                toString: () => path,
                toJSON: () => path
            };
            return uri;
        },
        from: (components: { scheme: string, path: string, query?: string }) => ({
            scheme: components.scheme,
            path: components.path,
            query: components.query || '',
            toString: () => `${components.scheme}://${components.path}${components.query ? '?' + components.query : ''}`
        }),
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
        joinPath: (baseUri: any, ...pathSegments: string[]) => {
            const separator = baseUri.fsPath.endsWith('/') ? '' : '/';
            const joinedPath = baseUri.fsPath + separator + pathSegments.join('/');
            return {
                scheme: baseUri.scheme,
                authority: baseUri.authority,
                path: joinedPath,
                query: baseUri.query,
                fragment: baseUri.fragment,
                fsPath: joinedPath,
                with: () => ({}),
                toString: () => `${baseUri.scheme}://${joinedPath}`
            };
        }
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
    commands: {
        executeCommand: (command: string, ...args: any[]) => Promise.resolve()
    },
    window: {
        showInformationMessage: () => Promise.resolve(),
        showWarningMessage: () => Promise.resolve(),
        showErrorMessage: () => Promise.resolve(),
        showSaveDialog: () => Promise.resolve(),
        showOpenDialog: () => Promise.resolve(),
    },
    workspace: {
        _config: new Map<string, unknown>(),
        getConfiguration: function() {
            const store = (this as any)._config as Map<string, unknown>;
            return {
                get: (key: string, defaultValue?: unknown) => {
                    return store.has(key) ? store.get(key) : defaultValue;
                },
                update: () => Promise.resolve()
            };
        },
        getWorkspaceFolder: () => undefined,
        fs: {
            readFile: () => Promise.resolve(new Uint8Array()),
            writeFile: () => Promise.resolve()
        }
    },
    ViewColumn: {
        Two: 2
    },
    l10n: {
        t: (key: string, ...args: any[]) => key
    },
    env: {
        uriScheme: 'vscode',
        appName: 'VS Code',
        language: 'en',
        remoteName: undefined as string | undefined,
        uiKind: 2 // Desktop
    },
    UIKind: {
        Desktop: 2,
        Web: 1
    },
    ColorThemeKind: {
        Light: 1,
        Dark: 2,
        HighContrast: 3,
        HighContrastLight: 4
    }
};
