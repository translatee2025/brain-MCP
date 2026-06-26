import http from "node:http";
import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { Marked } from "marked";
import {
  listDocs,
  listFolders,
  getDoc,
  saveDoc,
  deleteDoc,
  search,
  listVersions,
  restoreVersion,
  getVersionBody,
  DB_FILE,
} from "./db.js";
import { exportZipBuffer } from "./export.js";

let server: http.Server | null = null;
let boundPort = 0;
let started = false;

// Per-launch secret. The opened URL carries ?t=<TOKEN>; every /api and
// /download request must present it. A website that re-binds DNS to 127.0.0.1
// (the classic loopback attack) still does not know this token, and the Host
// check below rejects it regardless.
const TOKEN = randomBytes(24).toString("hex");

// Drop raw HTML at render time (defense in depth alongside the CSP). Markdown
// syntax still renders; embedded <script>/<svg onload>/etc. are removed.
const md = new Marked();
md.use({ renderer: { html: () => "" } });

function renderMd(markdown: string): string {
  const html = md.parse(markdown, { async: false }) as string;
  // Belt-and-suspenders: strip anything that slipped through. The real
  // guarantee is the nonce CSP (no inline/script execution) on the response.
  return html
    .replace(/<\s*(script|iframe|object|embed|link|meta)\b[\s\S]*?(?:<\/\s*\1\s*>|>)/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')?\s*javascript:[^"'\s>]*/gi, "$1=#");
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(s),
    "cache-control": "no-store",
  });
  res.end(s);
}

