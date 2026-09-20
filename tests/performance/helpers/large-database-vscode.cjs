// Only VS Code's host services are supplied here. Database engines, worker
// threads, RPC, serializers and file persistence use production code.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mockVscode } = require('../../unit/mocks/vscode.ts');

function fileUri(filePath) {
  const absolute = path.resolve(filePath);
  return {
    scheme: 'file', authority: '', path: absolute, fsPath: absolute, query: '', fragment: '',
    toString: () => pathToFileURL(absolute).href,
    with: fields => fileUri(fields.path ?? absolute)
  };
}

async function stat(uri) {
  try {
    const value = await fs.stat(uri.fsPath);
    return {
      type: value.isDirectory() ? 2 : 1,
      ctime: value.ctimeMs, mtime: value.mtimeMs, size: value.size
    };
  } catch (error) {
    if (error.code === 'ENOENT') error.code = 'FileNotFound';
    throw error;
  }
}

module.exports = {
  ...mockVscode,
  Uri: {
    ...mockVscode.Uri,
    file: fileUri,
    joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts))
  },
  workspace: {
    ...mockVscode.workspace,
    getConfiguration: () => ({
      get: (name, fallback) => ({ maxFileSize: 0, queryTimeout: 60000 }[name] ?? fallback)
    }),
    fs: {
      stat,
      readFile: async uri => new Uint8Array(await fs.readFile(uri.fsPath)),
      writeFile: async (uri, bytes) => fs.writeFile(uri.fsPath, bytes),
      rename: async (from, to) => fs.rename(from.fsPath, to.fsPath),
      delete: async uri => fs.rm(uri.fsPath, { force: true })
    }
  }
};
