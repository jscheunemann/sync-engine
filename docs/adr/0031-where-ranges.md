# 0031. A condition can be a range: a lower and an upper bound on one field

- Status: Accepted
- Date: 2026-11-28

## Context

A `where` takes one condition a field: a value or one operator. "Workouts from 2024 to 2025" needs two on the same field,
`gte` and `lte`. A find can take the lower bound and drop rows past the upper one itself (Fitness Tracker's `between`),
but it still reads every row after the start, to the end of the history. A summary can't do even that: its groups are
computed in the database, so rows past the end are in them. Apps worked around it with an `in` of every day in the span,
which stops at 1,000 values (under three years of days).

## Decision

- **A condition can be a range**: an object with exactly one lower bound (`gt` or `gte`) and exactly one upper bound
  (`lt` or `lte`), such as `{ gte: '2024-01-01', lte: '2025-12-31' }`. Both are kept (they're ANDed, as conditions on
  different fields are), and each value is checked against the field's kind as a single operator's is.
- Anything else with more than one key is still `bad_match`: two lower bounds, two upper bounds, or a bound with another
  operator (`in`, `ne` …).
- It's the same `Cond` list the backends already take (several conditions on one column were always possible there), so
  find, count, summarize and removeWhere all take ranges, on every backend, with no backend change.

## Consequences

- Minor version (3.3.0): every `where` that worked before means the same; one that was refused (`bad_match`) for having
  a lower and an upper bound now works.
- An index on the field serves a range as it serves either bound.
