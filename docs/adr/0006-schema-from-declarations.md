# 0006. Schema and migrations come from the apps' declarations

- Status: Proposed
- Date: 2026-11-18

## Context

Today each app writes its tables, functions and row-level-security policies by hand in numbered SQL migrations, and
the owner runs them in the SQL editor, staging first. SQL migrations are database-specific, so 0002 moves them.

## Decision

- **An app declares its types**, extending today's `RecordStore`: fields, their kinds, which are content (sealed by
  0010), which are queryable, `synced` or `server`, `shared` or per person, and a **schema version**.
- **The backend turns declarations into its own schema** and migrates between versions: add a type, add a field, add or
  drop a query field. Destructive steps (drop a field or type, change a kind) need an explicit, versioned migration
  step in the declaration, and keep the old data until a later version drops it.
- **Migrations run as today, under the owner's control:** the engine produces the plan (`plan`), shows it, and applies
  it (`migrate`), staging first. It never changes a schema on its own at request time.
- **Existing tables are adopted, not recreated:** the first version maps each app's current tables and columns, so
  moving to v2 moves no data.

## Consequences

- The apps' `migrations/` folders stop growing; their history stays as the record of how the tables came to be.
- keel's `scripts/keel migrate` runs the engine's plan for an app instead of the app's SQL files.
