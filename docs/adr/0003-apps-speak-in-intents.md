# 0003. Apps speak in intents, never SQL

- Status: Accepted
- Date: 2026-11-18

## Context

If apps sent SQL, they would be tied to one database's dialect, which 0002 rules out. If they could ask for anything,
the engine would become a general ORM. The intents must cover what the apps do today and stay small.

## Decision

Every call is one of these, against a **type** the app declared (0006):

| Intent | For |
| --- | --- |
| `apply(ops)` | Synced record changes from devices: today's `applyOp`, `applyCreates`, `applyDeletes` behind one call; the engine picks bulk paths itself. |
| `changes(since, limit)` | The change feed. |
| `get(type, id)` / `getMany(type, ids)` | Read records by id. |
| `find(type, where, order, limit, after)` | Read by **declared** query fields only: equals, in, ranges, `is null`; order by a declared field; cursor paging. No joins, no free text. |
| `count(type, where)` | Counts on the same terms. |
| `put(type, record)` / `update(type, id, fields, version)` / `remove(type, id)` | Server-side writes to types that aren't synced from devices (invitations, feedback, review queues, keys, analytics). Optimistic concurrency by version, as in sync. |
| `prefs.get()` / `prefs.put(data, version)` | The per-person settings document. |
| `work(fn)` | Several intents as one unit (0008). |

- **A type says how it is used:** `synced` (devices push and pull it) or `server` (written only by the app's server).
  Both are isolated per person unless declared `shared` (0009).
- **A query field must be declared** with its kind (text, number, time, boolean, id); the engine indexes it. An
  undeclared field in `where` is an error at start-up where possible, at the call otherwise.
- **No escape hatch.** When an app needs something these can't say, the engine gains a new intent, with its own ADR and
  contract tests. A report the intents can't express (analytics roll-ups) becomes a declared, named query in the
  engine, implemented per backend.

## Consequences

- Each app's routes are rewritten from SQL to intents. Reading the apps' code today, every route maps to these, except
  the analytics roll-ups and a few owner views (feedback across people), which become named queries and system
  intents (0009).
