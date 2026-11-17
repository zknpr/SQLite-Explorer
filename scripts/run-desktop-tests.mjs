import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { assertRuntimeVersion, runtimeVersion } from './vscode-runtime.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(scriptDirectory, '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(extensionDevelopmentPath, 'package.json'), 'utf8')
);
const engineRange = manifest.engines?.vscode;
const versionMatch = typeof engineRange === 'string'
  ? /^\^(\d+\.\d+\.\d+)$/.exec(engineRange)
  : null;
if (!versionMatch) {
  throw new Error(`Expected engines.vscode to be an exact caret pin, received ${engineRange}`);
}

// The lane runs against the oldest VS Code the extension supports, unless
// another one is named: `--vscode stable` or `--vscode 1.145.0`. The editor's
// runtime changes with its version, and with it what the extension host sends
// the native engine. A lane held to the oldest version did not see VS Code
// 1.145 write a format the engine could not read.
const named = process.argv.indexOf('--vscode');
const vscodeVersion = named === -1 ? versionMatch[1] : process.argv[named + 1];
const exactVersion = typeof vscodeVersion === 'string' && /^\d+\.\d+\.\d+$/.test(vscodeVersion);
if (!exactVersion && vscodeVersion !== 'stable') {
  throw new Error(`Expected --vscode to name "stable" or an exact version, received ${vscodeVersion}`);
}
const extensionTestsPath = path.join(
  extensionDevelopmentPath,
  '.desktop-test-out',
  'suite',
  'index.js'
);
if (!fs.existsSync(path.join(extensionDevelopmentPath, 'out', 'extension.js'))) {
  throw new Error('Missing out/extension.js; run node scripts/build.mjs first');
}
if (!fs.existsSync(extensionTestsPath)) {
  throw new Error('Desktop tests are not compiled; run npm run compile:desktop-tests first');
}

// Cached apps can update in place while their directory keeps the old version.
// Validate the selected application before launching or allocating test state.
const vscodeExecutablePath = process.env.VSCODE_TEST_EXECUTABLE_PATH
  ?? await downloadAndUnzipVSCode(vscodeVersion);
const actualVersion = exactVersion
  ? assertRuntimeVersion(vscodeExecutablePath, vscodeVersion)
  : runtimeVersion(vscodeExecutablePath).version;
console.log(`[Desktop tests] Verified VS Code ${actualVersion} at ${vscodeExecutablePath}`);

const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-explorer-desktop-'));

try {
  // One Extension Development Host launch for the complete matrix.
  // Do not add --disable-extensions: it disables the extension
  // under development and can make fallback-editor tests pass falsely.
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      '--disable-workspace-trust',
      '--disable-updates',
      '--skip-release-notes',
      '--skip-welcome'
    ]
  });
} finally {
  fs.rmSync(workspacePath, { recursive: true, force: true });
}
