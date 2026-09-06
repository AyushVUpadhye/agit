#!/usr/bin/env node
/**
 * Regenerates docs/demo.svg — the README demo as a self-contained animated
 * SVG (CSS keyframes, no scripts, no external assets, ~15KB).
 *
 * Every line of terminal text is REAL agit CLI output, captured by running
 * the built CLI against the synthetic fixture (fixtures/claude-code/
 * demo.jsonl). The generator only adds presentation: window chrome, scene
 * cuts, reveal timing, and color (event-type chips, diff +/-, the DIVERGED
 * highlight) — the same coloring the share page applies to the same data.
 *
 * Why SVG for the README: GitHub wraps animated GIFs in a play/pause
 * control that shows a play button to reduced-motion viewers; SVG in an
 * <img> is never wrapped, always autoplays, and stays crisp at any width.
 *
 * Usage: npm run build && node scripts/gen-demo-svg.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = mkdtempSync(join(tmpdir(), "agit-demo-svg-"));
const run = (...args) => {
  const r = spawnSync(process.execPath, [join(ROOT, "dist", "cli.js"), ...args, "--dir", store], {
    cwd: ROOT,
    encoding: "utf8",
    input: "",
  });
  return ((r.stdout ?? "") + (r.stderr ?? "")).replace(/\r\n/g, "\n").trimEnd().split("\n");
};

const importOut = run("import", "fixtures/claude-code/demo.jsonl");
const stateOut = run("replay", "demo", "--at", "24", "--state");
const verifyOut = run("verify", "demo");
const timelineOut = run("replay", "demo", "--timeline");
rmSync(store, { recursive: true, force: true });

// ---------------------------------------------------------------------------

const C = {
  fg: "#e6edf3",
  dim: "#8b949e",
  green: "#3fb950",
  red: "#f85149",
  blue: "#58a6ff",
  yellow: "#e3b341",
  magenta: "#f778ba",
  purple: "#d2a8ff",
};
const TYPE_COLORS = {
  "session.start": C.dim,
  "session.end": C.dim,
  user: C.purple,
  assistant: C.blue,
  "tool.call": C.yellow,
  "tool.result": C.dim,
  "file.diff": C.green,
  cost: C.magenta,
};

/** Split one output line into [text, color] runs. Content is untouched. */
function colorize(line) {
  const m = /^(\s*\d+\s+\d\d:\d\d:\d\d\s+)(\S+)(\s+)(.*)$/.exec(line);
  if (m) {
    const runs = [
      [m[1], C.dim],
      [m[2], TYPE_COLORS[m[2]] ?? C.fg],
      [m[3], C.fg],
    ];
    return runs.concat(highlight(m[4]));
  }
  if (/^\s*(---|-[^-])/.test(line)) return [[line, C.red]];
  if (/^\s*\+/.test(line)) return [[line, C.green]];
  if (/^\s*@@/.test(line)) return [[line, C.blue]];
  if (/^─── event/.test(line) || /^\s+before .+ after /.test(line)) return [[line, C.dim]];
  if (/^ok: /.test(line)) return [[line, C.green]];
  if (/^imported /.test(line))
    return [
      ["imported ", C.fg],
      [line.slice(9), C.blue],
    ];
  if (/^\s+(adapter|events|skipped|head|wrote)\s/.test(line)) return [[line, C.dim]];
  if (/^\s+redacted\s/.test(line)) {
    const i = line.indexOf("2:");
    return i === -1
      ? [[line, C.dim]]
      : [
          [line.slice(0, i), C.dim],
          [line.slice(i), C.yellow],
        ];
  }
  if (/lower bound|structured edits only/.test(line)) return [[line, C.dim]];
  return highlight(line);
}

