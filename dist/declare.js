// What an app declares beyond its record types (ADRs 0003, 0006, 0009): server and shared types, the fields a find may
// use, and its system intents. The engine checks every intent against these before a backend sees it, so a backend is
// only ever asked for declared tables, columns and values of the declared kind.
/** Kinds a find may filter and order by (not lists or JSON). */
export const QUERYABLE = ['text', 'number', 'integer', 'boolean', 'time', 'id'];
/** A refused intent: a code, and the field when there is one; never a value (no user data in errors). */
export class EngineError extends Error {
    code;
    field;
    constructor(code, field) {
        super(field ? `${code}: ${field}` : code);
        this.code = code;
        if (field !== undefined)
            this.field = field;
    }
}
const OPS = ['in', 'nin', 'ne', 'gt', 'gte', 'lt', 'lte', 'is', 'not'];
/** Whether a value is right for a kind (null always is: the table's own rules decide whether it's allowed). */
export function fits(kind, v) {
    if (v === null)
        return true;
    switch (kind) {
        case 'text':
            return typeof v === 'string';
        case 'id':
            return typeof v === 'string' && v.length > 0 && v.length <= 200;
        case 'number':
            return typeof v === 'number' && Number.isFinite(v);
        case 'integer':
            return Number.isSafeInteger(v);
        case 'ids':
            return Array.isArray(v) && v.length <= 10000 && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200 && !/[{},"\\\s]/.test(x));
        case 'boolean':
            return typeof v === 'boolean';
        case 'time':
            return (typeof v === 'string' && !Number.isNaN(Date.parse(v))) || (v instanceof Date && !Number.isNaN(v.getTime()));
        case 'json':
            return v !== undefined;
    }
}
/** A stored value as the engine returns it for its kind. */
export function out(kind, v) {
    if (v === null || v === undefined)
        return null;
    if (kind === 'time')
        return new Date(v).toISOString();
    if (kind === 'number' || kind === 'integer')
        return Number(v);
    if (kind === 'ids')
        return idList(v);
    if (kind === 'id')
        return String(v);
    return v;
}
/** A list of ids as stored: an array, or Postgres's text form of one (`{a,b}`) where a driver leaves it as text. */
function idList(v) {
    if (Array.isArray(v))
        return v.map(String);
    const s = String(v);
    if (s === '{}' || s === '')
        return [];
    return s.replace(/^\{|\}$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
}
/** Conditions from a where, against the fields that may be queried (name → column and kind). */
export function conditions(where, fields) {
    const conds = [];
    for (const [name, m] of Object.entries(where ?? {})) {
        const f = fields.get(name);
        if (!f)
            throw new EngineError('not_queryable', name);
        const check = (v) => {
            if (!fits(f.kind, v) || v === null)
                throw new EngineError('bad_value', name);
            return v;
        };
        if (m === null)
            conds.push({ col: f.col, op: 'null' });
        else if (typeof m !== 'object')
            conds.push({ col: f.col, op: 'eq', value: check(m) });
        else {
            const keys = Object.keys(m);
            const op = keys[0];
            if (keys.length !== 1 || !OPS.includes(op))
                throw new EngineError('bad_match', name);
            const v = m[op];
            if (op === 'is' || op === 'not') {
                if (v !== null)
                    throw new EngineError('bad_match', name);
                conds.push({ col: f.col, op: op === 'is' ? 'null' : 'notnull' });
            }
            else if (op === 'in' || op === 'nin') {
                if (!Array.isArray(v) || v.length > 1000)
                    throw new EngineError('bad_value', name);
                conds.push({ col: f.col, op, value: v.map(check) });
            }
            else
                conds.push({ col: f.col, op, value: check(v) });
        }
    }
    return conds;
}
/** A find's cursor: the last row's order value and key values, opaque to the app (base64url JSON). */
export const cursor = {
    make: (values) => {
        const bytes = new TextEncoder().encode(JSON.stringify(values));
        let bin = '';
        for (const b of bytes)
            bin += String.fromCharCode(b);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    read: (s) => {
        try {
            const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
            const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
            if (Array.isArray(v))
                return v;
        }
        catch { }
        throw new EngineError('bad_cursor');
    },
};
