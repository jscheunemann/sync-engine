# 0032. Bounds on any number column

- Status: Accepted
- Date: 2026-11-28

## Context

ADR 0031 let a summary measure any `number` or `integer` column of a declared type, so that a type with dozens of such
columns didn't need an index on each one. But a filter on one of them was still refused. Fitness Tracker's question
"easy runs with an average heart rate between 120 and 150, by month" had two options. It could declare `avg_hr` a query
field, which gives it an index that serves nothing the app looks up. Or it could read every row and drop the ones
outside the range itself, which is the cost that summaries exist to avoid.

A bound on such a column doesn't need an index any more than a measure does. The rows a query reads are found by its
other conditions: the person, a date range, a kind. A bound only drops some of them on the way.

## Decision

- **A `find`, `count` or `summarize` `where`, and a measure's own `where`, can bound any `number` or `integer` column
  of a declared type**, whether or not it's a query field. A bound is any of these:
  - `gt`, `gte`, `lt` or `lte`;
  - a range of one lower and one upper bound (ADR 0031);
  - `is: null` or `not: null`.
- **Conditions that look rows up by the column's value still need a query field:** a bare value, `eq`, `in`, `nin` and
  `ne` are `not_queryable`. So are order, groups and `distinct`, as before. A query field is what says "rows are found
  by this", and the schema plan indexes it.
- **These stay as before:**
  - `removeWhere` takes query fields only, so what a system intent may delete by is declared.
  - Record types are unchanged.
  - Columns of other kinds are unchanged.
- **A bound is checked like any condition:** a value that doesn't fit the column's kind is `bad_value`, and two
  lower bounds are `bad_match`.

## Consequences

- **Minor version (3.4.0).** Every `where` that worked before means the same. A bound that was refused
  (`not_queryable`) now works.
- **Cost:** a bound on a column without an index is checked on the rows the other conditions read. It's cheap when
  those conditions are selective, such as a person's rows in a date range. With nothing else to narrow the rows, it
  reads all of the person's rows, so an app should pair it with an indexed condition.
