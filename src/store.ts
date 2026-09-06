/** The .agit/ directory: sessions/<id>/events.jsonl + meta.json (SPEC §1, §10). */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEventType, type AgitEvent, type SessionMeta } from "./format/events.js";

export function agitDir(base: string): string {
  return join(base, ".agit");
}

export function sessionDir(base: string, id: string): string {
  return join(agitDir(base), "sessions", id);
}

export function writeSession(base: string, id: string, eventsJsonl: string, meta: SessionMeta): void {
  const dir = sessionDir(base, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), eventsJsonl, "utf8");
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

export function listSessionIds(base: string): string[] {
  const dir = join(agitDir(base), "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "events.jsonl")))
    .map((d) => d.name)
    .sort();
}

/** Resolve a full id or a unique prefix, git-style. */
export function resolveSessionId(base: string, idOrPrefix: string): string {
  const ids = listSessionIds(base);
  if (ids.includes(idOrPrefix)) return idOrPrefix;
  const matches = ids.filter((id) => id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`no session matches "${idOrPrefix}" (agit ls to list)`);
  throw new Error(`ambiguous session id "${idOrPrefix}": matches ${matches.join(", ")}`);
}

export function readSessionLines(base: string, id: string): string[] {
  const raw = readFileSync(join(sessionDir(base, id), "events.jsonl"), "utf8");
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Parse events leniently for display verbs; verify is the strict path. */
export function readSessionEvents(base: string, id: string): AgitEvent[] {
  const events: AgitEvent[] = [];
  for (const line of readSessionLines(base, id)) {
    const e = JSON.parse(line) as AgitEvent;
    if (typeof e.type !== "string" || !isEventType(e.type)) {
      throw new Error(
        `event ${e.seq}: unknown type ${JSON.stringify(e.type)} — was this written by a newer agit?`,
      );
    }
    events.push(e);
  }
  return events;
}

export function readSessionMeta(base: string, id: string): SessionMeta | null {
  const p = join(sessionDir(base, id), "meta.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as SessionMeta;
}
