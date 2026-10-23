# Changelog

## [Unreleased]

### Added
- Guides view: write a Guided Review of a pull request or your local changes with Claude Code over ACP, watch it build, and read it chapter by chapter in the native diff editor (overview with a Mermaid diagram and code links, chapter and file ticks, CodeLens, status bar). Guides are shared with Plannotator's web app. A pull request's own Claude Code settings and MCP servers are never loaded; guide history off (`PLANNOTATOR_GUIDE_HISTORY=0`) is honored.

## [0.4.0] - 2026-02-11

### Added
- Custom WebviewPanel with embedded iframe (replaces Simple Browser)
- Cookie persistence across sessions via reverse proxy and virtual cookie jar
- Auto-close panel when plan is approved or feedback is sent
- VS Code notification when panel opens
- Tab icon for Plannotator panel
- Plannotator output channel for diagnostics

### Changed
- Renamed display name from "Plannotator WebView" to "Plannotator"

## [0.1.0] - 2026-02-11

### Added
- Initial release
- Intercept Plannotator browser opens in VS Code integrated terminal
- URI handler for `vscode://plannotator-webview/open?url=...`
- Router shell script for PLANNOTATOR_BROWSER env var
- Configurable URL pattern matching
- Manual URL opening command
