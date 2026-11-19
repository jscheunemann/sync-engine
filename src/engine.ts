// The engine (version 2, ADRs 0002 to 0011): an app gives it connection settings and intents; the engine owns
// everything between the app and its data. This file is the core: it knows no database. It turns each intent into calls
// on a backend (backend.ts) and applies the sync rules: optimistic concurrency by version, ops applied once by op_id, a
// savepoint per op, content encryption through the app's hooks, the change feed, and prefs.
//
//   const engine = createEngine({ store, backend: postgres });                 // once
//   const session = engine.connect({ url: env.HYPERDRIVE.connectionString });  // per request
//   const results = await session.work({ person }, (w) => w.apply(ops));       // per call
//   ctx.waitUntil(session.close());
//
// The rules are version 1's (server.ts) unchanged: the contract tests run the same cases against both.

import { type AuditEntry, type Backend, type Cond, type Connection, isSystem, type Row, RuleError, type SchemaPlan, type Scope, type TableLayout, type Unit } from './backend.ts';
import { conditions, cursor, EngineError, type FindOptions, fits, type Kind, out, type SummaryOptions, type SystemDecl, type TypeDecl, type Where } from './declare.ts';
import type { ChangesPage, Fields, Op, Problem, ServerRecord } from './protocol.ts';
import { type FieldDecl, RecordType, type StoredRecord } from './records.ts';

export { RuleError, isSystem, type SchemaPlan, type TableLayout, type Backend, type PersonScope, type Row, type Scope, type SystemScope } from './backend.ts';
export { EngineError, type FindOptions, type GroupBy, type Kind, type Match, type Measure, type SummaryOptions, type SystemDecl, type TypeDecl, type Where } from './declare.ts';

export { type FieldDecl, type StoredRecord } from './records.ts';

/** A page of a find: the rows, and the cursor for the next page (null at the end). */
export interface Page<R> {
  rows: R[];
  next: string | null;
}

/** What may be read inside a unit of work (and what an app's hooks get): kept to the unit's scope. */
export interface Reader<T extends string = string> {
  get(type: T, id: string): Promise<StoredRecord | null>;
  getMany(type: T, ids: readonly string[]): Promise<StoredRecord[]>;
  /** Records of a type, or rows of a declared type, by declared fields only (ADR 0003). */
  find(type: T, opts?: FindOptions): Promise<Page<StoredRecord>>;
  find(type: string, opts?: FindOptions): Promise<Page<Row>>;
  count(type: string, opts?: { where?: Where }): Promise<number>;
  /** Groups and measures of a type's rows, by declared fields and paths only (ADR 0016). */
  summarize(type: string, opts: SummaryOptions): Promise<Row[]>;
}

/** The outcome of an update to a declared type. */
export type UpdateResult = { status: 'applied'; row: Row } | { status: 'conflict'; current: Row } | { status: 'not_found' };

/**
 * An app's records (ADR 0014): each type's fields, declared, and the app's rules for them. How a record is stored is
 * the engine's: the app never sees a column.
 */
export interface RecordStore<T extends string = string> {
  types: readonly T[];
  /** Each type's fields: a kind, or `{ kind, content: true }` for what people wrote (kept together, encrypted). */
  fields: Readonly<Record<T, Readonly<Record<string, FieldDecl>>>>;
  /** Fields with their defaults, for a new record (default: every field null). */
  defaults?(type: T): Fields;
  /** Problems with a set of changes alone (default: unknown fields, and values not of their kind). */
  checkChanges?(type: T, changes: Fields): Problem[];
  /** Values the rules imply (a done time when something is done). Returns a new object. */
  normalize?(type: T, fields: Fields, now: string): Fields;
  /** Every problem with a whole record. With `sealed`, content was checked on the device and can't be read here. */
  validate(type: T, fields: Fields, id: string, opts: { sealed: boolean }): Problem[];
  /** Rules that need other records, checked in the write's unit of work through `read` (no database access of their own). */
  crossChecks?(read: Reader<T>, type: T, id: string, fields: Fields, deleted: boolean): Promise<Problem[]>;
  /** Whether new records of this type may be written in bulk (default: types without `crossChecks`). */
  bulkSafe?(type: T): boolean;
}

/** A store with its mappings made: what the rules below work with. */
interface Mapped<T extends string> {
  types: readonly T[];
  isType(t: unknown): t is T;
  type(t: T): RecordType;
  fieldNames(t: T): readonly string[];
  contentFields(t: T): readonly string[];
  defaults(t: T): Fields;
  checkChanges(t: T, changes: Fields): Problem[];
  normalize(t: T, fields: Fields, now: string): Fields;
  validate: RecordStore<T>['validate'];
  crossChecks?: RecordStore<T>['crossChecks'];
  bulkSafe?: RecordStore<T>['bulkSafe'];
  toRecord(t: T, row: Row): StoredRecord;
  toColumns(t: T, fields: Fields): Row & { content: Row };
}

function mapStore<T extends string>(store: RecordStore<T>): Mapped<T> {
  const byType = new Map<string, RecordType>(store.types.map((t) => [t, new RecordType(t, store.fields[t] ?? {})]));
  const rt = (t: T) => byType.get(t)!;
  return {
    types: store.types,
    isType: (t): t is T => typeof t === 'string' && byType.has(t),
    type: rt,
    fieldNames: (t) => rt(t).names,
    contentFields: (t) => rt(t).content,
    defaults: (t) => ({ ...rt(t).empty(), ...(store.defaults?.(t) ?? {}) }),
    checkChanges: (t, c) => (store.checkChanges ? store.checkChanges(t, c) : rt(t).check(c)),
    normalize: (t, f, now) => (store.normalize ? store.normalize(t, f, now) : { ...f }),
    validate: (t, f, id, o) => store.validate(t, f, id, o),
    ...(store.crossChecks ? { crossChecks: (r: Reader<T>, t: T, id: string, f: Fields, d: boolean) => store.crossChecks!(r, t, id, f, d) } : {}),
    ...(store.bulkSafe ? { bulkSafe: (t: T) => store.bulkSafe!(t) } : {}),
    toRecord: (t, row) => rt(t).toRecord(row),
    toColumns: (t, f) => rt(t).toColumns(f),
  };
}

/**
 * Encryption of what people wrote, when an app has it (ADR 0010). Without it (`plain`), content is stored as it comes
 * (enc 0). Per unit of work: `prepare` runs once at its start and may read what the app's keys need.
 */
