import { type Backend, type Row, type Scope } from './backend.js';
import type { ChangesPage, Fields, Op, Problem, ServerRecord } from './protocol.js';
export { RuleError, type Backend, type Row, type Scope } from './backend.js';
/** A stored record: the server record plus how its content is stored. */
export interface StoredRecord extends ServerRecord {
    /** 0 plain, 1 encrypted at rest by the server, 2 encrypted on the device. */
    enc: number;
    key_version: number;
    /** enc 2 only: the content as the device encrypted it; the content fields are null. */
    sealed?: string;
}
/** What an app's hooks may read inside a unit of work: records by id, kept to the unit's person. */
export interface Reader<T extends string = string> {
    get(type: T, id: string): Promise<StoredRecord | null>;
    getMany(type: T, ids: readonly string[]): Promise<StoredRecord[]>;
}
/** An app's records: the rules for each type and how a type maps to its table's columns. */
export interface RecordStore<T extends string = string> {
    /** Where the app's tables are (a Postgres schema). */
    schema: string;
    types: readonly T[];
    isType(t: unknown): t is T;
    /** The editable fields of a type. */
    fieldNames(type: T): readonly string[];
    /** The fields that hold what people wrote (what encryption covers); stored in the row's `content`. */
    contentFields(type: T): readonly string[];
    /** Fields with their defaults, for a new record. */
    defaults(type: T): Fields;
    /** Problems with a set of changes alone: unknown and read-only keys. */
    checkChanges(type: T, changes: Fields): Problem[];
    /** Values the rules imply (a done time when something is done). Returns a new object. */
    normalize(type: T, fields: Fields, now: string): Fields;
    /** Every problem with a whole record. With `sealed`, content was checked on the device and can't be read here. */
    validate(type: T, fields: Fields, id: string, opts: {
        sealed: boolean;
    }): Problem[];
    /** Rules that need other records, checked in the write's unit of work through `read` (no database access of their own). */
    crossChecks?(read: Reader<T>, type: T, id: string, fields: Fields, deleted: boolean): Promise<Problem[]>;
    /** A row (after `openRow`) as a record. */
    toRecord(type: T, row: Row): StoredRecord;
    /** A record's fields as columns, with the content fields gathered in `content`. */
    toColumns(type: T, fields: Fields): Row & {
        content: Row;
    };
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
}
/** How many rows one bulk write takes. */
export declare const BULK_ROWS = 500;
/** The engine for an app's records on a backend. Make it once; connect per request. */
export declare function createEngine<T extends string, S>(opts: {
    store: RecordStore<T>;
    backend: Backend<S>;
}): Engine<T, S>;
/** The fields of a stored record, without the sync columns. */
export declare function fieldsFrom<T extends string>(store: RecordStore<T>, type: T, rec: ServerRecord): Fields;
