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
import { CATALOG_SQL, plan } from "./postgres-schema.js";
import { isSystem, RuleError } from "./backend.js";
/** A savepoint: `savepoint` on Postgres.js 3; on 4 a nested `begin` is one, and `savepoint` is kept as long as it is. */
const savepoint = (tx, fn) => (tx.savepoint ? tx.savepoint(fn) : tx.begin(fn));
const REF = '23503';
/** A database rule refusing a write, as the engine's RuleError; anything else as it was. */
function rule(e) {
    const code = e?.code ?? '';
    if (!code.startsWith('23'))
        return e;
    return new RuleError(String(e.constraint_name ?? ''), code === REF ? 'reference' : 'rule');
}
/**
 * A value as the driver writes it, by its column's kind: JSON as jsonb, a list of ids as a text array (Postgres's text
 * form, which both driver majors send as it is), change numbers as text. A column without a kind (the engine's own
 * tables) by its value: objects as jsonb.
 */
function param(tx, v, kind) {
    // A list of ids is never null: none is an empty list (as Clearwork has always stored it), so the column can be not null.
    if (kind === 'ids')
        return `{${(v ?? []).join(',')}}`;
    if (v === undefined || v === null)
        return null;
    if (typeof v === 'bigint')
        return v.toString();
    if (kind === 'json' || (kind === undefined && typeof v === 'object' && !(v instanceof Date)))
        return tx.json(v);
    return v;
}
function cols(tx, row, kinds) {
    const out = {};
    for (const [k, v] of Object.entries(row))
        out[k] = param(tx, v, kinds[k]);
    return out;
}
/** A Postgres text array literal: each key quoted, so a path key can hold any character. */
const textArray = (keys) => `{${keys.map((k) => `"${k.replace(/[\\"]/g, (m) => `\\${m}`)}"`).join(',')}}`;
/** A column, or a declared JSON path read from its column as its kind (null where the stored value isn't one). */
function ref(tx, c, name) {
    const p = c.paths[name];
    if (!p)
        return tx `${tx(name)}`;
    const from = tx(p.from);
    const path = textArray(p.path);
    if (p.kind === 'text')
        return tx `(${from} #>> ${path}::text[])`;
    const pg = p.kind === 'number' ? tx `double precision` : tx `boolean`;
    return tx `(case when jsonb_typeof(${from} #> ${path}::text[]) = ${p.kind} then (${from} #>> ${path}::text[])::${pg} end)`;
}
const kindOf = (c, name) => c.paths[name]?.kind ?? c.kinds[name];
/** One condition as SQL. Columns are names the engine checked against the app's declarations. */
function cond(tx, c, cs) {
    const k = kindOf(cs, c.col);
    const col = ref(tx, cs, c.col);
    switch (c.op) {
        case 'null':
            return tx `${col} is null`;
        case 'notnull':
            return tx `${col} is not null`;
        case 'in':
            return c.value.length ? tx `${col} in ${tx(c.value.map((v) => param(tx, v, k)))}` : tx `false`;
        case 'nin':
            return c.value.length ? tx `${col} not in ${tx(c.value.map((v) => param(tx, v, k)))}` : tx `true`;
        case 'eq':
            return tx `${col} = ${param(tx, c.value, k)}`;
        case 'ne':
            return tx `${col} is distinct from ${param(tx, c.value, k)}`;
        case 'gt':
            return tx `${col} > ${param(tx, c.value, k)}`;
        case 'gte':
            return tx `${col} >= ${param(tx, c.value, k)}`;
        case 'lt':
            return tx `${col} < ${param(tx, c.value, k)}`;
        case 'lte':
            return tx `${col} <= ${param(tx, c.value, k)}`;
    }
}
const and = (tx, parts) => (parts.length ? parts.reduce((a, b) => tx `${a} and ${b}`) : tx `true`);
const or = (tx, parts) => parts.reduce((a, b) => tx `(${a}) or (${b})`);
/** The conditions of a query: its own, its person, and its cursor (keyset paging; nulls in the order column last). */
function filter(tx, q, cs) {
    const kinds = cs.kinds;
    const parts = q.where.map((c) => cond(tx, c, cs));
    if (q.person !== null)
        parts.push(tx `${tx(q.personColumn)} = ${q.person}`);
    if (q.after) {
        const desc = q.order?.desc ?? false;
        const keyVals = q.order ? q.after.slice(1) : q.after;
        const keys = tx `(${q.key.map((k) => tx `${tx(k)}`).reduce((a, b) => tx `${a}, ${b}`)})`;
        const vals = tx `(${keyVals.map((v, i) => tx `${param(tx, v, kinds[q.key[i]])}`).reduce((a, b) => tx `${a}, ${b}`)})`;
        const pastKey = desc ? tx `${keys} < ${vals}` : tx `${keys} > ${vals}`;
        if (!q.order)
            parts.push(pastKey);
        else {
            const col = ref(tx, cs, q.order.col);
            const v = q.after[0];
            if (v === null)
                parts.push(tx `${col} is null and ${pastKey}`);
            else {
                const past = desc ? tx `${col} < ${param(tx, v, kindOf(cs, q.order.col))}` : tx `${col} > ${param(tx, v, kindOf(cs, q.order.col))}`;
                parts.push(tx `(${or(tx, [past, tx `${col} = ${param(tx, v, kindOf(cs, q.order.col))} and ${pastKey}`, tx `${col} is null`])})`);
            }
        }
    }
    return and(tx, parts);
}
/** Where a type's table is: its schema (by the settings) and its table name (by the layout). */
function placeOf(layout, settings, type) {
    return { schema: settings.schemas?.[type] ?? settings.schema, table: layout.columns?.[type]?.table ?? type };
}
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const ENGINE_TABLES = ['counters', 'applied_ops', 'prefs', 'engine_audit'];
function unit(tx, layout, settings, person) {
    const schema = settings.schema;
    const kindsOf = (t) => layout.columns?.[t]?.kinds ?? {};
    const colsOf = (t) => ({ kinds: kindsOf(t), paths: layout.columns?.[t]?.paths ?? {} });
    /** One of the engine's own tables, always in the app's schema. */
    const table = (name) => tx `${tx(schema)}.${tx(name)}`;
    /** A type's table, wherever the settings put it. */
    const typeTable = (type) => {
        const p = placeOf(layout, settings, type);
        return tx `${tx(p.schema)}.${tx(p.table)}`;
    };
    const declared = (name) => {
        if (!layout.types.includes(name) && !(layout.tables ?? []).includes(name))
            throw new Error('unknown_table');
        return typeTable(name);
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
        return typeTable(type);
    };
    const u = {
        savepoint: async (fn) => {
            try {
                return await savepoint(tx, (sp) => fn(unit(sp, layout, settings, person)));
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
            const list = rows.map((r) => cols(tx, { ...r, user_id: own() }, kindsOf(type)));
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
                const [row] = await tx `update ${t} set ${tx(cols(tx, c, kindsOf(type)))} where user_id = ${own()} and id = ${id} returning *`;
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
            // A type keyed by its person alone (one row each) has nothing to order by.
            const parts = [...(q.order ? [tx `${ref(tx, colsOf(q.table), q.order.col)} ${dir} nulls last`] : []), ...keyOrder];
            const order = parts.length ? tx `order by ${parts.reduce((a, b) => tx `${a}, ${b}`)}` : tx ``;
            const limit = q.limit !== undefined ? tx `limit ${q.limit}` : tx ``;
            return (await tx `select * from ${t} where ${filter(tx, q, colsOf(q.table))} ${order} ${limit}`);
        },
        count: async (q) => {
            const t = declared(q.table);
            const [row] = await tx `select count(*)::int as n from ${t} where ${filter(tx, { ...q, after: undefined }, colsOf(q.table))}`;
            return Number(row.n);
        },
        insert: async (name, row, onConflict) => {
            const t = declared(name);
            const c = cols(tx, row, kindsOf(name));
            const list = (names) => names.map((n) => tx `${tx(n)}`).reduce((a, b) => tx `${a}, ${b}`);
            let conflict = tx ``;
            if (onConflict) {
                const rest = Object.keys(c).filter((k) => !onConflict.key.includes(k));
                conflict =
                    onConflict.action === 'update' && rest.length
                        ? tx `on conflict (${list(onConflict.key)}) do update set ${rest.map((k) => tx `${tx(k)} = excluded.${tx(k)}`).reduce((a, b) => tx `${a}, ${b}`)}`
                        : tx `on conflict (${list(onConflict.key)}) do nothing`;
            }
            try {
                const [stored] = await tx `insert into ${t} ${tx(c)} ${conflict} returning *`;
                return stored ?? null;
            }
            catch (e) {
                throw rule(e);
            }
        },
        update: async (name, match, changes) => {
            const t = declared(name);
            const c = cols(tx, changes, kindsOf(name));
            if (!Object.keys(c).length) {
                const [row] = await tx `select * from ${t} where ${and(tx, match.map((m) => cond(tx, m, colsOf(name))))} for update`;
                return row ?? null;
            }
            try {
                const [row] = await tx `update ${t} set ${tx(c)} where ${and(tx, match.map((m) => cond(tx, m, colsOf(name))))} returning *`;
                return row ?? null;
            }
            catch (e) {
                throw rule(e);
            }
        },
        remove: async (name, match) => {
            const t = declared(name);
            try {
                // Counted from what came back: the result's `count` isn't promised on every driver version.
                const r = await tx `delete from ${t} where ${and(tx, match.map((m) => cond(tx, m, colsOf(name))))} returning 1 as gone`;
                return r.length;
            }
            catch (e) {
                throw rule(e);
            }
        },
        summarize: async (q) => {
            const t = declared(q.table);
            const cs = colsOf(q.table);
            // The groups are worked out in a subquery and grouped by name there: grouping by position would go to the
            // driver as a parameter, and an expression with a parameter in it (a time zone) can't be matched to itself.
            const inner = [tx `*`];
            q.by.forEach((g, i) => inner.push('col' in g ? tx `${ref(tx, cs, g.col)} as ${tx(`__g${i}`)}` : tx `((${tx(g.day)} at time zone ${g.zone})::date)::text as ${tx(`__g${i}`)}`));
            const sel = q.by.map((g, i) => tx `${tx(`__g${i}`)} as ${tx(g.as)}`);
            for (const m of q.measures) {
                const e = m.col !== undefined ? ref(tx, cs, m.col) : tx ``;
                const agg = m.fn === 'count' ? tx `count(*)`
                    : m.fn === 'distinct' ? tx `count(distinct ${e})`
                        : m.fn === 'percentile' ? tx `percentile_cont(${m.p}::double precision) within group (order by ${e})`
                            : m.fn === 'sum' ? tx `sum(${e})` : m.fn === 'avg' ? tx `avg(${e})` : m.fn === 'min' ? tx `min(${e})` : tx `max(${e})`;
                sel.push(m.where.length ? tx `${agg} filter (where ${and(tx, m.where.map((c) => cond(tx, c, cs)))}) as ${tx(m.as)}` : tx `${agg} as ${tx(m.as)}`);
            }
            const where = filter(tx, { table: q.table, person: q.person, personColumn: q.personColumn, where: q.where, key: [] }, cs);
            const join = (fs) => fs.reduce((a, b) => tx `${a}, ${b}`);
            const group = q.by.length ? tx `group by ${join(q.by.map((_, i) => tx `${tx(`__g${i}`)}`))}` : tx ``;
            const order = q.order ? tx `order by ${tx(q.order.as)} ${q.order.desc ? tx `desc` : tx `asc`} nulls last` : tx ``;
            return (await tx `select ${join(sel)} from (select ${join(inner)} from ${t} where ${where}) as s ${group} ${order} limit ${q.limit}`);
        },
        lock: async (name) => {
            await tx `select pg_advisory_xact_lock(hashtext(${`${schema}:${name}`}))`;
        },
        audit: async (a) => {
            await tx `insert into ${table('engine_audit')} (intent, by_person, type, action, rows) values (${a.intent}, ${a.by}, ${a.type}, ${a.action}, ${a.rows})`;
        },
    };
    return u;
}
function checked(settings, layout) {
    if (!settings?.url)
        throw new Error('no_database');
    const schema = settings.schema;
    if (typeof schema !== 'string' || !NAME.test(schema))
        throw new Error('bad_schema');
    for (const [type, s] of Object.entries(settings.schemas ?? {})) {
        if (typeof s !== 'string' || !NAME.test(s))
            throw new Error('bad_schema');
        if (layout && !layout.columns?.[type])
            throw new Error('unknown_type');
    }
    // No type's table may be one of the engine's own (same schema, same name).
    for (const type of Object.keys(layout?.columns ?? {})) {
        const p = placeOf(layout, settings, type);
        if (p.schema === schema && ENGINE_TABLES.includes(p.table))
            throw new Error('engine_table');
    }
    return schema;
}
/** What the schema has now, for a plan. */
async function inspect(sql, schema, roles) {
    const run = (q, p = [schema]) => sql.unsafe(q, p);
    const [ns, cols, fns, rls, pols, idx, grants, usage] = await Promise.all([
        run(CATALOG_SQL.schema), run(CATALOG_SQL.columns), run(CATALOG_SQL.functions), run(CATALOG_SQL.rls), run(CATALOG_SQL.policies), run(CATALOG_SQL.indexes),
        run(CATALOG_SQL.grants), run(CATALOG_SQL.usage, [schema, `{${roles.join(',')}}`]),
    ]);
    const c = { schema: ns.length > 0, columns: {}, functions: fns.map((r) => String(r.f)), rls: {}, policies: {}, indexes: idx.map((r) => String(r.i)), grants: {}, usage: usage.map((r) => String(r.r)) };
    for (const r of cols)
        (c.columns[String(r.t)] ??= {})[String(r.c)] = String(r.u);
    for (const r of rls)
        c.rls[String(r.t)] = { enabled: !!r.enabled, forced: !!r.forced };
    for (const r of pols)
        (c.policies[String(r.t)] ??= []).push(String(r.p));
    for (const r of grants)
        ((c.grants[String(r.o)] ??= {})[String(r.r)] ??= []).push(String(r.p));
    return c;
}
/** The Postgres backend. */
export const postgres = {
    kind: 'postgres',
    schema: {
        async plan(settings, layout) {
            const schema = checked(settings, layout);
            const sql = pg(settings.url, { max: 1, fetch_types: false, onnotice: () => { } });
            try {
                const roles = [settings.role, settings.systemRole].filter((r) => !!r);
                const all = [schema, ...new Set(Object.values(settings.schemas ?? {}))];
                const have = {};
                for (const sc of all)
                    have[sc] = await inspect(sql, sc, roles);
                return plan(layout, have, {
                    schema,
                    ...(settings.schemas ? { schemas: settings.schemas } : {}),
                    personSetting: settings.personSetting ?? 'app.user_id',
                    ...(settings.role ? { role: settings.role } : {}),
                    ...(settings.systemRole ? { systemRole: settings.systemRole } : {}),
                });
            }
            finally {
                await sql.end();
            }
        },
        async apply(settings, p) {
            checked(settings);
            const sql = pg(settings.url, { max: 1, fetch_types: false, onnotice: () => { } });
            try {
                // All steps or none: Postgres changes a schema inside a transaction.
                await sql.begin(async (tx) => {
                    for (const s of p.steps)
                        await tx.unsafe(s.sql);
                });
            }
            finally {
                await sql.end();
            }
        },
    },
    connect(settings, layout) {
        const schema = checked(settings, layout);
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
                    return fn(unit(tx, layout, settings, sys ? null : scope.person));
                });
            },
            close: () => sql.end(),
        };
    },
};
