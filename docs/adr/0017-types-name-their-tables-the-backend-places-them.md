# 0017. Types are addressed by name; the backend places their tables

- Status: Accepted
- Date: 2026-11-18
- Amends: 0014 (one schema per app becomes the default schema)

## Context

Fitness Tracker's tables are in three schemas: records in `fitness_data`, server tables in `fitness`, analytics in
`analytics`. Moving it to version 2 adopts them where they are (ADR 0006). One of its server tables, `fitness.prefs`
(account settings), has the same name as the engine's own `prefs` in the records schema.

## Decision

- **Units and backends address declared types by name, not by table.**
  - A type's `table` (its own name unless it declares another) is part of the layout the backend gets.
  - A type can't be named after an engine table: `counters`, `applied_ops`, `prefs`, `engine_audit`.
- **Where a type's table is belongs to the backend's settings,** never to the app's declarations. Postgres takes a
  default `schema`, which also holds the engine's own tables, and optionally `schemas: { type: schema }` for tables
  adopted elsewhere.
- **The backend refuses settings that would put a type's table on an engine table** (the same schema and name), or
  that name a type the app didn't declare.
- **The schema plan covers every schema the settings name:**
  - each schema is created if it's missing, and usable by the roles;
  - each table is checked against its own schema's catalog;
  - conflicts name `schema.table`;
  - `current_user_id()` stays in the default schema, and every policy calls it there.

## Consequences

- Fitness Tracker declares `account_prefs` on `fitness.prefs`, its records in `fitness_data`, and its analytics
  where they are, with no table moved.
- A later consolidation (all of an app's tables in one schema) is a settings change plus a person's move of the
  tables, with no app code changed.
