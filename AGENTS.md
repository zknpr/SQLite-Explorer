# Repository Guidelines

## Project structure and module organization

- `src/` contains the VS Code host; `src/core/` holds shared database, SQL, and RPC utilities.
- `core/ui/` contains viewer templates and JavaScript modules. `website/` contains the Next.js site and demo.
- `tests/unit/`, `tests/desktop/`, and `tests/performance/` cover logic, host integration, and performance. `scripts/` holds tooling, `l10n/` translations, and `natives/` bundled runtimes.

Edit UI templates/modules and `website/src/sqlite-viewer/worker.js`. Regenerate `core/ui/viewer.html` and `website/public/sqlite-viewer/{viewer.html,worker.js}` with `node scripts/build.mjs`; never hand-edit these outputs. Include regenerated tracked files with source changes. Build outputs include `out/` and WASM assets in `assets/`.

## Build, test, and development commands

Use Node.js 24 from `.nvmrc` and VS Code 1.110.0 or newer.

- `npm ci`: install locked dependencies.
- `npm run build`: build extension, workers, and viewer assets.
- `npx tsc --noEmit -p tsconfig.json`: typecheck source and tests.
- `npm test`: run the unit suite.
- `npm run test:desktop`: run Electron host integration tests after building.
- `npm run test:native-smoke`: exercise the bundled native runtime.

Launch an Extension Development Host in VS Code and open a `.db` file. Rebuild and reload after edits.

For the website, run `npm --prefix website ci`, then `npm --prefix website run dev`.

## Coding style and naming conventions

Keep TypeScript strict; prefer `unknown` over `any`. Preserve each file's indentation and quotes; two- and four-space styles coexist. Use camelCase for functions/variables and PascalCase for types/classes. Propagate errors explicitly and route host/worker logs to the SQLite Explorer output channel.

No root formatter is configured. Website ESLint runs with `npm --prefix website run lint`.

## Testing guidelines

Unit tests use Node's built-in runner through `tsx`; desktop tests use Mocha. Name unit tests `tests/unit/*.test.ts`. Import `./vscode_mock_setup` first for VS Code-dependent tests. Cover changed behavior with regressions and extend native smoke tests for native worker changes. No numeric coverage threshold is configured.

## Commit and pull request guidelines

Use Conventional Commits, such as `fix(worker): preserve transaction state`. Follow `.github/PULL_REQUEST_TEMPLATE.md`, link related issues, and explain the problem, solution, architecture, per-file changes, security impact, and test results. Include UI screenshots and update relevant docs/CHANGELOG.

## Security guidelines

Treat databases as untrusted. Bind SQL values, use `escapeIdentifier()` and `validateSqlType()`, render values with `textContent`, and preserve nonce-based CSP. Report vulnerabilities privately as described in `SECURITY.md`.
