// Tables from declarations, on Postgres (ADRs 0006, 0014). The plan compares what the app declared with what the
// database has and lists additive steps only: a schema, the engine's tables and functions, a table, a column, an
// index, row-level security, grants. Anything that differs in a way only a person should settle (a column of another
// type, a timestamp without a zone) is a conflict, reported and left alone. Existing tables are adopted as they are.
// Nothing here runs at request time: the owner plans, reads the plan, and applies it, staging first.
/** A name, quoted. Names are checked by the engine's declarations; quoting keeps the SQL right whatever they are. */
const q = (name) => `"${name.replace(/"/g, '""')}"`;
const lit = (s) => `'${s.replace(/'/g, "''")}'`;
/** The column type each kind gets in a new table or column. */
export const PG_TYPE = {
    text: 'text',
    date: 'date',
    number: 'double precision',
    integer: 'integer',
    boolean: 'boolean',
    time: 'timestamptz',
    id: 'uuid',
    ids: 'uuid[]',
    json: 'jsonb',
};
/** Existing column types that hold a kind as the engine writes and reads it (adopted tables). */
const FITS = {
    text: ['text', 'varchar', 'bpchar', 'citext'],
    number: ['float8', 'float4', 'numeric', 'int2', 'int4', 'int8'],
    integer: ['int2', 'int4', 'int8'],
    boolean: ['bool'],
    time: ['timestamptz'],
    date: ['date'],
    id: ['uuid', 'text', 'varchar'],
    ids: ['_uuid', '_text', '_varchar'],
    json: ['jsonb', 'json'],
};
/** The engine's own columns in a record table that need more than their kind (a type, a default, not null). */
const RECORD_DDL = {
    rev: 'bigint not null',
    version: 'integer not null default 1',
    created_at: 'timestamptz not null default now()',
    updated_at: 'timestamptz not null default now()',
    content: `jsonb not null default '{}'`,
    enc: 'smallint not null default 0',
    key_version: 'integer not null default 0',
};
function columnDdl(t, col, kind, schema) {
    if (t.access === 'record' && RECORD_DDL[col])
        return RECORD_DDL[col];
    if (t.access === 'record' && kind === 'ids')
        return `uuid[] not null default '{}'`;
    if (t.person === col)
        return `uuid not null default ${q(schema)}.current_user_id()`;
    return `${PG_TYPE[kind]}${t.key.includes(col) ? ' not null' : ''}`;
}
/** An empty catalog: a schema that isn't there yet. */
export const NONE = { schema: false, columns: {}, functions: [], rls: {}, policies: {}, indexes: [], grants: {}, usage: [] };
/**
 * The plan for one app's layout against what its schemas have (`have`, by schema name). The engine's own tables and
 * functions are in `o.schema`; each type's table is in `o.schemas[type]` if given (ADR 0017), and named by the layout.
 */
export function plan(layout, have, o) {
    const b = build(layout, have, o, false);
    return { steps: b.steps.map(({ summary, sql }) => ({ summary, sql })), conflicts: b.conflicts };
}
/**
 * The plan as one SQL script that needs no catalog (ADR 0027): every step the plan could have, each checking the
 * database itself when it runs, so the script is the same for any database and safe to run again and again. A step
 * that makes something runs only where it's missing; grants, row-level security on and `if not exists` run every time
 * (they change nothing the second time); what the plan would report as a conflict stops the script with an error that
 * names the table and column, never a value. Row-level security is forced only on a table the script itself made
 * (ADR 0021). One transaction: all of it or none.
 */
