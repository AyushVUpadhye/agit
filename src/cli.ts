#!/usr/bin/env node
/** agit — git for running agents. Local verbs only (roadmap milestone 1). */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import type { Adapter } from "./adapters/adapter.js";
import { buildChain, sha256Hex, toJsonl } from "./format/hash.js";
import { verifyChain } from "./format/verify.js";
import type { AgitEvent, SessionMeta } from "./format/events.js";
import { redactDeep, type RedactionCounts } from "./redact.js";
import {
  listSessionIds, readSessionEvents, readSessionLines, readSessionMeta,
  resolveSessionId, sessionDir, writeSession,
} from "./store.js";
import { eventLine, excerpt, fileStateAt, usageTotals } from "./state.js";

const ADAPTERS: Adapter[] = [claudeCodeAdapter];

const USAGE = `agit — git for running agents

usage:
  agit import <native-session.jsonl>   ingest a native session into .agit/
  agit ls                              list imported sessions
  agit show <id>                       summarize one session
  agit verify <id>                     validate the hash chain
  agit replay <id> [--at N]            step through events; --at jumps to N
  agit replay <id> --timeline          print the whole timeline, one line per event

options:
  --dir <path>    where .agit/ lives (default: current directory)

<id> accepts any unique prefix. See SPEC.md for the event format.`;

interface Opts {
  dir: string;
  at?: number;
  timeline: boolean;
  args: string[];
}

function parseArgs(argv: string[]): { verb: string; opts: Opts } {
  const opts: Opts = { dir: process.cwd(), timeline: false, args: [] };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dir") opts.dir = resolve(argv[++i] ?? ".");
    else if (a === "--at") opts.at = Number(argv[++i]);
    else if (a === "--timeline") opts.timeline = true;
    else if (a === "--help" || a === "-h") rest.unshift("help");
    else rest.push(a);
  }
  const verb = rest.shift() ?? "help";
  opts.args = rest;
  return { verb, opts };
}

async function main(): Promise<number> {
  const { verb, opts } = parseArgs(process.argv.slice(2));
  switch (verb) {
    case "import": return cmdImport(opts);
    case "ls": return cmdLs(opts);
    case "show": return cmdShow(opts);
    case "verify": return cmdVerify(opts);
    case "replay": return cmdReplay(opts);
    case "help": console.log(USAGE); return 0;
    default:
      console.error(`unknown command: ${verb}\n`);
      console.log(USAGE);
      return 2;
  }
}

