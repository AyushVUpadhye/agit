import { describe, expect, it } from "vitest";
import { applyUnifiedDiff, PatchError } from "../src/patch.js";

describe("applyUnifiedDiff: bare empty-line context", () => {
  it("accepts a bare empty line as context when the base line is genuinely empty", () => {
    const base = "a\n\nb\n";
    const diff = "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n\n-b\n+B\n";
    expect(applyUnifiedDiff(base, diff)).toBe("a\n\nB\n");
  });

  it(
    "keeps a bare empty context line even when it is the last line of the hunk " +
      "(previously confused with the trailing-newline split artifact)",
    () => {
      const base = "a\n\n"; // two lines: "a" and ""
      const diff = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n\n";
      expect(applyUnifiedDiff(base, diff)).toBe("a\n\n");
    },
  );

  it("throws instead of silently dropping a bare empty line that does not match the base", () => {
    // Base line 2 is "x", not empty — a bare "" context line here is a
    // genuine mismatch and must be treated like any other context mismatch
    // (PatchError), not silently swallowed.
    const base = "a\nx\nb\n";
    const diff = "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n\n-b\n+B\n";
    expect(() => applyUnifiedDiff(base, diff)).toThrow(PatchError);
  });

  it("throws instead of silently dropping a bare empty line past the end of the base", () => {
    const base = "a\n";
    const diff = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n\n";
    expect(() => applyUnifiedDiff(base, diff)).toThrow(PatchError);
  });
});
