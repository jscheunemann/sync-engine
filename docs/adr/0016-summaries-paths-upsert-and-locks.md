# 0016. Summaries, JSON paths, upsert and locks

- Status: Accepted
- Date: 2026-11-18
- Amends: 0012 (a find still can't join; a summary is the one aggregate intent)

## Context

Moving Fitness Tracker to version 2 needs four things the intents didn't have:

- **Its owner analytics screens summarise usage events:** groups, distinct counts, medians, counts of one kind of
  event, values inside the event's JSON, and days in the owner's time zone.
- **Some writes are "insert or update":** sessions, viewers, connections.
- **One path takes an advisory lock** so two quick clicks can't both create an API token past the limit.
- **One filter is "not one of these"** (event kinds).

The owner chose an engine summary intent over summing in the app.

## Decision

- **JSON paths:** a declared type names values inside a `json` field (`paths: { name: { from: 'e', path: ['name'],
  kind: 'text' } }`).
  - A path is read-only, and works wherever a query field does: filters, order, groups and measures.
  - A `number` or `boolean` path is null where the stored value isn't one, so a stray string never breaks a sum.
- **`summarize(type, { where, by, measures, order, limit })`:**
  - **Groups:** declared fields and paths, or a time field's local day in an IANA zone (`{ day: 't', zone }`), at most
    six.
  - **Measures:** `count`, `distinct`, `sum`, `avg`, `min`, `max`, `percentile` (continuous, `p` in (0, 1]). Each can
    have its own `where`, a conditional count. Sums, averages and percentiles need a number field.
  - **Ordering:** by a group or a measure, nulls last, at most 1000 groups.
  - **Scope and audit:** it's kept to the scope like a find, and audited in system units.
  - **Per backend:** Postgres writes it as one query (`filter`, `percentile_cont`, `at time zone`); SQLite, a test
    backend, computes it in code. The same contract checks both.
- **`not in`:** a filter `{ nin: [...] }`, with SQL's meaning: a null value matches neither `in` nor `nin`.
- **Upsert:** `put(type, row, { onConflict: 'update' | 'nothing' })`. On a taken key it updates only the given
  fields, or leaves the row and returns null.
- **Locks:** `lock(name)` holds a named lock until the unit ends (Postgres: a transaction advisory lock in the app's
  schema; SQLite: units already run one at a time).

## Consequences

- Fitness Tracker's analytics, sessions, viewers and connections move to intents with no SQL of their own.
- A summary still can't join two types. When a screen needs one, the app reads both and joins them in code, or a new
  intent is decided in an ADR.
