// The server side of sync, for Postgres (the `postgres` package): applying one op with optimistic concurrency and
// idempotency, the change feed, and the prefs document. An app describes its records once (`RecordStore`) and every
// write path in it (its sync route, its REST routes, its MCP tools) goes through `applyOp`, so they can never disagree.
//
// Tables an app needs, in one schema (`store.schema`), with row-level security keyed to the person (see README.md):
//   * a table per record type: (user_id, id) key, rev, version, created_at, updated_at, client_updated_at,
//     deleted_at, content jsonb, enc, key_version, and the app's own columns;
//   * counters (user_id, rev, purged_rev) and next_rev(), which numbers every change for the person;
//   * applied_ops (user_id, op_id, result, created_at), the idempotency log;
//   * prefs (user_id, data, version, updated_at).
export const plain = {
    prepare: async () => { },
    vaultEnabled: async () => false,
    openRow: async (_db, _type, row) => row,
    sealContent: async (_db, _type, _id, content) => ({ content, enc: 0, key_version: 0 }),
    openDoc: async (_db, _aad, value) => value,
    sealDoc: async (_db, _aad, value) => value,
};
const ident = (db, schema, name) => db `${db(schema)}.${db(name)}`;
/** The fields of a stored record, without the sync columns. */
export function fieldsFrom(store, type, rec) {
    const out = {};
    for (const name of store.fieldNames(type))
        out[name] = rec[name] ?? null;
    return out;
}
export async function getRecord(db, store, crypto, type, id, lock = false) {
    const table = ident(db, store.schema, type);
    const rows = lock ? await db `select * from ${table} where id = ${id} for update` : await db `select * from ${table} where id = ${id}`;
    return rows[0] ? store.toRecord(type, await crypto.openRow(db, type, rows[0])) : null;
}
const opAad = (opId) => `op|${opId}`;
/**
 * Applies one op inside the caller's transaction (in its own savepoint, so a failed op leaves the others alone).
 *   * base_version null: create; a record with that id already existing is a conflict.
 *   * base_version n: change or delete; the stored version must be n, otherwise a conflict with the current record.
 *   * delete true tombstones; delete false brings a tombstone back.
 * Every applied result is stored by op_id; repeating the op returns it as a duplicate.
 */
