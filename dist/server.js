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