export interface ContentCrypto {
  prepare?(read: Reader): Promise<void>;
  /** End-to-end encryption is on: content must arrive sealed by the device. */
  vaultEnabled(): Promise<boolean>;
  openRow(type: string, row: Row): Promise<Row>;
  sealContent(type: string, id: string, content: Row): Promise<{ content: Row; enc: number; key_version: number }>;
  openDoc(aad: string, value: unknown): Promise<unknown>;
  sealDoc(aad: string, value: unknown): Promise<unknown>;
}

export const plain: ContentCrypto = {
  vaultEnabled: async () => false,
  openRow: async (_type, row) => row,
  sealContent: async (_type, _id, content) => ({ content, enc: 0, key_version: 0 }),
  openDoc: async (_aad, value) => value,
  sealDoc: async (_aad, value) => value,
};

export type StoreOpResult<T extends string = string> =
  | { op_id: string; status: 'applied' | 'duplicate'; type: T; id: string; created: boolean; record: StoredRecord }
  | { op_id: string; status: 'conflict'; type: T; id: string; current: StoredRecord | null }
  | { op_id: string; status: 'not_found'; type: T; id: string }
  | { op_id: string; status: 'invalid'; type?: string; id?: string; problems: Problem[] };

/** The cursor is older than tombstones the server has cleaned up: the device must read everything again (HTTP 410). */
export class CursorExpired extends Error {
  readonly status = 410;
  constructor() {
    super('cursor_expired');
  }
}

export type Prefs = { data: Record<string, unknown>; version: number };
export type PutPrefsResult = Prefs | { conflict: { data: unknown; version: number } } | { problems: Problem[] };

/** One unit of work's intents (ADRs 0003, 0008): everything inside lands together or not at all. */
export interface Work<T extends string = string> extends Reader<T> {
  /**
   * Applies ops, each with the rules (version, once by op_id, its own savepoint). Results come back in the order of
   * `ops`. The engine picks the fastest way that gives the same results: all new records goes in bulk (a restore), all
   * plain deletes goes in bulk (clearing data), anything else one by one.
   */
  apply(ops: readonly Op<T>[], now?: string): Promise<StoreOpResult<T>[]>;
  /** Every record changed after `since`, in change order, at most `limit`. Throws CursorExpired after a clean-up. */
  changes(since: number, limit: number): Promise<ChangesPage<T>>;
  readonly prefs: {
    get(): Promise<Prefs>;
    /** Replaces the prefs if `baseVersion` is current; otherwise returns the current copy to merge with. */
    put(data: Record<string, unknown>, baseVersion: number): Promise<PutPrefsResult>;
  };
  /**
   * Writes a new row of a declared type; returns it as stored. With `onConflict` (ADR 0016), a row whose key is taken
   * is updated with the given fields (`update`), or left as it is (`nothing`: null comes back).
   */
  put(type: string, row: Row, opts?: { onConflict?: 'update' | 'nothing' }): Promise<Row | null>;
  /** Holds a named lock until the unit ends, so two units doing the same thing go one after the other. */
  lock(name: string): Promise<void>;
  /** Changes the row with this key; with a `version` column, only if `version` is still current. */
  update(type: string, key: Row, changes: Row, version?: number): Promise<UpdateResult>;
  /** Removes the row with this key; returns whether there was one. */
  remove(type: string, key: Row): Promise<boolean>;
}

/** A request's session: one connection, any number of units of work. */
export interface Session<T extends string = string> {
  work<R>(scope: Scope, fn: (w: Work<T>) => Promise<R>, opts?: { crypto?: ContentCrypto }): Promise<R>;
  close(): Promise<void>;
}

export interface Engine<T extends string, S> {
  readonly store: RecordStore<T>;
  connect(settings: S): Session<T>;
  /**
   * The tables the declarations need, against the database (ADR 0006): steps to read, and conflicts only a person can
   * settle. Changes nothing. Settings for a database user that may change the schema.
   */
  plan(settings: S): Promise<SchemaPlan>;
  /**
   * Applies a plan the owner read: refused if the database has moved since (the plan isn't what it would be now) or if
   * it has conflicts. All its steps or none.
   */
  migrate(settings: S, plan: SchemaPlan): Promise<void>;
}

/** How many rows one bulk write takes. */
export const BULK_ROWS = 500;

/** The engine for an app's records on a backend. Make it once; connect per request. */
export function createEngine<T extends string, S>(opts: {
  store: RecordStore<T>;
  backend: Backend<S>;
  /** Types the app's server writes (not synced from devices), by name (ADR 0003). */
  types?: Readonly<Record<string, TypeDecl>>;
  /** System intents, by name (ADR 0009). */
  system?: Readonly<Record<string, SystemDecl>>;
}): Engine<T, S> {
  const { backend } = opts;
  const store = mapStore(opts.store);
  const types = opts.types ?? {};
  const system = opts.system ?? {};
  for (const name of Object.keys(types)) if ((store.types as readonly string[]).includes(name)) throw new EngineError('type_declared_twice', name);
  for (const [name, d] of Object.entries(system))
    for (const t of [...(d.read ?? []), ...(d.write ?? [])]) if (!types[t] && !store.isType(t)) throw new EngineError('unknown_type', `${name}.${t}`);
  checkTypes(types);
  const tables = Object.keys(types);
  // Every table's columns by kind, for the backend to write each value as its kind and, in part 4b, to make the tables.
  const columns: Record<string, TableLayout> = {};
  for (const t of store.types) columns[t] = { table: t, kinds: { user_id: 'id', ...store.type(t).columns }, key: ['user_id', 'id'], access: 'record', person: 'user_id' };
  for (const [name, d] of Object.entries(types)) {
    const person = d.access === 'person' ? (d.personColumn ?? 'user_id') : undefined;
    columns[name] = {
      table: d.table ?? name,
      ...(d.view ? { view: d.view === true ? (true as const) : { remove: true as const } } : {}),
      ...(d.writes === 'system' ? { personReads: true as const } : {}),
      kinds: { ...(person ? { [person]: 'id' as Kind } : {}), ...d.fields },
      key: [...(person ? [person] : []), ...d.key],
      access: d.access,
      ...(person ? { person } : {}),
      query: (d.query ?? []).filter((f) => !d.key.includes(f)),
      ...(d.paths ? { paths: d.paths } : {}),
    };
  }
  const layout = { types: store.types, tables, columns };
  const schema = () => {
    if (!backend.schema) throw new EngineError('no_schema_support', backend.kind);
    return backend.schema;
  };
  return {
    store: opts.store,
    plan: (settings) => schema().plan(settings, layout),
    async migrate(settings, given) {
      const now = await schema().plan(settings, layout);
      if (now.conflicts.length) throw new EngineError('schema_conflicts');
      if (JSON.stringify(now.steps) !== JSON.stringify(given.steps)) throw new EngineError('plan_out_of_date');
      if (now.steps.length) await schema().apply(settings, now);
    },
    connect(settings: S): Session<T> {
      const conn: Connection = backend.connect(settings, layout);
      return {
        work: (scope, fn, o) => {
          if (isSystem(scope)) {
            if (!system[scope.system]) throw new EngineError('unknown_system_intent', scope.system);
          } else if (!scope || typeof scope.person !== 'string' || !scope.person) throw new Error('scope_required');
          const crypto = o?.crypto ?? plain;
          return conn.unit(scope, async (u) => {
            const core = new Core(store, types, system, scope, crypto, u);
            await crypto.prepare?.(core.reader(u));
            return fn(core.work());
          });
        },
        close: () => conn.close(),
      };
    },
  };
}

