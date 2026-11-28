// Intents for declared types (ADRs 0003, 0009, 0010): find and count on declared fields, put/update/remove, shared and
// system types, and system intents with their audit. The same contract runs on SQLite (always, tables from the
// declarations) and on Postgres (with TEST_DATABASE_URL), with row-level security on, so a backend can't pass by its
// database alone.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'postgres';
import { EngineError, createEngine, type ContentCrypto, type RecordStore, type Row, type Session, type SystemDecl, type TypeDecl, type Work } from '../src/engine.ts';
import { cursor } from '../src/declare.ts';
import { uuidv7 } from '../src/ids.ts';
import { postgres } from '../src/postgres.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlite, sqliteExec, sqliteRows } from './sqlite-backend.ts';

const URL_ = process.env.TEST_DATABASE_URL;
type T = 'notes';

/** Records, declared: found here by their columns (the rest of their contract is test/contract.test.ts). */
const store = (): RecordStore<T> => ({
  types: ['notes'],
  fields: { notes: { title: 'text', tags: 'ids', due: 'json', body: { kind: 'json', content: true } } },
  validate: () => [],
});

const types: Record<string, TypeDecl> = {
  docs: {
    access: 'person',
    key: ['id'],
    fields: { id: 'id', title: 'text', rank: 'number', done: 'boolean', due: 'time', body: 'json', version: 'number' },
    query: ['title', 'rank', 'done', 'due'],
    version: 'version',
    sealed: ['body'],
  },
  keys: { access: 'person', key: ['version'], fields: { version: 'number', wrapped: 'text' } },
  account: { access: 'person', key: [], fields: { prefs: 'json' } },
  days: { access: 'person', key: ['day'], fields: { day: 'date', n: 'integer' } },
  membership: { access: 'person', writes: 'system', key: [], fields: { since: 'date', via: 'text' } },
  settings: { access: 'shared', key: ['name'], fields: { name: 'text', value: 'json' } },
  invitations: { access: 'system', key: ['id'], fields: { id: 'id', code: 'text', email: 'text', redeemed_at: 'time' }, query: ['code', 'redeemed_at'] },
  events: {
    access: 'system',
    key: ['id'],
    fields: { id: 'id', viewer: 'text', sid: 'text', t: 'time', a: 'text', tab: 'text', e: 'json' },
    query: ['viewer', 'sid', 't', 'a', 'tab'],
    paths: { name: { from: 'e', path: ['name'], kind: 'text' }, dur: { from: 'e', path: ['dur'], kind: 'number' }, test: { from: 'e', path: ['test'], kind: 'boolean' } },
  },
  // A view the app's migrations make: today's events with a duration, read like any type.
  // An updatable view a system intent may remove rows through (ADR 0020), as an app's over Auth's users.
  accounts: { access: 'system', view: { remove: true }, key: ['id'], fields: { id: 'id', email: 'text' }, query: ['email'] },
  timed: { access: 'system', view: true, key: ['id'], fields: { id: 'id', a: 'text', ms: 'number' }, query: ['a', 'ms'] },
  viewers: { access: 'system', key: ['viewer'], fields: { viewer: 'text', first_seen: 'time', last_seen: 'time', os: 'text' } },
};
const system: Record<string, SystemDecl> = {
  invite: { write: ['invitations'] },
  analytics: { write: ['events', 'viewers'], read: ['timed'] },
  account_delete: { write: ['accounts'] },
  erase_person: { erase: true, write: ['docs', 'keys', 'days', 'account', 'membership'] },
  members: { write: ['membership'] },
  owner_report: { read: ['docs', 'settings'] },
  set_signup: { write: ['settings'] },
};

/** A crypto that marks what it seals, so a test can see content isn't stored as written. */
const marking: ContentCrypto = {
  vaultEnabled: async () => false,
  openRow: async (_t, r) => r,
  sealContent: async (_t, _id, c) => ({ content: c, enc: 0, key_version: 0 }),
  sealDoc: async (aad, d) => ({ sealed: JSON.stringify(d), aad }),
  openDoc: async (aad, d) => {
    const s = d as { sealed: string; aad: string };
    assert.equal(s.aad, aad, 'opened with the associated data it was sealed with');
    return JSON.parse(s.sealed);
  },
};

const code = async (p: Promise<unknown>, c: string, field?: string) => {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof EngineError, `an EngineError, not ${String(e)}`);
    assert.equal(e.code, c);
    if (field !== undefined) assert.equal(e.field, field);
    return true;
  });
};

interface Rig {
  session: Session<T>;
  /** The table as stored, every person's rows. */
  raw(table: string): Promise<Row[]>;
  audit(): Promise<Row[]>;
}

