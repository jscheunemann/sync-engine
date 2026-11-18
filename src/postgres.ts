// The Postgres backend (ADR 0004): the only part of the engine that knows Postgres or a driver. It owns the driver
// (Postgres.js, the engine's own dependency: apps don't install or upgrade it for the engine), the connection, the
// transaction per unit of work, and the SQL.
//
// Isolation (ADR 0007) is kept twice: every query here names the scope's person (`user_id = …`), and the unit also sets
// the person for the database's row-level security (`app.user_id`, transaction-local), which stays on as a second
// guard. Either alone keeps one person's rows from another.
//
// Tables are today's (README.md, "Tables"), adopted as they are: a table per record type, counters with next_rev(),
// applied_ops and prefs, all in the app's schema.

import pg from 'postgres';
import { type Backend, type Cond, type Connection, isSystem, type Layout, type Query, type Row, RuleError, type Scope, type Tombstone, type Unit } from './backend.ts';

/** How to reach the database. On Cloudflare Workers, pass Hyperdrive's connection string as `url`. */
export interface PostgresSettings {
  url: string;
  /** Connections at most, per session (default 5). */
  max?: number;
  /** The setting the database's row-level security reads for the person (default `app.user_id`). */
  personSetting?: string;
  /** Run every unit as this database role (`set local role`), for a database user that may switch to it. */
  role?: string;
  /**
   * The role system units run as (ADR 0009): one the database lets past row-level security for the tables system
   * intents reach. Without it, system units are refused.
   */
  systemRole?: string;
}


// The driver, as this file uses it: the calls Postgres.js 3 and 4 both have, typed here rather than with the driver's
// own types (which moved between majors), so the backend builds and runs on either. Nothing here is exported.
/** A query: awaited for its rows, or put inside another query as a fragment. */
type Frag = Promise<Row[]>;
interface Tx {
  (strings: TemplateStringsArray, ...values: unknown[]): Frag;
  /** An identifier (a name), a list of values for `in`, or the columns and values of a row for insert and update. */
  (value: unknown, ...columns: string[]): Frag;
  json(value: unknown): unknown;
  savepoint?<R>(fn: (sp: Tx) => Promise<R>): Promise<R>;
  begin<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
}
interface Sql extends Tx {
  end(): Promise<void>;
}

/** A savepoint: `savepoint` on Postgres.js 3; on 4 a nested `begin` is one, and `savepoint` is kept as long as it is. */
const savepoint = <R>(tx: Tx, fn: (sp: Tx) => Promise<R>): Promise<R> => (tx.savepoint ? tx.savepoint(fn) : tx.begin(fn));

const REF = '23503';

/** A database rule refusing a write, as the engine's RuleError; anything else as it was. */
function rule(e: unknown): unknown {
  const code = (e as { code?: string })?.code ?? '';
  if (!code.startsWith('23')) return e;
  return new RuleError(String((e as { constraint_name?: string }).constraint_name ?? ''), code === REF ? 'reference' : 'rule');
}

/** Values the driver writes as they are: change numbers as text (bigint), objects as jsonb. */
function value(tx: Tx, k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (k === 'content' && v !== null && typeof v === 'object') return tx.json(v as never);
  return v === undefined ? null : v;
}

function cols(tx: Tx, row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = value(tx, k, v);
  return out;
}

/** One condition as SQL. Columns are names the engine checked against the app's declarations. */
function cond(tx: Tx, c: Cond): Frag {
  const col = tx(c.col);
  switch (c.op) {
    case 'null':
      return tx`${col} is null`;
    case 'notnull':
      return tx`${col} is not null`;
    case 'in':
      return c.value.length ? tx`${col} in ${tx(c.value.map((v) => param(tx, v)) as never)}` : tx`false`;
    case 'eq':
      return tx`${col} = ${param(tx, c.value) as never}`;
    case 'ne':
      return tx`${col} is distinct from ${param(tx, c.value) as never}`;
    case 'gt':
      return tx`${col} > ${param(tx, c.value) as never}`;
    case 'gte':
      return tx`${col} >= ${param(tx, c.value) as never}`;
    case 'lt':
      return tx`${col} < ${param(tx, c.value) as never}`;
    case 'lte':
      return tx`${col} <= ${param(tx, c.value) as never}`;
  }
}

