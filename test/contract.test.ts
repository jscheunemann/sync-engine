// The contract (ADR 0005), against Postgres through the engine (version 2): every case version 1's server test covers,
// now through intents, plus isolation (ADR 0007) on its own: the same intents with row-level security off, where the
// engine alone must keep one person's data from another. Needs TEST_DATABASE_URL; skipped without it.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'postgres';
import { emptyState, key, sync, type Recs, type SyncState } from '../src/device.ts';
import { createEngine, CursorExpired, type ContentCrypto, type RecordStore, type Row, type Session, type StoredRecord } from '../src/engine.ts';
import { uuidv7 } from '../src/ids.ts';
import { postgres, type PostgresSettings } from '../src/postgres.ts';
import { checkOp, type Fields, type Op, type Transport } from '../src/protocol.ts';

const URL_ = process.env.TEST_DATABASE_URL;
type T = 'notes';

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const storeIn = (schema: string): RecordStore<T> => ({
  schema,
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
});

/** Today's tables (README.md), as an app has them; `rls` adds row-level security and the API role. */
const ddl = (S: string, rls: boolean) => `
drop schema if exists ${S} cascade;
create schema ${S};
create function ${S}.current_user_id() returns uuid language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create table ${S}.counters (user_id uuid primary key default ${S}.current_user_id(), rev bigint not null default 0, purged_rev bigint not null default 0);
create function ${S}.next_rev() returns bigint language sql volatile as $$
  insert into ${S}.counters as c (user_id, rev) values (${S}.current_user_id(), 1)
  on conflict (user_id) do update set rev = c.rev + 1 returning c.rev $$;
create table ${S}.applied_ops (user_id uuid not null default ${S}.current_user_id(), op_id uuid not null, result jsonb not null, created_at timestamptz not null default now(), primary key (user_id, op_id));
create table ${S}.prefs (user_id uuid primary key default ${S}.current_user_id(), data jsonb not null default '{}', version integer not null default 1, updated_at timestamptz not null default now());
create table ${S}.notes (
  user_id uuid not null default ${S}.current_user_id(), id uuid not null,
  rev bigint not null, version integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  client_updated_at timestamptz, deleted_at timestamptz,
  content jsonb not null default '{}', enc smallint not null default 0, key_version integer not null default 0,
  title text check (length(title) <= 40), pinned boolean not null default false,
  primary key (user_id, id));
${
  rls
    ? `grant usage on schema ${S} to se2_api;
grant select, insert, update on all tables in schema ${S} to se2_api;
grant execute on all functions in schema ${S} to se2_api;
${['counters', 'applied_ops', 'prefs', 'notes']
  .map((t) => `alter table ${S}.${t} enable row level security; alter table ${S}.${t} force row level security;
create policy own on ${S}.${t} for all to se2_api using (user_id = ${S}.current_user_id()) with check (user_id = ${S}.current_user_id());`)
  .join('\n')}`
    : ''
}`;

/** The contract's helpers on one engine session. */
function harness(session: Session<T>) {
  const now = () => new Date().toISOString();
  const opsOf = (raw: Op[]) => raw.map((r) => (checkOp(r, (t): t is T => t === 'notes') as { op: Op<T> }).op);
  /** One op at a time, as a device's push sends them (each through the one-by-one path). */
  const push = async (person: string, raw: Op[]) => {
    const out = [];
    for (const r of raw) {
      const c = checkOp(r, (t): t is T => t === 'notes');
      out.push('op' in c ? (await session.work({ person }, (w) => w.apply([c.op], now())))[0]! : { op_id: c.op_id ?? '', status: 'invalid' as const, problems: c.problems });
    }
    return out;
  };
  /** Many ops in one call: the engine picks the bulk path when they're all new records or all plain deletes. */
  const many = (person: string, raw: Op[], crypto?: ContentCrypto) => session.work({ person }, (w) => w.apply(opsOf(raw), now()), { crypto });
  const changes = (person: string, since: number, limit: number) => session.work({ person }, (w) => w.changes(since, limit));
  const transport = (person: string): Transport<T> => ({
    push: (ops) => push(person, ops.map(({ full: _full, ...op }) => op)),
    changes: (since) => changes(person, since, 2),
    getPrefs: () => session.work({ person }, (w) => w.prefs.get()),
    putPrefs: async (data, base) => {
      const r = await session.work({ person }, (w) => w.prefs.put(data, base));
      if ('problems' in r) throw new Error('invalid');
      return r as { data: Fields; version: number } | { conflict: { data: Fields; version: number } };
    },
  });
  return { push, many, changes, transport };
}

