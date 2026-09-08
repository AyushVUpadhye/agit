import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { openclawAdapter } from "../src/adapters/openclaw.js";
import type { DraftEvent, Json } from "../src/format/events.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const openclawLines = readFileSync(join(ROOT, "fixtures", "openclaw", "simple.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");

const payloadOf = (drafts: DraftEvent[], i: number): { [k: string]: Json } =>
  drafts[i]!.payload as { [k: string]: Json };

describe("openclaw adapter", () => {
  it("detects OpenClaw transcripts and does not claim Claude/Codex files", () => {
    expect(openclawAdapter.detect(openclawLines)).toBe(true);
    expect(openclawAdapter.detect(["not json", "{}"])).toBe(false);
    expect(claudeCodeAdapter.detect(openclawLines)).toBe(false);
    expect(codexAdapter.detect(openclawLines)).toBe(false);
  });

  it("maps the fixture to the expected event sequence", () => {
    const res = openclawAdapter.convert(openclawLines);

    expect(res.sessionId).toBe("0199openclaw-aaaa-7bbb-8ccc-ddddeeee0001");
    expect(res.records).toBe(6);
    expect(res.drafts.map((d) => d.type)).toEqual([
      "session.start",
      "message.user",
      "message.assistant",
      "cost",
      "tool.call",
      "tool.result",
      "message.assistant",
      "cost",
      "session.end",
    ]);
  });

  it("maps session metadata", () => {
    const res = openclawAdapter.convert(openclawLines);
    const start = payloadOf(res.drafts, 0);

    expect(start.runtime).toBe("openclaw");
    expect(start.nativeSessionId).toBe("0199openclaw-aaaa-7bbb-8ccc-ddddeeee0001");
    expect(start.cwd).toBe("/workspace/demo");
    expect(start.adapter).toEqual({
      name: "openclaw",
      version: "1",
    });
  });

  it("maps assistant text and tool calls", () => {
    const res = openclawAdapter.convert(openclawLines);

    const assistant = res.drafts.filter((d) => d.type === "message.assistant");
    expect(assistant).toHaveLength(2);
    expect(payloadOf(res.drafts, 2).text).toBe("I'll check the project status.");
    expect(payloadOf(res.drafts, 2).model).toBe("gpt-5.5");

    const call = res.drafts.find((d) => d.type === "tool.call")!;
    expect(payloadOf(res.drafts, res.drafts.indexOf(call))).toEqual({
      toolUseId: "functions.exec:1",
      name: "exec",
      input: { command: "git status --short" },
    });
  });

  it("maps tool results and costs", () => {
    const res = openclawAdapter.convert(openclawLines);

    const result = res.drafts.find((d) => d.type === "tool.result")!;
    const resultPayload = payloadOf(res.drafts, res.drafts.indexOf(result));

    expect(resultPayload).toEqual({
      toolUseId: "functions.exec:1",
      name: "exec",
      output: " M src/adapters/openclaw.ts",
      isError: false,
    });

    const costs = res.drafts.filter((d) => d.type === "cost");
    expect(costs).toHaveLength(2);

    expect(payloadOf(res.drafts, res.drafts.indexOf(costs[0]!))).toEqual({
      model: "gpt-5.5",
      provider: "openai",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 0,
      },
      cost: 0.0031,
    });
  });

  it("does not synthesize session.end in live mode", () => {
    const res = openclawAdapter.convert(openclawLines, { live: true });

    expect(res.drafts.at(-1)?.type).toBe("cost");
    expect(res.drafts.some((d) => d.type === "session.end")).toBe(false);
  });

  it("skips unsupported transcript record types", () => {
    const lines = [
      openclawLines[0]!,
      JSON.stringify({
        type: "compaction",
        id: "compact-1",
        parentId: null,
        timestamp: "2026-09-08T10:01:00.000Z",
        message: "summary",
      }),
      JSON.stringify({
        type: "custom",
        id: "custom-1",
        timestamp: "2026-09-08T10:01:01.000Z",
      }),
    ];

    const res = openclawAdapter.convert(lines);

    expect(res.skipped).toEqual({
      "type:compaction": 1,
      "type:custom": 1,
    });
  });

  it("skips unknown message roles instead of guessing", () => {
    const lines = [
      openclawLines[0]!,
      JSON.stringify({
        type: "message",
        id: "msg-unknown",
        timestamp: "2026-09-08T10:01:00.000Z",
        message: {
          role: "system",
          content: [{ type: "text", text: "system message" }],
        },
      }),
    ];

    const res = openclawAdapter.convert(lines);

    expect(res.skipped).toEqual({
      "message:system": 1,
    });
    expect(res.drafts.map((d) => d.type)).toEqual(["session.start", "session.end"]);
  });
});
