# Connecting your data sources

qbrin answers against your organisation's own systems. There are two ways your
data reaches a verification, and you can use either or both.

## 1. Indexed sources (the default)

Your admin connects Gmail, Drive, Slack, GitHub, Confluence, uploads, and
databases in the qbrin Console. qbrin ingests and indexes them into a knowledge
graph. Your `verify()` / `ask()` calls search that index. Nothing extra is
needed from the SDK — just ask.

## 2. Live query-in-place (verify against *current* state)

For systems where "as of the last sync" isn't good enough — an orders table, a
CRM, a policy service — qbrin can probe the source **read-only, at answer time**,
and fold matching records into the audited evidence. The verdict then reflects
the state of your systems *right now*.

This is configured **once, server-side, by your org admin** — not per call, and
not through the SDK (so a client can never point qbrin at a new system). The
admin adds one entry to `LIVE_QUERY_SOURCES` naming the source and an explicit
allowlist of what qbrin may read. Six kinds are supported: **Postgres, MySQL,
Salesforce, any REST/JSON API, Slack, GitHub**.

Once a source is connected, your existing calls transparently gain live
evidence:

```js
const v = await qb.verify("What is the status of order ORD-7719?");

if (v.freshness?.liveEvidenceCount) {
  console.log("verified against live systems, as of", v.freshness.newestEvidence);
  for (const e of v.evidence) {
    console.log(e.source, e.snippet); // e.g. "live:postgres  orders — id: ORD-7719 · status: paid"
  }
}
```

`freshness.liveEvidenceCount > 0` means at least one cited record came from a
live probe rather than the index.

### What qbrin will and won't do with a connected source

By construction — this is enforced in code, not policy:

- **It only looks up what your question is about.** The search terms are the
  entities in the question (order ids, emails, names). A question with no
  entities probes nothing. qbrin never scans or copies a table.
- **It can only read what your admin allowlisted.** Every table, column, object,
  field, endpoint, channel, and repo is named explicitly and validated; nothing
  outside the list is reachable.
- **Your values are never executed as code.** Question terms travel as bind
  parameters (SQL), escaped literals (SOQL), or URL-encoded params (REST / Slack
  / GitHub). No LLM ever writes a query.
- **Read-only, bounded, fail-soft.** Read-only transactions, statement timeouts,
  row caps, `https`-only endpoints with cloud-metadata hosts blocked, and any
  failing probe drops that evidence without failing your answer.
- **Live records are untrusted until proven.** They're fenced against prompt
  injection and admitted only if they survive the same verifier gate stack as
  any other evidence — a live row can only *support* a claim it literally states.

Full setup and the per-source config format live in the server docs
(`docs/LIVE-CONNECTORS.md`). Ask your qbrin admin to connect a source, then just
call `verify()`.
