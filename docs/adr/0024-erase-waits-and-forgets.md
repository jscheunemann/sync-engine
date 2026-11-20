# 0024. An erase waits for the person's open work, and takes them out of the audit

- Status: Accepted
- Date: 2026-11-19
- Amends: 0022

## Context

Two things an independent review of Fitness Tracker's account deletion found left after an erase (ADR 0022):

- **A write could land after it.** An app checks that a person may write, then writes in a unit of its own. A unit that
  had passed the check when the erase committed could still write afterwards, and nothing would remove that row.
- **The audit kept naming the person.** Every audit line a person caused carries their id, for good, the erase's own
  line included.

## Decision

- **Where some system intent declares `erase`, a person's own units and an erase of that person exclude each other.**
  Each person unit takes a lock for that person, shared with their other units, as it starts; `erase` takes it alone.
  So an erase waits for the person's open units to end, and removes what they wrote; a unit of theirs that starts
  while an erase is open waits for it to end. Their units never wait for each other, and nobody else's are affected.
  On Postgres: transaction advisory locks, one more statement at the start of a person unit, only where `erase` is
  declared.
- **`hold(person)`** in a system unit takes the same shared lock: for a system intent that writes on a person's
  behalf (their usage analytics, say). It needs no declaration and writes no audit line.
- **The engine doesn't decide what an erased person may do next.** The app reads whatever marks them (its own row)
  inside the unit, after the lock: that read then always sees a finished erase.
- **`erase` clears who caused each audit line the person caused**, its own included when they erase themselves. The
  lines stay, with their counts. On Postgres the system role may still only add audit lines: the clearing is one
  function, `forget_person(uuid)`, with its owner's rights, that the plan makes and grants to the system role alone,
  and only where `erase` is declared.

## Consequences

- After an erase commits, nothing of the person's is left, and nothing can arrive, provided the app checks its mark in
  the unit. Lines the app's later system units cause in that person's name are the app's to avoid (no `by`), or a last
  `erase` clears them.
- Minor version (2.7.0): nothing changes for callers that declare no `erase`.
