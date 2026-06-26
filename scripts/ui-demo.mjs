// Seeds a throwaway brain with the sample vault and starts the web UI for
// screenshots/demo. Prints the tokened URL. Run: node scripts/ui-demo.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.BRAIN_DIR = mkdtempSync(join(tmpdir(), "brain-demo-"));
process.env.BRAIN_UI_PORT = process.env.BRAIN_UI_PORT || "4321";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { importZip } = await import("../dist/import.js");
const { startUi } = await import("../dist/ui.js");

importZip(join(root, "samples", "brain-sample.zip"));
const { url } = startUi();
console.log("BRAIN_UI_URL=" + url);
// keep alive
setInterval(() => {}, 1 << 30);
