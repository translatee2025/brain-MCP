# Brain MCP — Project Handoff

A complete, self-contained briefing. Hand this to a fresh chat and it can
continue the work with no prior context.

---

## 1. What this is

**Brain MCP** is a small standalone [Model Context Protocol](https://modelcontextprotocol.io)
server that gives Claude Desktop (and ChatGPT desktop) a private, local,
long-term memory: a searchable store of clean markdown notes that Claude
writes, organizes, versions, and can read back as context.

- **Repo:** https://github.com/translatee2025/brain-MCP (private)
- **Local path:** `/Users/ag/Documents/brain-MCP`
- **Branch:** `main` · first commit `0a295ac`
- **Storage:** `~/.brain/brain.db` (SQLite). Nothing leaves the machine
  unless you opt into a cloud restructuring engine.

It is **not** connected to the Dobee app. It started as a spin-off idea from
a large "Brain" subsystem brief written for Dobee Talk2Mac, but the user
wanted a small independent tool for their own Claude Desktop instead. All
Dobee coupling was deliberately dropped.

## 2. The core design decision

The original Dobee brief made the *server* smart (bundled 7B model,
embeddings, conflict pipeline, ~2 week build). For a standalone Claude
Desktop tool that was overkill. The guiding principle here is:

> **The MCP server is a dumb but well-indexed markdown store. Claude is the
> brain.** Claude restructures raw conversation into clean prose *before*
> calling the save tool. All the "intelligence" lives in the model plus a
> short project instruction, not in the server.

This collapsed ~80% of the original scope and removed every heavy
dependency. Optional server-side restructuring still exists, but it is
pluggable and off the critical path.

A second hard reality shaped the design: **MCP servers cannot passively
watch a conversation.** There is no transcript feed. So "capture" is always
explicit — the model calls a tool. The ~10-page auto-save is therefore
*model-mediated* via a project instruction plus a running buffer the server
tracks, not a background watcher.

## 3. Architecture

```
Claude Desktop / ChatGPT desktop
        │  (stdio, MCP JSON-RPC)
        ▼
  src/index.ts            stdio transport entry
  src/server.ts           MCP server: 12 tools + brain://doc/{id} resource
        │
        ├── src/db.ts         SQLite (better-sqlite3, WAL, FK on)
        │     docs · tags · doc_tags · fts(FTS5) · doc_versions · capture_buffer
        ├── src/restructure.ts  pluggable cleanup: sampling | openai | none
        ├── src/export.ts       zip export (adm-zip)
        └── src/ui.ts           localhost web viewer/editor (Node http + marked)
```

- **Language/stack:** Node + TypeScript, ESM, compiled with `tsc` to `dist/`.
- **Deps:** `@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`,
  `adm-zip`, `marked`. Dev: `typescript`, `tsx`, `@types/*`.
- **Process model:** one stdio process launched by the host app. The web UI
  is an extra localhost HTTP server started on demand inside the same
  process.

## 4. Data model (SQLite, `~/.brain/brain.db`)

| Table | Purpose |
|---|---|
| `docs` | one row per note: id, title, folder, body_md, timestamps, soft `deleted` flag |
| `tags`, `doc_tags` | many-to-many tags |
| `fts` | FTS5 virtual table (`unicode61 remove_diacritics 2`), bm25-ranked search with highlighted snippets |
| `doc_versions` | post-image snapshot on every save/edit/restore; last 20 kept per doc |
| `capture_buffer` | per-session running buffer for the flush trigger |

Deletes are **soft** (row kept, dropped from FTS and listings). Versioning
is **non-destructive**: restoring an old version first snapshots the current
state, so nothing is ever lost.

## 5. Features and how each works

### 5.1 Save / search / read
Claude writes a clean note and calls `brain_save` (title, content, folder,
tags). FTS5 indexes it. `brain_search` runs a sanitized bm25 query and
returns ids + highlighted snippets. `brain_get` returns one note in full.
Every note is also exposed as an MCP **resource** `brain://doc/<id>` so the
model can pull the knowledge base in as context without an explicit call.

### 5.2 Auto-save after ~10 pages, and "save to brain"
Because MCP can't tail a chat, this is driven by a **project instruction**
(see install section) plus two tools:
- `brain_capture(text, session?)` appends the latest exchange to a buffer
  and returns a token estimate and `should_flush=true` once it crosses
  `BRAIN_FLUSH_TOKENS` (default 6000 ≈ 10 pages).
- `brain_flush(title, …)` restructures the **entire buffer** into one clean
  note, saves it, and clears the buffer.

"Save to brain" is simply an immediate `brain_flush`.

### 5.3 Pluggable restructuring (`BRAIN_RESTRUCTURE`)
`restructure()` cleans raw text into a reference doc using a strict
"restructure, do not summarize, lose nothing" system prompt. Engines:
- `none` — store exactly what Claude wrote (Claude already writes clean
  prose). Most reliable; works in ChatGPT desktop too. **Recommended.**
- `sampling` — server asks the host app's own model via MCP sampling. Zero
  config, no key. Works only if the host supports sampling; **degrades to
  verbatim** if not.
- `openai` — any OpenAI-compatible endpoint: real OpenAI, or local Ollama
  (`http://127.0.0.1:11434/v1`) / LM Studio (`http://127.0.0.1:1234/v1`).

If the chosen engine is unavailable the note is stored raw — a note is
never lost to an engine failure.

### 5.4 Version history
`brain_versions(id)` lists history; `brain_restore(id, version_n)` rolls
back non-destructively. The web UI shows the same with one-click restore.

### 5.5 Export
`brain_export` writes a zip: folder-structured `.md` files with YAML
frontmatter, plus `_index.md` (table of contents) and `_metadata.json`.
Default output `~/.brain/exports/brain-export-<date>.zip`.

### 5.6 Local web UI
`brain_open_ui` starts a **localhost-only** HTTP server and opens the
browser. It provides: folder list, FTS search box, rendered markdown,
an Edit toggle that saves back as a new version, version history with
restore, and download buttons for a single `.md`, the whole brain `.zip`,
or the raw `brain.db`. Port = `BRAIN_UI_PORT` (default 4319). HTML from
notes is best-effort sanitized (single-user local context).

### 5.7 System check
`brain_system_check` reports RAM/CPU and recommends a local model sized to
the machine (3B under 16 GB, 7B 16–32 GB, 14B 32 GB+, cloud under 8 GB)
with the exact `ollama pull` command and env vars to set.

## 6. Tool reference (12 tools)

| Tool | Args | Effect |
|---|---|---|
| `brain_save` | title, content, folder?, tags?, id?, restructure? | create/overwrite a note |
| `brain_search` | query, folder?, limit? | FTS5 search, ids + snippets |
| `brain_get` | id | full note |
| `brain_list` | folder?, limit? | recent notes + folder counts |
| `brain_delete` | id | soft-delete |
| `brain_versions` | id | version history |
| `brain_restore` | id, version_n | non-destructive rollback |
| `brain_capture` | text, session? | append to buffer, report should_flush |
| `brain_flush` | title, session?, folder?, tags?, restructure? | restructure buffer → note, clear |
| `brain_export` | path? | zip export, returns path |
| `brain_open_ui` | — | start + open local web viewer |
| `brain_system_check` | — | RAM/CPU + local-model recommendation |

Plus resource template: `brain://doc/{id}` (and a `list` of all docs).

## 7. Environment variables

| Var | Default | Meaning |
|---|---|---|
| `BRAIN_DIR` | `~/.brain` | storage directory |
| `BRAIN_RESTRUCTURE` | `sampling` | `none` \| `sampling` \| `openai` |
| `BRAIN_LLM_BASE_URL` | `https://api.openai.com/v1` | for `openai` engine |
| `BRAIN_LLM_API_KEY` | — | omit for local Ollama/LM Studio |
| `BRAIN_LLM_MODEL` | `gpt-4o-mini` | model for `openai` engine |
| `BRAIN_FLUSH_TOKENS` | `6000` | ~10-page auto-save threshold |
| `BRAIN_UI_PORT` | `4319` | web UI port |

## 8. Install

```bash
git clone https://github.com/translatee2025/brain-MCP.git
cd brain-MCP
npm install
npm run build
```

`npm install` builds the `better-sqlite3` native module for your Node.

### Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/Users/ag/Documents/brain-MCP/dist/index.js"],
      "env": { "BRAIN_RESTRUCTURE": "none" }
    }
  }
}
```

Restart Claude Desktop. Add this **project instruction** so capture works:

> After each substantial exchange, call `brain_capture` with a concise
> record of what was decided or learned. When it returns
> `should_flush=true`, or when I say "save to brain", call `brain_flush`
> with a good title, folder and tags. When I ask a question, search
> `brain` first.

### ChatGPT desktop

Same server and tools. Use `BRAIN_RESTRUCTURE=none` or `openai` — MCP
sampling is not reliable there, so do not depend on the `sampling` engine.

## 9. How it was built (chronology)

1. Reviewed a large Dobee "Brain Implementation Brief"; flagged that it was
   written against the wrong repo layout and over-scoped for the user's
   actual need.
2. User clarified: they want a **small standalone** tool for their own
   Claude Desktop, nothing to do with Dobee.
3. Built the minimal core: SQLite + FTS5 store, 6 tools, MCP resources,
   pluggable restructuring with graceful degradation, system check.
   Verified MCP handshake + save/search round-trip.
4. Added: version history, zip export, the capture/flush buffer for the
   ~10-page trigger, and the localhost web UI (browse / edit / restore /
   download). Verified end-to-end in an isolated temp dir.
5. Renamed the folder to `brain-MCP`, made it its own git repo, pushed to
   a private GitHub repo.

Testing was done by piping newline-delimited JSON-RPC into
`node dist/index.js` and asserting on tool results, plus direct fetches
against the UI server. One early test bug wrote artifacts into the real
`~/.brain` (a shell `export A=$B` ordering issue) — the user may want to
delete `~/.brain` for a clean slate before first real use.

## 10. Known limitations / honest notes

- **Capture is model-mediated.** No background watcher is possible in MCP;
  the project instruction is load-bearing.
- **`sampling` support varies** by Claude Desktop version; that is why the
  recommended config uses `none`.
- **UI has no auth.** It binds `127.0.0.1` only and assumes a single local
  user. HTML sanitization is best-effort, not a security boundary.
- **No secret redaction yet** (see roadmap). Don't paste raw credentials
  into notes until that lands.

## 11. Roadmap (proposed, not yet built)

Ranked by value:

1. **Secret redaction before save** — strip API keys/JWTs/PEM keys via
   regex before anything is stored.
2. **Near-duplicate / contradiction warning** — lightweight FTS-similarity
   check that flags an existing similar note before creating a twin.
3. **Obsidian mirror** — optionally also write each note as `.md` into a
   vault subfolder for free editing/graph.
4. **Auto-tagging / auto-folder** — let the configured LLM suggest folder
   and tags at flush time.
5. **Encryption at rest** — passphrase-derived key for the SQLite store.

## 12. Repo layout

```
brain-MCP/
  src/index.ts        stdio entry
  src/server.ts       MCP tools + resource
  src/db.ts           SQLite store, schema, queries
  src/restructure.ts  restructuring engines + system check
  src/export.ts       zip export
  src/ui.ts           localhost web UI
  README.md           short user-facing install/usage
  HANDOFF.md          this document
  package.json · tsconfig.json · .gitignore
```

`node_modules/` and `dist/` are gitignored — clone then
`npm install && npm run build`.