export async function applyOp(tx, store, crypto, op, now) {
    await crypto.prepare(tx);
    const done = await tx `select result from ${ident(tx, store.schema, 'applied_ops')} where op_id = ${op.op_id}`;
    if (done[0])
        return { ...(await crypto.openDoc(tx, opAad(op.op_id), done[0].result)), status: 'duplicate' };
    const changes = op.fields ?? {};
    const shapeProblems = store.checkChanges(op.type, changes);
    if (shapeProblems.length)
        return { op_id: op.op_id, status: 'invalid', type: op.type, id: op.id, problems: shapeProblems };
    try {
        return await applyInSavepoint(tx, store, crypto, op, changes, now);
    }
    catch (e) {
        // A database rule caught something the app's rules didn't (a check constraint): report it on the op, keep the
        // others going.
        const code = e?.code ?? '';
        if (code.startsWith('23') && code !== '23503') {
            return { op_id: op.op_id, status: 'invalid', type: op.type, id: op.id, problems: [{ field: e.constraint_name ?? 'record', code: 'db_rule' }] };
        }
        throw e;
    }
}
const invalid = (op, problems) => ({ op_id: op.op_id, status: 'invalid', type: op.type, id: op.id, problems });
async function applyInSavepoint(tx, store, crypto, op, changes, now) {
    return (await tx.savepoint(async (sp) => {
        const current = await getRecord(sp, store, crypto, op.type, op.id, true);
        let fields;
        let deletedAt;
        if (!current) {
            if (op.base_version !== null)
                return { op_id: op.op_id, status: 'not_found', type: op.type, id: op.id };
            fields = { ...store.defaults(op.type), ...changes };
            deletedAt = op.delete === true ? now : null;
        }
        else {
            if (op.base_version === null || op.base_version !== current.version) {
                return { op_id: op.op_id, status: 'conflict', type: op.type, id: op.id, current };
            }
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
        else if (named.length && (changedContent.length || !current) && (await crypto.vaultEnabled(sp))) {
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
        const problems = [...store.validate(op.type, fields, op.id, { sealed: stored !== 'plain' }), ...((await store.crossChecks?.(sp, op.type, op.id, fields, deletedAt !== null)) ?? [])];
        if (problems.length)
            return { op_id: op.op_id, status: 'invalid', type: op.type, id: op.id, problems };
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
            const sealed = await crypto.sealContent(sp, op.type, op.id, cols.content);
            content = sealed.content;
            cols.enc = sealed.enc;
            cols.key_version = sealed.key_version;
        }
        delete cols.content;
        const [{ rev }] = (await sp `select ${sp(store.schema)}.next_rev() as rev`);
        const table = ident(sp, store.schema, op.type);
        let row;
        if (!current) {
            const insert = { id: op.id, ...cols, rev, content: sp.json(content), deleted_at: deletedAt, client_updated_at: op.client_updated_at };
            // A record made offline keeps the time it was made; not before 2000 and not more than a day ahead of the server.
            if (op.created_at) {
                const t = Date.parse(op.created_at);
                if (t < Date.parse('2000-01-01T00:00:00Z') || t > Date.parse(now) + 86_400_000) {
                    return { op_id: op.op_id, status: 'invalid', type: op.type, id: op.id, problems: [{ field: 'created_at', code: 'out_of_range' }] };
                }
                insert.created_at = op.created_at;
            }
            [row] = await sp `insert into ${table} ${sp(insert)} returning *`;
        }
        else {
            const update = {
                ...cols,
                rev,
                content: sp.json(content),
                version: current.version + 1,
                updated_at: now,
                deleted_at: deletedAt,
                client_updated_at: op.client_updated_at ?? current.client_updated_at,
            };
            [row] = await sp `update ${table} set ${sp(update)} where id = ${op.id} returning *`;
        }
        const record = store.toRecord(op.type, await crypto.openRow(sp, op.type, row));
        const result = { op_id: op.op_id, status: 'applied', type: op.type, id: op.id, created: !current, record };
        await sp `insert into ${ident(sp, store.schema, 'applied_ops')} (op_id, result) values (${op.op_id}, ${sp.json((await crypto.sealDoc(sp, opAad(op.op_id), result)))})`;
        return result;
    }));
}
/** How many rows one bulk insert writes (well inside Postgres's 65,535 parameters). */
export const BULK_ROWS = 500;
/**
 * Applies many ops at once, for a restore (1.2.0): new records (base_version null, no delete) whose ids and op ids
 * aren't known yet are checked one by one exactly as applyOp checks a create (shape, defaults, normalize, sealed or
 * plain content, validate, created_at range) and then written with one insert per type and BULK_ROWS, their revs
 * taken as one block, and every result kept in applied_ops as applyOp keeps it. Anything else (a change, a delete, a
 * repeat, an id that exists, a type that isn't bulkSafe) goes through applyOp, so the outcome for every op is what
 * applyOp would have given. A database rule refusing a bulk insert sends that group through applyOp instead, which
 * reports each op on its own. Results come back in the order of `ops`. Run it inside the person's transaction.
 */
export async function applyCreates(tx, store, crypto, ops, now) {
    await crypto.prepare(tx);
    const results = new Array(ops.length);
    const isCreate = (op) => op.base_version === null && op.delete === undefined;
    const bulkType = (t) => (store.bulkSafe ? store.bulkSafe(t) : !store.crossChecks);
    const candidates = ops.map((op, i) => ({ op, i })).filter(({ op }) => isCreate(op) && bulkType(op.type));
    const slow = new Set(ops.map((_, i) => i).filter((i) => !candidates.some((c) => c.i === i)));
    // Repeats and ids already there take applyOp's path (a duplicate, or a conflict).
    if (candidates.length) {
        const opIds = candidates.map((c) => c.op.op_id);
        const done = new Set((await tx `select op_id from ${ident(tx, store.schema, 'applied_ops')} where op_id in ${tx(opIds)}`).map((r) => String(r.op_id)));
        const byType = new Map();
        for (const c of candidates)
            byType.set(c.op.type, [...(byType.get(c.op.type) ?? []), c.op.id]);
        // An id that's already there is a conflict with its current copy, as applyOp answers a create of it (1.3.1): read
        // in one query per type, not one op at a time, so a restore sent again after a reload stays fast.
        const exists = new Map();
        for (const [t, ids] of byType)
            for (const r of await tx `select * from ${ident(tx, store.schema, t)} where id in ${tx(ids)}`)
                exists.set(`${t}:${String(r.id)}`, r);
        const seen = new Set();
        for (const c of candidates) {
            const k = `${c.op.type}:${c.op.id}`;
            if (done.has(c.op.op_id) || seen.has(k))
                slow.add(c.i);
            else if (exists.has(k))
                results[c.i] = { op_id: c.op.op_id, status: 'conflict', type: c.op.type, id: c.op.id, current: store.toRecord(c.op.type, await crypto.openRow(tx, c.op.type, exists.get(k))) };
            seen.add(k);
        }
    }
    const vault = candidates.some((c) => store.contentFields(c.op.type).length) ? await crypto.vaultEnabled(tx) : false;
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
        let createdAt;
        if (op.created_at) {
            const t = Date.parse(op.created_at);
            if (t < Date.parse('2000-01-01T00:00:00Z') || t > Date.parse(now) + 86_400_000) {
                results[i] = invalid(op, [{ field: 'created_at', code: 'out_of_range' }]);
                continue;
            }
            createdAt = op.created_at;
        }
        const cols = store.toColumns(op.type, fields);
        let content;
        if (device) {
            content = { c: op.sealed };
            cols.enc = 2;
            cols.key_version = op.key_version;
        }
        else {
            const sealed = await crypto.sealContent(tx, op.type, op.id, cols.content);
            content = sealed.content;
            cols.enc = sealed.enc;
            cols.key_version = sealed.key_version;
        }
        delete cols.content;
        ready.push({ i, op, row: { id: op.id, ...cols, deleted_at: null, client_updated_at: op.client_updated_at ?? null, created_at: createdAt ?? now, updated_at: now }, content });
    }
    // Written a type and BULK_ROWS at a time, in a savepoint each: refused, that group goes one by one.
    const groups = new Map();
    for (const r of ready)
        groups.set(r.op.type, [...(groups.get(r.op.type) ?? []), r]);
    for (const [type, list] of groups) {
        for (let g = 0; g < list.length; g += BULK_ROWS) {
            const part = list.slice(g, g + BULK_ROWS);
            try {
                await tx.savepoint(async (sp) => {
                    // One block of revs for the group, in order: the first from next_rev() (which makes the counter if need be).
                    const [{ rev: first }] = (await sp `select ${sp(store.schema)}.next_rev() as rev`);
                    if (part.length > 1)
                        await sp `update ${ident(sp, store.schema, 'counters')} set rev = rev + ${part.length - 1} where user_id = ${sp(store.schema)}.current_user_id()`;
                    const rows = part.map((r, k) => ({ ...r.row, rev: String(BigInt(first) + BigInt(k)), content: sp.json(r.content) }));
                    const written = await sp `insert into ${ident(sp, store.schema, type)} ${sp(rows)} returning *`;
                    const byId = new Map(written.map((w) => [String(w.id), w]));
                    const kept = [];
                    for (const r of part) {
                        const record = store.toRecord(type, await crypto.openRow(sp, type, byId.get(r.op.id)));
                        const result = { op_id: r.op.op_id, status: 'applied', type, id: r.op.id, created: true, record };
                        results[r.i] = result;
                        kept.push({ op_id: r.op.op_id, result: sp.json((await crypto.sealDoc(sp, opAad(r.op.op_id), result))) });
                    }
                    await sp `insert into ${ident(sp, store.schema, 'applied_ops')} ${sp(kept, 'op_id', 'result')}`;
                });
            }
            catch (e) {
                const code = e?.code ?? '';
                if (!code.startsWith('23'))
                    throw e;
                for (const r of part) {
                    results[r.i] = undefined;
                    slow.add(r.i);
                }
            }
        }
    }
    // Everything else, one by one, in order.
    for (const i of [...slow].sort((a, b) => a - b))
        results[i] = await applyOp(tx, store, crypto, ops[i], now);
    return results;
}
/**
 * Deletes many records at once, for clearing all data (1.3.0): ops that delete (delete: true, no field changes) a record
 * that's there, not yet deleted, at the version the device saw, are checked as applyOp checks a delete (the record's
 * fields still valid) and then tombstoned with one update per type and BULK_ROWS, their revs taken as one block, every
 * result kept in applied_ops. A tombstone keeps everything, so a record can still be brought back. Anything else (a
 * record changed since, gone, already deleted, a repeat, an op that isn't a plain delete) goes through applyOp, so every
 * op's outcome is what applyOp would give. Results come back in the order of `ops`. Run it inside the person's
 * transaction.
 */
