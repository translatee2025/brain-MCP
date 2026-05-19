import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

export type DocRow = {
  id: string;
  title: string;
  folder: string;
  body_md: string;
  created_at: number;
  updated_at: number;
};

export type DocSummary = {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  updated_at: number;
};

const BRAIN_DIR =
  process.env.BRAIN_DIR && process.env.BRAIN_DIR.trim().length > 0
    ? process.env.BRAIN_DIR
    : join(homedir(), ".brain");

mkdirSync(BRAIN_DIR, { recursive: true });

const db = new Database(join(BRAIN_DIR, "brain.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");

db.exec(`
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  body_md TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_docs_folder ON docs(folder);
CREATE INDEX IF NOT EXISTS idx_docs_updated ON docs(updated_at DESC);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS doc_tags (
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (doc_id, tag_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  doc_id UNINDEXED,
  title,
  body_md,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS doc_versions (
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  version_n INTEGER NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, version_n)
);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON doc_versions(doc_id, version_n DESC);

CREATE TABLE IF NOT EXISTS capture_buffer (
  session TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (session, seq)
);
`);

const VERSION_KEEP = 20;

const stmt = {
  insertDoc: db.prepare(
    `INSERT INTO docs (id, title, folder, body_md, created_at, updated_at, deleted)
     VALUES (@id, @title, @folder, @body_md, @created_at, @updated_at, 0)`,
  ),
  updateDoc: db.prepare(
    `UPDATE docs SET title=@title, folder=@folder, body_md=@body_md, updated_at=@updated_at
     WHERE id=@id AND deleted=0`,
  ),
  getDoc: db.prepare(`SELECT * FROM docs WHERE id=? AND deleted=0`),
  softDelete: db.prepare(
    `UPDATE docs SET deleted=1, updated_at=? WHERE id=? AND deleted=0`,
  ),
  ensureTag: db.prepare(`INSERT OR IGNORE INTO tags(name) VALUES (?)`),
  tagId: db.prepare(`SELECT id FROM tags WHERE name=?`),
  linkTag: db.prepare(
    `INSERT OR IGNORE INTO doc_tags(doc_id, tag_id) VALUES (?, ?)`,
  ),
  clearTags: db.prepare(`DELETE FROM doc_tags WHERE doc_id=?`),
  docTags: db.prepare(
    `SELECT t.name FROM tags t JOIN doc_tags dt ON dt.tag_id=t.id WHERE dt.doc_id=? ORDER BY t.name`,
  ),
  ftsDelete: db.prepare(`DELETE FROM fts WHERE doc_id=?`),
  ftsInsert: db.prepare(
    `INSERT INTO fts(doc_id, title, body_md, tags) VALUES (?, ?, ?, ?)`,
  ),
  listAll: db.prepare(
    `SELECT id, title, folder, updated_at FROM docs WHERE deleted=0 ORDER BY updated_at DESC LIMIT ?`,
  ),
  listFolder: db.prepare(
    `SELECT id, title, folder, updated_at FROM docs WHERE deleted=0 AND folder=? ORDER BY updated_at DESC LIMIT ?`,
  ),
  folders: db.prepare(
    `SELECT folder, COUNT(*) AS n FROM docs WHERE deleted=0 GROUP BY folder ORDER BY folder`,
  ),
  ftsSearch: db.prepare(
    `SELECT f.doc_id AS id, d.title, d.folder, d.updated_at,
            snippet(fts, 2, '[', ']', ' ... ', 12) AS snippet
     FROM fts f JOIN docs d ON d.id=f.doc_id
     WHERE fts MATCH ? AND d.deleted=0
     ORDER BY bm25(fts) LIMIT ?`,
  ),
  nextVersion: db.prepare(
    `SELECT COALESCE(MAX(version_n), 0) + 1 AS n FROM doc_versions WHERE doc_id=?`,
  ),
  insertVersion: db.prepare(
    `INSERT INTO doc_versions (doc_id, version_n, title, body_md, changed_by, changed_at)
     VALUES (@doc_id, @version_n, @title, @body_md, @changed_by, @changed_at)`,
  ),
  listVersions: db.prepare(
    `SELECT version_n, title, changed_by, changed_at
     FROM doc_versions WHERE doc_id=? ORDER BY version_n DESC`,
  ),
  getVersion: db.prepare(
    `SELECT title, body_md FROM doc_versions WHERE doc_id=? AND version_n=?`,
  ),
  pruneVersions: db.prepare(
    `DELETE FROM doc_versions WHERE doc_id=? AND version_n <=
       (SELECT MAX(version_n) FROM doc_versions WHERE doc_id=?) - ?`,
  ),
  capAppend: db.prepare(
    `INSERT INTO capture_buffer (session, seq, text, ts)
     VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM capture_buffer WHERE session=?), ?, ?)`,
  ),
  capGet: db.prepare(
    `SELECT text FROM capture_buffer WHERE session=? ORDER BY seq`,
  ),
  capClear: db.prepare(`DELETE FROM capture_buffer WHERE session=?`),
  allForExport: db.prepare(
    `SELECT id, title, folder, body_md, created_at, updated_at
     FROM docs WHERE deleted=0 ORDER BY folder, created_at`,
  ),
};

function snapshot(
  docId: string,
  title: string,
  body: string,
  changedBy: string,
) {
  const n = (stmt.nextVersion.get(docId) as { n: number }).n;
  stmt.insertVersion.run({
    doc_id: docId,
    version_n: n,
    title,
    body_md: body,
    changed_by: changedBy,
    changed_at: Date.now(),
  });
  stmt.pruneVersions.run(docId, docId, VERSION_KEEP);
}

function tagsFor(docId: string): string[] {
  return (stmt.docTags.all(docId) as { name: string }[]).map((r) => r.name);
}

function reindex(docId: string, title: string, body: string, tags: string[]) {
  stmt.ftsDelete.run(docId);
  stmt.ftsInsert.run(docId, title, body, tags.join(" "));
}

function applyTags(docId: string, tags: string[]) {
  stmt.clearTags.run(docId);
  for (const raw of tags) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    stmt.ensureTag.run(name);
    const row = stmt.tagId.get(name) as { id: number } | undefined;
    if (row) stmt.linkTag.run(docId, row.id);
  }
}

