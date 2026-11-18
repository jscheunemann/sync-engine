# 0013. One Postgres backend for driver majors 3 and 4; the pin moves at 2.0.0

- Status: Accepted
- Date: 2026-11-18

## Context

Postgres.js 4 rewrote everything below its public API. For this engine the changes that matter are:

- the server types every parameter;
- the TypeScript types are named ES exports;
- transactions are stricter;
- Workers connect through `cloudflare:sockets`.

Version 1's `./server` takes each app's own driver, and its published types name the driver's types. Version 2's
backend owns the driver (ADR 0004).

## Decision

- **The backend types the driver itself:** a small interface for the calls it makes, which Postgres.js 3 and 4 both
  have. It doesn't use the driver's types, so it builds and runs on either.
  - A savepoint is the driver's `savepoint`, or on 4 a nested `begin`.
  - Removed rows are counted from `returning`, not from a result's `count`.
  - Every parameter's type is set by its column or by a cast in the SQL, never by the JavaScript value.
- **CI runs version 2's tests on both majors:** the main job on the pinned 3.4.9, the `driver` job on 4 (type-check
  and tests).
- **The pin stays 3.4.9 until 2.0.0.** Pinning 4 earlier would hand apps still on `./server` a second, different
  driver's types. At 2.0.0, when the apps no longer use `./server`, the pin moves to 4 with nothing else to change.

## Consequences

- Fitness Tracker's Postgres.js 4 upgrade (its PR 126) stops mattering to the engine once it's on version 2: the app
  won't use the driver for the engine at all.
- A future driver major is the same work: keep the backend's interface to what both versions have, and run the
  `driver` job on the new one.
