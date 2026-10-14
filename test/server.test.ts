// The server half against Postgres, and two devices syncing through it. Needs TEST_DATABASE_URL (a database this test
// may create a schema in); skipped without it.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import { emptyState, key, sync, type Recs, type SyncState } from '../src/device.ts';
import { uuidv7 } from '../src/ids.ts';
import { checkOp, type Fields, type Op, type Transport } from '../src/protocol.ts';
import { applyOp, CursorExpired, getPrefs, plain, putPrefs, readChanges, type RecordStore, type Row, type StoredRecord, type Tx } from '../src/server.ts';

const URL_ = process.env.TEST_DATABASE_URL;
const SCHEMA = 'se_test';
type T = 'notes';

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const STORE: RecordStore<T> = {
  schema: SCHEMA,
  types: ['notes'],
  isType: (t): t is T => t === 'notes',
  fieldNames: () => ['title', 'body', 'pinned'],
  contentFields: () => ['body'],
  defaults: () => ({ title: null, body: null, pinned: false }),
  checkChanges: (_t, changes) => Object.keys(changes).filter((k) => !['title', 'body', 'pinned'].includes(k)).map((field) => ({ field, code: 'unknown' })),
  normalize: (_t, f) => ({ ...f, title: typeof f.title === 'string' ? f.title.trim() : f.title }),
  validate: (_t, f) => (typeof f.title === 'string' && f.title ? [] : [{ field: 'title', code: 'required' }]),
  toColumns: (_t, f) => ({ title: f.title, pinned: f.pinned, content: f.body == null ? {} : { body: f.body } }),
  toRecord: (_t, row: Row): StoredRecord => {
    const content = (row.content ?? {}) as Row;
    return {
      id: String(row.id), version: Number(row.version), rev: Number(row.rev), created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)!,
      client_updated_at: iso(row.client_updated_at), deleted_at: iso(row.deleted_at), enc: Number(row.enc ?? 0), key_version: Number(row.key_version ?? 0),
      title: row.title ?? null, body: content.body ?? null, pinned: row.pinned ?? false,
    };
  },
};

const DDL = `
drop schema if exists ${SCHEMA} cascade;
create schema ${SCHEMA};
create function ${SCHEMA}.current_user_id() returns uuid language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create table ${SCHEMA}.counters (user_id uuid primary key default ${SCHEMA}.current_user_id(), rev bigint not null default 0, purged_rev bigint not null default 0);
create function ${SCHEMA}.next_rev() returns bigint language sql volatile as $$
  insert into ${SCHEMA}.counters as c (user_id, rev) values (${SCHEMA}.current_user_id(), 1)
  on conflict (user_id) do update set rev = c.rev + 1 returning c.rev $$;
create table ${SCHEMA}.applied_ops (user_id uuid not null default ${SCHEMA}.current_user_id(), op_id uuid not null, result jsonb not null, created_at timestamptz not null default now(), primary key (user_id, op_id));
create table ${SCHEMA}.prefs (user_id uuid primary key default ${SCHEMA}.current_user_id(), data jsonb not null default '{}', version integer not null default 1, updated_at timestamptz not null default now());
create table ${SCHEMA}.notes (
  user_id uuid not null default ${SCHEMA}.current_user_id(), id uuid not null,
  rev bigint not null, version integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  client_updated_at timestamptz, deleted_at timestamptz,
  content jsonb not null default '{}', enc smallint not null default 0, key_version integer not null default 0,
  title text check (length(title) <= 40), pinned boolean not null default false,
  primary key (user_id, id));
create role se_api nologin;
grant usage on schema ${SCHEMA} to se_api;
grant select, insert, update on all tables in schema ${SCHEMA} to se_api;
grant execute on all functions in schema ${SCHEMA} to se_api;
`;
const RLS = ['counters', 'applied_ops', 'prefs', 'notes']
  .map((t) => `alter table ${SCHEMA}.${t} enable row level security; alter table ${SCHEMA}.${t} force row level security;
  create policy own on ${SCHEMA}.${t} for all to se_api using (user_id = ${SCHEMA}.current_user_id()) with check (user_id = ${SCHEMA}.current_user_id());`)
  .join('\n');

