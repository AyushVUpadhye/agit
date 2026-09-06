#!/usr/bin/env node
/**
 * Regenerates the README demo: docs/demo.cast (asciinema v2) and, when agg
 * is available, docs/demo.gif.
 *
 * Every line of terminal output is REAL agit CLI output, captured by running
 * the built CLI against the synthetic fixture session
 * (fixtures/claude-code/demo.jsonl — never a real session). Only the prompt,
 * keystroke pacing, and pauses are synthesized: asciinema has no native
 * Windows recorder, so the cast is assembled rather than PTY-recorded. The
 * .cast plays in any asciinema player; agg turns it into the GIF.
 *
 * Usage:  npm run build && node scripts/record-demo.mjs [path\to\agg.exe]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const FIXTURE = join("fixtures", "claude-code", "demo.jsonl");
const CAST = join(ROOT, "docs", "demo.cast");
const GIF = join(ROOT, "docs", "demo.gif");
const store = mkdtempSync(join(tmpdir(), "agit-demo-"));

const COLS = 114;
const ROWS = 28;
let t = 0.5;
const events = [];
const out = (s) => events.push([Number(t.toFixed(3)), "o", s]);
const crlf = (s) => s.replace(/\r?\n/g, "\r\n");
const PROMPT = "[1;32m$[0m ";

function type(s, cps = 0.022) {
  for (const ch of s) {
    out(ch);
    t += cps;
  }
}

function run(args, input) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--dir", store], {
    cwd: ROOT,
    input,
    encoding: "utf8",
  });
  if (r.status !== 0 && args[0] !== "verify") {
    throw new Error(`agit ${args.join(" ")} exited ${r.status}:\n${r.stderr}`);
  }
  return (r.stdout ?? "") + (r.stderr ?? "");
}

function cmd(display, args, { pause = 1.3, lineDelay = 0.04, input } = {}) {
  out(PROMPT);
  type(display);
  t += 0.4;
  out("\r\n");
  t += 0.12;
  const lines = crlf(run(args, input)).split("\r\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    out(line + "\r\n");
    t += lineDelay;
  }
  t += pause;
}

// The storyboard: import -> verify -> the whole timeline -> jump to the
// divergent diff -> file state proving something changed outside the log.
cmd("agit import fixtures/claude-code/demo.jsonl", ["import", FIXTURE], { pause: 1.7 });
cmd("agit verify demo", ["verify", "demo"], { pause: 1.5 });
cmd("agit replay demo --timeline", ["replay", "demo", "--timeline"], { pause: 2.0, lineDelay: 0.055 });
cmd("agit replay demo --at 24", ["replay", "demo", "--at", "24"], { pause: 2.0, input: "" });
cmd("agit replay demo --at 24 --state", ["replay", "demo", "--at", "24", "--state"], {
  pause: 3.2,
  input: "",
});

rmSync(store, { recursive: true, force: true });

const header = {
  version: 2,
  width: COLS,
  height: ROWS,
  title: "agit — git for running agents",
  env: { TERM: "xterm-256color", SHELL: "/bin/bash" },
};
writeFileSync(CAST, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n");
console.log(`wrote ${CAST} (${events.length} events, ${t.toFixed(1)}s)`);

const agg = process.argv[2] ?? "agg";
const r = spawnSync(agg, ["--font-size", "15", CAST, GIF], { stdio: "inherit" });
if (r.error || r.status !== 0) {
  console.log("agg not run (pass its path as the first argument to produce the GIF)");
} else {
  console.log(`wrote ${GIF}`);
}
