# 0030. Group a summary by a date's year, quarter, month, week, weekday or hour

- Status: Accepted
- Date: 2026-11-27

## Context

A summary (ADR 0016) groups by a field, or by a time's local day in a zone. An app answering "workouts by type and year"
or "resting heart rate by month" over years of history has only those: grouping by day gives thousands of groups, past
`FIND_MAX` (1,000), and the app adds them up itself, which is slow and, at the limit, silently incomplete. Storing a year,
a month and a week column on every row would work without the engine, but each is wrong as soon as the date it comes from
is corrected (Fitness Tracker: a workout's time zone fixed after the fact), so the parts belong to the query, as the day
does.

## Decision

- **A group can be a part of a date or a time**: `{ part, field, zone?, as? }`, `part` one of `year`, `quarter`, `month`,
  `week`, `weekday`, `hour`.
  - On a **`date`** field: the date as it is (already a local date), no zone (`zone` given is `bad_zone`); every part but
    `hour` (`not_a_time`).
  - On a **`time`** field: its local date and time in `zone`, which is required (`bad_zone` without a known one), as the
    day group's.
  - Any other kind is `not_a_date`.
- **What a part is**, the same on every backend, so groups sort and compare as written:
  - `year`: the year, an integer (`2026`);
  - `quarter`: `'2026-Q4'`;
  - `month`: `'2026-11'`;
  - `week`: the Monday its ISO week starts, `'2026-11-23'` (a date, so a week across a new year stays one week);
  - `weekday`: 1 (Monday) to 7 (Sunday), ISO;
  - `hour`: 0 to 23.
- `as` defaults to `<field>_<part>`; ordering by it is allowed, as by any group.
- **Backends get `{ part, col, zone?, as }`** in `SummaryQuery.by`. Postgres computes it in the summary's subquery
  (`extract`, `to_char`, `date_trunc('week', …)` on a timestamp without a zone, so the session's zone never enters);
  SQLite, the contract's second backend, in the same place it computes a day.

## Consequences

- Minor version (3.2.0): existing groups are unchanged. A backend outside this package would need the parts; both
  backends are the engine's own (ADRs 0004, 0015).
- Grouping by a part reads the rows a summary's conditions keep, as any group does: an app keeps a multi-year summary fast
  with an index on what it filters by, not on the part.