export function script(layout, o) {
    const b = build(layout, {}, o, true);
    const out = [
        '-- The engine\'s schema for these declarations (sync-engine ADR 0027): safe to run again; each step checks the database.',
        'begin;',
    ];
    for (const s of b.steps) {
        out.push(`-- ${s.summary}`);
        if (!s.guard)
            out.push(s.sql);
        else
            out.push(`do $engine$ begin if ${s.guard} then execute ${lit(s.sql)};${s.after ? ` ${s.after}` : ''} end if; end $engine$;`);
    }
    out.push('commit;');
    return out.join('\n') + '\n';
}
/** The plan's steps against `have`; with `run`, as `script` writes them: guarded to check the database when they run. */
function build(layout, have, o, run) {
    const main = o.schema;
    const M = q(main);
    const steps = [];
    const conflicts = [];
    const step = (summary, sql, guard, after) => steps.push({ summary, sql, ...(run && guard ? { guard } : {}), ...(run && after ? { after } : {}) });
    // For the script: what's missing, asked of the database when the step runs.
    const noRel = (schema, table) => `to_regclass(${lit(`${q(schema)}.${q(table)}`)}) is null`;
    const noFn = (schema, fn, args = '') => `to_regprocedure(${lit(`${q(schema)}.${q(fn)}(${args})`)}) is null`;
    const noCol = (schema, table, col) => `not exists (select from information_schema.columns where table_schema = ${lit(schema)} and table_name = ${lit(table)} and column_name = ${lit(col)})`;
    // A table the script made this run, for forcing its row-level security (ADR 0021): a setting for the session.
    const madeKey = new Map();
    const made = (schema, table) => {
        const k = `${schema}.${table}`;
        if (!madeKey.has(k))
            madeKey.set(k, `engine_script.made_${madeKey.size + 1}`);
        return madeKey.get(k);
    };
    const makeTable = (summary, schema, table, sql) => step(summary, sql, noRel(schema, table), `perform set_config(${lit(made(schema, table))}, 'on', false);`);
    // A conflict the plan reports, checked by the script when it runs: it stops there, naming what (never a value).
    const check = (schema, table, cond, what) => step(`Check ${schema}.${table}: ${what}`, `do $engine$ begin if ${cond} then raise exception ${lit(`engine schema conflict: ${schema}.${table} ${what}`)}; end if; end $engine$;`);
    const types = layout.columns ?? {};
    const roles = [o.role, o.systemRole].filter((r) => !!r);
    const cat = (schema) => have[schema] ?? NONE;
    const placeOf = (type) => ({ schema: o.schemas?.[type] ?? main, table: types[type]?.table ?? type });
    const at = (schema, table) => `${q(schema)}.${q(table)}`;
    // Each schema the app uses: there, and usable by the roles.
    const schemas = [main, ...new Set(Object.keys(types).map((t) => placeOf(t).schema).filter((x) => x !== main))];
    for (const sc of schemas) {
        if (!cat(sc).schema)
            step(`Create schema ${sc}`, run ? `create schema if not exists ${q(sc)};` : `create schema ${q(sc)};`);
        const needUsage = roles.filter((r) => !cat(sc).usage.includes(r));
        if (needUsage.length)
            step(`Let ${needUsage.join(' and ')} use schema ${sc}`, `grant usage on schema ${q(sc)} to ${needUsage.map(q).join(', ')};`);
    }
    /** Grants a role what it lacks on a table (or `fn:name`) in a schema, and nothing it already has. */
    const grant = (role, privs, schema, obj, args = '') => {
        if (!role)
            return;
        const missing = privs.filter((p) => !(cat(schema).grants[obj]?.[role] ?? []).includes(p));
        if (!missing.length)
            return;
        const target = obj.startsWith('fn:') ? `function ${q(schema)}.${q(obj.slice(3))}(${args})` : at(schema, obj);
        step(`Grant ${role} ${missing.join(', ')} on ${schema}.${obj.replace(/^fn:/, '')}`, `grant ${missing.join(', ')} on ${target} to ${q(role)};`);
    };
    // Row-level security is turned on wherever it's off. It's forced on tables the plan makes; on a table that's already
    // there, forcing is the app's own choice and is left as it is (ADR 0021): an app may leave it off so that what runs
    // as the table's owner (a trigger, a hook another service calls) sees every row. The engine never connects as an
    // owner, so forcing adds nothing to its own isolation.
    const rlsOn = (schema, table) => {
        const r = cat(schema).rls[table];
        const isNew = !cat(schema).columns[table];
        if (!r?.enabled)
            step(`Turn on row-level security for ${schema}.${table}`, `alter table ${at(schema, table)} enable row level security;`);
        if (isNew && !r?.forced)
            step(`Force row-level security for ${schema}.${table}`, `alter table ${at(schema, table)} force row level security;`, `current_setting(${lit(made(schema, table))}, true) = 'on'`);
    };
    const policy = (schema, table, pname, body) => {
        if (!(cat(schema).policies[table] ?? []).includes(pname))
            step(`Policy ${pname} on ${schema}.${table}`, `create policy ${q(pname)} on ${at(schema, table)} ${body};`, `not exists (select from pg_policies where schemaname = ${lit(schema)} and tablename = ${lit(table)} and policyname = ${lit(pname)})`);
    };
    const personRls = (schema, table, col, readOnly = false) => {
        rlsOn(schema, table);
        const own = `(${q(col)} = ${M}.current_user_id())`;
        if (o.role)
            policy(schema, table, readOnly ? 'engine_person_read' : 'engine_person', readOnly ? `for select to ${q(o.role)} using ${own}` : `for all to ${q(o.role)} using ${own} with check ${own}`);
    };
    /** For the script: a column that's there must be of a type that holds its kind; a view's must be there at all. */
    const columnChecks = (schema, table, c, k) => {
        const fits = FITS[k].map(lit).join(', ');
        const udt = `(select udt_name::text from information_schema.columns where table_schema = ${lit(schema)} and table_name = ${lit(table)} and column_name = ${lit(c)})`;
        check(schema, table, `coalesce(${udt}, '') not in (${fits})`, `${c}: missing or not ${PG_TYPE[k]}`);
    };
    // The engine's own: who the unit is for, change numbers, the op log, prefs, the audit.
    const mine = cat(main);
    if (!mine.functions.includes('current_user_id'))
        step('Create current_user_id()', `create function ${M}.current_user_id() returns uuid language sql stable as $$ select nullif(current_setting(${lit(o.personSetting)}, true), '')::uuid $$;`, noFn(main, 'current_user_id'));
    const engine = {
        counters: `create table ${M}.counters (user_id uuid primary key default ${M}.current_user_id(), rev bigint not null default 0, purged_rev bigint not null default 0);`,
        applied_ops: `create table ${M}.applied_ops (user_id uuid not null default ${M}.current_user_id(), op_id uuid not null, result jsonb not null, created_at timestamptz not null default now(), primary key (user_id, op_id));`,
        prefs: `create table ${M}.prefs (user_id uuid primary key default ${M}.current_user_id(), data jsonb not null default '{}', version integer not null default 1, updated_at timestamptz not null default now());`,
        engine_audit: `create table ${M}.engine_audit (id bigint generated always as identity primary key, at timestamptz not null default now(), intent text not null, by_person uuid, type text not null, action text not null, rows integer not null);`,
    };
    for (const [name, sql] of Object.entries(engine))
        if (!mine.columns[name])
            makeTable(`Create the engine's table ${name}`, main, name, sql);
    if (!mine.functions.includes('next_rev'))
        step('Create next_rev()', `create function ${M}.next_rev() returns bigint language sql volatile as $$ insert into ${M}.counters as c (user_id, rev) values (${M}.current_user_id(), 1) on conflict (user_id) do update set rev = c.rev + 1 returning c.rev $$;`, noFn(main, 'next_rev'));
    for (const name of ['counters', 'applied_ops', 'prefs'])
        personRls(main, name, 'user_id');
    for (const name of ['counters', 'applied_ops', 'prefs'])
        grant(o.role, ['select', 'insert', 'update'], main, name);
    grant(o.role, ['execute'], main, 'fn:current_user_id');
    grant(o.role, ['execute'], main, 'fn:next_rev');
    grant(o.systemRole, ['insert'], main, 'engine_audit');
    grant(o.systemRole, ['execute'], main, 'fn:current_user_id');
    // Erasing a person takes them out of the audit too (ADR 0024). The system role may only add audit lines, so this one
    // change, clearing who caused a line for one person, is a function with its owner's rights and nothing else.
    if (layout.erase && o.systemRole) {
        if (!mine.functions.includes('forget_person'))
            step('Create forget_person()', `create function ${M}.forget_person(p uuid) returns integer language sql volatile security definer set search_path = '' as $$ with u as (update ${M}.engine_audit set by_person = null where by_person = p returning 1) select count(*)::int from u $$; revoke all on function ${M}.forget_person(uuid) from public;`, noFn(main, 'forget_person', 'uuid'));
        grant(o.systemRole, ['execute'], main, 'fn:forget_person', 'uuid');
    }
    // Erasing a person (ADR 0022): the system role deletes from the engine's own tables, and from the record tables below.
    if (layout.erase && o.systemRole)
        for (const name of ['counters', 'applied_ops', 'prefs']) {
            grant(o.systemRole, ['select', 'delete'], main, name);
            policy(main, name, 'engine_system_erase', `for delete to ${q(o.systemRole)} using (true)`);
            policy(main, name, 'engine_system_read', `for select to ${q(o.systemRole)} using (true)`);
        }
    for (const [type, t] of Object.entries(types)) {
        const { schema, table } = placeOf(type);
        const where = at(schema, table);
        const live = cat(schema).columns[table];
        if (t.view) {
            // The app's migrations make it; here it's checked, and read by whom it may be.
            if (run) {
                check(schema, table, noRel(schema, table), 'missing_view');
                for (const [c, k] of Object.entries(t.kinds))
                    columnChecks(schema, table, c, k);
                if (t.access !== 'system')
                    grant(o.role, ['select'], schema, table);
                grant(o.systemRole, t.view === true ? ['select'] : ['select', 'delete'], schema, table);
                continue;
            }
            if (!live)
                conflicts.push({ table: `${schema}.${table}`, issue: 'missing_view' });
            else
                for (const [c, k] of Object.entries(t.kinds)) {
                    const typ = live[c];
                    if (typ === undefined)
                        conflicts.push({ table: `${schema}.${table}`, column: c, issue: 'missing_column' });
                    else if (!FITS[k].includes(typ))
                        conflicts.push({ table: `${schema}.${table}`, column: c, issue: 'type', want: PG_TYPE[k], have: typ });
                }
            if (live) {
                if (t.access !== 'system')
                    grant(o.role, ['select'], schema, table);
                grant(o.systemRole, t.view === true ? ['select'] : ['select', 'delete'], schema, table);
            }
            continue;
        }
        if (!live) {
            const cols = Object.entries(t.kinds).map(([c, k]) => `${q(c)} ${columnDdl(t, c, k, main)}`);
            makeTable(`Create table ${schema}.${table}`, schema, table, `create table ${where} (${cols.join(', ')}${t.key.length ? `, primary key (${t.key.map(q).join(', ')})` : ''});`);
            // The script also adopts a table that's there: each column added where missing, each checked where it is.
            if (run)
                for (const [c, k] of Object.entries(t.kinds)) {
                    step(`Add column ${schema}.${table}.${c}`, `alter table ${where} add column ${q(c)} ${columnDdl(t, c, k, main).replace(/ not null$/, '')};`, noCol(schema, table, c));
                    columnChecks(schema, table, c, k);
                }
        }
        else {
            for (const [c, k] of Object.entries(t.kinds)) {
                const typ = live[c];
                if (typ === undefined) {
                    // A new column on a table with rows: nullable unless the engine has a default for it.
                    const ddl = columnDdl(t, c, k, main).replace(/ not null$/, '');
                    step(`Add column ${schema}.${table}.${c}`, `alter table ${where} add column ${q(c)} ${ddl};`);
                }
                else if (!FITS[k].includes(typ))
                    conflicts.push({ table: `${schema}.${table}`, column: c, issue: typ === 'timestamp' && k === 'time' ? 'no_zone' : 'type', want: PG_TYPE[k], have: typ });
            }
        }
        // Indexes: the change feed's (person, rev) for records; each query field, after the person where there is one.
        const idx = (cols) => {
            const iname = `${table}_${cols.join('_')}_idx`.slice(0, 63);
            if (!cat(schema).indexes.includes(iname))
                step(`Index ${schema}.${table} (${cols.join(', ')})`, `create index if not exists ${q(iname)} on ${where} (${cols.map(q).join(', ')});`);
        };
        if (t.access === 'record')
            idx(['user_id', 'rev']);
        for (const f of t.query ?? [])
            idx([...(t.person ? [t.person] : []), f]);
        if (t.person)
            personRls(schema, table, t.person, t.personReads === true);
        else
            rlsOn(schema, table);
        const all = ['select', 'insert', 'update', 'delete'];
        if (t.access === 'record')
            grant(o.role, ['select', 'insert', 'update'], schema, table);
        else if (t.access === 'person')
            grant(o.role, t.personReads ? ['select'] : all, schema, table);
        else if (t.access === 'shared') {
            grant(o.role, ['select'], schema, table);
            if (o.role)
                policy(schema, table, 'engine_read', `for select to ${q(o.role)} using (true)`);
        }
        // A system intent may read records (find, count) and read and write its declared types.
        grant(o.systemRole, t.access === 'record' ? (layout.erase ? ['select', 'delete'] : ['select']) : all, schema, table);
        if (o.systemRole)
            policy(schema, table, 'engine_system', `for all to ${q(o.systemRole)} using (true) with check (true)`);
    }
    return { steps, conflicts };
}
/** The catalog query, for a backend that runs it (Postgres's: `inspect` in postgres.ts). */
export const CATALOG_SQL = {
    schema: `select 1 as ok from pg_namespace where nspname = $1`,
    columns: `select table_name::text as t, column_name::text as c, udt_name::text as u from information_schema.columns where table_schema = $1`,
    functions: `select p.proname::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1`,
    rls: `select c.relname::text as t, c.relrowsecurity as enabled, c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind in ('r', 'p')`,
    policies: `select tablename::text as t, policyname::text as p from pg_policies where schemaname = $1`,
    indexes: `select indexname::text as i from pg_indexes where schemaname = $1`,
    grants: `select table_name::text as o, grantee::text as r, lower(privilege_type) as p from information_schema.role_table_grants where table_schema = $1
    union all select 'fn:' || routine_name::text, grantee::text, lower(privilege_type) from information_schema.role_routine_grants where routine_schema = $1`,
    usage: `select r from unnest($2::text[]) as r where exists (select from pg_roles where rolname = r) and exists (select from pg_namespace where nspname = $1) and has_schema_privilege(r, $1, 'USAGE')`,
};
