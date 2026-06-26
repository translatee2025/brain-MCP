# Changelog

## 0.2.0

The "ship-ready" release. Closes the audit's submission blockers (see
`AUDIT.md`) and makes the one-click install actually work everywhere.

### Cross-platform install (was: crashed on most machines)
- Migrated the store from the native `better-sqlite3` addon to Node's built-in
  `node:sqlite`. The bundle no longer ships a platform-specific binary, so it
  loads on macOS (Intel and Apple Silicon), Windows, and Linux with no compile
  step. Previously the bundle shipped an arm64-only binary that crashed at
  startup on every other target.
- `manifest.json` now lists all three platforms and pins the Node runtime; the
  launch args include `--experimental-sqlite` for older runtimes.

### Security (localhost UI lockdown)
- The web UI now requires a per-launch access token on every `/api` and
  `/download` request (the token rides in the opened URL).
- Host-header validation rejects DNS-rebinding attempts even with a valid token.
- Origin checks on state-changing requests; a nonce-based Content-Security-Policy
  so injected markup cannot execute; raw HTML dropped at render time.
- `EADDRINUSE` no longer crashes the MCP process; 500s no longer leak internals.

### Privacy
- New secret-redaction firewall: API keys, tokens, JWTs, private/SSH keys,
  `NAME=secret` assignments, and Luhn-valid card numbers are stripped before any
  note is written, buffered, or sent to a restructure engine. Saves report how
  many secrets were redacted.

### Data integrity
- `brain_flush`/`brain_save` no longer silently truncate: restructured output is
  sized to the input, truncation is detected, and on truncation the full
  verbatim text is stored instead of a partial note.
- Restructure calls now have a timeout so a hung endpoint cannot block the tool.
- Version pruning never evicts a user's hand-edit.
- `brain_restore` snapshots the current state before rolling back (truly
  non-destructive).
- Folder-scoped search filters in SQL before the limit (no more under-returning).
- Schema now stamps `user_version` for future migrations.

### Features
- New `brain_import` tool: load notes back from a Brain export zip (or any zip of
  markdown), completing the export round-trip. Includes a `dry_run` preview.
- Export frontmatter now includes tags and full timestamps, and the UI
  "Download .zip" carries frontmatter too, so exports round-trip cleanly.
- All 13 tools migrated to `registerTool` with MCP annotations
  (`readOnlyHint`/`destructiveHint`) and plain, non-instructional descriptions.

### Packaging
- Ships a sample vault (`samples/brain-sample.zip`) importable in one call, plus
  `DEMO-PROMPTS.md`.
- Added a smoke test and a UI-security test (`npm test`).

## 0.1.0

Initial release: SQLite + FTS5 note store, capture/flush buffer, version
history, pluggable restructuring, zip export, localhost web UI, MCPB bundle.
