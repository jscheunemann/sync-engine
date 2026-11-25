# 0026. Sealing plain content in place

- Status: Accepted
- Date: 2026-11-25

## Context

Clearwork encrypts what people wrote at rest (its ADR 0077). Records written before encryption was set up are stored
plain, and on version 1 the app sealed them a few at a time as each person synced, with its own SQL: their content, enc
and key version changed, and nothing else, so no device saw a change. Version 2 gives an app no SQL, and every write
through `w.apply` is a change devices see (a new change number and version).

## Decision

- **`w.sealPlain(max)`**, in a person's unit: up to `max` (1 to 1,000) of the person's records stored as plain (enc 0)
  are sealed with the unit's crypto and written back in place: content, enc and key version only; no change number,
  no version, no op result. Returns how many. When the crypto keeps content plain (enc 0), it stops and returns what
  it did, so an app without encryption gets 0.
- Each backend gives the rows (`plainRows`), held until the unit ends, so two requests can't seal the same row twice.

## Consequences

A minor version (2.9.0): nothing changes for existing callers. Test: `test/contract.test.ts` (a few at a time, nothing
devices see, 0 with plain crypto, another person's left alone; SQLite and Postgres).
