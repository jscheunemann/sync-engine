# 0025. An attempt inside a unit of work

- Status: Accepted
- Date: 2026-11-25

## Context

Clearwork's move to version 2 (its ADRs 0191, 0192) reaches its AI write tools. A tool's change is checked by applying
its ops and rolling them back (a dry run for the person's review), and a change the person accepts is kept only if
every op goes through: one refused op undoes the others, and the request still records that it failed. On version 1
the app did this with the driver's savepoints. Version 2 gives an app no transaction, so it had no way to undo part of
a unit and carry on.

## Decision

- **`w.attempt(fn)`** runs `fn` on the same unit, on a savepoint. If `fn` throws, everything it did is rolled back
  (records, their revs and stored op results, rows of declared types, audit lines) and the error comes back to the
  caller; the rest of the unit carries on and lands as usual. If `fn` returns, what it did stays part of the unit.
- Attempts nest. Inside one, the unit's scope, crypto and system intent are the unit's own: an attempt can do nothing
  the unit couldn't.
- Every backend already has savepoints (ops are applied one per savepoint), so this adds no backend work.

## Consequences

A minor version (2.8.0): nothing changes for existing callers. Tests: `test/intents.test.ts` (undone, kept, nested, kept
to the intent, on SQLite and Postgres) and `test/contract.test.ts` (ops in an attempt that throws leave no record, no
stored result and no rev behind).
