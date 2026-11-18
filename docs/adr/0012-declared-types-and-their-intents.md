# 0012. Declared types: find on declared fields, versioned updates, and the audit table

- Status: Accepted
- Date: 2026-11-18

## Context

ADRs 0003 and 0009 say apps speak in intents and that cross-person work is a named, audited system intent. Building
them (version 2, part 2) needed choices the ADRs leave open: how a type the app's server writes is declared, what a
find may do, how an update avoids losing a concurrent one, and where the audit goes.

## Decision

- **A declared type** (`createEngine({ types })`) names its table, its access (`person`, `shared` or `system`), its
  key, its fields by kind (`text`, `number`, `boolean`, `time`, `id`, `json`), the fields a find may use, an optional
  version column, and its sealed fields. Declarations are checked when the engine is made; a type can't take an
  engine table (`counters`, `applied_ops`, `prefs`, `engine_audit`) or a record type's name.
- **A find** filters by declared query fields and key fields only, with one condition per field (`eq`, `in`, `ne`,
  `gt`/`gte`/`lt`/`lte`, `is null`, `not null`); orders by one of them, ascending or descending, then by the key;
  **nulls last** both ways; pages with an opaque cursor (the last row's order and key values); 100 rows by default,
  1000 at most. **Count** takes the same conditions. Record types can be found too, by their standard columns and
  the store's `queryColumns`.
- **Writes:** `put` (a new row), `update` (by key) and `remove` (by key). With a version column, an update names the
  version it saw and gets `conflict` with the current row when it's stale, as records do; without one, the last
  write wins. Keys, the person column and the version column can't be changed by an update. Records are written
  only through `apply`.
- **Sealed fields** are sealed with the unit's `ContentCrypto.sealDoc` and opened with `openDoc`, with associated
  data `type|key values|field` unless the type gives its own (`aad`), so today's sealed columns can be adopted.
- **The person column** is set by the engine in a person scope (a different value is refused: `not_yours`); a
  system intent writing a person type names it, and reading one gets it on each row.
- **System units run as `systemRole`** (a backend setting): the database lets that role past row-level security for
  the tables system intents reach; without it, system units are refused. They set no person.
- **The audit table** is `<schema>.engine_audit` (`at`, `intent`, `by_person`, `type`, `action`, `rows`), one row
  per intent a system unit runs, written in the same unit: a unit that doesn't land leaves no audit.
- **Errors** are `EngineError`s with a code and, where there is one, a field; never a value. A database rule refusing
  a write is `refused` (or `reference`), with the constraint's name.
- Every rule runs on an in-memory backend in every test run (`test/memory-backend.ts`, replaced by SQLite in part 5)
  and on Postgres with row-level security on in CI.

## Consequences

- An app's server tables (invitations, keys, feedback, the review queue) move to declarations without changing
  their tables; part 4 makes the tables from the same declarations.
- A find can't join or aggregate beyond a count. Anything that needs more is a new, named intent in the engine,
  decided by an ADR, so the boundary stays where ADR 0002 put it.
