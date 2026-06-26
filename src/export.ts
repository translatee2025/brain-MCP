import AdmZip from "adm-zip";
import { join, resolve, isAbsolute } from "node:path";
import { mkdirSync } from "node:fs";
import { exportRows, tagsForDoc, BRAIN_DIR } from "./db.js";

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

function stamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

type Row = {
  id: string;
  title: string;
  folder: string;
  body_md: string;
  created_at: number;
  updated_at: number;
};

// Render one note as frontmatter + body. Tags and full epoch timestamps are
// included so the export round-trips back through import.ts.
function renderNote(r: Row, tags: string[]): string {
  const folder = r.folder || "(root)";
  const tagLine = tags.length ? `tags: [${tags.join(", ")}]\n` : "";
  const front =
    `---\ntitle: ${r.title}\nid: ${r.id}\nfolder: ${folder}\n` +
    tagLine +
    `created: ${stamp(r.created_at)}\nupdated: ${stamp(r.updated_at)}\n` +
    `created_ts: ${r.created_at}\nupdated_ts: ${r.updated_at}\n---\n\n`;
  return front + r.body_md;
}

function relFor(r: Row, used: Set<string>): string {
  const folder = r.folder || "";
  let rel = `${folder ? folder + "/" : ""}${slug(r.title)}.md`;
  let n = 2;
  while (used.has(rel)) {
    rel = `${folder ? folder + "/" : ""}${slug(r.title)}-${n++}.md`;
  }
  used.add(rel);
  return rel;
}

function buildZip(): { zip: AdmZip; count: number } {
  const rows = exportRows() as Row[];
  const zip = new AdmZip();
  const used = new Set<string>();
  const indexByFolder = new Map<string, string[]>();
  const meta: unknown[] = [];

  for (const r of rows) {
    const tags = tagsForDoc(r.id);
    const rel = relFor(r, used);
    zip.addFile(rel, Buffer.from(renderNote(r, tags), "utf8"));

    const key = r.folder || "(root)";
    if (!indexByFolder.has(key)) indexByFolder.set(key, []);
    indexByFolder.get(key)!.push(`- [${r.title}](./${rel}) - ${stamp(r.updated_at)}`);
    meta.push({
      id: r.id,
      title: r.title,
      folder: r.folder,
      tags,
      file: rel,
      created: r.created_at,
      updated: r.updated_at,
    });
  }

  let index = `# Brain Export\n\nExported: ${new Date().toISOString().slice(0, 16).replace("T", " ")}\nDocs: ${rows.length}\nFolders: ${indexByFolder.size}\n\n## Contents\n\n`;
  for (const [folder, lines] of [...indexByFolder.entries()].sort()) {
    index += `### ${folder}\n${lines.join("\n")}\n\n`;
  }
  zip.addFile("_index.md", Buffer.from(index, "utf8"));
  zip.addFile(
    "_metadata.json",
    Buffer.from(JSON.stringify({ exported_at: Date.now(), docs: meta }, null, 2), "utf8"),
  );
  return { zip, count: rows.length };
}

// Resolve an output path safely: default to BRAIN_DIR/exports; if a path is
// given it must end in .zip and must not escape via '..' traversal.
function safeOutPath(outPath?: string): string {
  if (!outPath) {
    const dir = join(BRAIN_DIR, "exports");
    mkdirSync(dir, { recursive: true });
    return join(dir, `brain-export-${stamp(Date.now())}.zip`);
  }
  if (!outPath.toLowerCase().endsWith(".zip")) {
    throw new Error("export path must end in .zip");
  }
  const abs = isAbsolute(outPath) ? resolve(outPath) : resolve(BRAIN_DIR, outPath);
  if (abs.split(/[\\/]/).includes("..")) throw new Error("invalid export path");
  return abs;
}

// Build a zip: folder-structured .md files + _index.md + _metadata.json.
export function exportZip(outPath?: string): { path: string; docCount: number } {
  const { zip, count } = buildZip();
  const path = safeOutPath(outPath);
  zip.writeZip(path);
  return { path, docCount: count };
}

export function exportZipBuffer(): Buffer {
  return buildZip().zip.toBuffer();
}
