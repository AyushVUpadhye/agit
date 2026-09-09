import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildChain, sha256Hex } from "../src/format/hash.js";
import type { AgitEvent } from "../src/format/events.js";
import { writeFork } from "../src/fork.js";
import { gitMergeFile, mergeFork } from "../src/merge.js";
import { redactDeep, type RedactionCounts } from "../src/redact.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const lines = readFileSync(join(ROOT, "fixtures", "claude-code", "demo.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
const converted = claudeCodeAdapter.convert(lines);
const counts: RedactionCounts = {};
for (const d of converted.drafts) d.payload = redactDeep(d.payload, counts);
const DEMO: AgitEvent[] = buildChain(converted.sessionId, converted.drafts);
const HEAD = DEMO.length - 1;

/** A fork of the demo session plus a target dir seeded with the fork-point tree. */
function setup(): { forkDir: string; intoDir: string } {
  const scratch = mkdtempSync(join(tmpdir(), "agit-mergetest-"));
  const forkDir = join(scratch, "fork");
  writeFork(DEMO, HEAD, "demo-ratelimit-0001", forkDir);
  // The target starts as the same tree (a colleague's checkout at the fork point).
  const intoDir = join(scratch, "target");
  for (const rel of ["src/ratelimit.ts", "src/login.ts"]) {
    const dest = join(intoDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(forkDir, "tree", rel), "utf8"), "utf8");
  }
  return { forkDir, intoDir };
}

describe("gitMergeFile", () => {
  it("merges non-overlapping edits cleanly", () => {
    const base = "a\nb\nc\nd\ne\n";
    const r = gitMergeFile(base, "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n");
    expect(r.clean).toBe(true);
    expect(r.content).toBe("A\nb\nc\nd\nE\n");
  });

  it("reports conflicts with standard markers", () => {
    const base = "x\n";
    const r = gitMergeFile(base, "ours-change\n", "fork-change\n");
    expect(r.clean).toBe(false);
    expect(r.content).toContain("<<<<<<< ours");
    expect(r.content).toContain(">>>>>>> fork");
  });

  // The merged result used to come back through execFileSync's stdout, capped
  // at the default 1 MB maxBuffer -- so an ordinary large file (a lockfile, a
  // generated module) took the whole `agit merge` down with `spawnSync git
  // ENOBUFS`, after earlier files had already been written to the target.
  const BULK = "a line of perfectly ordinary source code\n".repeat(36_000); // ~1.4 MB

  it("merges a file whose result exceeds 1 MB", () => {
    const r = gitMergeFile(BULK, "ours header\n" + BULK, BULK + "fork footer\n");
    expect(r.clean).toBe(true);
    expect(r.content.length).toBeGreaterThan(1024 * 1024);
    expect(r.content.startsWith("ours header\n")).toBe(true);
    expect(r.content.endsWith("fork footer\n")).toBe(true);
  });

  it("still reports conflicts in a file that large", () => {
    const r = gitMergeFile(BULK, BULK + "ours tail\n", BULK + "fork tail\n");
    expect(r.clean).toBe(false);
    expect(r.content.length).toBeGreaterThan(1024 * 1024);
    expect(r.content).toContain("<<<<<<< ours");
    expect(r.content).toContain(">>>>>>> fork");
  });
});

