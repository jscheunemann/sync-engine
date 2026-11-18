# 0001. Record the engine's decisions here

- Status: Proposed
- Date: 2026-11-18
- Origin: Fitness Tracker PR #126 (Postgres.js 3 → 4) failed at `npm install` on the engine's peer dependency, as
  Clearwork #101 had. Reviewing why led the owner to ask for the engine to be redesigned as loosely coupled.

## Decision

The engine keeps its own ADR log in `docs/adr/`, numbered from 0001, append-only, with the same rules as the apps'
logs. A decision about how apps and the engine meet is recorded here; each app records only how it adopts it.

## Consequences

`CLAUDE.md` gains a rule: an architectural judgment call is a new ADR in the same change.
