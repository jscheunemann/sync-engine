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

## Version 2: the engine owns data access

Version 2.0.0 (ADR 0011). Install with `github:jscheunemann/sync-engine#v2.0.0`. Version 1's `./server` is still in the
package, unchanged, for apps that haven't moved yet.

Following `docs/adr/` 0002 to 0016, an app gives the engine connection settings and intents; the engine owns the
driver, the SQL, transactions and per-person isolation. Nothing database-shaped crosses: no SQL, connection or driver
types. Part 1: the core and the Postgres backend, on today's tables. Part 2: declared types, find and count, and
system intents with their audit (ADR 0012). Part 3: one backend for Postgres.js 3 and 4 (ADR 0013). Part 4:
records and tables from declarations (ADR 0014). Part 5 (this): SQLite, a test backend, passes the same contract
(ADR 0015).

```ts
import { createEngine } from '@jscheunemann/sync-engine/engine';
import { postgres } from '@jscheunemann/sync-engine/postgres';

const engine = createEngine({ store, backend: postgres });                       // once
const session = engine.connect({ url: env.HYPERDRIVE.connectionString, schema: 'app' }); // per request
const results = await session.work({ person }, (w) => w.apply(ops), { crypto }); // a unit of work
const page = await session.work({ person }, (w) => w.changes(since, 500));
ctx.waitUntil(session.close());
```

A record type is declared, not mapped: the engine stores it.

```ts
const store: RecordStore<'tasks'> = {
  types: ['tasks'],
  fields: { tasks: { title: 'text', size: 'integer', due: 'json', tags: 'ids', notes: { kind: 'text', content: true } } },
  validate: (type, fields, id, { sealed }) => [],   // the app's rules; defaults, checkChanges, normalize, crossChecks optional
};
const plan = await engine.plan(adminSettings);    // the steps and any conflicts, to read; changes nothing
await engine.migrate(adminSettings, plan);        // refused if out of date or conflicted; all steps or none
```

- `w.apply(ops)` applies ops with version 1's rules; all new records, or all plain deletes, go in bulk by themselves.
- `w.changes`, `w.get`, `w.getMany`, `w.prefs.get` / `w.prefs.put`; everything in one `work` lands together.
- An app's hooks get a reader, never a connection: `crossChecks(read, …)`, `ContentCrypto.prepare(read)`.
- The Postgres driver is the engine's own dependency: apps don't install or upgrade it for the engine.
- `test/contract.test.ts` runs every case of version 1's server test through this API, isolation by the engine alone,
  and every field kind, on Postgres and on SQLite (`test/sqlite-backend.ts`, tests only); `test/intents.test.ts` the
  intents for declared types on both.

Tables the app's server writes are declared, and reached by intents on declared fields only:

```ts
const engine = createEngine({
  store, backend: postgres,
  types: {
    data_keys: { access: 'person', key: ['version'], fields: { version: 'number', wrapped: 'text', created_at: 'time' } },
    invitations: { access: 'system', key: ['id'], fields: { id: 'id', code: 'text', email: 'text', redeemed_at: 'time' }, query: ['code'] },
    signup_settings: { access: 'shared', key: ['id'], fields: { id: 'id', open: 'boolean' } },
  },
  system: { redeem_invitation: { write: ['invitations'] } },
});
const session = engine.connect({ url, role: 'app_api', systemRole: 'app_system' });
await session.work({ person }, (w) => w.find('data_keys', { order: '-version', limit: 1 }));
await session.work({ system: 'redeem_invitation' }, (w) => w.find('invitations', { where: { code, redeemed_at: { is: null } } }));
```

- `w.find(type, { where, order, limit, after })` → `{ rows, next }`; `w.count(type, { where })`.
- `w.put(type, row)`, `w.update(type, key, changes, version?)` (`applied`, `conflict` with the current row, or
  `not_found`), `w.remove(type, key)`.
- `person` types are each person's; `shared` types are read by anyone and written by system intents; `system` types
  only by system intents. A system intent touches only the types it declares, and each intent it runs is written to
  `<schema>.engine_audit` (no values).
- `w.summarize(type, { where, by, measures, order, limit })`: groups (fields, JSON `paths`, or `{ day, zone }`) with
  `count`, `distinct`, `sum`, `avg`, `min`, `max` and `percentile`, each with its own `where` if wanted (ADR 0016).
- `w.put(type, row, { onConflict: 'update' | 'nothing' })` for insert-or-update; `w.lock(name)` for the rest of the unit.
- Refusals are `EngineError`s: a code and a field, never a value.

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
- **`onPush`** (device, optional, 1.1.0): called once before a push with how many changes it sends in all, even when
  they go in several rounds of 500, for a progress count. It changes nothing about what's sent.
- **`applyCreates`** (server, 1.2.0): many ops at once, for a restore. New records whose ids aren't known yet are
  checked as `applyOp` checks a create and written with one insert per type (500 rows at a time), revs in one block,
  each result kept for repeats; everything else goes through `applyOp`, so every op's outcome is what `applyOp` would
  give. `RecordStore.bulkSafe(type)` says which types may go in bulk (a type whose `crossChecks` look at other new rows
  answers false).
- **`applyDeletes`** (server, 1.3.0): many deletes at once, for clearing all data. A plain delete of a record that's
  there, live and at the version the device saw is checked as `applyOp` checks it and tombstoned with one update per
  type (500 rows at a time), revs in one block, each result kept; everything else goes through `applyOp`.

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
