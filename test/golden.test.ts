import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildChain, toJsonl } from "../src/format/hash.js";
import { redactDeep, type RedactionCounts } from "../src/redact.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const fixture = join(ROOT, "fixtures", "claude-code", "simple.jsonl");
const golden = join(ROOT, "fixtures", "claude-code", "simple.golden.jsonl");

/**
 * The project's own guarantee, pinned: importing the committed fixture must
 * reproduce the committed golden log byte for byte. A refactor that changes
 * canonical serialization, hashing, redaction, or the adapter mapping —
 * however innocently — breaks every hash anyone has ever recorded, and this
 * test is where that surfaces. If the change is INTENTIONAL, it is a schema
 * or adapter version bump (SPEC §11): regenerate the golden file in the same
 * commit and say so loudly in the commit message.
 */
describe("golden import", () => {
  it("fixture import reproduces the committed golden log exactly", () => {
    const lines = readFileSync(fixture, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const converted = claudeCodeAdapter.convert(lines);
    const counts: RedactionCounts = {};
    for (const d of converted.drafts) d.payload = redactDeep(d.payload, counts);
    const produced = toJsonl(buildChain(converted.sessionId, converted.drafts));
    // Compare with LF endings regardless of checkout translation.
    expect(produced).toBe(readFileSync(golden, "utf8").replace(/\r\n/g, "\n"));
  });
});
