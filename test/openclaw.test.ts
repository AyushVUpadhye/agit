import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { buildChain } from "../src/format/hash.js";
import { timelineLines } from "../src/state.js";
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
      version: "0.1.0",
    });
  });

  it("maps assistant text and tool calls", () => {
    const res = openclawAdapter.convert(openclawLines);

    const assistant = res.drafts.filter((d) => d.type === "message.assistant");
    expect(assistant).toHaveLength(2);
    // Views read `blocks`; a payload without it renders as an empty turn.
    expect(payloadOf(res.drafts, 2).blocks).toEqual([
      { type: "text", text: "I'll check the project status." },
    ]);
    expect(payloadOf(res.drafts, 2).model).toBe("gpt-5.5");
    expect(payloadOf(res.drafts, 2).native).toEqual({ id: "msg-assistant-1", parentId: "msg-user-1" });

    const call = res.drafts.find((d) => d.type === "tool.call")!;
    expect(payloadOf(res.drafts, res.drafts.indexOf(call))).toEqual({
      toolUseId: "functions.exec:1",
      name: "exec",
      input: { command: "git status --short" },
      native: { id: "msg-assistant-2", parentId: "msg-assistant-1" },
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
      native: { id: "msg-tool-1", parentId: "msg-assistant-2" },
    });

    const costs = res.drafts.filter((d) => d.type === "cost");
    expect(costs).toHaveLength(2);

    // Same shape the other adapters emit: model, four token counts, and
    // everything runtime-specific (provider, money) under native.
    expect(payloadOf(res.drafts, res.drafts.indexOf(costs[0]!))).toEqual({
      model: "gpt-5.5",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 0,
      },
      native: {
        id: "msg-assistant-1",
        parentId: "msg-user-1",
        provider: "openai",
        costUsd: 0.0031,
      },
    });
  });

  it("emits the same payload shape as the other adapters", () => {
    // The bug this guards: an assistant payload without `blocks` imports
    // cleanly and then renders as "[empty]" in replay, show, the share page,
    // fork's SEED.md and the HTML export — the agent's words vanish.
    const claudeLines = readFileSync(join(ROOT, "fixtures", "claude-code", "simple.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const mine = openclawAdapter.convert(openclawLines).drafts;
    const theirs = claudeCodeAdapter.convert(claudeLines).drafts;

    const keysOf = (drafts: DraftEvent[], type: string): string[] => {
      const d = drafts.find((x) => x.type === type);
      return d ? Object.keys(d.payload as Record<string, unknown>).sort() : [];
    };
    for (const type of ["message.user", "message.assistant", "tool.call", "tool.result", "cost"]) {
      expect(keysOf(mine, type), `${type} payload keys`).toEqual(
        expect.arrayContaining(keysOf(theirs, type).filter((k) => k !== "structured")),
      );
    }

    // And the rendered timeline shows the text rather than an empty turn.
    const events = buildChain("oc", mine);
    const assistantLine = timelineLines(events).find((l) => l.includes("assistant"))!;
    expect(assistantLine).toContain("[text]");
    expect(assistantLine).not.toContain("[empty]");
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
