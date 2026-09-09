import { describe, expect, it } from "vitest";
import {
  ApplyPatchError,
  applyUpdate,
  parseApplyPatch,
  type UpdateChunk,
} from "../src/adapters/openclaw-patch.js";

const P = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`;

describe("parseApplyPatch — OpenClaw's patch grammar", () => {
  it("parses add, delete and update hunks in order", () => {
    const hunks = parseApplyPatch(
      P(
        "*** Add File: a.py\n+a = 1\n+b = 2\n*** Delete File: old.py\n*** Update File: c.py\n@@ def f():\n-    return 1\n+    return 2",
      ),
    );
    expect(hunks).toEqual([
      { kind: "add", path: "a.py", contents: "a = 1\nb = 2\n" },
      { kind: "delete", path: "old.py" },
      {
        kind: "update",
        path: "c.py",
        chunks: [
          {
            context: "def f():",
            oldLines: ["    return 1"],
            newLines: ["    return 2"],
            contextOldIndexes: [undefined],
            isEndOfFile: false,
          },
        ],
      },
    ]);
  });

  it("reads Move to, bare @@, empty context lines and End of File", () => {
    const [h] = parseApplyPatch(
      P("*** Update File: a.md\n*** Move to: docs/a.md\n@@\n # a\n\n+- new\n*** End of File"),
    );
    expect(h).toMatchObject({ kind: "update", path: "a.md", movePath: "docs/a.md" });
    const chunk = (h as { chunks: UpdateChunk[] }).chunks[0]!;
    expect(chunk.context).toBeUndefined();
    expect(chunk.oldLines).toEqual(["# a", ""]);
    expect(chunk.newLines).toEqual(["# a", "", "- new"]);
    expect(chunk.contextOldIndexes).toEqual([0, 1, undefined]);
    expect(chunk.isEndOfFile).toBe(true);
  });

  it("allows the first chunk without a @@ marker, but not later ones", () => {
    expect(parseApplyPatch(P("*** Update File: a\n-x\n+y"))).toHaveLength(1);
    expect(() => parseApplyPatch(P("*** Update File: a\n-x\n+y\n\nzzz"))).toThrow(ApplyPatchError);
  });

  it("tolerates a heredoc wrapper, as the runtime does", () => {
    const wrapped = `<<'EOF'\n*** Begin Patch\n*** Add File: a\n+1\n*** End Patch\nEOF`;
    expect(parseApplyPatch(wrapped)).toEqual([{ kind: "add", path: "a", contents: "1\n" }]);
  });

  it("refuses what is not a patch", () => {
    expect(() => parseApplyPatch("")).toThrow(ApplyPatchError);
    expect(() => parseApplyPatch("hello")).toThrow(/first line/);
    expect(() => parseApplyPatch("*** Begin Patch\n*** Add File: a\n+1")).toThrow(/last line/);
    expect(() => parseApplyPatch(P("*** Frobnicate: a"))).toThrow(/not a hunk header/);
    expect(() => parseApplyPatch(P("*** Update File: a"))).toThrow(/empty/);
  });
});

const update = (text: string): UpdateChunk[] => {
  const [h] = parseApplyPatch(P(`*** Update File: f\n${text}`));
  return (h as { chunks: UpdateChunk[] }).chunks;
};

describe("applyUpdate — the bytes OpenClaw would have written", () => {
  it("replaces old lines with new ones, positioned by context", () => {
    const out = applyUpdate("a\nb\nc\nb\n", update("@@ c\n-b\n+B"));
    expect(out).toBe("a\nb\nc\nB\n");
  });

  it("appends at End of File and keeps a missing final newline missing", () => {
    expect(applyUpdate("a\nb\n", update("@@\n+c\n*** End of File"))).toBe("a\nb\nc\n");
    expect(applyUpdate("a\nb", update("@@\n+c\n*** End of File"))).toBe("a\nb\nc");
  });

  it("keeps CRLF endings and a BOM untouched", () => {
    const out = applyUpdate("﻿a\r\nb\r\nc\r\n", update("@@\n-b\n+B"));
    expect(out).toBe("﻿a\r\nB\r\nc\r\n");
  });

  it("matches through trailing whitespace and punctuation only when exact matching fails", () => {
    expect(applyUpdate("x = 'a'  \ny\n", update("@@\n-x = 'a'\n+x = 'b'"))).toBe("x = 'b'\ny\n");
    expect(applyUpdate("say “hi”\n", update('@@\n-say "hi"\n+say "yo"'))).toBe('say "yo"\n');
  });

  it("refuses an ambiguous match rather than picking one", () => {
    expect(() => applyUpdate("b\nb\n", update("@@\n-b\n+B"))).toThrow(/occur/);
    expect(() => applyUpdate("a\nb\n", update("@@\n-zzz\n+B"))).toThrow(/not found/);
    expect(() => applyUpdate("k\nk\nv\n", update("@@ k\n-v\n+V"))).toThrow(/context/);
  });

  it("keeps matched context bytes verbatim even when the match was tolerant", () => {
    // The context line in the file has trailing spaces the patch does not; those bytes survive.
    const out = applyUpdate("keep   \nold\n", update("@@\n keep\n-old\n+new"));
    expect(out).toBe("keep   \nnew\n");
  });

  it("applies several chunks in order without letting one shift another", () => {
    const out = applyUpdate("1\n2\n3\n4\n5\n", update("@@\n-2\n+two\n@@\n-4\n+four"));
    expect(out).toBe("1\ntwo\n3\nfour\n5\n");
  });
});
