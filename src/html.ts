import type { AgitEvent, SessionMeta } from "./format/events.js";

export function renderSessionHtml(events: AgitEvent[], meta?: SessionMeta | null): string {
  const data = JSON.stringify({ events, meta: meta ?? null })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'">
<title>agit · session</title>
<style>
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: #0d1117;
  color: #c9d1d9;
}
header {
  padding: 16px 20px;
  border-bottom: 1px solid #30363d;
  background: #161b22;
}
h1 { margin: 0 0 6px; font-size: 18px; }
.meta {
  color: #8b949e;
  font-size: 12px;
  white-space: pre-wrap;
}
.layout {
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(420px, 1fr);
  height: calc(100vh - 83px);
}
.panel {
  min-width: 0;
  overflow: auto;
}
#timeline {
  border-right: 1px solid #30363d;
}
.row {
  display: grid;
  grid-template-columns: 42px 72px 145px minmax(0, 1fr);
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #21262d;
  cursor: pointer;
}
.row:hover { background: #161b22; }
.row.sel { background: #1f2933; }
.seq, .t { color: #8b949e; }
.sum {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user { color: #79c0ff; }
.assistant { color: #d2a8ff; }
.toolcall { color: #ffa657; }
.toolresult { color: #7ee787; }
.filediff { color: #56d364; }
.cost { color: #a5d6ff; }
.err { background: #2d1b1b; }
.detail {
  padding: 18px;
}
.detail h3 {
  margin-top: 0;
  font-size: 13px;
  color: #8b949e;
  word-break: break-word;
}
pre {
  margin: 10px 0;
  padding: 12px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
}
pre.think {
  color: #8b949e;
}
pre.del { color: #ff7b72; }
pre .add { color: #7ee787; }
pre .del { color: #ff7b72; }
pre .hunk { color: #d2a8ff; }
.files {
  border-top: 1px solid #30363d;
  padding: 12px;
}
.files h2 {
  margin: 0 0 8px;
  font-size: 13px;
}
.file {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  gap: 6px;
  padding: 3px 0;
}
.file path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plus { color: #7ee787; }
.minus { color: #ff7b72; }
.muted { color: #8b949e; }
@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
    height: auto;
  }
  #timeline {
    max-height: 50vh;
    border-right: 0;
    border-bottom: 1px solid #30363d;
  }
}
</style>
</head>
<body>
<header>
  <h1>agit · session</h1>
  <div id="meta" class="meta"></div>
</header>

<main class="layout">
  <section class="panel" id="timeline"></section>
  <section class="panel">
    <div id="detail" class="detail">
      <div class="muted">Select an event.</div>
    </div>
    <div class="files">
      <h2>Files</h2>
      <div id="flist" class="muted">No structured file edits.</div>
    </div>
  </section>
</main>

<script type="application/json" id="session-data">${data}</script>
<script>
"use strict";

var DATA = JSON.parse(
  document.getElementById("session-data")?.textContent ?? "{}"
);
var events = DATA.events || [];
var meta = DATA.meta || null;

var timeline = document.getElementById("timeline");
var detail = document.getElementById("detail");
var metaBox = document.getElementById("meta");
var fileList = document.getElementById("flist");

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function str(v) {
  return typeof v === "string" ? v : "";
}

function oneLine(s, max) {
  s = s.replace(/\\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function chipClass(t) {
  return {
    "message.user": "user",
    "message.assistant": "assistant",
    "tool.call": "toolcall",
    "tool.result": "toolresult",
    "file.diff": "filediff",
    "cost": "cost"
  }[t] || "";
}

function summary(e) {
  var p = e.payload || {};

  switch (e.type) {
    case "session.start":
      return "runtime " + str(p.runtime) + " " +
        str(p.runtimeVersion) +
        (p.cwd ? " · " + str(p.cwd) : "");

    case "session.end":
      return "reason " + str(p.reason);

    case "message.user":
      return oneLine(str(p.text), 160);

    case "message.assistant": {
      var blocks = Array.isArray(p.blocks) ? p.blocks : [];
      var texts = blocks
        .filter(function (b) { return b && b.type === "text"; })
        .map(function (b) { return str(b.text); })
        .join(" ");
      var kinds = blocks
        .map(function (b) { return str(b.type); })
        .join("+");
      return "[" + (kinds || "empty") + "] " + oneLine(texts, 140);
    }

    case "tool.call": {
      var input = p.input && typeof p.input === "object" ? p.input : {};
      var keys = Object.keys(input);
      var preferred = ["command", "file_path", "pattern", "path", "url", "prompt"]
        .filter(function (x) { return x in input; })[0] || keys[0];
      var value = preferred ? input[preferred] : "";
      return str(p.name) + "  " +
        oneLine(typeof value === "string" ? value : JSON.stringify(value || ""), 130);
    }

    case "tool.result":
      return (p.isError ? "ERROR " : "") +
        oneLine(str(p.output), 150);

    case "file.diff":
      return str(p.kind) + " " + str(p.path);

    case "cost": {
      var u = p.usage || {};
      return str(p.model) +
        "  in=" + (u.inputTokens || 0) +
        " out=" + (u.outputTokens || 0);
    }

    default:
      return "";
  }
}

function addEvent(e) {
  var row = el("div", "row");
  row.dataset.seq = String(e.seq);

  if (e.type === "tool.result" && e.payload && e.payload.isError) {
    row.classList.add("err");
  }

  row.appendChild(el("span", "seq", String(e.seq)));
  row.appendChild(el("span", "t", str(e.ts).slice(11, 19)));
  row.appendChild(el("span", "chip " + chipClass(e.type), e.type));
  row.appendChild(el("span", "sum", summary(e)));

  row.addEventListener("click", function () {
    select(e.seq);
  });

  timeline.appendChild(row);
}

function select(seq) {
  var rows = timeline.children;

  for (var i = 0; i < rows.length; i++) {
    rows[i].classList.toggle(
      "sel",
      Number(rows[i].dataset.seq) === seq
    );
  }

  var e = events[seq];
  if (!e) return;

  detail.textContent = "";

  var heading = el(
    "h3",
    "",
    "event " + e.seq +
      " · " + e.ts +
      " · " + e.type +
      " · hash " + str(e.hash).slice(0, 12)
  );

  detail.appendChild(heading);

  var p = e.payload || {};

  if (e.type === "message.user") {
    detail.appendChild(el("pre", "", str(p.text)));

  } else if (e.type === "message.assistant") {
    var blocks = Array.isArray(p.blocks) ? p.blocks : [];

    blocks.forEach(function (b) {
      var thinking = b.type === "thinking";
      detail.appendChild(
        el(
          "pre",
          thinking ? "think" : "",
          (thinking ? "(thinking) " : "") + str(b.text)
        )
      );
    });

  } else if (e.type === "tool.call") {
    detail.appendChild(el("pre", "", str(p.name)));
    detail.appendChild(
      el("pre", "", JSON.stringify(p.input, null, 2))
    );

  } else if (e.type === "tool.result") {
    if (p.isError) {
      detail.appendChild(el("pre", "del", "(error)"));
    }

    detail.appendChild(el("pre", "", str(p.output)));

    if (p.structured) {
      detail.appendChild(
        el(
          "pre",
          "think",
          "structured: " +
            oneLine(JSON.stringify(p.structured), 600)
        )
      );
    }

  } else if (e.type === "file.diff") {
    detail.appendChild(
      el(
        "pre",
        "",
        str(p.kind) + " " + str(p.path) +
        "\nbefore " + (p.beforeHash || "∅") +
        "\nafter  " + str(p.afterHash)
      )
    );

    var pre = el("pre", "");

    str(p.diff).split("\n").forEach(function (line) {
      var cls =
        line.charAt(0) === "+" ? "add" :
        line.charAt(0) === "-" ? "del" :
        line.slice(0, 2) === "@@" ? "hunk" :
        "";

      pre.appendChild(el("span", cls, line + "\n"));
    });

    detail.appendChild(pre);

  } else {
    detail.appendChild(
      el("pre", "", JSON.stringify(p, null, 2))
    );
  }
}

function renderFiles() {
  var files = Object.create(null);

  events.forEach(function (e) {
    if (e.type !== "file.diff") return;

    var p = e.payload || {};
    var diff = str(p.diff);
    var added = 0;
    var removed = 0;

    diff.split("\n").forEach(function (line) {
      if (line.charAt(0) === "+" && line.slice(0, 3) !== "+++") {
        added++;
      } else if (line.charAt(0) === "-" && line.slice(0, 3) !== "---") {
        removed++;
      }
    });

    var path = str(p.path);
    var f = files[path] || {
      added: 0,
      removed: 0,
      edits: 0,
      kind: str(p.kind)
    };

    f.added += added;
    f.removed += removed;
    f.edits++;
    files[path] = f;
  });

  fileList.textContent = "";

  var paths = Object.keys(files);

  if (paths.length === 0) {
    fileList.className = "muted";
    fileList.textContent = "No structured file edits.";
    return;
  }

  fileList.className = "";

  paths.forEach(function (path) {
    var f = files[path];
    var row = el("div", "file");

    row.appendChild(
      el(
        "span",
        f.kind === "create" ? "plus" : "",
        f.kind === "create" ? "A" : "M"
      )
    );

    row.appendChild(el("path", "", path));

    var counts = el("span", "");

    counts.appendChild(
      el("span", "plus", "+" + f.added + " ")
    );
    counts.appendChild(
      el("span", "minus", "-" + f.removed)
    );

    row.appendChild(counts);
    fileList.appendChild(row);
  });
}

function renderMeta() {
  var first = events[0];
  var last = events[events.length - 1];

  var lines = [
    "session: " + (first ? str(first.session) : "unknown"),
    "events: " + events.length
  ];

  if (first && last) {
    lines.push("started: " + first.ts);
    lines.push("ended: " + last.ts);
  }

  if (meta) {
    lines.push(
      "adapter: " +
      str(meta.adapter && meta.adapter.name) +
      "@" +
      str(meta.adapter && meta.adapter.version)
    );
    lines.push("imported: " + str(meta.importedAt));
    lines.push("chain head: " + str(meta.headHash));
  }

  metaBox.textContent = lines.join("\n");
}

events.forEach(addEvent);
renderFiles();
renderMeta();

if (events.length > 0) {
  select(events[0].seq);
}
</script>
</body>
</html>
`;
}