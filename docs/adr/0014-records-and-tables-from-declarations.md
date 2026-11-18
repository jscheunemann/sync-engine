# 0014. Records and tables from declarations: no app code sees a column

- Status: Accepted
- Date: 2026-11-18
- Amends: 0006 (the tables are made from the declarations, and adopted ones are checked against them)

## Context

After part 2, apps still mapped their records to columns themselves (`toColumns`, `toRecord`, `fieldNames`,
`contentFields`) and named the Postgres schema their tables live in. That is the app knowing how its data is stored,
which ADR 0002 says is the engine's. Fitness Tracker's mapping is field to column. Clearwork's is too, except for two
field kinds:

- a list of ids, kept as a Postgres array;
- a due date, split across four columns (`*_kind`, `*_at`, `*_zone`, `*_local`), which nothing on the server queries.

## Decision

- **Apps declare each record type's fields:** a kind (`text`, `number`, `integer`, `boolean`, `time`, `id`, `ids`,
  `json`), or `{ kind, content: true }` for what people wrote. The engine maps them to columns and back:
  - columns by kind;
  - content gathered in `content`, sealed when the device sealed it;
  - times as ISO strings, id lists as arrays.
- **The app's `RecordStore` keeps only its rules:**
  - `validate`, with `defaults`, `checkChanges` and `normalize` optional;
  - `crossChecks`;
  - `bulkSafe`.
  The engine's default shape check refuses unknown fields and values not of their kind.
- **Field names can't take the engine's own columns** or the person's.
- **Where data lives is the backend's setting:** the schema is a Postgres setting (`schema`), not the app's. The
  backend gets a layout of each table instead:
  - its columns by kind;
  - its key;
  - who its rows belong to;
  - its query fields.
- **A composite value is one `json` field.** Clearwork's due date becomes one `jsonb` column holding what devices
  send. Clearwork's own migration moves the four columns into it when it moves to version 2. It's not engine work,
  and a column can be added later if due dates ever need to be queried on the server.
- **Tables come from the declarations** (`engine.plan`, `engine.migrate`), as ADR 0006 set out:
  - **The plan is additive.** It covers the schema, the engine's tables and functions, each table with its key,
    missing columns (nullable on tables that have rows), indexes, row-level security and grants for the person and
    system roles.
  - **Differences are reported, not changed.** A column of another type, or a timestamp without a zone, is a
    conflict.
  - **Migrate re-plans first.** It refuses a plan that is out of date or has conflicts, and applies all of a plan's
    steps or none.
  - **Nothing changes a schema at request time.**

## Consequences

- The apps lose their mapping code and their schema name; a record type's declaration is the whole of its storage.
- keel's `migrate` for an app on version 2 becomes `engine.plan` (shown to the owner) and `engine.migrate`, staging
  first. The apps' SQL migrations stay as history.
- A plan never drops or rewrites anything. Removing a field, or changing its kind, is a person's change: the owner
  runs it, and the next plan is checked against the result.