/** A value as a cursor keeps it: times as ISO strings, change numbers as text. */
const jsonValue = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() : v);

const opAad = (opId: string) => `op|${opId}`;
const invalid = <T extends string>(op: Op<T>, problems: Problem[]): StoreOpResult<T> => ({ op_id: op.op_id, status: 'invalid', type: op.type, id: op.id, problems });
const createdAtOk = (createdAt: string, now: string) => {
  const t = Date.parse(createdAt);
  return !(t < Date.parse('2000-01-01T00:00:00Z') || t > Date.parse(now) + 86_400_000);
};

/** The fields of a stored record, without the sync columns (inside the engine, from a mapped store). */
const fieldsOf = <T extends string>(store: Mapped<T>, type: T, rec: ServerRecord): Fields =>
  Object.fromEntries(store.fieldNames(type).map((n) => [n, rec[n] ?? null]));

/** The fields of a stored record, without the sync columns. */
export function fieldsFrom<T extends string>(store: RecordStore<T>, type: T, rec: ServerRecord): Fields {
  const out: Fields = {};
  for (const name of Object.keys(store.fields[type] ?? {})) out[name] = rec[name] ?? null;
  return out;
}

/** A type as a find sees it: its table, who its rows belong to, its key, and the fields it may use. */
interface Shape {
  name: string;
  table: string;
  record: boolean;
  access: TypeDecl['access'];
  personColumn: string;
  key: readonly string[];
  fields: Readonly<Record<string, Kind>>;
  queryable: Map<string, { col: string; kind: Kind }>;
  decl?: TypeDecl;
}

