import { describe, expect, it } from "vitest";
import type { AgitEvent } from "../src/format/events.js";
import { renderSessionHtml } from "../src/html.js";

function event(
  seq: number,
  type: AgitEvent["type"],
  payload: AgitEvent["payload"],
): AgitEvent {
  return {
    v: 1,
    seq,
    ts: `2026-01-01T00:00:0${seq}.000Z`,
    session: "test-session",
    type,
    payload,
    prev: seq === 0 ? null : `prev-${seq}`,
    hash: `hash-${seq}`,
  };
}

describe("renderSessionHtml", () => {
  it("renders a self-contained HTML session viewer", () => {
    const events = [
      event(0, "session.start", {
        runtime: "claude",
        runtimeVersion: "1.0",
        cwd: "/tmp/project",
      }),
      event(1, "message.user", {
        text: "Hello",
      }),
    ];

    const html = renderSessionHtml(events);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("agit · session");
    expect(html).toContain("session-data");
    expect(html).toContain("session.start");
    expect(html).toContain("Hello");

    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).toContain("connect-src 'none'");
  });

  it("safely embeds script-like session content", () => {
    const malicious = "</script><script>alert('owned')</script>";

    const html = renderSessionHtml([
      event(0, "message.user", {
        text: malicious,
      }),
    ]);

    expect(html).not.toContain("</script><script>");
    expect(html).toContain("\\u003c/script\\u003e");
    expect(html).toContain("\\u003cscript\\u003e");
  });

  it("safely handles single quotes in session content", () => {
    const html = renderSessionHtml([
      event(0, "message.user", {
        text: "it's safe; don't break the viewer",
      }),
    ]);

    expect(html).toContain("application/json");
    expect(html).toContain("it's safe; don't break the viewer");
    expect(html).not.toContain("JSON.parse('");
  });

  it("renders untrusted content with textContent rather than innerHTML", () => {
    const html = renderSessionHtml([
      event(0, "message.user", {
        text: "<img src=x onerror=alert(1)>",
      }),
    ]);

    expect(html).toContain("textContent");
    expect(html).not.toContain("innerHTML");
    expect(html).toContain("\\u003cimg");
  });

  it("is deterministic for identical input", () => {
    const events = [
      event(0, "session.start", {
        runtime: "claude",
      }),
      event(1, "message.assistant", {
        blocks: [{ type: "text", text: "Done" }],
      }),
    ];

    const meta = {
      agitSchema: 1,
      sessionId: "test-session",
      adapter: {
        name: "test",
        version: "1.0.0",
      },
      importedAt: "2026-01-01T00:00:00.000Z",
      source: {
        path: "/tmp/session.jsonl",
        sha256: "abc",
        bytes: 123,
        records: 2,
      },
      skipped: {},
      redactions: {},
      eventCount: 2,
      headHash: "hash-1",
    };

    expect(renderSessionHtml(events, meta)).toBe(
      renderSessionHtml(events, meta),
    );
  });
});