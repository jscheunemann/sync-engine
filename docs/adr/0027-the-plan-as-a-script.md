# 0027. The plan as a script that checks the database itself

- Status: Accepted
- Date: 2026-11-26
- Amends: 0006, 0014 (another way to apply the same plan; the plan and `migrate` are unchanged)

## Context

`engine.plan` reads the database's catalog and lists what's missing; the owner reads it and `engine.migrate` applies
it. That takes a run of the app's code with a connection that owns the schemas. A platform that runs an app's own
migrations as plain SQL (keel, which runs them as an administrator and never runs an app's code) can't do that, so on
Fitness Tracker's stage the migrations ran and the plan never did: its system role had no grants at all, and sign-up
failed. A plan written once and kept in a file would go stale the moment it ran, because it lists only what was
missing then.

## Decision

- **`engine.script(settings)`** returns the plan as one SQL script that needs no catalog and connects to nothing: every
  step the plan could have, in the plan's order, each checking the database when it runs.
  - What makes something (a table, a function, a policy, a column on an adopted table) runs only where it's missing:
    `to_regclass`, `to_regprocedure`, `pg_policies`, `information_schema.columns`.
  - What changes nothing the second time runs every time: `create schema if not exists`, grants, row-level security on,
    `create index if not exists`.
  - Row-level security is forced only on a table this run made (a setting the making step sets for its transaction only, so a later run on the same connection can't mistake an adopted table for one it made), as the plan
    forces only what it makes (ADR 0021).
  - What the plan reports as a conflict (a column of another type, a view or a view's column missing) stops the script
    with `engine schema conflict: <schema>.<table> <column or issue>`, never a value.
  - One transaction (`begin` … `commit`): all of it or none.
- So the same file is right for any database, and safe to run after every migration: an app keeps it with its
  migrations, regenerated from its declarations and checked in CI, and a platform runs it as SQL.
- The backend may offer it (`schema.script`); Postgres does. Nothing is dropped, rewritten or narrowed, as with the plan.

## Consequences

A minor version (2.10.0): nothing changes for existing callers. Tests: `test/schema.test.ts` (the plan's steps in
order, the guards, a view checked and never made, the same text for any catalog; on Postgres: run twice then nothing
left to plan, an adopted table keeps its force setting and gains a missing column, a conflict stops it with nothing of
it kept).
