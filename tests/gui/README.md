# Installed extension UI tests

These tests install an exact VSIX into an isolated VS Code profile, then use real
mouse and keyboard actions through Playwright Electron. They do not send webview
RPC messages or import the extension into the test process. Mutations are checked
independently through SQLite on the test files.

Build and package first, then run from the repository with Node 24:

```sh
GUI_VSIX=release/sqlite-explorer-darwin-arm64-1.8.0.vsix npm run test:gui
```

The default application version is the supported minimum, 1.110.0. The runner can
download a separate test application, or use `VSCODE_TEST_EXECUTABLE_PATH` to point
to its actual desktop executable. Set `GUI_VSCODE_VERSION` to an exact version
when testing another application. Its `resources/app/package.json` must match;
a cache directory name is not accepted as version evidence.

`GUI_OUTPUT` selects a new output directory. Each run creates its own databases,
profile and extension installation. Results, failure screenshots, stable-screen
screenshots, VS Code logs, application identity and the VSIX SHA-256 are retained
there. An existing output directory is refused to avoid overwriting evidence.

Available suites:

| Command | Coverage |
| --- | --- |
| `npm run test:gui` | Main database, SQL, import/export, settings, and replacement workflows |
| `npm run test:gui:lifecycle` | Save As ownership, hot exit, read-only/WAL transitions, closing a running query, inactive automatic saves, and save conflicts |
| `npm run test:gui:grid` | Batch operations, keyboard editing, pins/sizing, JSON, filters, selected exports, SQL completion/cancellation/history |
| `npm run test:gui:cells` | External text editing, BLOB replacement, oversized content, media, downloads, and wide-table virtualization |
| `npm run test:gui:edges` | File associations, empty/corrupt files, view editor and trigger behavior, size limits, and configuration changes |
| `npm run test:gui:sharing` | Two editor groups for one database, continued editing after closing a group, and TEXT/BLOB composite-key Undo/Redo |
| `npm run test:gui:progress` | Cancellation after import progress and export output begin; rollback, cleanup, and subsequent operations |
| `npm run test:gui:interactions` | Saved SQL reopening, NULL/empty values, modal focus and keyboard controls, exact PDF/raw TEXT downloads, and export options |
| `npm run test:gui:contention` | Native view commit blocked by a real external reader, rollback, committed retry in the same editor, and persisted Undo/Redo |
| `npm run test:gui:uploads` | Five MiB BLOB drops, labels/inspector, pending-file and encoding cancellation with trusted Undo, and native external-change recovery |

The upload suite creates browser `File` drop events and passes them through the
production handler. It uses trusted workbench keyboard input for Undo and holds
FileReader or an encoding task at controlled barriers to make cancellation
repeatable. Its report identifies these seams; it does not establish native OS
drag-and-drop delivery. The optional `J13` interaction case covers that separate
input boundary, entering the database before pressing Shift.

The size-limit recovery case changes the actual VS Code setting, verifies the
saved configuration, and retries in the same database editor without reloading
the window. A size refusal creates a disconnected document, avoiding VS Code's
cached rejected-model promise. The case also closes and reopens the exact URI.

Each command requires `GUI_VSIX`. Use a matching platform VSIX with
`GUI_BACKEND=native`, or the generic VSIX with `GUI_BACKEND=wasm`. The main, grid,
cell, and edge WASM suites enable automatic saves so independent disk reads can
verify mutations. The lifecycle suite controls save behavior per case.

The lifecycle, progress, and interaction suites require `VSCODE_TEST_EXECUTABLE_PATH`.
The progress and interaction suites also require `GUI_EXPECTED_SHA256` to pin their package before
creating the larger fixtures. The lifecycle suite accepts comma-separated
`GUI_CASES`: `save-as`, `hot-exit`, `read-only`, `wal-transition`,
`close-active-query`, and the WASM-only `auto-save` and `external-replacement`.

The contention suite requires a native platform package. The interaction suite
runs J00–J12 by default; `GUI_CASES` selects interaction IDs. Its J13 real file
drag is opt-in with `GUI_CASES=J13` or `GUI_FILE_DRAG=1`, since the workbench can
intercept that gesture before it reaches the webview.

The cell suite requires `ffmpeg` to generate its video fixture; `GUI_FFMPEG` may
name its executable. `GUI_ONLY` selects comma-separated cell case IDs. Runtime
codec support is recorded separately from byte-preserving download and fallback
behavior. `GUI_TEXT_MULTILINE=1` selects the ordinary multiline large-text fixture.
Use `GUI_CLIPBOARD=1` for the grid suite only in a disposable desktop: it reads and
writes the actual system clipboard. Keep macOS output paths short to stay within
the platform's Unix-socket path limit.

The regular workflow suite covers sidebar/schema, views, grid pagination/filter,
cell editing/Undo/Redo, BLOB download, row/table/column creation, quoted names,
generated columns, two-database SQL ownership, parameters, Explain, query history,
import, table/query export, settings and external replacement recovery. Separate
lifecycle and advanced cell runners cover their own cases. A test name describes
its assertions; a passing suite does not establish every possible combination.

The profile selects VS Code's supported simple file dialogs and custom
confirmation dialogs so the controls are visible to the test. Native operating
system dialogs, clipboard, codecs and deployment to a user's existing profile
need separately recorded checks. CSP remains enabled. Application updates,
extension updates and workspace trust prompts are disabled only in the isolated
test profile.

The separate [large-database characterization](../performance/LARGE_DATABASE_QA.md)
exercises the production database adapters, measures process memory and timings,
and records fixture allocation. It does not replace installed UI checks or
establish cold-cache performance.
