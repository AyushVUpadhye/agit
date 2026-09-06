# Security

## The plain statement first

**Session logs contain whatever the agent saw.** File contents, command
output, environment details, and any secret an agent happened to read or
print. agit redacts known credential patterns at import — before hashing,
before anything leaves your machine — but redaction is a pattern list, not a
guarantee (SPEC.md §8 documents exactly what is and isn't caught). Before
sharing a session anywhere, read it. Treat every imported or shared log as
untrusted input: agit only ever displays log content, never executes it.

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub security advisories](https://github.com/thegoodengineers/agit/security/advisories/new)
rather than a public issue. Reports we especially want:

- Anything that lets a crafted session log escape "displayed, never
  executed" — script injection in the share page, the CLI, or a downstream
  renderer of agit logs.
- Data leaks through the relay: cross-share access, share-id enumeration,
  writer-token bypass, or anything persisted that we claim is in-memory.
- Redaction bypasses that are pattern-shaped (a credential format the table
  should catch but doesn't). Note: secrets that match no known pattern are a
  documented limitation, not a vulnerability.
- Hash-chain weaknesses: any way to alter events without `agit verify`
  noticing.

There is no bounty program; there is credit in the advisory and a fast fix.
Expect an acknowledgement within a few days.

## Scope notes

The relay binds loopback by default and holds shares in memory with TTL
expiry. Deployments that expose it to a network are expected to put TLS in
front (PROTOCOL.md, deployment notes); reports assuming a plaintext public
relay configuration will be read with that in mind.
