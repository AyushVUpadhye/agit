import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { SCHEMA_VERSION, type AgitEvent, type DraftEvent } from "./events.js";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SPEC.md §4: hash over the canonical form of the event minus `hash`. */
export function eventHash(event: Omit<AgitEvent, "hash">): string {
  const { v, seq, ts, session, type, payload, prev } = event;
  return sha256Hex(Buffer.from(canonicalJson({ v, seq, ts, session, type, payload, prev }), "utf8"));
}

/**
 * Chain a sequence of draft events into full events, assigning seq/prev/hash.
 * `from` continues an existing chain (live streaming): seq starts at
 * from.seq and the first event links to from.prev.
 */
export function buildChain(
  session: string,
  drafts: DraftEvent[],
  from: { seq: number; prev: string | null } = { seq: 0, prev: null },
): AgitEvent[] {
  const events: AgitEvent[] = [];
  let prev = from.prev;
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]!;
    const partial: Omit<AgitEvent, "hash"> = {
      v: SCHEMA_VERSION,
      seq: from.seq + i,
      ts: d.ts,
      session,
      type: d.type,
      payload: d.payload,
      prev,
    };
    const hash = eventHash(partial);
    events.push({ ...partial, hash });
    prev = hash;
  }
  return events;
}

/** Serialize events to JSONL. Key order in the file is the envelope order from SPEC §2. */
export function toJsonl(events: AgitEvent[]): string {
  return events
    .map((e) =>
      JSON.stringify({
        v: e.v,
        seq: e.seq,
        ts: e.ts,
        session: e.session,
        type: e.type,
        payload: e.payload,
        prev: e.prev,
        hash: e.hash,
      }),
    )
    .join("\n") + (events.length > 0 ? "\n" : "");
}
