// The sync protocol shared by every app on this engine: what a record looks like on the wire, the ops a device sends
// (POST /sync/push), what each op comes back as, and the change feed (GET /sync/changes). See README.md for the model.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
export const isInstant = (v) => typeof v === 'string' && INSTANT_RE.test(v) && !Number.isNaN(Date.parse(v));
const OP_KEYS = new Set(['op_id', 'type', 'id', 'base_version', 'fields', 'delete', 'client_updated_at', 'created_at', 'sealed', 'key_version']);
const SEALED_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_SEALED = 1_500_000;
/** Checks an op's shape before it touches the database. `isType` says which record types this app has. */
export function checkOp(raw, isType) {
    const problems = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return { problems: [{ field: 'op', code: 'type' }] };
    const o = raw;
    for (const k of Object.keys(o))
        if (!OP_KEYS.has(k))
            problems.push({ field: k, code: 'unknown' });
    if (!isUuid(o.op_id))
        problems.push({ field: 'op_id', code: 'type' });
    if (!isType(o.type))
        problems.push({ field: 'type', code: 'not_allowed' });
    if (!isUuid(o.id))
        problems.push({ field: 'id', code: 'type' });
    if (o.base_version !== null && o.base_version !== undefined && !(Number.isInteger(o.base_version) && o.base_version >= 1)) {
        problems.push({ field: 'base_version', code: 'type' });
    }
    if (o.fields !== undefined && (!o.fields || typeof o.fields !== 'object' || Array.isArray(o.fields)))
        problems.push({ field: 'fields', code: 'type' });
    if (o.delete !== undefined && typeof o.delete !== 'boolean')
        problems.push({ field: 'delete', code: 'type' });
    if (o.client_updated_at !== undefined && o.client_updated_at !== null && !isInstant(o.client_updated_at)) {
        problems.push({ field: 'client_updated_at', code: 'type' });
    }
    if (o.created_at !== undefined && o.created_at !== null && !isInstant(o.created_at))
        problems.push({ field: 'created_at', code: 'type' });
    if (o.sealed !== undefined) {
        if (typeof o.sealed !== 'string' || o.sealed.length < 24 || o.sealed.length > MAX_SEALED || !SEALED_RE.test(o.sealed))
            problems.push({ field: 'sealed', code: 'type' });
        if (!Number.isInteger(o.key_version) || o.key_version < 1)
            problems.push({ field: 'key_version', code: 'type' });
    }
    else if (o.key_version !== undefined)
        problems.push({ field: 'key_version', code: 'without_sealed' });
    if (problems.length)
        return { problems, op_id: isUuid(o.op_id) ? o.op_id : undefined };
    return {
        op: {
            op_id: o.op_id,
            type: o.type,
            id: o.id.toLowerCase(),
            base_version: o.base_version ?? null,
            fields: o.fields ?? undefined,
            delete: o.delete,
            client_updated_at: o.client_updated_at ?? null,
            created_at: o.created_at ?? null,
            ...(o.sealed !== undefined ? { sealed: o.sealed, key_version: o.key_version } : {}),
        },
    };
}