function cmdImport(opts: Opts): number {
  const src = opts.args[0];
  if (!src) { console.error("usage: agit import <native-session.jsonl>"); return 2; }
  const path = resolve(src);
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() !== "");

  const adapter = ADAPTERS.find((a) => a.detect(lines));
  if (!adapter) {
    console.error("no adapter recognizes this file (adapters available: " + ADAPTERS.map((a) => a.name).join(", ") + ")");
    return 1;
  }

  const converted = adapter.convert(lines);
  const redactions: RedactionCounts = {};
  for (const d of converted.drafts) d.payload = redactDeep(d.payload, redactions);
  const events = buildChain(converted.sessionId, converted.drafts);
  const jsonl = toJsonl(events);

  const meta: SessionMeta = {
    agitSchema: 1,
    sessionId: converted.sessionId,
    adapter: { name: adapter.name, version: adapter.version },
    importedAt: new Date().toISOString(),
    source: { path, sha256: sha256Hex(raw), bytes: statSync(path).size, records: converted.records },
    skipped: converted.skipped,
    redactions,
    eventCount: events.length,
    headHash: events[events.length - 1]!.hash,
  };
  writeSession(opts.dir, converted.sessionId, jsonl, meta);

  console.log(`imported ${converted.sessionId}`);
  console.log(`  adapter     ${adapter.name}@${adapter.version}`);
  console.log(`  events      ${events.length} (from ${converted.records} native records)`);
  const skippedTotal = Object.values(converted.skipped).reduce((a, b) => a + b, 0);
  if (skippedTotal > 0) {
    const detail = Object.entries(converted.skipped).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}×${v}`).join(", ");
    console.log(`  skipped     ${skippedTotal} native records with no mapping: ${detail}`);
  }
  const redactedTotal = Object.values(redactions).reduce((a, b) => a + b, 0);
  console.log(redactedTotal > 0
    ? `  redacted    ${redactedTotal}: ${Object.entries(redactions).map(([k, v]) => `${k}×${v}`).join(", ")}`
    : `  redacted    nothing matched the credential patterns (SPEC §8 — a seatbelt, not a guarantee)`);
  console.log(`  head        ${meta.headHash.slice(0, 12)}`);
  console.log(`  wrote       ${sessionDir(opts.dir, converted.sessionId)}`);
  return 0;
}

function cmdLs(opts: Opts): number {
  const ids = listSessionIds(opts.dir);
  if (ids.length === 0) { console.log("no sessions imported yet (agit import <file>)"); return 0; }
  const rows = ids.map((id) => {
    const events = readSessionEvents(opts.dir, id);
    const first = events[0]!;
    const last = events[events.length - 1]!;
    const files = fileStateAt(events).size;
    const start = (first.payload as { runtime?: unknown }).runtime;
    return {
      id: id.slice(0, 8),
      started: first.ts.slice(0, 16).replace("T", " "),
      dur: humanDuration(Date.parse(last.ts) - Date.parse(first.ts)),
      events: String(events.length),
      files: String(files),
      runtime: typeof start === "string" ? start : "?",
    };
  });
  const cols = ["id", "started", "dur", "events", "files", "runtime"] as const;
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => r[c].length)));
  console.log(cols.map((c, i) => c.toUpperCase().padEnd(widths[i]!)).join("  "));
  for (const r of rows) console.log(cols.map((c, i) => r[c].padEnd(widths[i]!)).join("  "));
  return 0;
}

function cmdShow(opts: Opts): number {
  const id = requireId(opts);
  const events = readSessionEvents(opts.dir, id);
  const meta = readSessionMeta(opts.dir, id);
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const start = first.payload as { [k: string]: unknown };

  console.log(`session ${id}`);
  console.log(`  runtime     ${start.runtime} ${start.runtimeVersion ?? ""}`.trimEnd());
  if (typeof start.cwd === "string") console.log(`  cwd         ${start.cwd}`);
  if (typeof start.gitBranch === "string" && start.gitBranch) console.log(`  branch      ${start.gitBranch}`);
  console.log(`  started     ${first.ts}`);
  console.log(`  duration    ${humanDuration(Date.parse(last.ts) - Date.parse(first.ts))}`);
  if (meta) console.log(`  imported    ${meta.importedAt}  (adapter ${meta.adapter.name}@${meta.adapter.version})`);

  const byType = new Map<string, number>();
  const tools = new Map<string, number>();
  for (const e of events) {
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    if (e.type === "tool.call") {
      const name = (e.payload as { name?: unknown }).name;
      if (typeof name === "string") tools.set(name, (tools.get(name) ?? 0) + 1);
    }
  }
  console.log(`  events      ${events.length}  (${[...byType.entries()].map(([t, n]) => `${t}×${n}`).join(", ")})`);
  if (tools.size > 0) {
    console.log(`  tools       ${[...tools.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(", ")}`);
  }

  const u = usageTotals(events);
  if (u.apiMessages > 0) {
    console.log(`  models      ${[...u.models].join(", ")}`);
    console.log(`  tokens      in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadInputTokens} cacheWrite=${u.cacheCreationInputTokens} (${u.apiMessages} API messages)`);
  }

  const files = fileStateAt(events);
  if (files.size > 0) {
    console.log(`  files       ${files.size} touched via structured edits (shell-driven changes not tracked — SPEC §5.7)`);
    for (const f of files.values()) {
      console.log(`    ${f.kind === "create" ? "A" : "M"} ${f.path}  (+${f.added} -${f.removed}, ${f.edits} edit${f.edits === 1 ? "" : "s"})`);
    }
  }
  if (meta && Object.keys(meta.redactions).length > 0) {
    console.log(`  redactions  ${Object.entries(meta.redactions).map(([k, v]) => `${k}×${v}`).join(", ")}`);
  }
  return 0;
}

function cmdVerify(opts: Opts): number {
  const id = requireId(opts);
  const lines = readSessionLines(opts.dir, id);
  const meta = readSessionMeta(opts.dir, id) ?? undefined;
  const res = verifyChain(lines, meta);
  if (res.ok) {
    console.log(`ok: ${res.events} events, chain intact${meta ? ", matches meta.json head" : " (no meta.json — truncation not checkable)"}`);
    return 0;
  }
  console.error(`BROKEN at seq ${res.firstBroken!.seq}: ${res.firstBroken!.reason}`);
  console.error(`${res.events} events verified before the break`);
  return 1;
}

async function cmdReplay(opts: Opts): Promise<number> {
  const id = requireId(opts);
  const events = readSessionEvents(opts.dir, id);

  if (opts.timeline || (opts.at === undefined && !process.stdin.isTTY)) {
    for (const e of events) console.log(`${String(e.seq).padStart(5)}  ${e.ts.slice(11, 19)}  ${eventLine(e)}`);
    return 0;
  }

  let pos = clamp(opts.at ?? 0, 0, events.length - 1);
  printEventDetail(events, pos);
  if (opts.at !== undefined && !process.stdin.isTTY) return 0;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n(${events.length} events — Enter/n next, p prev, g N goto, s state here, q quit)`);
  for (;;) {
    const answer = (await rl.question(`replay ${pos}/${events.length - 1}> `)).trim();
    if (answer === "q") break;
    if (answer === "" || answer === "n") pos = clamp(pos + 1, 0, events.length - 1);
    else if (answer === "p") pos = clamp(pos - 1, 0, events.length - 1);
    else if (answer.startsWith("g")) pos = clamp(Number(answer.slice(1).trim()), 0, events.length - 1);
    else if (answer === "s") { printStateAt(events, pos); continue; }
    else { console.log("Enter/n next, p prev, g N goto, s state, q quit"); continue; }
    printEventDetail(events, pos);
  }
  rl.close();
  return 0;
}