const create = (title: string, o: Partial<Op> = {}): Op => ({ op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: null, fields: { title, body: `about ${title}` }, ...o });
const del = (r: StoredRecord, o: Partial<Op> = {}): Op => ({ op_id: uuidv7(), type: 'notes', id: r.id, base_version: r.version, delete: true, ...o });
const rec = (r: unknown) => (r as { record: StoredRecord }).record;

describe('contract: Postgres, through the engine, row-level security on', { skip: !URL_ && 'TEST_DATABASE_URL not set' }, () => {
  const S = 'se2_test';
  let admin: pg.Sql;
  let session: Session<T>;
  let h: ReturnType<typeof harness>;
  const A = uuidv7(), B = uuidv7();

  before(async () => {
    admin = pg(URL_!, { max: 2, onnotice: () => {} });
    await admin.unsafe(`do $$ begin if exists (select from pg_roles where rolname = 'se2_api') then execute 'drop owned by se2_api'; drop role se2_api; end if; end $$;`).catch(() => {});
    await admin.unsafe(`create role se2_api nologin;` + ddl(S, true));
    const engine = createEngine({ store: storeIn(S), backend: postgres });
    session = engine.connect({ url: URL_!, max: 2, role: 'se2_api' } satisfies PostgresSettings);
    h = harness(session);
  });
  after(async () => {
    await session.close();
    await admin.unsafe(`drop schema if exists ${S} cascade; drop owned by se2_api; drop role if exists se2_api`);
    await admin.end();
  });

  test('new records in one call go in bulk, each just as one op would, in order, with revs in a row', async () => {
    const ops = Array.from({ length: 1203 }, (_, i) => create(` Note ${i} `));
    const results = await h.many(A, ops);
    assert.equal(results.length, 1203);
    assert.ok(results.every((r, i) => r.status === 'applied' && r.id === ops[i]!.id));
    const recs = results.map(rec);
    assert.deepEqual([recs[0]!.title, recs[0]!.body, recs[0]!.pinned, recs[0]!.version], ['Note 0', 'about  Note 0 ', false, 1], 'defaults, normalize, content');
    const revs = recs.map((r) => r.rev);
    assert.equal(new Set(revs).size, 1203, 'every rev its own');
    assert.ok(revs.every((r, i) => i === 0 || r === revs[i - 1]! + 1), 'one block, in order');
    const [again] = await h.push(A, [ops[5]!]);
    assert.equal(again!.status, 'duplicate');
    assert.equal(rec(again).rev, revs[5]);
    const page = await h.changes(A, revs[0]! - 1, 1000);
    assert.equal(page.changes.length, 1000);
  });

  test('a call that mixes kinds of op goes one by one, with the same answers', async () => {
    const [made] = await h.push(A, [create('first')]);
    const existing = rec(made);
    const repeat = create('repeat');
    await h.push(A, [repeat]);
    const results = await h.many(A, [
      create('fine'),
      repeat,
      create('taken', { id: existing.id }),
      { op_id: uuidv7(), type: 'notes', id: existing.id, base_version: 1, fields: { pinned: true } },
      create(''),
      create('x'.repeat(41)),
      create('also fine'),
    ]);
    assert.deepEqual(results.map((r) => r.status), ['applied', 'duplicate', 'conflict', 'applied', 'invalid', 'invalid', 'applied']);
    assert.equal(rec(results[3]).version, 2);
    assert.equal(rec(results[6]).title, 'also fine');
  });

  test('the bulk path for new records answers repeats, existing ids and refused rows as one op would', async () => {
    const [made] = await h.push(A, [create('kept')]);
    const repeat = create('repeat in bulk');
    await h.many(A, [repeat, create('pad')]);
    const results = await h.many(A, [create('ok 1'), repeat, create('taken', { id: rec(made).id }), create(''), create('x'.repeat(41)), create('ok 2')]);
    assert.deepEqual(results.map((r) => r.status), ['applied', 'duplicate', 'conflict', 'invalid', 'invalid', 'applied']);
    assert.deepEqual((results[4] as { problems: unknown[] }).problems, [{ field: 'notes_title_check', code: 'db_rule' }]);
  });

  test('plain deletes in one call are tombstones in bulk, each as one op would, revs in a row, kept for repeats', async () => {
    const made = (await h.many(A, Array.from({ length: 1203 }, (_, i) => create(`Gone ${i}`)))).map(rec);
    const ops = made.map((r) => del(r));
    const results = await h.many(A, ops);
    assert.ok(results.every((r, i) => r.status === 'applied' && r.id === made[i]!.id));
    const recs = results.map(rec);
    assert.ok(recs.every((r, i) => r.deleted_at && r.version === made[i]!.version + 1 && r.body === made[i]!.body), 'a tombstone keeps everything');
    const revs = recs.map((r) => r.rev);
    assert.ok(revs.every((r, i) => i === 0 || r === revs[i - 1]! + 1), 'one block, in order');
    const [again] = await h.push(A, [ops[7]!]);
    assert.equal(again!.status, 'duplicate');
    const [back] = await h.push(A, [{ op_id: uuidv7(), type: 'notes', id: recs[0]!.id, base_version: recs[0]!.version, delete: false }]);
    assert.equal(rec(back).deleted_at, null);
    const page = await h.changes(A, revs[0]! - 1, 1000);
    assert.ok(page.changes.every((c) => c.record.deleted_at || c.record.id === recs[0]!.id));
  });

  test('the bulk path for deletes answers changed, gone, already deleted and repeats as one op would', async () => {
    const [a, b, c, d] = (await h.many(A, [create('a'), create('b'), create('c'), create('d')])).map(rec);
    await h.push(A, [{ op_id: uuidv7(), type: 'notes', id: b!.id, base_version: 1, fields: { pinned: true } }]);
    await h.push(A, [del(c!)]);
    const repeat = del(d!);
    await h.push(A, [repeat]);
    const results = await h.many(A, [del(a!), del(b!), del(c!), repeat, del({ ...a!, id: uuidv7() })]);
    assert.deepEqual(results.map((r) => r.status), ['applied', 'conflict', 'conflict', 'duplicate', 'not_found']);
    assert.equal((results[1] as { current: StoredRecord }).current.pinned, true);
  });

  test('a restore sent again (new op ids, the same records): every one a conflict with its current copy, as one op answers', async () => {
    const ops = Array.from({ length: 700 }, (_, i) => create(`Again ${i}`));
    await h.many(A, ops);
    const resent = ops.map((o) => ({ ...o, op_id: uuidv7() }));
    const again = await h.many(A, resent.slice(1));
    assert.ok(again.every((r, i) => r.status === 'conflict' && (r as { current: StoredRecord }).current.id === ops[i + 1]!.id && (r as { current: StoredRecord }).current.title === `Again ${i + 1}`));
    const [viaBulk] = await h.many(A, [resent[0]!, create('new beside it')]);
    const [viaOne] = await h.push(A, [{ ...resent[0]!, op_id: uuidv7() }]);
    assert.deepEqual({ ...viaBulk, op_id: '' }, { ...viaOne, op_id: '' });
  });

  test('create, change at the right version, refuse a stale one with the current copy', async () => {
    const id = uuidv7();
    const [c] = await h.push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: null, fields: { title: ' Hello ', body: 'secret words' } }]);
    assert.equal(c!.status, 'applied');
    const r = rec(c);
    assert.deepEqual([r.version, r.title, r.body, r.pinned], [1, 'Hello', 'secret words', false]);
    const [u] = await h.push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: 1, fields: { pinned: true } }]);
    assert.equal(rec(u).version, 2);
    assert.equal(rec(u).body, 'secret words', 'unchanged fields are kept');
    const [stale] = await h.push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: 1, fields: { title: 'late' } }]);
    assert.equal(stale!.status, 'conflict');
    assert.equal((stale as { current: StoredRecord }).current.version, 2);
    const [again] = await h.push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: null, fields: { title: 'dup id' } }]);
    assert.equal(again!.status, 'conflict', 'creating an id that exists is a conflict');
    assert.equal((await session.work({ person: A }, (w) => w.get('notes', id)))!.version, 2, 'get reads it');
  });

  test('an op sent twice is applied once; unknown records, bad values and database rules are reported on the op', async () => {
    const op: Op = { op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: null, fields: { title: 'once' } };
    const [first, second] = [(await h.push(A, [op]))[0]!, (await h.push(A, [op]))[0]!];
    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'duplicate');
    assert.equal(rec(second).rev, rec(first).rev);
    const results = await h.push(A, [
      { op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: 3, fields: { title: 'x' } },
      { op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: null, fields: { title: '' } },
      { op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: null, fields: { colour: 'red', title: 't' } },
      { op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: null, fields: { title: 'x'.repeat(41) } },
      { op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: null, fields: { title: 'still applied after the others' } },
    ]);
    assert.deepEqual(results.map((r) => r.status), ['not_found', 'invalid', 'invalid', 'invalid', 'applied']);
    assert.deepEqual((results[3] as { problems: unknown[] }).problems, [{ field: 'notes_title_check', code: 'db_rule' }]);
  });

  test('deleting leaves a tombstone, and an op can bring it back; one person never sees another’s records', async () => {
    const id = uuidv7();
    await h.push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: null, fields: { title: 'temp' } }]);
    const [d] = await h.push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: 1, delete: true }]);
    assert.ok(rec(d).deleted_at);
    const [r] = await h.push(A, [{ op_id: uuidv7(), type: 'notes', id, base_version: 2, delete: false }]);
    assert.equal(rec(r).deleted_at, null);
    const [other] = await h.push(B, [{ op_id: uuidv7(), type: 'notes', id, base_version: 3, fields: { title: 'not mine' } }]);
    assert.equal(other!.status, 'not_found');
    assert.equal((await h.changes(B, 0, 100)).changes.length, 0);
  });

  test('the change feed: in rev order, paged; an old cursor after a clean-up must start again from 0', async () => {
    const P = uuidv7();
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    for (const id of ids) await h.push(P, [{ op_id: uuidv7(), type: 'notes', id, base_version: null, fields: { title: id.slice(0, 8) } }]);
    const p1 = await h.changes(P, 0, 2);
    assert.deepEqual(p1.changes.map((c) => c.record.id), ids.slice(0, 2));
    assert.equal(p1.next, p1.changes[1]!.record.rev);
    const p2 = await h.changes(P, p1.next!, 2);
    assert.deepEqual([p2.changes.map((c) => c.record.id), p2.next], [ids.slice(2), null]);
    await admin`update ${admin(S)}.counters set purged_rev = 2 where user_id = ${P}`;
    await assert.rejects(h.changes(P, 1, 10), CursorExpired);
    assert.equal((await h.changes(P, 0, 10)).changes.length, 3, '0 is always allowed');
  });

  test('prefs: replaced at the right version, otherwise the current copy comes back', async () => {
    const P = uuidv7();
    const w = <R>(fn: (x: Parameters<Parameters<Session<T>['work']>[1]>[0]) => Promise<R>) => session.work({ person: P }, fn);
    assert.deepEqual(await w((x) => x.prefs.get()), { data: {}, version: 0 });
    assert.deepEqual(await w((x) => x.prefs.put({ theme: 'dark' }, 0)), { data: { theme: 'dark' }, version: 1 });
    assert.deepEqual(await w((x) => x.prefs.put({ theme: 'light' }, 0)), { conflict: { data: { theme: 'dark' }, version: 1 } });
  });

  test('a unit of work lands together or not at all', async () => {
    const P = uuidv7();
    const id = uuidv7();
    await assert.rejects(
      session.work({ person: P }, async (w) => {
        await w.apply([{ op_id: uuidv7(), type: 'notes', id, base_version: null, fields: { title: 'half done' } }]);
        await w.prefs.put({ theme: 'dark' }, 0);
        throw new Error('stop');
      }),
      /stop/,
    );
    assert.equal(await session.work({ person: P }, (w) => w.get('notes', id)), null);
    assert.deepEqual(await session.work({ person: P }, (w) => w.prefs.get()), { data: {}, version: 0 });
  });

  test('two devices sync through the engine: offline edits to different fields merge; a deletion reaches the other device', async () => {
    const P = uuidv7();
    const dev = () => ({ recs: new Map() as Recs<T>, prefs: {} as Fields, state: emptyState<T>() as SyncState<T> });
    const run = async (d: ReturnType<typeof dev>, at: string) => {
      const r = await sync<T>({ ...d, transport: h.transport(P), fieldsOf: storeIn(S).fieldNames, now: () => at });
      assert.equal(r.error, null);
      Object.assign(d, { recs: r.recs, prefs: r.prefs, state: r.state });
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
    const [row] = await admin`select deleted_at from ${admin(S)}.notes where id = ${gone}`;
    assert.ok(row!.deleted_at, 'kept as a tombstone');
  });
});

