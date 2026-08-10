# Desktop extension-host integration lane

Run `node scripts/build.mjs` first. `npm run test:desktop` then compiles this
directory, downloads/caches the exact VS Code version pinned by `engines.vscode`,
and runs the complete matrix in one Extension Development Host launch. Fixtures
are generated with sql.js under the temporary workspace created by the runner;
nothing depends on machine-local `test_db/` files.

The suite exercises real custom-editor providers, extension-host lifecycle, native
and worker-backed WASM engines, save/revert/backup, the registered virtual filesystem,
and the production table-export stream. A non-production-only object returned by
`activate()` supplies the narrow observation/control surface that cannot be shared by
importing source modules into the separately bundled test extension.

Webview-internal behavior is deliberately out of scope: grid rendering, modals, media
panels, and other webview DOM behavior belong to the demo Playwright lane. Electron
extension tests cannot reach into the isolated webview DOM, and this lane does not fake
coverage with webview message injection.

The `sqliteExplorer.fileOperations` setting controls blob-inspector I/O (`native` or
`web`); it does not select a database backend. The desktop test API therefore forces
`native` or `wasm` without changing the shipped setting contract. The same test-only
bridge can lower the internal WASM paging threshold so compact fixtures exercise both
storage paths without repurposing the user-facing `maxFileSize` refusal cap.
Backend-specific rows are labeled directly in their test names rather than silently
skipped.
