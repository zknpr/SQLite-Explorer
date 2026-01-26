declare module 'sql.js' {
  export interface Database {
    run(sql: string, params?: any[]): void;
    exec(sql: string, params?: any[]): QueryResults[];
    prepare(sql: string, params?: any[]): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface QueryResults {
    columns: string[];
    values: any[][];
  }

  export interface Statement {
    bind(values: any[]): boolean;
    step(): boolean;
    get(params?: any[]): any[];
    getColumnNames(): string[];
    getAsObject(params?: any[]): any;
    run(params?: any[]): void;
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
