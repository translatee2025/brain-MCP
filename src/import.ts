import AdmZip from "adm-zip";
import { statSync } from "node:fs";
import { saveDoc } from "./db.js";
import { redact } from "./redact.js";

// Import notes from a Brain export zip (or any zip of markdown files). The
// inverse of export.ts, completing the round-trip the audit flagged as
// missing. Parses YAML frontmatter for title/folder/tags when present, else
// derives them from the entry path. Secret redaction runs on import too.

const MAX_ZIP_BYTES = 200 * 1024 * 1024; // 200 MB safety cap
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per note cap

type ParsedNote = {
  title: string;
  folder: string;
  tags: string[];
  body: string;
};

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

function deriveFromPath(entryName: string): { title: string; folder: string } {
  const parts = entryName.split("/").filter(Boolean);
  const file = parts.pop() || "untitled.md";
  const folder = parts.join("/");
  const title = file.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || "Untitled";
  return { title, folder };
}

function parseEntry(entryName: string, raw: string): ParsedNote | null {
  const { meta, body } = parseFrontmatter(raw);
  const derived = deriveFromPath(entryName);
  const title = meta.title || derived.title;
  const folder = (meta.folder && meta.folder !== "(root)" ? meta.folder : derived.folder) || "";
  const tags = meta.tags
    ? meta.tags
        .replace(/^\[|\]$/g, "")
        .split(/[,\s]+/)
        .map((t) => t.replace(/['"]/g, "").trim())
        .filter(Boolean)
    : [];
  if (!body.trim()) return null;
  return { title, folder, tags, body };
}

export function importZip(
  zipPath: string,
  opts: { dryRun?: boolean } = {},
): { imported: number; skipped: number; dryRun: boolean; redactions: number; notes: string[] } {
  const st = statSync(zipPath);
  if (st.size > MAX_ZIP_BYTES) throw new Error(`zip too large (${st.size} bytes, max ${MAX_ZIP_BYTES})`);

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  let imported = 0;
  let skipped = 0;
  let redactions = 0;
  const notes: string[] = [];

  for (const e of entries) {
    if (e.isDirectory) continue;
    const name = e.entryName;
    if (!name.toLowerCase().endsWith(".md")) continue;
    if (name.startsWith("_")) continue; // skip _index.md / _metadata.json siblings
    if (e.header.size > MAX_FILE_BYTES) {
      skipped++;
      continue;
    }
    const raw = e.getData().toString("utf8");
    const parsed = parseEntry(name, raw);
    if (!parsed) {
      skipped++;
      continue;
    }
    const scrubbed = redact(parsed.body);
    redactions += scrubbed.count;
    notes.push(`${parsed.folder ? parsed.folder + "/" : ""}${parsed.title}`);
    if (!opts.dryRun) {
      saveDoc({
        title: parsed.title,
        folder: parsed.folder,
        body_md: scrubbed.text,
        tags: parsed.tags,
        changedBy: "import",
      });
    }
    imported++;
  }

  return { imported, skipped, dryRun: !!opts.dryRun, redactions, notes };
}
