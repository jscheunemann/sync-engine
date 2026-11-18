// Tables from declarations, on Postgres (ADRs 0006, 0014). The plan compares what the app declared with what the
// database has and lists additive steps only: a schema, the engine's tables and functions, a table, a column, an
// index, row-level security, grants. Anything that differs in a way only a person should settle (a column of another
// type, a timestamp without a zone) is a conflict, reported and left alone. Existing tables are adopted as they are.
// Nothing here runs at request time: the owner plans, reads the plan, and applies it, staging first.

import type { Layout, SchemaPlan, TableLayout } from './backend.ts';
import type { Kind } from './declare.ts';

/** What the database has in one schema, as the plan needs it. */
export interface Catalog {
  schema: boolean;
  /** Table → column → its type (`udt_name`: `text`, `int4`, `_uuid`…). */
  columns: Record<string, Record<string, string>>;
  functions: string[];
  /** Table → whether row-level security is enabled and forced. */
  rls: Record<string, { enabled: boolean; forced: boolean }>;
  /** Table → its policies' names. */
  policies: Record<string, string[]>;
  indexes: string[];
  /** Table or function (`fn:name`) → role → its privileges, lower case (`select`, `execute`…). */
  grants: Record<string, Record<string, string[]>>;
  /** The roles that may use the schema. */
  usage: string[];
}

export type Plan = SchemaPlan;
type Step = Plan['steps'][number];
type Conflict = Plan['conflicts'][number];

export interface PlanOptions {
  schema: string;
  /** The role person units run as, and the system units' role (grants and policies are made for each given). */
  role?: string;
  systemRole?: string;
  /** The setting row-level security reads the person from. */
  personSetting: string;
}

/** A name, quoted. Names are checked by the engine's declarations; quoting keeps the SQL right whatever they are. */
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The column type each kind gets in a new table or column. */
export const PG_TYPE: Readonly<Record<Kind, string>> = {
  text: 'text',
  number: 'double precision',
  integer: 'integer',
  boolean: 'boolean',
  time: 'timestamptz',
  id: 'uuid',
  ids: 'uuid[]',
  json: 'jsonb',
};

/** Existing column types that hold a kind as the engine writes and reads it (adopted tables). */
const FITS: Readonly<Record<Kind, readonly string[]>> = {
  text: ['text', 'varchar', 'bpchar', 'citext'],
  number: ['float8', 'float4', 'numeric', 'int2', 'int4', 'int8'],
  integer: ['int2', 'int4', 'int8'],
  boolean: ['bool'],
  time: ['timestamptz'],
  id: ['uuid', 'text', 'varchar'],
  ids: ['_uuid', '_text', '_varchar'],
  json: ['jsonb', 'json'],
};

/** The engine's own columns in a record table that need more than their kind (a type, a default, not null). */
const RECORD_DDL: Readonly<Record<string, string>> = {
  rev: 'bigint not null',
  version: 'integer not null default 1',
  created_at: 'timestamptz not null default now()',
  updated_at: 'timestamptz not null default now()',
  content: `jsonb not null default '{}'`,
  enc: 'smallint not null default 0',
  key_version: 'integer not null default 0',
};

function columnDdl(t: TableLayout, col: string, kind: Kind, schema: string): string {
  if (t.access === 'record' && RECORD_DDL[col]) return RECORD_DDL[col]!;
  if (t.access === 'record' && kind === 'ids') return `uuid[] not null default '{}'`;
  if (t.person === col) return `uuid not null default ${q(schema)}.current_user_id()`;
  return `${PG_TYPE[kind]}${t.key.includes(col) ? ' not null' : ''}`;
}

/** An empty catalog: a schema that isn't there yet. */
export const NONE: Catalog = { schema: false, columns: {}, functions: [], rls: {}, policies: {}, indexes: [], grants: {}, usage: [] };

/**
 * The plan for one app's layout against what its schemas have (`have`, by schema name). The engine's own tables and
 * functions are in `o.schema`; each type's table is in `o.schemas[type]` if given (ADR 0017), and named by the layout.
 */
