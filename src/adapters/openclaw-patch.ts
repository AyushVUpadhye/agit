/**
 * OpenClaw's `apply_patch` text format, parsed and applied the way OpenClaw
 * applies it, so agit can reconstruct exactly the bytes the runtime wrote.
 *
 * The grammar (openclaw/openclaw: docs/tools/apply-patch.md, the parser in
 * src/agents/apply-patch.ts):
 *
 *   *** Begin Patch
 *   *** Add File: <path>          then lines each starting with "+"
 *   *** Delete File: <path>
 *   *** Update File: <path>       optionally "*** Move to: <new path>", then
 *   @@ [context line]             one or more chunks: " " context, "-" old,
 *    context                      "+" new; a bare empty line is empty context;
 *   -old                          "*** End of File" pins the chunk to EOF
 *   +new
 *   *** End Patch
 *
 * Application matches src/agents/apply-patch-update.ts: a chunk's @@ context
 * is located first and must be unique; its old lines are then found from
 * there by tiers of tolerance — exact, trailing-whitespace trimmed, trimmed,
 * then with Unicode dash/quote/space punctuation normalised — the first tier
 * that matches at all decides, and a tier matching more than once is an
 * error. Line endings of untouched and replaced lines are kept, a BOM is
 * kept, and a file with no final newline keeps not having one.
 *
 * Written from the documented grammar and the observed behaviour, not copied.
 * Anything this cannot parse or apply is the caller's cue to skip and count,
 * never to guess.
 */

export class ApplyPatchError extends Error {}

export interface UpdateChunk {
  /** The line named after `@@`, used to position the chunk; must be unique in the file. */
  context?: string;
  oldLines: string[];
  newLines: string[];
  /** For each new line: the index in oldLines it is context for, or undefined for an added line. */
  contextOldIndexes: (number | undefined)[];
  isEndOfFile: boolean;
}

export type PatchHunk =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; movePath?: string; chunks: UpdateChunk[] };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF = "*** End of File";

export function parseApplyPatch(input: string): PatchHunk[] {
  const trimmed = input.trim();
  if (trimmed === "") throw new ApplyPatchError("input is empty");
  let lines = trimmed.split(/\r?\n/);

  if (lines[0]?.trim() !== BEGIN || lines[lines.length - 1]?.trim() !== END) {
    // A heredoc wrapper around an otherwise valid patch is tolerated, as OpenClaw tolerates it.
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (
      lines.length >= 4 &&
      (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
      last !== undefined &&
      last.endsWith("EOF")
    ) {
      lines = lines.slice(1, -1);
    }
    if (lines[0]?.trim() !== BEGIN) throw new ApplyPatchError(`the first line must be '${BEGIN}'`);
    if (lines[lines.length - 1]?.trim() !== END) throw new ApplyPatchError(`the last line must be '${END}'`);
  }

  const body = lines.slice(1, -1);
  const hunks: PatchHunk[] = [];
  let i = 0;
  while (i < body.length) {
    const head = body[i]!.trim();

    if (head.startsWith(ADD)) {
      const path = head.slice(ADD.length);
      let contents = "";
      i++;
      while (i < body.length && body[i]!.startsWith("+")) {
        contents += body[i]!.slice(1) + "\n";
        i++;
      }
      hunks.push({ kind: "add", path, contents });
      continue;
    }

    if (head.startsWith(DELETE)) {
      hunks.push({ kind: "delete", path: head.slice(DELETE.length) });
      i++;
      continue;
    }

    if (head.startsWith(UPDATE)) {
      const path = head.slice(UPDATE.length);
      i++;
      let movePath: string | undefined;
      const next = body[i]?.trim();
      if (next !== undefined && next.startsWith(MOVE)) {
        movePath = next.slice(MOVE.length);
        i++;
      }
      const chunks: UpdateChunk[] = [];
      while (i < body.length) {
        const line = body[i]!;
        if (line.trim() === "") {
          i++;
          continue;
        }
        if (line.startsWith("***")) break;
        const { chunk, consumed } = parseChunk(body, i, chunks.length === 0);
        chunks.push(chunk);
        i += consumed;
      }
      if (chunks.length === 0) throw new ApplyPatchError(`update hunk for '${path}' is empty`);
      hunks.push(
        movePath === undefined
          ? { kind: "update", path, chunks }
          : { kind: "update", path, movePath, chunks },
      );
      continue;
    }

    throw new ApplyPatchError(`'${body[i]}' is not a hunk header`);
  }
  return hunks;
}

function parseChunk(
  lines: string[],
  start: number,
  allowMissingContext: boolean,
): { chunk: UpdateChunk; consumed: number } {
  let i = start;
  let context: string | undefined;
  const first = lines[i]!;
  if (first === "@@") {
    i++;
  } else if (first.startsWith("@@ ")) {
    context = first.slice(3);
    i++;
  } else if (!allowMissingContext) {
    throw new ApplyPatchError(`expected a @@ context marker, got '${first}'`);
  }
  if (i >= lines.length) throw new ApplyPatchError("update hunk does not contain any lines");

  const chunk: UpdateChunk = {
    ...(context === undefined ? {} : { context }),
    oldLines: [],
    newLines: [],
    contextOldIndexes: [],
    isEndOfFile: false,
  };
  let parsed = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === EOF) {
      if (parsed === 0) throw new ApplyPatchError("update hunk does not contain any lines");
      chunk.isEndOfFile = true;
      i++;
      break;
    }
    const marker = line[0];
    if (marker === undefined) {
      chunk.contextOldIndexes.push(chunk.oldLines.length);
      chunk.oldLines.push("");
      chunk.newLines.push("");
    } else if (marker === " ") {
      chunk.contextOldIndexes.push(chunk.oldLines.length);
      chunk.oldLines.push(line.slice(1));
      chunk.newLines.push(line.slice(1));
    } else if (marker === "+") {
      chunk.contextOldIndexes.push(undefined);
      chunk.newLines.push(line.slice(1));
    } else if (marker === "-") {
      chunk.oldLines.push(line.slice(1));
    } else {
      if (parsed === 0) throw new ApplyPatchError(`unexpected line in update hunk: '${line}'`);
      break;
    }
    parsed++;
    i++;
  }
  return { chunk, consumed: i - start };
}

