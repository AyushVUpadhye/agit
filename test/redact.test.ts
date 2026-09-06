import { describe, expect, it } from "vitest";
import { redactDeep, redactString, type RedactionCounts } from "../src/redact.js";

function run(s: string): { out: string; counts: RedactionCounts } {
  const counts: RedactionCounts = {};
  return { out: redactString(s, counts), counts };
}

describe("redaction (SPEC §8)", () => {
  it("anthropic key", () => {
    const { out, counts } = run("key=sk-ant-api03-AAAABBBBCCCCDDDD1234 end");
    expect(out).toBe("key=[REDACTED:anthropic-key] end");
    expect(counts["anthropic-key"]).toBe(1);
  });

  it("openai key, without eating anthropic keys first", () => {
    const { out } = run("sk-proj-AAAABBBBCCCCDDDDEEEE1234");
    expect(out).toBe("[REDACTED:openai-key]");
    const both = run("a sk-ant-XXXXYYYYZZZZWWWW1234 b sk-AAAABBBBCCCCDDDDEEEE12 c");
    expect(both.out).toBe("a [REDACTED:anthropic-key] b [REDACTED:openai-key] c");
  });

  it("aws access key id", () => {
    expect(run("AKIAIOSFODNN7EXAMPLE").out).toBe("[REDACTED:aws-access-key-id]");
  });

  it("github tokens, both shapes", () => {
    expect(run("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789").out).toBe("[REDACTED:github-token]");
    expect(run("github_pat_ABCDEFGHIJKLMNOPQRSTUV0123").out).toBe("[REDACTED:github-token]");
  });

  it("slack token", () => {
    expect(run("xoxb-1234567890-abcdef").out).toBe("[REDACTED:slack-token]");
  });

  it("google api key", () => {
    expect(run("AIzaSyA1234567890abcdefghijklmnopqrstuv").out).toBe("[REDACTED:google-api-key]");
  });

  it("private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nxyz\n-----END RSA PRIVATE KEY-----";
    expect(run(`before\n${pem}\nafter`).out).toBe("before\n[REDACTED:private-key]\nafter");
  });

  it("jwt", () => {
    expect(run("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV").out).toBe("[REDACTED:jwt]");
  });

  it("bearer", () => {
    expect(run("Authorization: Bearer abcdefghij0123456789xyz").out).toContain("[REDACTED:bearer]");
  });

  it("assignment keeps the key and separator", () => {
    const { out } = run('password = "hunter2hunter2hunter2"');
    expect(out).toBe('password = "[REDACTED:assignment]"');
  });

  it("does not fire on ordinary code", () => {
    const code = "const skew = 5; // tokens: 123\nfunction api(key: string) { return key; }";
    expect(run(code).out).toBe(code);
  });

  it("redactDeep walks nested payloads and counts", () => {
    const counts: RedactionCounts = {};
    const out = redactDeep(
      { a: ["xoxb-1234567890-abcdef", { b: "AKIAIOSFODNN7EXAMPLE" }], n: 3 },
      counts,
    );
    expect(out).toEqual({ a: ["[REDACTED:slack-token]", { b: "[REDACTED:aws-access-key-id]" }], n: 3 });
    expect(counts).toEqual({ "slack-token": 1, "aws-access-key-id": 1 });
  });
});
