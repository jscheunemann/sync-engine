// SQLite, the second backend (ADR 0005), for tests only: the same contract cases run on it as on Postgres, so the core
// can't lean on anything Postgres has. It uses Node's built-in `node:sqlite`; nothing here ships in the package.
//
// What differs from Postgres, and stays in here: no schemas (tables by name), no row-level security (isolation is the
// engine's alone, ADR 0007), values by kind as SQLite stores them (times as ISO text, JSON and id lists as JSON text,
// booleans as 0/1), and one writer at a time (units are queued).

import { DatabaseSync } from 'node:sqlite';
import { type Backend, type Cond, isSystem, type Layout, type Query, type Row, RuleError, type SchemaPlan, type TableLayout, type Tombstone, type Unit } from '../src/backend.ts';
import type { Kind } from '../src/declare.ts';

export interface SqliteSettings {
  /** A file, or `:memory:`; every connect and plan with the same path shares one database. */
  path: string;
}

type Kinds = Readonly<Record<string, Kind>>;

/** The engine's own tables, and how their columns are kept. */
const ENGINE: Readonly<Record<string, { kinds: Kinds; ddl: string }>> = {
  counters: { kinds: { user_id: 'id', rev: 'integer', purged_rev: 'integer' }, ddl: `create table counters (user_id text primary key, rev integer not null default 0, purged_rev integer not null default 0)` },
  applied_ops: { kinds: { user_id: 'id', op_id: 'id', result: 'json', created_at: 'time' }, ddl: `create table applied_ops (user_id text not null, op_id text not null, result text not null, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), primary key (user_id, op_id))` },
  prefs: { kinds: { user_id: 'id', data: 'json', version: 'integer', updated_at: 'time' }, ddl: `create table prefs (user_id text primary key, data text not null default '{}', version integer not null default 1, updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))` },
  engine_audit: { kinds: { id: 'integer', at: 'time', intent: 'text', by_person: 'id', type: 'text', action: 'text', rows: 'integer' }, ddl: `create table engine_audit (id integer primary key autoincrement, at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), intent text not null, by_person text, type text not null, action text not null, rows integer not null)` },
};

const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const SQL_TYPE: Readonly<Record<Kind, string>> = { text: 'text', number: 'real', integer: 'integer', boolean: 'integer', time: 'text', id: 'text', ids: 'text', json: 'text' };
const RECORD_DDL: Readonly<Record<string, string>> = {
  rev: 'integer not null',
  version: 'integer not null default 1',
  created_at: `text not null default ${NOW}`,
  updated_at: `text not null default ${NOW}`,
  content: `text not null default '{}'`,
  enc: 'integer not null default 0',
  key_version: 'integer not null default 0',
};

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** A value as SQLite keeps it, by kind. Times are normalised so text order is time order. */
function enc(kind: Kind | undefined, v: unknown): unknown {
  if (kind === 'ids') return JSON.stringify(v ?? []);
  if (v === undefined || v === null) return null;
  switch (kind) {
    case 'json':
      return JSON.stringify(v);
    case 'time':
      return new Date(v as string).toISOString();
    case 'boolean':
      return v ? 1 : 0;
    default:
      if (kind === undefined && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
      return v as never;
  }
}

function dec(kind: Kind | undefined, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case 'json':
    case 'ids':
      return JSON.parse(String(v));
    case 'boolean':
      return v === 1 || v === 1n || v === true;
    default:
      return v;
  }
}

/** A refused write as the engine's RuleError: a reference, or a rule named as SQLite names it. */
function rule(e: unknown): unknown {
  const m = String((e as Error)?.message ?? '');
  if (!/constraint failed/i.test(m)) return e;
  if (/FOREIGN KEY/i.test(m)) return new RuleError('', 'reference');
  const named = m.match(/CHECK constraint failed: (\w+)/i);
  return new RuleError(named ? named[1]! : m.replace(/^.*constraint failed: /i, '').replace(/\W+/g, '_'), 'rule');
}

interface Db {
  db: DatabaseSync;
  queue: Promise<unknown>;
  sp: number;
}
const open = new Map<string, Db>();
function db(path: string): Db {
  let d = open.get(path);
  if (!d) {
    const s = new DatabaseSync(path);
    s.exec('pragma foreign_keys = on; pragma journal_mode = wal;');
    d = { db: s, queue: Promise.resolve(), sp: 0 };
    open.set(path, d);
  }
  return d;
}

