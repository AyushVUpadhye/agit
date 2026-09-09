/**
 * Adapter for OpenClaw session transcripts (JSONL, one entry per line).
 *
 * Mapping rules follow SPEC.md section 6: linearize in native file order,
 * preserve native ids under payload.native, skip and count what cannot be
 * mapped, never guess.
 *
 * Derived from OpenClaw'''s own type definitions rather than from a captured
 * log, and each shape below was checked against them:
 *   - the header entry, src/config/sessions/transcript-header.ts:
 *       { type: "session", version, id, timestamp, cwd, parentSession? }
 *   - the message entry, src/agents/sessions/session-manager-types.ts:
 *       SessionMessageEntry { type: "message", id, parentId, timestamp, message }
 *   - roles user | assistant | toolResult, content parts text | thinking |
 *     toolCall, and Usage { input, output, cacheRead, cacheWrite, cost },
 *     packages/llm-core/src/types.ts
 *
 * Structured apply_patch calls can emit file.diff when the full file state
 * can be established from earlier edits in the same session. Updates whose
 * base content is unknown are skipped rather than guessed.
 */
import { createHash } from "node:crypto";
import { applyUnifiedDiff } from "../patch.js";
import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

const ADAPTER_NAME = "openclaw";
const ADAPTER_VERSION = "0.2.0";

type RecordValue = { [key: string]: Json };

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is RecordValue => Boolean(asRecord(part)))
    .filter((part) => part.type === "text" || part.type === "thinking")
    .map((part) => String(part.text ?? part.thinking ?? ""))
    .filter(Boolean)
    .join("\n");
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  for (const partValue of content) {
    const part = asRecord(partValue);
    if (!part) continue;

    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
  }

  return "";
}

/**
 * A cost event in the shape the other adapters emit: model, four token
 * counts, and everything runtime-specific under native. Token fields are
 * coerced to numbers so a field missing from one record cannot make two
 * imports of the same log differ (SPEC §7).
 *
 * OpenClaw's Usage carries `cost` as well, and it is kept — under native,
 * because SPEC's cost payload counts tokens and says nothing about money.
 */
function usagePayload(message: RecordValue, native: Json): { [key: string]: Json } | undefined {
  const usage = asRecord(message.usage);
  if (!usage) return undefined;
  const cost = asRecord(usage.cost);

  const nativeRecord = asRecord(native) ?? {};
  return {
    model: typeof message.model === "string" ? message.model : null,
    usage: {
      inputTokens: num(usage.input),
      outputTokens: num(usage.output),
      cacheReadInputTokens: num(usage.cacheRead),
      cacheCreationInputTokens: num(usage.cacheWrite),
    },
    native: {
      ...nativeRecord,
      ...(typeof message.provider === "string" ? { provider: message.provider } : {}),
      ...(cost && typeof cost.total === "number" ? { costUsd: cost.total } : {}),
    },
  };
}

function sha256Utf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function fileDiffPayload(
  path: string,
  before: string | null,
  after: string,
  diff: string,
  toolUseId: string,
): { [key: string]: Json } {
  return {
    path,
    kind: before === null ? "create" : "modify",
    diff,
    beforeHash: before === null ? null : sha256Utf8(before),
    afterHash: sha256Utf8(after),
    toolUseId,
    source: "apply_patch",
  };
}

type PendingPatch = {
  ts: string;
  toolUseId: string;
  changes: Json;
};

