import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildChain } from "../src/format/hash.js";
import { fileStateAt, usageTotals } from "../src/state.js";

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
