// Records from declarations (ADR 0014): an app declares each record type's fields and their kinds, and which hold what
// people wrote; the engine maps them to columns and back. The app keeps its rules (defaults, normalize, validate,
// cross-checks), never how a record is stored.
import { fits, out, QUERYABLE } from "./declare.js";
/** Columns every record table has, by kind, besides the person and the fields. */
export const RECORD_COLUMNS = {
    id: 'id',
    rev: 'number',
    version: 'integer',
    created_at: 'time',
    updated_at: 'time',
    client_updated_at: 'time',
    deleted_at: 'time',
    content: 'json',
    enc: 'integer',
    key_version: 'integer',
};
/** Names a field can't take: the engine's own columns, and the person. */
const RESERVED = new Set([...Object.keys(RECORD_COLUMNS), 'user_id', 'sealed']);
const kindOf = (d) => (typeof d === 'string' ? d : d.kind);
const isContent = (d) => typeof d !== 'string' && d.content === true;
/** One record type's mapping, made once from its declaration. */
export class RecordType {
    names;
    content;
    /** Each column's kind: the engine's, then the fields stored as columns. */
    columns;
    /** Columns a find may use. */
    queryable;
    fields;
    constructor(name, fields) {
        for (const f of Object.keys(fields)) {
            if (RESERVED.has(f))
                throw new Error(`reserved_field: ${name}.${f}`);
            if (!/^[a-z][a-z0-9_]{0,62}$/.test(f))
                throw new Error(`bad_field_name: ${name}.${f}`);
        }
        this.fields = fields;
        this.names = Object.keys(fields);
        this.content = this.names.filter((f) => isContent(fields[f]));
        const cols = { ...RECORD_COLUMNS };
        for (const f of this.names)
            if (!isContent(fields[f]))
                cols[f] = kindOf(fields[f]);
        this.columns = cols;
        this.queryable = Object.fromEntries(Object.entries(cols).filter(([c, k]) => QUERYABLE.includes(k) && !['client_updated_at', 'enc', 'key_version', 'version'].includes(c)));
    }
    /** Every field null: what a new record starts from when the app gives no defaults. */
    empty() {
        return Object.fromEntries(this.names.map((f) => [f, null]));
    }
    /** The default shape check, for an app without its own: unknown fields, and values not of their kind. */
    check(changes) {
        const problems = [];
        for (const [f, v] of Object.entries(changes)) {
            const d = this.fields[f];
            if (!d)
                problems.push({ field: f, code: 'unknown' });
            else if (!fits(kindOf(d), v))
                problems.push({ field: f, code: 'invalid' });
        }
        return problems;
    }
    /** A record's fields as columns, with the content fields gathered in `content`. */
    toColumns(fields) {
        const cols = {};
        const content = {};
        for (const f of this.names) {
            const v = fields[f] ?? null;
            if (isContent(this.fields[f])) {
                if (v !== null)
                    content[f] = v;
            }
            else
                cols[f] = v;
        }
        return { ...cols, content };
    }
    /** A row (after the app's crypto opened it), or its JSON form from the change feed, as a record. */
    toRecord(row) {
        const raw = row.content;
        const content = (typeof raw === 'string' ? JSON.parse(raw) : raw);
        const rec = {
            id: String(row.id),
            version: Number(row.version),
            rev: Number(row.rev),
            created_at: out('time', row.created_at),
            updated_at: out('time', row.updated_at),
            client_updated_at: out('time', row.client_updated_at),
            deleted_at: out('time', row.deleted_at),
            enc: Number(row.enc ?? 0),
            key_version: Number(row.key_version ?? 0),
        };
        // Sealed by the device (enc 2): the content is one ciphertext the server can't read.
        if (rec.enc === 2 && typeof content?.c === 'string')
            rec.sealed = content.c;
        for (const f of this.names) {
            const d = this.fields[f];
            rec[f] = isContent(d) ? (rec.enc === 2 ? null : (content?.[f] ?? null)) : kindOf(d) === 'ids' ? (out('ids', row[f]) ?? []) : out(kindOf(d), row[f]);
        }
        return rec;
    }
}
