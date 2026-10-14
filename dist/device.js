// The device side of sync. The device keeps a full copy; this keeps it and the server in step.
//
//   * Base copies: for every record, the last server copy this device saw (`state.base`).
//   * Outbox: whatever differs between the device's records and their base copies. Edits are found by comparing,
//     not by queuing each change, so an edit made offline (or by any screen) is never missed; the time a record was
//     first seen changed is kept as its client_updated_at for merging.
//   * Push before pull. A stale write comes back as a conflict with the server's copy; the device merges field by
//     field (merge3) and tries again. Then every change after the cursor is pulled and merged the same way.
//   * The first sync on a device pulls first, and can adopt server records that match ones the device made (`adopt`),
//     so a new device's defaults don't appear twice.
//   * Prefs (settings and app state that isn't a record) are one versioned document, merged key by key.
//   * End-to-end encryption, when an app has it: the transport encrypts and decrypts; the engine only sees plaintext.
//     When it is turned on or off, every record still stored the other way is rewritten (`sealed` says which way).
//
// Everything here is plain data and an injected transport, so the same rules run in the browser and in tests, and
// another back end (iCloud) can replace the transport later.
import { canonical, merge3 } from "./merge.js";
export { canonical };
/** The key of a record in Recs and in the sync state. */
export const key = (type, id) => `${type}:${id}`;
export const emptyState = () => ({ cursor: 0, base: {}, seen: {}, refused: {}, prefs: null });
const same = (a, b) => canonical(a) === canonical(b);
function baseFrom(type, r, names) {
    const fields = {};
    for (const n of names)
        fields[n] = r[n] ?? null;
    return { type, id: r.id, fields, version: r.version, deleted_at: r.deleted_at, client_updated_at: r.client_updated_at, created_at: r.created_at, updated_at: r.updated_at, enc: Number(r.enc ?? 0), ...(Number(r.enc) === 2 ? { kv: Number(r.key_version ?? 0) } : {}) };
}
function recFromBase(b) {
    return { type: b.type, id: b.id, fields: { ...b.fields }, created_at: b.created_at, updated_at: b.updated_at };
}
/** Replaces every reference to `from` with `to` in the records' fields (ids, id lists and JSON). */
function renameRef(recs, from, to) {
    const walk = (v) => v === from ? to : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
    for (const r of recs.values())
        r.fields = walk(r.fields);
}
export async function sync(input) {
    const now = input.now ?? (() => new Date().toISOString());
    const newOpId = input.newOpId ?? (() => crypto.randomUUID());
    const state = structuredClone(input.state);
    state.refused ??= {};
    if (!!state.sealed !== !!input.sealed) {
        state.refused = {};
        state.sealed = !!input.sealed;
    }
    const recs = new Map([...input.recs].map(([k, r]) => [k, { ...r, fields: { ...r.fields } }]));
    let prefs = { ...input.prefs };
    const out = { recs, prefs, state, changed: false, pushed: 0, pulled: 0, refused: [], error: null };
    const { transport } = input;
    const stabilize = input.stabilize ?? ((_t, local) => local);
    /** The device's copy of a record, with the server's precision kept where the device's copy still agrees. */
    const localFields = (k) => {
        const r = recs.get(k);
        if (!r)
            return null;
        const b = state.base[k];
        return b ? stabilize(r.type, r.fields, b.fields) : r.fields;
    };
    const fingerprint = (k) => {
        const f = localFields(k);
        return f ? canonical(f) : 'deleted';
    };
    const touch = () => {
        const t = now();
        for (const k of new Set([...recs.keys(), ...Object.keys(state.base)])) {
            const h = fingerprint(k);
            if (state.seen[k]?.h !== h)
                state.seen[k] = { h, at: t };
        }
        for (const k of Object.keys(state.seen))
            if (!recs.has(k) && !state.base[k])
                delete state.seen[k];
    };
    const hasContent = (t) => (input.contentOf?.(t).length ?? 0) > 0;
    /** Stored the other way from what encryption wants (on: encrypted on the device; off: not). */
    const wrongWay = (k) => {
        const b = state.base[k];
        if (!b || b.deleted_at || !recs.has(k) || !hasContent(b.type))
            return false;
        if (input.sealed && b.enc === 2) {
            const below = input.resealBelow?.(b.type);
            return !!below && (b.kv ?? 0) < below;
        }
        return input.sealed ? b.enc !== 2 : b.enc === 2;
    };
    const isDirty = (k) => {
        const b = state.base[k];
        const f = localFields(k);
        if (!f)
            return !!b && !b.deleted_at;
        if (!b || b.deleted_at)
            return true;
        return !same(f, b.fields) || wrongWay(k);
    };
    const sideOfLocal = (k) => {
        const f = localFields(k);
        const at = state.seen[k]?.at ?? null;
        return f ? { fields: f, deleted_at: null, client_updated_at: at } : { fields: state.base[k]?.fields ?? {}, deleted_at: at ?? now(), client_updated_at: at };
    };
    const sideOfServer = (b) => ({ fields: b.fields, deleted_at: b.deleted_at, client_updated_at: b.client_updated_at });
    /** Takes a server copy as the new base; if the device's copy was edited too, merges the two. */
    const absorb = (type, r) => {
        const k = key(type, r.id);
        const names = input.fieldsOf(type);
        const server = baseFrom(type, r, names);
        if (isDirty(k)) {
            const prior = state.base[k];
            const baseSide = prior ? { fields: prior.fields, deleted_at: prior.deleted_at, client_updated_at: prior.client_updated_at } : { fields: {}, deleted_at: r.deleted_at, client_updated_at: null };
            const merged = merge3(baseSide, sideOfLocal(k), sideOfServer(server));
            state.base[k] = server;
            if (merged.deleted_at)
                recs.delete(k);
            else
                recs.set(k, { type, id: r.id, fields: merged.fields, created_at: r.created_at, updated_at: r.updated_at });
            const h = fingerprint(k);
            state.seen[k] = { h, at: merged.client_updated_at ?? now() };
        }
        else {
            state.base[k] = server;
            if (r.deleted_at)
                recs.delete(k);
            else
                recs.set(k, recFromBase(server));
            state.seen[k] = { h: fingerprint(k), at: r.client_updated_at ?? now() };
        }
        out.changed = true;
    };
    async function pull() {
        let fresh = false;
        const seenOnServer = new Set();
        for (;;) {
            let page;
            try {
                page = await transport.changes(state.cursor);
            }
            catch (e) {
                if (e?.status === 410 && !fresh) {
                    // Too long away: read everything again, then drop what the server no longer has.
                    fresh = true;
                    state.cursor = 0;
                    continue;
                }
                throw e;
            }
            for (const c of page.changes) {
                const k = key(c.type, c.record.id);
                seenOnServer.add(k);
                const b = state.base[k];
                if (!b || b.version !== c.record.version || b.deleted_at !== c.record.deleted_at) {
                    absorb(c.type, c.record);
                    out.pulled++;
                }
                state.cursor = Math.max(state.cursor, c.record.rev);
            }
            if (page.next === null)
                break;
        }
        if (fresh) {
            for (const k of Object.keys(state.base)) {
                if (seenOnServer.has(k))
                    continue;
                delete state.base[k];
                delete state.seen[k];
                if (recs.delete(k))
                    out.changed = true;
            }
        }
    }
    async function push() {
        const ops = [];
        const keyOf = new Map();
        for (const k of new Set([...recs.keys(), ...Object.keys(state.base)])) {
            if (!isDirty(k))
                continue;
            const fp = fingerprint(k);
            if (state.refused[k] === fp)
                continue;
            const r = recs.get(k);
            const b = state.base[k];
            const f = localFields(k);
            const at = state.seen[k]?.at ?? now();
            let op;
            if (!f)
                op = { op_id: newOpId(), type: b.type, id: b.id, base_version: b.version, delete: true, client_updated_at: at };
            else if (!b)
                op = { op_id: newOpId(), type: r.type, id: r.id, base_version: null, fields: f, client_updated_at: at, created_at: r.created_at ?? null };
            else {
                const changes = {};
                for (const n of Object.keys(f))
                    if (!same(f[n], b.fields[n]))
                        changes[n] = f[n];
                // Leaving encryption: the whole content goes back in plaintext so the server can take it.
                if (!input.sealed && b.enc === 2)
                    for (const n of input.contentOf?.(b.type) ?? [])
                        changes[n] = f[n] ?? null;
                op = { op_id: newOpId(), type: b.type, id: b.id, base_version: b.version, fields: changes, client_updated_at: at };
                if (b.deleted_at)
                    op.delete = false;
            }
            if (f)
                op.full = f;
            ops.push(op);
            keyOf.set(op.op_id, k);
        }
        if (!ops.length)
            return false;
        let again = false;
        for (let i = 0; i < ops.length; i += 500) {
            const batch = ops.slice(i, i + 500);
            const results = await transport.push(batch);
            for (const res of results) {
                const k = keyOf.get(res.op_id);
                if (!k)
                    continue;
                const op = batch.find((o) => o.op_id === res.op_id);
                if (res.status === 'applied' || res.status === 'duplicate') {
                    const before = localFields(k);
                    const prior = recs.get(k);
                    state.base[k] = baseFrom(op.type, res.record, input.fieldsOf(op.type));
                    // The server's copy is what was sent, normalized (a done time filled in, a cleared field): take it.
                    if (res.record.deleted_at)
                        recs.delete(k);
                    else
                        recs.set(k, recFromBase(state.base[k]));
                    if (!same(before, localFields(k)) || (prior && (prior.created_at !== res.record.created_at || prior.updated_at !== res.record.updated_at)))
                        out.changed = true;
                    state.seen[k] = { h: fingerprint(k), at: state.seen[k]?.at ?? now() };
                    delete state.refused[k];
                    out.pushed++;
                }
                else if (res.status === 'conflict') {
                    if (res.current)
                        absorb(op.type, res.current);
                    again = true;
                }
                else if (res.status === 'not_found') {
                    // The server no longer has it (cleaned up): make it again.
                    delete state.base[k];
                    again = true;
                }
                else if (res.status === 'invalid') {
                    state.refused[k] = fingerprint(k);
                    out.refused.push({ key: k, problems: res.problems });
                }
            }
        }
        return again;
    }
    async function syncPrefs() {
        for (let round = 0; round < 3; round++) {
            const server = await transport.getPrefs();
            const known = state.prefs;
            let merged;
            if (!known) {
                // First sync on this device: the account's prefs win over what this device had.
                merged = server.version > 0 ? { ...prefs, ...server.data } : prefs;
            }
            else if (known.version === server.version) {
                merged = prefs;
            }
            else {
                merged = mergeKeys(prefs, known.data, server.data);
            }
            if (!same(merged, prefs))
                out.changed = true;
            prefs = merged;
            const below = input.sealed ? input.resealBelow?.('prefs') : null;
            if (same(merged, server.data) && !!server.sealed === !!input.sealed && !(below && (server.kv ?? 0) < below)) {
                state.prefs = { data: server.data, version: server.version };
                return;
            }
            const res = await transport.putPrefs(merged, server.version);
            if ('conflict' in res) {
                state.prefs = known;
                continue;
            }
            state.prefs = { data: res.data, version: res.version };
            return;
        }
    }
    try {
        touch();
        const first = state.cursor === 0 && Object.keys(state.base).length === 0;
        if (first) {
            await pull();
            if (input.adopt?.(recs, state.base, (from, to) => renameRef(recs, from, to)))
                out.changed = true;
            touch();
        }
        for (let round = 0; round < 3 && (await push()); round++)
            touch();
        await pull();
        touch();
        // A pull can merge in edits that still need sending.
        for (let round = 0; round < 2 && (await push()); round++)
            touch();
        await syncPrefs();
    }
    catch (e) {
        out.error = e;
    }
    out.prefs = prefs;
    return out;
}
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** Key by key, into nested objects: what this device changed wins; otherwise the server's. */
export function mergeKeys(local, base, server) {
    if (plain(local) && plain(server) && (plain(base) || base == null)) {
        const b = plain(base) ? base : {};
        const out = {};
        for (const k of new Set([...Object.keys(local), ...Object.keys(server)]))
            out[k] = mergeKeys(local[k], b[k], server[k]);
        return out;
    }
    return !same(local, base) ? (local ?? null) : (server ?? null);
}
/**
 * The screens may change S while a sync is in flight. `before` is what the sync started from, `now` what the
 * screens hold now, `synced` what the sync produced. Edits made during the sync win field by field; everything else
 * comes from the sync.
 */