function contract(name: string, rig: () => Rig, opts: { skip?: string | false } = {}) {
  describe(`intents: ${name}`, { skip: opts.skip }, () => {
    const A = uuidv7(), B = uuidv7(), OWNER = uuidv7();
    let s: Session<T>;
    let r: Rig;
    before(() => {
      r = rig();
      s = r.session;
    });
    const as = (person: string) => <R>(fn: (w: Work<T>) => Promise<R>) => s.work({ person }, fn, { crypto: marking });
    const sys = (name: string, by?: string) => <R>(fn: (w: Work<T>) => Promise<R>) => s.work({ system: name, ...(by ? { by } : {}) }, fn, { crypto: marking });

    test('put and find: declared fields only, each of its kind; sealed fields stored sealed and come back opened', async () => {
      const id = uuidv7();
      const put = await as(A)((w) => w.put('docs', { id, title: 'Plan', rank: 2, done: false, due: '2026-11-20T15:00:00.000Z', body: { text: 'secret words' } }));
      assert.deepEqual(put, { id, title: 'Plan', rank: 2, done: false, due: '2026-11-20T15:00:00.000Z', body: { text: 'secret words' }, version: 1 });
      const stored = (await r.raw('docs')).find((x) => x.id === id)!;
      assert.equal(typeof (stored.body as Row).sealed, 'string', 'stored as the crypto sealed it');
      assert.equal((stored.body as { aad: string }).aad, `docs|${id}|body`);
      assert.equal(stored.user_id, A, 'the person column is the scope’s');
      const page = await as(A)((w) => w.find('docs', { where: { id } }));
      assert.deepEqual(page.rows, [put]);
      assert.equal(page.next, null);
      await code(as(A)((w) => w.put('docs', { id: uuidv7(), title: 'x', color: 'red' })), 'unknown_field', 'color');
      await code(as(A)((w) => w.put('docs', { id: uuidv7(), title: 42 })), 'bad_value', 'title');
      await code(as(A)((w) => w.put('docs', { id: uuidv7(), title: 'x', user_id: B })), 'not_yours', 'user_id');
      await code(as(A)((w) => w.put('docs', { id, title: 'again' })), 'refused');
    });

    test('find: conditions, order both ways with nulls last, and cursors that page through without gaps or repeats', async () => {
      const P = uuidv7();
      const made = [];
      for (let i = 0; i < 23; i++)
        made.push(await as(P)((w) => w.put('docs', { id: uuidv7(), title: `t${i % 5}`, rank: i % 4 === 0 ? null : i, done: i % 2 === 0, due: null })));
      const all = await as(P)((w) => w.count('docs'));
      assert.equal(all, 23);
      assert.equal(await as(P)((w) => w.count('docs', { where: { done: true } })), 12);
      assert.equal(await as(P)((w) => w.count('docs', { where: { rank: { is: null } } })), 6);
      assert.equal(await as(P)((w) => w.count('docs', { where: { rank: { not: null }, title: { in: ['t1', 't2'] } } })), 8);
      // a range: one lower and one upper bound (ADR 0031), in finds, counts and summaries alike
      assert.equal(await as(P)((w) => w.count('docs', { where: { rank: { gte: 10, lt: 20 } } })), 8);
      assert.equal(await as(P)((w) => w.count('docs', { where: { rank: { gt: 10, lte: 20 } } })), 7, '20 is a null rank');
      assert.deepEqual((await as(P)((w) => w.find('docs', { where: { rank: { gte: 18, lte: 19 } }, order: 'rank' }))).rows.map((r) => r.rank), [18, 19]);
      assert.deepEqual(await as(P)((w) => w.summarize('docs', { where: { rank: { gte: 10, lt: 20 } }, measures: { s: { sum: 'rank' } } })), [{ s: 117 }]);
      for (const bad of [{ gt: 1, gte: 2 }, { lt: 1, lte: 2 }, { gte: 1, in: [2] }, { gte: 1, lt: 5, ne: 3 }, {}])
        assert.equal(await as(P)((w) => w.count('docs', { where: { rank: bad as never } })).catch((e) => e.code), 'bad_match', JSON.stringify(bad));
      await code(as(P)((w) => w.count('docs', { where: { rank: { gte: 1, lt: 'x' } } })), 'bad_value', 'rank');
      assert.equal(await as(P)((w) => w.count('docs', { where: { rank: { gte: 10 }, title: { ne: 't0' } } })), 8);
      for (const order of ['rank', '-rank', 'title', '-id', undefined]) {
        const seen: Row[] = [];
        let after: string | undefined;
        for (;;) {
          const page = await as(P)((w) => w.find('docs', { order, limit: 4, ...(after ? { after } : {}) }));
          seen.push(...page.rows);
          if (!page.next) break;
          after = page.next;
        }
        assert.equal(seen.length, 23, `every row once, ordered by ${order}`);
        assert.equal(new Set(seen.map((x) => x.id)).size, 23);
        if (order === 'rank' || order === '-rank') {
          const ranks = seen.map((x) => x.rank as number | null);
          const firstNull = ranks.indexOf(null);
          assert.ok(ranks.slice(firstNull).every((x) => x === null), 'nulls last');
          const vals = ranks.slice(0, firstNull) as number[];
          assert.deepEqual(vals, [...vals].sort((a, b) => (order === 'rank' ? a - b : b - a)));
        }
      }
      await code(as(P)((w) => w.find('docs', { where: { body: 'x' } })), 'not_queryable', 'body');
      await code(as(P)((w) => w.find('docs', { order: 'version' })), 'not_queryable', 'version');
      await code(as(P)((w) => w.find('docs', { limit: 5000 })), 'bad_limit');
      await code(as(P)((w) => w.find('docs', { after: 'nonsense' })), 'bad_cursor');
      await code(as(P)((w) => w.find('docs', { order: 'rank', after: cursor.make(['x']) })), 'bad_cursor');
      await code(as(P)((w) => w.find('nothing')), 'unknown_type', 'nothing');
    });

    test('update at the version seen; a stale one gets the current copy; keys stay put; remove', async () => {
      const id = uuidv7();
      await as(A)((w) => w.put('docs', { id, title: 'v1', body: { text: 'one' } }));
      const ok = await as(A)((w) => w.update('docs', { id }, { title: 'v2', body: { text: 'two' } }, 1));
      assert.equal(ok.status, 'applied');
      assert.deepEqual([(ok as { row: Row }).row.title, (ok as { row: Row }).row.version, (ok as { row: Row }).row.body], ['v2', 2, { text: 'two' }]);
      const stale = await as(A)((w) => w.update('docs', { id }, { title: 'v3' }, 1));
      assert.equal(stale.status, 'conflict');
      assert.deepEqual([(stale as { current: Row }).current.title, (stale as { current: Row }).current.version], ['v2', 2]);
      assert.equal((await as(A)((w) => w.update('docs', { id: uuidv7() }, { title: 'x' }, 1))).status, 'not_found');
      await code(as(A)((w) => w.update('docs', { id }, { title: 'x' })), 'version_required', 'version');
      await code(as(A)((w) => w.update('docs', { id }, { id: uuidv7() }, 2)), 'key_field', 'id');
      await code(as(A)((w) => w.update('docs', { id }, { version: 9 }, 2)), 'key_field', 'version');
      await code(as(A)((w) => w.update('docs', { title: 'v2' }, { title: 'x' }, 2)), 'bad_key', 'docs');
      // A type without a version column: last write wins; a type keyed by another field.
      await as(A)((w) => w.put('keys', { version: 1, wrapped: 'w1' }));
      assert.equal((await as(A)((w) => w.update('keys', { version: 1 }, { wrapped: 'w1b' }))).status, 'applied');
      assert.equal(await as(A)((w) => w.remove('docs', { id })), true);
      assert.equal(await as(A)((w) => w.remove('docs', { id })), false);
    });

    test('a type keyed by its person alone: one row each, found, updated and upserted', async () => {
      await as(A)((w) => w.put('account', { prefs: { a: 1 } }));
      await as(B)((w) => w.put('account', { prefs: { b: 1 } }));
      assert.deepEqual((await as(A)((w) => w.find('account'))).rows, [{ prefs: { a: 1 } }]);
      assert.equal((await as(A)((w) => w.update('account', {}, { prefs: { a: 2 } }))).status, 'applied');
      await as(A)((w) => w.put('account', { prefs: { a: 3 } }, { onConflict: 'update' }));
      assert.deepEqual((await as(A)((w) => w.find('account'))).rows, [{ prefs: { a: 3 } }]);
      assert.deepEqual((await as(B)((w) => w.find('account'))).rows, [{ prefs: { b: 1 } }]);
    });

    test('dates: local days, checked, ordered and compared as days (ADR 0019)', async () => {
      for (const day of ['2026-11-18', '2026-11-02', '2026-12-01']) await as(A)((w) => w.put('days', { day, n: 1 }));
      assert.deepEqual((await as(A)((w) => w.find('days', { order: '-day' }))).rows.map((x) => x.day), ['2026-12-01', '2026-11-18', '2026-11-02']);
      assert.equal(await as(A)((w) => w.count('days', { where: { day: { gte: '2026-11-10' } } })), 2);
      const [range] = await as(A)((w) => w.summarize('days', { measures: { first: { min: 'day' }, last: { max: 'day' } } }));
      assert.deepEqual(range, { first: '2026-11-02', last: '2026-12-01' });
      await code(as(A)((w) => w.put('days', { day: '2026-02-30', n: 1 })), 'bad_value', 'day');
      await code(as(A)((w) => w.put('days', { day: '2026-11-18T00:00:00Z', n: 1 })), 'bad_value', 'day');
      assert.equal((await as(A)((w) => w.update('days', { day: '2026-11-18' }, { n: 2 }))).status, 'applied');
    });

    test('a person type people only read: their own row, written only by a system intent (ADR 0019)', async () => {
      await code(as(A)((w) => w.put('membership', { since: '2026-01-01', via: 'self' })), 'system_only', 'membership');
      await sys('members', OWNER)((w) => w.put('membership', { user_id: A, since: '2026-01-01', via: 'invitation' }));
      assert.deepEqual((await as(A)((w) => w.find('membership'))).rows, [{ since: '2026-01-01', via: 'invitation' }]);
      assert.deepEqual((await as(B)((w) => w.find('membership'))).rows, []);
      await code(as(A)((w) => w.update('membership', {}, { via: 'self' })), 'system_only', 'membership');
      await code(as(A)((w) => w.remove('membership', {})), 'system_only', 'membership');
      assert.equal((await sys('members', OWNER)((w) => w.update('membership', { user_id: A }, { via: 'existing' }))).status, 'applied');
    });

    test('one person never finds, counts, changes or removes another’s rows', async () => {
      const id = uuidv7();
      await as(A)((w) => w.put('keys', { version: 7, wrapped: 'mine' }));
      await as(A)((w) => w.put('docs', { id, title: 'A’s' }));
      assert.equal((await as(B)((w) => w.find('docs', { where: { id } }))).rows.length, 0);
      assert.equal(await as(B)((w) => w.count('docs', { where: { id } })), 0);
      assert.equal((await as(B)((w) => w.update('docs', { id }, { title: 'taken' }, 1))).status, 'not_found');
      assert.equal(await as(B)((w) => w.remove('docs', { id })), false);
      assert.equal(await as(B)((w) => w.remove('keys', { version: 7 })), false);
      // The same key for B is B's own row, not a clash with A's.
      await as(B)((w) => w.put('keys', { version: 7, wrapped: 'theirs' }));
      assert.equal((await as(A)((w) => w.find('keys', { where: { version: 7 } }))).rows[0]!.wrapped, 'mine');
      assert.equal((await as(A)((w) => w.find('docs', { where: { id } }))).rows[0]!.title, 'A’s');
    });

    test('shared types: any person reads, only a system intent writes; system types: only system intents', async () => {
      await code(as(A)((w) => w.put('settings', { name: 'signup', value: { open: true } })), 'system_only', 'settings');
      await sys('set_signup', OWNER)((w) => w.put('settings', { name: 'signup', value: { open: true } }));
      assert.deepEqual((await as(B)((w) => w.find('settings', { where: { name: 'signup' } }))).rows, [{ name: 'signup', value: { open: true } }]);
      await code(as(A)((w) => w.find('invitations')), 'system_only', 'invitations');
      await code(as(A)((w) => w.count('invitations')), 'system_only', 'invitations');
      await code(as(A)((w) => w.put('invitations', { id: uuidv7(), code: 'X', email: 'a@b.c' })), 'system_only', 'invitations');
    });

    test('system intents: declared, kept to their types, across people where allowed, and audited without content', async () => {
      assert.throws(() => s.work({ system: 'nope' }, async () => 1), (e: unknown) => e instanceof EngineError && e.code === 'unknown_system_intent');
      const inv = uuidv7();
      await sys('invite', OWNER)((w) => w.put('invitations', { id: inv, code: 'ABCD-EFGH-JKLM', email: 'someone@example.com', redeemed_at: null }));
      const found = await sys('invite')((w) => w.find('invitations', { where: { code: 'ABCD-EFGH-JKLM', redeemed_at: { is: null } } }));
      assert.equal(found.rows.length, 1);
      assert.equal((await sys('invite')((w) => w.update('invitations', { id: inv }, { redeemed_at: new Date().toISOString() }))).status, 'applied');
      await code(sys('invite')((w) => w.find('docs')), 'not_permitted', 'docs');
      await code(sys('owner_report')((w) => w.put('settings', { name: 'x', value: 1 })), 'not_permitted', 'settings');
      // Reading people's rows: every person's, each with its person, for the declared intent only.
      const n = await sys('owner_report', OWNER)((w) => w.count('docs'));
      assert.ok(n >= 2);
      const page = await sys('owner_report', OWNER)((w) => w.find('docs', { limit: 1000 }));
      const people = new Set(page.rows.map((x) => x.user_id));
      assert.ok(people.has(A) && people.size >= 2, 'rows of more than one person, each labelled');
      // …filtered and grouped by whose they are (a person unit can't name anyone: its own rows are all it has)
      const onlyA = await sys('owner_report')((w) => w.find('docs', { where: { user_id: A }, limit: 1000 }));
      assert.ok(onlyA.rows.length > 0 && onlyA.rows.every((x) => x.user_id === A));
      const perPerson = await sys('owner_report')((w) => w.summarize('docs', { by: ['user_id'], measures: { n: { count: true } } }));
      assert.equal(perPerson.find((x) => x.user_id === A)!.n, onlyA.rows.length);
      await code(as(A)((w) => w.find('docs', { where: { user_id: B } as never })), 'not_queryable', 'user_id');
      // Records, the change feed and prefs are one person's.
      await code(sys('owner_report')((w) => w.prefs.get()), 'person_scope_only');
      await code(sys('owner_report')((w) => w.changes(0, 10)), 'person_scope_only');
      await code(sys('owner_report')((w) => w.get('notes', uuidv7())), 'person_scope_only');
      // A system intent writing a person's type names the person.
      await code(sys('owner_report')((w) => w.put('docs', { id: uuidv7(), title: 'x' })), 'not_permitted', 'docs');

      const log = await r.audit();
      const mine = log.filter((x) => x.intent === 'invite' || x.intent === 'owner_report');
      assert.deepEqual(
        mine.map((x) => [x.intent, x.by_person ?? x.by ?? null, x.type, x.action, Number(x.rows)]).slice(0, 3),
        [['invite', OWNER, 'invitations', 'put', 1], ['invite', null, 'invitations', 'find', 1], ['invite', null, 'invitations', 'update', 1]],
      );
      assert.ok(mine.some((x) => x.intent === 'owner_report' && x.action === 'find' && Number(x.rows) === page.rows.length));
      const text = JSON.stringify(log);
      for (const secret of ['someone@example.com', 'ABCD-EFGH-JKLM', 'secret words']) assert.ok(!text.includes(secret), 'no values in the audit');
      // Person units aren't audited.
      assert.ok(!log.some((x) => x.intent === undefined || x.intent === null));
    });

    test('a unit that throws leaves nothing behind, its audit included', async () => {
      const id = uuidv7();
      const before = (await r.audit()).length;
      await assert.rejects(
        sys('invite', OWNER)(async (w) => {
          await w.put('invitations', { id, code: 'ZZZZ-ZZZZ-ZZZZ', email: 'x@y.z' });
          throw new Error('stop');
        }),
        /stop/,
      );
      assert.equal((await r.audit()).length, before, 'the audit of a unit that didn’t land is gone with it');
      assert.equal(await sys('invite')((w) => w.count('invitations', { where: { code: 'ZZZZ-ZZZZ-ZZZZ' } })), 0);
    });

    test('attempt: what it did is undone when it throws, the rest of the unit lands; kept when it returns (ADR 0025)', async () => {
      const kept = uuidv7(), undone = uuidv7(), inner = uuidv7(), after = uuidv7();
      const out = await as(A)(async (w) => {
        await w.put('docs', { id: kept, title: 'before' });
        await assert.rejects(
          w.attempt(async (t) => {
            await t.put('docs', { id: undone, title: 'tried' });
            assert.equal((await t.update('docs', { id: kept }, { title: 'changed in the attempt' }, 1)).status, 'applied');
            assert.equal((await t.find('docs', { where: { id: undone } })).rows.length, 1, 'seen inside the attempt');
            throw new Error('no');
          }),
          /no/,
        );
        const r = await w.attempt(async (t) => {
          await t.put('docs', { id: inner, title: 'kept' });
          // nested: the inner one undone, the outer one kept
          await assert.rejects(t.attempt(async (u) => { await u.put('docs', { id: after, title: 'x' }); throw new Error('inner'); }), /inner/);
          return 'done';
        });
        assert.equal((await w.find('docs', { where: { id: undone } })).rows.length, 0, 'undone in the rest of the unit');
        return r;
      });
      assert.equal(out, 'done');
      const titles = Object.fromEntries((await as(A)((w) => w.find('docs', { where: { id: { in: [kept, undone, inner, after] } } }))).rows.map((x) => [x.id, x.title]));
      assert.deepEqual(titles, { [kept]: 'before', [inner]: 'kept' });
      // in a system unit too, kept to its intent
      await assert.rejects(sys('invite', OWNER)((w) => w.attempt((t) => t.put('docs', { id: uuidv7(), title: 'x' }))), EngineError);
    });

    test('summaries: groups (fields, JSON paths, a local day), counts, distinct and conditional counts, sums, percentiles, order and limit', async () => {
      const ev = (viewer: string, sid: string, t: string, a: string, tab: string | null, e: Row) => sys('analytics')((w) => w.put('events', { id: uuidv7(), viewer, sid, t, a, tab, e }));
      // Two viewers over two New York days (the 03:30Z event is still the 19th there).
      await ev('v1', 's1', '2026-11-19T15:00:00.000Z', 'view', 'today', {});
      await ev('v1', 's1', '2026-11-19T15:01:00.000Z', 'dwell', 'today', { dur: 1000 });
      await ev('v1', 's1', '2026-11-19T15:02:00.000Z', 'dwell', 'today', { dur: 3000 });
      await ev('v2', 's2', '2026-11-20T03:30:00.000Z', 'dwell', 'plan', { dur: 'not a number' });
      await ev('v2', 's2', '2026-11-20T15:00:00.000Z', 'unplanned', null, { name: 'swim' });
      await ev('v2', 's3', '2026-11-20T16:00:00.000Z', 'unplanned', null, { name: 'swim' });
      await ev('v2', 's3', '2026-11-20T16:01:00.000Z', 'error', 'plan', { test: true });
      const live = { test: { ne: true } };
      const [totals] = await sys('analytics')((w) => w.summarize('events', { where: live, measures: { viewers: { distinct: 'viewer' }, sessions: { distinct: 'sid' }, events: { count: true }, errors: { count: true, where: { a: 'error' } } } }));
      assert.deepEqual(totals, { viewers: 2, sessions: 3, events: 6, errors: 0 }, 'the test event is left out; a missing flag is not true');
      const daily = await sys('analytics')((w) => w.summarize('events', { by: [{ day: 't', zone: 'America/New_York', as: 'day' }], measures: { events: { count: true } }, order: 'day' }));
      assert.deepEqual(daily, [{ day: '2026-11-19', events: 4 }, { day: '2026-11-20', events: 3 }]);
      const dwell = await sys('analytics')((w) => w.summarize('events', { where: { a: 'dwell' }, by: ['tab'], measures: { ms: { sum: 'dur' }, visits: { count: true }, p50: { percentile: 'dur', p: 0.5 }, p75: { percentile: 'dur', p: 0.75 } }, order: '-visits' }));
      assert.deepEqual(dwell, [{ tab: 'today', ms: 4000, visits: 2, p50: 2000, p75: 2500 }, { tab: 'plan', ms: null, visits: 1, p50: null, p75: null }]);
      const named = await sys('analytics')((w) => w.summarize('events', { where: { a: { nin: ['view', 'dwell', 'error'] } }, by: ['name'], measures: { n: { count: true }, first: { min: 't' } }, order: '-n', limit: 1 }));
      assert.deepEqual(named, [{ name: 'swim', n: 2, first: '2026-11-20T15:00:00.000Z' }]);
      assert.equal((await sys('analytics')((w) => w.find('events', { where: { name: 'swim' } }))).rows.length, 2, 'a path is a query field');
      await code(sys('analytics')((w) => w.summarize('events', { measures: { s: { sum: 'a' } } })), 'not_a_number', 's');
      await code(sys('analytics')((w) => w.summarize('events', { by: [{ day: 'a', zone: 'UTC' }], measures: { n: { count: true } } })), 'not_a_time', 'a');
      await code(sys('analytics')((w) => w.summarize('events', { by: [{ day: 't', zone: 'Mars/Olympus' }], measures: { n: { count: true } } })), 'bad_zone');
      await code(sys('analytics')((w) => w.summarize('events', { measures: { n: { count: true }, m: { distinct: 'e' } } })), 'not_queryable', 'e');
      await code(as(A)((w) => w.summarize('events', { measures: { n: { count: true } } })), 'system_only', 'events');
      const log = await r.audit();
      assert.ok(log.some((x) => x.intent === 'analytics' && x.action === 'summarize'), 'summaries are audited');
    });

    test('summaries by a date part: year, quarter, month, ISO week and weekday of a date; and of a time in its zone, its hour (ADR 0030)', async () => {
      // a date: across a new year, the ISO week (from Monday 2025-12-29) staying one week
      for (const day of ['2025-12-29', '2026-01-01', '2026-01-05', '2026-04-02']) await as(A)((w) => w.put('days', { day, n: 1 }));
      const early = { day: { lt: '2026-06-01' } };
      const by = (part: 'year' | 'quarter' | 'month' | 'week' | 'weekday') =>
        as(A)((w) => w.summarize('days', { where: early, by: [{ part, field: 'day' }], measures: { days: { count: true } }, order: `day_${part}` }));
      assert.deepEqual(await by('year'), [{ day_year: 2025, days: 1 }, { day_year: 2026, days: 3 }]);
      assert.deepEqual(await by('quarter'), [{ day_quarter: '2025-Q4', days: 1 }, { day_quarter: '2026-Q1', days: 2 }, { day_quarter: '2026-Q2', days: 1 }]);
      assert.deepEqual(await by('month'), [{ day_month: '2025-12', days: 1 }, { day_month: '2026-01', days: 2 }, { day_month: '2026-04', days: 1 }]);
      assert.deepEqual(await by('week'), [{ day_week: '2025-12-29', days: 2 }, { day_week: '2026-01-05', days: 1 }, { day_week: '2026-03-30', days: 1 }]);
      assert.deepEqual(await by('weekday'), [{ day_weekday: 1, days: 2 }, { day_weekday: 4, days: 2 }], 'Monday 1, Thursday 4');
      // two parts at once, named
      const both = await as(A)((w) => w.summarize('days', { where: early, by: [{ part: 'year', field: 'day', as: 'y' }, { part: 'month', field: 'day', as: 'm' }], measures: { days: { count: true } }, order: 'm' }));
      assert.deepEqual(both, [{ y: 2025, m: '2025-12', days: 1 }, { y: 2026, m: '2026-01', days: 2 }, { y: 2026, m: '2026-04', days: 1 }]);

      // a time, in its zone: 03:30Z on New Year's Day is still 2025 in New York, a Wednesday at 22:00
      const ev = (t: string) => sys('analytics')((w) => w.put('events', { id: uuidv7(), viewer: 'v9', sid: 's9', t, a: 'view', tab: 'parts', e: {} }));
      await ev('2026-01-01T03:30:00.000Z');
      await ev('2026-01-01T15:00:00.000Z');
      const at = (part: 'year' | 'weekday' | 'hour', zone: string) =>
        sys('analytics')((w) => w.summarize('events', { where: { tab: 'parts' }, by: [{ part, field: 't', zone }], measures: { n: { count: true } }, order: `t_${part}` }));
      assert.deepEqual(await at('year', 'America/New_York'), [{ t_year: 2025, n: 1 }, { t_year: 2026, n: 1 }]);
      assert.deepEqual(await at('year', 'UTC'), [{ t_year: 2026, n: 2 }], 'the zone decides');
      assert.deepEqual(await at('weekday', 'America/New_York'), [{ t_weekday: 3, n: 1 }, { t_weekday: 4, n: 1 }]);
      assert.deepEqual(await at('hour', 'America/New_York'), [{ t_hour: 10, n: 1 }, { t_hour: 22, n: 1 }]);

      const n = { n: { count: true as const } };
      await code(as(A)((w) => w.summarize('days', { by: [{ part: 'decade' as 'year', field: 'day' }], measures: n })), 'bad_part', 'part');
      await code(sys('analytics')((w) => w.summarize('events', { by: [{ part: 'year', field: 'a' }], measures: n })), 'not_a_date', 'a');
      await code(as(A)((w) => w.summarize('days', { by: [{ part: 'year', field: 'day', zone: 'UTC' }], measures: n })), 'bad_zone', 'zone');
      await code(as(A)((w) => w.summarize('days', { by: [{ part: 'hour', field: 'day' }], measures: n })), 'not_a_time', 'day');
      await code(sys('analytics')((w) => w.summarize('events', { by: [{ part: 'year', field: 't' }], measures: n })), 'bad_zone', 'zone');
      await code(sys('analytics')((w) => w.summarize('events', { by: [{ part: 'year', field: 't', zone: 'Mars/Olympus' }], measures: n })), 'bad_zone', 'zone');
    });

    test('a summary measures any number column of a declared type, query field or not, over a range (ADR 0031)', async () => {
      const P = uuidv7();
      for (const [day, n] of [['2026-03-01', 2], ['2026-03-15', 4], ['2026-04-02', 9], ['2026-05-20', 100]] as const) await as(P)((w) => w.put('days', { day, n }));
      // n isn't a query field of days: summed, averaged, its lowest, highest and median, by month, in a range
      const rows = await as(P)((w) => w.summarize('days', { where: { day: { gte: '2026-03-01', lte: '2026-04-30' } }, by: [{ part: 'month', field: 'day', as: 'm' }],
        measures: { total: { sum: 'n' }, mean: { avg: 'n' }, lo: { min: 'n' }, hi: { max: 'n' }, mid: { percentile: 'n', p: 0.5 } }, order: 'm' }));
      assert.deepEqual(rows.map((r) => ({ ...r, mean: Number(r.mean), mid: Number(r.mid) })),
        [{ m: '2026-03', total: 6, mean: 3, lo: 2, hi: 4, mid: 3 }, { m: '2026-04', total: 9, mean: 9, lo: 9, hi: 9, mid: 9 }]);
      // still query fields only: filtering, grouping, ordering and distinct by it
      await code(as(P)((w) => w.summarize('days', { where: { n: 2 }, measures: { c: { count: true } } })), 'not_queryable', 'n');
      await code(as(P)((w) => w.summarize('days', { by: ['n'], measures: { c: { count: true } } })), 'not_queryable', 'n');
      await code(as(P)((w) => w.summarize('days', { measures: { d: { distinct: 'n' } } })), 'not_queryable', 'n');
      await code(as(P)((w) => w.find('days', { order: 'n' })), 'not_queryable', 'n');
      // a column that isn't declared, or isn't a number, is refused as before
      await code(as(P)((w) => w.summarize('days', { measures: { s: { sum: 'ghost' } } })), 'not_queryable', 'ghost');
      await code(as(P)((w) => w.summarize('membership', { measures: { s: { max: 'via' } } })), 'not_queryable', 'via');
    });

    test('a find, count or summary bounds any number column of a declared type; looking rows up by its value still needs a query field (ADR 0032)', async () => {
      const P = uuidv7();
      for (const [day, n] of [['2026-06-01', 2], ['2026-06-02', 5], ['2026-06-03', 8], ['2026-06-04', 12]] as const) await as(P)((w) => w.put('days', { day, n }));
      await as(P)((w) => w.put('days', { day: '2026-06-05' }));
      const june = { gte: '2026-06-01', lte: '2026-06-30' };
      // a bound, a range, is null: in a find, a count, a summary and a measure's own where
      const days = async (where: Record<string, unknown>) => (await as(P)((w) => w.find('days', { where: { day: june, ...where }, order: 'day' }))).rows.map((r) => r.n);
      assert.deepEqual(await days({ n: { gte: 5 } }), [5, 8, 12]);
      assert.deepEqual(await days({ n: { gt: 2, lt: 12 } }), [5, 8]);
      assert.deepEqual(await days({ n: { is: null } }), [null]);
      assert.deepEqual(await days({ n: { not: null } }), [2, 5, 8, 12]);
      assert.equal(await as(P)((w) => w.count('days', { where: { day: june, n: { lte: 5 } } })), 2);
      const [s] = await as(P)((w) => w.summarize('days', { where: { day: june, n: { gte: 5, lte: 12 } }, measures: { c: { count: true }, total: { sum: 'n' }, big: { count: true, where: { n: { gt: 10 } } } } }));
      assert.deepEqual(s, { c: 3, total: 25, big: 1 });
      // values, lists, and anything else that looks rows up by n: still query fields only
      await code(as(P)((w) => w.find('days', { where: { n: 5 } })), 'not_queryable', 'n');
      await code(as(P)((w) => w.find('days', { where: { n: { in: [2, 5] } } })), 'not_queryable', 'n');
      await code(as(P)((w) => w.find('days', { where: { n: { ne: 5 } } })), 'not_queryable', 'n');
      await code(as(P)((w) => w.count('days', { where: { n: { gte: 1, gt: 2 } } })), 'bad_match', 'n');
      await code(as(P)((w) => w.find('days', { where: { n: null } })), 'not_queryable', 'n');
      // a bound must be a number; a text column can't be bounded this way
      await code(as(P)((w) => w.find('days', { where: { n: { gte: 'five' } } })), 'bad_value', 'n');
      await code(as(P)((w) => w.find('membership', { where: { via: { gte: 'a' } } })), 'not_queryable', 'via');
    });

    test('a view: read like any type (find, count, summarize), never written', async () => {
      const page = await sys('analytics')((w) => w.find('timed', { where: { a: 'dwell' } }));
      assert.deepEqual(page.rows.map((x) => x.ms).sort(), [1000, 3000]);
      assert.equal(await sys('analytics')((w) => w.count('timed')), 2);
      const [sum] = await sys('analytics')((w) => w.summarize('timed', { measures: { ms: { sum: 'ms' } } }));
      assert.equal(sum!.ms, 4000);
      await code(sys('analytics')((w) => w.put('timed', { id: uuidv7(), a: 'x', ms: 1 })), 'read_only', 'timed');
      await code(sys('analytics')((w) => w.remove('timed', { id: uuidv7() })), 'read_only', 'timed');
    });

    test('a removable view: read, rows removed through it by a system intent, never put or updated (ADR 0020)', async () => {
      const id = uuidv7();
      await sys('invite')((w) => w.put('invitations', { id, code: 'VIEW-ROWS-0001', email: 'gone@example.com' }));
      assert.equal(await sys('account_delete')((w) => w.count('accounts', { where: { email: 'gone@example.com' } })), 1);
      await code(sys('account_delete')((w) => w.update('accounts', { id }, { email: 'x@y.z' })), 'read_only', 'accounts');
      await code(sys('account_delete')((w) => w.put('accounts', { id: uuidv7(), email: 'x@y.z' })), 'read_only', 'accounts');
      assert.equal(await sys('account_delete')((w) => w.remove('accounts', { id })), true);
      assert.equal(await sys('invite')((w) => w.count('invitations', { where: { id } })), 0, 'gone from the table under it');
      await code(as(A)((w) => w.find('accounts')), 'system_only', 'accounts');
    });

    test('removeWhere: every matching row of a system type in one statement, by a system intent that writes it (ADR 0023)', async () => {
      const v1 = 'rw-' + uuidv7(), v2 = 'rw-' + uuidv7();
      for (const v of [v1, v1, v1, v2]) await sys('analytics')((w) => w.put('events', { id: uuidv7(), viewer: v, sid: 's', t: '2026-11-19T00:00:00Z', a: 'open', tab: 'x', e: {} }));
      const P = uuidv7();
      await code(as(P)((w) => w.removeWhere('events', { viewer: v1 })), 'system_only', 'removeWhere');
      await code(sys('invite')((w) => w.removeWhere('events', { viewer: v1 })), 'not_permitted', 'events');
      await code(sys('analytics')((w) => w.removeWhere('events', {})), 'where_required', 'events');
      await code(sys('analytics')((w) => w.removeWhere('events', { e: 'x' })), 'not_queryable', 'e');
      await code(sys('erase_person')((w) => w.removeWhere('keys', { version: 1 })), 'system_type_only', 'keys');
      const before = (await r.audit()).length;
      assert.equal(await sys('analytics')((w) => w.removeWhere('events', { viewer: v1 })), 3);
      assert.equal(await sys('analytics')((w) => w.removeWhere('events', { viewer: v1 })), 0);
      assert.equal(await sys('analytics')((w) => w.count('events', { where: { viewer: v2 } })), 1, 'the other viewer’s rows are untouched');
      const lines = (await r.audit()).slice(before).filter((x) => x.action === 'remove');
      assert.deepEqual(lines.map((x) => Number(x.rows)), [3, 0], 'one audit line a call, with the count');
    });

    test('erase: every row of one person, by a system intent that declares it, keeping what it says (ADR 0022)', async () => {
      const Z = uuidv7(), Y = uuidv7();
      for (const p of [Z, Y]) {
        await as(p)((w) => w.put('docs', { id: uuidv7(), title: 'mine' }));
        await as(p)((w) => w.put('keys', { version: 1, wrapped: 'k' }));
        await as(p)((w) => w.put('days', { day: '2026-11-18', n: 1 }));
        await as(p)((w) => w.put('account', { prefs: { a: 1 } }));
        await sys('members')((w) => w.put('membership', { user_id: p, since: '2026-01-01', via: 'invitation' }));
      }
      await code(as(Z)((w) => w.erase(Z)), 'system_only', 'erase');
      await code(sys('members')((w) => w.erase(Z)), 'not_permitted', 'erase');
      await code(sys('erase_person')((w) => w.erase('not-a-person')), 'bad_value', 'person');
      const removed = await sys('erase_person', OWNER)((w) => w.erase(Z, { keep: ['membership'] }));
      assert.deepEqual([removed.docs, removed.keys, removed.days, removed.account], [1, 1, 1, 1]);
      assert.equal(removed.membership, undefined, 'kept');
      for (const t of ['docs', 'keys', 'days', 'account'] as const) {
        assert.equal(await as(Z)((w) => w.count(t)), 0, `${t}: Z's gone`);
        assert.equal(await as(Y)((w) => w.count(t)), 1, `${t}: Y's untouched`);
      }
      assert.equal((await as(Z)((w) => w.find('membership'))).rows.length, 1, 'membership kept');
      const log = await r.audit();
      assert.ok(log.some((x) => x.intent === 'erase_person' && x.action === 'erase' && Number(x.rows) >= 4));
    });

    test('erase takes the person out of the audit: their lines stay, naming no one; hold is a system unit’s (ADR 0024)', async () => {
      const Z = uuidv7(), Y = uuidv7();
      for (const p of [Z, Y]) await sys('members', p)((w) => w.put('membership', { user_id: p, since: '2026-01-01', via: 'invitation' }));
      const named = async (p: string) => (await r.audit()).filter((x) => String(x.by_person ?? '').toLowerCase() === p.toLowerCase()).length;
      assert.ok((await named(Z)) >= 1);
      const lines = (await r.audit()).length;
      await sys('erase_person', Z)((w) => w.erase(Z)); // by the person themself, as when they delete their own account
      assert.equal(await named(Z), 0, 'Z is named nowhere, the erase line included');
      assert.ok((await named(Y)) >= 1, 'others are still named');
      const log = await r.audit();
      assert.equal(log.length, lines + 1, 'no line is removed');
      assert.equal(log[log.length - 1]!.action, 'erase');
      assert.equal(log[log.length - 1]!.by_person, null);
      // an owner erasing someone else is still named
      await sys('erase_person', OWNER)((w) => w.erase(Y));
      const last = (await r.audit()).at(-1)!;
      assert.equal(String(last.by_person).toLowerCase(), OWNER.toLowerCase());
      await code(as(Z)((w) => w.hold(Z)), 'system_only', 'hold');
      await code(sys('members')((w) => w.hold('nobody')), 'bad_value', 'person');
      await sys('members')((w) => w.hold(Z));
    });

    test('put on a taken key: update, or leave it; a lock holds for the unit', async () => {
      const first = await sys('analytics')((w) => w.put('viewers', { viewer: 'v9', first_seen: '2026-11-01T00:00:00.000Z', last_seen: '2026-11-01T00:00:00.000Z', os: 'ios' }));
      assert.equal(first!.os, 'ios');
      const updated = await sys('analytics')((w) => w.put('viewers', { viewer: 'v9', last_seen: '2026-11-18T00:00:00.000Z', os: 'android' }, { onConflict: 'update' }));
      assert.deepEqual([updated!.first_seen, updated!.last_seen, updated!.os], ['2026-11-01T00:00:00.000Z', '2026-11-18T00:00:00.000Z', 'android'], 'only the given fields change');
      assert.equal(await sys('analytics')((w) => w.put('viewers', { viewer: 'v9', os: 'x' }, { onConflict: 'nothing' })), null);
      await code(sys('analytics')((w) => w.put('viewers', { viewer: 'v9', os: 'x' })), 'refused');
      // Two units after the same lock: the second waits for the first to end.
      const order: string[] = [];
      await Promise.all([
        as(A)(async (w) => { await w.lock('tokens:A'); order.push('a1'); await new Promise((res) => setTimeout(res, 50)); order.push('a2'); }),
        new Promise((res) => setTimeout(res, 10)).then(() => as(A)(async (w) => { await w.lock('tokens:A'); order.push('b'); })),
      ]);
      assert.deepEqual(order, ['a1', 'a2', 'b']);
      await code(as(A)((w) => w.lock('')), 'bad_lock');
    });

    test('putMany: many rows at once, each checked as put checks it, in statements of up to 500 (ADR 0029)', async () => {
      const P = uuidv7();
      const day = (i: number) => new Date(Date.UTC(2020, 0, 1) + i * 864e5).toISOString().slice(0, 10);
      // more than one statement's worth
      assert.equal(await as(P)((w) => w.putMany('days', Array.from({ length: 1200 }, (_, i) => ({ day: day(i), n: i })))), 1200);
      assert.equal(await as(P)((w) => w.count('days')), 1200);
      assert.equal(await as(B)((w) => w.count('days', { where: { day: day(0) } })), 0, 'the rows are the unit’s person’s');
      // update: only the given fields change; a key twice is one row, the later fields over the earlier
      assert.equal(await as(P)((w) => w.putMany('days', [{ day: day(0), n: 5 }, { day: day(0), n: 6 }, { day: '2030-01-01', n: 1 }], { onConflict: 'update' })), 2);
      assert.equal((await as(P)((w) => w.find('days', { where: { day: day(0) } }))).rows[0]!.n, 6);
      // nothing: only free keys are written, and counted
      assert.equal(await as(P)((w) => w.putMany('days', [{ day: day(1), n: 99 }, { day: '2031-01-01', n: 1 }], { onConflict: 'nothing' })), 1);
      assert.equal((await as(P)((w) => w.find('days', { where: { day: day(1) } }))).rows[0]!.n, 1);
      // a taken key without onConflict refuses the whole call: nothing of it stays, and the unit carries on
      await as(P)(async (w) => {
        await code(w.putMany('days', [{ day: '2032-01-01', n: 1 }, { day: day(2), n: 1 }]), 'refused');
        assert.equal(await w.count('days', { where: { day: { gte: '2032-01-01' } } }), 0);
        assert.equal(await w.putMany('days', [{ day: '2032-01-01', n: 1 }]), 1);
      });
      // every row checked before anything is written
      await code(as(P)((w) => w.putMany('days', [{ day: '2033-01-01', n: 1 }, { day: '2026-02-30', n: 1 }])), 'bad_value', 'day');
      await code(as(P)((w) => w.putMany('days', [{ day: '2033-01-01', n: 1, color: 'red' }])), 'unknown_field', 'color');
      await code(as(P)((w) => w.putMany('days', [{ day: '2033-01-01', n: 1, user_id: B }])), 'not_yours', 'user_id');
      assert.equal(await as(P)((w) => w.count('days', { where: { day: '2033-01-01' } })), 0);
      await code(as(P)((w) => w.putMany('days', 'x' as never)), 'bad_rows');
      await code(as(P)((w) => w.putMany('days', [null as never])), 'bad_rows');
      await code(as(P)((w) => w.putMany('days', [], { onConflict: 'replace' as never })), 'bad_on_conflict');
      await code(as(P)((w) => w.putMany('days', Array.from({ length: 10_001 }, (_, i) => ({ day: day(i % 300), n: i })))), 'too_many_rows');
      await code(as(P)((w) => w.putMany('membership', [{ since: '2026-01-01', via: 'self' }])), 'system_only', 'membership');
      await code(as(P)((w) => w.putMany('notes', [{}])), 'records_use_apply', 'notes');
      await code(as(P)((w) => w.putMany('timed', [{ id: uuidv7(), a: 'x', ms: 1 }])), 'read_only', 'timed');
      assert.equal(await as(P)((w) => w.putMany('days', [])), 0);
      // sealed fields are sealed and versions start at 1, as with put
      const id = uuidv7();
      assert.equal(await as(P)((w) => w.putMany('docs', [{ id, title: 'bulk', body: { text: 'secret words' } }])), 1);
      assert.deepEqual((await as(P)((w) => w.find('docs', { where: { id } }))).rows.map((x) => [x.body, x.version]), [[{ text: 'secret words' }, 1]]);
      assert.equal(typeof ((await r.raw('docs')).find((x) => x.id === id)!.body as Row).sealed, 'string');
      // rows that give different fields: each updates only its own
      await sys('analytics')((w) => w.putMany('viewers', [
        { viewer: 'm1', first_seen: '2026-11-01T00:00:00.000Z', os: 'ios' },
        { viewer: 'm2', first_seen: '2026-11-02T00:00:00.000Z', os: 'ios' },
      ]));
      await sys('analytics')((w) => w.putMany('viewers', [{ viewer: 'm1', os: 'android' }, { viewer: 'm2', last_seen: '2026-11-20T00:00:00.000Z' }], { onConflict: 'update' }));
      const m = (await sys('analytics')((w) => w.find('viewers', { where: { viewer: { in: ['m1', 'm2'] } } }))).rows;
      assert.deepEqual(m.map((x) => [x.viewer, x.first_seen, x.os, x.last_seen]), [
        ['m1', '2026-11-01T00:00:00.000Z', 'android', null],
        ['m2', '2026-11-02T00:00:00.000Z', 'ios', '2026-11-20T00:00:00.000Z'],
      ]);
      // a system unit's putMany is one audit line, with the count and no values
      const before = (await r.audit()).length;
      await sys('analytics')((w) => w.putMany('viewers', Array.from({ length: 30 }, (_, i) => ({ viewer: `bulk${i}`, os: 'ios' }))));
      const lines = (await r.audit()).slice(before);
      assert.deepEqual(lines.map((x) => [x.intent, x.type, x.action, Number(x.rows)]), [['analytics', 'viewers', 'put', 30]]);
    });

    test('errors carry a code and a field, never a value', async () => {
      const values = ['private text 1', 'someone-else@example.com'];
      // One at a time: a refusal started early would go unhandled while the one before it is awaited.
      for (const run of [
        () => as(A)((w) => w.put('docs', { id: uuidv7(), title: 123 as never, body: values[0] })),
        () => as(A)((w) => w.find('docs', { where: { title: { in: [values[1], 4] } } })),
      ])
        await assert.rejects(run(), (e: Error) => values.every((v) => !e.message.includes(v)));
    });
  });
}

