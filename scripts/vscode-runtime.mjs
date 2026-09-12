import fs from 'node:fs';
import path from 'node:path';

/** Resolve the application package belonging to a desktop VS Code executable. */
export function applicationRoot(executablePath) {
  if (typeof executablePath !== 'string' || executablePath.length === 0) {
    throw new Error('Expected a VS Code executable path');
  }
  const executable = fs.realpathSync(executablePath);
  if (!fs.statSync(executable).isFile()) {
    throw new Error(`VS Code executable is not a file: ${executable}`);
  }
  const directory = path.dirname(executable);
  const candidates = path.basename(directory) === 'MacOS' && path.basename(path.dirname(directory)) === 'Contents'
    ? [path.resolve(directory, '..', 'Resources', 'app')]
    : [path.join(directory, 'resources', 'app')];

  if (path.extname(executable).toLowerCase() === '.exe') {
    // Recent Windows archives keep resources below a commit-named directory.
    // Never choose an arbitrary retained version after an application update.
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[0-9a-f]{10}$/i.test(entry.name)) {
        candidates.push(path.join(directory, entry.name, 'resources', 'app'));
      }
    }
  }
  const roots = candidates.filter(candidate => fs.existsSync(path.join(candidate, 'package.json')));
  if (roots.length === 0) {
    throw new Error(`Cannot locate VS Code application package.json for executable: ${executable}`);
  }
  if (roots.length !== 1) {
    throw new Error(`Ambiguous VS Code application roots for executable ${executable}: ${roots.join(', ')}`);
  }
  return fs.realpathSync(roots[0]);
}

/** Check an exact test-runtime version; a cache directory name is not evidence. */
export function assertRuntimeVersion(executablePath, expectedVersion) {
  if (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    throw new Error(`Expected an exact VS Code runtime version, received ${expectedVersion}`);
  }
  const manifestPath = path.join(applicationRoot(executablePath), 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read VS Code runtime version from ${manifestPath}: ${error.message}`, { cause: error });
  }
  const actualVersion = typeof manifest?.version === 'string' ? manifest.version : '<missing version>';
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `VS Code runtime version mismatch: expected ${expectedVersion}, actual ${actualVersion} at ${manifestPath}. `
      + `Set VSCODE_TEST_EXECUTABLE_PATH to an executable for VS Code ${expectedVersion}.`
    );
  }
  return actualVersion;
}
