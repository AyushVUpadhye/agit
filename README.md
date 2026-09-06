# agit — git for running agents

An AI coding session is trapped: one terminal, one machine, a proprietary log
format, one pair of eyes. When it ends you're left with changed files and a
scrollback buffer.

agit turns the session itself into an open artifact. It imports a runtime's
native log into an append-only, hash-chained JSONL event log — and every
feature is a view over that log. agit does not build an agent; it sits above
every agent, the way git sits above every editor.

```
npm install -g agitsh
```

## What works today

- **`agit import <session.jsonl>`** — ingest a native Claude Code session
  (`~/.claude/projects/<project>/<uuid>.jsonl`) into
  `.agit/sessions/<id>/events.jsonl`. Deterministic: the same input always
  produces byte-identical output. Credential-looking strings are redacted on
  the way in (see [SPEC.md §8](SPEC.md) for exactly what is and isn't caught).
- **`agit ls`** — list imported sessions: start, duration, events, files touched.
- **`agit show <id>`** — one-session summary: model, tools, token totals,
  per-file diffstat.
- **`agit verify <id>`** — validate the hash chain; reports the first broken
  link, and detects truncation via `meta.json`.
- **`agit replay <id>`** — step through events (`n`/`p`/`g N`), inspect any
  event, and show cumulative file state at any point (`s`). `--at N` jumps
  straight to event N; `--timeline` prints the whole session one line per
  event.

Session ids accept unique prefixes, git-style. Everything is local: no
server, no network calls, no telemetry.

## The format

[SPEC.md](SPEC.md) is the most important artifact in this repo. Eight event
types (`session.start`, `session.end`, `message.user`, `message.assistant`,
`tool.call`, `tool.result`, `file.diff`, `cost`), each carrying a canonical
SHA-256 hash and the hash of the previous event. Tamper-evidence, stable fork
points, and independent verification of what an agent claims it did — all
fall out of that chain.

## What does not work yet

Said plainly:

- **One adapter.** Claude Code only. Codex and OpenClaw are next; the adapter
  interface is three functions, written to make that real rather than
  aspirational.
- **`file.diff` coverage is partial.** Diffs come from structured edit tools
  (`Edit`/`Write`). Files changed through shell commands leave no diff event;
  file state from replay is a lower bound on what changed.
- **No `share`, `fork`, `merge`, or `pr`.** Those are roadmap milestones 2–3.
  When they land: fork will be honestly lossy (file state replays; agent
  context is summarized, not transplanted), merge will be file-level git
  merge plus a written summary — not a merge of two minds.
- **Redaction is a seatbelt, not a guarantee.** Session logs contain whatever
  the agent saw. Before sharing one anywhere, read it.

## Security posture

Session logs are untrusted input: they may contain adversarial content and
are never executed, only displayed. Known credential patterns are redacted at
import, before hashing, and counted in `meta.json`. Sharing (when it exists)
will be explicitly opt-in per session. Never commit real session logs to this
repo — tests run against synthetic fixtures.

## Development

Node 20+, TypeScript, ESM, zero runtime dependencies.

```
npm install
npm run build   # tsc -> dist/
npm test        # vitest
```

Conventional Commits, small and focused. If a real session breaks an adapter,
fix the adapter, not the fixture.

## License

Apache-2.0
