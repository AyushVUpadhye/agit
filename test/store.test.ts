import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeSessionId, listSessionIds, sessionDir, writeSession } from "../src/store.js";
import type { SessionMeta } from "../src/format/events.js";

function tmpBase(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "agit-store-")));
}

const META: SessionMeta = {
  agitSchema: 1,
  sessionId: "s",
  adapter: { name: "test", version: "0" },
  importedAt: new Date().toISOString(),
  source: { path: "x.jsonl", sha256: "0".repeat(64), bytes: 0, records: 0 },
  skipped: {},
  redactions: {},
  eventCount: 0,
  headHash: "0".repeat(64),
};

describe("assertSafeSessionId (SPEC §1)", () => {
  it("accepts ids matching the spec charset", () => {
    for (const id of ["a", "session-1", "abc_DEF.123", "0000-uuid-looking-4f2a"]) {
      expect(() => assertSafeSessionId(id)).not.toThrow();
    }
  });

  it("rejects path-traversal and separator payloads a hostile native log could set", () => {
    for (const id of [
      "..",
      ".",
      "",
      "../evil",
      "../../etc/passwd",
      "a/b",
      "a\\b",
      "/etc/passwd",
      "C:\\evil",
    ]) {
      expect(() => assertSafeSessionId(id)).toThrow(/unsafe session id/);
    }
  });
});

describe("writeSession path safety", () => {
  it("refuses to write a session whose id would escape .agit/sessions", () => {
    const base = tmpBase();
    expect(() => writeSession(base, "../../outside", "", { ...META, sessionId: "../../outside" })).toThrow(
      /unsafe session id/,
    );
    // Nothing was written outside the store, and nothing inside it either.
    expect(existsSync(resolve(base, "..", "..", "outside"))).toBe(false);
    expect(listSessionIds(base)).toEqual([]);
  });

  it("still writes normally for a well-formed id", () => {
    const base = tmpBase();
    writeSession(base, "good-id", '{"a":1}\n', { ...META, sessionId: "good-id" });
    expect(readFileSync(join(sessionDir(base, "good-id"), "events.jsonl"), "utf8")).toBe('{"a":1}\n');
    expect(listSessionIds(base)).toEqual(["good-id"]);
  });
});
