/** Core event types for the agit v2 format. See SPEC.md. */

export const SCHEMA_VERSION = 2;

export const EVENT_TYPES = [
  "session.start",
  "session.end",
  "message.user",
  "message.assistant",
  "tool.call",
  "tool.result",
  "file.diff",
  "file.delete",
  "cost",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** JSON value as it appears in payloads. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface AgitEvent {
  v: number;
  seq: number;
  /** ISO-8601 UTC with milliseconds. */
  ts: string;
  session: string;
  type: EventType;
  payload: { [key: string]: Json };
  /** Hash of the previous event; null iff seq === 0. */
  prev: string | null;
  /** SHA-256 hex of the canonical form of this event minus `hash`. */
  hash: string;
}

/** An event before it has been placed in the chain. */
export type DraftEvent = Omit<AgitEvent, "v" | "seq" | "session" | "prev" | "hash">;

export interface SessionMeta {
  agitSchema: number;
  sessionId: string;
  adapter: { name: string; version: string };
  importedAt: string;
  source: { path: string; sha256: string; bytes: number; records: number };
  skipped: Record<string, number>;
  redactions: Record<string, number>;
  eventCount: number;
  headHash: string;
}

export function isEventType(t: string): t is EventType {
  return (EVENT_TYPES as readonly string[]).includes(t);
}