const FIND_LIMIT = 100;
/** An IANA time zone the runtime knows. */
const validZone = (z: unknown): z is string => {
  if (typeof z !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(z)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
};
/** The engine's own tables in an app's schema: never an app's declared type. */
const ENGINE_TABLES = ['counters', 'applied_ops', 'prefs', 'engine_audit'];
const FIND_MAX = 1000;

/** Checks an app's declared types once, when the engine is made. */
function checkTypes(types: Readonly<Record<string, TypeDecl>>): void {
  for (const [name, d] of Object.entries(types)) {
    if (!['person', 'shared', 'system'].includes(d.access)) throw new EngineError('bad_access', name);
    // A type can't be called after the engine's own tables. Its table may share a name with one if the backend keeps it
    // elsewhere (another schema): the backend checks that, since only it knows where tables are.
    if (ENGINE_TABLES.includes(name)) throw new EngineError('engine_table', name);
    if (d.writes !== undefined && (d.writes !== 'system' || d.access !== 'person')) throw new EngineError('bad_writes', name);
    if (d.view !== undefined && d.view !== true && !(typeof d.view === 'object' && d.view.remove === true && d.access === 'system')) throw new EngineError('bad_view', name);
    for (const k of [...d.key, ...(d.query ?? []), ...(d.sealed ?? []), ...(d.version ? [d.version] : [])])
      if (!d.fields[k]) throw new EngineError('undeclared_field', `${name}.${k}`);
    for (const k of d.sealed ?? []) if (d.fields[k] !== 'json') throw new EngineError('sealed_not_json', `${name}.${k}`);
    if (d.version && d.fields[d.version] !== 'number') throw new EngineError('version_not_number', `${name}.${d.version}`);
    if (d.access === 'person' && d.fields[d.personColumn ?? 'user_id']) throw new EngineError('person_column_declared', `${name}.${d.personColumn ?? 'user_id'}`);
    for (const [p, x] of Object.entries(d.paths ?? {})) {
      if (d.fields[p]) throw new EngineError('path_is_a_field', `${name}.${p}`);
      if (d.fields[x.from] !== 'json') throw new EngineError('path_not_in_json', `${name}.${p}`);
      if (!x.path.length || x.path.some((k) => typeof k !== 'string' || !k || k.length > 100)) throw new EngineError('bad_path', `${name}.${p}`);
      if (!['text', 'number', 'boolean'].includes(x.kind)) throw new EngineError('bad_path', `${name}.${p}`);
    }
  }
}

/** The rules, on one unit. */
class Core<T extends string> {
  private readonly store: Mapped<T>;
  private readonly types: Readonly<Record<string, TypeDecl>>;
  private readonly crypto: ContentCrypto;
  private readonly u: Unit;
  /** The scope's person, or null in a system unit. */
  private readonly person: string | null;
  private readonly intent: { name: string; by: string | null; decl: SystemDecl } | null;
  constructor(store: Mapped<T>, types: Readonly<Record<string, TypeDecl>>, system: Readonly<Record<string, SystemDecl>>, scope: Scope, crypto: ContentCrypto, u: Unit) {
    this.store = store;
    this.types = types;
    this.crypto = crypto;
    this.u = u;
    if (isSystem(scope)) {
      this.person = null;
      this.intent = { name: scope.system, by: scope.by ?? null, decl: system[scope.system]! };
    } else {
      this.person = scope.person;
      this.intent = null;
    }
  }

  private check(type: unknown): asserts type is T {
    if (!this.store.isType(type)) throw new Error('unknown_type');
  }

  /** Records, prefs and the change feed are one person's: a system unit reaches records only through find and count. */
  private personOnly(): void {
    if (this.person === null) throw new EngineError('person_scope_only');
  }

  private shape(type: string): Shape {
    if (this.store.isType(type)) {
      const fields = this.store.type(type).queryable;
      const queryable = new Map(Object.entries(fields).map(([n, k]) => [n, { col: n, kind: k }]));
      return { name: type, table: type, record: true, access: 'person', personColumn: 'user_id', key: ['id'], fields, queryable };
    }
    const d = this.types[type];
    if (!d) throw new EngineError('unknown_type', type);
    const queryable = new Map<string, { col: string; kind: Kind }>();
    for (const n of [...d.key, ...(d.query ?? [])]) queryable.set(n, { col: n, kind: d.fields[n]! });
    for (const [n, x] of Object.entries(d.paths ?? {})) queryable.set(n, { col: n, kind: x.kind });
    return { name: type, table: type, record: false, access: d.access, personColumn: d.personColumn ?? 'user_id', key: d.key, fields: d.fields, queryable, decl: d };
  }

  /** Whether this unit may read or write a type (ADR 0009); the person filter a query takes when it may. */
  private allow(sh: Shape, write: boolean): string | null {
    if (this.intent) {
      const d = this.intent.decl;
      const ok = write ? (d.write ?? []).includes(sh.name) : [...(d.read ?? []), ...(d.write ?? [])].includes(sh.name);
      if (!ok) throw new EngineError('not_permitted', sh.name);
      return null;
    }
    if (sh.access === 'system') throw new EngineError('system_only', sh.name);
    if (sh.access === 'shared') {
      if (write) throw new EngineError('system_only', sh.name);
      return null;
    }
    if (write && sh.decl?.writes === 'system') throw new EngineError('system_only', sh.name);
    return this.person;
  }

  private async audit(sh: Shape, action: 'get' | 'find' | 'count' | 'summarize' | 'put' | 'update' | 'remove', rows: number): Promise<void> {
    if (this.intent) await this.u.audit({ intent: this.intent.name, by: this.intent.by, type: sh.name, action, rows });
  }

  private aad(sh: Shape, field: string, row: Row): string {
    if (sh.decl?.aad) return sh.decl.aad(field, row);
    return [sh.name, ...sh.key.map((k) => String(row[k] ?? '')), field].join('|');
  }

  /** A stored row of a declared type as the app gets it: declared fields, by kind, sealed ones opened. */
  private async outRow(sh: Shape, row: Row): Promise<Row> {
    const o: Row = {};
    for (const [n, k] of Object.entries(sh.fields)) o[n] = out(k, row[n]);
    if (sh.access === 'person' && this.person === null) o[sh.personColumn] = out('id', row[sh.personColumn]);
    for (const f of sh.decl?.sealed ?? []) if (o[f] !== null) o[f] = await this.crypto.openDoc(this.aad(sh, f, o), o[f]);
    return o;
  }

  private async find(u: Unit, type: string, opts: FindOptions = {}): Promise<Page<Row>> {
    const sh = this.shape(type);
    const person = this.allow(sh, false);
    const where = conditions(opts.where, sh.queryable);
    let order: { col: string; desc: boolean } | undefined;
    if (opts.order !== undefined) {
      const desc = opts.order.startsWith('-');
      const name = desc ? opts.order.slice(1) : opts.order;
      const f = sh.queryable.get(name);
      if (!f) throw new EngineError('not_queryable', name);
      if (!sh.key.includes(name) || sh.key.length > 1) order = { col: f.col, desc };
      else if (desc) order = { col: f.col, desc };
    }
    const limit = opts.limit ?? FIND_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > FIND_MAX) throw new EngineError('bad_limit');
    const after = opts.after !== undefined ? cursor.read(opts.after) : undefined;
    if (after && after.length !== sh.key.length + (order ? 1 : 0)) throw new EngineError('bad_cursor');
    const rows = await u.select({ table: sh.table, person, personColumn: sh.personColumn, where, order, key: sh.key, after, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next = rows.length > limit && last ? cursor.make([...(order ? [jsonValue(last[order.col])] : []), ...sh.key.map((k) => jsonValue(last[k]))]) : null;
    await this.audit(sh, 'find', page.length);
    if (sh.record) {
      const t = type as T;
      return { rows: await Promise.all(page.map(async (r) => this.store.toRecord(t, await this.crypto.openRow(t, r)) as unknown as Row)), next };
    }
    return { rows: await Promise.all(page.map((r) => this.outRow(sh, r))), next };
  }

  private async count(u: Unit, type: string, opts: { where?: Where } = {}): Promise<number> {
    const sh = this.shape(type);
    const person = this.allow(sh, false);
    const n = await u.count({ table: sh.table, person, personColumn: sh.personColumn, where: conditions(opts.where, sh.queryable), key: sh.key });
    await this.audit(sh, 'count', n);
    return n;
  }

  private async summarize(u: Unit, type: string, o: SummaryOptions): Promise<Row[]> {
    const sh = this.shape(type);
    const person = this.allow(sh, false);
    const field = (name: string) => {
      const f = sh.queryable.get(name);
      if (!f) throw new EngineError('not_queryable', name);
      return f;
    };
    const alias = (a: string) => {
      if (!/^[a-z][a-z0-9_]{0,62}$/i.test(a)) throw new EngineError('bad_name', a);
      return a;
    };
    const kinds = new Map<string, Kind | 'day'>();
    const by = (o.by ?? []).map((g) => {
      if (typeof g === 'string') {
        const f = field(g);
        kinds.set(g, f.kind);
        return { col: f.col, as: alias(g) };
      }
      const f = field(g.day);
      if (f.kind !== 'time') throw new EngineError('not_a_time', g.day);
      if (!validZone(g.zone)) throw new EngineError('bad_zone', 'zone');
      const as = alias(g.as ?? g.day);
      kinds.set(as, 'day');
      return { day: f.col, zone: g.zone, as };
    });
    if (by.length > 6) throw new EngineError('too_many_groups');
    const measures = Object.entries(o.measures ?? {}).map(([as, m]) => {
      alias(as);
      if (kinds.has(as)) throw new EngineError('name_taken', as);
      const where = conditions(m.where, sh.queryable);
      const fns = (['count', 'distinct', 'sum', 'avg', 'min', 'max', 'percentile'] as const).filter((k) => k in m);
      if (fns.length !== 1) throw new EngineError('bad_measure', as);
      const fn = fns[0]!;
      if (fn === 'count') {
        if ((m as { count: unknown }).count !== true) throw new EngineError('bad_measure', as);
        kinds.set(as, 'integer');
        return { as, fn, where };
      }
      const f = field((m as Record<string, unknown>)[fn] as string);
      if (['sum', 'avg', 'percentile'].includes(fn) && f.kind !== 'number' && f.kind !== 'integer') throw new EngineError('not_a_number', as);
      const p = (m as { p?: number }).p;
      if (fn === 'percentile' && !(typeof p === 'number' && p > 0 && p <= 1)) throw new EngineError('bad_measure', as);
      kinds.set(as, fn === 'distinct' ? 'integer' : fn === 'min' || fn === 'max' ? f.kind : 'number');
      return { as, fn, col: f.col, where, ...(fn === 'percentile' ? { p: p! } : {}) };
    });
    if (!measures.length || measures.length > 20) throw new EngineError('bad_measure');
    let order: { as: string; desc: boolean } | undefined;
    if (o.order !== undefined) {
      const desc = o.order.startsWith('-');
      const as = desc ? o.order.slice(1) : o.order;
      if (!kinds.has(as)) throw new EngineError('not_queryable', as);
      order = { as, desc };
    }
    const limit = o.limit ?? FIND_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > FIND_MAX) throw new EngineError('bad_limit');
    const rows = await u.summarize({ table: sh.table, person, personColumn: sh.personColumn, where: conditions(o.where, sh.queryable), by, measures, ...(order ? { order } : {}), limit });
    await this.audit(sh, 'summarize', rows.length);
    return rows.map((r) => {
      const o: Row = {};
      for (const [k, kind] of kinds) {
        const v = r[k];
        o[k] = kind === 'day' ? (v === null || v === undefined ? null : String(v).slice(0, 10)) : out(kind, v);
      }
      return o;
    });
  }

  /** A declared type, for a write: records are written only through apply. */
  private writable(type: string, op: 'put' | 'update' | 'remove'): { sh: Shape; person: string | null } {
    const sh = this.shape(type);
    if (sh.record) throw new EngineError('records_use_apply', type);
    if (sh.decl?.view && !(op === 'remove' && sh.decl.view !== true && (sh.decl.view as { remove?: true }).remove)) throw new EngineError('read_only', type);
    return { sh, person: this.allow(sh, true) };
  }

  /** Columns from what the app gave: declared fields only, each of its kind, sealed ones sealed. */
  private async columns(sh: Shape, given: Row, keyRow: Row): Promise<Row> {
    const c: Row = {};
    for (const [n, v] of Object.entries(given)) {
      const kind = sh.fields[n];
      if (!kind) throw new EngineError('unknown_field', n);
      if (v === undefined) continue;
      if (!fits(kind, v)) throw new EngineError('bad_value', n);
      c[n] = (sh.decl?.sealed ?? []).includes(n) && v !== null ? await this.crypto.sealDoc(this.aad(sh, n, { ...keyRow, ...given }), v) : v;
    }
    return c;
  }

  private keyMatch(sh: Shape, key: Row, person: string | null): Cond[] {
    // A system unit names the person of a person type's row in its key; a person unit's person is its own.
    const names = Object.keys(key).filter((k) => !(sh.access === 'person' && person === null && k === sh.personColumn));
    if (names.length !== sh.key.length || !sh.key.every((k) => names.includes(k))) throw new EngineError('bad_key', sh.name);
    const m: Cond[] = sh.key.map((k) => {
      if (!fits(sh.fields[k]!, key[k]) || key[k] === null) throw new EngineError('bad_value', k);
      return { col: k, op: 'eq', value: key[k] };
    });
    if (sh.access === 'person') {
      const who = person ?? key[sh.personColumn];
      if (person === null && (typeof who !== 'string' || !who)) throw new EngineError('person_required', sh.personColumn);
      m.push({ col: sh.personColumn, op: 'eq', value: who });
    }
    return m;
  }

  private refused(e: unknown): never {
    if (e instanceof RuleError) throw new EngineError(e.kind === 'reference' ? 'reference' : 'refused', e.rule || undefined);
    throw e;
  }

  private async put(type: string, given: Row, opts: { onConflict?: 'update' | 'nothing' } = {}): Promise<Row | null> {
    const { sh, person } = this.writable(type, 'put');
    const row = { ...given };
    let who: unknown = person;
    if (sh.access === 'person') {
      if (person === null) {
        who = row[sh.personColumn];
        if (typeof who !== 'string' || !who) throw new EngineError('person_required', sh.personColumn);
      } else if (row[sh.personColumn] !== undefined && row[sh.personColumn] !== person) throw new EngineError('not_yours', sh.personColumn);
      delete row[sh.personColumn];
    }
    const c = await this.columns(sh, row, row);
    if (sh.decl?.version && c[sh.decl.version] === undefined) c[sh.decl.version] = 1;
    if (sh.access === 'person') c[sh.personColumn] = who;
    try {
      if (opts.onConflict !== undefined && !['update', 'nothing'].includes(opts.onConflict)) throw new EngineError('bad_on_conflict');
      const key = [...(sh.access === 'person' ? [sh.personColumn] : []), ...sh.key];
      const stored = await this.u.savepoint((sp) => sp.insert(sh.table, c, opts.onConflict ? { key, action: opts.onConflict } : undefined));
      await this.audit(sh, 'put', stored ? 1 : 0);
      return stored ? this.outRow(sh, stored) : null;
    } catch (e) {
      this.refused(e);
    }
  }

  private async update(type: string, key: Row, changes: Row, version?: number): Promise<UpdateResult> {
    const { sh, person } = this.writable(type, 'update');
    const match = this.keyMatch(sh, key, person);
    const keyRow: Row = Object.fromEntries(sh.key.map((k) => [k, key[k]]));
    for (const k of [...sh.key, sh.personColumn]) if (k in changes) throw new EngineError('key_field', k);
    const vcol = sh.decl?.version;
    if (vcol && vcol in changes) throw new EngineError('key_field', vcol);
    if (vcol && (typeof version !== 'number' || !Number.isInteger(version))) throw new EngineError('version_required', vcol);
    const c = await this.columns(sh, changes, keyRow);
    if (vcol) c[vcol] = version! + 1;
    const guarded = vcol ? [...match, { col: vcol, op: 'eq' as const, value: version }] : match;
    let row: Row | null;
    try {
      row = await this.u.savepoint((sp) => sp.update(sh.table, guarded, c));
    } catch (e) {
      this.refused(e);
    }
    await this.audit(sh, 'update', row ? 1 : 0);
    if (row) return { status: 'applied', row: await this.outRow(sh, row) };
    if (!vcol) return { status: 'not_found' };
    const [current] = await this.u.select({ table: sh.table, person: null, personColumn: sh.personColumn, where: match, key: sh.key, limit: 1 });
    return current ? { status: 'conflict', current: await this.outRow(sh, current) } : { status: 'not_found' };
  }

  private async remove(type: string, key: Row): Promise<boolean> {
    const { sh, person } = this.writable(type, 'remove');
    const match = this.keyMatch(sh, key, person);
    let n: number;
    try {
      n = await this.u.savepoint((sp) => sp.remove(sh.table, match));
    } catch (e) {
      this.refused(e);
    }
    await this.audit(sh, 'remove', n);
    return n > 0;
  }

  reader(u: Unit): Reader<T> {
    return {
      get: async (type, id) => {
        this.personOnly();
        this.check(type);
        const row = await u.getRow(type, id);
        return row ? this.store.toRecord(type, await this.crypto.openRow(type, row)) : null;
      },
      getMany: async (type, ids) => {
        this.personOnly();
        this.check(type);
        if (!ids.length) return [];
        const rows = await u.getRows(type, ids);
        return Promise.all(rows.map(async (r) => this.store.toRecord(type, await this.crypto.openRow(type, r))));
      },
      find: ((type: string, opts?: FindOptions) => this.find(u, type, opts)) as Reader<T>['find'],
      count: (type, opts) => this.count(u, type, opts),
      summarize: (type, opts) => this.summarize(u, type, opts),
    };
  }

  work(): Work<T> {
    const r = this.reader(this.u);
    const p = () => this.personOnly();
    return {
      get: r.get,
      getMany: r.getMany,
      find: r.find,
      count: r.count,
      summarize: r.summarize,
      apply: (ops, now) => (p(), this.apply(ops, now ?? new Date().toISOString())),
      changes: (since, limit) => (p(), this.changes(since, limit)),
      prefs: { get: () => (p(), this.getPrefs()), put: (data, base) => (p(), this.putPrefs(data, base)) },
      put: (type, row, opts) => this.put(type, row, opts),
      lock: async (name) => {
        if (typeof name !== 'string' || !name || name.length > 200) throw new EngineError('bad_lock');
        await this.u.lock(name);
      },
      update: (type, key, changes, version) => this.update(type, key, changes, version),
      remove: (type, key) => this.remove(type, key),
    };
  }

  private async record(u: Unit, type: T, id: string, lock: boolean): Promise<StoredRecord | null> {
    const row = await u.getRow(type, id, lock);
    return row ? this.store.toRecord(type, await this.crypto.openRow(type, row)) : null;
  }

  private bulkType(t: T): boolean {
    return this.store.bulkSafe ? this.store.bulkSafe(t) : !this.store.crossChecks;
  }

  async apply(ops: readonly Op<T>[], now: string): Promise<StoreOpResult<T>[]> {
    for (const op of ops) this.check(op.type);
    const isCreate = (op: Op<T>) => op.base_version === null && op.delete === undefined;
    const plainDelete = (op: Op<T>) => op.delete === true && op.base_version !== null && !Object.keys(op.fields ?? {}).length && op.sealed === undefined;
    if (ops.length > 1 && ops.every((op) => isCreate(op) && this.bulkType(op.type))) return this.applyCreates(ops, now);
    if (ops.length > 1 && ops.every(plainDelete)) return this.applyDeletes(ops, now);
    const out: StoreOpResult<T>[] = [];
    for (const op of ops) out.push(await this.applyOp(op, now));
    return out;
  }

  /** One op, in its own savepoint (version 1's applyOp). */
  async applyOp(op: Op<T>, now: string): Promise<StoreOpResult<T>> {
    const done = await this.u.appliedResult(op.op_id);
    if (done !== undefined) return { ...((await this.crypto.openDoc(opAad(op.op_id), done)) as StoreOpResult<T> & { status: 'applied' }), status: 'duplicate' };
    const changes = op.fields ?? {};
    const shapeProblems = this.store.checkChanges(op.type, changes);
    if (shapeProblems.length) return invalid(op, shapeProblems);
    try {
      return await this.u.savepoint((sp) => this.applyIn(sp, op, changes, now));
    } catch (e) {
      // A database rule caught something the app's rules didn't (a check): report it on the op, keep the others going.
      if (e instanceof RuleError && e.kind === 'rule') return invalid(op, [{ field: e.rule || 'record', code: 'db_rule' }]);
      throw e;
    }
  }

  private async applyIn(sp: Unit, op: Op<T>, changes: Fields, now: string): Promise<StoreOpResult<T>> {
    const { store, crypto } = this;
    const current = await this.record(sp, op.type, op.id, true);
    let fields: Fields;
    let deletedAt: string | null;
    if (!current) {
      if (op.base_version !== null) return { op_id: op.op_id, status: 'not_found', type: op.type, id: op.id };
      fields = { ...store.defaults(op.type), ...changes };
      deletedAt = op.delete === true ? now : null;
    } else {
      if (op.base_version === null || op.base_version !== current.version) return { op_id: op.op_id, status: 'conflict', type: op.type, id: op.id, current };
      fields = { ...fieldsOf(store, op.type, current), ...changes };
      deletedAt = op.delete === true ? (current.deleted_at ?? now) : op.delete === false ? null : current.deleted_at;
    }
    fields = store.normalize(op.type, fields, now);

    // Where the content comes from: the device's ciphertext, the stored ciphertext kept as it is, or plaintext the
    // server stores (encrypting it at rest when the app does).
    const named = store.contentFields(op.type);
    const changedContent = Object.keys(changes).filter((k) => named.includes(k));
    let stored: 'device' | 'keep' | 'plain';
    if (op.sealed !== undefined) {
      if (changedContent.length) return invalid(op, [{ field: changedContent[0]!, code: 'content_outside_sealed' }]);
      stored = 'device';
    } else if (named.length && (changedContent.length || !current) && (await crypto.vaultEnabled())) {
      return invalid(op, [{ field: 'sealed', code: 'sealed_required' }]);
    } else if (current?.enc === 2) {
      if (!changedContent.length) stored = 'keep';
      else if (named.every((k) => k in changes)) stored = 'plain'; // the whole content in plaintext: encryption was turned off
      else return invalid(op, [{ field: changedContent[0]!, code: 'sealed_record' }]);
    } else stored = 'plain';

    const problems = [...store.validate(op.type, fields, op.id, { sealed: stored !== 'plain' }), ...((await store.crossChecks?.(this.reader(sp), op.type, op.id, fields, deletedAt !== null)) ?? [])];
    if (problems.length) return invalid(op, problems);

    const cols: Row = store.toColumns(op.type, fields);
    let content: Row;
    if (stored === 'device') {
      content = { c: op.sealed };
      cols.enc = 2;
      cols.key_version = op.key_version;
    } else if (stored === 'keep') {
      content = { c: current!.sealed };
      cols.enc = 2;
      cols.key_version = current!.key_version;
    } else {
      const sealed = await crypto.sealContent(op.type, op.id, cols.content as Row);
      content = sealed.content;
      cols.enc = sealed.enc;
      cols.key_version = sealed.key_version;
    }
    delete cols.content;
    let row: Row;
    if (!current) {
      // A record made offline keeps the time it was made; not before 2000 and not more than a day ahead of the server.
      if (op.created_at && !createdAtOk(op.created_at, now)) return invalid(op, [{ field: 'created_at', code: 'out_of_range' }]);
      const rev = await sp.nextRevs(1);
      const insert: Row = { id: op.id, ...cols, rev, content, deleted_at: deletedAt, client_updated_at: op.client_updated_at ?? null };
      if (op.created_at) insert.created_at = op.created_at;
      [row] = (await sp.insertRows(op.type, [insert])) as [Row];
    } else {
      const rev = await sp.nextRevs(1);
      row = await sp.updateRow(op.type, op.id, {
        ...cols,
        rev,
        content,
        version: current.version + 1,
        updated_at: now,
        deleted_at: deletedAt,
        client_updated_at: op.client_updated_at ?? current.client_updated_at,
      });
    }
    const record = store.toRecord(op.type, await crypto.openRow(op.type, row));
    const result: StoreOpResult<T> = { op_id: op.op_id, status: 'applied', type: op.type, id: op.id, created: !current, record };
    await sp.saveResults([{ op_id: op.op_id, result: await crypto.sealDoc(opAad(op.op_id), result) }]);
    return result;
  }

  /** Many new records (version 1's applyCreates): each checked as applyOp checks a create, written in bulk. */
  private async applyCreates(ops: readonly Op<T>[], now: string): Promise<StoreOpResult<T>[]> {
    const { store, crypto, u } = this;
    const results: (StoreOpResult<T> | undefined)[] = new Array(ops.length);
    const candidates = ops.map((op, i) => ({ op, i }));
    const slow = new Set<number>();

    // Repeats and ids already there take applyOp's path (a duplicate) or answer as it would (a conflict).
    const done = await u.appliedOpIds(candidates.map((c) => c.op.op_id));
    const byType = new Map<T, string[]>();
    for (const c of candidates) byType.set(c.op.type, [...(byType.get(c.op.type) ?? []), c.op.id]);
    const exists = new Map<string, Row>();
    for (const [t, ids] of byType) for (const r of await u.getRows(t, ids)) exists.set(`${t}:${String(r.id)}`, r);
    const seen = new Set<string>();
    for (const c of candidates) {
      const k = `${c.op.type}:${c.op.id}`;
      if (done.has(c.op.op_id) || seen.has(k)) slow.add(c.i);
      else if (exists.has(k)) results[c.i] = { op_id: c.op.op_id, status: 'conflict', type: c.op.type, id: c.op.id, current: store.toRecord(c.op.type, await crypto.openRow(c.op.type, exists.get(k)!)) };
      seen.add(k);
    }
    const vault = candidates.some((c) => store.contentFields(c.op.type).length) ? await crypto.vaultEnabled() : false;

    type Ready = { i: number; op: Op<T>; row: Row };
    const ready: Ready[] = [];
    for (const { op, i } of candidates) {
      if (slow.has(i) || results[i]) continue;
      const changes = op.fields ?? {};
      const shape = store.checkChanges(op.type, changes);
      if (shape.length) { results[i] = invalid(op, shape); continue; }
      const fields = store.normalize(op.type, { ...store.defaults(op.type), ...changes }, now);
      const named = store.contentFields(op.type);
      const changedContent = Object.keys(changes).filter((k) => named.includes(k));
      let device = false;
      if (op.sealed !== undefined) {
        if (changedContent.length) { results[i] = invalid(op, [{ field: changedContent[0]!, code: 'content_outside_sealed' }]); continue; }
        device = true;
      } else if (named.length && vault) { results[i] = invalid(op, [{ field: 'sealed', code: 'sealed_required' }]); continue; }
      const problems = store.validate(op.type, fields, op.id, { sealed: device });
      if (problems.length) { results[i] = invalid(op, problems); continue; }
      if (op.created_at && !createdAtOk(op.created_at, now)) { results[i] = invalid(op, [{ field: 'created_at', code: 'out_of_range' }]); continue; }
      const cols: Row = store.toColumns(op.type, fields);
      let content: Row;
      if (device) {
        content = { c: op.sealed };
        cols.enc = 2;
        cols.key_version = op.key_version;
      } else {
        const sealed = await crypto.sealContent(op.type, op.id, cols.content as Row);
        content = sealed.content;
        cols.enc = sealed.enc;
        cols.key_version = sealed.key_version;
      }
      delete cols.content;
      ready.push({ i, op, row: { id: op.id, ...cols, content, deleted_at: null, client_updated_at: op.client_updated_at ?? null, created_at: op.created_at ?? now, updated_at: now } });
    }

    // Written a type and BULK_ROWS at a time, in a savepoint each: refused, that group goes one by one.
    const groups = new Map<T, Ready[]>();
    for (const r of ready) groups.set(r.op.type, [...(groups.get(r.op.type) ?? []), r]);
    for (const [type, list] of groups) {
      for (let g = 0; g < list.length; g += BULK_ROWS) {
        const part = list.slice(g, g + BULK_ROWS);
        try {
          await u.savepoint(async (sp) => {
            const first = await sp.nextRevs(part.length);
            const written = await sp.insertRows(type, part.map((r, k) => ({ ...r.row, rev: first + BigInt(k) })));
            const byId = new Map(written.map((w) => [String(w.id), w]));
            const kept: { op_id: string; result: unknown }[] = [];
            for (const r of part) {
              const record = store.toRecord(type, await crypto.openRow(type, byId.get(r.op.id)!));
              const result: StoreOpResult<T> = { op_id: r.op.op_id, status: 'applied', type, id: r.op.id, created: true, record };
              results[r.i] = result;
              kept.push({ op_id: r.op.op_id, result: await crypto.sealDoc(opAad(r.op.op_id), result) });
            }
            await sp.saveResults(kept);
          });
        } catch (e) {
          if (!(e instanceof RuleError)) throw e;
          for (const r of part) {
            results[r.i] = undefined;
            slow.add(r.i);
          }
        }
      }
    }
    for (const i of [...slow].sort((a, b) => a - b)) results[i] = await this.applyOp(ops[i]!, now);
    return results as StoreOpResult<T>[];
  }

  /** Many plain deletes (version 1's applyDeletes): tombstoned in bulk, everything else one by one. */
  private async applyDeletes(ops: readonly Op<T>[], now: string): Promise<StoreOpResult<T>[]> {
    const { store, crypto, u } = this;
    const results: (StoreOpResult<T> | undefined)[] = new Array(ops.length);
    const slow = new Set<number>();
    const cands = ops.map((op, i) => ({ op, i }));
    const done = await u.appliedOpIds(cands.map((c) => c.op.op_id));
    const byType = new Map<T, { op: Op<T>; i: number }[]>();
    const seen = new Set<string>();
    for (const c of cands) {
      const k = `${c.op.type}:${c.op.id}`;
      if (done.has(c.op.op_id) || seen.has(k)) slow.add(c.i);
      else byType.set(c.op.type, [...(byType.get(c.op.type) ?? []), c]);
      seen.add(k);
    }
    for (const [type, list] of byType) {
      for (let g = 0; g < list.length; g += BULK_ROWS) {
        const part = list.slice(g, g + BULK_ROWS);
        try {
          await u.savepoint(async (sp) => {
            const rows = await sp.getRows(type, part.map((p) => p.op.id), true);
            const current = new Map(rows.map((r) => [String(r.id), r]));
            const go: { op: Op<T>; i: number }[] = [];
            for (const p of part) {
              const row = current.get(p.op.id);
              if (!row) { results[p.i] = { op_id: p.op.op_id, status: 'not_found', type, id: p.op.id }; continue; }
              if (Number(row.version) !== p.op.base_version) { results[p.i] = { op_id: p.op.op_id, status: 'conflict', type, id: p.op.id, current: store.toRecord(type, await crypto.openRow(type, row)) }; continue; }
              if (row.deleted_at) { slow.add(p.i); continue; }
              const rec = store.toRecord(type, await crypto.openRow(type, row));
              const fields = store.normalize(type, fieldsOf(store, type, rec), now);
              const problems = store.validate(type, fields, p.op.id, { sealed: Number(row.enc) === 2 });
              if (problems.length) { results[p.i] = invalid(p.op, problems); continue; }
              go.push(p);
            }
            if (!go.length) return;
            const first = await sp.nextRevs(go.length);
            const written = await sp.tombstoneRows(type, go.map((p, k) => ({ id: p.op.id, rev: first + BigInt(k), clientUpdatedAt: p.op.client_updated_at ?? null })), now);
            const byId = new Map(written.map((w) => [String(w.id), w]));
            const kept: { op_id: string; result: unknown }[] = [];
            for (const p of go) {
              const record = store.toRecord(type, await crypto.openRow(type, byId.get(p.op.id)!));
              const result: StoreOpResult<T> = { op_id: p.op.op_id, status: 'applied', type, id: p.op.id, created: false, record };
              results[p.i] = result;
              kept.push({ op_id: p.op.op_id, result: await crypto.sealDoc(opAad(p.op.op_id), result) });
            }
            await sp.saveResults(kept);
          });
        } catch (e) {
          if (!(e instanceof RuleError)) throw e;
          for (const p of part) {
            results[p.i] = undefined;
            slow.add(p.i);
          }
        }
      }
    }
    for (const i of [...slow].sort((a, b) => a - b)) if (!results[i]) results[i] = await this.applyOp(ops[i]!, now);
    return results as StoreOpResult<T>[];
  }

  async changes(since: number, limit: number): Promise<ChangesPage<T>> {
    const purged = await this.u.purgedRev();
    // 0 means everything, which is always allowed: it's how a device behind the clean-up catches up.
    if (since > 0 && since < purged) throw new CursorExpired();
    const found = await this.u.changesSince(this.store.types, since, limit + 1);
    const opened = await Promise.all(found.map(async (r) => ({ type: r.type as T, row: await this.crypto.openRow(r.type, r.row) })));
    const items = opened.slice(0, limit).map((r) => ({ type: r.type, record: this.store.toRecord(r.type, r.row) }));
    return { changes: items, next: opened.length > limit ? items[items.length - 1]!.record.rev : null };
  }

  async getPrefs(): Promise<Prefs> {
    const row = await this.u.getPrefs();
    return row ? { data: (await this.crypto.openDoc('prefs', row.data)) as Record<string, unknown>, version: row.version } : { data: {}, version: 0 };
  }

  async putPrefs(data: Record<string, unknown>, baseVersion: number): Promise<PutPrefsResult> {
    const row = await this.u.getPrefs(true);
    const version = row ? row.version : 0;
    if (version !== baseVersion) return { conflict: { data: row ? await this.crypto.openDoc('prefs', row.data) : {}, version } };
    if ((await this.crypto.vaultEnabled()) && !(data.enc === 2 && typeof data.c === 'string')) return { problems: [{ field: 'data', code: 'sealed_required' }] };
    const saved = await this.u.putPrefs(await this.crypto.sealDoc('prefs', data), !!row);
    return { data, version: saved };
  }
}
