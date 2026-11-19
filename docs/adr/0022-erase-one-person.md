# 0022. Erase one person

- Status: Accepted
- Date: 2026-11-18

## Context

Deleting an account used to rely on the database: every table referenced Auth's users with `on delete cascade`, so
deleting the sign-in deleted the data. That ties the apps to one database and one Auth, and it deletes data only after
Auth has gone, in someone else's table. Fitness Tracker wants the order the other way round: data first, from its own
Worker, once the person has just signed in again; the sign-in last, from a small Worker that alone holds Auth's admin
key.

## Decision

- **`erase(person, {keep?})`** on a unit: deletes every row of that person in the record types, the engine's own tables
  (applied ops, prefs, counters) and the person types the intent writes, except the types in `keep`. It returns the
  rows removed by type, and writes one audit line (`type: '*'`, `action: 'erase'`, the total) with no values.
- **Only a system intent that declares `erase: true`** may call it. A person unit gets `system_only`; another system
  intent gets `not_permitted`. The person must be a UUID (`bad_value`).
- Views are never erased through (they belong to someone else); shared and system types aren't either: what of those
  is the person's is for the app to remove with `remove`, in the same unit.
- It runs in the unit's transaction: all or nothing.
- **Grants:** when some system intent declares `erase`, the schema plan lets the system role select and delete in the
  record tables and the engine's own tables (with a delete and a read policy on the latter). Otherwise it gets neither.

## Consequences

- An app can delete a person's data before, and without, deleting the sign-in, on any backend.
- Minor version (2.5.0): nothing changes for existing callers.
