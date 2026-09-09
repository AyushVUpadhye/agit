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
  {
    label: "private-key",
    regexes: [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  },
  { label: "anthropic-key", regexes: [/\bsk-ant-[A-Za-z0-9_-]{16,}/g] },
  { label: "openai-key", regexes: [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g] },
  { label: "aws-access-key-id", regexes: [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g] },
  {
    label: "github-token",
    regexes: [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g],
  },
  { label: "slack-token", regexes: [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g] },
  {
    label: "slack-webhook",
    regexes: [/\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+\b/g],
  },
  { label: "google-api-key", regexes: [/\bAIza[0-9A-Za-z_-]{35}\b/g] },
  { label: "stripe-key", regexes: [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g] },
  { label: "npm-token", regexes: [/\bnpm_[A-Za-z0-9]{36}\b/g] },
  { label: "jwt", regexes: [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g] },
  { label: "bearer", regexes: [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi] },
  {
    // scheme://user:password@host — connection strings and API URLs commonly
    // carry the credential in the userinfo component. Keep everything but
    // the password itself; the "@" that follows is outside the match.
    label: "url-credentials",
    regexes: [/\b([a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@]{1,64}:)([^\s/@]{3,})(?=@)/gi],
    replacement: "$1[REDACTED:url-credentials]",
  },
  {
    // The keyword MUST end the identifier before "=`/`:` — e.g. `password`,
    // `db_password`, `DB_PASSWORD`, `client_secret`, `AUTH_TOKEN` all match.
    // A plain `\bpassword\b` misses every one of those SCREAMING_SNAKE_CASE
    // or prefixed forms: `_` and `-` are word characters to `\b`, so there is
    // no boundary between them and the keyword that follows.
    //
    // The prefix group bounds BOTH the run length (`{1,32}`) and the repeat
    // count (`{0,4}`) — an earlier `(?:[A-Za-z0-9]+[_-])*` here was
    // catastrophically slow (quadratic-or-worse) on any long run of ordinary
    // word characters, secret or not, because the unbounded `+` had to
    // backtrack the full remaining length looking for a `_`/`-` that might
    // never appear, at every position the regex engine anchors to. Real
    // identifier segments are never anywhere near 32 characters or 4 levels
    // deep, so the bound costs no real matches while making the worst case a
    // small constant instead of the whole remaining string.
    label: "assignment",
    regexes: [
      /((?:[A-Za-z0-9]{1,32}[_-]){0,4}(?:api[_-]?key|apikey|client[_-]?secret|secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|passwd|password|dsn|connection[_-]?string|authorization)\s*[=:]\s*["']?)([A-Za-z0-9_\-./+]{16,})/gi,
    ],
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
          // Reapply the kept groups manually ($1, $2, ... — as many as the
          // pattern captured).
          const groups = args.slice(1, -2) as string[];
          return p.replacement.replace(/\$(\d)/g, (_m, d: string) => groups[Number(d) - 1] ?? "");
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
