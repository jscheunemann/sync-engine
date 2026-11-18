# 0011. Version 2.0.0, and moving the apps one at a time

- Status: Proposed
- Date: 2026-11-18

## Decision

- **0002 to 0010 ship as version 2.0.0**, a major version by the engine's rules. Version 1 gets fixes only, until both
  apps have moved.
- **Order of work:**
  1. Fitness Tracker moves from its pinned commit (the v1.0.0 era) to **v1.3.1** on its current driver, on its own,
     so a later failure has one cause.
  2. The engine builds v2: core and intents, the Postgres backend on Postgres.js 3 and 4, declarations and migration
     plans, isolation, the contract suite, and the SQLite backend for the contract only.
  3. **Fitness Tracker moves to v2** on staging first, then production, with its existing tests and its preview.
  4. **Clearwork moves to v2** the same way. Its beta gate's "runs on Postgres.js 4" is then met by the engine.
  5. Dotline starts on v2.
- **Apps pin a version tag** (`#v2.x.y`), never a commit. Dependabot proposes engine updates like any other package;
  a minor or patch release needs no app change.
- **The Dependabot rule holding postgres majors** (Clearwork ADR 0185, and the same for Fitness Tracker now) is removed
  when each app is on v2, because the apps no longer depend on the driver.

## Consequences

- Fitness Tracker PR #126 is closed, and its Dependabot ignores postgres majors until step 3.
- The apps' own ADRs record their move (one each), pointing here.