// ───────────────────────────── application ─────────────────────────────

type Ending = "\r\n" | "\r" | "\n" | "";
interface SourceLine {
  text: string;
  ending: Ending;
}
interface Source {
  bom: string;
  lines: SourceLine[];
  preferredEnding: Exclude<Ending, "">;
}
type Replacement = { at: number; oldCount: number; lines: SourceLine[] };

const DASHES = /[\u2010-\u2015\u2212]/g;
const SINGLE_QUOTES = /[\u2018-\u201B]/g;
const DOUBLE_QUOTES = /[\u201C-\u201F]/g;
const SPACES = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;

function normalizePunctuation(s: string): string {
  return s.replace(DASHES, "-").replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(SPACES, " ");
}

const TIERS: ((s: string) => string)[] = [
  (s) => s,
  (s) => s.trimEnd(),
  (s) => s.trim(),
  (s) => normalizePunctuation(s.trim()),
];

type Seek =
  { kind: "found"; index: number } | { kind: "ambiguous"; occurrences: number } | { kind: "missing" };

/** Find `pattern` in `lines` at or after `start`; with `eof`, only at the very end. */
function seek(lines: string[], pattern: string[], start: number, eof: boolean): Seek {
  if (pattern.length === 0) return { kind: "found", index: start };
  if (pattern.length > lines.length) return { kind: "missing" };
  const maxStart = lines.length - pattern.length;
  const from = eof ? Math.max(start, maxStart) : start;
  if (from > maxStart) return { kind: "missing" };
  for (const norm of TIERS) {
    let index: number | null = null;
    let occurrences = 0;
    for (let i = from; i <= maxStart; i++) {
      let ok = true;
      for (let k = 0; k < pattern.length; k++) {
        if (norm(lines[i + k]!) !== norm(pattern[k]!)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        index ??= i;
        occurrences++;
      }
    }
    if (index !== null)
      return occurrences === 1 ? { kind: "found", index } : { kind: "ambiguous", occurrences };
  }
  return { kind: "missing" };
}

function parseSource(contents: string): Source {
  const bom = contents.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? contents.slice(1) : contents;
  const raw = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+/g) ?? [];
  const lines = raw.map((l): SourceLine => {
    if (l.endsWith("\r\n")) return { text: l.slice(0, -2), ending: "\r\n" };
    if (l.endsWith("\r")) return { text: l.slice(0, -1), ending: "\r" };
    if (l.endsWith("\n")) return { text: l.slice(0, -1), ending: "\n" };
    return { text: l, ending: "" };
  });
  const preferredEnding = (lines.find((l) => l.ending !== "")?.ending || "\n") as Exclude<Ending, "">;
  return { bom, lines, preferredEnding };
}

