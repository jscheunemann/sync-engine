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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlite, sqliteExec, sqliteRow, sqliteRows } from './sqlite-backend.ts';

const URL_ = process.env.TEST_DATABASE_URL;
type T = 'notes';

const storeIn = (): RecordStore<T> => ({
  types: ['notes'],
  fields: { notes: { title: 'text', body: { kind: 'text', content: true }, pinned: 'boolean' } },
  defaults: () => ({ title: null, body: null, pinned: false }),
  checkChanges: (_t, changes) => Object.keys(changes).filter((k) => !['title', 'body', 'pinned'].includes(k)).map((field) => ({ field, code: 'unknown' })),
  normalize: (_t, f) => ({ ...f, title: typeof f.title === 'string' ? f.title.trim() : f.title }),
  validate: (_t, f) => (typeof f.title === 'string' && f.title ? [] : [{ field: 'title', code: 'required' }]),
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

/** One backend's database, for the contract: a session, and the two things an operator does outside the engine. */
interface Rig {
  session: Session<T>;
  /** A clean-up happened: changes up to `rev` are gone for this person. */
  setPurged(person: string, rev: number): Promise<void>;
  /** A record's deleted_at as stored (a tombstone is kept, not removed). */
  deletedAt(id: string): Promise<unknown>;
  close(): Promise<void>;
}

/** Every case version 1's server test covers, through intents, on one backend (ADR 0005). */
function recordContract(name: string, make: () => Promise<Rig>, skip: string | false) {
describe(`contract: ${name}`, { skip }, () => {
  let rig: Rig;
  let session: Session<T>;
  let h: ReturnType<typeof harness>;
  const A = uuidv7(), B = uuidv7();

  before(async () => {
    rig = await make();
    session = rig.session;
    h = harness(session);
  });
  after(() => rig.close());

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
    await rig.setPurged(P, 2);
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

  test('sealPlain seals stored plain content in place: no change number, no version, a few at a time (ADR 0026)', async () => {
    const P = uuidv7();
    const mk = (title: string) => ({ op_id: uuidv7(), type: 'notes' as T, id: uuidv7(), base_version: null, fields: { title } });
    const ops = [mk('one'), mk('two'), mk('three')];
    await session.work({ person: P }, (w) => w.apply(ops));
    const before = await session.work({ person: P }, (w) => w.changes(0, 10));
    const sealing: ContentCrypto = {
      vaultEnabled: async () => false,
      openRow: async (_t, r) => (Number(r.enc) === 1 ? { ...r, content: JSON.parse(String((r.content as { c: string }).c)) } : r),
      sealContent: async (_t, _id, c) => ({ content: { c: JSON.stringify(c) }, enc: 1, key_version: 7 }),
      sealDoc: async (_a, d) => d,
      openDoc: async (_a, d) => d,
    };
    assert.equal(await session.work({ person: P }, (w) => w.sealPlain(2)), 0, 'a crypto that keeps content plain seals nothing');
    assert.equal(await session.work({ person: P }, (w) => w.sealPlain(2), { crypto: sealing }), 2);
    assert.equal(await session.work({ person: P }, (w) => w.sealPlain(2), { crypto: sealing }), 1);
    assert.equal(await session.work({ person: P }, (w) => w.sealPlain(2), { crypto: sealing }), 0, 'nothing plain left');
    const after = await session.work({ person: P }, (w) => w.changes(0, 10), { crypto: sealing });
    assert.deepEqual(after.changes.map((c) => [c.record.id, c.record.rev, c.record.version, c.record.title]), before.changes.map((c) => [c.record.id, c.record.rev, c.record.version, c.record.title]));
    assert.ok(after.changes.every((c) => c.record.enc === 1 && c.record.key_version === 7));
    assert.equal(after.next, before.next, 'no device sees a change');
    // another person's are left alone
    const Q = uuidv7();
    await session.work({ person: Q }, (w) => w.apply([mk('theirs')]));
    await session.work({ person: P }, (w) => w.sealPlain(10), { crypto: sealing });
    assert.equal((await session.work({ person: Q }, (w) => w.changes(0, 10))).changes[0]!.record.enc, 0);
  });

  test('an attempt that throws undoes its ops, their revs and their stored results; the rest of the unit lands (ADR 0025)', async () => {
    const P = uuidv7();
    const tried = { op_id: uuidv7(), type: 'notes' as T, id: uuidv7(), base_version: null, fields: { title: 'tried' } };
    const kept = { op_id: uuidv7(), type: 'notes' as T, id: uuidv7(), base_version: null, fields: { title: 'kept' } };
    await session.work({ person: P }, async (w) => {
      await assert.rejects(
        w.attempt(async (t) => {
          const [r] = await t.apply([tried]);
          assert.equal(r!.status, 'applied');
          throw new Error('check only');
        }),
        /check only/,
      );
      const [r] = await w.attempt((t) => t.apply([kept]));
      assert.equal(r!.status, 'applied');
    });
    assert.equal(await session.work({ person: P }, (w) => w.get('notes', tried.id)), null);
    const [again] = await session.work({ person: P }, (w) => w.apply([tried]));
    assert.equal(again!.status, 'applied', 'not a duplicate: its result was undone too');
    const feed = await session.work({ person: P }, (w) => w.changes(0, 10));
    assert.deepEqual(feed.changes.map((c) => c.record.rev), [1, 2], 'the undone op’s rev was given back');
  });

  test('two devices sync through the engine: offline edits to different fields merge; a deletion reaches the other device', async () => {
    const P = uuidv7();
    const dev = () => ({ recs: new Map() as Recs<T>, prefs: {} as Fields, state: emptyState<T>() as SyncState<T> });
    const run = async (d: ReturnType<typeof dev>, at: string) => {
      const r = await sync<T>({ ...d, transport: h.transport(P), fieldsOf: () => ['title', 'body', 'pinned'], now: () => at });
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
    assert.ok(await rig.deletedAt(gone), 'kept as a tombstone');
  });
});
}

/** Isolation by the engine alone (ADR 0007): no row-level security under it. */
function isolationContract(name: string, make: () => Promise<Rig>, skip: string | false) {
describe(`contract: isolation by the engine alone, ${name}`, { skip }, () => {
  let rig: Rig;
  let session: Session<T>;
  let h: ReturnType<typeof harness>;
  const A = uuidv7(), B = uuidv7();

  before(async () => {
    rig = await make();
    session = rig.session;
    h = harness(session);
  });
  after(() => rig.close());

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
}

/** Postgres, with today's tables made by hand (adopted, ADR 0006); `rls` adds row-level security and the API role. */
function pgRig(S: string, rls: boolean) {
  return async (): Promise<Rig> => {
    const admin = pg(URL_!, { max: 2, onnotice: () => {} });
    if (rls) {
      await admin.unsafe(`do $$ begin if exists (select from pg_roles where rolname = 'se2_api') then execute 'drop owned by se2_api'; drop role se2_api; end if; end $$;`).catch(() => {});
      await admin.unsafe(`create role se2_api nologin;`);
    }
    await admin.unsafe(ddl(S, rls));
    const session = createEngine({ store: storeIn(), backend: postgres }).connect({ url: URL_!, schema: S, max: 2, ...(rls ? { role: 'se2_api' } : {}) } satisfies PostgresSettings);
    return {
      session,
      setPurged: async (person, rev) => void (await admin.unsafe(`update ${S}.counters set purged_rev = $1 where user_id = $2`, [rev, person])),
      deletedAt: async (id) => (await admin.unsafe(`select deleted_at from ${S}.notes where id = $1`, [id]))[0]?.deleted_at,
      close: async () => {
        await session.close();
        await admin.unsafe(`drop schema if exists ${S} cascade` + (rls ? `; drop owned by se2_api; drop role if exists se2_api` : ''));
        await admin.end();
      },
    };
  };
}

/**
 * SQLite (test/sqlite-backend.ts), with the tables the engine plans from the declarations, plus the database rule the
 * contract checks (a title of at most 40 characters), added as an operator would.
 */
function sqliteRig() {
  return async (): Promise<Rig> => {
    const dir = mkdtempSync(join(tmpdir(), 'se2-'));
    const path = join(dir, 'contract.db');
    const engine = createEngine({ store: storeIn(), backend: sqlite });
    const p = await engine.plan({ path });
    await sqlite.schema!.apply({ path }, { ...p, steps: p.steps.map((st) => ({ ...st, sql: st.sql.replace('"title" text', '"title" text constraint notes_title_check check (length(title) <= 40)') })) });
    const session = engine.connect({ path });
    return {
      session,
      setPurged: async (person, rev) => sqliteExec(path, `update counters set purged_rev = ? where user_id = ?`, rev, person),
      deletedAt: async (id) => sqliteRow(path, `select deleted_at from notes where id = ?`, id)?.deleted_at,
      close: async () => {
        await session.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };
}

const noDb = !URL_ && 'TEST_DATABASE_URL not set';
recordContract('Postgres, through the engine, row-level security on', pgRig('se2_test', true), noDb);
recordContract('SQLite, through the engine', sqliteRig(), false);
isolationContract('Postgres (row-level security off)', pgRig('se2_open', false), noDb);
isolationContract('SQLite (no row-level security at all)', sqliteRig(), false);

type K = 'tasks';
const kindsStore: RecordStore<K> = {
  types: ['tasks'],
  fields: { tasks: { title: 'text', size: 'integer', est: 'number', done: 'boolean', due_at: 'time', tags: 'ids', due: 'json', notes: { kind: 'text', content: true } } },
  validate: () => [],
};

/** A backend's session for every field kind, and a record's stored list, JSON and content, as plain values. */
interface KindsRig {
  session: Session<K>;
  stored(id: string): Promise<{ tags: unknown; due: unknown; content: unknown }>;
  close(): Promise<void>;
}

function kindsContract(name: string, make: () => Promise<KindsRig>, skip: string | false) {
describe(`contract: every field kind, stored by the engine from declarations (ADR 0014), ${name}`, { skip }, () => {
  let rig: KindsRig;
  let session: Session<K>;
  const P = uuidv7();
  before(async () => {
    rig = await make();
    session = rig.session;
  });
  after(() => rig.close());

  test('each kind is written as its column takes it and comes back as it went in, in one op, in bulk and in the feed', async () => {
    const tag = uuidv7();
    const fields = { title: 'Plan', size: 3, est: 0.1 + 0.2, done: true, due_at: '2026-11-20T15:00:00.000Z', tags: [tag, uuidv7()], due: { kind: 'floating', date: '2026-11-20', time: '09:00' }, notes: 'what I wrote' };
    const op = (f: Fields): Op<K> => ({ op_id: uuidv7(), type: 'tasks', id: uuidv7(), base_version: null, fields: f });
    const [one] = await session.work({ person: P }, (w) => w.apply([op(fields)]));
    assert.equal(one!.status, 'applied');
    const got = (one as { record: StoredRecord }).record;
    for (const [k, v] of Object.entries(fields)) assert.deepEqual(got[k], v, k);
    const many = await session.work({ person: P }, (w) => w.apply([op({ ...fields, tags: [] }), op({ title: 'Empty' })]));
    assert.deepEqual(many.map((r) => r.status), ['applied', 'applied']);
    assert.deepEqual((many[0] as { record: StoredRecord }).record.tags, []);
    assert.deepEqual((many[1] as { record: StoredRecord }).record.due, null);
    assert.deepEqual((many[1] as { record: StoredRecord }).record.tags, [], 'no list is an empty list');
    const stored = await rig.stored(got.id);
    assert.deepEqual(stored.tags, fields.tags, 'a list of ids');
    assert.deepEqual(stored!.due, fields.due, 'jsonb, as the device sent it');
    assert.deepEqual(stored!.content, { notes: 'what I wrote' }, 'content apart from the columns');
    const feed = await session.work({ person: P }, (w) => w.changes(0, 10));
    const fromFeed = feed.changes.find((c) => c.record.id === got.id)!.record;
    for (const [k, v] of Object.entries(fields)) assert.deepEqual(fromFeed[k], v, `${k} from the feed`);
    const found = await session.work({ person: P }, (w) => w.find('tasks', { where: { size: 3, done: true, due_at: { gte: '2026-11-20T00:00:00Z' } } }));
    assert.deepEqual(found.rows.map((r) => r.id).sort(), [got.id, (many[0] as { record: StoredRecord }).record.id].sort());
    await assert.rejects(session.work({ person: P }, (w) => w.find('tasks', { where: { tags: [tag] as never } })), /not_queryable/);
  });
});
}

kindsContract(
  'Postgres',
  async () => {
    const S = 'se2_kinds';
    const admin = pg(URL_!, { max: 2, onnotice: () => {} });
    await admin.unsafe(ddl(S, false) + `
create table ${S}.tasks (
  user_id uuid not null, id uuid not null, rev bigint not null, version integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), client_updated_at timestamptz, deleted_at timestamptz,
  content jsonb not null default '{}', enc smallint not null default 0, key_version integer not null default 0,
  title text, size integer, est double precision, done boolean, due_at timestamptz, tags uuid[] not null default '{}', due jsonb,
  primary key (user_id, id));`);
    const session = createEngine({ store: kindsStore, backend: postgres }).connect({ url: URL_!, schema: S, max: 2 });
    return {
      session,
      stored: async (id) => {
        const [r] = await admin.unsafe(`select array_to_json(tags) as tags, due, content from ${S}.tasks where id = $1`, [id]);
        return { tags: r!.tags, due: r!.due, content: r!.content };
      },
      close: async () => {
        await session.close();
        await admin.unsafe(`drop schema if exists ${S} cascade`);
        await admin.end();
      },
    };
  },
  noDb,
);

kindsContract(
  'SQLite',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'se2-kinds-'));
    const path = join(dir, 'kinds.db');
    const engine = createEngine({ store: kindsStore, backend: sqlite });
    await engine.migrate({ path }, await engine.plan({ path }));
    const session = engine.connect({ path });
    return {
      session,
      stored: async (id) => {
        const [r] = sqliteRows(path, `select tags, due, content from tasks where id = ?`, id);
        return { tags: r!.tags, due: r!.due, content: r!.content };
      },
      close: async () => rmSync(dir, { recursive: true, force: true }),
    };
  },
  false,
);
