# Launch posts — agit 0.3.0

Ready to paste. Three lengths for three venues. Post from your own accounts;
the HN one matters most, the others are echoes.

---

## Show HN

**Title** (79 chars):

> Show HN: Agit – Git for AI coding sessions: replay, verify, fork, live-share

**Body:**

An AI coding session is trapped: one terminal, one machine, a proprietary
log format, one pair of eyes. When it ends you're left with changed files
and a scrollback buffer. You can't hand a running session to a teammate,
ask why the agent did something at step 400, or try two approaches from the
same starting point.

Agit treats the session itself as data: it imports an agent runtime's
native log into an append-only, hash-chained JSONL event log, and every
feature is a view over that log. It doesn't build an agent — it sits above
agents, the way git sits above editors.

What works today:

- `agit import` — Claude Code sessions and Codex CLI rollouts, auto-
  detected into the same eight event types. Deterministic: same input,
  byte-identical output. Credentials redacted on the way in.
- `agit replay` — step through events, jump to any point, see cumulative
  file state as of that event. Time-travel debugging for "why did it do
  that at step 412."
- `agit verify` — the hash chain means you can independently check what an
  agent *claims* it did against what the log shows. My favorite feature
  fell out of this: when a later edit's before-hash contradicts the file's
  last known content, replay marks it `[DIVERGED at seq N]` — cryptographic
  proof the file was changed outside the recorded edits (a `sed -i` the
  log never saw, a human touching files mid-session).
- `agit share` — live: it tails the running session's log and streams it
  through a self-hosted relay; teammates watch a browser replay and send
  messages that land in your terminal. A finished live stream is
  byte-identical to a full import, so viewers can download it and verify
  what they watched. Crash-resumable.
- `agit fork <id> --at N` — branch a session at any event: the file tree is
  reconstructed from the log with every step verified against the recorded
  content hashes, plus a deterministic context summary for seeding a new
  session. `agit merge` brings a fork's files back (ordinary git three-way
  merge, fork point as base). `agit pr` bundles a session for a colleague,
  verifiably.

What doesn't work, said plainly (the README keeps this list honest): files
changed via shell commands produce no diff events, so file state is a
labeled lower bound; fork's context seeding is a summary, not a transplant
— you can't inject history into a running agent, and anyone claiming
otherwise is selling something; viewer messages reach the human, never the
agent; redaction is a seatbelt, not a guarantee.

Zero runtime dependencies, TypeScript, Apache-2.0. The event format is one
readable spec (SPEC.md) — the adapter interface is three functions, and the
second runtime (Codex) needed zero schema changes, which is the main reason
I trust the format enough to show it to you.

    npm install -g agitsh
    agit import ~/.claude/projects/<project>/<session>.jsonl
    agit replay <id> --timeline

https://github.com/thegoodengineers/agit

I'd especially value: real session logs that break the adapters (fixing the
adapter, not the fixture, is a repo rule), and anyone running OpenClaw —
the third adapter is blocked on sample data.

---

## X / Twitter (thread)

**1/**
Your AI coding session is trapped in a scrollback buffer.

agit turns it into a git-like artifact: an append-only, hash-chained event
log you can replay, verify, fork, and live-share.

npm i -g agitsh
github.com/thegoodengineers/agit

**2/**
The feature I didn't plan: because every file edit records content hashes,
agit can *prove* when a file changed outside the recorded edits.

[DIVERGED at seq 24] = cryptographic evidence your agent's log doesn't
match reality. Auditing agents by hash chain.

**3/**
Two runtimes already — Claude Code and Codex CLI import into the same
eight event types, auto-detected. The second adapter needed zero schema
changes.

Live share streams a *running* session to a teammate's browser; the stream
is verifiable against the final log, byte for byte.

**4/**
Honest limits, in the README where they belong: shell edits are a blind
spot (labeled, not hidden), fork seeds context with a summary (you can't
transplant an agent's mind), redaction is a seatbelt.

Send me a session that breaks an adapter — fixing the adapter is a repo
rule.

---

## Reddit (r/programming or r/LocalLLaMA)

**Title:** agit — git-like replay, verify, fork and live-share for AI
coding sessions (Claude Code + Codex, open source)

**Body:**

The pitch in one line: your agent session becomes an append-only,
hash-chained event log, and replay / verify / share / fork are all views
over that log.

The part I find genuinely new: `agit verify` checks the hash chain, and
replay marks `[DIVERGED at seq N]` when a file's recorded before-hash
contradicts its last known content — cryptographic proof something changed
outside the log (shell edits, humans). You can hand a colleague a session
bundle and they can verify every event of it offline.

Live share tails a *running* session and streams it to a browser; a
finished stream is byte-identical to a full import, so viewers can verify
what they watched. Fork reconstructs the working tree at any event, every
file checked against its recorded hash, and refuses to write anything it
can't verify.

Two runtime adapters (Claude Code, Codex CLI), zero runtime dependencies,
Apache-2.0, and a README that says plainly what doesn't work. Would love
real logs that break the adapters.

https://github.com/thegoodengineers/agit
