import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exec } from "node:child_process";
import {
  saveDoc,
  getDoc,
  deleteDoc,
  listDocs,
  listFolders,
  search,
  listVersions,
  restoreVersion,
  captureAppend,
  captureGet,
  captureClear,
  BRAIN_DIR,
} from "./db.js";
import { restructure, systemCheck } from "./restructure.js";
import { exportZip } from "./export.js";
import { importZip } from "./import.js";
import { redact } from "./redact.js";
import { startUi } from "./ui.js";

const FLUSH_TOKENS = Number(process.env.BRAIN_FLUSH_TOKENS ?? 6000);
const estTokens = (s: string) => Math.ceil(s.length / 4);

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

function redactNote(s: string): { text: string; suffix: string } {
  const r = redact(s);
  return {
    text: r.text,
    suffix: r.count > 0 ? ` (${r.count} secret${r.count === 1 ? "" : "s"} redacted before saving)` : "",
  };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "brain", version: "0.1.0" });

  server.registerTool(
    "brain_save",
    {
      title: "Save note",
      description:
        "Save a markdown note to long-term memory with a title, optional folder, and tags. Pass an existing id to overwrite that note. Secrets are stripped before storage. The restructure option controls optional cleanup before saving.",
      inputSchema: {
        title: z.string().describe("Short descriptive title."),
        content: z.string().describe("The note body (markdown)."),
        folder: z.string().optional().describe("Folder path, e.g. 'Projects/Modem'."),
        tags: z.array(z.string()).optional(),
        id: z.string().optional().describe("Existing doc id to overwrite."),
        restructure: z.enum(["sampling", "openai", "none"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const red = redactNote(args.content);
      const { body, engine, truncated } = await restructure(server, args.title, red.text, args.restructure);
      const res = saveDoc({ id: args.id, title: args.title, folder: args.folder, body_md: body, tags: args.tags });
      const note =
        truncated
          ? " (restructured output would have been truncated; stored verbatim to avoid losing content)"
          : engine === "raw" && (args.restructure ?? "") !== "none"
            ? " (restructure engine unavailable; stored verbatim)"
            : "";
      return ok(`${res.created ? "Created" : "Updated"} "${args.title}" (id ${res.id}, engine ${engine})${note}${red.suffix}`);
    },
  );

  server.registerTool(
    "brain_search",
    {
      title: "Search notes",
      description: "Full-text search across saved notes. Returns ids, titles, and matching snippets.",
      inputSchema: {
        query: z.string(),
        folder: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const hits = search(args.query, args.folder, args.limit ?? 10);
      if (hits.length === 0) return ok("No matches.");
      return ok(
        hits.map((h) => `- [${h.id}] ${h.folder ? h.folder + "/" : ""}${h.title}\n  ${h.snippet}`).join("\n"),
      );
    },
  );

  server.registerTool(
    "brain_get",
    {
      title: "Get note",
      description: "Fetch one note in full by id, including its folder and tags.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const d = getDoc(args.id);
      if (!d) return ok(`Not found: ${args.id}`);
      const meta = `# ${d.title}\nfolder: ${d.folder || "(root)"} | tags: ${d.tags.join(", ") || "none"}\n\n`;
      return ok(meta + d.body_md);
    },
  );

  server.registerTool(
    "brain_list",
    {
      title: "List notes",
      description: "List recent notes with per-folder counts, optionally scoped to one folder.",
      inputSchema: {
        folder: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const docs = listDocs(args.folder, args.limit ?? 50);
      const folders = listFolders();
      if (docs.length === 0) return ok("Brain is empty.");
      const header = "Folders: " + folders.map((f) => `${f.folder} (${f.count})`).join(", ") + "\n\n";
      return ok(
        header +
          docs
            .map((d) => `- [${d.id}] ${d.folder ? d.folder + "/" : ""}${d.title}` + (d.tags.length ? ` #${d.tags.join(" #")}` : ""))
            .join("\n"),
      );
    },
  );

  server.registerTool(
    "brain_delete",
    {
      title: "Delete note",
      description: "Soft-delete a note by id. It is removed from search and listings but retained in the database.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => ok(deleteDoc(args.id) ? `Deleted ${args.id}` : `Not found: ${args.id}`),
  );

  server.registerTool(
    "brain_versions",
    {
      title: "List versions",
      description: "List the version history of a note, newest first.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const vs = listVersions(args.id);
      if (vs.length === 0) return ok("No versions (or unknown id).");
      return ok(vs.map((v) => `v${v.version_n} — ${v.changed_by} — ${new Date(v.changed_at).toLocaleString()}`).join("\n"));
    },
  );

  server.registerTool(
    "brain_restore",
    {
      title: "Restore version",
      description: "Restore a note to an earlier version. The current state is snapshotted first, so the restore is non-destructive.",
      inputSchema: { id: z.string(), version_n: z.number().int() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      ok(restoreVersion(args.id, args.version_n) ? `Restored ${args.id} to v${args.version_n}.` : `Could not restore: unknown id or version.`),
  );

  server.registerTool(
    "brain_capture",
    {
      title: "Capture to buffer",
      description:
        "Append the latest exchange to a per-session buffer for later saving. Returns a token estimate and should_flush=true once the buffer crosses the auto-save threshold. Does not create a note yet. Secrets are stripped before buffering.",
      inputSchema: {
        text: z.string(),
        session: z.string().optional().describe("Conversation key; defaults to 'default'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const session = args.session ?? "default";
      captureAppend(session, redact(args.text).text);
      const tokens = estTokens(captureGet(session));
      const shouldFlush = tokens >= FLUSH_TOKENS;
      return ok(
        `buffered. session=${session} tokens~${tokens} threshold=${FLUSH_TOKENS} should_flush=${shouldFlush}` +
          (shouldFlush ? " — call brain_flush now." : ""),
      );
    },
  );

  server.registerTool(
    "brain_flush",
    {
      title: "Flush buffer to note",
      description: "Restructure the running buffer into one note, save it, and clear the buffer. The buffer is only cleared after the note is saved.",
      inputSchema: {
        title: z.string(),
        session: z.string().optional(),
        folder: z.string().optional(),
        tags: z.array(z.string()).optional(),
        restructure: z.enum(["sampling", "openai", "none"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const session = args.session ?? "default";
      const raw = redact(captureGet(session)).text;
      if (!raw.trim()) return ok(`Buffer '${session}' is empty, nothing to save.`);
      const { body, engine, truncated } = await restructure(server, args.title, raw, args.restructure);
      const res = saveDoc({ title: args.title, folder: args.folder, body_md: body, tags: args.tags });
      // body always contains the full content (raw on failure/truncation), so
      // clearing now cannot lose anything.
      captureClear(session);
      const note = truncated ? " (restructured output would have been truncated; stored verbatim)" : "";
      return ok(`Flushed buffer '${session}' to "${args.title}" (id ${res.id}, engine ${engine})${note}. Buffer cleared.`);
    },
  );

  server.registerTool(
    "brain_export",
    {
      title: "Export brain",
      description: "Export all notes to a zip of folder-structured markdown (with an index and metadata). Returns the file path.",
      inputSchema: { path: z.string().optional().describe("Optional output .zip path inside the brain directory.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const r = exportZip(args.path);
      return ok(`Exported ${r.docCount} docs to ${r.path}`);
    },
  );

  server.registerTool(
    "brain_import",
    {
      title: "Import notes",
      description: "Import notes from a Brain export zip (or any zip of markdown files). Use dry_run to preview the count without writing. Secrets are stripped on import.",
      inputSchema: {
        path: z.string().describe("Path to a .zip of markdown notes."),
        dry_run: z.boolean().optional().describe("Preview without writing."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const r = importZip(args.path, { dryRun: args.dry_run });
        const head = r.dryRun
          ? `Dry run: ${r.imported} notes would be imported, ${r.skipped} skipped`
          : `Imported ${r.imported} notes, ${r.skipped} skipped`;
        const red = r.redactions > 0 ? ` (${r.redactions} secrets redacted)` : "";
        const sample = r.notes.slice(0, 10).map((n) => `- ${n}`).join("\n");
        return ok(`${head}${red}.\n${sample}${r.notes.length > 10 ? `\n...and ${r.notes.length - 10} more` : ""}`);
      } catch (e) {
        return ok(`Import failed: ${String(e)}`);
      }
    },
  );

  server.registerTool(
    "brain_open_ui",
    {
      title: "Open web viewer",
      description: "Start the local web viewer (loopback only) to browse, read, edit, restore, and download notes, then open it in the browser. Returns the URL.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const { url } = startUi();
      if (process.platform === "darwin") exec(`open "${url}"`);
      else if (process.platform === "win32") exec(`start "" "${url}"`);
      else exec(`xdg-open "${url}"`);
      return ok(`Brain UI running at ${url} (loopback only; the URL carries a one-time access token).`);
    },
  );

  server.registerTool(
    "brain_system_check",
    {
      title: "System check",
      description: "Report this machine's RAM, CPU, and platform, and recommend a right-sized local model plus setup steps for offline restructuring.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const s = systemCheck();
      return ok(
        `Platform: ${s.platform}\nRAM: ${s.totalRamGb} GB | CPU cores: ${s.cpuCores}\nStorage dir: ${BRAIN_DIR}\n\nRecommended: ${s.recommendation}\n\nSetup:\n${s.setup.map((l) => "  " + l).join("\n")}`,
      );
    },
  );

  // Expose every note as a readable resource so the host model can pull the
  // knowledge base in as context without an explicit tool call.
  server.registerResource(
    "doc",
    new ResourceTemplate("brain://doc/{id}", {
      list: async () => ({
        resources: listDocs(undefined, 200).map((d) => ({
          uri: `brain://doc/${d.id}`,
          name: `${d.folder ? d.folder + "/" : ""}${d.title}`,
          mimeType: "text/markdown",
        })),
      }),
    }),
    { title: "Brain note", description: "A saved markdown note from long-term memory." },
    async (uri, { id }) => {
      const d = getDoc(String(id));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: d ? `# ${d.title}\n\n${d.body_md}` : `Not found: ${id}`,
          },
        ],
      };
    },
  );

  return server;
}
