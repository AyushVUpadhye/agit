---
name: Adapter request
about: Ask for (or offer to build) support for another agent runtime's session logs
labels: adapter
---

**Runtime**

Name, link, and roughly how many people use it.

**Where its session logs live**

Path pattern and format (JSONL? SQLite? directory of files?). If you can,
paste a *sanitized* sample of 3–5 records showing the shapes for: a user
message, an assistant message, a tool call, and a tool result. Strip real
paths, file contents, and anything secret-shaped.

**Log behavior**

- Append-only while the session runs, or rewritten in place?
- Does one API message span multiple records?
- Are structured file edits recorded (before/after content or patches), or
  only tool output text?

**Are you offering to build it?**

CONTRIBUTING.md has the adapter-writing guide — the interface is three
functions, and the Claude Code adapter is the template. Either way this
issue is useful; sample data is the hard part.