/** One at a time on a database: a unit's statements are synchronous, but its callbacks await. */
function serial<R>(d: Db, fn: () => Promise<R>): Promise<R> {
  const run = d.queue.then(fn, fn);
  d.queue = run.catch(() => undefined);
  return run;
}

function unit(d: Db, layout: Layout, person: string | null): Unit {
  const s = d.db;
  const kindsOf = (t: string): Kinds => layout.columns?.[t]?.kinds ?? ENGINE[t]?.kinds ?? {};
  const declared = (t: string) => {
    if (!layout.types.includes(t) && !(layout.tables ?? []).includes(t)) throw new Error('unknown_table');
    return q(t);
  };
  const own = (): string => {
    if (person === null) throw new Error('person_scope_only');
    return person;
  };
  const decode = (t: string, row: Record<string, unknown> | undefined): Row | null => {
    if (!row) return null;
    const k = kindsOf(t);
    const out: Row = {};
    for (const [c, v] of Object.entries(row)) out[c] = dec(k[c], v);
    return out;
  };
  const all = (t: string, sql: string, params: unknown[]) => {
    try {
      return (s.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]).map((r) => decode(t, r)!);
    } catch (e) {
      throw rule(e);
    }
  };
  const one = (t: string, sql: string, params: unknown[]) => all(t, sql, params)[0] ?? null;
  const setCols = (t: string, cols: Row) => {
    const k = kindsOf(t);
    const names = Object.keys(cols);
    return { sql: names.map((n) => `${q(n)} = ?`).join(', '), params: names.map((n) => enc(k[n], cols[n])) };
  };
  const cond = (t: string, c: Cond): { sql: string; params: unknown[] } => {
    const col = q(c.col);
    const k = kindsOf(t)[c.col];
    switch (c.op) {
      case 'null':
        return { sql: `${col} is null`, params: [] };
      case 'notnull':
        return { sql: `${col} is not null`, params: [] };
      case 'in':
        return c.value.length ? { sql: `${col} in (${c.value.map(() => '?').join(', ')})`, params: c.value.map((v) => enc(k, v)) } : { sql: '0', params: [] };
      case 'ne':
        return { sql: `${col} is not ?`, params: [enc(k, c.value)] };
      default: {
        const op = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[c.op];
        return { sql: `${col} ${op} ?`, params: [enc(k, c.value)] };
      }
    }
  };
  const where = (t: string, conds: readonly Cond[], extra: { sql: string; params: unknown[] }[] = []) => {
    const parts = [...conds.map((c) => cond(t, c)), ...extra];
    return { sql: parts.length ? parts.map((p) => `(${p.sql})`).join(' and ') : '1', params: parts.flatMap((p) => p.params) };
  };
  const filter = (qy: Query) => {
    const k = kindsOf(qy.table);
    const extra: { sql: string; params: unknown[] }[] = [];
    if (qy.person !== null) extra.push({ sql: `${q(qy.personColumn)} = ?`, params: [qy.person] });
    if (qy.after) {
      const desc = qy.order?.desc ?? false;
      const keyVals = qy.order ? qy.after.slice(1) : qy.after;
      const keys = `(${qy.key.map(q).join(', ')})`;
      const vals = `(${keyVals.map(() => '?').join(', ')})`;
      const pastKey = { sql: `${keys} ${desc ? '<' : '>'} ${vals}`, params: keyVals.map((v, i) => enc(k[qy.key[i]!], v)) };
      if (!qy.order) extra.push(pastKey);
      else {
        const col = q(qy.order.col);
        const v = qy.after[0];
        const kv = enc(k[qy.order.col], v);
        if (v === null) extra.push({ sql: `${col} is null and ${pastKey.sql}`, params: pastKey.params });
        else extra.push({ sql: `${col} ${desc ? '<' : '>'} ? or (${col} = ? and ${pastKey.sql}) or ${col} is null`, params: [kv, kv, ...pastKey.params] });
      }
    }
    return where(qy.table, qy.where, extra);
  };

  const u: Unit = {
    savepoint: async (fn) => {
      const name = `sp${++d.sp}`;
      s.exec(`savepoint ${name}`);
      try {
        const r = await fn(u);
        s.exec(`release ${name}`);
        return r;
      } catch (e) {
        s.exec(`rollback to ${name}; release ${name}`);
        throw rule(e);
      }
    },
    getRow: async (type, id) => one(type, `select * from ${declared(type)} where user_id = ? and id = ?`, [own(), id]),
    getRows: async (type, ids) => (ids.length ? all(type, `select * from ${declared(type)} where user_id = ? and id in (${ids.map(() => '?').join(', ')})`, [own(), ...ids]) : []),
    insertRows: async (type, rows) => {
      const t = declared(type);
      const k = kindsOf(type);
      return rows.map((r) => {
        const row: Row = { ...r, user_id: own() };
        const names = Object.keys(row);
        return one(type, `insert into ${t} (${names.map(q).join(', ')}) values (${names.map(() => '?').join(', ')}) returning *`, names.map((n) => enc(k[n], row[n])))!;
      });
    },
    updateRow: async (type, id, cols) => {
      const set = setCols(type, cols);
      return one(type, `update ${declared(type)} set ${set.sql} where user_id = ? and id = ? returning *`, [...set.params, own(), id])!;
    },
    tombstoneRows: async (type, items: readonly Tombstone[], now) =>
      items.map(
        (x) =>
          one(
            type,
            `update ${declared(type)} set deleted_at = ?, version = version + 1, updated_at = ?, rev = ?, client_updated_at = coalesce(?, client_updated_at) where user_id = ? and id = ? returning *`,
            [enc('time', now), enc('time', now), x.rev, enc('time', x.clientUpdatedAt), own(), x.id],
          )!,
      ),
    nextRevs: async (n) => {
      const r = one('counters', `insert into counters (user_id, rev) values (?, ?) on conflict (user_id) do update set rev = rev + excluded.rev returning rev`, [own(), n]);
      return BigInt(Number(r!.rev) - n + 1);
    },
    purgedRev: async () => Number(one('counters', `select purged_rev from counters where user_id = ?`, [own()])?.purged_rev ?? 0),
    changesSince: async (types, since, limit) => {
      const rows: { type: string; row: Row }[] = [];
      for (const t of types) for (const r of all(t, `select * from ${declared(t)} where user_id = ? and rev > ? order by rev limit ?`, [own(), since, limit])) rows.push({ type: t, row: r });
      return rows.sort((a, b) => Number(a.row.rev) - Number(b.row.rev)).slice(0, limit);
    },
    appliedResult: async (opId) => one('applied_ops', `select result from applied_ops where user_id = ? and op_id = ?`, [own(), opId])?.result,
    appliedOpIds: async (opIds) =>
      new Set(opIds.length ? all('applied_ops', `select op_id from applied_ops where user_id = ? and op_id in (${opIds.map(() => '?').join(', ')})`, [own(), ...opIds]).map((r) => String(r.op_id)) : []),
    saveResults: async (list) => {
      for (const x of list) all('applied_ops', `insert into applied_ops (user_id, op_id, result) values (?, ?, ?)`, [own(), x.op_id, enc('json', x.result)]);
    },
    getPrefs: async () => {
      const r = one('prefs', `select data, version from prefs where user_id = ?`, [own()]);
      return r ? { data: r.data, version: Number(r.version) } : null;
    },
    putPrefs: async (data, existed) => {
      const r = existed
        ? one('prefs', `update prefs set data = ?, version = version + 1, updated_at = ${NOW} where user_id = ? returning version`, [enc('json', data), own()])
        : one('prefs', `insert into prefs (user_id, data, version) values (?, ?, 1) returning version`, [own(), enc('json', data)]);
      return Number(r!.version);
    },
    select: async (qy) => {
      const t = declared(qy.table);
      const dir = qy.order?.desc ? 'desc' : 'asc';
      const order = [...(qy.order ? [`${q(qy.order.col)} ${dir} nulls last`] : []), ...qy.key.map((k) => `${q(k)} ${dir}`)].join(', ');
      const f = filter(qy);
      return all(qy.table, `select * from ${t} where ${f.sql} order by ${order}${qy.limit !== undefined ? ` limit ${Number(qy.limit)}` : ''}`, f.params);
    },
    count: async (qy) => {
      const f = filter({ ...qy, after: undefined });
      return Number(one(qy.table, `select count(*) as n from ${declared(qy.table)} where ${f.sql}`, f.params)!.n);
    },
    insert: async (table, row) => {
      const k = kindsOf(table);
      const names = Object.keys(row);
      return one(table, `insert into ${declared(table)} (${names.map(q).join(', ')}) values (${names.map(() => '?').join(', ')}) returning *`, names.map((n) => enc(k[n], row[n])))!;
    },
    update: async (table, match, changes) => {
      const w = where(table, match);
      if (!Object.keys(changes).length) return one(table, `select * from ${declared(table)} where ${w.sql}`, w.params);
      const set = setCols(table, changes);
      return one(table, `update ${declared(table)} set ${set.sql} where ${w.sql} returning *`, [...set.params, ...w.params]);
    },
    remove: async (table, match) => {
      const w = where(table, match);
      return all(table, `delete from ${declared(table)} where ${w.sql} returning 1 as gone`, w.params).length;
    },
    audit: async (a) => {
      all('engine_audit', `insert into engine_audit (intent, by_person, type, action, rows) values (?, ?, ?, ?, ?)`, [a.intent, a.by, a.type, a.action, a.rows]);
    },
  };
  return u;
}

