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

/** The plan for one app's layout against what its schema has. */
export function plan(layout: Layout, have: Catalog, o: PlanOptions): Plan {
  const S = q(o.schema);
  const steps: Step[] = [];
  const conflicts: Conflict[] = [];
  const step = (summary: string, sql: string) => steps.push({ summary, sql });
  const tables = layout.columns ?? {};
  const roles = [o.role, o.systemRole].filter((r): r is string => !!r);

  if (!have.schema) step(`Create schema ${o.schema}`, `create schema ${S};`);
  const needUsage = roles.filter((r) => !have.usage.includes(r));
  if (needUsage.length) step(`Let ${needUsage.join(' and ')} use schema ${o.schema}`, `grant usage on schema ${S} to ${needUsage.map(q).join(', ')};`);
  /** Grants a role what it lacks on a table (or `fn:name`), and nothing it already has. */
  const grant = (role: string | undefined, privs: string[], obj: string) => {
    if (!role) return;
    const missing = privs.filter((p) => !(have.grants[obj]?.[role] ?? []).includes(p));
    if (!missing.length) return;
    const target = obj.startsWith('fn:') ? `function ${S}.${q(obj.slice(3))}()` : `${S}.${q(obj)}`;
    step(`Grant ${role} ${missing.join(', ')} on ${obj.replace(/^fn:/, '')}`, `grant ${missing.join(', ')} on ${target} to ${q(role)};`);
  };

  // The engine's own: who the unit is for, change numbers, the op log, prefs, the audit.
  if (!have.functions.includes('current_user_id'))
    step('Create current_user_id()', `create function ${S}.current_user_id() returns uuid language sql stable as $$ select nullif(current_setting(${lit(o.personSetting)}, true), '')::uuid $$;`);
  const engine: Record<string, string> = {
    counters: `create table ${S}.counters (user_id uuid primary key default ${S}.current_user_id(), rev bigint not null default 0, purged_rev bigint not null default 0);`,
    applied_ops: `create table ${S}.applied_ops (user_id uuid not null default ${S}.current_user_id(), op_id uuid not null, result jsonb not null, created_at timestamptz not null default now(), primary key (user_id, op_id));`,
    prefs: `create table ${S}.prefs (user_id uuid primary key default ${S}.current_user_id(), data jsonb not null default '{}', version integer not null default 1, updated_at timestamptz not null default now());`,
    engine_audit: `create table ${S}.engine_audit (id bigint generated always as identity primary key, at timestamptz not null default now(), intent text not null, by_person uuid, type text not null, action text not null, rows integer not null);`,
  };
  for (const [name, sql] of Object.entries(engine)) if (!have.columns[name]) step(`Create the engine's table ${name}`, sql);
  if (!have.functions.includes('next_rev'))
    step(
      'Create next_rev()',
      `create function ${S}.next_rev() returns bigint language sql volatile as $$ insert into ${S}.counters as c (user_id, rev) values (${S}.current_user_id(), 1) on conflict (user_id) do update set rev = c.rev + 1 returning c.rev $$;`,
    );
  for (const name of ['counters', 'applied_ops', 'prefs']) personRls(name, 'user_id');
  for (const name of ['counters', 'applied_ops', 'prefs']) grant(o.role, ['select', 'insert', 'update'], name);
  grant(o.role, ['execute'], 'fn:current_user_id');
  grant(o.role, ['execute'], 'fn:next_rev');
  grant(o.systemRole, ['insert'], 'engine_audit');
  grant(o.systemRole, ['execute'], 'fn:current_user_id');

  for (const [name, t] of Object.entries(tables)) {
    const live = have.columns[name];
    if (!live) {
      const cols = Object.entries(t.kinds).map(([c, k]) => `${q(c)} ${columnDdl(t, c, k, o.schema)}`);
      step(`Create table ${name}`, `create table ${S}.${q(name)} (${cols.join(', ')}${t.key.length ? `, primary key (${t.key.map(q).join(', ')})` : ''});`);
    } else {
      for (const [c, k] of Object.entries(t.kinds)) {
        const typ = live[c];
        if (typ === undefined) {
          // A new column on a table with rows: nullable unless the engine has a default for it.
          const ddl = columnDdl(t, c, k, o.schema).replace(/ not null$/, '');
          step(`Add column ${name}.${c}`, `alter table ${S}.${q(name)} add column ${q(c)} ${ddl};`);
        } else if (!FITS[k].includes(typ)) conflicts.push({ table: name, column: c, issue: typ === 'timestamp' && k === 'time' ? 'no_zone' : 'type', want: PG_TYPE[k], have: typ });
      }
    }
    // Indexes: the change feed's (person, rev) for records; each query field, after the person where there is one.
    const idx = (cols: string[]) => {
      const iname = `${name}_${cols.join('_')}_idx`.slice(0, 63);
      if (!have.indexes.includes(iname)) step(`Index ${name} (${cols.join(', ')})`, `create index if not exists ${q(iname)} on ${S}.${q(name)} (${cols.map(q).join(', ')});`);
    };
    if (t.access === 'record') idx(['user_id', 'rev']);
    for (const f of t.query ?? []) idx([...(t.person ? [t.person] : []), f]);

    if (t.person) personRls(name, t.person);
    else rlsOn(name);
    const all = ['select', 'insert', 'update', 'delete'];
    if (t.access === 'record') grant(o.role, ['select', 'insert', 'update'], name);
    else if (t.access === 'person') grant(o.role, all, name);
    else if (t.access === 'shared') {
      grant(o.role, ['select'], name);
      if (o.role) policy(name, 'engine_read', `for select to ${q(o.role)} using (true)`);
    }
    // A system intent may read records (find, count) and read and write its declared types.
    grant(o.systemRole, t.access === 'record' ? ['select'] : all, name);
    if (o.systemRole) policy(name, 'engine_system', `for all to ${q(o.systemRole)} using (true) with check (true)`);
  }
  return { steps, conflicts };

  function rlsOn(name: string) {
    const r = have.rls[name];
    if (!r?.enabled) step(`Turn on row-level security for ${name}`, `alter table ${S}.${q(name)} enable row level security;`);
    if (!r?.forced) step(`Force row-level security for ${name}`, `alter table ${S}.${q(name)} force row level security;`);
  }
  function policy(name: string, pname: string, body: string) {
    if (!(have.policies[name] ?? []).includes(pname)) step(`Policy ${pname} on ${name}`, `create policy ${q(pname)} on ${S}.${q(name)} ${body};`);
  }
  function personRls(name: string, col: string) {
    rlsOn(name);
    if (o.role) policy(name, 'engine_person', `for all to ${q(o.role)} using (${q(col)} = ${S}.current_user_id()) with check (${q(col)} = ${S}.current_user_id())`);
  }
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
