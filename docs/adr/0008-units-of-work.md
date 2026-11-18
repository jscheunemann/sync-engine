# 0008. Units of work replace shared transactions

- Status: Accepted
- Date: 2026-11-18

## Decision

- **An app never holds a transaction.** A call that must change several things together runs as
  `engine.work(scope, async (w) => { … })`: the intents inside see each other's writes and land together or not at
  all.
- **Inside a unit, each synced op still runs in its own savepoint**, as today, so one bad op never holds up the others.
- **The app's rules run inside the unit as plain functions** given what the intents return (`validate`,
  `crossChecks`, hooks): no database access of their own.
- **Retries are the engine's**: a serialization failure or a dropped connection inside a unit is retried a bounded
  number of times, because every op is idempotent by `op_id`.

## Consequences

- Clearwork's "one write path through `applyOp`" (its ADR 0068) becomes the engine's rule for every app.
