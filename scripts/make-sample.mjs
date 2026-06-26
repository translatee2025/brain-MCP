// Generates samples/brain-sample.zip: a small, realistic vault a reviewer (or
// new user) can load in one call with brain_import. Run: node scripts/make-sample.mjs
import AdmZip from "adm-zip";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "samples"), { recursive: true });

const notes = [
  {
    path: "Projects/Modem/launch-plan.md",
    front: { title: "Modem launch plan", folder: "Projects/Modem", tags: "[product, launch]" },
    body: `# Modem launch plan\n\nTarget launch is Q3. Sharia certification must complete before any public announcement.\n\n## Milestones\n- Beta to 50 users in month 1\n- Certification review in month 2\n- Public launch end of Q3\n\n## Open questions\n- Pricing tiers not finalized\n- Support staffing for launch week\n`,
  },
  {
    path: "Personal/car-buying.md",
    front: { title: "Car buying notes", folder: "Personal", tags: "[personal, decisions]" },
    body: `# Car buying notes\n\nLeaning toward a white car: stays cooler in summer and resells more easily.\n\nBudget ceiling is set. Prioritize reliability over features.\n`,
  },
  {
    path: "Tech/postgres-tips.md",
    front: { title: "Postgres tips", folder: "Tech", tags: "[database, reference]" },
    body: `# Postgres tips\n\nUseful commands collected over time.\n\n\`\`\`sql\n-- find slow queries\nSELECT query, mean_exec_time\nFROM pg_stat_statements\nORDER BY mean_exec_time DESC\nLIMIT 10;\n\`\`\`\n\nAlways add an index before a large backfill, not after.\n`,
  },
  {
    path: "Tech/git-workflow.md",
    front: { title: "Git workflow", folder: "Tech", tags: "[git, reference]" },
    body: `# Git workflow\n\nBranch from main, never commit directly. Rebase before merge to keep history linear.\n\n\`\`\`bash\ngit switch -c feature/x\ngit rebase main\n\`\`\`\n`,
  },
];

const zip = new AdmZip();
for (const n of notes) {
  const fm =
    `---\ntitle: ${n.front.title}\nfolder: ${n.front.folder}\ntags: ${n.front.tags}\n---\n\n`;
  zip.addFile(n.path, Buffer.from(fm + n.body, "utf8"));
}
const out = join(root, "samples", "brain-sample.zip");
zip.writeZip(out);
console.log("wrote", out, "with", notes.length, "notes");
