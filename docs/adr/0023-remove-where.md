# 0023. Remove every matching row of a system type

- Status: Accepted
- Date: 2026-11-19

## Context

`remove` takes one row by its key: a savepoint, a delete and an audit line each time. Removing everything a system type
holds for one subject (a person's usage analytics under their pseudonym, when they delete their account) then costs
three statements a row, thousands in one transaction, where SQL needed one. An independent review of Fitness Tracker's
account deletion found that the people with the most data would be the ones who couldn't delete.

## Decision

- **`removeWhere(type, where)`** on a unit: one delete of every row that matches, one audit line with the count, the
  rows removed returned.
- **Only in a system unit whose intent writes the type, and only for system types.** A person unit gets `system_only`;
  a person, shared or record type `system_type_only` (`records_use_apply` for records); a read-only view `read_only`.
- **`where` names at least one queryable field** (`where_required`): never a whole table by accident. The conditions
  are `find`'s.

## Consequences

- Minor version (2.6.0): nothing changes for existing callers, and no backend changes (the backends' `remove` already
  took conditions).
