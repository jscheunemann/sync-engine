# 0015. SQLite proves the contract, as a test backend only

- Status: Accepted
- Date: 2026-11-18
- Amends: 0012 (its in-memory test backend is replaced)

## Context

ADR 0005 says every backend passes one contract suite, and that a second backend proves it. Until that second
backend exists, "the core doesn't depend on Postgres" is a claim. The owner chose to keep SQLite as a test backend
only for now, and to hold off on a rename until everything is proved.

## Decision

- **SQLite is the second backend,** in `test/sqlite-backend.ts`, on Node's built-in `node:sqlite`. It isn't in the
  package and apps can't use it.
- **The contract suites run on every backend through a rig:** a session, and the two things an operator does outside
  the engine (marking a clean-up, reading a tombstone). The suites are:
  - every case of version 1's server test;
  - isolation by the engine alone;
  - every field kind;
  - the intents for declared types.
- **SQLite's tables come from the declarations** (`engine.plan` and `engine.migrate`). The contract's one database
  rule, a title check, is added the way an operator would add it.
- **What SQLite doesn't have stays in its backend:**
  - schemas (tables by name);
  - row-level security (isolation is the engine's alone there, as ADR 0007 requires it can be);
  - Postgres types (times are ISO text, JSON and id lists are JSON text, booleans are 0/1);
  - concurrent writers (units are queued).
- **The in-memory backend from part 2 is removed:** SQLite runs in every test run, with or without Postgres.

## Consequences

- Every case passed on SQLite with no change to the engine's core. The core's rules don't lean on anything Postgres
  has, and an app built on intents moves between them with no code of its own changing.
- A real second backend for production (MariaDB, say) would start from this one. It would need its own driver,
  types, row-level security or equivalent, and a schema plan with conflicts; it would pass the same suites.
