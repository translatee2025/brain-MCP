import { createHash } from "node:crypto";

// Deterministic secret-redaction firewall. Runs before any note text is
// written to disk (or sent to a restructure engine), so credentials pasted
// into a chat never get persisted. Returns the scrubbed text plus a count of
// how many secrets were removed (never the values themselves).
//
// Each match becomes a typed placeholder with a short salted fingerprint, so
// the same secret reads consistently across notes without exposing it:
//   <redacted:aws_access_key#a1b2c3>

type Pattern = { name: string; re: RegExp; luhn?: boolean };

// Process-lifetime salt: fingerprints are stable within a run but not
// reversible or comparable across machines.
const SALT = createHash("sha256").update(String(process.pid) + ":brain").digest("hex");

const PATTERNS: Pattern[] = [
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "stripe_key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "aws_access_key", re: /\bA(?:KIA|SIA|GPA|IDA|ROA|NPA|NVA)[0-9A-Z]{16}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: "private_key", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { name: "ssh_key", re: /\bssh-(?:rsa|ed25519|ecdsa)\s+[A-Za-z0-9+/]{40,}={0,2}\b/g },
  { name: "bearer", re: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}\b/g },
  // Common "NAME=secret" assignment for obviously-secret keys.
  { name: "secret_assignment", re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/g },
  // Credit-card-shaped digit runs, Luhn-validated to cut false positives.
  { name: "credit_card", re: /\b(?:\d[ -]?){13,19}\b/g, luhn: true },
];

function fingerprint(s: string): string {
  return createHash("sha256").update(SALT + s).digest("hex").slice(0, 6);
}

function luhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export type RedactionResult = { text: string; count: number; kinds: string[] };

export function redact(input: string): RedactionResult {
  if (!input) return { text: input, count: 0, kinds: [] };
  let text = input;
  let count = 0;
  const kinds = new Set<string>();

  for (const p of PATTERNS) {
    text = text.replace(p.re, (match, g1?: string, g2?: string) => {
      // For NAME=secret, only redact the value (g2), keep the name visible.
      if (p.name === "secret_assignment" && g1 !== undefined && g2 !== undefined) {
        count++;
        kinds.add(p.name);
        return `${g1}=<redacted:${p.name}#${fingerprint(g2)}>`;
      }
      if (p.luhn && !luhnValid(match)) return match; // not a real card number
      count++;
      kinds.add(p.name);
      return `<redacted:${p.name}#${fingerprint(match)}>`;
    });
  }

  return { text, count, kinds: [...kinds] };
}