export async function applyDeletes(tx, store, crypto, ops, now) {
    await crypto.prepare(tx);
    const results = new Array(ops.length);
    const slow = new Set();
    const plainDelete = (op) => op.delete === true && op.base_version !== null && !Object.keys(op.fields ?? {}).length && op.sealed === undefined;
    const cands = ops.map((op, i) => ({ op, i })).filter(({ op, i }) => (plainDelete(op) ? true : (slow.add(i), false)));
    if (cands.length) {
        const done = new Set((await tx `select op_id from ${ident(tx, store.schema, 'applied_ops')} where op_id in ${tx(cands.map((c) => c.op.op_id))}`).map((r) => String(r.op_id)));
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
                    await tx.savepoint(async (sp) => {
                        const table = ident(sp, store.schema, type);
                        const rows = await sp `select * from ${table} where id in ${sp(part.map((p) => p.op.id))} for update`;
                        const current = new Map(rows.map((r) => [String(r.id), r]));
                        // What goes in bulk: there, live, at the version seen, and still valid as applyOp would check it.
                        const go = [];
                        for (const p of part) {
                            const row = current.get(p.op.id);
                            // As applyOp answers (1.3.1), without a query each: gone is not_found; another version is a conflict with the
                            // current copy. Already deleted at the version seen goes one by one (applyOp keeps its deletion time).
                            if (!row) {
                                results[p.i] = { op_id: p.op.op_id, status: 'not_found', type, id: p.op.id };
                                continue;
                            }
                            if (Number(row.version) !== p.op.base_version) {
                                results[p.i] = { op_id: p.op.op_id, status: 'conflict', type, id: p.op.id, current: store.toRecord(type, await crypto.openRow(sp, type, row)) };
                                continue;
                            }
                            if (row.deleted_at) {
                                slow.add(p.i);
                                continue;
                            }
                            const rec = store.toRecord(type, await crypto.openRow(sp, type, row));
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
                        const [{ rev: first }] = (await sp `select ${sp(store.schema)}.next_rev() as rev`);
                        if (go.length > 1)
                            await sp `update ${ident(sp, store.schema, 'counters')} set rev = rev + ${go.length - 1} where user_id = ${sp(store.schema)}.current_user_id()`;
                        // One update for the group: each row its own rev, from a list of (id, rev, client time).
                        const vals = go.map((p, k) => [p.op.id, String(BigInt(first) + BigInt(k)), p.op.client_updated_at ?? null]);
                        const written = await sp `
              update ${table} t set deleted_at = ${now}, version = t.version + 1, updated_at = ${now}, rev = v.rev::bigint,
                client_updated_at = coalesce(v.cua::timestamptz, t.client_updated_at)
              from (values ${sp(vals)}) as v(id, rev, cua)
              where t.id = v.id::uuid returning t.*`;
                        const byId = new Map(written.map((w) => [String(w.id), w]));
                        const kept = [];
                        for (const p of go) {
                            const record = store.toRecord(type, await crypto.openRow(sp, type, byId.get(p.op.id)));
                            const result = { op_id: p.op.op_id, status: 'applied', type, id: p.op.id, created: false, record };
                            results[p.i] = result;
                            kept.push({ op_id: p.op.op_id, result: sp.json((await crypto.sealDoc(sp, opAad(p.op.op_id), result))) });
                        }
                        await sp `insert into ${ident(sp, store.schema, 'applied_ops')} ${sp(kept, 'op_id', 'result')}`;
                    });
                }
                catch (e) {
                    const code = e?.code ?? '';
                    if (!code.startsWith('23'))
                        throw e;
                    for (const p of part) {
                        results[p.i] = undefined;
                        slow.add(p.i);
                    }
                }
            }
        }
    }
    for (const i of [...slow].sort((a, b) => a - b))
        if (!results[i])
            results[i] = await applyOp(tx, store, crypto, ops[i], now);
    return results;
}
/** The cursor is older than tombstones the server has cleaned up: the device must read everything again (HTTP 410). */
export class CursorExpired extends Error {
    status = 410;
    constructor() {
        super('cursor_expired');
    }
}
/**
 * Every record changed after `since`, in rev order, at most `limit` (plus whether there's more). Run it inside the
 * person's transaction. Throws CursorExpired when `since` (other than 0) is older than the last tombstone clean-up.
 */
