// The web lane's driver evaluates code in the extension host, a worker of the page, where `vscode` is
// only what an extension is handed. This leaves it where that code can find it.
exports.activate = () => {
  globalThis.__webLane = require('vscode');
};
