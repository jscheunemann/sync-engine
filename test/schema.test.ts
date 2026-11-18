// Tables from declarations (ADRs 0006, 0014): the plan is additive, adopts what's there, reports what it won't change;
// applied on Postgres it makes tables the engine then runs on, under its own row-level security, and plans nothing more.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'postgres';
import { EngineError, createEngine, type RecordStore, type SchemaPlan, type SystemDecl, type TypeDecl } from '../src/engine.ts';
import { uuidv7 } from '../src/ids.ts';
import { postgres } from '../src/postgres.ts';
import { type Catalog, NONE, plan } from '../src/postgres-schema.ts';

const URL_ = process.env.TEST_DATABASE_URL;
type T = 'tasks';
const store: RecordStore<T> = {
  types: ['tasks'],
  fields: { tasks: { title: 'text', due: 'json', tags: 'ids', notes: { kind: 'text', content: true } } },
  validate: () => [],
};
const types: Record<string, TypeDecl> = {
  keys: { access: 'person', key: ['version'], fields: { version: 'integer', wrapped: 'text' } },
  settings: { access: 'shared', key: ['name'], fields: { name: 'text', value: 'json' } },
  invitations: { access: 'system', key: ['id'], fields: { id: 'id', code: 'text', redeemed_at: 'time' }, query: ['code'] },
};
const system: Record<string, SystemDecl> = { invite: { write: ['invitations'] }, set: { write: ['settings'] } };

/** The layout the engine hands its backend, taken from a backend that records it. */
function layoutOf() {
  let seen: unknown;
  const spy = { kind: 'spy', connect: (_s: unknown, l: unknown) => ((seen = l), { unit: async () => undefined as never, close: async () => {} }), };
  createEngine({ store, backend: spy, types, system }).connect({});
  return seen as Parameters<typeof plan>[0];
}
const none: Record<string, Catalog> = {};
const one = (c: Catalog) => ({ app: c });
const opts = { schema: 'app', role: 'app_api', systemRole: 'app_sys', personSetting: 'app.user_id' };

