# 0028. Version 3: the engine runs on Postgres.js 4, and version 1's `./server` is gone

- Status: Accepted
- Date: 2026-11-25
- Amends: 0013 (when the pin moves)

## Context

ADR 0013 made the Postgres backend work on driver majors 3 and 4, and kept the pin at 3.4.9 while any app still used
version 1's `./server`, which takes the app's own driver and names its types. Clearwork's Worker no longer imports
`./server` or the driver (its ADR 0194); Fitness Tracker reaches the database only through version 2's engine and
imports nothing from `./server` but types. The pin didn't move at 2.0.0, as 0013 planned, because `./server` was still
in the package.

## Decision

- **Version 3.0.0 pins Postgres.js 4.1.1** as the engine's own dependency (ADR 0004). Apps don't install it.
- **`./server` is removed**, with its test. Everything it did is in version 2's API (`w.apply`, `w.changes`,
  `w.prefs`), whose contract test ran every case of `./server`'s test (ADR 0015). Its types (`RecordStore`,
  `StoredRecord`, `ContentCrypto`, …) come from `./engine`.
- **CI's `driver` job now runs on 3**, so the backend keeps working on both majors (0013): the main job on the pin, 4.
- It's a major version: what an app imports changes, and the driver under every unit of work changes. It waits for the
  owner, and each app moves to it on its own preview first.

## Consequences

- An app on `./server` stays on 2.x until it moves to the engine.
- An app moving to 3.0.0 changes its type imports from `./server` to `./engine`; nothing it sends or stores changes.
- The README describes version 2's API only.