// SQLite: the tables made from the declarations (plan and migrate), then the same contract.
{
  const path = join(mkdtempSync(join(tmpdir(), 'se2-int-')), 'intents.db');
  const engine = createEngine({ store: store(), backend: sqlite, types, system });
  let session: Session<T> | undefined;
  contract('SQLite, tables from the declarations', () => {
    session ??= engine.connect({ path });
    return {
      session,
      raw: async (t) => sqliteRows(path, `select * from "${t}"`) as Row[],
      audit: async () => sqliteRows(path, `select intent, by_person, type, action, rows from engine_audit order by id`) as Row[],
    };
  });
  before(async () => {
    await engine.migrate({ path }, await engine.plan({ path }));
    // The view is the app's (its migrations make it), so the test makes it here.
    sqliteExec(path, `create view accounts as select id, email from invitations`);
    sqliteExec(path, `create trigger accounts_delete instead of delete on accounts begin delete from invitations where id = old.id; end`);
    sqliteExec(path, `create view timed as select id, a, json_extract(e, '$.dur') as ms from events where json_type(e, '$.dur') in ('integer', 'real')`);
  });
}

describe('declarations are checked when the engine is made', () => {
  const mk = (t: Record<string, TypeDecl>, s: Record<string, SystemDecl> = {}) => () => createEngine({ store: store(), backend: postgres, types: t, system: s });
  const is = (c: string) => (e: unknown) => e instanceof EngineError && e.code === c;
  test('fields, keys, versions, sealing, engine tables and system intents', () => {
    assert.throws(mk({ a: { access: 'person', key: ['id'], fields: {} } }), is('undeclared_field'));
    assert.throws(mk({ a: { access: 'person', key: ['id'], fields: { id: 'id', n: 'text' }, sealed: ['n'] } }), is('sealed_not_json'));
    assert.throws(mk({ a: { access: 'person', key: ['id'], fields: { id: 'id', v: 'text' }, version: 'v' } }), is('version_not_number'));
    assert.throws(mk({ a: { access: 'person', key: ['id'], fields: { id: 'id', user_id: 'id' } } }), is('person_column_declared'));
    assert.throws(mk({ prefs: { access: 'person', key: [], fields: {} } }), is('engine_table'));
    assert.throws(mk({ notes: { access: 'system', key: ['id'], fields: { id: 'id' } } }), is('type_declared_twice'));
    assert.throws(mk({}, { x: { read: ['ghosts'] } }), is('unknown_type'));
    assert.doesNotThrow(mk(types, system));
  });
});