function columnDdl(t: TableLayout, col: string, kind: Kind): string {
  if (t.access === 'record' && RECORD_DDL[col]) return RECORD_DDL[col]!;
  if (kind === 'ids') return `text not null default '[]'`;
  return `${SQL_TYPE[kind]}${t.key.includes(col) ? ' not null' : ''}`;
}

/** SQLite, for the engine's tests. */
export const sqlite: Backend<SqliteSettings> = {
  kind: 'sqlite',
  schema: {
    async plan(settings, layout): Promise<SchemaPlan> {
      const s = db(settings.path).db;
      const have = new Set((s.prepare(`select name from sqlite_master where type = 'table'`).all() as { name: string }[]).map((r) => r.name));
      const steps: { summary: string; sql: string }[] = [];
      for (const [name, e] of Object.entries(ENGINE)) if (!have.has(name)) steps.push({ summary: `Create the engine's table ${name}`, sql: `${e.ddl};` });
      for (const [name, t] of Object.entries(layout.columns ?? {})) {
        if (have.has(name)) {
          const cols = new Set((s.prepare(`select name from pragma_table_info(?)`).all(name) as { name: string }[]).map((r) => r.name));
          for (const [c, k] of Object.entries(t.kinds))
            if (!cols.has(c)) steps.push({ summary: `Add column ${name}.${c}`, sql: `alter table ${q(name)} add column ${q(c)} ${columnDdl(t, c, k).replace(/ not null$/, '')};` });
          continue;
        }
        const cols = Object.entries(t.kinds).map(([c, k]) => `${q(c)} ${columnDdl(t, c, k)}`);
        steps.push({ summary: `Create table ${name}`, sql: `create table ${q(name)} (${cols.join(', ')}${t.key.length ? `, primary key (${t.key.map(q).join(', ')})` : ''});` });
        if (t.access === 'record') steps.push({ summary: `Index ${name} (user_id, rev)`, sql: `create index ${q(`${name}_user_id_rev_idx`)} on ${q(name)} (user_id, rev);` });
      }
      return { steps, conflicts: [] };
    },
    async apply(settings, p) {
      const d = db(settings.path);
      await serial(d, async () => {
        d.db.exec('begin');
        try {
          for (const s of p.steps) d.db.exec(s.sql);
          d.db.exec('commit');
        } catch (e) {
          d.db.exec('rollback');
          throw e;
        }
      });
    },
  },
  connect(settings, layout) {
    const d = db(settings.path);
    return {
      unit: (scope, fn) =>
        serial(d, async () => {
          d.db.exec('begin immediate');
          try {
            const r = await fn(unit(d, layout, isSystem(scope) ? null : scope.person));
            d.db.exec('commit');
            return r;
          } catch (e) {
            d.db.exec('rollback');
            throw e;
          }
        }),
      close: async () => {},
    };
  },
};

/** For a test standing in for the owner: change a row as an operator would (a clean-up's purged_rev). */
export function sqliteExec(path: string, sql: string, ...params: unknown[]): void {
  db(path).db.prepare(sql).run(...(params as never[]));
}

/** Every row of a table as stored, JSON text read as JSON (what a test compares with what went in). */
export function sqliteRows(path: string, sql: string, ...params: unknown[]): Record<string, unknown>[] {
  return (db(path).db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]).map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^[[{]/.test(v) ? JSON.parse(v) : v])),
  );
}

/** One row as stored, for a test checking what an operator would see. */
export function sqliteRow(path: string, sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
  return db(path).db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
}
