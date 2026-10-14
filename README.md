# sync-engine

Record sync for local-first apps on Postgres, shared by Clearwork and Fitness Tracker. Every device keeps a full copy
of a person's data and works offline; this keeps the devices and the server in step without losing an edit.

## The model

**Records.** Data is a set of records, each with a type, an id made on the device (UUIDv7, so a record created offline
never needs renaming) and its fields. The server keeps one row per record, in a table per type, with sync columns:

| Column | Meaning |
| --- | --- |
| `version` | How many times the row has changed. A write names the version it was based on; any other version is a **conflict** (optimistic concurrency). |
| `rev` | The person's change counter at the row's last change (one counter per person, `next_rev()`). A device's **cursor** is the highest rev it has seen. |
| `client_updated_at` | When the change was made on the device. When both sides changed a field, the later change wins. |
| `deleted_at` | A **tombstone**. Rows are never deleted by the API, so a deletion reaches every device. |
| `content`, `enc`, `key_version` | What people wrote, so an app can encrypt it at rest or end to end without changing columns. |

**Ops.** A device sends changes as ops (`POST /sync/push`): create (`base_version: null`), change or delete
(`base_version: n`), or bring back a tombstone. Each op has its own `op_id`; the server stores every result by it, so
an op sent twice (a retry after a dropped connection) is applied once. Each op is applied in its own savepoint, so one
bad record never holds up the others: it comes back `invalid` with problems (a field and a code, never a value).

**The change feed.** `GET /sync/changes?since=<cursor>` returns every record changed after the cursor, in rev order, a
page at a time. When old tombstones have been cleaned up, a cursor older than the clean-up gets `410`; the device then
reads everything again from 0 and drops what the server no longer has.

**On the device** (`sync()`), each round:

1. **Outbox by comparison.** The device keeps a base copy of every record as the server last had it. Whatever differs
   from its base is sent, so no edit is missed whichever screen made it, even offline. The first time a record is seen
   changed is its `client_updated_at`.
2. **Push before pull.** A conflict comes back with the server's copy; the device merges it with its own **field by
   field** against the base (`merge3`) and sends the result again:
   - a field changed on one side takes that side;
   - a field changed on both takes the later change (the server's on a tie);
   - a deletion beats an older edit; an edit made after the deletion brings the record back.
3. **Pull** every change after the cursor and merge it the same way into anything edited locally.
4. **Prefs**: settings and app state that isn't a record are one versioned document per person, merged key by key
   into nested objects (this device's change wins a tie).

A record the server refused stays on the device, is reported, and isn't sent again until it changes. A sync that
stops (offline, signed out) keeps what it did and finishes next time. Edits made while a sync was running are kept
(`rebase`, field by field).

**A new device pulls first**, and an app can adopt server records that are the same as ones the device made
(`adopt`, e.g. `adoptByName('contexts', 'name')`) so defaults don't appear twice.

## Using it

```ts
// device
import { sync, emptyState, rebase, type Transport } from '@jscheunemann/sync-engine';
// server (needs the `postgres` package)
import { applyOp, readChanges, getPrefs, putPrefs, plain, type RecordStore } from '@jscheunemann/sync-engine/server';
```

An app supplies:

- **`RecordStore`** (server): its schema name, record types, each type's fields, defaults, rules (`normalize`,
  `validate`, `crossChecks`) and how a type maps to its table's columns (`toColumns`, `toRecord`).
- **`ContentCrypto`** (server, per request): how content is sealed and opened. `plain` stores it as it comes.
- **A `Transport`** (device): push, changes, and prefs over its own API (and encryption, if any). Ops carry `full`,
  the device's whole copy, for a transport that encrypts; a transport must never send it as is.
- **Hooks** (device): `fieldsOf`, and optionally `stabilize` (keep the server's precise value when the device only
  keeps a coarser copy that still agrees) and `adopt`.

### Tables

In the app's schema, with row-level security enabled and forced, every policy `user_id = <current user>`:

```sql
create table <schema>.counters (user_id uuid primary key default <current user>, rev bigint not null default 0, purged_rev bigint not null default 0);
create function <schema>.next_rev() returns bigint language sql volatile as $$
  insert into <schema>.counters as c (user_id, rev) values (<current user>, 1)
  on conflict (user_id) do update set rev = c.rev + 1 returning c.rev $$;
create table <schema>.applied_ops (user_id uuid not null default <current user>, op_id uuid not null, result jsonb not null,
  created_at timestamptz not null default now(), primary key (user_id, op_id));
create table <schema>.prefs (user_id uuid primary key default <current user>, data jsonb not null default '{}',
  version integer not null default 1, updated_at timestamptz not null default now());
-- and a table per record type:
create table <schema>.<type> (user_id uuid not null default <current user>, id uuid not null,
  rev bigint not null, version integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  client_updated_at timestamptz, deleted_at timestamptz,
  content jsonb not null default '{}', enc smallint not null default 0, key_version integer not null default 0,
  -- the type's own columns
  primary key (user_id, id));
create index on <schema>.<type> (user_id, rev);
```

`test/server.test.ts` builds exactly this and runs the model against it.

## Versions

Apps install a tag: `"@jscheunemann/sync-engine": "github:jscheunemann/sync-engine#v1.0.0"`. See `CLAUDE.md` for what
counts as a breaking change.
