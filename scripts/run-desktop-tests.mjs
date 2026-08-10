import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

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

const vscodeVersion = versionMatch[1];
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

const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-explorer-desktop-'));

try {
  // One cache-aware download and one Extension Development Host launch for the
  // complete matrix. Do not add --disable-extensions: it disables the extension
  // under development and can make fallback-editor tests pass falsely.
  const vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
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