describe("mergeFork", () => {
  it("fast-forwards when the target never moved, and records merge.json", () => {
    const { forkDir, intoDir } = setup();
    // Simulate the forked session changing ratelimit.ts.
    const p = join(forkDir, "tree", "src", "ratelimit.ts");
    writeFileSync(p, readFileSync(p, "utf8").replace("LIMIT = 5", "LIMIT = 3"), "utf8");

    const { results, conflicts } = mergeFork({
      forkDir,
      intoDir,
      sourceEvents: DEMO,
      summary: "tightened the limit to 3 after load testing",
    });
    expect(conflicts).toBe(0);
    const byRel = Object.fromEntries(results.map((r) => [r.rel, r.outcome]));
    expect(byRel["src/ratelimit.ts"]).toBe("took-fork");
    expect(byRel["src/login.ts"]).toBe("unchanged");
    expect(readFileSync(join(intoDir, "src", "ratelimit.ts"), "utf8")).toContain("LIMIT = 3");

    const record = JSON.parse(readFileSync(join(forkDir, "merge.json"), "utf8")) as Record<string, unknown>;
    expect(record.summary).toBe("tightened the limit to 3 after load testing");
    expect(record.conflicts).toBe(0);
  });

  it("three-way merges diverging non-overlapping edits and flags true conflicts", () => {
    const { forkDir, intoDir } = setup();
    const forkFile = join(forkDir, "tree", "src", "ratelimit.ts");
    const oursFile = join(intoDir, "src", "ratelimit.ts");
    // Fork edits the return expression; ours edits the LIMIT line, three
    // lines away -> separable hunks, clean merge. (Adjacent-line edits are a
    // genuine diff3 conflict, so the regions must actually be apart.)
    writeFileSync(
      forkFile,
      readFileSync(forkFile, "utf8").replace("hits(ip, WINDOW)", "hits(ip, WINDOW * 2)"),
      "utf8",
    );
    writeFileSync(oursFile, readFileSync(oursFile, "utf8").replace("LIMIT = 5", "LIMIT = 8"), "utf8");
    // Both edit the same line of login.ts -> conflict.
    const forkLogin = join(forkDir, "tree", "src", "login.ts");
    const oursLogin = join(intoDir, "src", "login.ts");
    writeFileSync(forkLogin, readFileSync(forkLogin, "utf8").replace("tooMany()", "reject429()"), "utf8");
    writeFileSync(oursLogin, readFileSync(oursLogin, "utf8").replace("tooMany()", "throttle()"), "utf8");

    const { results, conflicts } = mergeFork({ forkDir, intoDir, sourceEvents: DEMO });
    const byRel = Object.fromEntries(results.map((r) => [r.rel, r.outcome]));
    expect(byRel["src/ratelimit.ts"]).toBe("clean-merge");
    const merged = readFileSync(oursFile, "utf8");
    expect(merged).toContain("LIMIT = 8");
    expect(merged).toContain("WINDOW * 2");

    expect(conflicts).toBe(1);
    expect(byRel["src/login.ts"]).toBe("conflict");
    expect(readFileSync(oursLogin, "utf8")).toContain("<<<<<<< ours");
  });

  it("adds fork-new files and never resurrects target deletions", () => {
    const { forkDir, intoDir } = setup();
    writeFileSync(join(forkDir, "tree", "src", "limits.md"), "docs\n", "utf8");
    rmSync(join(intoDir, "src", "login.ts")); // target deleted it; fork left it at base

    const { results } = mergeFork({ forkDir, intoDir, sourceEvents: DEMO });
    const byRel = Object.fromEntries(results.map((r) => [r.rel, r.outcome]));
    expect(byRel["src/limits.md"]).toBe("added");
    expect(readFileSync(join(intoDir, "src", "limits.md"), "utf8")).toBe("docs\n");
    expect(byRel["src/login.ts"]).toBe("unchanged");
    expect(existsSync(join(intoDir, "src", "login.ts"))).toBe(false);
  });

  it("refuses a fork whose fork-point hash contradicts the store", () => {
    const { forkDir, intoDir } = setup();
    const fj = JSON.parse(readFileSync(join(forkDir, "fork.json"), "utf8")) as Record<string, unknown>;
    fj.atHash = "0".repeat(64);
    writeFileSync(join(forkDir, "fork.json"), JSON.stringify(fj), "utf8");
    expect(() => mergeFork({ forkDir, intoDir, sourceEvents: DEMO })).toThrow(/does not match/);
  });

  it("merges interleaved edits across multiple files independently", () => {
    const baseA = "a1\na2\na3\na4\na5\na6\na7\n";
    const baseB = "b1\nb2\nb3\nb4\nb5\nb6\nb7\n";
    const forkA = "a1\na2\nA3-fork\na4\na5\na6\na7-fork\n";
    const forkB = "b1\nb2\nB3-fork\nb4\nb5\nb6\nb7-fork\n";
    const oursA = "A1-ours\na2\na3\na4\na5\na6\na7\n";
    const oursB = "B1-ours\nb2\nb3\nb4\nb5\nb6\nb7\n";

    const drafts = [
      {
        ts: "2026-01-01T00:00:00.000Z",
        type: "file.diff" as const,
        payload: {
          path: "src/a.ts",
          kind: "create" as const,
          diff: "--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1,7 @@\n+a1\n+a2\n+a3\n+a4\n+a5\n+a6\n+a7\n",
          beforeHash: null,
          afterHash: sha256Hex(baseA),
          toolUseId: "a-create",
          source: "test",
        },
      },
      {
        ts: "2026-01-01T00:00:01.000Z",
        type: "file.diff" as const,
        payload: {
          path: "src/b.ts",
          kind: "create" as const,
          diff: "--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1,7 @@\n+b1\n+b2\n+b3\n+b4\n+b5\n+b6\n+b7\n",
          beforeHash: null,
          afterHash: sha256Hex(baseB),
          toolUseId: "b-create",
          source: "test",
        },
      },
      {
        ts: "2026-01-01T00:00:02.000Z",
        type: "file.diff" as const,
        payload: {
          path: "src/a.ts",
          kind: "modify" as const,
          diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,7 +1,7 @@\n a1\n a2\n-a3\n+A3-fork\n a4\n a5\n a6\n-a7\n+A7-fork\n",
          beforeHash: sha256Hex(baseA),
          afterHash: sha256Hex(forkA),
          toolUseId: "a-edit",
          source: "test",
        },
      },
      {
        ts: "2026-01-01T00:00:03.000Z",
        type: "file.diff" as const,
        payload: {
          path: "src/b.ts",
          kind: "modify" as const,
          diff: "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,7 +1,7 @@\n b1\n b2\n-b3\n+B3-fork\n b4\n b5\n b6\n-b7\n+B7-fork\n",
          beforeHash: sha256Hex(baseB),
          afterHash: sha256Hex(forkB),
          toolUseId: "b-edit",
          source: "test",
        },
      },
    ];

    const events = buildChain("merge-interleave", drafts);
    const scratch = mkdtempSync(join(tmpdir(), "agit-merge-interleave-"));
    const forkDir = join(scratch, "fork");
    const intoDir = join(scratch, "target");

    writeFork(events, 1, "merge-interleave", forkDir);

    for (const rel of ["src/a.ts", "src/b.ts"]) {
      const dest = join(intoDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(join(forkDir, "tree", rel), "utf8"), "utf8");
    }

    writeFileSync(join(forkDir, "tree", "src", "a.ts"), forkA, "utf8");
    writeFileSync(join(forkDir, "tree", "src", "b.ts"), forkB, "utf8");

    writeFileSync(join(intoDir, "src", "a.ts"), oursA, "utf8");
    writeFileSync(join(intoDir, "src", "b.ts"), oursB, "utf8");

    const { results, conflicts } = mergeFork({
      forkDir,
      intoDir,
      sourceEvents: events,
    });

    const byRel = Object.fromEntries(results.map((r) => [r.rel, r.outcome]));

    expect(conflicts).toBe(0);
    expect(byRel["src/a.ts"]).toBe("clean-merge");
    expect(byRel["src/b.ts"]).toBe("clean-merge");

    expect(readFileSync(join(intoDir, "src", "a.ts"), "utf8")).toBe(
      "A1-ours\na2\nA3-fork\na4\na5\na6\na7-fork\n",
    );
    expect(readFileSync(join(intoDir, "src", "b.ts"), "utf8")).toBe(
      "B1-ours\nb2\nB3-fork\nb4\nb5\nb6\nb7-fork\n",
    );
  });
});
