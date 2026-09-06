import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildChain, sha256Hex } from "../src/format/hash.js";
import type { AgitEvent } from "../src/format/events.js";
import { reconstructTree, treeRelativePath, writeFork } from "../src/fork.js";
import { applyUnifiedDiff, PatchError } from "../src/patch.js";
import { redactDeep, type RedactionCounts } from "../src/redact.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function load(fixture: string): AgitEvent[] {
  const lines = readFileSync(join(ROOT, "fixtures", "claude-code", fixture), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const converted = claudeCodeAdapter.convert(lines);
  const counts: RedactionCounts = {};
  for (const d of converted.drafts) d.payload = redactDeep(d.payload, counts);
  return buildChain(converted.sessionId, converted.drafts);
}

const SIMPLE = load("simple.jsonl");
const DEMO = load("demo.jsonl");

describe("applyUnifiedDiff", () => {
  it("applies creates and modifies from real fixture events", () => {
    const create = SIMPLE.find((e) => e.type === "file.diff")!;
    const p = create.payload as { diff: string; afterHash: string };
    const made = applyUnifiedDiff(null, p.diff);
    expect(sha256Hex(made)).toBe(p.afterHash);
  });

  it("throws on context mismatch instead of fuzzy-matching", () => {
    const modify = SIMPLE.filter((e) => e.type === "file.diff")[1]!;
    const p = modify.payload as { diff: string };
    expect(() => applyUnifiedDiff("totally different\ncontent\n", p.diff)).toThrow(PatchError);
  });
});

describe("reconstructTree", () => {
  it("replays the simple session to its exact final content, hash-verified", () => {
    const { files, skipped } = reconstructTree(SIMPLE, SIMPLE.length - 1);
    expect(skipped).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("C:\\proj\\hello.ts");
    expect(files[0]!.content).toBe(
      "export function hello(name: string): string {\n  return `Hello, ${name}!!`;\n}\n",
    );
  });

  it("time-travels: state at an earlier event is the earlier content", () => {
    const firstDiff = SIMPLE.find((e) => e.type === "file.diff")!;
    const { files } = reconstructTree(SIMPLE, firstDiff.seq);
    expect(files[0]!.content).toContain("Hello, ${name}!`");
    expect(files[0]!.content).not.toContain("!!");
  });

  it("recovers a diverged file from runtime-recorded originalFile, still verified", () => {
    // demo.jsonl: ratelimit.ts is created, then modified by sed (invisible),
    // then Edited — the Edit's beforeHash contradicts our chain, but its
    // tool.result carries originalFile, so reconstruction recovers.
    const { files, skipped } = reconstructTree(DEMO, DEMO.length - 1);
    expect(skipped).toEqual([]);
    const rate = files.find((f) => f.path.endsWith("ratelimit.ts"))!;
    expect(rate.recoveredFromOriginalFile).toBe(true);
    expect(rate.content).toContain("LIMIT = 5");
    expect(rate.content).toContain("WINDOW = 30");
    // login.ts pre-existed the session; recovered the same way.
    const login = files.find((f) => f.path.endsWith("login.ts"))!;
    expect(login.recoveredFromOriginalFile).toBe(true);
    expect(login.content).toContain("if (!allow(req.ip)) return tooMany();");
  });

  it("before the divergence, reconstruction uses the clean chain", () => {
    // Event just before the diverging Edit's file.diff (seq 24 in demo).
    const { files } = reconstructTree(DEMO, 23);
    const rate = files.find((f) => f.path.endsWith("ratelimit.ts"))!;
    expect(rate.recoveredFromOriginalFile).toBe(false);
    expect(rate.content).toContain("LIMIT = 10"); // the sed change was never in the log
    expect(rate.content).toContain("WINDOW = 60");
  });
});

describe("treeRelativePath", () => {
  it("re-roots under cwd and sanitizes", () => {
    expect(treeRelativePath("C:\\app\\src\\login.ts", "C:\\app")).toBe("src/login.ts");
    expect(treeRelativePath("/home/u/proj/a.ts", "/home/u/proj")).toBe("a.ts");
    expect(treeRelativePath("D:\\other\\x.ts", "C:\\app")).toBe("D/other/x.ts");
  });

  it("neutralizes traversal from hostile logs", () => {
    // '..' segments are dropped entirely; whatever remains stays inside tree/.
    expect(treeRelativePath("..\\..\\..\\etc\\passwd", null)).toBe("etc/passwd");
    expect(treeRelativePath("C:\\app\\..\\..\\evil.ts", "C:\\app")).toBe("evil.ts");
    expect(treeRelativePath("a\\..\\b\\con<tro>l.ts", null)).toBe("a/b/con_tro_l.ts");
  });
});

describe("writeFork", () => {
  it("writes tree, SEED.md, and fork.json with provenance", () => {
    const out = join(mkdtempSync(join(tmpdir(), "agit-fork-")), "f1");
    const at = DEMO.length - 1;
    const res = writeFork(DEMO, at, "demo-ratelimit-0001", out);

    expect(res.written.map((w) => w.rel).sort()).toEqual(["src/login.ts", "src/ratelimit.ts"]);
    const tree = readFileSync(join(out, "tree", "src", "ratelimit.ts"), "utf8");
    expect(sha256Hex(tree)).toBe(
      (DEMO.filter((e) => e.type === "file.diff").at(-1)!.payload as { afterHash: string }).afterHash,
    );

    const fork = JSON.parse(readFileSync(join(out, "fork.json"), "utf8")) as Record<string, unknown>;
    expect(fork).toMatchObject({
      agitFork: 1,
      sourceSession: "demo-ratelimit-0001",
      atSeq: at,
      atHash: DEMO[at]!.hash,
    });

    const seed = readFileSync(join(out, "SEED.md"), "utf8");
    expect(seed).toContain("Add rate limiting to the login endpoint");
    expect(seed).toContain("[DIVERGED at seq 24]");
    expect(seed).toContain("mechanical summary");
    expect(seed).toContain(DEMO[at]!.hash.slice(0, 12));
    expect(existsSync(join(out, "tree"))).toBe(true);
  });
});