describe('contract: isolation by the engine alone (row-level security off)', { skip: !URL_ && 'TEST_DATABASE_URL not set' }, () => {
  const S = 'se2_open';
  let admin: pg.Sql;
  let session: Session<T>;
  let h: ReturnType<typeof harness>;
  const A = uuidv7(), B = uuidv7();

  before(async () => {
    admin = pg(URL_!, { max: 2, onnotice: () => {} });
    await admin.unsafe(ddl(S, false));
    session = createEngine({ store: storeIn(S), backend: postgres }).connect({ url: URL_!, max: 2 });
    h = harness(session);
  });
  after(async () => {
    await session.close();
    await admin.unsafe(`drop schema if exists ${S} cascade`);
    await admin.end();
  });

  test('no intent reads, changes or deletes another person’s data', async () => {
    const [made] = await h.push(A, [create('mine')]);
    const mine = rec(made);
    const many = (await h.many(A, [create('m1'), create('m2')])).map(rec);
    await session.work({ person: A }, (w) => w.prefs.put({ theme: 'dark' }, 0));

    assert.equal(await session.work({ person: B }, (w) => w.get('notes', mine.id)), null, 'get');
    assert.deepEqual(await session.work({ person: B }, (w) => w.getMany('notes', [mine.id, ...many.map((r) => r.id)])), [], 'getMany');
    assert.equal((await h.changes(B, 0, 1000)).changes.length, 0, 'changes');
    assert.deepEqual(await session.work({ person: B }, (w) => w.prefs.get()), { data: {}, version: 0 }, 'prefs');
    const [change] = await h.push(B, [{ op_id: uuidv7(), type: 'notes', id: mine.id, base_version: 1, fields: { title: 'not mine' } }]);
    assert.equal(change!.status, 'not_found', 'change');
    const dels = await h.many(B, many.map((r) => del(r)));
    assert.deepEqual(dels.map((r) => r.status), ['not_found', 'not_found'], 'bulk delete');
    const [same] = await h.push(B, [create('same id, my own', { id: mine.id })]);
    assert.equal(same!.status, 'applied', 'an id is per person: this is B’s own record');
    const [replay] = await h.push(B, [{ ...create('x'), op_id: (made as { op_id: string }).op_id }]);
    assert.equal(replay!.status, 'applied', 'op ids are per person: A’s op is not a duplicate for B');

    const still = await session.work({ person: A }, (w) => w.get('notes', mine.id));
    assert.deepEqual([still!.title, still!.version, still!.deleted_at], ['mine', 1, null], 'A’s record is untouched');
    assert.equal((await session.work({ person: A }, (w) => w.prefs.get())).version, 1);
  });

  test('a unit needs a person', async () => {
    assert.throws(() => session.work({ person: '' }, async () => 1), /scope_required/);
  });
});
