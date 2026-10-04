# Security Policy

## Supported versions

Security fixes go into the latest release of `prelude-context` on npm.

## Reporting a vulnerability

Please do not open a public issue. Report privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. You should get a response within a week.

## What Prelude touches

- Prelude reads files in the project directory and writes only to `.context/` (or the directory named by `PRELUDE_ROOT`) and to `~/.prelude/` (or `PRELUDE_HOME`) for the workspace registry.
- Inference, `locate`, and the MCP server make no network requests. The MCP server uses stdio transport only.
- `.context/` files are meant to be committed. Prelude records the names of environment files it detects, never their contents, but review what you commit: descriptions, decisions, and notes are free text.