describe('the plan', () => {
  test('from nothing: the schema, the engine’s tables, each table with its key, indexes, row-level security, grants', () => {
    const p = plan(layoutOf(), none, opts);
    assert.deepEqual(p.conflicts, []);
    const sql = p.steps.map((s) => s.sql).join('\n');
    assert.match(p.steps[0]!.sql, /^create schema "app";/);
    for (const t of ['counters', 'applied_ops', 'prefs', 'engine_audit', 'tasks', 'keys', 'settings', 'invitations']) assert.match(sql, new RegExp(`create table "app"\\."?${t}"? `), t);
    assert.match(sql, /"tags" uuid\[\] not null default '\{\}'/);
    assert.match(sql, /"due" jsonb/);
    assert.match(sql, /"user_id" uuid not null default "app"\.current_user_id\(\).*primary key \("user_id", "version"\)/);
    assert.match(sql, /"tasks_user_id_rev_idx" on "app"\."tasks" \("user_id", "rev"\)/);
    assert.match(sql, /"invitations_code_idx"/);
    assert.match(sql, /create policy "engine_person" on "app"\."keys" for all to "app_api" using \("user_id" = "app"\.current_user_id\(\)\)/);
    assert.match(sql, /create policy "engine_read" on "app"\."settings" for select to "app_api"/);
    assert.doesNotMatch(sql, /grant [a-z, ]+ on "app"\."invitations" to "app_api"/, 'system types: never the person role');
    assert.match(sql, /grant select, insert, update, delete on "app"\."invitations" to "app_sys"/);
    assert.ok(p.steps.every((s) => s.summary && !/drop|truncate|delete from|alter column/i.test(s.sql)), 'additive only');
  });

  test('adopting tables that are there: missing columns added (nullable), types that differ reported and left alone', () => {
    const have: Catalog = {
      ...NONE,
      schema: true,
      functions: ['current_user_id', 'next_rev'],
      columns: {
        counters: { user_id: 'uuid' }, applied_ops: { op_id: 'uuid' }, prefs: { data: 'jsonb' }, engine_audit: { id: 'int8' },
        tasks: { user_id: 'uuid', id: 'uuid', rev: 'int8', version: 'int4', created_at: 'timestamptz', updated_at: 'timestamp', client_updated_at: 'timestamptz', deleted_at: 'timestamptz', content: 'jsonb', enc: 'int2', key_version: 'int4', title: 'text', tags: '_uuid' },
        keys: { user_id: 'uuid', version: 'int4', wrapped: 'jsonb' },
      },
    };
    const p = plan(layoutOf(), one(have), opts);
    assert.deepEqual(p.conflicts, [
      { table: 'app.tasks', column: 'updated_at', issue: 'no_zone', want: 'timestamptz', have: 'timestamp' },
      { table: 'app.keys', column: 'wrapped', issue: 'type', want: 'text', have: 'jsonb' },
    ]);
    const sql = p.steps.map((s) => s.sql).join('\n');
    assert.match(sql, /alter table "app"\."tasks" add column "due" jsonb;/);
    assert.doesNotMatch(sql, /create table "app"\."(tasks|keys|counters)"/);
    assert.doesNotMatch(sql, /create schema|create function/);
  });

  test('a type in another schema, under a table name of its own, even one the engine uses in the app’s schema (ADR 0017)', () => {
    let seen: unknown;
    const spy = { kind: 'spy', connect: (_s: unknown, l: unknown) => ((seen = l), { unit: async () => undefined as never, close: async () => {} }) };
    createEngine({ store, backend: spy, types: { ...types, account_prefs: { access: 'person', table: 'prefs', key: [], fields: { prefs: 'json' } } }, system }).connect({});
    const p = plan(seen as Parameters<typeof plan>[0], {}, { ...opts, schemas: { account_prefs: 'other', invitations: 'other' } });
    const sql = p.steps.map((x) => x.sql).join('\n');
    assert.match(sql, /create schema "other";/);
    assert.match(sql, /grant usage on schema "other" to "app_api", "app_sys";/);
    assert.match(sql, /create table "other"\."prefs" \("user_id" uuid not null default "app"\.current_user_id\(\), "prefs" jsonb, primary key \("user_id"\)\);/);
    assert.match(sql, /create table "app"\.prefs /, 'the engine’s own prefs, in the app’s schema');
    assert.match(sql, /create table "other"\."invitations"/);
    assert.match(sql, /create policy "engine_person" on "other"\."prefs" for all to "app_api" using \("user_id" = "app"\.current_user_id\(\)\)/);
    assert.doesNotMatch(sql, /create table "app"\."invitations"/);
  });

  test('nothing to do when everything is there', () => {
    const p1 = plan(layoutOf(), none, opts);
    // What applying p1 leaves: every table and column, function, index, policy and grant it made.
    const have: Catalog = { schema: true, columns: {}, functions: ['current_user_id', 'next_rev'], rls: {}, policies: {}, indexes: [], grants: {}, usage: ['app_api', 'app_sys'] };
    for (const s of p1.steps) {
      const t = s.sql.match(/^create table "app"\."?([a-z_]+)"? \((.*)\);$/s);
      if (t) have.columns[t[1]!] = Object.fromEntries([...t[2]!.matchAll(/"([a-z_]+)" ([a-z ]+?)(?:\[\])?[ ,]/g)].map((m) => [m[1]!, 'x']));
      const i = s.sql.match(/create index if not exists "([^"]+)"/);
      if (i) have.indexes.push(i[1]!);
      const r = s.sql.match(/alter table "app"\."([a-z_]+)" (enable|force) row level security/);
      if (r) have.rls[r[1]!] = { ...(have.rls[r[1]!] ?? { enabled: false, forced: false }), [r[2] === 'enable' ? 'enabled' : 'forced']: true };
      const po = s.sql.match(/create policy "([a-z_]+)" on "app"\."([a-z_]+)"/);
      if (po) (have.policies[po[2]!] ??= []).push(po[1]!);
      const g = s.sql.match(/^grant ([a-z, ]+) on (function )?"app"\."([a-z_]+)"(?:\(\))? to "([a-z_]+)"/);
      if (g) ((have.grants[(g[2] ? 'fn:' : '') + g[3]!] ??= {})[g[4]!] ??= []).push(...g[1]!.split(', '));
    }
    const p2 = plan(layoutOf(), one(have), opts);
    assert.deepEqual(p2.steps.filter((s) => !s.sql.startsWith('alter table') || !/add column/.test(s.sql)).map((s) => s.summary), []);
  });
});

