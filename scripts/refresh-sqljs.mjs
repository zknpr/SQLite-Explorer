/**
 * sql.js now includes SQLite Explorer's bounded plan reader. Rebuild its pinned
 * upstream source and the shared C helper together; the old upstream-only
 * workflow artifacts do not contain the reader and must not replace this build.
 *
 * Requires Emscripten 5.0.0 and Zig 0.16.0. Accepts the same options as:
 *   node scripts/build-query-plan.mjs --sqljs-source /path/to/sql.js-checkout
 */
import { buildQueryPlanRuntime } from './build-query-plan.mjs';

buildQueryPlanRuntime().catch(error => { console.error(error); process.exitCode = 1; });
