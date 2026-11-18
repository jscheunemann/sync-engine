# 0007. Per-person isolation is enforced by the engine

- Status: Accepted
- Date: 2026-11-18

## Context

Today a person's rows are kept apart by Postgres row-level security keyed by `current_user_id()`, set per request by
the app. Not every database has row-level security, so a portable design can't rely on it alone.

## Decision

- **The engine adds the scope's person to every read and write** of a per-person type, in its core, before a backend
  sees the intent. A backend cannot be asked for "all rows".
- **On Postgres, row-level security stays on as a second guard,** enabled and forced, set by the backend from the same
  scope. A bug in either layer alone leaks nothing.
- **The contract proves it:** every intent is tried with one person's scope against another's data, on every backend,
  and must return nothing or refuse.
- The guarantee is stated, not hidden: on a backend without row-level security, isolation rests on the engine alone.

## Consequences

- The apps stop setting `current_user_id()` and writing policies; the engine does both.