export async function readChanges(tx, store, crypto, since, limit) {
    const [counter] = await tx `select purged_rev from ${ident(tx, store.schema, 'counters')}`;
    // 0 means everything, which is always allowed: it's how a device behind the clean-up catches up.
    if (counter && since > 0 && since < Number(counter.purged_rev))
        throw new CursorExpired();
    const parts = store.types.map((t) => tx `select ${t}::text as type, rev, to_jsonb(r) as row from ${ident(tx, store.schema, t)} r where rev > ${since}`);
    const union = parts.reduce((acc, p) => tx `${acc} union all ${p}`);
    const found = await tx `select type, row from (${union}) c order by rev limit ${limit + 1}`;
    const opened = await Promise.all(found.map(async (r) => ({ type: r.type, row: await crypto.openRow(tx, String(r.type), r.row) })));
    const items = opened.slice(0, limit).map((r) => ({ type: r.type, record: store.toRecord(r.type, r.row) }));
    return { changes: items, next: opened.length > limit ? items[items.length - 1].record.rev : null };
}
/** The person's prefs: settings and app state that isn't a record. Version 0: none yet. */
export async function getPrefs(tx, schema, crypto) {
    const [row] = await tx `select data, version from ${ident(tx, schema, 'prefs')}`;
    return row ? { data: (await crypto.openDoc(tx, 'prefs', row.data)), version: Number(row.version) } : { data: {}, version: 0 };
}
/**
 * Replaces the prefs if base_version is still current; otherwise returns the current copy to merge with. With
 * end-to-end encryption on, the data must be the device's sealed copy ({enc: 2, c}).
 */
export async function putPrefs(tx, schema, crypto, data, baseVersion) {
    await crypto.prepare(tx);
    const table = ident(tx, schema, 'prefs');
    const [row] = await tx `select data, version from ${table} for update`;
    const version = row ? Number(row.version) : 0;
    if (version !== baseVersion)
        return { conflict: { data: row ? await crypto.openDoc(tx, 'prefs', row.data) : {}, version } };
    if ((await crypto.vaultEnabled(tx)) && !(data.enc === 2 && typeof data.c === 'string'))
        return { problems: [{ field: 'data', code: 'sealed_required' }] };
    const sealed = tx.json((await crypto.sealDoc(tx, 'prefs', data)));
    const [saved] = row
        ? await tx `update ${table} set data = ${sealed}, version = version + 1, updated_at = now() returning version`
        : await tx `insert into ${table} (data, version) values (${sealed}, 1) returning version`;
    return { data, version: Number(saved.version) };
}
