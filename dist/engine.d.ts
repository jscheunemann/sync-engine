import { type Backend, type Row, type SchemaPlan, type Scope } from './backend.js';
import { type FindOptions, type SummaryOptions, type SystemDecl, type TypeDecl, type Where } from './declare.js';
import type { ChangesPage, Fields, Op, Problem, ServerRecord } from './protocol.js';
import { type FieldDecl, type StoredRecord } from './records.js';
export { RuleError, isSystem, type SchemaPlan, type TableLayout, type Backend, type PersonScope, type Row, type Scope, type SystemScope } from './backend.js';
export { EngineError, type FindOptions, type GroupBy, type Kind, type Match, type Measure, type SummaryOptions, type SystemDecl, type TypeDecl, type Where } from './declare.js';
export { type FieldDecl, type StoredRecord } from './records.js';
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
    count(type: string, opts?: {
        where?: Where;
    }): Promise<number>;
    /** Groups and measures of a type's rows, by declared fields and paths only (ADR 0016). */
    summarize(type: string, opts: SummaryOptions): Promise<Row[]>;
}
/** The outcome of an update to a declared type. */
export type UpdateResult = {
    status: 'applied';
    row: Row;
} | {
    status: 'conflict';
    current: Row;
} | {
    status: 'not_found';
};
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
    validate(type: T, fields: Fields, id: string, opts: {
        sealed: boolean;
    }): Problem[];
    /** Rules that need other records, checked in the write's unit of work through `read` (no database access of their own). */
    crossChecks?(read: Reader<T>, type: T, id: string, fields: Fields, deleted: boolean): Promise<Problem[]>;
    /** Whether new records of this type may be written in bulk (default: types without `crossChecks`). */
    bulkSafe?(type: T): boolean;
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
    sealContent(type: string, id: string, content: Row): Promise<{
        content: Row;
        enc: number;
        key_version: number;
    }>;
    openDoc(aad: string, value: unknown): Promise<unknown>;
    sealDoc(aad: string, value: unknown): Promise<unknown>;
}
export declare const plain: ContentCrypto;
export type StoreOpResult<T extends string = string> = {
    op_id: string;
    status: 'applied' | 'duplicate';
    type: T;
    id: string;
    created: boolean;
    record: StoredRecord;
} | {
    op_id: string;
    status: 'conflict';
    type: T;
    id: string;
    current: StoredRecord | null;
} | {
    op_id: string;
    status: 'not_found';
    type: T;
    id: string;
} | {
    op_id: string;
    status: 'invalid';
    type?: string;
    id?: string;
    problems: Problem[];
};
/** The cursor is older than tombstones the server has cleaned up: the device must read everything again (HTTP 410). */
export declare class CursorExpired extends Error {
    readonly status = 410;
    constructor();
}
export type Prefs = {
    data: Record<string, unknown>;
    version: number;
};
export type PutPrefsResult = Prefs | {
    conflict: {
        data: unknown;
        version: number;
    };
} | {
    problems: Problem[];
};
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
    put(type: string, row: Row, opts?: {
        onConflict?: 'update' | 'nothing';
    }): Promise<Row | null>;
    /** Holds a named lock until the unit ends, so two units doing the same thing go one after the other. */
    lock(name: string): Promise<void>;
    /**
     * Erases one person (ADR 0022), in a system unit whose intent declares `erase`: every row of theirs in the record
     * types, the engine's own tables, and the person types the intent writes, except those in `keep`. Returns the rows
     * removed by type. Can't be undone.
     */
    erase(person: string, opts?: {
        keep?: readonly string[];
    }): Promise<Record<string, number>>;
    /** Changes the row with this key; with a `version` column, only if `version` is still current. */
    update(type: string, key: Row, changes: Row, version?: number): Promise<UpdateResult>;
    /** Removes the row with this key; returns whether there was one. */
    remove(type: string, key: Row): Promise<boolean>;
    /**
     * Removes every row of a system type that matches (ADR 0023), in a system unit whose intent writes the type: one
     * statement and one audit line, however many rows. `where` must name at least one field. Returns the rows removed.
     */
    removeWhere(type: string, where: Where): Promise<number>;
}
/** A request's session: one connection, any number of units of work. */
export interface Session<T extends string = string> {
    work<R>(scope: Scope, fn: (w: Work<T>) => Promise<R>, opts?: {
        crypto?: ContentCrypto;
    }): Promise<R>;
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
export declare const BULK_ROWS = 500;
/** The engine for an app's records on a backend. Make it once; connect per request. */
export declare function createEngine<T extends string, S>(opts: {
    store: RecordStore<T>;
    backend: Backend<S>;
    /** Types the app's server writes (not synced from devices), by name (ADR 0003). */
    types?: Readonly<Record<string, TypeDecl>>;
    /** System intents, by name (ADR 0009). */
    system?: Readonly<Record<string, SystemDecl>>;
}): Engine<T, S>;
/** The fields of a stored record, without the sync columns. */
export declare function fieldsFrom<T extends string>(store: RecordStore<T>, type: T, rec: ServerRecord): Fields;