/** A value for a parameter: objects and arrays as jsonb, times as they are. */
function param(tx: Tx, v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) return tx.json(v as never);
  return v;
}

const and = (tx: Tx, parts: Frag[]) => (parts.length ? parts.reduce((a, b) => tx`${a} and ${b}`) : tx`true`);
const or = (tx: Tx, parts: Frag[]) => parts.reduce((a, b) => tx`(${a}) or (${b})`);

/** The conditions of a query: its own, its person, and its cursor (keyset paging; nulls in the order column last). */
function filter(tx: Tx, q: Query): Frag {
  const parts = q.where.map((c) => cond(tx, c));
  if (q.person !== null) parts.push(tx`${tx(q.personColumn)} = ${q.person}`);
  if (q.after) {
    const desc = q.order?.desc ?? false;
    const keyVals = q.order ? q.after.slice(1) : q.after;
    const keys = tx`(${q.key.map((k) => tx`${tx(k)}`).reduce((a, b) => tx`${a}, ${b}`)})`;
    const vals = tx`(${keyVals.map((v) => tx`${param(tx, v) as never}`).reduce((a, b) => tx`${a}, ${b}`)})`;
    const pastKey = desc ? tx`${keys} < ${vals}` : tx`${keys} > ${vals}`;
    if (!q.order) parts.push(pastKey);
    else {
      const col = tx(q.order.col);
      const v = q.after[0];
      if (v === null) parts.push(tx`${col} is null and ${pastKey}`);
      else {
        const past = desc ? tx`${col} < ${param(tx, v) as never}` : tx`${col} > ${param(tx, v) as never}`;
        parts.push(tx`(${or(tx, [past, tx`${col} = ${param(tx, v) as never} and ${pastKey}`, tx`${col} is null`])})`);
      }
    }
  }
  return and(tx, parts);
}

