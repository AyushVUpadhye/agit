/**
 * Views over an event log: cumulative file state at any point, usage totals,
 * compact per-event rendering. All read-only folds over events — no I/O.
 */

import type { AgitEvent, Json } from "./format/events.js";

export interface FileState {
  path: string;
  kind: "create" | "modify";
  afterHash: string;
  lastSeq: number;
  edits: number;
  added: number;
  removed: number;
}

/** Fold file.diff events up to and including seq `at` (default: all). Lower bound on reality — SPEC §5.7. */
export function fileStateAt(events: AgitEvent[], at?: number): Map<string, FileState> {
  const files = new Map<string, FileState>();
  for (const e of events) {
    if (at !== undefined && e.seq > at) break;
    if (e.type !== "file.diff") continue;
    const p = e.payload as { path?: Json; kind?: Json; afterHash?: Json; diff?: Json };
    if (typeof p.path !== "string" || typeof p.afterHash !== "string") continue;
    const { added, removed } = diffStat(typeof p.diff === "string" ? p.diff : "");
    const prev = files.get(p.path);
    files.set(p.path, {
      path: p.path,
      kind: prev ? prev.kind : p.kind === "create" ? "create" : "modify",
      afterHash: p.afterHash,
      lastSeq: e.seq,
      edits: (prev?.edits ?? 0) + 1,
      added: (prev?.added ?? 0) + added,
      removed: (prev?.removed ?? 0) + removed,
    });
  }
  return files;
}

export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  apiMessages: number;
  models: Set<string>;
}

export function usageTotals(events: AgitEvent[], at?: number): UsageTotals {
  const t: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    apiMessages: 0,
    models: new Set(),
  };
  for (const e of events) {
    if (at !== undefined && e.seq > at) break;
    if (e.type !== "cost") continue;
    const p = e.payload as { model?: Json; usage?: { [k: string]: Json } };
    if (typeof p.model === "string") t.models.add(p.model);
    const u = p.usage ?? {};
    t.inputTokens += num(u.inputTokens);
    t.outputTokens += num(u.outputTokens);
    t.cacheReadInputTokens += num(u.cacheReadInputTokens);
    t.cacheCreationInputTokens += num(u.cacheCreationInputTokens);
    t.apiMessages++;
  }
  return t;
}

function num(v: Json | undefined): number {
  return typeof v === "number" ? v : 0;
}

const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");

/** One-line rendering for timelines. */
export function eventLine(e: AgitEvent): string {
  const p = e.payload as { [k: string]: Json };
  switch (e.type) {
    case "session.start":
      return `session.start  runtime=${str(p.runtime)} ${str(p.runtimeVersion)}`.trimEnd();
    case "session.end":
      return `session.end    reason=${str(p.reason)}`;
    case "message.user":
      return `user           ${excerpt(str(p.text), 90)}`;
    case "message.assistant": {
      const blocks = Array.isArray(p.blocks) ? (p.blocks as { type?: Json; text?: Json }[]) : [];
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => str(b.text))
        .join(" ");
      const kinds = blocks.map((b) => str(b.type)).join("+") || "empty";
      return `assistant      [${kinds}] ${excerpt(text, 76)}`;
    }
    case "tool.call":
      return `tool.call      ${str(p.name)} ${excerpt(firstArg(p.input), 70)}`;
    case "tool.result":
      return `tool.result    ${p.isError === true ? "ERROR " : ""}${excerpt(str(p.output), 76)}`;
    case "file.diff": {
      const { added, removed } = diffStat(str(p.diff));
      return `file.diff      ${str(p.kind)} ${str(p.path)} (+${added} -${removed})`;
    }
    case "cost": {
      const u = (p.usage ?? {}) as { [k: string]: Json };
      return `cost           ${str(p.model)} in=${num(u.inputTokens)} out=${num(u.outputTokens)} cacheRead=${num(u.cacheReadInputTokens)}`;
    }
  }
}

function firstArg(input: Json | undefined): string {
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) return "";
  const entries = Object.entries(input);
  if (entries.length === 0) return "";
  const preferred = ["command", "file_path", "pattern", "path", "url", "prompt"];
  const [k, v] = entries.find(([key]) => preferred.includes(key)) ?? entries[0]!;
  return `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`;
}

export function excerpt(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1) + "…";
}
