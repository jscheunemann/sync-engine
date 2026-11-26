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

## The engine owns data access

Version 3.0.0 (ADR 0028). Install with `github:jscheunemann/sync-engine#v3.0.0`. The engine runs on Postgres.js 4, its
own dependency; version 1's `./server` is gone (apps still on it stay on 2.x).

Following `docs/adr/` 0002 onwards, an app gives the engine connection settings and intents; the engine owns the
driver, the SQL, transactions and per-person isolation. Nothing database-shaped crosses: no SQL, connection or driver
types.

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
const sql = engine.script(adminSettings);          // the same plan as SQL for any database: each step checks first, safe to rerun (ADR 0027)
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

- `w.find(type, { where, order, limit, after })` → `{ rows, next }`; `w.count(type, { where })`. A system unit may also
  filter, order and group a person type by its person column.
- `w.put(type, row)`, `w.update(type, key, changes, version?)` (`applied`, `conflict` with the current row, or
  `not_found`), `w.remove(type, key)`.
- `person` types are each person's; `shared` types are read by anyone and written by system intents; `system` types
  only by system intents. A system intent touches only the types it declares, and each intent it runs is written to
  `<schema>.engine_audit` (no values).
- `w.summarize(type, { where, by, measures, order, limit })`: groups (fields, JSON `paths`, or `{ day, zone }`) with
  `count`, `distinct`, `sum`, `avg`, `min`, `max` and `percentile`, each with its own `where` if wanted (ADR 0016).
- Kinds include `date` (a local day, `YYYY-MM-DD`); a person type with `writes: 'system'` is read by each person and
  written only by system intents (ADR 0019).
- A type can be a view the app's migrations define (`view: true`): read like any type, never written (ADR 0018).
- Postgres keeps tables in `schema`, or per type in `schemas: { type: schema }` for tables adopted elsewhere (ADR 0017).
- `w.put(type, row, { onConflict: 'update' | 'nothing' })` for insert-or-update; `w.lock(name)` for the rest of the unit.
- `w.erase(person, { keep })` in a system unit whose intent declares `erase: true`: every row of one person (ADR 0022).
- `w.removeWhere(type, where)` in a system unit, for a system type its intent writes: every matching row in one statement (ADR 0023).
- `w.hold(person)` in a system unit that writes for a person: an erase of them waits for it, as it does for their own units (ADR 0024).
- `w.attempt(fn)`: part of a unit that's undone if `fn` throws, while the rest carries on (ADR 0025): a dry run, or changes kept only if all of them go through.
- `w.sealPlain(max)`: seals up to `max` of the person's records stored before the app encrypted content, in place, so no device sees a change (ADR 0026).
- Refusals are `EngineError`s: a code and a field, never a value.

## Using it

```ts
// device
import { sync, emptyState, rebase, type Transport } from '@jscheunemann/sync-engine';
// server
import { createEngine, plain, type RecordStore, type ContentCrypto } from '@jscheunemann/sync-engine/engine';
import { postgres } from '@jscheunemann/sync-engine/postgres';
```

An app supplies:

- **`RecordStore`** (server): its record types, each type's declared fields, and its rules (`defaults`, `normalize`,
  `checkChanges`, `validate`, `crossChecks`). The engine makes and maps the tables (ADR 0014).
- **`ContentCrypto`** (server, per unit of work): how content is sealed and opened. `plain` stores it as it comes.
- **A `Transport`** (device): push, changes, and prefs over its own API (and encryption, if any). Ops carry `full`,
  the device's whole copy, for a transport that encrypts; a transport must never send it as is.
- **Hooks** (device): `fieldsOf`, and optionally `stabilize` (keep the server's precise value when the device only
  keeps a coarser copy that still agrees) and `adopt`.
- **`onPush`** (device, optional): called once before a push with how many changes it sends in all, even when they go
  in several rounds of 500, for a progress count. It changes nothing about what's sent.

## Versions

Apps install a tag: `"@jscheunemann/sync-engine": "github:jscheunemann/sync-engine#v3.0.0"`. See `CLAUDE.md` for what
counts as a breaking change.
