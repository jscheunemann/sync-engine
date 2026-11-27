# 0029. Put many rows of a declared type at once

- Status: Accepted
- Date: 2026-11-26

## Context

`put` writes one row: a savepoint, an insert and its release, three statements in a row, and an audit line in a system
unit. An app that stores a batch someone sent (Fitness Tracker's Apple Health sync: a hundred workouts, or 1,500 single
readings, in one request) then makes thousands of round trips in one transaction. A 100-workout batch ran out of time
and stored nothing. Statements in one transaction can't overlap, so the only way down is fewer of them. ADR 0023 did the
same for removing.

## Decision

- **`putMany(type, rows, { onConflict })`** on a unit: each row checked exactly as `put` checks it (declared fields of
  their kind, the person's column, sealed fields sealed, the version's first), then written in statements of up to
  `BULK_ROWS` rows (fewer for a wide table, so a statement stays within the database's parameters), all in one savepoint,
  with one audit line counting the rows. Returns how many rows were written.
- **A key given twice is one row**, since one statement can't write a key twice: with `update`, the later row's fields
  over the earlier's; with `nothing`, the first. Without `onConflict` every row goes in, and a repeated or taken key is
  refused for the whole call, as a second `put` would be.
- **Rows that give different fields are written apart**, so an upsert updates only the fields each row gave, as `put`
  does.
- **At most `PUT_MANY_MAX` (10,000) rows a call** (`too_many_rows`): one call is one savepoint the database holds.
- **Backends get `insertMany(table, rows, onConflict)`**: one statement for rows with the same columns and distinct
  keys, returning the count only (a big batch isn't sent back). SQLite, the contract's second backend, does the same in
  one statement.

## Consequences

- Minor version (3.1.0): nothing changes for existing callers. A backend outside this package would need
  `insertMany`; both backends are the engine's own (ADRs 0004, 0015).
- `putMany` returns a count, not the stored rows: an app that needs a row back reads it, or uses `put`.