/** In-line highlights for REDACTED and DIVERGED markers, wherever they appear. */
function highlight(text) {
  const runs = [];
  const re = /(\[REDACTED:[a-z-]+\]|\[DIVERGED[^\]]*\])/g;
  let last = 0;
  for (let m; (m = re.exec(text));) {
    if (m.index > last) runs.push([text.slice(last, m.index), C.fg]);
    runs.push([m[1], m[1].startsWith("[DIVERGED") ? C.red : C.yellow]);
    last = m.index + m[1].length;
  }
  if (last < text.length) runs.push([text.slice(last), C.fg]);
  return runs.length > 0 ? runs : [["", C.fg]];
}

// ---------------------------------------------------------------------------

const W = 800;
const TOP = 42;
const LH = 15.2;
const FS = 12;
const TOTAL = 19;
const lines = []; // {t, end, row, runs}

function scene(start, end) {
  let row = 0;
  return {
    cmd: (dt, text) =>
      lines.push({
        t: start + dt,
        end,
        row: row++,
        runs: [
          ["$ ", C.green],
          [text, C.fg],
        ],
      }),
    say: (dt, outLines) => {
      for (const [i, l] of outLines.entries()) {
        lines.push({ t: start + dt + i * 0.06, end, row: row++, runs: colorize(l) });
      }
    },
    gap: () => row++,
  };
}

// Scene 1 — import (the poster: visible from t=0).
const s1 = scene(0, 4.6);
s1.cmd(0, "agit import fixtures/claude-code/demo.jsonl");
s1.say(
  0.5,
  importOut.filter((l) => !l.startsWith("  wrote")),
);

// Scene 2 — the payoff, early: the divergent diff and the state proof.
const s2 = scene(4.6, 13.2);
s2.cmd(0.2, "agit replay demo --at 24 --state");
s2.say(
  0.8,
  stateOut.filter((l) => l !== ""),
);

// Scene 3 — trust beat + the timeline as context (story tail fits the frame).
const s3 = scene(13.2, TOTAL);
s3.cmd(0.2, "agit verify demo");
s3.say(0.7, verifyOut);
s3.gap();
s3.cmd(1.3, "agit replay demo --timeline");
s3.say(1.9, timelineOut.slice(10));

const H = TOP + 12 + Math.max(...lines.map((l) => l.row + 1)) * LH + 14;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (sec) => ((Math.min(Math.max(sec, 0), TOTAL) / TOTAL) * 100).toFixed(3);

let styles = "";
let body = "";
lines.forEach((l, i) => {
  const a = pct(l.t);
  const b = pct(l.t + 0.02);
  const c = pct(l.end - 0.15);
  styles += `@keyframes k${i}{0%,${a}%{opacity:0}${b}%,${c}%{opacity:1}${pct(l.end - 0.1)}%,100%{opacity:0}}\n.l${i}{opacity:0;animation:k${i} ${TOTAL}s steps(1,end) infinite}\n`;
  const y = (TOP + 14 + l.row * LH).toFixed(1);
  const spans = l.runs.map(([text, color]) => `<tspan fill="${color}">${esc(text)}</tspan>`).join("");
  body += `<text class="l${i}" x="16" y="${y}">${spans}</text>\n`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Consolas,Menlo,monospace" font-size="${FS}">
<style>
text{white-space:pre}
${styles}</style>
<rect width="${W}" height="${H}" rx="8" fill="#0d1117" stroke="#30363d"/>
<rect width="${W}" height="28" rx="8" fill="#161b22"/>
<rect y="20" width="${W}" height="8" fill="#161b22"/>
<circle cx="19" cy="14" r="5" fill="#f85149"/><circle cx="37" cy="14" r="5" fill="#e3b341"/><circle cx="55" cy="14" r="5" fill="#3fb950"/>
<text x="${W / 2}" y="18" text-anchor="middle" fill="#8b949e">agit — the session is data</text>
${body}</svg>
`;
writeFileSync(join(ROOT, "docs", "demo.svg"), svg);
console.log(`wrote docs/demo.svg (${svg.length} bytes, ${lines.length} lines, ${TOTAL}s loop, ${W}x${H})`);
