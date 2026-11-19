# 0021. Adopted tables keep their own force setting

- Status: Accepted
- Date: 2026-11-18
- Amends: 0014 (what the schema plan does to row-level security on a table that's already there)

## Context

The schema plan turned row-level security on and forced it on every declared table. Fitness Tracker leaves it unforced
on purpose on some tables (sign-up settings, invitations, members, admins), so that what runs as their owner sees
every row. That's Auth's sign-up hook, which reads the sign-up switch and the invitations, and the trigger that adds a
member when an invitation is used. Forced, the hook saw no row and refused every sign-up. Fitness Tracker's API tests
caught it on the first run with the plan applied.

The engine never connects as a table's owner. Its units run as the person role or the system role, so forcing adds
nothing to the engine's own isolation.

## Decision

- **On a table that's already there, the plan turns row-level security on if it's off, and leaves forcing as the
  app's migrations set it.**
- **On a table the plan makes, it turns it on and forces it, as before.**

## Consequences

- Adopting an app's tables can't take away what its owner-run code relies on.
- An app that wants forcing on an adopted table sets it in its own migration, as its rules require (Clearwork and
  Dotline force it on every table; the plan leaves that as it is too).
