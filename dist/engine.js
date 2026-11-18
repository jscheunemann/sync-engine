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
import { RuleError } from "./backend.js";
export { RuleError } from "./backend.js";
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
/** The engine for an app's records on a backend. Make it once; connect per request. */
export function createEngine(opts) {
    const { store, backend } = opts;
    return {
        store,
        connect(settings) {
            const conn = backend.connect(settings, { schema: store.schema, types: store.types });
            return {
                work: (scope, fn, o) => {
                    if (!scope || typeof scope.person !== 'string' || !scope.person)
                        throw new Error('scope_required');
                    const crypto = o?.crypto ?? plain;
                    return conn.unit(scope, async (u) => {
                        const core = new Core(store, crypto, u);
                        await crypto.prepare?.(core.reader(u));
                        return fn(core.work());
                    });
                },
                close: () => conn.close(),
            };
        },
    };
}
const opAad = (opId) => `op|${opId}`;
const invalid = (op, problems) => ({ op_id: op.op_id, status: 'invalid', type: op.type, id: op.id, problems });
const createdAtOk = (createdAt, now) => {
    const t = Date.parse(createdAt);
    return !(t < Date.parse('2000-01-01T00:00:00Z') || t > Date.parse(now) + 86_400_000);
};
/** The fields of a stored record, without the sync columns. */
export function fieldsFrom(store, type, rec) {
    const out = {};
    for (const name of store.fieldNames(type))
        out[name] = rec[name] ?? null;
    return out;
}
/** The rules, on one unit. */
class Core {
    store;
    crypto;
    u;
    constructor(store, crypto, u) {
        this.store = store;
        this.crypto = crypto;
        this.u = u;
    }
    check(type) {
        if (!this.store.isType(type))
            throw new Error('unknown_type');
    }
    reader(u) {
        return {
            get: async (type, id) => {
                this.check(type);
                const row = await u.getRow(type, id);
                return row ? this.store.toRecord(type, await this.crypto.openRow(type, row)) : null;
            },
            getMany: async (type, ids) => {
                this.check(type);
                if (!ids.length)
                    return [];
                const rows = await u.getRows(type, ids);
                return Promise.all(rows.map(async (r) => this.store.toRecord(type, await this.crypto.openRow(type, r))));
            },
        };
    }
    work() {
        const r = this.reader(this.u);
        return {
            get: r.get,
            getMany: r.getMany,
            apply: (ops, now) => this.apply(ops, now ?? new Date().toISOString()),
            changes: (since, limit) => this.changes(since, limit),
            prefs: { get: () => this.getPrefs(), put: (data, base) => this.putPrefs(data, base) },
        };
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
            fields = { ...fieldsFrom(store, op.type, current), ...changes };
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
                            const fields = store.normalize(type, fieldsFrom(store, type, rec), now);
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
