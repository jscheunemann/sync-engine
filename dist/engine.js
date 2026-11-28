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
// The rules are version 1's unchanged (its server.ts, removed at 3.0.0: ADR 0028); the contract tests ran every case against both.
import { isSystem, RuleError } from "./backend.js";
import { conditions, cursor, EngineError, fits, out } from "./declare.js";
import { RecordType } from "./records.js";
export { RuleError, isSystem } from "./backend.js";
export { EngineError } from "./declare.js";
export {} from "./records.js";
function mapStore(store) {
    const byType = new Map(store.types.map((t) => [t, new RecordType(t, store.fields[t] ?? {})]));
    const rt = (t) => byType.get(t);
    return {
        types: store.types,
        isType: (t) => typeof t === 'string' && byType.has(t),
        type: rt,
        fieldNames: (t) => rt(t).names,
        contentFields: (t) => rt(t).content,
        defaults: (t) => ({ ...rt(t).empty(), ...(store.defaults?.(t) ?? {}) }),
        checkChanges: (t, c) => (store.checkChanges ? store.checkChanges(t, c) : rt(t).check(c)),
        normalize: (t, f, now) => (store.normalize ? store.normalize(t, f, now) : { ...f }),
        validate: (t, f, id, o) => store.validate(t, f, id, o),
        ...(store.crossChecks ? { crossChecks: (r, t, id, f, d) => store.crossChecks(r, t, id, f, d) } : {}),
        ...(store.bulkSafe ? { bulkSafe: (t) => store.bulkSafe(t) } : {}),
        toRecord: (t, row) => rt(t).toRecord(row),
        toColumns: (t, f) => rt(t).toColumns(f),
    };
}
export const plain = {
    vaultEnabled: async () => false,
    openRow: async (_type, row) => row,
    sealContent: async (_type, _id, content) => ({ content, enc: 0, key_version: 0 }),
    openDoc: async (_aad, value) => value,
    sealDoc: async (_aad, value) => value,
};
/** The cursor is older than tombstones the server has cleaned up: the device must read everything again (HTTP 410). */
export class CursorExpired extends Error {
    status = 410;
    constructor() {
        super('cursor_expired');
    }
}
/** How many rows one bulk write takes. */
export const BULK_ROWS = 500;
/** How many rows one putMany takes (ADR 0029). */
export const PUT_MANY_MAX = 10_000;
/** Parameters one statement may carry: Postgres allows 65,535; this leaves room. */
const MAX_PARAMS = 30_000;
/** The engine for an app's records on a backend. Make it once; connect per request. */
export function createEngine(opts) {
    const { backend } = opts;
    const store = mapStore(opts.store);
    const types = opts.types ?? {};
    const system = opts.system ?? {};
    for (const name of Object.keys(types))
        if (store.types.includes(name))
            throw new EngineError('type_declared_twice', name);
    for (const [name, d] of Object.entries(system))
        for (const t of [...(d.read ?? []), ...(d.write ?? [])])
            if (!types[t] && !store.isType(t))
                throw new EngineError('unknown_type', `${name}.${t}`);
    checkTypes(types);
    const tables = Object.keys(types);
    // Every table's columns by kind, for the backend to write each value as its kind and, in part 4b, to make the tables.
    const columns = {};
    for (const t of store.types)
        columns[t] = { table: t, kinds: { user_id: 'id', ...store.type(t).columns }, key: ['user_id', 'id'], access: 'record', person: 'user_id' };
    for (const [name, d] of Object.entries(types)) {
        const person = d.access === 'person' ? (d.personColumn ?? 'user_id') : undefined;
        columns[name] = {
            table: d.table ?? name,
            ...(d.view ? { view: d.view === true ? true : { remove: true } } : {}),
            ...(d.writes === 'system' ? { personReads: true } : {}),
            kinds: { ...(person ? { [person]: 'id' } : {}), ...d.fields },
            key: [...(person ? [person] : []), ...d.key],
            access: d.access,
            ...(person ? { person } : {}),
            query: (d.query ?? []).filter((f) => !d.key.includes(f)),
            ...(d.paths ? { paths: d.paths } : {}),
        };
    }
    const layout = { types: store.types, tables, columns, erase: Object.values(system ?? {}).some((d) => d.erase === true) };
    const schema = () => {
        if (!backend.schema)
            throw new EngineError('no_schema_support', backend.kind);
        return backend.schema;
    };
    return {
        store: opts.store,
        plan: (settings) => schema().plan(settings, layout),
        script(settings) {
            const s = schema();
            if (!s.script)
                throw new EngineError('no_schema_support', backend.kind);
            return s.script(settings, layout);
        },
        async migrate(settings, given) {
            const now = await schema().plan(settings, layout);
            if (now.conflicts.length)
                throw new EngineError('schema_conflicts');
            if (JSON.stringify(now.steps) !== JSON.stringify(given.steps))
                throw new EngineError('plan_out_of_date');
            if (now.steps.length)
                await schema().apply(settings, now);
        },
        connect(settings) {
            const conn = backend.connect(settings, layout);
            return {
                work: (scope, fn, o) => {
                    if (isSystem(scope)) {
                        if (!system[scope.system])
                            throw new EngineError('unknown_system_intent', scope.system);
                    }
                    else if (!scope || typeof scope.person !== 'string' || !scope.person)
                        throw new Error('scope_required');
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
const jsonValue = (v) => (v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() : v);
const opAad = (opId) => `op|${opId}`;
const invalid = (op, problems) => ({ op_id: op.op_id, status: 'invalid', type: op.type, id: op.id, problems });
const createdAtOk = (createdAt, now) => {
    const t = Date.parse(createdAt);
    return !(t < Date.parse('2000-01-01T00:00:00Z') || t > Date.parse(now) + 86_400_000);
};
/** The fields of a stored record, without the sync columns (inside the engine, from a mapped store). */
const fieldsOf = (store, type, rec) => Object.fromEntries(store.fieldNames(type).map((n) => [n, rec[n] ?? null]));
/** The fields of a stored record, without the sync columns. */
export function fieldsFrom(store, type, rec) {
    const out = {};
    for (const name of Object.keys(store.fields[type] ?? {}))
        out[name] = rec[name] ?? null;
    return out;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIND_LIMIT = 100;
/** The parts of a date a summary groups by (ADR 0030). */
const DATE_PARTS = ['year', 'quarter', 'month', 'week', 'weekday', 'hour'];
/** An IANA time zone the runtime knows. */
const validZone = (z) => {
    if (typeof z !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(z))
        return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: z });
        return true;
    }
    catch {
        return false;
    }
};
/** The engine's own tables in an app's schema: never an app's declared type. */
const ENGINE_TABLES = ['counters', 'applied_ops', 'prefs', 'engine_audit'];
const FIND_MAX = 1000;
/** Checks an app's declared types once, when the engine is made. */
function checkTypes(types) {
    for (const [name, d] of Object.entries(types)) {
        if (!['person', 'shared', 'system'].includes(d.access))
            throw new EngineError('bad_access', name);
        // A type can't be called after the engine's own tables. Its table may share a name with one if the backend keeps it
        // elsewhere (another schema): the backend checks that, since only it knows where tables are.
        if (ENGINE_TABLES.includes(name))
            throw new EngineError('engine_table', name);
        if (d.writes !== undefined && (d.writes !== 'system' || d.access !== 'person'))
            throw new EngineError('bad_writes', name);
        if (d.view !== undefined && d.view !== true && !(typeof d.view === 'object' && d.view.remove === true && d.access === 'system'))
            throw new EngineError('bad_view', name);
        for (const k of [...d.key, ...(d.query ?? []), ...(d.sealed ?? []), ...(d.version ? [d.version] : [])])
            if (!d.fields[k])
                throw new EngineError('undeclared_field', `${name}.${k}`);
        for (const k of d.sealed ?? [])
            if (d.fields[k] !== 'json')
                throw new EngineError('sealed_not_json', `${name}.${k}`);
        if (d.version && d.fields[d.version] !== 'number')
            throw new EngineError('version_not_number', `${name}.${d.version}`);
        if (d.access === 'person' && d.fields[d.personColumn ?? 'user_id'])
            throw new EngineError('person_column_declared', `${name}.${d.personColumn ?? 'user_id'}`);
        for (const [p, x] of Object.entries(d.paths ?? {})) {
            if (d.fields[p])
                throw new EngineError('path_is_a_field', `${name}.${p}`);
            if (d.fields[x.from] !== 'json')
                throw new EngineError('path_not_in_json', `${name}.${p}`);
            if (!x.path.length || x.path.some((k) => typeof k !== 'string' || !k || k.length > 100))
                throw new EngineError('bad_path', `${name}.${p}`);
            if (!['text', 'number', 'boolean'].includes(x.kind))
                throw new EngineError('bad_path', `${name}.${p}`);
        }
    }
}
/** The rules, on one unit. */
class Core {
    store;
    types;
    crypto;
    u;
    /** The scope's person, or null in a system unit. */
    person;
    intent;
    constructor(store, types, system, scope, crypto, u) {
        this.store = store;
        this.types = types;
        this.crypto = crypto;
        this.u = u;
        if (isSystem(scope)) {
            this.person = null;
            this.intent = { name: scope.system, by: scope.by ?? null, decl: system[scope.system] };
        }
        else {
            this.person = scope.person;
            this.intent = null;
        }
    }
    check(type) {
        if (!this.store.isType(type))
            throw new Error('unknown_type');
    }
    /** Records, prefs and the change feed are one person's: a system unit reaches records only through find and count. */
    personOnly() {
        if (this.person === null)
            throw new EngineError('person_scope_only');
    }
    shape(type) {
        if (this.store.isType(type)) {
            const fields = this.store.type(type).queryable;
            const queryable = new Map(Object.entries(fields).map(([n, k]) => [n, { col: n, kind: k }]));
            if (this.person === null)
                queryable.set('user_id', { col: 'user_id', kind: 'id' });
            return { name: type, table: type, record: true, access: 'person', personColumn: 'user_id', key: ['id'], fields, queryable, ranged: new Map() };
        }
        const d = this.types[type];
        if (!d)
            throw new EngineError('unknown_type', type);
        const queryable = new Map();
        for (const n of [...d.key, ...(d.query ?? [])])
            queryable.set(n, { col: n, kind: d.fields[n] });
        for (const [n, x] of Object.entries(d.paths ?? {}))
            queryable.set(n, { col: n, kind: x.kind });
        // A system unit reaches every person's rows of a person type, so it may filter, order and group by whose they are.
        if (d.access === 'person' && this.person === null)
            queryable.set(d.personColumn ?? 'user_id', { col: d.personColumn ?? 'user_id', kind: 'id' });
        const ranged = new Map();
        for (const [n, k] of Object.entries(d.fields))
            if ((k === 'number' || k === 'integer') && !queryable.has(n) && !(d.sealed ?? []).includes(n))
                ranged.set(n, { col: n, kind: k });
        return { name: type, table: type, record: false, access: d.access, personColumn: d.personColumn ?? 'user_id', key: d.key, fields: d.fields, queryable, ranged, decl: d };
    }
    /** Whether this unit may read or write a type (ADR 0009); the person filter a query takes when it may. */
    allow(sh, write) {
        if (this.intent) {
            const d = this.intent.decl;
            const ok = write ? (d.write ?? []).includes(sh.name) : [...(d.read ?? []), ...(d.write ?? [])].includes(sh.name);
            if (!ok)
                throw new EngineError('not_permitted', sh.name);
            return null;
        }
        if (sh.access === 'system')
            throw new EngineError('system_only', sh.name);
        if (sh.access === 'shared') {
            if (write)
                throw new EngineError('system_only', sh.name);
            return null;
        }
        if (write && sh.decl?.writes === 'system')
            throw new EngineError('system_only', sh.name);
        return this.person;
    }
    async audit(sh, action, rows) {
        if (this.intent)
            await this.u.audit({ intent: this.intent.name, by: this.intent.by, type: sh.name, action, rows });
    }
    aad(sh, field, row) {
        if (sh.decl?.aad)
            return sh.decl.aad(field, row);
        return [sh.name, ...sh.key.map((k) => String(row[k] ?? '')), field].join('|');
    }
    /** A stored row of a declared type as the app gets it: declared fields, by kind, sealed ones opened. */
    async outRow(sh, row) {
        const o = {};
        for (const [n, k] of Object.entries(sh.fields))
            o[n] = out(k, row[n]);
        if (sh.access === 'person' && this.person === null)
            o[sh.personColumn] = out('id', row[sh.personColumn]);
        for (const f of sh.decl?.sealed ?? [])
            if (o[f] !== null)
                o[f] = await this.crypto.openDoc(this.aad(sh, f, o), o[f]);
        return o;
    }
    async find(u, type, opts = {}) {
        const sh = this.shape(type);
        const person = this.allow(sh, false);
        const where = conditions(opts.where, sh.queryable, sh.ranged);
        let order;
        if (opts.order !== undefined) {
            const desc = opts.order.startsWith('-');
            const name = desc ? opts.order.slice(1) : opts.order;
            const f = sh.queryable.get(name);
            if (!f)
                throw new EngineError('not_queryable', name);
            if (!sh.key.includes(name) || sh.key.length > 1)
                order = { col: f.col, desc };
            else if (desc)
                order = { col: f.col, desc };
        }
        const limit = opts.limit ?? FIND_LIMIT;
        if (!Number.isInteger(limit) || limit < 1 || limit > FIND_MAX)
            throw new EngineError('bad_limit');
        const after = opts.after !== undefined ? cursor.read(opts.after) : undefined;
        if (after && after.length !== sh.key.length + (order ? 1 : 0))
            throw new EngineError('bad_cursor');
        const rows = await u.select({ table: sh.table, person, personColumn: sh.personColumn, where, order, key: sh.key, after, limit: limit + 1 });
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        const next = rows.length > limit && last ? cursor.make([...(order ? [jsonValue(last[order.col])] : []), ...sh.key.map((k) => jsonValue(last[k]))]) : null;
        await this.audit(sh, 'find', page.length);
        if (sh.record) {
            const t = type;
            return { rows: await Promise.all(page.map(async (r) => this.store.toRecord(t, await this.crypto.openRow(t, r)))), next };
        }
        return { rows: await Promise.all(page.map((r) => this.outRow(sh, r))), next };
    }
    async count(u, type, opts = {}) {
        const sh = this.shape(type);
        const person = this.allow(sh, false);
        const n = await u.count({ table: sh.table, person, personColumn: sh.personColumn, where: conditions(opts.where, sh.queryable, sh.ranged), key: sh.key });
        await this.audit(sh, 'count', n);
        return n;
    }
    async summarize(u, type, o) {
        const sh = this.shape(type);
        const person = this.allow(sh, false);
        const field = (name) => {
            const f = sh.queryable.get(name);
            if (!f)
                throw new EngineError('not_queryable', name);
            return f;
        };
        const alias = (a) => {
            if (!/^[a-z][a-z0-9_]{0,62}$/i.test(a))
                throw new EngineError('bad_name', a);
            return a;
        };
        const kinds = new Map();
        const by = (o.by ?? []).map((g) => {
            if (typeof g === 'string') {
                const f = field(g);
                kinds.set(g, f.kind);
                return { col: f.col, as: alias(g) };
            }
            if ('part' in g) {
                // a date's part (ADR 0030): a date as it is, a time in its zone
                if (!DATE_PARTS.includes(g.part))
                    throw new EngineError('bad_part', 'part');
                const f = field(g.field);
                if (f.kind !== 'date' && f.kind !== 'time')
                    throw new EngineError('not_a_date', g.field);
                if (f.kind === 'date' && g.zone !== undefined)
                    throw new EngineError('bad_zone', 'zone');
                if (f.kind === 'date' && g.part === 'hour')
                    throw new EngineError('not_a_time', g.field);
                if (f.kind === 'time' && !(typeof g.zone === 'string' && validZone(g.zone)))
                    throw new EngineError('bad_zone', 'zone');
                const as = alias(g.as ?? `${g.field}_${g.part}`);
                kinds.set(as, g.part === 'year' || g.part === 'weekday' || g.part === 'hour' ? 'integer' : 'text');
                return { part: g.part, col: f.col, ...(f.kind === 'time' ? { zone: g.zone } : {}), as };
            }
            const f = field(g.day);
            if (f.kind !== 'time')
                throw new EngineError('not_a_time', g.day);
            if (!validZone(g.zone))
                throw new EngineError('bad_zone', 'zone');
            const as = alias(g.as ?? g.day);
            kinds.set(as, 'day');
            return { day: f.col, zone: g.zone, as };
        });
        if (by.length > 6)
            throw new EngineError('too_many_groups');
        const measures = Object.entries(o.measures ?? {}).map(([as, m]) => {
            alias(as);
            if (kinds.has(as))
                throw new EngineError('name_taken', as);
            const where = conditions(m.where, sh.queryable, sh.ranged);
            const fns = ['count', 'distinct', 'sum', 'avg', 'min', 'max', 'percentile'].filter((k) => k in m);
            if (fns.length !== 1)
                throw new EngineError('bad_measure', as);
            const fn = fns[0];
            if (fn === 'count') {
                if (m.count !== true)
                    throw new EngineError('bad_measure', as);
                kinds.set(as, 'integer');
                return { as, fn, where };
            }
            const name = m[fn];
            // a declared type's number columns can be measured without being query fields (ADR 0031): a measure reads the
            // rows the conditions keep, so it needs no index; order, groups and distinct still need query fields (and
            // conditions on them only bound them, ADR 0032)
            const plain = fn !== 'distinct' && !sh.record && !sh.queryable.has(name) && typeof name === 'string' && Object.hasOwn(sh.fields, name)
                && (sh.fields[name] === 'number' || sh.fields[name] === 'integer');
            const f = plain ? { col: name, kind: sh.fields[name] } : field(name);
            if (['sum', 'avg', 'percentile'].includes(fn) && f.kind !== 'number' && f.kind !== 'integer')
                throw new EngineError('not_a_number', as);
            const p = m.p;
            if (fn === 'percentile' && !(typeof p === 'number' && p > 0 && p <= 1))
                throw new EngineError('bad_measure', as);
            kinds.set(as, fn === 'distinct' ? 'integer' : fn === 'min' || fn === 'max' ? f.kind : 'number');
            return { as, fn, col: f.col, where, ...(fn === 'percentile' ? { p: p } : {}) };
        });
        if (!measures.length || measures.length > 20)
            throw new EngineError('bad_measure');
        let order;
        if (o.order !== undefined) {
            const desc = o.order.startsWith('-');
            const as = desc ? o.order.slice(1) : o.order;
            if (!kinds.has(as))
                throw new EngineError('not_queryable', as);
            order = { as, desc };
        }
        const limit = o.limit ?? FIND_LIMIT;
        if (!Number.isInteger(limit) || limit < 1 || limit > FIND_MAX)
            throw new EngineError('bad_limit');
        const rows = await u.summarize({ table: sh.table, person, personColumn: sh.personColumn, where: conditions(o.where, sh.queryable, sh.ranged), by, measures, ...(order ? { order } : {}), limit });
        await this.audit(sh, 'summarize', rows.length);
        return rows.map((r) => {
            const o = {};
            for (const [k, kind] of kinds) {
                const v = r[k];
                o[k] = kind === 'day' ? (v === null || v === undefined ? null : String(v).slice(0, 10)) : out(kind, v);
            }
            return o;
        });
    }
    async erase(person, keep) {
        if (!this.intent)
            throw new EngineError('system_only', 'erase');
        if (!this.intent.decl.erase)
            throw new EngineError('not_permitted', 'erase');
        if (typeof person !== 'string' || !UUID.test(person))
            throw new EngineError('bad_value', 'person');
        for (const k of keep)
            if (!this.types[k] && !this.store.isType(k))
                throw new EngineError('unknown_type', k);
        const declared = (this.intent.decl.write ?? []).filter((t) => this.types[t]?.access === 'person' && !this.types[t]?.view);
        const types = [...this.store.types, ...declared].filter((t) => !keep.includes(t));
        const removed = await this.u.erase(person.toLowerCase(), types);
        const total = Object.values(removed).reduce((a, n) => a + n, 0);
        // the erased person is named nowhere in the audit, this line included (ADR 0024)
        const by = this.intent.by?.toLowerCase() === person.toLowerCase() ? null : this.intent.by;
        await this.u.audit({ intent: this.intent.name, by, type: '*', action: 'erase', rows: total });
        return removed;
    }
    /** A declared type, for a write: records are written only through apply. */
    writable(type, op) {
        const sh = this.shape(type);
        if (sh.record)
            throw new EngineError('records_use_apply', type);
        if (sh.decl?.view && !(op === 'remove' && sh.decl.view !== true && sh.decl.view.remove))
            throw new EngineError('read_only', type);
        return { sh, person: this.allow(sh, true) };
    }
    /** Columns from what the app gave: declared fields only, each of its kind, sealed ones sealed. */
    async columns(sh, given, keyRow) {
        const c = {};
        for (const [n, v] of Object.entries(given)) {
            const kind = sh.fields[n];
            if (!kind)
                throw new EngineError('unknown_field', n);
            if (v === undefined)
                continue;
            if (!fits(kind, v))
                throw new EngineError('bad_value', n);
            c[n] = (sh.decl?.sealed ?? []).includes(n) && v !== null ? await this.crypto.sealDoc(this.aad(sh, n, { ...keyRow, ...given }), v) : v;
        }
        return c;
    }
    keyMatch(sh, key, person) {
        // A system unit names the person of a person type's row in its key; a person unit's person is its own.
        const names = Object.keys(key).filter((k) => !(sh.access === 'person' && person === null && k === sh.personColumn));
        if (names.length !== sh.key.length || !sh.key.every((k) => names.includes(k)))
            throw new EngineError('bad_key', sh.name);
        const m = sh.key.map((k) => {
            if (!fits(sh.fields[k], key[k]) || key[k] === null)
                throw new EngineError('bad_value', k);
            return { col: k, op: 'eq', value: key[k] };
        });
        if (sh.access === 'person') {
            const who = person ?? key[sh.personColumn];
            if (person === null && (typeof who !== 'string' || !who))
                throw new EngineError('person_required', sh.personColumn);
            m.push({ col: sh.personColumn, op: 'eq', value: who });
        }
        return m;
    }
    refused(e) {
        if (e instanceof RuleError)
            throw new EngineError(e.kind === 'reference' ? 'reference' : 'refused', e.rule || undefined);
        throw e;
    }
    /** A put's columns: the person's column checked (or named, in a system unit), declared fields of their kind, the version's first. */
    async putColumns(sh, person, given) {
        const row = { ...given };
        let who = person;
        if (sh.access === 'person') {
            if (person === null) {
                who = row[sh.personColumn];
                if (typeof who !== 'string' || !who)
                    throw new EngineError('person_required', sh.personColumn);
            }
            else if (row[sh.personColumn] !== undefined && row[sh.personColumn] !== person)
                throw new EngineError('not_yours', sh.personColumn);
            delete row[sh.personColumn];
        }
        const c = await this.columns(sh, row, row);
        if (sh.decl?.version && c[sh.decl.version] === undefined)
            c[sh.decl.version] = 1;
        if (sh.access === 'person')
            c[sh.personColumn] = who;
        return c;
    }
    onConflictOf(sh, onConflict) {
        if (onConflict === undefined)
            return undefined;
        if (onConflict !== 'update' && onConflict !== 'nothing')
            throw new EngineError('bad_on_conflict');
        return { key: [...(sh.access === 'person' ? [sh.personColumn] : []), ...sh.key], action: onConflict };
    }
    async put(type, given, opts = {}) {
        const { sh, person } = this.writable(type, 'put');
        const c = await this.putColumns(sh, person, given);
        try {
            const conflict = this.onConflictOf(sh, opts.onConflict);
            const stored = await this.u.savepoint((sp) => sp.insert(sh.table, c, conflict));
            await this.audit(sh, 'put', stored ? 1 : 0);
            return stored ? this.outRow(sh, stored) : null;
        }
        catch (e) {
            this.refused(e);
        }
    }
    async putMany(type, given, opts = {}) {
        const { sh, person } = this.writable(type, 'put');
        const conflict = this.onConflictOf(sh, opts.onConflict);
        if (!Array.isArray(given))
            throw new EngineError('bad_rows');
        if (given.length > PUT_MANY_MAX)
            throw new EngineError('too_many_rows');
        // One row a key (a statement can't write a key twice): with update the later fields go over the earlier ones, with
        // nothing the first stays. Without onConflict every row goes in, and a repeated key is refused, as a second put is.
        const rows = [];
        const byKey = new Map();
        for (const g of given) {
            if (!g || typeof g !== 'object' || Array.isArray(g))
                throw new EngineError('bad_rows');
            const c = await this.putColumns(sh, person, g);
            if (!conflict) {
                rows.push(c);
                continue;
            }
            const k = JSON.stringify(conflict.key.map((n) => c[n] ?? null));
            const at = byKey.get(k);
            if (at === undefined) {
                byKey.set(k, rows.length);
                rows.push(c);
            }
            else if (conflict.action === 'update')
                rows[at] = { ...rows[at], ...c };
        }
        // Rows with the same columns go together, so an upsert updates only what each row gave.
        const groups = new Map();
        for (const r of rows) {
            const names = Object.keys(r).sort().join(',');
            const g = groups.get(names);
            if (g)
                g.push(r);
            else
                groups.set(names, [r]);
        }
        try {
            const n = rows.length
                ? await this.u.savepoint(async (sp) => {
                    let written = 0;
                    for (const [names, list] of groups) {
                        const size = Math.max(1, Math.min(BULK_ROWS, Math.floor(MAX_PARAMS / names.split(',').length)));
                        for (let i = 0; i < list.length; i += size)
                            written += await sp.insertMany(sh.table, list.slice(i, i + size), conflict);
                    }
                    return written;
                })
                : 0;
            await this.audit(sh, 'put', n);
            return n;
        }
        catch (e) {
            this.refused(e);
        }
    }
    async update(type, key, changes, version) {
        const { sh, person } = this.writable(type, 'update');
        const match = this.keyMatch(sh, key, person);
        const keyRow = Object.fromEntries(sh.key.map((k) => [k, key[k]]));
        for (const k of [...sh.key, sh.personColumn])
            if (k in changes)
                throw new EngineError('key_field', k);
        const vcol = sh.decl?.version;
        if (vcol && vcol in changes)
            throw new EngineError('key_field', vcol);
        if (vcol && (typeof version !== 'number' || !Number.isInteger(version)))
            throw new EngineError('version_required', vcol);
        const c = await this.columns(sh, changes, keyRow);
        if (vcol)
            c[vcol] = version + 1;
        const guarded = vcol ? [...match, { col: vcol, op: 'eq', value: version }] : match;
        let row;
        try {
            row = await this.u.savepoint((sp) => sp.update(sh.table, guarded, c));
        }
        catch (e) {
            this.refused(e);
        }
        await this.audit(sh, 'update', row ? 1 : 0);
        if (row)
            return { status: 'applied', row: await this.outRow(sh, row) };
        if (!vcol)
            return { status: 'not_found' };
        const [current] = await this.u.select({ table: sh.table, person: null, personColumn: sh.personColumn, where: match, key: sh.key, limit: 1 });
        return current ? { status: 'conflict', current: await this.outRow(sh, current) } : { status: 'not_found' };
    }
    async remove(type, key) {
        const { sh, person } = this.writable(type, 'remove');
        const match = this.keyMatch(sh, key, person);
        let n;
        try {
            n = await this.u.savepoint((sp) => sp.remove(sh.table, match));
        }
        catch (e) {
            this.refused(e);
        }
        await this.audit(sh, 'remove', n);
        return n > 0;
    }
    async removeWhere(type, where) {
        if (!this.intent)
            throw new EngineError('system_only', 'removeWhere');
        const { sh } = this.writable(type, 'remove');
        if (sh.access !== 'system')
            throw new EngineError('system_type_only', type);
        const match = conditions(where, sh.queryable);
        if (!match.length)
            throw new EngineError('where_required', type);
        let n;
        try {
            n = await this.u.savepoint((sp) => sp.remove(sh.table, match));
        }
        catch (e) {
            this.refused(e);
        }
        await this.audit(sh, 'remove', n);
        return n;
    }
    reader(u) {
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
                if (!ids.length)
                    return [];
                const rows = await u.getRows(type, ids);
                return Promise.all(rows.map(async (r) => this.store.toRecord(type, await this.crypto.openRow(type, r))));
            },
            find: ((type, opts) => this.find(u, type, opts)),
            count: (type, opts) => this.count(u, type, opts),
            summarize: (type, opts) => this.summarize(u, type, opts),
        };
    }
    work() {
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
            putMany: (type, rows, opts) => this.putMany(type, rows, opts),
            erase: (person, opts) => this.erase(person, opts?.keep ?? []),
            lock: async (name) => {
                if (typeof name !== 'string' || !name || name.length > 200)
                    throw new EngineError('bad_lock');
                await this.u.lock(name);
            },
            update: (type, key, changes, version) => this.update(type, key, changes, version),
            remove: (type, key) => this.remove(type, key),
            removeWhere: (type, where) => this.removeWhere(type, where),
            hold: async (person) => {
                if (!this.intent)
                    throw new EngineError('system_only', 'hold');
                if (typeof person !== 'string' || !UUID.test(person))
                    throw new EngineError('bad_value', 'person');
                await this.u.hold(person.toLowerCase());
            },
            attempt: (fn) => this.u.savepoint((sp) => fn(this.on(sp).work())),
            sealPlain: (max) => (p(), this.sealPlain(max)),
        };
    }
    async sealPlain(max) {
        if (!Number.isInteger(max) || max < 1 || max > FIND_MAX)
            throw new EngineError('bad_limit', 'max');
        let done = 0;
        for (const type of this.store.types) {
            if (done >= max)
                break;
            for (const row of await this.u.plainRows(type, max - done)) {
                const sealed = await this.crypto.sealContent(type, String(row.id), (row.content ?? {}));
                if (sealed.enc === 0)
                    return done; // this crypto keeps content plain
                await this.u.updateRow(type, String(row.id), { content: sealed.content, enc: sealed.enc, key_version: sealed.key_version });
                done++;
            }
        }
        return done;
    }
    /** The same unit's intents on a savepoint of it (attempt). */
    on(u) {
        return Object.assign(Object.create(Core.prototype), this, { u });
    }
    async record(u, type, id, lock) {
        const row = await u.getRow(type, id, lock);
        return row ? this.store.toRecord(type, await this.crypto.openRow(type, row)) : null;
    }
    bulkType(t) {
        return this.store.bulkSafe ? this.store.bulkSafe(t) : !this.store.crossChecks;
    }
    async apply(ops, now) {
        for (const op of ops)
            this.check(op.type);
        const isCreate = (op) => op.base_version === null && op.delete === undefined;
        const plainDelete = (op) => op.delete === true && op.base_version !== null && !Object.keys(op.fields ?? {}).length && op.sealed === undefined;
        if (ops.length > 1 && ops.every((op) => isCreate(op) && this.bulkType(op.type)))
            return this.applyCreates(ops, now);
        if (ops.length > 1 && ops.every(plainDelete))
            return this.applyDeletes(ops, now);
        const out = [];
        for (const op of ops)
            out.push(await this.applyOp(op, now));
        return out;
    }
    /** One op, in its own savepoint (version 1's applyOp). */
    async applyOp(op, now) {
        const done = await this.u.appliedResult(op.op_id);
        if (done !== undefined)
            return { ...(await this.crypto.openDoc(opAad(op.op_id), done)), status: 'duplicate' };
        const changes = op.fields ?? {};
        const shapeProblems = this.store.checkChanges(op.type, changes);
        if (shapeProblems.length)
            return invalid(op, shapeProblems);
        try {
            return await this.u.savepoint((sp) => this.applyIn(sp, op, changes, now));
        }
        catch (e) {
            // A database rule caught something the app's rules didn't (a check): report it on the op, keep the others going.
            if (e instanceof RuleError && e.kind === 'rule')
                return invalid(op, [{ field: e.rule || 'record', code: 'db_rule' }]);
            throw e;
        }
    }
    async applyIn(sp, op, changes, now) {
        const { store, crypto } = this;
        const current = await this.record(sp, op.type, op.id, true);
        let fields;
        let deletedAt;
        if (!current) {
            if (op.base_version !== null)
                return { op_id: op.op_id, status: 'not_found', type: op.type, id: op.id };
            fields = { ...store.defaults(op.type), ...changes };
            deletedAt = op.delete === true ? now : null;
        }
        else {
            if (op.base_version === null || op.base_version !== current.version)
                return { op_id: op.op_id, status: 'conflict', type: op.type, id: op.id, current };
            fields = { ...fieldsOf(store, op.type, current), ...changes };
            deletedAt = op.delete === true ? (current.deleted_at ?? now) : op.delete === false ? null : current.deleted_at;
        }
        fields = store.normalize(op.type, fields, now);
        // Where the content comes from: the device's ciphertext, the stored ciphertext kept as it is, or plaintext the
        // server stores (encrypting it at rest when the app does).
        const named = store.contentFields(op.type);
        const changedContent = Object.keys(changes).filter((k) => named.includes(k));
        let stored;
        if (op.sealed !== undefined) {
            if (changedContent.length)
                return invalid(op, [{ field: changedContent[0], code: 'content_outside_sealed' }]);
            stored = 'device';
        }
        else if (named.length && (changedContent.length || !current) && (await crypto.vaultEnabled())) {
            return invalid(op, [{ field: 'sealed', code: 'sealed_required' }]);
        }
        else if (current?.enc === 2) {
            if (!changedContent.length)
                stored = 'keep';
            else if (named.every((k) => k in changes))
                stored = 'plain'; // the whole content in plaintext: encryption was turned off
            else
                return invalid(op, [{ field: changedContent[0], code: 'sealed_record' }]);
        }
        else
            stored = 'plain';
        const problems = [...store.validate(op.type, fields, op.id, { sealed: stored !== 'plain' }), ...((await store.crossChecks?.(this.reader(sp), op.type, op.id, fields, deletedAt !== null)) ?? [])];
        if (problems.length)
            return invalid(op, problems);
        const cols = store.toColumns(op.type, fields);
        let content;
        if (stored === 'device') {
            content = { c: op.sealed };
            cols.enc = 2;
            cols.key_version = op.key_version;
        }
        else if (stored === 'keep') {
            content = { c: current.sealed };
            cols.enc = 2;
            cols.key_version = current.key_version;
        }
        else {
            const sealed = await crypto.sealContent(op.type, op.id, cols.content);
            content = sealed.content;
            cols.enc = sealed.enc;
            cols.key_version = sealed.key_version;
        }
        delete cols.content;
        let row;
        if (!current) {
            // A record made offline keeps the time it was made; not before 2000 and not more than a day ahead of the server.
            if (op.created_at && !createdAtOk(op.created_at, now))
                return invalid(op, [{ field: 'created_at', code: 'out_of_range' }]);
            const rev = await sp.nextRevs(1);
            const insert = { id: op.id, ...cols, rev, content, deleted_at: deletedAt, client_updated_at: op.client_updated_at ?? null };
            if (op.created_at)
                insert.created_at = op.created_at;
            [row] = (await sp.insertRows(op.type, [insert]));
        }
        else {
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
        const result = { op_id: op.op_id, status: 'applied', type: op.type, id: op.id, created: !current, record };
        await sp.saveResults([{ op_id: op.op_id, result: await crypto.sealDoc(opAad(op.op_id), result) }]);
        return result;
    }
    /** Many new records (version 1's applyCreates): each checked as applyOp checks a create, written in bulk. */
    async applyCreates(ops, now) {
        const { store, crypto, u } = this;
        const results = new Array(ops.length);
        const candidates = ops.map((op, i) => ({ op, i }));
        const slow = new Set();
        // Repeats and ids already there take applyOp's path (a duplicate) or answer as it would (a conflict).
        const done = await u.appliedOpIds(candidates.map((c) => c.op.op_id));
        const byType = new Map();
        for (const c of candidates)
            byType.set(c.op.type, [...(byType.get(c.op.type) ?? []), c.op.id]);
        const exists = new Map();
        for (const [t, ids] of byType)
            for (const r of await u.getRows(t, ids))
                exists.set(`${t}:${String(r.id)}`, r);
        const seen = new Set();
        for (const c of candidates) {
            const k = `${c.op.type}:${c.op.id}`;
            if (done.has(c.op.op_id) || seen.has(k))
                slow.add(c.i);
            else if (exists.has(k))
                results[c.i] = { op_id: c.op.op_id, status: 'conflict', type: c.op.type, id: c.op.id, current: store.toRecord(c.op.type, await crypto.openRow(c.op.type, exists.get(k))) };
            seen.add(k);
        }
        const vault = candidates.some((c) => store.contentFields(c.op.type).length) ? await crypto.vaultEnabled() : false;
        const ready = [];
        for (const { op, i } of candidates) {
            if (slow.has(i) || results[i])
                continue;
            const changes = op.fields ?? {};
            const shape = store.checkChanges(op.type, changes);
            if (shape.length) {
                results[i] = invalid(op, shape);
                continue;
            }
            const fields = store.normalize(op.type, { ...store.defaults(op.type), ...changes }, now);
            const named = store.contentFields(op.type);
            const changedContent = Object.keys(changes).filter((k) => named.includes(k));
            let device = false;
            if (op.sealed !== undefined) {
                if (changedContent.length) {
                    results[i] = invalid(op, [{ field: changedContent[0], code: 'content_outside_sealed' }]);
                    continue;
                }
                device = true;
            }
            else if (named.length && vault) {
                results[i] = invalid(op, [{ field: 'sealed', code: 'sealed_required' }]);
                continue;
            }
            const problems = store.validate(op.type, fields, op.id, { sealed: device });
            if (problems.length) {
                results[i] = invalid(op, problems);
                continue;
            }
            if (op.created_at && !createdAtOk(op.created_at, now)) {
                results[i] = invalid(op, [{ field: 'created_at', code: 'out_of_range' }]);
                continue;
            }
            const cols = store.toColumns(op.type, fields);
            let content;
            if (device) {
                content = { c: op.sealed };
                cols.enc = 2;
                cols.key_version = op.key_version;
            }
            else {
                const sealed = await crypto.sealContent(op.type, op.id, cols.content);
                content = sealed.content;
                cols.enc = sealed.enc;
                cols.key_version = sealed.key_version;
            }
            delete cols.content;
            ready.push({ i, op, row: { id: op.id, ...cols, content, deleted_at: null, client_updated_at: op.client_updated_at ?? null, created_at: op.created_at ?? now, updated_at: now } });
        }
        // Written a type and BULK_ROWS at a time, in a savepoint each: refused, that group goes one by one.
        const groups = new Map();
        for (const r of ready)
            groups.set(r.op.type, [...(groups.get(r.op.type) ?? []), r]);
        for (const [type, list] of groups) {
            for (let g = 0; g < list.length; g += BULK_ROWS) {
                const part = list.slice(g, g + BULK_ROWS);
                try {
                    await u.savepoint(async (sp) => {
                        const first = await sp.nextRevs(part.length);
                        const written = await sp.insertRows(type, part.map((r, k) => ({ ...r.row, rev: first + BigInt(k) })));
                        const byId = new Map(written.map((w) => [String(w.id), w]));
                        const kept = [];
                        for (const r of part) {
                            const record = store.toRecord(type, await crypto.openRow(type, byId.get(r.op.id)));
                            const result = { op_id: r.op.op_id, status: 'applied', type, id: r.op.id, created: true, record };
                            results[r.i] = result;
                            kept.push({ op_id: r.op.op_id, result: await crypto.sealDoc(opAad(r.op.op_id), result) });
                        }
                        await sp.saveResults(kept);
                    });
                }
                catch (e) {
                    if (!(e instanceof RuleError))
                        throw e;
                    for (const r of part) {
                        results[r.i] = undefined;
                        slow.add(r.i);
                    }
                }
            }
        }
        for (const i of [...slow].sort((a, b) => a - b))
            results[i] = await this.applyOp(ops[i], now);
        return results;
    }
    /** Many plain deletes (version 1's applyDeletes): tombstoned in bulk, everything else one by one. */
    async applyDeletes(ops, now) {
        const { store, crypto, u } = this;
        const results = new Array(ops.length);
        const slow = new Set();
        const cands = ops.map((op, i) => ({ op, i }));
        const done = await u.appliedOpIds(cands.map((c) => c.op.op_id));
        const byType = new Map();
        const seen = new Set();
        for (const c of cands) {
            const k = `${c.op.type}:${c.op.id}`;
            if (done.has(c.op.op_id) || seen.has(k))
                slow.add(c.i);
            else
                byType.set(c.op.type, [...(byType.get(c.op.type) ?? []), c]);
            seen.add(k);
        }
        for (const [type, list] of byType) {
            for (let g = 0; g < list.length; g += BULK_ROWS) {
                const part = list.slice(g, g + BULK_ROWS);
                try {
                    await u.savepoint(async (sp) => {
                        const rows = await sp.getRows(type, part.map((p) => p.op.id), true);
                        const current = new Map(rows.map((r) => [String(r.id), r]));
                        const go = [];
                        for (const p of part) {
                            const row = current.get(p.op.id);
                            if (!row) {
                                results[p.i] = { op_id: p.op.op_id, status: 'not_found', type, id: p.op.id };
                                continue;
                            }
                            if (Number(row.version) !== p.op.base_version) {
                                results[p.i] = { op_id: p.op.op_id, status: 'conflict', type, id: p.op.id, current: store.toRecord(type, await crypto.openRow(type, row)) };
                                continue;
                            }
                            if (row.deleted_at) {
                                slow.add(p.i);
                                continue;
                            }
                            const rec = store.toRecord(type, await crypto.openRow(type, row));
                            const fields = store.normalize(type, fieldsOf(store, type, rec), now);
                            const problems = store.validate(type, fields, p.op.id, { sealed: Number(row.enc) === 2 });
                            if (problems.length) {
                                results[p.i] = invalid(p.op, problems);
                                continue;
                            }
                            go.push(p);
                        }
                        if (!go.length)
                            return;
                        const first = await sp.nextRevs(go.length);
                        const written = await sp.tombstoneRows(type, go.map((p, k) => ({ id: p.op.id, rev: first + BigInt(k), clientUpdatedAt: p.op.client_updated_at ?? null })), now);
                        const byId = new Map(written.map((w) => [String(w.id), w]));
                        const kept = [];
                        for (const p of go) {
                            const record = store.toRecord(type, await crypto.openRow(type, byId.get(p.op.id)));
                            const result = { op_id: p.op.op_id, status: 'applied', type, id: p.op.id, created: false, record };
                            results[p.i] = result;
                            kept.push({ op_id: p.op.op_id, result: await crypto.sealDoc(opAad(p.op.op_id), result) });
                        }
                        await sp.saveResults(kept);
                    });
                }
                catch (e) {
                    if (!(e instanceof RuleError))
                        throw e;
                    for (const p of part) {
                        results[p.i] = undefined;
                        slow.add(p.i);
                    }
                }
            }
        }
        for (const i of [...slow].sort((a, b) => a - b))
            if (!results[i])
                results[i] = await this.applyOp(ops[i], now);
        return results;
    }
    async changes(since, limit) {
        const purged = await this.u.purgedRev();
        // 0 means everything, which is always allowed: it's how a device behind the clean-up catches up.
        if (since > 0 && since < purged)
            throw new CursorExpired();
        const found = await this.u.changesSince(this.store.types, since, limit + 1);
        const opened = await Promise.all(found.map(async (r) => ({ type: r.type, row: await this.crypto.openRow(r.type, r.row) })));
        const items = opened.slice(0, limit).map((r) => ({ type: r.type, record: this.store.toRecord(r.type, r.row) }));
        return { changes: items, next: opened.length > limit ? items[items.length - 1].record.rev : null };
    }
    async getPrefs() {
        const row = await this.u.getPrefs();
        return row ? { data: (await this.crypto.openDoc('prefs', row.data)), version: row.version } : { data: {}, version: 0 };
    }
    async putPrefs(data, baseVersion) {
        const row = await this.u.getPrefs(true);
        const version = row ? row.version : 0;
        if (version !== baseVersion)
            return { conflict: { data: row ? await this.crypto.openDoc('prefs', row.data) : {}, version } };
        if ((await this.crypto.vaultEnabled()) && !(data.enc === 2 && typeof data.c === 'string'))
            return { problems: [{ field: 'data', code: 'sealed_required' }] };
        const saved = await this.u.putPrefs(await this.crypto.sealDoc('prefs', data), !!row);
        return { data, version: saved };
    }
}