export function plan(layout: Layout, have: Readonly<Record<string, Catalog>>, o: PlanOptions & { schemas?: Readonly<Record<string, string>> }): Plan {
  const main = o.schema;
  const M = q(main);
  const steps: Step[] = [];
  const conflicts: Conflict[] = [];
  const step = (summary: string, sql: string) => steps.push({ summary, sql });
  const types = layout.columns ?? {};
  const roles = [o.role, o.systemRole].filter((r): r is string => !!r);
  const cat = (schema: string) => have[schema] ?? NONE;
  const placeOf = (type: string) => ({ schema: o.schemas?.[type] ?? main, table: types[type]?.table ?? type });
  const at = (schema: string, table: string) => `${q(schema)}.${q(table)}`;

  // Each schema the app uses: there, and usable by the roles.
  const schemas = [main, ...new Set(Object.keys(types).map((t) => placeOf(t).schema).filter((x) => x !== main))];
  for (const sc of schemas) {
    if (!cat(sc).schema) step(`Create schema ${sc}`, `create schema ${q(sc)};`);
    const needUsage = roles.filter((r) => !cat(sc).usage.includes(r));
    if (needUsage.length) step(`Let ${needUsage.join(' and ')} use schema ${sc}`, `grant usage on schema ${q(sc)} to ${needUsage.map(q).join(', ')};`);
  }
  /** Grants a role what it lacks on a table (or `fn:name`) in a schema, and nothing it already has. */
  const grant = (role: string | undefined, privs: string[], schema: string, obj: string) => {
    if (!role) return;
    const missing = privs.filter((p) => !(cat(schema).grants[obj]?.[role] ?? []).includes(p));
    if (!missing.length) return;
    const target = obj.startsWith('fn:') ? `function ${q(schema)}.${q(obj.slice(3))}()` : at(schema, obj);
    step(`Grant ${role} ${missing.join(', ')} on ${schema}.${obj.replace(/^fn:/, '')}`, `grant ${missing.join(', ')} on ${target} to ${q(role)};`);
  };
  const rlsOn = (schema: string, table: string) => {
    const r = cat(schema).rls[table];
    if (!r?.enabled) step(`Turn on row-level security for ${schema}.${table}`, `alter table ${at(schema, table)} enable row level security;`);
    if (!r?.forced) step(`Force row-level security for ${schema}.${table}`, `alter table ${at(schema, table)} force row level security;`);
  };
  const policy = (schema: string, table: string, pname: string, body: string) => {
    if (!(cat(schema).policies[table] ?? []).includes(pname)) step(`Policy ${pname} on ${schema}.${table}`, `create policy ${q(pname)} on ${at(schema, table)} ${body};`);
  };
  const personRls = (schema: string, table: string, col: string) => {
    rlsOn(schema, table);
    if (o.role) policy(schema, table, 'engine_person', `for all to ${q(o.role)} using (${q(col)} = ${M}.current_user_id()) with check (${q(col)} = ${M}.current_user_id())`);
  };

  // The engine's own: who the unit is for, change numbers, the op log, prefs, the audit.
  const mine = cat(main);
  if (!mine.functions.includes('current_user_id'))
    step('Create current_user_id()', `create function ${M}.current_user_id() returns uuid language sql stable as $$ select nullif(current_setting(${lit(o.personSetting)}, true), '')::uuid $$;`);
  const engine: Record<string, string> = {
    counters: `create table ${M}.counters (user_id uuid primary key default ${M}.current_user_id(), rev bigint not null default 0, purged_rev bigint not null default 0);`,
    applied_ops: `create table ${M}.applied_ops (user_id uuid not null default ${M}.current_user_id(), op_id uuid not null, result jsonb not null, created_at timestamptz not null default now(), primary key (user_id, op_id));`,
    prefs: `create table ${M}.prefs (user_id uuid primary key default ${M}.current_user_id(), data jsonb not null default '{}', version integer not null default 1, updated_at timestamptz not null default now());`,
    engine_audit: `create table ${M}.engine_audit (id bigint generated always as identity primary key, at timestamptz not null default now(), intent text not null, by_person uuid, type text not null, action text not null, rows integer not null);`,
  };
  for (const [name, sql] of Object.entries(engine)) if (!mine.columns[name]) step(`Create the engine's table ${name}`, sql);
  if (!mine.functions.includes('next_rev'))
    step(
      'Create next_rev()',
      `create function ${M}.next_rev() returns bigint language sql volatile as $$ insert into ${M}.counters as c (user_id, rev) values (${M}.current_user_id(), 1) on conflict (user_id) do update set rev = c.rev + 1 returning c.rev $$;`,
    );
  for (const name of ['counters', 'applied_ops', 'prefs']) personRls(main, name, 'user_id');
  for (const name of ['counters', 'applied_ops', 'prefs']) grant(o.role, ['select', 'insert', 'update'], main, name);
  grant(o.role, ['execute'], main, 'fn:current_user_id');
  grant(o.role, ['execute'], main, 'fn:next_rev');
  grant(o.systemRole, ['insert'], main, 'engine_audit');
  grant(o.systemRole, ['execute'], main, 'fn:current_user_id');

  for (const [type, t] of Object.entries(types)) {
    const { schema, table } = placeOf(type);
    const where = at(schema, table);
    const live = cat(schema).columns[table];
    if (t.view) {
      // The app's migrations make it; here it's checked, and read by whom it may be.
      if (!live) conflicts.push({ table: `${schema}.${table}`, issue: 'missing_view' });
      else
        for (const [c, k] of Object.entries(t.kinds)) {
          const typ = live[c];
          if (typ === undefined) conflicts.push({ table: `${schema}.${table}`, column: c, issue: 'missing_column' });
          else if (!FITS[k].includes(typ)) conflicts.push({ table: `${schema}.${table}`, column: c, issue: 'type', want: PG_TYPE[k], have: typ });
        }
      if (live) {
        if (t.access !== 'system') grant(o.role, ['select'], schema, table);
        grant(o.systemRole, ['select'], schema, table);
      }
      continue;
    }
    if (!live) {
      const cols = Object.entries(t.kinds).map(([c, k]) => `${q(c)} ${columnDdl(t, c, k, main)}`);
      step(`Create table ${schema}.${table}`, `create table ${where} (${cols.join(', ')}${t.key.length ? `, primary key (${t.key.map(q).join(', ')})` : ''});`);
    } else {
      for (const [c, k] of Object.entries(t.kinds)) {
        const typ = live[c];
        if (typ === undefined) {
          // A new column on a table with rows: nullable unless the engine has a default for it.
          const ddl = columnDdl(t, c, k, main).replace(/ not null$/, '');
          step(`Add column ${schema}.${table}.${c}`, `alter table ${where} add column ${q(c)} ${ddl};`);
        } else if (!FITS[k].includes(typ)) conflicts.push({ table: `${schema}.${table}`, column: c, issue: typ === 'timestamp' && k === 'time' ? 'no_zone' : 'type', want: PG_TYPE[k], have: typ });
      }
    }
    // Indexes: the change feed's (person, rev) for records; each query field, after the person where there is one.
    const idx = (cols: string[]) => {
      const iname = `${table}_${cols.join('_')}_idx`.slice(0, 63);
      if (!cat(schema).indexes.includes(iname)) step(`Index ${schema}.${table} (${cols.join(', ')})`, `create index if not exists ${q(iname)} on ${where} (${cols.map(q).join(', ')});`);
    };
    if (t.access === 'record') idx(['user_id', 'rev']);
    for (const f of t.query ?? []) idx([...(t.person ? [t.person] : []), f]);

    if (t.person) personRls(schema, table, t.person);
    else rlsOn(schema, table);
    const all = ['select', 'insert', 'update', 'delete'];
    if (t.access === 'record') grant(o.role, ['select', 'insert', 'update'], schema, table);
    else if (t.access === 'person') grant(o.role, all, schema, table);
    else if (t.access === 'shared') {
      grant(o.role, ['select'], schema, table);
      if (o.role) policy(schema, table, 'engine_read', `for select to ${q(o.role)} using (true)`);
    }
    // A system intent may read records (find, count) and read and write its declared types.
    grant(o.systemRole, t.access === 'record' ? ['select'] : all, schema, table);
    if (o.systemRole) policy(schema, table, 'engine_system', `for all to ${q(o.systemRole)} using (true) with check (true)`);
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
