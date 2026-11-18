# 0019. Dates, and person types people only read

- Status: Accepted
- Date: 2026-11-18

## Context

Fitness Tracker keeps local calendar days in Postgres `date` columns: a snapshot's day, the day of a daily analytics
row, the day a change was sent for review. Dotline's days are local dates too. A `text` field doesn't fit them: the
plan reports a conflict, and the driver hands a date back as a timestamp.

Some of Fitness Tracker's tables are each person's to read but never to write: their membership, whether they're an
owner. Only owner actions change those rows. A `person` type grants its role writes, which would loosen what the
database allows today.

## Decision

- **A `date` kind.** It's a local calendar day, `YYYY-MM-DD`, and only a real one. It's stored as `date` (text on
  SQLite) and comes back as the same ten characters, whatever the driver returns. Finds, order, comparisons and
  `min`/`max` work on it.
- **`writes: 'system'` on a person type.** Each person finds and counts their own rows, and only a system intent puts,
  updates or removes them (`system_only` otherwise).
  - The plan gives the person role read grants only, and a read policy (`engine_person_read`) instead of
    `engine_person`.
  - A system intent changing such a row names its person in the key, as it does for any person type.

## Consequences

- Fitness Tracker's snapshots, daily analytics and review days, and its memberships and owner flags, move with no
  table changed and no grant widened.
- Dotline's days use the same kind.
