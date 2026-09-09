import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isEventTypeForVersion,
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  type AgitEvent,
  type DraftEvent,
} from "../src/format/events.js";
import { buildChain, eventHash, sha256Hex } from "../src/format/hash.js";
import { verifyChain } from "../src/format/verify.js";
import { fileStateAt } from "../src/state.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const V1_GOLDEN = join(ROOT, "fixtures", "claude-code", "simple.golden.v1.jsonl");

const lines = (text: string): string[] => text.split("\n").filter((l) => l.trim() !== "");

/** Re-chain events under another schema version, the way a build of that version wrote them. */
function asVersion(events: AgitEvent[], v: number): AgitEvent[] {
  let prev: string | null = null;
  return events.map((e) => {
    const re = { ...e, v, prev } as AgitEvent;
    re.hash = eventHash(re);
    prev = re.hash;
    return re;
  });
}

const TS = (n: number): string => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;
const CONTENT = "hello\n";
const DRAFTS: DraftEvent[] = [
  { ts: TS(0), type: "session.start", payload: { runtime: "test", cwd: "/w" } },
  {
    ts: TS(1),
    type: "file.diff",
    payload: {
      path: "/w/a.txt",
      kind: "create",
      diff: "--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+hello\n",
      beforeHash: null,
      afterHash: sha256Hex(CONTENT),
      toolUseId: "t1",
      source: "apply_patch",
    },
  },
  {
    ts: TS(2),
    type: "file.delete",
    payload: { path: "/w/a.txt", beforeHash: sha256Hex(CONTENT), toolUseId: "t2", source: "apply_patch" },
  },
];

describe("schema versions: v2 writes, v1 still reads", () => {
  it("this build writes v2, and readers accept both versions", () => {
    expect(SCHEMA_VERSION).toBe(2);
    expect([...SUPPORTED_SCHEMA_VERSIONS]).toEqual([1, 2]);
    const events = buildChain("s", DRAFTS);
    expect(events.every((e) => e.v === 2)).toBe(true);
    expect(verifyChain(events.map((e) => JSON.stringify(e))).ok).toBe(true);
  });

  it("a v1 log written by the previous build still verifies, untouched", () => {
    const text = readFileSync(V1_GOLDEN, "utf8");
    expect(lines(text).every((l) => (JSON.parse(l) as AgitEvent).v === 1)).toBe(true);
    const res = verifyChain(lines(text));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.events).toBeGreaterThan(0);
  });

  it("a v1 log is still recognized and adopted by import, and verifies from the store", () => {
    const store = mkdtempSync(join(tmpdir(), "agit-v1-"));
    const run = (args: string[]): string => {
      try {
        return execFileSync(process.execPath, [CLI, ...args, "--dir", store], {
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        return (e.stdout ?? "") + (e.stderr ?? "");
      }
    };
    expect(run(["import", V1_GOLDEN])).toContain("adopted");
    const id = (JSON.parse(lines(readFileSync(V1_GOLDEN, "utf8"))[0]!) as AgitEvent).session;
    expect(run(["verify", id])).toContain("chain intact");
  });

  it("file.delete is accepted in v2 and rejected in a v1 log, naming the event", () => {
    const v2 = buildChain("s", DRAFTS);
    expect(verifyChain(v2.map((e) => JSON.stringify(e))).ok).toBe(true);

    const v1 = asVersion(v2, 1);
    const res = verifyChain(v1.map((e) => JSON.stringify(e)));
    expect(res.ok).toBe(false);
    expect(res.firstBroken?.seq).toBe(2);
    expect(res.firstBroken?.reason).toMatch(/requires schema v2/);
    // Everything before the deletion was fine under v1.
    expect(res.events).toBe(2);
  });

  it("an unknown schema version is still rejected", () => {
    const v7 = asVersion(buildChain("s", DRAFTS.slice(0, 2)), 7);
    const res = verifyChain(v7.map((e) => JSON.stringify(e)));
    expect(res.ok).toBe(false);
    expect(res.firstBroken?.reason).toBe("unknown schema version 7");
  });

  it("isEventTypeForVersion draws the line exactly at file.delete", () => {
    expect(isEventTypeForVersion("file.delete", 1)).toBe(false);
    expect(isEventTypeForVersion("file.delete", 2)).toBe(true);
    expect(isEventTypeForVersion("file.diff", 1)).toBe(true);
    expect(isEventTypeForVersion("file.diff", 2)).toBe(true);
    expect(isEventTypeForVersion("bogus", 2)).toBe(false);
  });
});

describe("file state with deletions", () => {
  it("marks a deleted file and keeps its history", () => {
    const events = buildChain("s", DRAFTS);
    const state = fileStateAt(events);
    const a = state.get("/w/a.txt")!;
    expect(a.deletedAtSeq).toBe(2);
    expect(a.edits).toBe(2);
    expect(a.divergedAtSeq).toBeUndefined();
    // Before the deletion it was simply a created file.
    expect(fileStateAt(events, 1).get("/w/a.txt")!.deletedAtSeq).toBeUndefined();
  });

  it("a later edit of the same path clears the deletion", () => {
    const events = buildChain("s", [
      ...DRAFTS,
      {
        ts: TS(3),
        type: "file.diff",
        payload: {
          path: "/w/a.txt",
          kind: "create",
          diff: "--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+again\n",
          beforeHash: null,
          afterHash: sha256Hex("again\n"),
          toolUseId: "t3",
          source: "apply_patch",
        },
      },
    ]);
    const a = fileStateAt(events).get("/w/a.txt")!;
    expect(a.deletedAtSeq).toBeUndefined();
    expect(a.afterHash).toBe(sha256Hex("again\n"));
    expect(a.edits).toBe(3);
  });

  it("a deletion whose beforeHash contradicts the last known content is proof of an outside edit", () => {
    const drafts = DRAFTS.map((d) => ({ ...d, payload: { ...(d.payload as object) } })) as DraftEvent[];
    (drafts[2]!.payload as { beforeHash: string }).beforeHash = sha256Hex("edited by a shell command\n");
    const a = fileStateAt(buildChain("s", drafts)).get("/w/a.txt")!;
    expect(a.deletedAtSeq).toBe(2);
    expect(a.divergedAtSeq).toBe(2);
  });
});
