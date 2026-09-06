/**
 * Canonical JSON serialization for hashing (SPEC.md §3).
 *
 * RFC 8785 (JCS) restricted to what agit events contain: object keys sorted
 * by UTF-16 code unit, no insignificant whitespace, ECMAScript string and
 * number serialization. Implemented as a recursive key-sort followed by
 * JSON.stringify, which matches those rules in Node.
 */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("canonical form cannot contain NaN or infinities");
    }
    if (value === undefined) {
      throw new Error("canonical form cannot contain undefined");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  const out: Record<string, unknown> = {};
  // Default sort() compares by UTF-16 code unit — exactly the SPEC ordering.
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue; // JSON.stringify would drop it; be explicit.
    out[key] = sortKeysDeep(v);
  }
  return out;
}