export const saveDoc = db.transaction(
  (input: {
    id?: string;
    title: string;
    folder?: string;
    body_md: string;
    tags?: string[];
    changedBy?: string;
  }): { id: string; created: boolean } => {
    const now = Date.now();
    const folder = (input.folder ?? "").trim();
    const tags = input.tags ?? [];
    const changedBy = input.changedBy ?? "restructure";

    if (input.id) {
      const existing = stmt.getDoc.get(input.id) as DocRow | undefined;
      if (!existing) throw new Error(`doc not found: ${input.id}`);
      stmt.updateDoc.run({
        id: input.id,
        title: input.title,
        folder,
        body_md: input.body_md,
        updated_at: now,
      });
      applyTags(input.id, tags);
      reindex(input.id, input.title, input.body_md, tagsFor(input.id));
      snapshot(input.id, input.title, input.body_md, changedBy);
      return { id: input.id, created: false };
    }

    const id = randomUUID();
    stmt.insertDoc.run({
      id,
      title: input.title,
      folder,
      body_md: input.body_md,
      created_at: now,
      updated_at: now,
    });
    applyTags(id, tags);
    reindex(id, input.title, input.body_md, tagsFor(id));
    snapshot(id, input.title, input.body_md, changedBy);
    return { id, created: true };
  },
);

export function listVersions(docId: string): {
  version_n: number;
  title: string;
  changed_by: string;
  changed_at: number;
}[] {
  return stmt.listVersions.all(docId) as {
    version_n: number;
    title: string;
    changed_by: string;
    changed_at: number;
  }[];
}

export const restoreVersion = db.transaction(
  (docId: string, versionN: number): boolean => {
    const v = stmt.getVersion.get(docId, versionN) as
      | { title: string; body_md: string }
      | undefined;
    if (!v) return false;
    const cur = stmt.getDoc.get(docId) as DocRow | undefined;
    if (!cur) return false;
    stmt.updateDoc.run({
      id: docId,
      title: v.title,
      folder: cur.folder,
      body_md: v.body_md,
      updated_at: Date.now(),
    });
    reindex(docId, v.title, v.body_md, tagsFor(docId));
    snapshot(docId, v.title, v.body_md, `rollback:v${versionN}`);
    return true;
  },
);

export function getVersionBody(
  docId: string,
  versionN: number,
): { title: string; body_md: string } | null {
  return (
    (stmt.getVersion.get(docId, versionN) as
      | { title: string; body_md: string }
      | undefined) ?? null
  );
}

export const captureAppend = db.transaction(
  (session: string, text: string): void => {
    stmt.capAppend.run(session, session, text, Date.now());
  },
);

export function captureGet(session: string): string {
  return (stmt.capGet.all(session) as { text: string }[])
    .map((r) => r.text)
    .join("\n\n");
}

export function captureClear(session: string): void {
  stmt.capClear.run(session);
}

export function exportRows(): {
  id: string;
  title: string;
  folder: string;
  body_md: string;
  created_at: number;
  updated_at: number;
}[] {
  return stmt.allForExport.all() as {
    id: string;
    title: string;
    folder: string;
    body_md: string;
    created_at: number;
    updated_at: number;
  }[];
}

export const DB_FILE = join(BRAIN_DIR, "brain.db");

export function getDoc(id: string): (DocRow & { tags: string[] }) | null {
  const row = stmt.getDoc.get(id) as DocRow | undefined;
  if (!row) return null;
  return { ...row, tags: tagsFor(id) };
}

export const deleteDoc = db.transaction((id: string): boolean => {
  const res = stmt.softDelete.run(Date.now(), id);
  stmt.ftsDelete.run(id);
  return res.changes > 0;
});

export function listDocs(folder: string | undefined, limit: number): DocSummary[] {
  const rows = (
    folder && folder.trim().length > 0
      ? stmt.listFolder.all(folder.trim(), limit)
      : stmt.listAll.all(limit)
  ) as Omit<DocSummary, "tags">[];
  return rows.map((r) => ({ ...r, tags: tagsFor(r.id) }));
}

export function listFolders(): { folder: string; count: number }[] {
  return (stmt.folders.all() as { folder: string; n: number }[]).map((r) => ({
    folder: r.folder || "(root)",
    count: r.n,
  }));
}

// FTS5 MATCH is strict about syntax. Reduce the user query to safe quoted
// terms so a stray ':' or '(' can never throw a query-syntax error.
function sanitizeQuery(q: string): string {
  const terms = q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((t) => t.length > 0)
    .slice(0, 16);
  return terms.map((t) => `"${t}"`).join(" ");
}

export function search(
  q: string,
  folder: string | undefined,
  limit: number,
): { id: string; title: string; folder: string; updated_at: number; snippet: string }[] {
  const match = sanitizeQuery(q);
  if (!match) return [];
  const rows = stmt.ftsSearch.all(match, limit) as {
    id: string;
    title: string;
    folder: string;
    updated_at: number;
    snippet: string;
  }[];
  const f = folder?.trim();
  return f ? rows.filter((r) => r.folder === f) : rows;
}

export { BRAIN_DIR };
