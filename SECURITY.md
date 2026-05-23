# Security Policy

SQLite Explorer takes security seriously. The extension parses and edits arbitrary, potentially untrusted SQLite database files, so input handling and isolation are treated as first-class concerns.

## Supported Versions

Only the latest released version receives security updates. The extension auto-updates through the VS Code Marketplace and Open VSX, so we recommend always running the current release.

| Version        | Supported |
|----------------|-----------|
| Latest release | ✅        |
| Older releases | ❌        |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, report them privately through GitHub's built-in private vulnerability reporting:

1. Go to the [**Security** tab](https://github.com/zknpr/sqlite-explorer/security) of the repository.
2. Click **Report a vulnerability** to open a private advisory (direct link: <https://github.com/zknpr/sqlite-explorer/security/advisories/new>).
3. Include as much detail as you can:
   - A description of the issue and its impact.
   - Steps to reproduce or a proof of concept.
   - Affected version(s) and platform (desktop VS Code, VS Code for Web, remote SSH/WSL/container).
   - Any suggested remediation.

You will receive an acknowledgement, and we will keep you informed as the issue is investigated and resolved.

## Disclosure Policy

- We follow **coordinated disclosure**. Please give us a reasonable window to ship a fix before any public disclosure.
- Once a fix is released, we are happy to credit reporters in the release notes (opt-in).

## Scope

**In scope:**
- The VS Code extension and its bundled workers.
- The web demo viewer.

**Out of scope:**
- Vulnerabilities in upstream dependencies — report those to the respective projects; we will update once a patched release is available.
- Issues that require an already-compromised local machine or a maliciously modified build.

## Security Design

The extension applies defense-in-depth: a strict nonce-based Content Security Policy (no `unsafe-inline`), parameterized SQL with escaped identifiers, `textContent`-only rendering to prevent XSS, and workspace-scoped file access. See the [Security section of the README](README.md#security) for details.
