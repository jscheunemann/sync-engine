# 0018. Views the app defines are read-only types

- Status: Accepted
- Date: 2026-11-18

## Context

Fitness Tracker's usage events are a view (`analytics.events`) that unpacks the batches devices send. Its owner
screens summarise the events, so the engine has to read the view. The view's definition is the app's SQL, kept in its
migrations, and it's no table the engine could make or write.

## Decision

- **A declared type can be `view: true`.** It's read like any type: find, count, summarize, by its declared fields and
  paths, kept to its access. Writes to it are refused (`read_only`).
- **The schema plan never makes a view:**
  - a missing view, a missing column, or a column of another type is a conflict;
  - a view gets read grants only, and no row-level security, policies or indexes, since its rows are its tables' and
    so are their policies.
- **The view stays the app's:** defined in its own migrations, and changed the way the app changes any migration.

## Consequences

- Fitness Tracker's analytics read `analytics.events` through the engine, with no SQL in the app.
- A view is the one place an app's SQL still shapes what the engine reads. It sits in migrations, not in request code,
  and the plan checks it against the declaration.
