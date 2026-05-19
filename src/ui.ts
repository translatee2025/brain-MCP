import http from "node:http";
import { createReadStream } from "node:fs";
import { marked } from "marked";
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

// Local single-user content, but a saved note could contain raw HTML.
// Strip script/iframe and inline event handlers before rendering.
function renderMd(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return html
    .replace(/<\s*(script|iframe|object|embed)[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(s),
  });
  res.end(s);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>Brain</title><style>
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
<div class="top"><button onclick="dlAll()">Download .zip</button><button onclick="location='/download/db'">Download DB</button></div>
</header><div id="list"></div></div>
<div id="main"><div id="bar"></div><div id="meta"></div>
<input id="etitle"><div id="view"></div><textarea id="edit"></textarea>
<div id="vers"></div></div></div>
<script>
let cur=null,editing=false;
async function load(){const r=await fetch('/api/docs');const d=await r.json();render(d)}
function render(d){const L=document.getElementById('list');L.innerHTML='';
 const by={};d.docs.forEach(x=>{(by[x.folder||'(root)']=by[x.folder||'(root)']||[]).push(x)});
 Object.keys(by).sort().forEach(f=>{const h=document.createElement('div');h.className='fold';h.textContent=f;L.appendChild(h);
  by[f].forEach(x=>{const e=document.createElement('div');e.className='doc'+(cur===x.id?' sel':'');
   e.innerHTML='<div>'+esc(x.title)+'</div><small>'+(x.tags.join(' ')||'')+'</small>';
   e.onclick=()=>open(x.id);L.appendChild(e)})})}
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
async function open(id){cur=id;editing=false;const r=await fetch('/api/doc/'+id);const d=await r.json();
 document.getElementById('meta').textContent=(d.folder||'(root)')+'  ·  '+(d.tags.join(', ')||'no tags')+'  ·  v'+d.latest;
 document.getElementById('view').innerHTML=d.html;document.getElementById('view').style.display='block';
 document.getElementById('edit').style.display='none';document.getElementById('etitle').style.display='none';
 document.getElementById('edit').value=d.body_md;document.getElementById('etitle').value=d.title;
 bar(d);vers(d.versions);load()}
function bar(d){document.getElementById('bar').innerHTML=
 '<button class="pri" onclick="toggle()">'+(editing?'View':'Edit')+'</button>'+
 (editing?'<button class="pri" onclick="save()">Save</button>':'')+
 '<button onclick="location=\\'/download/doc/'+d.id+'\\'">Download .md</button>'+
 '<button onclick="del(\\''+d.id+'\\')">Delete</button>'}
function toggle(){editing=!editing;const v=document.getElementById('view'),e=document.getElementById('edit'),t=document.getElementById('etitle');
 v.style.display=editing?'none':'block';e.style.display=editing?'block':'none';t.style.display=editing?'block':'none';
 fetch('/api/doc/'+cur).then(r=>r.json()).then(bar)}
async function save(){const body=document.getElementById('edit').value,title=document.getElementById('etitle').value;
 await fetch('/api/doc/'+cur,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({title,body_md:body})});
 editing=false;open(cur)}
async function del(id){if(!confirm('Delete this note?'))return;await fetch('/api/doc/'+id,{method:'DELETE'});cur=null;
 document.getElementById('view').innerHTML='';document.getElementById('bar').innerHTML='';document.getElementById('vers').style.display='none';load()}
function vers(vs){const V=document.getElementById('vers');if(!vs.length){V.style.display='none';return}
 V.style.display='block';V.innerHTML='<b>Version history</b>'+vs.map(v=>
 '<div class="vrow"><span>v'+v.version_n+' <span class="muted">'+v.changed_by+' · '+new Date(v.changed_at).toLocaleString()+'</span></span>'+
 '<button onclick="restore('+v.version_n+')">Restore</button></div>').join('')}
async function restore(n){if(!confirm('Restore v'+n+'? Current state is saved as a new version.'))return;
 await fetch('/api/doc/'+cur+'/restore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version_n:n})});open(cur)}
function dlAll(){location='/download/all'}
let t;document.getElementById('q').oninput=e=>{clearTimeout(t);t=setTimeout(async()=>{
 const v=e.target.value.trim();if(!v){load();return}
 const r=await fetch('/api/search?q='+encodeURIComponent(v));const d=await r.json();
 const L=document.getElementById('list');L.innerHTML='';d.forEach(x=>{const el=document.createElement('div');
 el.className='doc';el.innerHTML='<div>'+esc(x.title)+'</div><small>'+esc(x.snippet)+'</small>';
 el.onclick=()=>open(x.id);L.appendChild(el)})},220)};
load();
</script></body></html>`;

export function startUi(): { url: string; port: number } {
  if (server && boundPort) {
    return { url: `http://127.0.0.1:${boundPort}`, port: boundPort };
  }
  const port = Number(process.env.BRAIN_UI_PORT ?? 4319);

  server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const p = u.pathname;

      if (p === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(PAGE);
      }
      if (p === "/api/docs") {
        return json(res, 200, {
          folders: listFolders(),
          docs: listDocs(undefined, 500),
        });
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
          return json(res, 200, {
            ...d,
            html: renderMd(d.body_md),
            versions: vs,
            latest: vs[0]?.version_n ?? 1,
          });
        }
        if (req.method === "PUT") {
          const b = await readBody(req);
          const d = getDoc(id);
          if (!d) return json(res, 404, { error: "not found" });
          saveDoc({
            id,
            title: b.title ?? d.title,
            folder: d.folder,
            body_md: b.body_md ?? d.body_md,
            tags: d.tags,
            changedBy: "user_edit",
          });
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
        const v = u.searchParams.get("v");
        const d = v
          ? getVersionBody(id, Number(v))
          : (() => {
              const g = getDoc(id);
              return g ? { title: g.title, body_md: g.body_md } : null;
            })();
        if (!d) return json(res, 404, { error: "not found" });
        const name =
          d.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "note";
        res.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="${name}.md"`,
        });
        return res.end(d.body_md);
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
      res.writeHead(500);
      res.end(String(e));
    }
  });

  server.listen(port, "127.0.0.1");
  boundPort = port;
  return { url: `http://127.0.0.1:${port}`, port };
}
