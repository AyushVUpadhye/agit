import type { DraftEvent } from "../format/events.js";

/** What an adapter produces from one native session log. Payloads are not yet redacted or chained — the import pipeline does both. */
export interface ConvertResult {
  sessionId: string;
  drafts: DraftEvent[];
  /** Native record count (non-empty lines). */
  records: number;
  /** Native record types (or markers like "<unparseable>") that were skipped, with counts. Skip and log, never guess. */
  skipped: Record<string, number>;
}

export interface Adapter {
  name: string;
  version: string;
  /** Cheap sniff: could these lines be this runtime's native log? */
  detect(lines: string[]): boolean;
  convert(lines: string[]): ConvertResult;
}
