# Privacy Policy — Brain MCP

**Last updated:** 2026-06-24

Brain MCP is a local memory tool. Your notes, your machine, no cloud — unless
you explicitly opt in. This page describes exactly what happens to your data
and what the extension does or does not do with it.

## 1. Who runs this extension

Brain MCP is published by the GitHub user **translatee2025**
(<https://github.com/translatee2025>). It is open-source software released
under the MIT License. Contact: open an issue on the public repository at
<https://github.com/translatee2025/brain-MCP/issues>.

## 2. What data the extension processes

The extension stores **notes you (or the AI model on your behalf) ask it to
save**. Each note typically contains:

- a title you choose,
- the markdown body of the note,
- an optional folder path and tags,
- timestamps and a version history,
- a per-session "capture buffer" of text you accumulate before saving.

Whatever you type into a chat and ask Claude to save through this extension
becomes a note. The extension itself adds no extra collection.

## 3. Where the data is stored

All data is stored **locally on your computer**, in a SQLite database file:

- Default location: `~/.brain/brain.db`
- Override location: the `BRAIN_DIR` user-config setting

Exports (zip archives) are written to `~/.brain/exports/` only when you run
the export tool. The local web viewer binds to `127.0.0.1` only and is not
reachable from the network.

The extension does not synchronise this data anywhere. It does not back it up
to the cloud. It does not transmit it to the author or to any third party.

## 4. What is sent over the network

By default, **nothing**. The extension performs no telemetry, analytics,
crash reporting, version checks, or background network requests.

There are two and only two situations where network traffic can leave your
machine, and both are user-controlled:

1. **MCP sampling** (`restructure_mode = "sampling"`). If you set this mode,
   the extension asks Claude Desktop's own model — over the existing MCP
   sampling channel that you already use for chat — to tidy up your raw text
   before storing it. No new endpoint is contacted by the extension itself;
   the host application handles the model call.
2. **OpenAI-compatible endpoint** (`restructure_mode = "openai"`). If you
   configure `llm_base_url`, `llm_api_key`, and `llm_model`, the extension
   will POST your raw text to **the endpoint you configured** to have it
   restructured. This can be a remote service (e.g. `api.openai.com`) or a
   local model server you run yourself (e.g. Ollama on `127.0.0.1:11434`).
   You choose. The extension contacts no other endpoint.

If neither mode is configured (`restructure_mode = "none"`, the default), no
network traffic ever leaves your machine.

## 5. Third-party data sharing

The author does not collect, sell, share, or have any access to your data.
The extension does not include any third-party SDKs, trackers, or telemetry.

If you opt into the `openai` restructure mode (section 4 above), your text is
sent to **the endpoint you chose**, and that endpoint's own privacy policy
applies to that traffic. The author of Brain MCP has no relationship with
that endpoint and does not receive any data from it.

## 6. Data retention and deletion

You control retention entirely:

- Soft-delete a single note via the `brain_delete` tool or the web UI's
  Delete button. The row is marked deleted and removed from search.
- Hard-delete everything by deleting the storage folder (default `~/.brain`).
- Export everything as a zip at any time via the `brain_export` tool or the
  web UI's "Download .zip" / "Download DB" buttons.

The author cannot delete your data because the author never has it.

## 7. Children's data

Brain MCP is a developer tool for adult users. It does not knowingly process
data from children under 13.

## 8. Security

Data is stored in a plain SQLite file under your home directory, protected by
your operating system's file permissions. The local web viewer is bound to
`127.0.0.1` only. If you opt into an OpenAI-compatible endpoint, your API
key is stored in the extension's user-config (sensitive field) and sent only
to the endpoint URL you specified.

This is a local-first tool, not a hardened secure-storage system. Do not use
it to store regulated data (PHI, PCI cardholder data, classified material).

## 9. Changes to this policy

Material changes will be published as new versions of this file in the
repository, with the date at the top updated.

## 10. Contact

Questions or concerns: open an issue at
<https://github.com/translatee2025/brain-MCP/issues>.
