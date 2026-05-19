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
import { startUi } from "./ui.js";

const FLUSH_TOKENS = Number(process.env.BRAIN_FLUSH_TOKENS ?? 6000);
const estTokens = (s: string) => Math.ceil(s.length / 4);

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

export function buildServer(): McpServer {
  const server = new McpServer({ name: "brain", version: "0.1.0" });

  server.tool(
    "brain_save",
    "Save a clean note to long-term memory. Write the content as polished standalone prose yourself before calling this; set restructure='none' to keep it verbatim, 'sampling' to have the host model tidy it, 'openai' to use a configured endpoint.",
    {
      title: z.string().describe("Short descriptive title."),
      content: z.string().describe("The note body (markdown)."),
      folder: z.string().optional().describe("Folder path, e.g. 'Projects/Modem'."),
      tags: z.array(z.string()).optional(),
      id: z.string().optional().describe("Existing doc id to overwrite."),
      restructure: z.enum(["sampling", "openai", "none"]).optional(),
    },
    async (args) => {
      const { body, engine } = await restructure(
        server,
        args.title,
        args.content,
        args.restructure,
      );
      const res = saveDoc({
        id: args.id,
        title: args.title,
        folder: args.folder,
        body_md: body,
        tags: args.tags,
      });
      return ok(
        `${res.created ? "Created" : "Updated"} "${args.title}" (id ${res.id}, engine ${engine})` +
          (engine === "raw" && (args.restructure ?? "") !== "none"
            ? " — restructure engine unavailable, stored verbatim"
            : ""),
      );
    },
  );

  server.tool(
    "brain_search",
    "Full-text search across saved notes. Returns ids, titles and snippets.",
    {
      query: z.string(),
      folder: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      const hits = search(args.query, args.folder, args.limit ?? 10);
      if (hits.length === 0) return ok("No matches.");
      return ok(
        hits
          .map(
            (h) =>
              `- [${h.id}] ${h.folder ? h.folder + "/" : ""}${h.title}\n  ${h.snippet}`,
          )
          .join("\n"),
      );
    },
  );

  server.tool(
    "brain_get",
    "Fetch one note in full by id.",
    { id: z.string() },
    async (args) => {
      const d = getDoc(args.id);
      if (!d) return ok(`Not found: ${args.id}`);
      const meta = `# ${d.title}\nfolder: ${d.folder || "(root)"} | tags: ${d.tags.join(", ") || "none"}\n\n`;
      return ok(meta + d.body_md);
    },
  );

  server.tool(
    "brain_list",
    "List recent notes, optionally within a folder.",
    {
      folder: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args) => {
      const docs = listDocs(args.folder, args.limit ?? 50);
      const folders = listFolders();
      if (docs.length === 0) return ok("Brain is empty.");
      const header =
        "Folders: " +
        folders.map((f) => `${f.folder} (${f.count})`).join(", ") +
        "\n\n";
      return ok(
        header +
          docs
            .map(
              (d) =>
                `- [${d.id}] ${d.folder ? d.folder + "/" : ""}${d.title}` +
                (d.tags.length ? ` #${d.tags.join(" #")}` : ""),
            )
            .join("\n"),
      );
    },
  );

  server.tool(
    "brain_delete",
    "Soft-delete a note by id (removed from search and listing; not purged).",
    { id: z.string() },
    async (args) => ok(deleteDoc(args.id) ? `Deleted ${args.id}` : `Not found: ${args.id}`),
  );

  server.tool(
    "brain_system_check",
    "Inspect this machine's RAM/CPU and recommend a local model + exact setup steps for local restructuring.",
    {},
    async () => {
      const s = systemCheck();
      return ok(
        `Platform: ${s.platform}\nRAM: ${s.totalRamGb} GB | CPU cores: ${s.cpuCores}\nStorage dir: ${BRAIN_DIR}\n\nRecommended: ${s.recommendation}\n\nSetup:\n${s.setup.map((l) => "  " + l).join("\n")}`,
      );
    },
  );

  server.tool(
    "brain_versions",
    "List the version history of a note (newest first).",
    { id: z.string() },
    async (args) => {
      const vs = listVersions(args.id);
      if (vs.length === 0) return ok("No versions (or unknown id).");
      return ok(
        vs
          .map(
            (v) =>
              `v${v.version_n} — ${v.changed_by} — ${new Date(v.changed_at).toLocaleString()}`,
          )
          .join("\n"),
      );
    },
  );

  server.tool(
    "brain_restore",
    "Restore a note to an earlier version. The current state is kept as a new version first (non-destructive).",
    { id: z.string(), version_n: z.number().int() },
    async (args) =>
      ok(
        restoreVersion(args.id, args.version_n)
          ? `Restored ${args.id} to v${args.version_n}.`
          : `Could not restore: unknown id or version.`,
      ),
  );

  // Running buffer so a long conversation can be flushed in one note.
  // Call brain_capture after each substantial exchange; when it reports
  // should_flush (or the user says "save to brain"), call brain_flush.
  server.tool(
    "brain_capture",
    "Append the latest exchange to a running buffer. Returns the buffer token estimate and should_flush=true once it crosses the threshold (~10 pages). Does not save yet.",
    {
      text: z.string(),
      session: z.string().optional().describe("Conversation key; defaults to 'default'."),
    },
    async (args) => {
      const session = args.session ?? "default";
      captureAppend(session, args.text);
      const tokens = estTokens(captureGet(session));
      const shouldFlush = tokens >= FLUSH_TOKENS;
      return ok(
        `buffered. session=${session} tokens~${tokens} threshold=${FLUSH_TOKENS} should_flush=${shouldFlush}` +
          (shouldFlush ? " — call brain_flush now." : ""),
      );
    },
  );

  server.tool(
    "brain_flush",
    "Restructure the running buffer into one clean note, save it, and clear the buffer. Call when brain_capture reports should_flush or when the user says 'save to brain'.",
    {
      title: z.string(),
      session: z.string().optional(),
      folder: z.string().optional(),
      tags: z.array(z.string()).optional(),
      restructure: z.enum(["sampling", "openai", "none"]).optional(),
    },
    async (args) => {
      const session = args.session ?? "default";
      const raw = captureGet(session);
      if (!raw.trim()) return ok(`Buffer '${session}' is empty, nothing to save.`);
      const { body, engine } = await restructure(
        server,
        args.title,
        raw,
        args.restructure,
      );
      const res = saveDoc({
        title: args.title,
        folder: args.folder,
        body_md: body,
        tags: args.tags,
      });
      captureClear(session);
      return ok(
        `Flushed buffer '${session}' → "${args.title}" (id ${res.id}, engine ${engine}). Buffer cleared.`,
      );
    },
  );

  server.tool(
    "brain_export",
    "Export the whole brain to a zip (folder-structured .md + _index.md + _metadata.json). Returns the file path.",
    { path: z.string().optional().describe("Optional output .zip path.") },
    async (args) => {
      const r = exportZip(args.path);
      return ok(`Exported ${r.docCount} docs to ${r.path}`);
    },
  );

  server.tool(
    "brain_open_ui",
    "Open the local web viewer to browse, read, edit and download notes. Returns the URL.",
    {},
    async () => {
      const { url } = startUi();
      if (process.platform === "darwin") exec(`open ${url}`);
      else if (process.platform === "win32") exec(`start ${url}`);
      return ok(`Brain UI running at ${url} (localhost only).`);
    },
  );

  // Expose every note as a readable resource so the host model can pull
  // the knowledge base in as context without an explicit tool call.
  server.resource(
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
