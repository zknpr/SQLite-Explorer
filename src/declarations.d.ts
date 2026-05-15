declare module 'sql.js' {
  export interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string, params?: unknown[]): QueryResults[];
    prepare(sql: string, params?: unknown[]): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface QueryResults {
    columns: string[];
    values: unknown[][];
  }

  export interface Statement {
    bind(values: unknown[]): boolean;
    step(): boolean;
    get(params?: unknown[]): unknown[];
    getColumnNames(): string[];
    getAsObject(params?: unknown[]): Record<string, unknown>;
    run(params?: unknown[]): void;
    free(): void;
  }

  export interface SqlJsConfig {
    locateFile?: (filename: string) => string;
    wasmBinary?: ArrayBuffer;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array | ArrayBuffer) => Database;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
