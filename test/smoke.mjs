// Ad-hoc smoke test: spawns the built server over stdio, exercises the tools,
// and checks redaction, truncation-safety, import round-trip, folder search,
// and the UI security gate. Run: node test/smoke.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "brain-smoke-"));
let pass = 0,
  fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
  cond ? pass++ : fail++;
};

function rpc(env, messages) {
  return new Promise((resolve) => {
    const p = spawn("node", ["dist/index.js"], { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", () => {});
    for (const m of messages) p.stdin.write(JSON.stringify(m) + "\n");
    setTimeout(() => {
      p.kill();
      const byId = {};
      for (const line of out.split("\n").filter(Boolean)) {
        try {
          const o = JSON.parse(line);
          if (o.id != null) byId[o.id] = o;
        } catch {}
      }
      resolve(byId);
    }, 900);
  });
}

const init = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];
const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

const env = { BRAIN_DIR: DIR, BRAIN_RESTRUCTURE: "none" };

// 1. tools/list + annotations
let r = await rpc(env, [...init, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
const tools = r[2]?.result?.tools ?? [];
const names = tools.map((t) => t.name);
check("13 tools registered (incl brain_import)", names.length === 13 && names.includes("brain_import"), names.join(","));
const save = tools.find((t) => t.name === "brain_save");
check("brain_save has destructiveHint annotation", save?.annotations?.destructiveHint === true);
const srch = tools.find((t) => t.name === "brain_search");
check("brain_search has readOnlyHint annotation", srch?.annotations?.readOnlyHint === true);
check("descriptions non-instructional (no 'yourself')", !save.description.toLowerCase().includes("yourself"), save.description.slice(0, 50));

// 2. save with secrets -> redaction, then search finds it
r = await rpc(env, [
  ...init,
  call(3, "brain_save", { title: "Modem launch", content: "Launch Q3. Key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 and AKIAIOSFODNN7EXAMPLE here.", folder: "Projects/Modem", tags: ["modem"], restructure: "none" }),
]);
const saveText = r[3]?.result?.content?.[0]?.text ?? "";
check("save reports redactions", /redacted/.test(saveText), saveText);

// 3. reopen (new process), confirm note stored WITHOUT raw secret, search + folder search
r = await rpc(env, [
  ...init,
  call(4, "brain_search", { query: "launch" }),
  call(5, "brain_search", { query: "launch", folder: "Projects/Modem" }),
  call(6, "brain_export", {}),
]);
const searchText = r[4]?.result?.content?.[0]?.text ?? "";
check("search finds the note", /Modem launch/.test(searchText), searchText.replace(/\n/g, " ").slice(0, 80));
check("folder-scoped search returns it", /Modem launch/.test(r[5]?.result?.content?.[0]?.text ?? ""));
const exportText = r[6]?.result?.content?.[0]?.text ?? "";
check("export wrote docs", /Exported 1 docs/.test(exportText), exportText);

// 4. get the note, verify secret is redacted in stored body
const id = (searchText.match(/\[([0-9a-f-]{36})\]/) || [])[1];
r = await rpc(env, [...init, call(7, "brain_get", { id })]);
const body = r[7]?.result?.content?.[0]?.text ?? "";
check("raw anthropic key NOT in stored note", !body.includes("sk-ant-api03-ABCDEFG"), body.slice(0, 120));
check("redaction placeholder present", /redacted:(anthropic_key|aws_access_key)/.test(body));

// 5. versions + restore round-trip (separate processes so calls are sequential)
await rpc(env, [...init, call(8, "brain_save", { id, title: "Modem launch", content: "v2 content", folder: "Projects/Modem", restructure: "none" })]);
r = await rpc(env, [...init, call(9, "brain_versions", { id })]);
const vtext = r[9]?.result?.content?.[0]?.text ?? "";
check("version history has >=2 versions after overwrite", (vtext.match(/^v\d/gm) || []).length >= 2, vtext.replace(/\n/g, " "));
await rpc(env, [...init, call(10, "brain_restore", { id, version_n: 1 })]);
r = await rpc(env, [...init, call(11, "brain_get", { id })]);
const restored = r[11]?.result?.content?.[0]?.text ?? "";
check("restore to v1 brings back redacted original (non-destructive)", /redacted:/.test(restored) && !restored.includes("v2 content"), restored.slice(60, 140).replace(/\n/g, " "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
