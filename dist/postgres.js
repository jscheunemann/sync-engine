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
import { isSystem, RuleError } from "./backend.js";
const REF = '23503';
/** A database rule refusing a write, as the engine's RuleError; anything else as it was. */
function rule(e) {
    const code = e?.code ?? '';
    if (!code.startsWith('23'))
        return e;
    return new RuleError(String(e.constraint_name ?? ''), code === REF ? 'reference' : 'rule');
}
/** Values the driver writes as they are: change numbers as text (bigint), objects as jsonb. */
function value(tx, k, v) {
    if (typeof v === 'bigint')
        return v.toString();
    if (k === 'content' && v !== null && typeof v === 'object')
        return tx.json(v);
    return v === undefined ? null : v;
}
function cols(tx, row) {
    const out = {};
    for (const [k, v] of Object.entries(row))
        out[k] = value(tx, k, v);
    return out;
}
/** One condition as SQL. Columns are names the engine checked against the app's declarations. */
function cond(tx, c) {
    const col = tx(c.col);
    switch (c.op) {
        case 'null':
            return tx `${col} is null`;
        case 'notnull':
            return tx `${col} is not null`;
        case 'in':
            return c.value.length ? tx `${col} in ${tx(c.value.map((v) => param(tx, v)))}` : tx `false`;
        case 'eq':
            return tx `${col} = ${param(tx, c.value)}`;
        case 'ne':
            return tx `${col} is distinct from ${param(tx, c.value)}`;
        case 'gt':
            return tx `${col} > ${param(tx, c.value)}`;
        case 'gte':
            return tx `${col} >= ${param(tx, c.value)}`;
        case 'lt':
            return tx `${col} < ${param(tx, c.value)}`;
        case 'lte':
            return tx `${col} <= ${param(tx, c.value)}`;
    }
}
/** A value for a parameter: objects and arrays as jsonb, times as they are. */
function param(tx, v) {
    if (v === undefined)
        return null;
    if (typeof v === 'bigint')
        return v.toString();
    if (v !== null && typeof v === 'object' && !(v instanceof Date))
        return tx.json(v);
    return v;
}
const and = (tx, parts) => (parts.length ? parts.reduce((a, b) => tx `${a} and ${b}`) : tx `true`);
const or = (tx, parts) => parts.reduce((a, b) => tx `(${a}) or (${b})`);
/** The conditions of a query: its own, its person, and its cursor (keyset paging; nulls in the order column last). */
function filter(tx, q) {
    const parts = q.where.map((c) => cond(tx, c));
    if (q.person !== null)
        parts.push(tx `${tx(q.personColumn)} = ${q.person}`);
    if (q.after) {
        const desc = q.order?.desc ?? false;
        const keyVals = q.order ? q.after.slice(1) : q.after;
        const keys = tx `(${q.key.map((k) => tx `${tx(k)}`).reduce((a, b) => tx `${a}, ${b}`)})`;
        const vals = tx `(${keyVals.map((v) => tx `${param(tx, v)}`).reduce((a, b) => tx `${a}, ${b}`)})`;
        const pastKey = desc ? tx `${keys} < ${vals}` : tx `${keys} > ${vals}`;
        if (!q.order)
            parts.push(pastKey);
        else {
            const col = tx(q.order.col);
            const v = q.after[0];
            if (v === null)
                parts.push(tx `${col} is null and ${pastKey}`);
            else {
                const past = desc ? tx `${col} < ${param(tx, v)}` : tx `${col} > ${param(tx, v)}`;
                parts.push(tx `(${or(tx, [past, tx `${col} = ${param(tx, v)} and ${pastKey}`, tx `${col} is null`])})`);
            }
        }
    }
    return and(tx, parts);
}
function unit(tx, layout, person) {
    const schema = layout.schema;
    const table = (name) => tx `${tx(schema)}.${tx(name)}`;
    const declared = (name) => {
        if (!layout.types.includes(name) && !(layout.tables ?? []).includes(name))
            throw new Error('unknown_table');
        return table(name);
    };
    /** A unit's person, for the operations that are only ever one person's. */
    const own = () => {
        if (person === null)
            throw new Error('person_scope_only');
        return person;
    };
    const known = (type) => {
        if (!layout.types.includes(type))
            throw new Error('unknown_type');
        return table(type);
    };
    const u = {
        savepoint: async (fn) => {
            try {
                return (await tx.savepoint((sp) => fn(unit(sp, layout, person))));
            }
            catch (e) {
                throw rule(e);
            }
        },
        getRow: async (type, id, lock) => {
            const t = known(type);
            const rows = lock
                ? await tx `select * from ${t} where user_id = ${own()} and id = ${id} for update`
                : await tx `select * from ${t} where user_id = ${own()} and id = ${id}`;
            return rows[0] ?? null;
        },
        getRows: async (type, ids, lock) => {
            if (!ids.length)
                return [];
            const t = known(type);
            const rows = lock
                ? await tx `select * from ${t} where user_id = ${own()} and id in ${tx(ids)} for update`
                : await tx `select * from ${t} where user_id = ${own()} and id in ${tx(ids)}`;
            return rows;
        },
        insertRows: async (type, rows) => {
            if (!rows.length)
                return [];
            const t = known(type);
            const list = rows.map((r) => cols(tx, { ...r, user_id: own() }));
            try {
                return (await tx `insert into ${t} ${tx(list)} returning *`);
            }
            catch (e) {
                throw rule(e);
            }
        },
        updateRow: async (type, id, c) => {
            const t = known(type);
            try {
                const [row] = await tx `update ${t} set ${tx(cols(tx, c))} where user_id = ${own()} and id = ${id} returning *`;
                return row;
            }
            catch (e) {
                throw rule(e);
            }
        },
        tombstoneRows: async (type, items, now) => {
            if (!items.length)
                return [];
            const t = known(type);
            // One update for the group: each row its own rev, from a list of (id, rev, client time).
            const vals = items.map((x) => [x.id, x.rev.toString(), x.clientUpdatedAt]);
            try {
                return (await tx `
          update ${t} t set deleted_at = ${now}, version = t.version + 1, updated_at = ${now}, rev = v.rev::bigint,
            client_updated_at = coalesce(v.cua::timestamptz, t.client_updated_at)
          from (values ${tx(vals)}) as v(id, rev, cua)
          where t.user_id = ${own()} and t.id = v.id::uuid returning t.*`);
            }
            catch (e) {
                throw rule(e);
            }
        },
        nextRevs: async (n) => {
            // next_rev() numbers the change (and makes the counter if need be); a block takes the rest in one update.
            const [{ rev }] = (await tx `select ${tx(schema)}.next_rev() as rev`);
            if (n > 1)
                await tx `update ${table('counters')} set rev = rev + ${n - 1} where user_id = ${own()}`;
            return BigInt(rev);
        },
        purgedRev: async () => {
            const [row] = await tx `select purged_rev from ${table('counters')} where user_id = ${own()}`;
            return row ? Number(row.purged_rev) : 0;
        },
        changesSince: async (types, since, limit) => {
            const parts = types.map((ty) => tx `select ${ty}::text as type, rev, to_jsonb(r) as row from ${known(ty)} r where user_id = ${own()} and rev > ${since}`);
            const union = parts.reduce((acc, p) => tx `${acc} union all ${p}`);
            const found = await tx `select type, row from (${union}) c order by rev limit ${limit}`;
            return found.map((r) => ({ type: String(r.type), row: r.row }));
        },
        appliedResult: async (opId) => {
            const [row] = await tx `select result from ${table('applied_ops')} where user_id = ${own()} and op_id = ${opId}`;
            return row ? row.result : undefined;
        },
        appliedOpIds: async (opIds) => {
            if (!opIds.length)
                return new Set();
            const rows = await tx `select op_id from ${table('applied_ops')} where user_id = ${own()} and op_id in ${tx(opIds)}`;
            return new Set(rows.map((r) => String(r.op_id)));
        },
        saveResults: async (list) => {
            if (!list.length)
                return;
            const rows = list.map((x) => ({ user_id: own(), op_id: x.op_id, result: tx.json(x.result) }));
            await tx `insert into ${table('applied_ops')} ${tx(rows, 'user_id', 'op_id', 'result')}`;
        },
        getPrefs: async (lock) => {
            const t = table('prefs');
            const [row] = lock
                ? await tx `select data, version from ${t} where user_id = ${own()} for update`
                : await tx `select data, version from ${t} where user_id = ${own()}`;
            return row ? { data: row.data, version: Number(row.version) } : null;
        },
        putPrefs: async (data, existed) => {
            const t = table('prefs');
            const doc = tx.json(data);
            const [saved] = existed
                ? await tx `update ${t} set data = ${doc}, version = version + 1, updated_at = now() where user_id = ${own()} returning version`
                : await tx `insert into ${t} (user_id, data, version) values (${own()}, ${doc}, 1) returning version`;
            return Number(saved.version);
        },
        select: async (q) => {
            const t = declared(q.table);
            const dir = q.order?.desc ? tx `desc` : tx `asc`;
            const keyOrder = q.key.map((k) => tx `${tx(k)} ${dir}`);
            const order = [...(q.order ? [tx `${tx(q.order.col)} ${dir} nulls last`] : []), ...keyOrder].reduce((a, b) => tx `${a}, ${b}`);
            const limit = q.limit !== undefined ? tx `limit ${q.limit}` : tx ``;
            return (await tx `select * from ${t} where ${filter(tx, q)} order by ${order} ${limit}`);
        },
        count: async (q) => {
            const t = declared(q.table);
            const [row] = await tx `select count(*)::int as n from ${t} where ${filter(tx, { ...q, after: undefined })}`;
            return Number(row.n);
        },
        insert: async (name, row) => {
            const t = declared(name);
            const c = {};
            for (const [k, v] of Object.entries(row))
                c[k] = param(tx, v);
            try {
                const [stored] = await tx `insert into ${t} ${tx(c)} returning *`;
                return stored;
            }
            catch (e) {
                throw rule(e);
            }
        },
        update: async (name, match, changes) => {
            const t = declared(name);
            const c = {};
            for (const [k, v] of Object.entries(changes))
                c[k] = param(tx, v);
            if (!Object.keys(c).length) {
                const [row] = await tx `select * from ${t} where ${and(tx, match.map((m) => cond(tx, m)))} for update`;
                return row ?? null;
            }
            try {
                const [row] = await tx `update ${t} set ${tx(c)} where ${and(tx, match.map((m) => cond(tx, m)))} returning *`;
                return row ?? null;
            }
            catch (e) {
                throw rule(e);
            }
        },
        remove: async (name, match) => {
            const t = declared(name);
            try {
                const r = await tx `delete from ${t} where ${and(tx, match.map((m) => cond(tx, m)))}`;
                return r.count;
            }
            catch (e) {
                throw rule(e);
            }
        },
        audit: async (a) => {
            await tx `insert into ${table('engine_audit')} (intent, by_person, type, action, rows) values (${a.intent}, ${a.by}, ${a.type}, ${a.action}, ${a.rows})`;
        },
    };
    return u;
}
/** The Postgres backend. */
export const postgres = {
    kind: 'postgres',
    connect(settings, layout) {
        if (!settings?.url)
            throw new Error('no_database');
        const sql = pg(settings.url, {
            max: settings.max ?? 5,
            fetch_types: false, // no extra round trip on connect; the engine uses only built-in types
            prepare: true,
            connect_timeout: 10,
            idle_timeout: 5,
            onnotice: () => { },
        });
        const personSetting = settings.personSetting ?? 'app.user_id';
        return {
            unit: (scope, fn) => {
                const sys = isSystem(scope);
                if (sys && !settings.systemRole)
                    return Promise.reject(new Error('no_system_role'));
                return sql.begin(async (tx) => {
                    const role = sys ? settings.systemRole : settings.role;
                    if (role)
                        await tx `select set_config('role', ${role}, true)`;
                    // extra_float_digits 3: numbers come back exactly as stored (through Hyperdrive the server's output is
                    // otherwise rounded to 15 digits). A system unit sets no person: row-level security then shows no one's rows
                    // to anything but the system role.
                    await tx `select set_config(${personSetting}, ${sys ? '' : scope.person}, true), set_config('extra_float_digits', '3', true)`;
                    return fn(unit(tx, layout, sys ? null : scope.person));
                });
            },
            close: () => sql.end(),
        };
    },
};