function emitOpenClawFileDiffs(
  pending: PendingPatch,
  result: RecordValue,
  body: DraftEvent[],
  known: Map<string, string>,
  skip: (reason: string) => void,
): void {
  if (result.isError === true) {
    skip("apply_patch:error");
    return;
  }

  const resultText = toolResultText(result.content);
  let resultObject: RecordValue | undefined;

  try {
    resultObject = asRecord(JSON.parse(resultText));
  } catch {
    skip("apply_patch:malformed-result");
    return;
  }

  if (!resultObject) {
    skip("apply_patch:malformed-result");
    return;
  }

  if (resultObject.status !== "completed") {
    skip(`apply_patch:${String(resultObject.status ?? "not completed")}`);
    return;
  }

  if (!Array.isArray(pending.changes)) {
    skip("apply_patch:no changes");
    return;
  }

  for (const changeValue of pending.changes) {
    const change = asRecord(changeValue);

    if (!change) {
      skip("apply_patch:malformed change");
      continue;
    }

    const path = typeof change.path === "string" ? change.path : "";
    const kindRecord = asRecord(change.kind);
    const kind =
      kindRecord && typeof kindRecord.type === "string"
        ? kindRecord.type
        : "";

    if (!path || !kind) {
      skip("apply_patch:malformed change");
      continue;
    }

    const diff = typeof change.diff === "string" ? change.diff : "";

    if (kind === "add") {
      if (!diff) {
        skip("apply_patch:add(no content)");
        continue;
      }

      body.push({
        ts: pending.ts,
        type: "file.diff",
        payload: fileDiffPayload(
          path,
          null,
          diff,
          synthesizeCreateDiff(path, diff),
          pending.toolUseId,
        ),
      });

      known.set(path, diff);
      continue;
    }

    if (kind === "update") {
      if (!diff) {
        skip("apply_patch:update(no diff)");
        continue;
      }

      const movePath = kindRecord?.move_path;
      if (typeof movePath === "string" && movePath !== "") {
        skip("apply_patch:update(rename)");
        continue;
      }

      const before = known.get(path);

      if (before === undefined) {
        skip("apply_patch:update(base content not in log)");
        continue;
      }

      let after: string;

      try {
        after = applyUnifiedDiff(before, diff);
      } catch {
        skip("apply_patch:update(diff did not apply)");
        continue;
      }

      body.push({
        ts: pending.ts,
        type: "file.diff",
        payload: fileDiffPayload(
          path,
          before,
          after,
          diff,
          pending.toolUseId,
        ),
      });

      known.set(path, after);
      continue;
    }

    if (kind === "delete") {
      known.delete(path);
      skip("apply_patch:delete(no deletion event in SPEC)");
      continue;
    }

    skip(`apply_patch:${kind}`);
  }
}

function synthesizeCreateDiff(path: string, content: string): string {
  const lines = content.endsWith("\n")
    ? content.slice(0, -1).split("\n")
    : content.split("\n");

  return (
    `--- /dev/null\n+++ b/${path}\n` +
    `@@ -0,0 +1,${lines.length} @@\n` +
    lines.map((line) => `+${line}`).join("\n") +
    "\n"
  );
}

