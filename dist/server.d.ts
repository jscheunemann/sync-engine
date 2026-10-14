import type postgres from 'postgres';
import type { ChangesPage, Fields, Op, Problem, ServerRecord } from './protocol.js';
export type Db = postgres.Sql | postgres.TransactionSql;
export type Tx = postgres.TransactionSql;
export type Row = Record<string, unknown>;
/** A stored record: the server record plus how its content is stored. */
export interface StoredRecord extends ServerRecord {
    /** 0 plain, 1 encrypted at rest by the server, 2 encrypted on the device. */
    enc: number;
    key_version: number;
    /** enc 2 only: the content as the device encrypted it; the content fields are null. */
    sealed?: string;
}
/** An app's records: the rules for each type and how a type maps to its table's columns. */
export interface RecordStore<T extends string = string> {
    /** The Postgres schema of the record tables, counters, next_rev(), applied_ops and prefs. */
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
    /** Rules that need other rows (no dependency cycles), checked in the write's transaction. */
    crossChecks?(tx: Tx, type: T, id: string, fields: Fields, deleted: boolean): Promise<Problem[]>;
    /** A row (after `openRow`) as a record. */
    toRecord(type: T, row: Row): StoredRecord;
    /** A record's fields as columns, with the content fields gathered in `content`. */
    toColumns(type: T, fields: Fields): Row & {
        content: Row;
    };
}
/**
 * Encryption of what people wrote, when an app has it. Without it (`plain`), content is stored as it comes (enc 0).
 * Per request: an app's keys belong to the person the request is for.
 */
export interface ContentCrypto {
    prepare(db: Db): Promise<void>;
    /** End-to-end encryption is on: content must arrive sealed by the device. */
    vaultEnabled(db: Db): Promise<boolean>;
    openRow(db: Db, type: string, row: Row): Promise<Row>;
    sealContent(db: Db, type: string, id: string, content: Row): Promise<{
        content: Row;
        enc: number;
        key_version: number;
    }>;
    openDoc(db: Db, aad: string, value: unknown): Promise<unknown>;
    sealDoc(db: Db, aad: string, value: unknown): Promise<unknown>;
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
/** The fields of a stored record, without the sync columns. */
export declare function fieldsFrom<T extends string>(store: RecordStore<T>, type: T, rec: ServerRecord): Fields;
export declare function getRecord<T extends string>(db: Db, store: RecordStore<T>, crypto: ContentCrypto, type: T, id: string, lock?: boolean): Promise<StoredRecord | null>;
/**
 * Applies one op inside the caller's transaction (in its own savepoint, so a failed op leaves the others alone).
 *   * base_version null: create; a record with that id already existing is a conflict.
 *   * base_version n: change or delete; the stored version must be n, otherwise a conflict with the current record.
 *   * delete true tombstones; delete false brings a tombstone back.
 * Every applied result is stored by op_id; repeating the op returns it as a duplicate.
 */
export declare function applyOp<T extends string>(tx: Tx, store: RecordStore<T>, crypto: ContentCrypto, op: Op<T>, now: string): Promise<StoreOpResult<T>>;
/** The cursor is older than tombstones the server has cleaned up: the device must read everything again (HTTP 410). */
export declare class CursorExpired extends Error {
    readonly status = 410;
    constructor();
}
/**
 * Every record changed after `since`, in rev order, at most `limit` (plus whether there's more). Run it inside the
 * person's transaction. Throws CursorExpired when `since` (other than 0) is older than the last tombstone clean-up.
 */
export declare function readChanges<T extends string>(tx: Tx, store: RecordStore<T>, crypto: ContentCrypto, since: number, limit: number): Promise<ChangesPage<T>>;
/** The person's prefs: settings and app state that isn't a record. Version 0: none yet. */
export declare function getPrefs(tx: Tx, schema: string, crypto: ContentCrypto): Promise<{
    data: Record<string, unknown>;
    version: number;
}>;
/**
 * Replaces the prefs if base_version is still current; otherwise returns the current copy to merge with. With
 * end-to-end encryption on, the data must be the device's sealed copy ({enc: 2, c}).
 */
export declare function putPrefs(tx: Tx, schema: string, crypto: ContentCrypto, data: Record<string, unknown>, baseVersion: number): Promise<{
    data: Record<string, unknown>;
    version: number;
} | {
    conflict: {
        data: unknown;
        version: number;
    };
} | {
    problems: Problem[];
}>;