function unit(tx: Tx, layout: Layout, person: string | null): Unit {
  const schema = layout.schema;
  const table = (name: string) => tx`${tx(schema)}.${tx(name)}`;
  const declared = (name: string) => {
    if (!layout.types.includes(name) && !(layout.tables ?? []).includes(name)) throw new Error('unknown_table');
    return table(name);
  };
  /** A unit's person, for the operations that are only ever one person's. */
  const own = (): string => {
    if (person === null) throw new Error('person_scope_only');
    return person;
  };
  const known = (type: string) => {
    if (!layout.types.includes(type)) throw new Error('unknown_type');
    return table(type);
  };
  const u: Unit = {
    savepoint: async (fn) => {
      try {
        return await savepoint(tx, (sp) => fn(unit(sp, layout, person)));
      } catch (e) {
        throw rule(e);
      }
    },
    getRow: async (type, id, lock) => {
      const t = known(type);
      const rows = lock
        ? await tx`select * from ${t} where user_id = ${own()} and id = ${id} for update`
        : await tx`select * from ${t} where user_id = ${own()} and id = ${id}`;
      return (rows[0] as Row | undefined) ?? null;
    },
    getRows: async (type, ids, lock) => {
      if (!ids.length) return [];
      const t = known(type);
      const rows = lock
        ? await tx`select * from ${t} where user_id = ${own()} and id in ${tx(ids as string[])} for update`
        : await tx`select * from ${t} where user_id = ${own()} and id in ${tx(ids as string[])}`;
      return rows as unknown as Row[];
    },
    insertRows: async (type, rows) => {
      if (!rows.length) return [];
      const t = known(type);
      const list = rows.map((r) => cols(tx, { ...r, user_id: own() }));
      try {
        return (await tx`insert into ${t} ${tx(list as never)} returning *`) as unknown as Row[];
      } catch (e) {
        throw rule(e);
      }
    },
    updateRow: async (type, id, c) => {
      const t = known(type);
      try {
        const [row] = await tx`update ${t} set ${tx(cols(tx, c) as never)} where user_id = ${own()} and id = ${id} returning *`;
        return row as Row;
      } catch (e) {
        throw rule(e);
      }
    },
    tombstoneRows: async (type, items: readonly Tombstone[], now) => {
      if (!items.length) return [];
      const t = known(type);
      // One update for the group: each row its own rev, from a list of (id, rev, client time).
      const vals = items.map((x) => [x.id, x.rev.toString(), x.clientUpdatedAt]);
      try {
        return (await tx`
          update ${t} t set deleted_at = ${now}, version = t.version + 1, updated_at = ${now}, rev = v.rev::bigint,
            client_updated_at = coalesce(v.cua::timestamptz, t.client_updated_at)
          from (values ${tx(vals as never)}) as v(id, rev, cua)
          where t.user_id = ${own()} and t.id = v.id::uuid returning t.*`) as unknown as Row[];
      } catch (e) {
        throw rule(e);
      }
    },
    nextRevs: async (n) => {
      // next_rev() numbers the change (and makes the counter if need be); a block takes the rest in one update.
      const [{ rev }] = (await tx`select ${tx(schema)}.next_rev() as rev`) as unknown as [{ rev: string }];
      if (n > 1) await tx`update ${table('counters')} set rev = rev + ${n - 1} where user_id = ${own()}`;
      return BigInt(rev);
    },
    purgedRev: async () => {
      const [row] = await tx`select purged_rev from ${table('counters')} where user_id = ${own()}`;
      return row ? Number(row.purged_rev) : 0;
    },
    changesSince: async (types, since, limit) => {
      const parts = types.map((ty) => tx`select ${ty}::text as type, rev, to_jsonb(r) as row from ${known(ty)} r where user_id = ${own()} and rev > ${since}`);
      const union = parts.reduce((acc, p) => tx`${acc} union all ${p}`);
      const found = await tx`select type, row from (${union}) c order by rev limit ${limit}`;
      return found.map((r) => ({ type: String(r.type), row: r.row as Row }));
    },
    appliedResult: async (opId) => {
      const [row] = await tx`select result from ${table('applied_ops')} where user_id = ${own()} and op_id = ${opId}`;
      return row ? row.result : undefined;
    },
    appliedOpIds: async (opIds) => {
      if (!opIds.length) return new Set();
      const rows = await tx`select op_id from ${table('applied_ops')} where user_id = ${own()} and op_id in ${tx(opIds as string[])}`;
      return new Set(rows.map((r) => String(r.op_id)));
    },
    saveResults: async (list) => {
      if (!list.length) return;
      const rows = list.map((x) => ({ user_id: own(), op_id: x.op_id, result: tx.json(x.result as never) }));
      await tx`insert into ${table('applied_ops')} ${tx(rows as never, 'user_id', 'op_id', 'result')}`;
    },
    getPrefs: async (lock) => {
      const t = table('prefs');
      const [row] = lock
        ? await tx`select data, version from ${t} where user_id = ${own()} for update`
        : await tx`select data, version from ${t} where user_id = ${own()}`;
      return row ? { data: row.data, version: Number(row.version) } : null;
    },
    putPrefs: async (data, existed) => {
      const t = table('prefs');
      const doc = tx.json(data as never);
      const [saved] = existed
        ? await tx`update ${t} set data = ${doc}, version = version + 1, updated_at = now() where user_id = ${own()} returning version`
        : await tx`insert into ${t} (user_id, data, version) values (${own()}, ${doc}, 1) returning version`;
      return Number(saved!.version);
    },
    select: async (q) => {
      const t = declared(q.table);
      const dir = q.order?.desc ? tx`desc` : tx`asc`;
      const keyOrder = q.key.map((k) => tx`${tx(k)} ${dir}`);
      const order = [...(q.order ? [tx`${tx(q.order.col)} ${dir} nulls last`] : []), ...keyOrder].reduce((a, b) => tx`${a}, ${b}`);
      const limit = q.limit !== undefined ? tx`limit ${q.limit}` : tx``;
      return (await tx`select * from ${t} where ${filter(tx, q)} order by ${order} ${limit}`) as unknown as Row[];
    },
    count: async (q) => {
      const t = declared(q.table);
      const [row] = await tx`select count(*)::int as n from ${t} where ${filter(tx, { ...q, after: undefined })}`;
      return Number(row!.n);
    },
    insert: async (name, row) => {
      const t = declared(name);
      const c: Row = {};
      for (const [k, v] of Object.entries(row)) c[k] = param(tx, v);
      try {
        const [stored] = await tx`insert into ${t} ${tx(c as never)} returning *`;
        return stored as Row;
      } catch (e) {
        throw rule(e);
      }
    },
    update: async (name, match, changes) => {
      const t = declared(name);
      const c: Row = {};
      for (const [k, v] of Object.entries(changes)) c[k] = param(tx, v);
      if (!Object.keys(c).length) {
        const [row] = await tx`select * from ${t} where ${and(tx, match.map((m) => cond(tx, m)))} for update`;
        return (row as Row | undefined) ?? null;
      }
      try {
        const [row] = await tx`update ${t} set ${tx(c as never)} where ${and(tx, match.map((m) => cond(tx, m)))} returning *`;
        return (row as Row | undefined) ?? null;
      } catch (e) {
        throw rule(e);
      }
    },
    remove: async (name, match) => {
      const t = declared(name);
      try {
        // Counted from what came back: the result's `count` isn't promised on every driver version.
        const r = await tx`delete from ${t} where ${and(tx, match.map((m) => cond(tx, m)))} returning 1 as gone`;
        return r.length;
      } catch (e) {
        throw rule(e);
      }
    },
    audit: async (a) => {
      await tx`insert into ${table('engine_audit')} (intent, by_person, type, action, rows) values (${a.intent}, ${a.by}, ${a.type}, ${a.action}, ${a.rows})`;
    },
  };
  return u;
}

