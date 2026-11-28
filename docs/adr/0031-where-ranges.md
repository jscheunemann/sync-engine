# 0031. Ranges in conditions, and measures over any number column

- Status: Accepted
- Date: 2026-11-28

## Context

Two limits stood in the way of an app answering "calories by activity and year, 2024 to 2025" in one summary:

- **A `where` took one condition per field**: a value or one operator. A span needs two on the same field, `gte` and
  `lte`. A find can take the lower bound and drop rows past the upper one itself (Fitness Tracker's `between`), but it
  still reads every row after the start, to the end of the history. A summary can't do even that: its groups are
  computed in the database, so rows past the end are in them. Apps worked around it with an `in` of every day in the
  span, which stops at 1,000 values, under three years of days.
- **A measure took only a query field**, the fields a find filters and orders by, each of which the schema plan
  indexes. Summing calories or averaging a workout's heart-rate drift meant declaring each such column a query field,
  with an index nobody filters by: Fitness Tracker's workout metrics have about 45 of them.

## Decision

- **A condition can be a range**: an object with exactly one lower bound (`gt` or `gte`) and exactly one upper bound
  (`lt` or `lte`), such as `{ gte: '2024-01-01', lte: '2025-12-31' }`. Both are kept (ANDed, as conditions on different
  fields are), and each value is checked against the field's kind as a single operator's is.
  - Anything else with more than one key is still `bad_match`: two lower bounds, two upper bounds, or a bound with
    another operator (`in`, `ne` …).
  - It's the same `Cond` list the backends already take (several conditions on one column always worked there), so
    find, count, summarize and removeWhere take ranges on every backend with no backend change.
- **A summary's `sum`, `avg`, `min`, `max` and `percentile` can measure any `number` or `integer` column of a declared
  type**, a query field or not. A measure reads the rows the summary's conditions keep, so it needs no index of its
  own.
  - Filters, order, groups and `distinct` still take query fields only, as does any measure over another kind (`min`
    of a date, say).
  - Record types are unchanged: their fields can be content, and stay measured through their query fields.
  - A declared type's sealed fields are `json` (checked when the engine is made), so a number column is never sealed.

## Consequences

- Minor version (3.3.0): every `where` and every measure that worked before means the same. A `where` that was refused
  (`bad_match`) for having a lower and an upper bound now works, and so does a measure over a declared type's number
  column that isn't a query field (`not_queryable` before).
- An index on a field serves a range as it serves either bound. What a summary measures is never indexed for it; what
  it filters by should be.
