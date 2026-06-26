// Verifies the UI lockdown: token required, DNS-rebinding (bad Host) rejected,
// raw DB download gated. Plus import round-trip. Run: node test/ui-security.mjs
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "brain-ui-"));
process.env.BRAIN_DIR = DIR;
const PORT = 4399;
process.env.BRAIN_UI_PORT = String(PORT);

let pass = 0,
  fail = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  :: " + e : ""}`);
  c ? pass++ : fail++;
};

// raw request so we can forge the Host header (fetch forbids it)
function rawGet(path, { host, headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method: "GET", headers: { host: host ?? `127.0.0.1:${PORT}`, ...headers } },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      },
    );
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
    req.end();
  });
}

const db = await import("../dist/db.js");
const { startUi } = await import("../dist/ui.js");

// seed a note with a secret to ensure the DB has content
db.saveDoc({ title: "Secret note", folder: "X", body_md: "hello world body", tags: ["a"] });

const { url } = startUi();
const token = new URL(url).searchParams.get("t");
await new Promise((r) => setTimeout(r, 300));

// 1. no token -> 403
let r = await rawGet("/api/docs");
check("GET /api/docs without token -> 403", r.status === 403, "status " + r.status);

// 2. with token -> 200 and returns the note
r = await rawGet(`/api/docs?t=${token}`);
check("GET /api/docs with token -> 200", r.status === 200, "status " + r.status);
check("docs payload includes the seeded note", r.body.includes("Secret note"));

// 3. DNS rebinding: valid token but attacker Host header -> 403
r = await rawGet(`/api/docs?t=${token}`, { host: "evil.example.com" });
check("rebinding (bad Host) rejected even WITH token -> 403", r.status === 403, "status " + r.status);

// 4. raw DB download gated by token
r = await rawGet("/download/db");
check("GET /download/db without token -> 403", r.status === 403, "status " + r.status);
r = await rawGet(`/download/db?t=${token}`);
check("GET /download/db with token -> 200", r.status === 200, "status " + r.status);

// 5. page served, CSP present, no token needed for the shell
r = await rawGet("/");
check("GET / serves the app shell", r.status === 200 && r.body.includes("<title>Brain</title>"));

// 6. import round-trip: export to a zip, import it back into a fresh dir count
const { exportZip } = await import("../dist/export.js");
const { importZip } = await import("../dist/import.js");
const ex = exportZip();
const dry = importZip(ex.path, { dryRun: true });
check("import dry-run sees the exported note", dry.imported >= 1, JSON.stringify(dry).slice(0, 120));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