describe('server, against Postgres', { skip: !URL_ && 'TEST_DATABASE_URL not set' }, () => {
  let sql: postgres.Sql;
  const A = uuidv7(), B = uuidv7();

  /** One request for a person: a transaction as the API role, with their id set. */
  const as = <R>(user: string, fn: (tx: Tx) => Promise<R>): Promise<R> =>
    sql.begin(async (tx) => {
      await tx`set local role se_api`;
      await tx`select set_config('app.user_id', ${user}, true)`;
      return fn(tx);
    }) as Promise<R>;
  const push = (user: string, ops: Op[]) =>
    as(user, async (tx) => {
      const now = new Date().toISOString();
      const out = [];
      for (const raw of ops) {
        const c = checkOp(raw, STORE.isType);
        out.push('op' in c ? await applyOp(tx, STORE, plain, c.op, now) : { op_id: c.op_id ?? '', status: 'invalid' as const, problems: c.problems });
      }
      return out;
    });
  const transport = (user: string): Transport<T> => ({
    // like a real transport, send each op without `full` (the device's whole copy, for a transport that encrypts)
    push: (ops) => push(user, ops.map(({ full: _full, ...op }) => op)),
    changes: (since) => as(user, (tx) => readChanges(tx, STORE, plain, since, 2)),
    getPrefs: () => as(user, (tx) => getPrefs(tx, SCHEMA, plain)),
    putPrefs: async (data, base) => {
      const r = await as(user, (tx) => putPrefs(tx, SCHEMA, plain, data, base));
      if ('problems' in r) throw new Error('invalid');
      return r as { data: Fields; version: number } | { conflict: { data: Fields; version: number } };
    },
  });

  before(async () => {
    sql = postgres(URL_!, { max: 2, onnotice: () => {} });
    await sql.unsafe(`drop role if exists se_api`).catch(async () => {
      await sql.unsafe(`drop owned by se_api; drop role se_api`);
    });
    await sql.unsafe(DDL + RLS);
  });
  after(async () => {
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade; drop owned by se_api; drop role if exists se_api`);
    await sql.end();
  });

  test('create, change at the right version, refuse a stale one with the current copy', async () => {
    const id = uuidv7();
    const [c] = await push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: null, fields: { title: ' Hello ', body: 'secret words' } }]);
    assert.equal(c!.status, 'applied');
    const rec = (c as { record: StoredRecord }).record;
    assert.deepEqual([rec.version, rec.title, rec.body, rec.pinned], [1, 'Hello', 'secret words', false], 'defaults, normalize and content round-trip');
    const [u] = await push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: 1, fields: { pinned: true } }]);
    assert.equal((u as { record: StoredRecord }).record.version, 2);
    assert.equal((u as { record: StoredRecord }).record.body, 'secret words', 'unchanged fields are kept');
    const [stale] = await push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: 1, fields: { title: 'late' } }]);
    assert.equal(stale!.status, 'conflict');
    assert.equal((stale as { current: StoredRecord }).current.version, 2);
    const [again] = await push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: null, fields: { title: 'dup id' } }]);
    assert.equal(again!.status, 'conflict', 'creating an id that exists is a conflict');
  });

  test('an op sent twice is applied once; unknown records, bad values and database rules are reported on the op', async () => {
    const op: Op = { op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: null, fields: { title: 'once' } };
    const [first, second] = [(await push(A, [op]))[0]!, (await push(A, [op]))[0]!];
    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'duplicate');
    assert.equal((second as { record: StoredRecord }).record.rev, (first as { record: StoredRecord }).record.rev);
    const results = await push(A, [
      { op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: 3, fields: { title: 'x' } },
      { op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: null, fields: { title: '' } },
      { op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: null, fields: { colour: 'red', title: 't' } },
      { op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: null, fields: { title: 'x'.repeat(41) } },
      { op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: null, fields: { title: 'still applied after the others' } },
    ]);
    assert.deepEqual(results.map((r) => r.status), ['not_found', 'invalid', 'invalid', 'invalid', 'applied']);
    assert.deepEqual((results[3] as { problems: unknown[] }).problems, [{ field: 'notes_title_check', code: 'db_rule' }]);
    assert.deepEqual(checkOp({ op_id: 'x', type: 'tasks', id: 'y', extra: 1 }, STORE.isType), {
      problems: [{ field: 'extra', code: 'unknown' }, { field: 'op_id', code: 'type' }, { field: 'type', code: 'not_allowed' }, { field: 'id', code: 'type' }],
      op_id: undefined,
    });
  });

  test('deleting leaves a tombstone, and an op can bring it back; one person never sees another’s records', async () => {
    const id = uuidv7();
    await push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: null, fields: { title: 'temp' } }]);
    const [d] = await push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: 1, delete: true }]);
    assert.ok((d as { record: StoredRecord }).record.deleted_at);
    const [r] = await push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: 2, delete: false }]);
    assert.equal((r as { record: StoredRecord }).record.deleted_at, null);
    const [other] = await push(B, [{ op_id: uuidv7(), type: 'notes', id, base_version: 3, fields: { title: 'not mine' } }]);
    assert.equal(other!.status, 'not_found');
    assert.equal((await as(B, (tx) => readChanges(tx, STORE, plain, 0, 100))).changes.length, 0);
  });

  test('the change feed: in rev order, paged; an old cursor after a clean-up must start again from 0', async () => {
    const P = uuidv7();
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    for (const id of ids) await push(P, [{ op_id: uuidv7(), type: 'notes', id, base_version: null, fields: { title: id.slice(0, 8) } }]);
    const p1 = await as(P, (tx) => readChanges(tx, STORE, plain, 0, 2));
    assert.deepEqual(p1.changes.map((c) => c.record.id), ids.slice(0, 2));
    assert.equal(p1.next, p1.changes[1]!.record.rev);
    const p2 = await as(P, (tx) => readChanges(tx, STORE, plain, p1.next!, 2));
    assert.deepEqual([p2.changes.map((c) => c.record.id), p2.next], [ids.slice(2), null]);
    await sql`update ${sql(SCHEMA)}.counters set purged_rev = 2 where user_id = ${P}`;
    await assert.rejects(as(P, (tx) => readChanges(tx, STORE, plain, 1, 10)), CursorExpired);
    assert.equal((await as(P, (tx) => readChanges(tx, STORE, plain, 0, 10))).changes.length, 3, '0 is always allowed');
  });

  test('prefs: replaced at the right version, otherwise the current copy comes back', async () => {
    const P = uuidv7();
    assert.deepEqual(await as(P, (tx) => getPrefs(tx, SCHEMA, plain)), { data: {}, version: 0 });
    assert.deepEqual(await as(P, (tx) => putPrefs(tx, SCHEMA, plain, { theme: 'dark' }, 0)), { data: { theme: 'dark' }, version: 1 });
    assert.deepEqual(await as(P, (tx) => putPrefs(tx, SCHEMA, plain, { theme: 'light' }, 0)), { conflict: { data: { theme: 'dark' }, version: 1 } });
  });

  test('two devices sync through Postgres: offline edits to different fields merge; a deletion reaches the other device', async () => {
    const P = uuidv7();
    const dev = () => ({ recs: new Map() as Recs<T>, prefs: {} as Fields, state: emptyState<T>() as SyncState<T> });
    const run = async (d: ReturnType<typeof dev>, at: string) => {
      const r = await sync<T>({ ...d, transport: transport(P), fieldsOf: STORE.fieldNames, now: () => at });
      assert.equal(r.error, null);
      Object.assign(d, { recs: r.recs, prefs: r.prefs, state: r.state });
      return r;
    };
    const a = dev(), b = dev();
    const id = uuidv7(), gone = uuidv7();
    a.recs.set(key('notes', id), { type: 'notes', id, fields: { title: 'Plan', body: 'v1', pinned: false } });
    a.recs.set(key('notes', gone), { type: 'notes', id: gone, fields: { title: 'Gone', body: null, pinned: false } });
    await run(a, '2026-10-14T10:00:00Z');
    await run(b, '2026-10-14T10:01:00Z');
    assert.equal(b.recs.get(key('notes', id))!.fields.body, 'v1');
    a.recs.get(key('notes', id))!.fields.title = 'Plan A';
    a.recs.delete(key('notes', gone));
    b.recs.get(key('notes', id))!.fields.pinned = true;
    await run(a, '2026-10-14T11:00:00Z');
    await run(b, '2026-10-14T11:05:00Z');
    await run(a, '2026-10-14T11:10:00Z');
    for (const d of [a, b]) {
      assert.deepEqual(d.recs.get(key('notes', id))!.fields, { title: 'Plan A', body: 'v1', pinned: true });
      assert.equal(d.recs.has(key('notes', gone)), false);
    }
    const [row] = await sql`select version, deleted_at from ${sql(SCHEMA)}.notes where id = ${gone}`;
    assert.ok(row!.deleted_at, 'kept as a tombstone');
  });
});
