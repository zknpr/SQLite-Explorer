#!/usr/bin/env node

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const DEFAULT_SIZE_MIB = 256;
const MAX_SQLITE_VALUE_BYTES = 1_000_000_000;

function usage() {
  return `Usage:
  node scripts/generate-large-cell-fixture.mjs --output <path> [--size-mib <1..900>]

Creates a SQLite database with table large_cells containing one exact-size
ASCII BLOB and one exact-size ASCII TEXT value. The default is 256 MiB per cell.
The output path must not already exist.`;
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parsePositiveInteger(raw, option) {
  if (!/^\d+$/.test(raw)) throw new Error(`${option} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return value;
}

function parseArgs(argv) {
  let output;
  let sizeMib = DEFAULT_SIZE_MIB;
  let help = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--output') {
      output = requireValue(argv, index, '--output');
      index++;
    } else if (argument.startsWith('--output=')) {
      output = argument.slice('--output='.length);
      if (!output) throw new Error('--output requires a value');
    } else if (argument === '--size-mib') {
      sizeMib = parsePositiveInteger(requireValue(argv, index, '--size-mib'), '--size-mib');
      index++;
    } else if (argument.startsWith('--size-mib=')) {
      sizeMib = parsePositiveInteger(argument.slice('--size-mib='.length), '--size-mib');
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (help) return { help: true };
  if (!output) throw new Error('--output is required');

  const sizeBytes = sizeMib * 1024 * 1024;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes >= MAX_SQLITE_VALUE_BYTES) {
    throw new Error(
      `--size-mib must produce fewer than ${MAX_SQLITE_VALUE_BYTES} bytes per SQLite value`
    );
  }

  return {
    help: false,
    output: path.resolve(output),
    sizeMib,
    sizeBytes
  };
}

async function runSqlite(databasePath, sql) {
  const sqlitePath = process.env.SQLITE3_PATH || 'sqlite3';
  const child = spawn(sqlitePath, ['-batch', '-bail', databasePath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  child.stdin.end(sql);
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  if (code !== 0 || signal !== null) {
    throw new Error(
      `sqlite3 failed (exit=${String(code)}, signal=${String(signal)}): ${stderr.trim() || stdout.trim()}`
    );
  }
  return stdout;
}

async function assertOutputAbsent(outputPath) {
  try {
    await fs.lstat(outputPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Output already exists: ${outputPath}`);
}

async function generate(options) {
  await assertOutputAbsent(options.output);
  await fs.mkdir(path.dirname(options.output), { recursive: true });

  // printf('%.*c', N, X) is SQLite's bounded way to repeat one ASCII character.
  // Casting the B row to BLOB makes both cells text-like at the byte level while
  // preserving distinct SQLite storage classes for inspector and transport tests.
  const sql = `
.timeout 60000
PRAGMA journal_mode=OFF;
PRAGMA synchronous=OFF;
PRAGMA temp_store=MEMORY;
PRAGMA locking_mode=EXCLUSIVE;
BEGIN IMMEDIATE;
CREATE TABLE large_cells (
  kind TEXT PRIMARY KEY,
  payload
);
INSERT INTO large_cells(kind, payload)
VALUES ('blob', CAST(printf('%.*c', ${options.sizeBytes}, 'B') AS BLOB));
INSERT INTO large_cells(kind, payload)
VALUES ('text', printf('%.*c', ${options.sizeBytes}, 'T'));
COMMIT;
`;

  const startedAt = performance.now();
  try {
    await runSqlite(options.output, sql);
    const verification = await runSqlite(
      options.output,
      "SELECT kind || '|' || typeof(payload) || '|' || length(CAST(payload AS BLOB)) FROM large_cells ORDER BY kind;\n"
    );
    const expected = [
      `blob|blob|${options.sizeBytes}`,
      `text|text|${options.sizeBytes}`
    ];
    const actual = verification.trim().split('\n');
    if (actual.length !== expected.length || actual.some((line, index) => line !== expected[index])) {
      throw new Error(`Fixture verification failed: ${JSON.stringify(actual)}`);
    }
    const stat = await fs.stat(options.output);
    process.stdout.write(`LARGE_CELL_FIXTURE ${JSON.stringify({
      output: options.output,
      cellBytes: options.sizeBytes,
      databaseBytes: stat.size,
      elapsedMs: performance.now() - startedAt
    })}\n`);
  } catch (error) {
    await fs.rm(options.output, { force: true });
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await generate(options);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