/** Postgres, with row-level security on for the person role; the system role may pass it, as a deployment sets up. */
const ddl = (S: string) => `
drop schema if exists ${S} cascade;
create schema ${S};
create function ${S}.current_user_id() returns uuid language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create table ${S}.notes (user_id uuid not null, id uuid not null, primary key (user_id, id));
create table ${S}.counters (user_id uuid primary key, rev bigint not null default 0, purged_rev bigint not null default 0);
create table ${S}.applied_ops (user_id uuid not null, op_id uuid not null, result jsonb not null, created_at timestamptz not null default now(), primary key (user_id, op_id));
create table ${S}.prefs (user_id uuid primary key, data jsonb not null default '{}', version integer not null default 1, updated_at timestamptz not null default now());
create table ${S}.docs (user_id uuid not null default ${S}.current_user_id(), id uuid not null, title text, rank double precision, done boolean, due timestamptz,
  body jsonb, version integer not null default 1, primary key (user_id, id));
create table ${S}.days (user_id uuid not null default ${S}.current_user_id(), day date not null, n integer, primary key (user_id, day));
create table ${S}.membership (user_id uuid primary key, since date, via text);
create table ${S}.account (user_id uuid primary key default ${S}.current_user_id(), prefs jsonb);
create table ${S}.keys (user_id uuid not null default ${S}.current_user_id(), version integer not null, wrapped text not null, primary key (user_id, version));
create table ${S}.settings (name text primary key, value jsonb not null);
create table ${S}.invitations (id uuid primary key, code text not null unique, email text not null, redeemed_at timestamptz);
create table ${S}.events (id uuid primary key, viewer text, sid text, t timestamptz, a text, tab text, e jsonb);
create view ${S}.accounts as select id, email from ${S}.invitations;
create view ${S}.timed as select id, a, (e ->> 'dur')::double precision as ms from ${S}.events where jsonb_typeof(e -> 'dur') = 'number';
create table ${S}.viewers (viewer text primary key, first_seen timestamptz, last_seen timestamptz, os text);
create table ${S}.engine_audit (id bigint generated always as identity primary key, at timestamptz not null default now(), intent text not null,
  by_person uuid, type text not null, action text not null, rows integer not null);
create function ${S}.forget_person(p uuid) returns integer language sql volatile security definer set search_path = '' as $$ with u as (update ${S}.engine_audit set by_person = null where by_person = p returning 1) select count(*)::int from u $$;
grant usage on schema ${S} to se2_int_api, se2_int_sys;
grant select, insert, update, delete on all tables in schema ${S} to se2_int_api, se2_int_sys;
grant execute on all functions in schema ${S} to se2_int_api, se2_int_sys;
${['docs', 'keys', 'account', 'days']
  .map((t) => `alter table ${S}.${t} enable row level security; alter table ${S}.${t} force row level security;