/** New lines for a replaced span, keeping the endings the span had where that is meaningful. */
function changedLines(source: Source, at: number, oldCount: number, newLines: string[]): SourceLine[] {
  const replaced = source.lines.slice(at, at + oldCount);
  const nearby: Ending =
    replaced.find((l) => l.ending !== "")?.ending ||
    source.lines[at]?.ending ||
    source.lines[at - 1]?.ending ||
    source.preferredEnding;
  return newLines.map((text, index) => {
    let ending: Ending = nearby;
    if (replaced.length === newLines.length) ending = replaced[index]?.ending ?? nearby;
    else if (index === newLines.length - 1 && replaced.length > 0)
      ending = replaced[replaced.length - 1]?.ending ?? nearby;
    else if (index < replaced.length - 1) ending = replaced[index]?.ending ?? nearby;
    return { text, ending };
  });
}

/** The chunk's new lines with matched context lines reused verbatim, so tolerant matching never rewrites untouched bytes. */
function chunkLines(
  source: Source,
  match: number,
  pattern: string[],
  newSlice: string[],
  contextOldIndexes: (number | undefined)[],
): SourceLine[] {
  const out: SourceLine[] = [];
  let oldStart = 0;
  let newStart = 0;
  contextOldIndexes.forEach((oldIdx, newIdx) => {
    if (oldIdx === undefined || oldIdx >= pattern.length || newIdx >= newSlice.length) return;
    out.push(...changedLines(source, match + oldStart, oldIdx - oldStart, newSlice.slice(newStart, newIdx)));
    out.push(source.lines[match + oldIdx]!);
    oldStart = oldIdx + 1;
    newStart = newIdx + 1;
  });
  out.push(...changedLines(source, match + oldStart, pattern.length - oldStart, newSlice.slice(newStart)));
  return out;
}

/** Apply an update's chunks to a file's contents; throws when a chunk cannot be placed unambiguously. */
export function applyUpdate(original: string, chunks: UpdateChunk[]): string {
  const source = parseSource(original);
  const texts = source.lines.map((l) => l.text);
  const missingFinalEnding = source.lines.length > 0 && source.lines[source.lines.length - 1]!.ending === "";
  const replacements: Replacement[] = [];
  let cursor = 0;

  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const found = seek(texts, [chunk.context], cursor, false);
      if (found.kind === "ambiguous")
        throw new ApplyPatchError(`context '${chunk.context}' occurs ${found.occurrences} times`);
      if (found.kind === "missing") throw new ApplyPatchError(`context '${chunk.context}' not found`);
      cursor = found.index + 1;
    }

    if (chunk.oldLines.length === 0) {
      const at = chunk.context !== undefined && !chunk.isEndOfFile ? cursor : source.lines.length;
      const inserted = changedLines(source, at, 0, chunk.newLines);
      const last = inserted[inserted.length - 1];
      if (missingFinalEnding && at === source.lines.length && last) last.ending = "";
      replacements.push({ at, oldCount: 0, lines: inserted });
      cursor = at;
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seek(texts, pattern, cursor, chunk.isEndOfFile);
    if (found.kind === "missing" && pattern[pattern.length - 1] === "") {
      // A trailing blank in the hunk may be an EOF sentinel rather than a real line.
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1);
      found = seek(texts, pattern, cursor, chunk.isEndOfFile);
    }
    if (found.kind === "ambiguous")
      throw new ApplyPatchError(`the hunk's lines occur ${found.occurrences} times`);
    if (found.kind === "missing") throw new ApplyPatchError("the hunk's lines were not found");
    replacements.push({
      at: found.index,
      oldCount: pattern.length,
      lines: chunkLines(source, found.index, pattern, newSlice, chunk.contextOldIndexes),
    });
    cursor = found.index + pattern.length;
  }

  const result = [...source.lines];
  for (const r of [...replacements].sort((a, b) => b.at - a.at)) result.splice(r.at, r.oldCount, ...r.lines);
  for (const line of result.slice(0, -1)) if (line.ending === "") line.ending = source.preferredEnding;
  return source.bom + result.map((l) => l.text + l.ending).join("");
}