function printEventDetail(events: AgitEvent[], seq: number): void {
  const e = events[seq]!;
  console.log(`\n─── event ${e.seq} · ${e.ts} · ${e.type} ─── hash ${e.hash.slice(0, 12)}`);
  const p = e.payload as { [k: string]: unknown };
  switch (e.type) {
    case "message.user":
    case "message.assistant": {
      const texts = e.type === "message.user"
        ? [String(p.text ?? "")]
        : (p.blocks as { type: string; text: string }[]).map((b) => (b.type === "thinking" ? `(thinking) ${b.text}` : b.text));
      for (const t of texts) console.log(indentClip(t, 30));
      break;
    }
    case "tool.call":
      console.log(`  ${p.name}`);
      console.log(indentClip(JSON.stringify(p.input, null, 2) ?? "{}", 25));
      break;
    case "tool.result":
      if (p.isError === true) console.log("  (error)");
      console.log(indentClip(String(p.output ?? ""), 25));
      break;
    case "file.diff":
      console.log(`  ${p.kind} ${p.path}`);
      console.log(`  before ${p.beforeHash ?? "∅"}  after ${p.afterHash}`);
      console.log(indentClip(String(p.diff ?? ""), 40));
      break;
    default:
      console.log(indentClip(JSON.stringify(p, null, 2), 25));
  }
}

function printStateAt(events: AgitEvent[], seq: number): void {
  const files = fileStateAt(events, seq);
  const u = usageTotals(events, seq);
  console.log(`\nstate after event ${seq}:`);
  console.log(`  tokens so far  in=${u.inputTokens} out=${u.outputTokens} (${u.apiMessages} API messages)`);
  if (files.size === 0) {
    console.log("  no structured file edits yet");
  } else {
    for (const f of files.values()) {
      console.log(`  ${f.kind === "create" ? "A" : "M"} ${f.path}  (+${f.added} -${f.removed})  content sha256 ${f.afterHash.slice(0, 12)} @ seq ${f.lastSeq}`);
    }
    console.log("  (structured edits only — shell-driven changes are invisible here, SPEC §5.7)");
  }
}

function indentClip(text: string, maxLines: number): string {
  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines).map((l) => "  " + excerpt(l, 160));
  if (lines.length > maxLines) shown.push(`  … ${lines.length - maxLines} more lines`);
  return shown.join("\n");
}

function requireId(opts: Opts): string {
  const arg = opts.args[0];
  if (!arg) { console.error("missing <id> (agit ls to list sessions)"); process.exit(2); }
  return resolveSessionId(opts.dir, arg);
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
