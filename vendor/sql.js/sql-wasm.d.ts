import type { SqlJsConfig, SqlJsStatic } from 'sql.js';

declare function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;

export default initSqlJs;
