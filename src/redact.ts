/**
 * Credential-pattern redaction (SPEC.md §8). Runs on every payload string at
 * import, before hashing. A seatbelt, not a guarantee — the spec documents
 * exactly what this does and does not catch.
 */

import type { Json } from "./format/events.js";

interface Pattern {
  label: string;
  regexes: RegExp[];
  /** Replacement; $1 preserves a leading kept group (assignment pattern). */
  replacement?: string;
}

// Order matters: anthropic-key must run before the generic openai-key shape,
// and specific token shapes before the generic assignment catch-all.
const PATTERNS: Pattern[] = [
  { label: "private-key", regexes: [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g] },
  { label: "anthropic-key", regexes: [/\bsk-ant-[A-Za-z0-9_-]{16,}/g] },
  { label: "openai-key", regexes: [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g] },
  { label: "aws-access-key-id", regexes: [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g] },
  {
    label: "github-token",
    regexes: [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g],
  },
  { label: "slack-token", regexes: [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g] },
  { label: "google-api-key", regexes: [/\bAIza[0-9A-Za-z_-]{35}\b/g] },
  { label: "jwt", regexes: [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g] },
  { label: "bearer", regexes: [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi] },
  {
    label: "assignment",
    regexes: [/(\b(?:api[_-]?key|apikey|secret|token|passwd|password|authorization)\b\s*[=:]\s*["']?)([A-Za-z0-9_\-./+]{16,})/gi],
    replacement: "$1[REDACTED:assignment]",
  },
];

export type RedactionCounts = Record<string, number>;

export function redactString(s: string, counts: RedactionCounts): string {
  let out = s;
  for (const p of PATTERNS) {
    for (const re of p.regexes) {
      out = out.replace(re, (...args) => {
        counts[p.label] = (counts[p.label] ?? 0) + 1;
        if (p.replacement) {
          // Reapply the kept group manually.
          const groups = args.slice(1, -2) as string[];
          return p.replacement.replace("$1", groups[0] ?? "") ;
        }
        return `[REDACTED:${p.label}]`;
      });
    }
  }
  return out;
}

/** Recursively redact every string in a JSON value. Values only — object keys are payload structure, not data. */
export function redactDeep<T extends Json>(value: T, counts: RedactionCounts): T {
  if (typeof value === "string") return redactString(value, counts) as T;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, counts)) as T;
  const out: { [key: string]: Json } = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, counts);
  return out as T;
}
