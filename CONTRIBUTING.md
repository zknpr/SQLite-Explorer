# Contributing to SQLite Explorer

Thanks for your interest in improving SQLite Explorer! This guide explains how to set up the project, the conventions we follow, and how to get your changes merged.

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to Contribute

- **Report bugs** — Open a [bug report](https://github.com/zknpr/sqlite-explorer/issues/new?template=bug_report.yml) with clear reproduction steps.
- **Request features** — Open a [feature request](https://github.com/zknpr/sqlite-explorer/issues/new?template=feature_request.yml) describing the problem you want solved.
- **Improve docs** — Fixes to the README, CHANGELOG, or this guide are always welcome.
- **Add translations** — The extension is localized via the `l10n/` directory (14 languages today). New languages and corrections are appreciated.
- **Submit code** — Bug fixes and features via pull request (see below).

## Reporting Security Issues

**Do not open public issues for security vulnerabilities.** See [SECURITY.md](SECURITY.md) for private reporting instructions.

## Development Setup

### Prerequisites

- **Node.js 24** (see `.nvmrc` — run `nvm use` if you use nvm)
- **VS Code 1.110.0 or newer**
- **npm** (ships with Node)

### Getting Started

```bash
git clone https://github.com/zknpr/sqlite-explorer.git
cd sqlite-explorer

npm install              # Install dependencies
node scripts/build.mjs   # Build extension + worker
npm test                 # Run the unit test suite
```

### Running the Extension

1. Open the project in VS Code.
2. Press `F5` to launch an **Extension Development Host** window.
3. Open any `.sqlite`, `.db`, or `.sqlite3` file to exercise the extension.

After changing source files, re-run `node scripts/build.mjs` and reload the host window (`Ctrl+R` / `Cmd+R`).

## Project Structure

The codebase is split across three communication layers — **Webview** (UI), **Extension Host** (VS Code API), and **Worker** (SQLite engine). See [`CLAUDE.md`](CLAUDE.md) for a detailed architecture map and the [Architecture section of the README](README.md#architecture) for a high-level overview.

## Testing

Tests use Node's built-in test runner via `tsx`:

```bash
npm test
```

- Add or update tests for any behavior you change.
- Unit tests live in `tests/unit/`; test **behavior** (observable results), not implementation details.
- VS Code APIs are mocked — new test files must import `tests/unit/vscode_mock_setup.ts` first (path-mapped via `tsconfig.test.json`).

## Coding Standards

- **TypeScript** — Keep types strict; avoid `any` (prefer `unknown` and narrow).
- **Security first** — This project handles untrusted database files:
  - Use parameterized queries (`?` placeholders) for all values.
  - Escape identifiers with `escapeIdentifier()`; validate SQL types with `validateSqlType()`.
  - Render cell values with `textContent`, never `innerHTML`.
  - Preserve the nonce-based Content Security Policy — no `unsafe-inline`.
- **Style** — Match the surrounding code. Keep changes focused and DRY.
- **No silent failures** — Propagate errors explicitly; log via the "SQLite Explorer" output channel, not `console.log`.

## Commit & Pull Request Guidelines

- This project uses [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `fix(worker): …`, `feat(grid): …`, `chore(deps): …`, `test: …`, `docs: …`).
- Keep each pull request focused on a single concern.
- Before opening a PR, make sure:
  - `npm test` passes.
  - `node scripts/build.mjs` completes without errors.
  - Docs/CHANGELOG are updated if behavior changed.
- Fill out the pull request template and link any related issue.
- Automated code-review bots run on every pull request — please address the feedback they surface.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE.md).
