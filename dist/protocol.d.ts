export type Fields = Record<string, unknown>;
/** One problem with a record or an op: the field (or op key) and a short code, never the value. */
export interface Problem {
    field: string;
    code: string;
}
/** A record as the server stores and returns it: the app's fields plus the sync columns. */
export interface ServerRecord {
    id: string;
    /** Changes to this row so far; a write must name the version it was based on (optimistic concurrency). */
    version: number;
    /** The person's change counter when this row last changed; a device's cursor is the highest rev it has seen. */
    rev: number;
    created_at: string;
    updated_at: string;
    /** When the change was made on the device, for merging (the later edit wins a field both sides changed). */
    client_updated_at: string | null;
    /** A tombstone: rows are never deleted by the API. */
    deleted_at: string | null;
    [field: string]: unknown;
}
/** One change a device sends. */
export interface Op {
    /** A fresh UUID per op; sending the same op again returns its first result (idempotency). */
    op_id: string;
    type: string;
    id: string;
    /** null: create. n: change or delete the record at version n; anything else is a conflict. */
    base_version: number | null;
    /** The fields that changed (all of them on create). */
    fields?: Fields;
    /** true tombstones; false brings a tombstone back. */
    delete?: boolean;
    client_updated_at?: string | null;
    /** When the record was made on the device. Only used when the op creates the record. */
    created_at?: string | null;
    /** Every field of the device's copy, for a transport that encrypts (never sent as it is). */
    full?: Fields;
    /** Content the device encrypted, with its key's version (apps with end-to-end encryption). */
    sealed?: string;
    key_version?: number;
}
export type OpResult = {
    op_id: string;
    status: 'applied' | 'duplicate';
    record: ServerRecord;
    type?: string;
    id?: string;
    created?: boolean;
} | {
    op_id: string;
    status: 'conflict';
    current: ServerRecord | null;
    type?: string;
    id?: string;
} | {
    op_id: string;
    status: 'not_found';
    type?: string;
    id?: string;
} | {
    op_id: string;
    status: 'invalid';
    problems: Problem[];
    type?: string;
    id?: string;
};
/** A page of the change feed: every record changed after the cursor, in rev order. next is null on the last page. */
export interface ChangesPage<T extends string = string> {
    changes: {
        type: T;
        record: ServerRecord;
    }[];
    next: number | null;
}
/** How a device reaches the server. An app can wrap one (to encrypt, or to reach iCloud) without the engine knowing. */
export interface Transport<T extends string = string> {
    push(ops: Op[]): Promise<OpResult[]>;
    /** Throws an error with status 410 when the cursor is too old (tombstones it needed were cleaned up). */
    changes(since: number): Promise<ChangesPage<T>>;
    /** `sealed`: the server's copy was encrypted on a device. Version 0: nothing saved yet. */
    getPrefs(): Promise<{
        data: Fields;
        version: number;
        sealed?: boolean;
        kv?: number;
    }>;
    /** Resolves with { conflict } instead of throwing when base_version is stale. */
    putPrefs(data: Fields, baseVersion: number): Promise<{
        data: Fields;
        version: number;
    } | {
        conflict: {
            data: Fields;
            version: number;
        };
    }>;
}
export declare const isUuid: (v: unknown) => v is string;
export declare const isInstant: (v: unknown) => v is string;
/** Checks an op's shape before it touches the database. `isType` says which record types this app has. */
export declare function checkOp<T extends string>(raw: unknown, isType: (t: unknown) => t is T): {
    op: Op & {
        type: T;
    };
} | {
    problems: Problem[];
    op_id?: string;
};
