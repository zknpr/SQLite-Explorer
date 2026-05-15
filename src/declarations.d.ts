declare module 'sql.js' {
  export type SqlValue = number | string | Uint8Array | null;
  export type ParamsObject = Record<string, SqlValue>;
  export type BindParams = SqlValue[] | ParamsObject | null;

  export interface Database {
    run(sql: string, params?: BindParams): void;
    exec(sql: string, params?: BindParams): QueryResults[];
    prepare(sql: string, params?: BindParams): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface QueryResults {
    columns: string[];
    values: SqlValue[][];
  }

  export interface Statement {
    bind(values?: BindParams): boolean;
    step(): boolean;
    get(params?: BindParams): SqlValue[];
    getColumnNames(): string[];
    getAsObject(params?: BindParams): Record<string, SqlValue>;
    run(params?: BindParams): void;
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
