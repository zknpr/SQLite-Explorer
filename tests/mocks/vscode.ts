
export class Uri {
    scheme: string;
    authority: string;
    path: string;
    query: string;
    fragment: string;

    constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
        this.scheme = scheme;
        this.authority = authority;
        this.path = path;
        this.query = query;
        this.fragment = fragment;
    }

    static parse(str: string) {
        // simple parser
        // We assume file URI or similar
        // For tests, we can just return a dummy
        const url = new URL(str);
        return new Uri(url.protocol.replace(":", ""), url.host, url.pathname, url.search, url.hash);
    }

    static file(path: string) {
        return new Uri("file", "", path, "", "");
    }

    with(change: any) {
        return new Uri(
            change.scheme || this.scheme,
            change.authority || this.authority,
            change.path || this.path,
            change.query || this.query,
            change.fragment || this.fragment
        );
    }

    toString() {
        return `${this.scheme}://${this.authority}${this.path}`;
    }

    fsPath() {
        return this.path;
    }
}

export class FileSystemError extends Error {
    code: string;
    constructor(message: string, code: string) {
        super(message);
        this.code = code;
    }
    static FileNotFound(uri?: Uri) { return new FileSystemError("File not found", "FileNotFound"); }
    static NoPermissions(message?: string) { return new FileSystemError(message || "No permissions", "NoPermissions"); }
    static Unavailable(message?: string) { return new FileSystemError(message || "Unavailable", "Unavailable"); }
}

export class EventEmitter<T> {
    listeners: Array<(e: T) => any> = [];
    event = (listener: (e: T) => any) => {
        this.listeners.push(listener);
        return { dispose: () => {} };
    }
    fire(data: T) { this.listeners.forEach(l => l(data)); }
    dispose() { this.listeners = []; }
}

export class Disposable {
    callOnDispose: () => void;
    constructor(callOnDispose: () => void) { this.callOnDispose = callOnDispose; }
    dispose() { if (this.callOnDispose) this.callOnDispose(); }
}

export enum FileType { File = 1, Directory = 2 }
export enum FilePermission { Readonly = 1 }
export enum FileChangeType { Changed = 1, Created = 2, Deleted = 3 }
