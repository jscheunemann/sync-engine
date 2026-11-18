# 0005. One contract suite every backend passes; a second backend proves it

- Status: Proposed
- Date: 2026-11-18

## Decision

- **The contract is a test suite in the engine** that runs every intent against a real database through a backend:
  sync's merge and conflict rules, idempotent ops, the change feed and purge, bulk paths, queries, units of work,
  schema migration, and isolation (0007), including attempts to read or write across people.
- **Every backend passes it in CI**, on every database version and driver version it supports (for Postgres: 16, 17
  and 18; Postgres.js 3 and 4).
- **A second backend proves the design: SQLite** (and through it, Cloudflare D1). It is cheap to run and different
  enough from Postgres (no schemas, no row-level security, other types) to expose any Postgres assumption in the core.
  **It is a test of the boundary only, never a production target** (the owner, 2026-11-18); making it one would be a new
  ADR. MariaDB can follow the same way if it is ever wanted.

## Consequences

- "Swap the database without touching the apps" is checked on every change: the same app-facing tests pass on two
  unlike backends.
- The in-memory server the device tests use today stays for fast device tests; it is not a backend.