async function readBody(req: http.IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

// Reject any request whose Host header is not our loopback origin. This is the
// primary defense against DNS rebinding: a rebound request arrives with the
// attacker's hostname in Host, which fails this check.
function hostOk(req: http.IncomingMessage): boolean {
  const host = (req.headers.host || "").toLowerCase();
  return (
    host === `127.0.0.1:${boundPort}` ||
    host === `localhost:${boundPort}` ||
    host === `[::1]:${boundPort}`
  );
}

function originOk(req: http.IncomingMessage): boolean {
  const o = req.headers.origin;
  if (!o) return true; // top-level navigations (downloads) send no Origin
  return (
    o === `http://127.0.0.1:${boundPort}` ||
    o === `http://localhost:${boundPort}` ||
    o === `http://[::1]:${boundPort}`
  );
}

function tokenOk(u: URL): boolean {
  return u.searchParams.get("t") === TOKEN;
}

const PAGE = (nonce: string) => `<!doctype html><html><head><meta charset="utf-8">
<title>Brain</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;font:14px/1.55 -apple-system,system-ui,sans-serif;color:#1c1c1e;background:#f5f5f7}
#wrap{display:flex;height:100vh}
#side{width:300px;border-right:1px solid #ddd;overflow:auto;background:#fff;display:flex;flex-direction:column}
#side header{padding:12px;border-bottom:1px solid #eee}
#q{width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font:inherit}
.top{display:flex;gap:6px;margin-top:8px}
.top button{flex:1;padding:6px;font:11px sans-serif;border:1px solid #ccc;background:#fafafa;border-radius:6px;cursor:pointer}
#list{flex:1;overflow:auto}
.fold{padding:8px 12px;font-weight:600;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.doc{padding:8px 12px;cursor:pointer;border-bottom:1px solid #f0f0f0}
.doc:hover{background:#f0f0f5}.doc.sel{background:#e7e7ef}
.doc small{color:#999;display:block}
#main{flex:1;overflow:auto;padding:28px 40px;max-width:900px}
#meta{color:#888;font-size:12px;margin-bottom:14px}
#bar{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap}
#bar button{padding:7px 12px;border:1px solid #ccc;background:#fff;border-radius:7px;cursor:pointer;font:inherit}
#bar button.pri{background:#1c1c1e;color:#fff;border-color:#1c1c1e}
#view h1,#view h2,#view h3{line-height:1.25}#view pre{background:#1c1c1e;color:#f5f5f7;padding:14px;border-radius:8px;overflow:auto}
#view code{background:#eee;padding:1px 5px;border-radius:4px}#view pre code{background:none;padding:0}
#edit{display:none;width:100%;height:70vh;font:13px ui-monospace,Menlo,monospace;padding:14px;border:1px solid #ccc;border-radius:8px}
#etitle{display:none;width:100%;padding:8px;font:inherit;margin-bottom:8px;border:1px solid #ccc;border-radius:7px}
#vers{margin-top:30px;border-top:1px solid #ddd;padding-top:14px;display:none}
.vrow{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:13px}
.vrow button{font-size:12px;padding:3px 9px;cursor:pointer}.muted{color:#999}
</style></head><body><div id="wrap">
<div id="side"><header>
<input id="q" placeholder="Search...">
<div class="top"><button id="dzip">Download .zip</button><button id="ddb">Download DB</button></div>
</header><div id="list"></div></div>
<div id="main"><div id="bar"></div><div id="meta"></div>
<input id="etitle"><div id="view"></div><textarea id="edit"></textarea>
<div id="vers"></div></div></div>
<script nonce="${nonce}">
const T=new URLSearchParams(location.search).get('t')||'';
const qs=p=>p+(p.includes('?')?'&':'?')+'t='+encodeURIComponent(T);
let cur=null,editing=false;
async function load(){const d=await(await fetch(qs('/api/docs'))).json();render(d)}
function render(d){const L=document.getElementById('list');L.innerHTML='';
 const by={};d.docs.forEach(x=>{(by[x.folder||'(root)']=by[x.folder||'(root)']||[]).push(x)});
 Object.keys(by).sort().forEach(f=>{const h=document.createElement('div');h.className='fold';h.textContent=f;L.appendChild(h);
  by[f].forEach(x=>{const e=document.createElement('div');e.className='doc'+(cur===x.id?' sel':'');
   const t=document.createElement('div');t.textContent=x.title;const s=document.createElement('small');s.textContent=x.tags.join(' ');
   e.appendChild(t);e.appendChild(s);e.onclick=()=>open(x.id);L.appendChild(e)})})}
async function open(id){cur=id;editing=false;const d=await(await fetch(qs('/api/doc/'+encodeURIComponent(id)))).json();
 document.getElementById('meta').textContent=(d.folder||'(root)')+'  ·  '+(d.tags.join(', ')||'no tags')+'  ·  v'+d.latest;
 document.getElementById('view').innerHTML=d.html;document.getElementById('view').style.display='block';
 document.getElementById('edit').style.display='none';document.getElementById('etitle').style.display='none';
 document.getElementById('edit').value=d.body_md;document.getElementById('etitle').value=d.title;
 bar(d);vers(d.versions);load()}
function bar(d){const b=document.getElementById('bar');b.innerHTML='';
 const mk=(label,cls,fn)=>{const x=document.createElement('button');x.textContent=label;if(cls)x.className=cls;x.onclick=fn;b.appendChild(x)};
 mk(editing?'View':'Edit','pri',toggle);
 if(editing)mk('Save','pri',save);
 mk('Download .md',null,()=>{location=qs('/download/doc/'+encodeURIComponent(d.id))});
 mk('Delete',null,()=>del(d.id))}
function toggle(){editing=!editing;const v=document.getElementById('view'),e=document.getElementById('edit'),t=document.getElementById('etitle');
 v.style.display=editing?'none':'block';e.style.display=editing?'block':'none';t.style.display=editing?'block':'none';
 fetch(qs('/api/doc/'+encodeURIComponent(cur))).then(r=>r.json()).then(bar)}
async function save(){const body=document.getElementById('edit').value,title=document.getElementById('etitle').value;
 await fetch(qs('/api/doc/'+encodeURIComponent(cur)),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({title,body_md:body})});
 editing=false;open(cur)}
async function del(id){if(!confirm('Delete this note?'))return;await fetch(qs('/api/doc/'+encodeURIComponent(id)),{method:'DELETE'});cur=null;
 document.getElementById('view').innerHTML='';document.getElementById('bar').innerHTML='';document.getElementById('vers').style.display='none';load()}
function vers(vs){const V=document.getElementById('vers');if(!vs.length){V.style.display='none';return}
 V.style.display='block';V.innerHTML='';const h=document.createElement('b');h.textContent='Version history';V.appendChild(h);
 vs.forEach(v=>{const row=document.createElement('div');row.className='vrow';
  const sp=document.createElement('span');sp.textContent='v'+v.version_n+' ('+v.changed_by+' · '+new Date(v.changed_at).toLocaleString()+')';
  const btn=document.createElement('button');btn.textContent='Restore';btn.onclick=()=>restore(v.version_n);
  row.appendChild(sp);row.appendChild(btn);V.appendChild(row)})}
async function restore(n){if(!confirm('Restore v'+n+'? Current state is saved as a new version.'))return;
 await fetch(qs('/api/doc/'+encodeURIComponent(cur)+'/restore'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version_n:n})});open(cur)}
document.getElementById('dzip').onclick=()=>{location=qs('/download/all')};
document.getElementById('ddb').onclick=()=>{location=qs('/download/db')};
let t;document.getElementById('q').oninput=e=>{clearTimeout(t);t=setTimeout(async()=>{
 const v=e.target.value.trim();if(!v){load();return}
 const d=await(await fetch(qs('/api/search?q='+encodeURIComponent(v)))).json();
 const L=document.getElementById('list');L.innerHTML='';d.forEach(x=>{const el=document.createElement('div');
 el.className='doc';const t=document.createElement('div');t.textContent=x.title;const s=document.createElement('small');s.textContent=x.snippet;
 el.appendChild(t);el.appendChild(s);el.onclick=()=>open(x.id);L.appendChild(el)})},220)};
load();
</script></body></html>`;

export function startUi(): { url: string; port: number } {
  if (started && boundPort) {
    return { url: `http://127.0.0.1:${boundPort}/?t=${TOKEN}`, port: boundPort };
  }
  const port = Number(process.env.BRAIN_UI_PORT ?? 4319);
  boundPort = port;

  server = http.createServer(async (req, res) => {
    try {
      // Every request must come from our own loopback origin.
      if (!hostOk(req)) {
        res.writeHead(403);
        return res.end("forbidden");
      }
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);
      const p = u.pathname;

      if (p === "/" && req.method === "GET") {
        const nonce = randomBytes(16).toString("base64");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
            `img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'`,
          "cache-control": "no-store",
        });
        return res.end(PAGE(nonce));
      }

      // All data routes require the per-launch token and a same-origin (or
      // navigation) Origin.
      const isApi = p.startsWith("/api/") || p.startsWith("/download/");
      if (isApi && (!tokenOk(u) || !originOk(req))) {
        res.writeHead(403);
        return res.end("forbidden");
      }

      if (p === "/api/docs") {
        return json(res, 200, { folders: listFolders(), docs: listDocs(undefined, 500) });
      }
      if (p === "/api/search") {
        return json(res, 200, search(u.searchParams.get("q") ?? "", undefined, 30));
      }

      let m = p.match(/^\/api\/doc\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (req.method === "GET") {
          const d = getDoc(id);
          if (!d) return json(res, 404, { error: "not found" });
          const vs = listVersions(id);
          return json(res, 200, { ...d, html: renderMd(d.body_md), versions: vs, latest: vs[0]?.version_n ?? 1 });
        }
        if (req.method === "PUT") {
          const b = await readBody(req);
          const d = getDoc(id);
          if (!d) return json(res, 404, { error: "not found" });
          saveDoc({ id, title: b.title ?? d.title, folder: d.folder, body_md: b.body_md ?? d.body_md, tags: d.tags, changedBy: "user_edit" });
          return json(res, 200, { ok: true });
        }
        if (req.method === "DELETE") {
          return json(res, 200, { ok: deleteDoc(id) });
        }
      }

      m = p.match(/^\/api\/doc\/([^/]+)\/restore$/);
      if (m && req.method === "POST") {
        const b = await readBody(req);
        const ok = restoreVersion(decodeURIComponent(m[1]), Number(b.version_n));
        return json(res, ok ? 200 : 404, { ok });
      }

      m = p.match(/^\/download\/doc\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const g = getDoc(id);
        if (!g) return json(res, 404, { error: "not found" });
        const name = g.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "note";
        res.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="${name}.md"`,
        });
        return res.end(g.body_md);
      }

      if (p === "/download/all") {
        const buf = exportZipBuffer();
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="brain-export.zip"`,
          "content-length": buf.length,
        });
        return res.end(buf);
      }

      if (p === "/download/db") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="brain.db"`,
        });
        return createReadStream(DB_FILE).pipe(res);
      }

      res.writeHead(404);
      res.end("not found");
    } catch (e) {
      // Log detail to stderr only; never leak internals to the client.
      process.stderr.write(`[brain-mcp ui] ${String(e)}\n`);
      if (!res.headersSent) res.writeHead(500);
      res.end("internal error");
    }
  });

  // A busy port must not crash the whole MCP process.
  server.on("error", (err) => {
    process.stderr.write(`[brain-mcp ui] server error: ${String(err)}\n`);
    started = false;
  });

  server.listen(port, "127.0.0.1");
  started = true;
  return { url: `http://127.0.0.1:${port}/?t=${TOKEN}`, port };
}