create policy own on ${S}.${t} for all to se2_int_api using (user_id = ${S}.current_user_id()) with check (user_id = ${S}.current_user_id());
create policy system on ${S}.${t} for all to se2_int_sys using (true) with check (true);`)
  .join('\n')}
alter table ${S}.membership enable row level security; alter table ${S}.membership force row level security;
create policy own_read on ${S}.membership for select to se2_int_api using (user_id = ${S}.current_user_id());
create policy system on ${S}.membership for all to se2_int_sys using (true) with check (true);
revoke insert, update, delete on ${S}.membership from se2_int_api;
alter table ${S}.settings enable row level security; alter table ${S}.settings force row level security;
create policy read on ${S}.settings for select to se2_int_api using (true);
create policy system on ${S}.settings for all to se2_int_sys using (true) with check (true);
revoke all on ${S}.invitations, ${S}.accounts, ${S}.events, ${S}.timed, ${S}.viewers, ${S}.engine_audit from se2_int_api;
`;

let admin: ReturnType<typeof pg> | undefined;
let pgSession: Session<T> | undefined;
const S = 'se2_int';
contract(
  'Postgres, row-level security on',
  () => {
    const engine = createEngine({ store: store(), backend: postgres, types, system });
    pgSession = engine.connect({ url: URL_!, schema: S, max: 2, role: 'se2_int_api', systemRole: 'se2_int_sys' });
    return {
      session: pgSession,
      raw: async (t) => (await admin!.unsafe(`select * from ${S}.${t}`)) as unknown as Row[],
      audit: async () => (await admin!.unsafe(`select intent, by_person::text as by_person, type, action, rows from ${S}.engine_audit order by id`)) as unknown as Row[],
    };
  },
  { skip: !URL_ && 'TEST_DATABASE_URL not set' },
);

if (URL_) {
  before(async () => {
    admin = pg(URL_, { max: 2, onnotice: () => {} });
    for (const role of ['se2_int_api', 'se2_int_sys'])
      await admin.unsafe(`do $$ begin if exists (select from pg_roles where rolname = '${role}') then execute 'drop owned by ${role}'; drop role ${role}; end if; end $$;`).catch(() => {});
    await admin.unsafe(`create role se2_int_api nologin; create role se2_int_sys nologin;` + ddl(S));
  });
  after(async () => {
    await pgSession?.close();
    await admin!.unsafe(`drop schema if exists ${S} cascade; drop owned by se2_int_api; drop owned by se2_int_sys; drop role if exists se2_int_api; drop role if exists se2_int_sys`);
    await admin!.end();
  });
}
