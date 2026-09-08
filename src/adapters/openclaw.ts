import type { DraftEvent, Json } from "../format/events.js";
import type { Adapter, ConvertOptions, ConvertResult } from "./adapter.js";

const ADAPTER_NAME = "openclaw";
const ADAPTER_VERSION = "1";

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

function usagePayload(message: RecordValue): { [key: string]: Json } | undefined {
  const usage = asRecord(message.usage);
  const cost = asRecord(usage?.cost);
  if (!usage || !cost) return undefined;

  return {
    ...(typeof message.model === "string" ? { model: message.model } : {}),
    ...(typeof message.provider === "string" ? { provider: message.provider } : {}),
    usage: {
      inputTokens: usage.input as Json,
      outputTokens: usage.output as Json,
      cacheReadInputTokens: usage.cacheRead as Json,
      cacheCreationInputTokens: usage.cacheWrite as Json,
    },
    cost: cost.total as Json,
  };
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

      if (role === "user") {
        const text = textContent(message.content);
        if (!text) {
          skip("message:user(empty)");
          continue;
        }

        drafts.push({
          ts,
          type: "message.user",
          payload: { text },
        });
        continue;
      }

      if (role === "assistant") {
        const content = Array.isArray(message.content) ? message.content : [];

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

            drafts.push({
              ts,
              type: "message.assistant",
              payload: {
                text,
                ...(part.type === "thinking" ? { thinking: true } : {}),
                ...(typeof message.model === "string" ? { model: message.model } : {}),
              },
            });
            continue;
          }

          if (part.type === "toolCall") {
            if (typeof part.id !== "string" || typeof part.name !== "string") {
              skip("toolCall:malformed");
              continue;
            }

            drafts.push({
              ts,
              type: "tool.call",
              payload: {
                toolUseId: part.id,
                name: part.name,
                input: (asRecord(part.arguments) ?? {}) as Json,
              },
            });
            continue;
          }

          skip(`assistant:content:${String(part.type ?? "unknown")}`);
        }

        const usage = usagePayload(message);
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
          },
        });
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
      nativeSessionId: sessionId,
      adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
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
