declare module 'sql.js' {
  export type SqlValue = number | string | Uint8Array | null;

  export interface Database {
    run(sql: string, params?: SqlValue[]): void;
    exec(sql: string, params?: SqlValue[]): QueryResults[];
    prepare(sql: string, params?: SqlValue[]): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface QueryResults {
    columns: string[];
    values: SqlValue[][];
  }

  export interface Statement {
    bind(values: SqlValue[]): boolean;
    step(): boolean;
    get(params?: SqlValue[]): SqlValue[];
    getColumnNames(): string[];
    getAsObject(params?: SqlValue[]): Record<string, SqlValue>;
    run(params?: SqlValue[]): void;
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