describe('tables from declarations, on Postgres', { skip: !URL_ && 'TEST_DATABASE_URL not set' }, () => {
  const S = 'se2_made';
  let admin: ReturnType<typeof pg>;
  const settings = { url: URL_!, schema: S, max: 2, role: 'se2_made_api', systemRole: 'se2_made_sys' };
  const engine = createEngine({ store, backend: postgres, types, system });

  before(async () => {
    admin = pg(URL_!, { max: 2, onnotice: () => {} });
    await admin.unsafe(`drop schema if exists ${S}_other cascade; drop schema if exists ${S} cascade`);
    for (const r of ['se2_made_api', 'se2_made_sys'])
      await admin.unsafe(`do $$ begin if exists (select from pg_roles where rolname = '${r}') then execute 'drop owned by ${r}'; drop role ${r}; end if; end $$; create role ${r} nologin;`);
  });
  after(async () => {
    await admin.unsafe(`drop schema if exists ${S}_other cascade; drop schema if exists ${S} cascade; drop owned by se2_made_api; drop owned by se2_made_sys; drop role if exists se2_made_api; drop role if exists se2_made_sys`);
    await admin.end();
  });

  test('plan, migrate, and nothing more to plan; a stale plan or a conflict is refused', async () => {
    const first = await engine.plan(settings);
    assert.ok(first.steps.length > 20);
    assert.deepEqual(first.conflicts, []);
    const stale: SchemaPlan = { ...first, steps: first.steps.slice(1) };
    await assert.rejects(engine.migrate(settings, stale), (e: unknown) => e instanceof EngineError && e.code === 'plan_out_of_date');
    await engine.migrate(settings, first);
    const again = await engine.plan(settings);
    assert.deepEqual(again.steps.map((s) => s.summary), [], 'applied: nothing left to do');
    await admin.unsafe(`alter table ${S}.keys alter column wrapped type jsonb using to_jsonb(wrapped)`);
    const conflicted = await engine.plan(settings);
    assert.deepEqual(conflicted.conflicts.map((c) => [c.table, c.column, c.issue]), [[`${S}.keys`, 'wrapped', 'type']]);
    await assert.rejects(engine.migrate(settings, conflicted), (e: unknown) => e instanceof EngineError && e.code === 'schema_conflicts');
    await admin.unsafe(`alter table ${S}.keys alter column wrapped type text using wrapped #>> '{}'`);
  });

  test('the engine runs on what it made: records, person and shared and system types, each kept to its own by row-level security', async () => {
    const session = engine.connect(settings);
    try {
      const A = uuidv7(), B = uuidv7();
      const [r] = await session.work({ person: A }, (w) => w.apply([{ op_id: uuidv7(), type: 'tasks', id: uuidv7(), base_version: null, fields: { title: 'x', tags: [uuidv7()], due: { kind: 'fixed', at: '2026-11-20T15:00:00.000Z' }, notes: 'n' } }]));
      assert.equal(r!.status, 'applied');
      await session.work({ person: A }, (w) => w.put('keys', { version: 1, wrapped: 'k' }));
      await session.work({ system: 'set', by: A }, (w) => w.put('settings', { name: 'signup', value: { open: true } }));
      assert.equal((await session.work({ person: B }, (w) => w.find('settings'))).rows.length, 1);
      await session.work({ system: 'invite' }, (w) => w.put('invitations', { id: uuidv7(), code: 'C1', redeemed_at: null }));
      assert.equal(await session.work({ system: 'invite' }, (w) => w.count('invitations', { where: { code: 'C1' } })), 1);
      assert.equal((await session.work({ person: B }, (w) => w.changes(0, 10))).changes.length, 0);
      assert.equal((await session.work({ person: B }, (w) => w.find('keys'))).rows.length, 0);
      // Row-level security alone: as the person role with B's id set, A's rows aren't there.
      const seen = await admin.begin(async (tx) => {
        await tx.unsafe(`set local role se2_made_api; select set_config('app.user_id', '${B}', true)`);
        return [...(await tx.unsafe(`select count(*)::int as n from ${S}.tasks`)), ...(await tx.unsafe(`select count(*)::int as n from ${S}.keys`))].map((x) => x.n);
      });
      assert.deepEqual(seen, [0, 0]);
      await assert.rejects(
        admin.begin(async (tx) => {
          await tx.unsafe(`set local role se2_made_api`);
          await tx.unsafe(`select * from ${S}.invitations`);
        }),
        /permission denied/,
      );
      const audit = await admin.unsafe(`select intent, action from ${S}.engine_audit order by id`);
      assert.deepEqual(audit.map((a) => `${a.intent}:${a.action}`), ['set:put', 'invite:put', 'invite:count']);
    } finally {
      await session.close();
    }
  });

  test('a type kept in another schema, its table named like the engine’s own prefs, both used in one unit (ADR 0017)', async () => {
    const more = createEngine({ store, backend: postgres, types: { ...types, account_prefs: { access: 'person', table: 'prefs', key: [], fields: { prefs: 'json' } } }, system });
    const at = { ...settings, schemas: { account_prefs: `${S}_other` } };
    await more.migrate(at, await more.plan(at));
    assert.deepEqual((await more.plan(at)).steps.map((x) => x.summary), []);
    const session = more.connect(at);
    try {
      const P = uuidv7();
      await session.work({ person: P }, async (w) => {
        await w.put('account_prefs', { prefs: { analytics: false } });
        await w.prefs.put({ theme: 'dark' }, 0);
      });
      const [mine, engines] = await session.work({ person: P }, async (w) => [(await w.find('account_prefs')).rows, await w.prefs.get()]);
      assert.deepEqual(mine, [{ prefs: { analytics: false } }]);
      assert.deepEqual((engines as { data: unknown }).data, { theme: 'dark' });
      const [where] = await admin.unsafe(`select (select count(*)::int from ${S}_other.prefs) as other, (select count(*)::int from ${S}.prefs where user_id = $1) as engine`, [P]);
      assert.deepEqual([where!.other, where!.engine], [1, 1]);
    } finally {
      await session.close();
    }
    assert.throws(() => more.connect({ ...settings, schemas: { account_prefs: S } }), /engine_table/, 'not in the engine’s own schema under its table’s name');
    assert.throws(() => more.connect({ ...settings, schemas: { nobody: S } }), /unknown_type/);
  });
});
