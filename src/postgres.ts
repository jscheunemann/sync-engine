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
import { type Backend, type Connection, type Layout, type Row, RuleError, type Scope, type Tombstone, type Unit } from './backend.ts';

/** How to reach the database. On Cloudflare Workers, pass Hyperdrive's connection string as `url`. */
export interface PostgresSettings {
  url: string;
  /** Connections at most, per session (default 5). */
  max?: number;
  /** The setting the database's row-level security reads for the person (default `app.user_id`). */
  personSetting?: string;
  /** Run every unit as this database role (`set local role`), for a database user that may switch to it. */
  role?: string;
}

// The driver's own types stay inside this file: nothing here is exported with them.
type Sql = pg.Sql;
type Tx = pg.TransactionSql;

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

function unit(tx: Tx, layout: Layout, person: string): Unit {
  const schema = layout.schema;
  const table = (name: string) => tx`${tx(schema)}.${tx(name)}`;
  const known = (type: string) => {
    if (!layout.types.includes(type)) throw new Error('unknown_type');
    return table(type);
  };
  const u: Unit = {
    savepoint: async (fn) => {
      try {
        return (await tx.savepoint((sp: Tx) => fn(unit(sp, layout, person)))) as never;
      } catch (e) {
        throw rule(e);
      }
    },
    getRow: async (type, id, lock) => {
      const t = known(type);
      const rows = lock
        ? await tx`select * from ${t} where user_id = ${person} and id = ${id} for update`
        : await tx`select * from ${t} where user_id = ${person} and id = ${id}`;
      return (rows[0] as Row | undefined) ?? null;
    },
    getRows: async (type, ids, lock) => {
      if (!ids.length) return [];
      const t = known(type);
      const rows = lock
        ? await tx`select * from ${t} where user_id = ${person} and id in ${tx(ids as string[])} for update`
        : await tx`select * from ${t} where user_id = ${person} and id in ${tx(ids as string[])}`;
      return rows as unknown as Row[];
    },
    insertRows: async (type, rows) => {
      if (!rows.length) return [];
      const t = known(type);
      const list = rows.map((r) => cols(tx, { ...r, user_id: person }));
      try {
        return (await tx`insert into ${t} ${tx(list as never)} returning *`) as unknown as Row[];
      } catch (e) {
        throw rule(e);
      }
    },
    updateRow: async (type, id, c) => {
      const t = known(type);
      try {
        const [row] = await tx`update ${t} set ${tx(cols(tx, c) as never)} where user_id = ${person} and id = ${id} returning *`;
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
          where t.user_id = ${person} and t.id = v.id::uuid returning t.*`) as unknown as Row[];
      } catch (e) {
        throw rule(e);
      }
    },
    nextRevs: async (n) => {
      // next_rev() numbers the change (and makes the counter if need be); a block takes the rest in one update.
      const [{ rev }] = (await tx`select ${tx(schema)}.next_rev() as rev`) as unknown as [{ rev: string }];
      if (n > 1) await tx`update ${table('counters')} set rev = rev + ${n - 1} where user_id = ${person}`;
      return BigInt(rev);
    },
    purgedRev: async () => {
      const [row] = await tx`select purged_rev from ${table('counters')} where user_id = ${person}`;
      return row ? Number(row.purged_rev) : 0;
    },
    changesSince: async (types, since, limit) => {
      const parts = types.map((ty) => tx`select ${ty}::text as type, rev, to_jsonb(r) as row from ${known(ty)} r where user_id = ${person} and rev > ${since}`);
      const union = parts.reduce((acc, p) => tx`${acc} union all ${p}`);
      const found = await tx`select type, row from (${union}) c order by rev limit ${limit}`;
      return found.map((r) => ({ type: String(r.type), row: r.row as Row }));
    },
    appliedResult: async (opId) => {
      const [row] = await tx`select result from ${table('applied_ops')} where user_id = ${person} and op_id = ${opId}`;
      return row ? row.result : undefined;
    },
    appliedOpIds: async (opIds) => {
      if (!opIds.length) return new Set();
      const rows = await tx`select op_id from ${table('applied_ops')} where user_id = ${person} and op_id in ${tx(opIds as string[])}`;
      return new Set(rows.map((r) => String(r.op_id)));
    },
    saveResults: async (list) => {
      if (!list.length) return;
      const rows = list.map((x) => ({ user_id: person, op_id: x.op_id, result: tx.json(x.result as never) }));
      await tx`insert into ${table('applied_ops')} ${tx(rows as never, 'user_id', 'op_id', 'result')}`;
    },
    getPrefs: async (lock) => {
      const t = table('prefs');
      const [row] = lock
        ? await tx`select data, version from ${t} where user_id = ${person} for update`
        : await tx`select data, version from ${t} where user_id = ${person}`;
      return row ? { data: row.data, version: Number(row.version) } : null;
    },
    putPrefs: async (data, existed) => {
      const t = table('prefs');
      const doc = tx.json(data as never);
      const [saved] = existed
        ? await tx`update ${t} set data = ${doc}, version = version + 1, updated_at = now() where user_id = ${person} returning version`
        : await tx`insert into ${t} (user_id, data, version) values (${person}, ${doc}, 1) returning version`;
      return Number(saved!.version);
    },
  };
  return u;
}

/** The Postgres backend. */
export const postgres: Backend<PostgresSettings> = {
  kind: 'postgres',
  connect(settings: PostgresSettings, layout: Layout): Connection {
    if (!settings?.url) throw new Error('no_database');
    const sql: Sql = pg(settings.url, {
      max: settings.max ?? 5,
      fetch_types: false, // no extra round trip on connect; the engine uses only built-in types
      prepare: true,
      connect_timeout: 10,
      idle_timeout: 5,
      onnotice: () => {},
    });
    const personSetting = settings.personSetting ?? 'app.user_id';
    return {
      unit: <R>(scope: Scope, fn: (u: Unit) => Promise<R>) =>
        sql.begin(async (tx: Tx) => {
          if (settings.role) await tx`select set_config('role', ${settings.role}, true)`;
          // extra_float_digits 3: numbers come back exactly as stored (through Hyperdrive the server's output is
          // otherwise rounded to 15 digits).
          await tx`select set_config(${personSetting}, ${scope.person}, true), set_config('extra_float_digits', '3', true)`;
          return fn(unit(tx, layout, scope.person));
        }) as Promise<R>,
      close: () => sql.end(),
    };
  },
};
