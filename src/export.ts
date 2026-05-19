import AdmZip from "adm-zip";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { exportRows, BRAIN_DIR } from "./db.js";

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

// Build a zip: folder-structured .md files + _index.md + _metadata.json.
// Returns the written zip path.
export function exportZip(outPath?: string): {
  path: string;
  docCount: number;
} {
  const rows = exportRows();
  const zip = new AdmZip();
  const used = new Set<string>();
  const indexByFolder = new Map<string, string[]>();
  const meta: unknown[] = [];

  for (const r of rows) {
    const folder = r.folder || "";
    let rel = `${folder ? folder + "/" : ""}${slug(r.title)}.md`;
    let n = 2;
    while (used.has(rel)) {
      rel = `${folder ? folder + "/" : ""}${slug(r.title)}-${n++}.md`;
    }
    used.add(rel);

    const front =
      `---\ntitle: ${r.title}\nid: ${r.id}\nfolder: ${folder || "(root)"}\n` +
      `created: ${stamp(r.created_at)}\nupdated: ${stamp(r.updated_at)}\n---\n\n`;
    zip.addFile(rel, Buffer.from(front + r.body_md, "utf8"));

    const key = folder || "(root)";
    if (!indexByFolder.has(key)) indexByFolder.set(key, []);
    indexByFolder
      .get(key)!
      .push(`- [${r.title}](./${rel}) - ${stamp(r.updated_at)}`);
    meta.push({
      id: r.id,
      title: r.title,
      folder,
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

  let path = outPath;
  if (!path) {
    const dir = join(BRAIN_DIR, "exports");
    mkdirSync(dir, { recursive: true });
    path = join(dir, `brain-export-${stamp(Date.now())}.zip`);
  }
  zip.writeZip(path);
  return { path, docCount: rows.length };
}

export function exportZipBuffer(): Buffer {
  const rows = exportRows();
  const zip = new AdmZip();
  const used = new Set<string>();
  for (const r of rows) {
    const folder = r.folder || "";
    let rel = `${folder ? folder + "/" : ""}${slug(r.title)}.md`;
    let n = 2;
    while (used.has(rel)) {
      rel = `${folder ? folder + "/" : ""}${slug(r.title)}-${n++}.md`;
    }
    used.add(rel);
    zip.addFile(rel, Buffer.from(r.body_md, "utf8"));
  }
  return zip.toBuffer();
}
