# Brain MCP — Overview, Readiness, and Security

A three-part briefing: what it is, what changed to make it ready, and how it is
secured. Written for a non-specialist reader; no prior context required.

---

## Page 1 — What it is

**Brain is a private long-term memory for Claude.** It is a small connector (an
MCP server) that you install into Claude Desktop. Once installed, Claude can
save things you tell it to remember, search them later, and read them back, all
stored as clean notes in a single file on your own computer.

The guiding idea is deliberately simple: **the connector is a well-organized
filing cabinet, and Claude is the brain.** Brain does not run its own AI. It
stores, indexes, versions, and protects your notes. Claude does the thinking,
writes the note, and decides when to look something up. This keeps Brain small,
fast, easy to trust, and easy to audit.

**What it does, in plain terms:**

- **Remembers on request.** Say "save this to Brain" and Claude writes a clean,
  titled note into a folder you choose. It can also accumulate a long
  conversation and save the whole thing as one tidy note once it crosses about
  ten pages.
- **Finds things later.** Full-text search across everything you have saved,
  ranked by relevance, with highlighted snippets.
- **Keeps a history.** Every note keeps its past versions; you can see the
  history and roll back to any earlier version without losing the current one.
- **Lets you browse and edit.** A built-in local web page shows all your notes,
  lets you read them nicely formatted, edit them, restore old versions, and
  download a single note, the whole collection as a zip, or the raw database.
- **Backs up and restores.** Export everything to a zip of plain Markdown files;
  import a zip back in. Your notes are never locked inside the app.
- **Stays private.** Everything lives in one local file. Nothing is uploaded,
  there is no account, and there is no tracking.

**Who it is for.** Anyone who wants Claude to remember things across
conversations without sending their notes to a cloud service. It is already
being passed around and used by friends. The next step is getting it into
Claude Desktop's official connector directory so anyone can install it in one
click.

**How "remember after ten pages" works.** A connector cannot silently watch a
conversation, so this is cooperative: Claude calls a "capture" step after each
exchange and a "save" step once the running total is large enough (or when you
say "save to brain"). A one-line project instruction tells Claude to do this.
This is an honest design choice, not a limitation we hide.

---

## Page 2 — What changed, and why it is now good enough for Claude

**The starting point.** The first version worked on the machine it was built on,
but it was not ready for other people. An independent, exhaustive review (run as
a 45-agent audit, with every finding double-checked to weed out false alarms)
surfaced 24 real issues. Three of them were blockers: it would have failed
review or simply not worked for most reviewers.

**The three blockers, and the fixes:**

1. **It only ran on one kind of computer.** The old build shipped a piece of
   compiled code specific to Apple Silicon Macs. On an Intel Mac, Windows, or
   Linux it crashed on startup, before a single feature ran. **Fix:** Brain now
   uses the database engine built directly into the runtime, so there is nothing
   to compile and nothing platform-specific. It loads everywhere.

2. **The tools were not labeled.** Anthropic requires each tool to declare
   whether it only reads data or can change it, so the app can show the right
   confirmation prompts. The old version declared nothing, which is an automatic
   rejection. **Fix:** all thirteen tools now carry those labels, and their
   descriptions were rewritten to be plain and accurate.

3. **The built-in web viewer was wide open.** While it was running, any website
   you happened to visit could quietly read, change, or download your entire
   notes database. This directly contradicted Brain's core promise. **Fix:** the
   viewer is now locked down (covered in detail on page 3).

**The other improvements that came with this release:**

- **Secrets are removed before anything is saved.** If an API key, password,
  token, or card number ends up in a note, it is replaced with a placeholder
  before it ever touches the disk.
- **Long saves cannot silently lose content.** Previously, saving a very long
  conversation could quietly drop the second half. Now the full text is always
  preserved.
- **Safer history and search.** Restoring an old version keeps the current one
  too, your hand-edits are never auto-deleted by cleanup, and folder-scoped
  search no longer misses results.
- **Real backup and restore.** Export now includes tags and timestamps, and a
  new import tool brings a zip back in, so a backup actually restores.
- **A sample notes pack and example prompts** ship in the box so a reviewer can
  try it in seconds.

**Why this clears Anthropic's bar.** The connector directory has a published
checklist. Brain now meets it: a complete manifest with proper tool labels, a
clear privacy policy, an open-source license, a public repository with
documentation, a sensible privacy-first default (no network unless you opt in),
and, critically, a build that actually installs and runs on macOS, Windows, and
Linux. The one-click installer is built, the secrets and data-loss footguns are
closed, and the headline security hole is fixed. In short, it went from "works
on my machine" to "safe to hand to a stranger."

