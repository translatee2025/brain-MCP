# brain-mcp

A small standalone long-term memory server for Claude Desktop (and ChatGPT desktop).
One stdio MCP process, one SQLite file. No cloud, no second model unless you opt in.

The MCP server is a well-indexed markdown store. Claude is the brain: it writes
clean notes and calls `brain_save`. Optional server-side restructuring is
pluggable (host model via MCP sampling / an OpenAI-compatible endpoint / a local
Ollama or LM Studio model).

- **Private by default.** One local SQLite file (`~/.brain/brain.db`). No
  telemetry, no account, no cloud unless you opt into a restructure engine.
- **Secrets are stripped before write.** API keys, tokens, JWTs, private keys,
  and credit-card numbers are redacted before anything touches disk.
- **Cross-platform, no build step.** Uses Node's built-in SQLite (`node:sqlite`),
  so the one-click bundle loads on macOS, Windows and Linux with no native
  module to compile.

## Tools

- `brain_save` — store a note (title, content, folder, tags); overwrite by id
- `brain_search` — full-text search (FTS5, bm25-ranked, highlighted snippets)
- `brain_get` — fetch one note in full
- `brain_list` — recent notes + folder counts
- `brain_delete` — soft-delete (kept in DB, dropped from search)
- `brain_versions` / `brain_restore` — version history; non-destructive rollback
- `brain_capture` — append the latest exchange to a running buffer; reports
  `should_flush` once it crosses ~10 pages
- `brain_flush` — restructure the whole buffer into one clean note and clear it
- `brain_export` — zip of all notes (folder-structured .md + index + metadata)
- `brain_import` — load notes back from a Brain export zip (or any zip of .md)
- `brain_open_ui` — open the local web viewer/editor
- `brain_system_check` — RAM/CPU report + recommended local model and setup

All tools carry MCP annotations (`readOnlyHint`/`destructiveHint`) so the client
shows the right confirmation gates. Every note is also a resource
(`brain://doc/<id>`) so the model can pull the knowledge base in as context
without a tool call.

## Auto-save after ~10 pages, and "save to brain"

MCP servers can't passively watch a conversation, so capture is mediated by a
project instruction. Add this to the Claude project:

> After each substantial exchange, call `brain_capture` with a concise record
> of what was decided or learned. When it returns `should_flush=true`, or when
> I say "save to brain", call `brain_flush` with a good title, folder and tags.

`brain_capture` accumulates a buffer and estimates tokens; the ~10-page
threshold is `BRAIN_FLUSH_TOKENS` (default 6000). `brain_flush` restructures
the entire buffer into one clean note and clears it. "Save to brain" is just an
immediate `brain_flush`.

## Web UI

`brain_open_ui` (or `npm run start` then visit the port) opens a localhost-only
viewer: folder list, FTS search box, rendered markdown, an Edit toggle that
saves back as a new version, version history with one-click restore, and
download buttons for a single `.md`, the whole brain as `.zip`, or the raw
`brain.db`. Port = `BRAIN_UI_PORT` (default 4319).

## Install (one-click, recommended)

Download the latest `brain-mcp.mcpb` from
[Releases](https://github.com/translatee2025/brain-MCP/releases) and
double-click it. Claude Desktop installs the extension and lets you configure
the optional restructure engine from a settings dialog. No terminal needed.

## Install (manual, from source)

```
git clone https://github.com/translatee2025/brain-MCP.git
cd brain-MCP
npm install
npm run build
```

Data lives in `~/.brain/brain.db` (override with `BRAIN_DIR`).

## Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/Users/ag/Documents/brain-MCP/dist/index.js"],
      "env": {
        "BRAIN_RESTRUCTURE": "none"
      }
    }
  }
}
```

Restart Claude Desktop. Add a project instruction like: "When I say remember
this, write a clean standalone note and call brain_save with a good title,
folder and tags."

## Restructuring engine (`BRAIN_RESTRUCTURE`)

- `none` (default-safe) — store exactly what Claude wrote. Claude already
  produces clean prose, so this is the recommended start. Works in ChatGPT
  desktop too.
- `sampling` — the server asks the host app's own model to tidy the note.
  Zero config, no key. Works only if the host supports MCP sampling; degrades
  to verbatim storage if not.
- `openai` — use an OpenAI-compatible endpoint. Set:
  - `BRAIN_LLM_BASE_URL` (e.g. `https://api.openai.com/v1`, or local
    `http://127.0.0.1:11434/v1` for Ollama, `http://127.0.0.1:1234/v1` for LM Studio)
  - `BRAIN_LLM_API_KEY` (omit for local)
  - `BRAIN_LLM_MODEL`

Run `brain_system_check` from the chat to get a model recommendation sized to
your machine and the exact `ollama pull` + env vars to set.

## ChatGPT desktop

Same server, same tools. Use `BRAIN_RESTRUCTURE=none` or `openai` — MCP
sampling is not reliable there, so don't depend on the `sampling` engine.
