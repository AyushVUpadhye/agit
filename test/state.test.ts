import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildChain } from "../src/format/hash.js";
import type { DraftEvent } from "../src/format/events.js";
import { fileStateAt, timelineLines, usageTotals } from "../src/state.js";

const FIXTURE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "fixtures",
  "claude-code",
  "simple.jsonl",
);
const lines = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
const res = claudeCodeAdapter.convert(lines);
const events = buildChain(res.sessionId, res.drafts);

describe("replay state folds", () => {
  it("file state is cumulative and time-travels", () => {
    // Event 7 is the create diff, 11 the modify diff (see adapter.test.ts).
    expect(fileStateAt(events, 6).size).toBe(0);
    const afterCreate = fileStateAt(events, 7).get("C:\\proj\\hello.ts")!;
    expect(afterCreate.kind).toBe("create");
    expect(afterCreate.edits).toBe(1);

    const atEnd = fileStateAt(events).get("C:\\proj\\hello.ts")!;
    expect(atEnd.kind).toBe("create"); // created within this session, then modified
    expect(atEnd.edits).toBe(2);
    expect(atEnd.lastSeq).toBe(11);
    expect(atEnd.added).toBeGreaterThan(0);
    expect(atEnd.removed).toBeGreaterThan(0);
  });

  it("flags divergence when a beforeHash contradicts the last known content", () => {
    const diff = (ts: string, beforeHash: string | null, afterHash: string): DraftEvent => ({
      ts,
      type: "file.diff",
      payload: {
        path: "C:\\p\\a.ts",
        kind: beforeHash === null ? "create" : "modify",
        diff: "",
        beforeHash,
        afterHash,
        toolUseId: "t",
        source: "Edit",
      },
    });
    // create -> consistent edit -> edit whose before contradicts the last after
    const evs = buildChain("s", [
      diff("2026-01-01T00:00:00.000Z", null, "h1"),
      diff("2026-01-01T00:00:01.000Z", "h1", "h2"),
      diff("2026-01-01T00:00:02.000Z", "hX", "h3"),
    ]);
    const clean = fileStateAt(evs, 1).get("C:\\p\\a.ts")!;
    expect(clean.divergedAtSeq).toBeUndefined();
    const state = fileStateAt(evs).get("C:\\p\\a.ts")!;
    expect(state.divergedAtSeq).toBe(2); // proof: something changed a.ts between seq 1 and 2
    expect(state.afterHash).toBe("h3");
  });

  it("timeline shows date separators only when a session spans days", () => {
    const singleDay = timelineLines(events);
    expect(singleDay.some((l) => l.includes("──────"))).toBe(false);
    expect(singleDay).toHaveLength(events.length);

    const twoDays = buildChain("s", [
      { ts: "2026-01-01T23:59:00.000Z", type: "message.user", payload: { text: "late" } },
      { ts: "2026-01-02T00:03:00.000Z", type: "message.user", payload: { text: "past midnight" } },
      { ts: "2026-01-02T09:00:00.000Z", type: "message.user", payload: { text: "morning" } },
    ]);
    const lines2 = timelineLines(twoDays);
    expect(lines2).toHaveLength(5); // 3 rows + 2 separators
    expect(lines2[0]).toContain("2026-01-01");
    expect(lines2[2]).toContain("2026-01-02");
    expect(lines2.filter((l) => l.includes("──────"))).toHaveLength(2);
  });

  it("usage totals accumulate and respect the cutoff", () => {
    const all = usageTotals(events);
    expect(all.apiMessages).toBe(4);
    expect(all.inputTokens).toBe(10 + 1 + 7 + 5);
    expect(all.outputTokens).toBe(20 + 2 + 8 + 6);
    expect([...all.models]).toEqual(["claude-opus-5"]);

    const early = usageTotals(events, 5); // only msg_A's cost has landed
    expect(early.apiMessages).toBe(1);
    expect(early.inputTokens).toBe(10);
  });
});
