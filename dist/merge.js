// Three-way merge of one record: used by a device when the server reports a conflict, or when a pulled change meets a
// local edit. `base` is the last server copy this device saw, `local` its edited copy, `server` the newer server copy.
//   * a field changed on one side only takes that side;
//   * a field changed on both sides takes the side with the later client_updated_at (server on a tie);
//   * a deletion beats an older edit; an edit newer than the deletion revives the record.
/** JSON with object keys sorted, so the same value always prints the same (Postgres jsonb reorders keys). */
export function canonical(v) {
    if (Array.isArray(v))
        return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') {
        const o = v;
        return `{${Object.keys(o)
            .filter((k) => o[k] !== undefined)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
            .join(',')}}`;
    }
    return JSON.stringify(v ?? null);
}
const same = (a, b) => canonical(a) === canonical(b);
const time = (s) => (s ? Date.parse(s) : 0);
export function merge3(base, local, server) {
    const localNewer = time(local.client_updated_at) > time(server.client_updated_at);
    const keys = new Set([...Object.keys(base.fields), ...Object.keys(local.fields), ...Object.keys(server.fields)]);
    const fields = {};
    for (const k of keys) {
        const b = base.fields[k];
        const l = local.fields[k];
        const s = server.fields[k];
        const lChanged = !same(l, b);
        const sChanged = !same(s, b);
        if (lChanged && !sChanged)
            fields[k] = l;
        else if (sChanged && !lChanged)
            fields[k] = s;
        else if (lChanged && sChanged)
            fields[k] = localNewer ? l : s;
        else
            fields[k] = s;
    }
    // deleted_at merges like a field…
    const dl = !same(local.deleted_at, base.deleted_at);
    const ds = !same(server.deleted_at, base.deleted_at);
    let deleted_at;
    let deleter = null;
    if (dl && !ds)
        [deleted_at, deleter] = [local.deleted_at, 'local'];
    else if (ds && !dl)
        [deleted_at, deleter] = [server.deleted_at, 'server'];
    else if (dl && ds)
        [deleted_at, deleter] = localNewer ? [local.deleted_at, 'local'] : [server.deleted_at, 'server'];
    else
        deleted_at = server.deleted_at;
    // …except that an edit made on the other side after the deletion revives the record.
    if (deleted_at && deleter) {
        const other = deleter === 'local' ? server : local;
        const me = deleter === 'local' ? local : server;
        if (!same(other.fields, base.fields) && time(other.client_updated_at) > time(me.client_updated_at))
            deleted_at = null;
    }
    const cu = localNewer ? local.client_updated_at : server.client_updated_at;
    return { fields, deleted_at, client_updated_at: cu };
}