export const openclawAdapter: Adapter = {
  name: ADAPTER_NAME,
  version: ADAPTER_VERSION,

  detect(lines: string[]): boolean {
    for (const line of lines.slice(0, 25)) {
      try {
        const record = asRecord(JSON.parse(line));
        if (record?.type === "session" && typeof record.id === "string") {
          return true;
        }
      } catch {
        // Ignore malformed/unrelated leading records.
      }
    }
    return false;
  },

  convert(lines: string[], opts?: ConvertOptions): ConvertResult {
    const drafts: DraftEvent[] = [];
    const skipped: Record<string, number> = {};

    let records = 0;
    let sessionId = "";
    let firstTs = "";
    let lastTs = "";
    let cwd: string | undefined;
    let sessionFormatVersion: Json = null;
    const known = new Map<string, string>();
    const pendingPatches = new Map<string, PendingPatch>();

    const skip = (reason: string) => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    };

    for (const line of lines) {
      if (!line.trim()) continue;

      records++;

      let record: RecordValue | undefined;
      try {
        record = asRecord(JSON.parse(line));
      } catch {
        skip("invalid-json");
        continue;
      }

      if (!record) {
        skip("non-object");
        continue;
      }

      const ts = typeof record.timestamp === "string" ? record.timestamp : "";
      if (ts) {
        if (!firstTs) firstTs = ts;
        lastTs = ts;
      }

      if (record.type === "session") {
        if (!sessionId && typeof record.id === "string") {
          sessionId = record.id;
          cwd = typeof record.cwd === "string" ? record.cwd : undefined;
          sessionFormatVersion = typeof record.version === "number" ? record.version : null;
        }
        continue;
      }

      if (record.type !== "message") {
        skip(`type:${String(record.type ?? "unknown")}`);
        continue;
      }

      const message = asRecord(record.message);
      if (!message || typeof message.role !== "string") {
        skip("message:malformed");
        continue;
      }

      const role = message.role;
      // SPEC §6: keep the runtime's own ids, so the transcript DAG survives
      // the mapping and events can be traced back to their source records.
      const native: Json = {
        id: typeof record.id === "string" ? record.id : null,
        parentId: typeof record.parentId === "string" ? record.parentId : null,
      };

      if (role === "user") {
        const text = textContent(message.content);
        if (!text) {
          skip("message:user(empty)");
          continue;
        }

        drafts.push({
          ts,
          type: "message.user",
          payload: { text, native },
        });
        continue;
      }

      if (role === "assistant") {
        const content = Array.isArray(message.content) ? message.content : [];
        // One native message becomes one message.assistant carrying its
        // blocks, plus a tool.call per call — the same shape the Claude Code
        // and Codex adapters emit. Every view reads `blocks`, so a payload
        // without it renders as an empty assistant turn.
        const blocks: Json[] = [];
        const toolCalls: DraftEvent[] = [];

        for (const partValue of content) {
          const part = asRecord(partValue);
          if (!part) {
            skip("assistant:malformed-content");
            continue;
          }

          if (part.type === "text" || part.type === "thinking") {
            const text = String(part.text ?? part.thinking ?? "");
            if (!text) {
              skip(`assistant:${String(part.type)}(empty)`);
              continue;
            }
            blocks.push({ type: part.type === "thinking" ? "thinking" : "text", text });
            continue;
          }

          if (part.type === "toolCall") {
            if (typeof part.id !== "string" || typeof part.name !== "string") {
              skip("toolCall:malformed");
              continue;
            }

            const input = (asRecord(part.arguments) ?? {}) as Json;

            toolCalls.push({
              ts,
              type: "tool.call",
              payload: {
                toolUseId: part.id,
                name: part.name,
                input,
                native,
              },
            });

            if (part.name === "apply_patch") {
              const inputRecord = asRecord(input);

              pendingPatches.set(part.id, {
                ts,
                toolUseId: part.id,
                changes: inputRecord?.changes ?? null,
              });
            }

            continue;
          }

          skip(`assistant:content:${String(part.type ?? "unknown")}`);
        }

        if (blocks.length > 0) {
          drafts.push({
            ts,
            type: "message.assistant",
            payload: {
              model: typeof message.model === "string" ? message.model : null,
              blocks,
              stopReason: typeof message.stopReason === "string" ? message.stopReason : null,
              native,
            },
          });
        }
        drafts.push(...toolCalls);

        const usage = usagePayload(message, native);
        if (usage) {
          drafts.push({
            ts,
            type: "cost",
            payload: usage,
          });
        }

        continue;
      }

      if (role === "toolResult") {
        if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string") {
          skip("toolResult:malformed");
          continue;
        }

        drafts.push({
          ts,
          type: "tool.result",
          payload: {
            toolUseId: message.toolCallId,
            name: message.toolName,
            output: textContent(message.content),
            isError: message.isError === true,
            native,
          },
        });

        if (message.toolName === "apply_patch") {
          const pending = pendingPatches.get(message.toolCallId);

          if (pending) {
            emitOpenClawFileDiffs(
              pending,
              message,
              drafts,
              known,
              skip,
            );
            pendingPatches.delete(message.toolCallId);
          } else {
            skip("apply_patch:missing-call");
          }
        }

        continue;
      }

      skip(`message:${role}`);
    }

    if (!sessionId) {
      throw new Error("OpenClaw transcript has no session header");
    }

    if (!firstTs) firstTs = new Date(0).toISOString();
    if (!lastTs) lastTs = firstTs;

    const startPayload: { [key: string]: Json } = {
      runtime: "openclaw",
      // The header carries a session-format version, not an OpenClaw
      // version, so it goes under native rather than being passed off as one.
      runtimeVersion: null,
      nativeSessionId: sessionId,
      gitBranch: null,
      adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
      native: { sessionFormatVersion: sessionFormatVersion },
    };

    if (cwd !== undefined) startPayload.cwd = cwd;

    drafts.unshift({
      ts: firstTs,
      type: "session.start",
      payload: startPayload,
    });

    if (!opts?.live) {
      drafts.push({
        ts: lastTs,
        type: "session.end",
        payload: { reason: "log-end", synthesized: true },
      });
    }

    return { sessionId, drafts, records, skipped };
  },
};