/** The Postgres backend. */
export const postgres: Backend<PostgresSettings> = {
  kind: 'postgres',
  connect(settings: PostgresSettings, layout: Layout): Connection {
    if (!settings?.url) throw new Error('no_database');
    const sql = pg(settings.url, {
      max: settings.max ?? 5,
      fetch_types: false, // no extra round trip on connect; the engine uses only built-in types
      prepare: true,
      connect_timeout: 10,
      idle_timeout: 5,
      onnotice: () => {},
    }) as unknown as Sql;
    const personSetting = settings.personSetting ?? 'app.user_id';
    return {
      unit: <R>(scope: Scope, fn: (u: Unit) => Promise<R>) => {
        const sys = isSystem(scope);
        if (sys && !settings.systemRole) return Promise.reject(new Error('no_system_role'));
        return sql.begin(async (tx: Tx) => {
          const role = sys ? settings.systemRole : settings.role;
          if (role) await tx`select set_config('role', ${role}, true)`;
          // extra_float_digits 3: numbers come back exactly as stored (through Hyperdrive the server's output is
          // otherwise rounded to 15 digits). A system unit sets no person: row-level security then shows no one's rows
          // to anything but the system role.
          await tx`select set_config(${personSetting}, ${sys ? '' : scope.person}, true), set_config('extra_float_digits', '3', true)`;
          return fn(unit(tx, layout, sys ? null : scope.person));
        }) as Promise<R>;
      },
      close: () => sql.end(),
    };
  },
};