export function rebase(before, now, synced) {
    const out = new Map(synced);
    for (const k of new Set([...before.keys(), ...now.keys()])) {
        const b = before.get(k);
        const n = now.get(k);
        if (same(b?.fields, n?.fields) && !!b === !!n)
            continue;
        const s = synced.get(k);
        if (!n) {
            out.delete(k);
            continue;
        }
        if (!b || !s) {
            out.set(k, n);
            continue;
        }
        const fields = { ...s.fields };
        for (const f of Object.keys(n.fields))
            if (!same(n.fields[f], b.fields[f]))
                fields[f] = n.fields[f];
        out.set(k, { ...s, fields });
    }
    return out;
}
/**
 * An `adopt` hook for a type whose records are matched by a name (case-insensitive): on a new device, each record it
 * made that has the same name as one on the server is dropped and references to it point at the server's.
 */
export function adoptByName(type, field) {
    return (recs, base, renameRef) => {
        let changed = false;
        const byName = new Map();
        for (const b of Object.values(base))
            if (b.type === type && !b.deleted_at)
                byName.set(String(b.fields[field]).toLowerCase(), b.id);
        for (const [k, r] of [...recs]) {
            if (r.type !== type || base[k])
                continue;
            const name = String(r.fields[field]).toLowerCase();
            const serverId = byName.get(name);
            if (!serverId)
                continue;
            byName.delete(name); // each server record is adopted once
            recs.delete(k);
            renameRef(r.id, serverId);
            changed = true;
        }
        return changed;
    };
}
