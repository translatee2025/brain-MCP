import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type RestructureMode = "sampling" | "openai" | "none";

export function configuredMode(): RestructureMode {
  const m = (process.env.BRAIN_RESTRUCTURE ?? "sampling").toLowerCase();
  if (m === "openai" || m === "none") return m;
  return "sampling";
}

const SYSTEM_PROMPT = `You restructure raw notes or chat snippets into a clean, standalone reference document.

Rules:
1. This is RESTRUCTURING, not summarizing. Every fact, number, name, URL, code snippet, command, decision, caveat and alternative in the input must survive in the output. Nothing is dropped.
2. Strip conversational artifacts. No "User:", "Assistant:", "sure, here is", "thanks". Write as if an expert authored a reference doc.
3. Reproduce every code block and command in full. Never truncate code.
4. Never compress with "etc.", "and more", "various". If 10 items were listed, list all 10.
5. Use Markdown headings and paragraphs. Output the document body only, no preamble, no fences around the whole thing.
6. Keep the original language. Do not translate.`;

function buildUserPrompt(title: string, raw: string): string {
  return `TITLE: ${title}\n\nRAW CONTENT TO RESTRUCTURE:\n${raw}`;
}

// Ask the host app's own model (Claude Desktop) to restructure, via MCP
// sampling. Returns null if the host does not support sampling.
const TIMEOUT_MS = Number(process.env.BRAIN_LLM_TIMEOUT_MS ?? 120000);

// Size the output budget to the input so restructuring of a long buffer is
// not capped below what it needs (the old fixed 4000-token cap silently
// dropped the back half of long conversations).
function maxOutputTokens(raw: string): number {
  const estIn = Math.ceil(raw.length / 4);
  return Math.min(Math.max(estIn + 1000, 4000), 16000);
}

type EngineOut = { text: string; truncated: boolean } | null;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("restructure timed out")), ms)),
  ]);
}

async function viaSampling(server: McpServer, title: string, raw: string): Promise<EngineOut> {
  try {
    const result = await withTimeout(
      server.server.createMessage({
        systemPrompt: SYSTEM_PROMPT,
        maxTokens: maxOutputTokens(raw),
        messages: [
          { role: "user", content: { type: "text", text: buildUserPrompt(title, raw) } },
        ],
      }),
      TIMEOUT_MS,
    );
    const c = result.content as
      | { type: string; text?: string }
      | { type: string; text?: string }[];
    const blocks = Array.isArray(c) ? c : [c];
    const text = blocks
      .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
      .join("")
      .trim();
    if (text.length === 0) return null;
    const truncated = (result as { stopReason?: string }).stopReason === "maxTokens";
    return { text, truncated };
  } catch {
    return null;
  }
}

// OpenAI-compatible endpoint: real OpenAI/ChatGPT, or a local Ollama
// (http://127.0.0.1:11434/v1) / LM Studio (http://127.0.0.1:1234/v1).
async function viaOpenAI(title: string, raw: string): Promise<EngineOut> {
  const base = (process.env.BRAIN_LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const key = process.env.BRAIN_LLM_API_KEY ?? "";
  const model = process.env.BRAIN_LLM_MODEL ?? "gpt-4o-mini";
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: maxOutputTokens(raw),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(title, raw) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text || text.length === 0) return null;
    const truncated = data.choices?.[0]?.finish_reason === "length";
    return { text, truncated };
  } catch {
    return null;
  }
}

// Restructure with graceful degradation. Two guarantees:
// 1. If the engine is unavailable, store the raw text verbatim (never lose a note).
// 2. If the engine SUCCEEDS but truncates its output, fall back to verbatim raw
//    too: a partial note is data loss, the full buffer is not. The caller can
//    surface that it was stored verbatim.
export async function restructure(
  server: McpServer,
  title: string,
  raw: string,
  override?: RestructureMode,
): Promise<{ body: string; engine: RestructureMode | "raw"; truncated: boolean }> {
  const mode = override ?? configuredMode();
  if (mode === "none") return { body: raw, engine: "raw", truncated: false };
  const out = mode === "openai" ? await viaOpenAI(title, raw) : await viaSampling(server, title, raw);
  if (!out) return { body: raw, engine: "raw", truncated: false };
  if (out.truncated) return { body: raw, engine: "raw", truncated: true };
  return { body: out.text, engine: mode, truncated: false };
}

// Inspect the machine and recommend a local model the user can pull,
// instead of blindly downloading gigabytes.
export function systemCheck(): {
  totalRamGb: number;
  cpuCores: number;
  platform: string;
  recommendation: string;
  setup: string[];
} {
  const totalRamGb = Math.round((os.totalmem() / 1e9) * 10) / 10;
  const cpuCores = os.cpus()?.length ?? 0;
  const platform = `${os.platform()} ${os.arch()}`;

  let model: string;
  let note: string;
  if (totalRamGb < 8) {
    model = "(none) — use cloud (Claude sampling or an OpenAI key)";
    note =
      "Under 8 GB RAM: a local model will fight the OS for memory. Prefer BRAIN_RESTRUCTURE=sampling, or set an OpenAI key.";
  } else if (totalRamGb < 16) {
    model = "qwen2.5:3b-instruct-q4_K_M";
    note = "~2.5 GB on disk, ~3 GB at runtime. Comfortable on 8-16 GB.";
  } else if (totalRamGb < 32) {
    model = "qwen2.5:7b-instruct-q4_K_M";
    note = "~4.5 GB on disk, ~6 GB at runtime. The sweet spot on 16-32 GB.";
  } else {
    model = "qwen2.5:14b-instruct-q4_K_M";
    note = "~9 GB on disk, ~11 GB at runtime. Best quality on 32 GB+.";
  }

  const setup =
    totalRamGb < 8
      ? [
          "Leave BRAIN_RESTRUCTURE unset (defaults to Claude sampling), or:",
          "Set BRAIN_RESTRUCTURE=openai, BRAIN_LLM_API_KEY=<your key>.",
        ]
      : [
          "Install Ollama from https://ollama.com",
          `Run: ollama pull ${model}`,
          "Then set these env vars for the MCP server:",
          "  BRAIN_RESTRUCTURE=openai",
          "  BRAIN_LLM_BASE_URL=http://127.0.0.1:11434/v1",
          `  BRAIN_LLM_MODEL=${model}`,
          "(LM Studio works too: BRAIN_LLM_BASE_URL=http://127.0.0.1:1234/v1)",
        ];

  return {
    totalRamGb,
    cpuCores,
    platform,
    recommendation: `${model} — ${note}`,
    setup,
  };
}