**Evidence.** The release ships with an automated test suite that verifies the
behavior end to end (saving, search, redaction, version history, import, and the
security gate). All twenty checks pass. The full audit, including the issues that
were investigated and found to be false alarms, is published in the repository so
the quality claims can be checked rather than taken on faith.

---

## Page 3 — Security

Brain's entire promise is "your memory never leaves your computer." Security is
therefore not a feature, it is the product. This page describes what is
protected, the attacks that were considered, and what was done about each.

### What data exists, and where

Everything is in one local SQLite file (by default `~/.brain/brain.db`): your
notes, their folders, tags, version history, and a small working buffer used for
the "save after ten pages" feature. Exports are written only when you ask for
them. There is no server in the cloud, no account, and no copy anywhere else.

### The headline fix: locking down the local viewer

Brain includes an optional web page, served on your own machine, for browsing
and editing notes. In the previous version this page had no protection. The
audit confirmed a serious, realistic attack: while the viewer was running, a
malicious website open in any browser tab could reach the local address and read
every note, download the whole database, or silently edit and delete notes. That
completely defeats the "stays on your machine" promise.

Three layers now defend it, and the test suite proves each one:

1. **A one-time access key.** Every launch generates a fresh secret key that
   rides inside the link Brain opens. Every data request must present that key.
   A random website does not have it, so its requests are refused.
2. **Origin checks that stop "DNS rebinding."** There is a known trick where a
   malicious site tricks the browser into treating the attacker's domain as if
   it were your local machine. Brain inspects the address each request claims to
   be for and rejects anything that is not genuinely the local viewer, **even if
   the request somehow carries the key.** This is the test that matters most, and
   it passes: a forged request is blocked.
3. **A strict content policy.** The viewer is configured so that even if some
   hostile text were stored in a note, it cannot run code or call out to the
   internet when displayed. Raw embedded HTML is stripped before display as an
   additional layer.

The viewer is also bound only to the local loopback address (never the network),
a busy port no longer crashes the connector, and internal error details are
never shown to the page.

### Secrets are removed before they are stored

A filtering pass runs before any note is written, buffered, or sent to an
optional cleanup step. It recognizes the common shapes of credentials (cloud and
service API keys, access tokens, web tokens, private and SSH keys,
`NAME=secret` style assignments, and valid-looking card numbers) and replaces
each with a typed placeholder. The save tells you how many secrets it removed,
but never repeats the secret itself. This means you can safely paste an error log
or a config snippet and trust that the sensitive parts will not be persisted.

### Your notes are protected from accidental loss

The product's second promise is that it never loses what you wrote. Several
safeguards enforce this: a long save can never be silently truncated (if a
cleanup step would cut the text, the full original is stored instead); restoring
an older version preserves the current one first; automatic history cleanup never
deletes a version you edited by hand; and the database uses write-ahead logging
so a crash mid-write does not corrupt your notes.

### Network posture: private by default

Out of the box, Brain makes no network connections at all: no telemetry, no
analytics, no update checks, no background calls. There are exactly two ways any
data can leave your machine, both off by default and both chosen by you: an
optional "let Claude's own model tidy this note" mode, and an optional setting to
send notes to a cleanup service you configure (which can be a fully local model
on your own computer). If you do nothing, nothing is ever sent.

### Trustworthy by construction

A point worth making to a security reviewer: Brain has **no query engine and no
parser exposed to untrusted input.** Several competing memory tools have shipped
real vulnerabilities because they let an AI's output drive a database query
language. Brain stores plain files and searches them with parameterized,
sanitized queries, so that entire class of attack does not apply.

To keep the findings honest, the audit also recorded the plausible-sounding
problems that were investigated and found **not** to be real for this code (for
example, a feared zip "path traversal" on export, and a feared way to smuggle a
malicious address into the optional cleanup step). Documenting what was ruled out,
and why, is part of making the security claims checkable.

### Honest, remaining limitations

- **Encryption at rest is not yet included.** The notes file is protected by your
  operating system's normal file permissions, not by a passphrase. Anyone with
  full access to your user account could read the file directly. Encryption is the
  top item on the next roadmap. Do not store regulated data (medical, payment-card,
  classified) in Brain today.
- **Deletion is currently "soft."** A deleted note is hidden from search but kept
  in the file so it can be recovered. A true permanent-erase option is planned.
- **The installer is not yet code-signed**, so the first launch shows the normal
  "unidentified developer" prompt. Anthropic signs connectors it accepts, which
  resolves this for directory installs.

None of these weaken the core promise: with the default settings, your memory is
a single file on your computer that nothing reads, sends, or tracks, and that a
website you visit can no longer touch.
