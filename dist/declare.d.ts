import type { Cond, Row } from './backend.js';
/** The kind of a field: what values it takes, and how it comes back (times as ISO strings, numbers as numbers). */
export type Kind = 'text' | 'number' | 'boolean' | 'time' | 'id' | 'json';
/** A type that isn't synced from devices (ADR 0003): written by the app's server, read through find. */
export interface TypeDecl {
    /** The table, when it isn't the type's name. */
    table?: string;
    /**
     * Who its rows belong to (ADR 0009):
     *   * `person`: each row to one person (a person column); a person scope sees and writes only its own;
     *   * `shared`: to no one, readable by any person, written only by a system intent (an app's settings);
     *   * `system`: to no one, reached only by a system intent (invitations, analytics).
     */
    access: 'person' | 'shared' | 'system';
    /** The column naming a row's person (`person` types; default `user_id`). */
    personColumn?: string;
    /** The key, without the person column: `['id']`, `['version']`, or `[]` for one row per person. */
    key: readonly string[];
    /** The columns the engine may read and write, by kind. Others are left to the table's defaults. */
    fields: Readonly<Record<string, Kind>>;
    /** Fields a find may filter and order by (key fields always may). */
    query?: readonly string[];
    /** A number column the engine uses for optimistic concurrency: an update names the version it saw. */
    version?: string;
    /** `json` fields holding what people wrote: sealed and opened with the app's ContentCrypto (ADR 0010). */
    sealed?: readonly string[];
    /** The associated data a sealed field is sealed with (default `type|key values|field`), to match what's stored. */
    aad?(field: string, row: Row): string;
}
/** A system intent (ADR 0009): which types it may read and which it may write. */
export interface SystemDecl {
    read?: readonly string[];
    write?: readonly string[];
}
/** A condition on one field: a value (equals), or one operator. */
export type Match = string | number | boolean | null | {
    in: readonly unknown[];
} | {
    ne: unknown;
} | {
    gt: unknown;
} | {
    gte: unknown;
} | {
    lt: unknown;
} | {
    lte: unknown;
} | {
    is: null;
} | {
    not: null;
};
export type Where = Readonly<Record<string, Match>>;
export interface FindOptions {
    where?: Where;
    /** A field to order by, ascending; `-field` for descending. Ties go by key. Default: the key. */
    order?: string;
    /** At most this many (default 100, at most 1000). */
    limit?: number;
    /** The `next` of the page before. */
    after?: string;
}
/** A refused intent: a code, and the field when there is one; never a value (no user data in errors). */
export declare class EngineError extends Error {
    readonly code: string;
    readonly field?: string;
    constructor(code: string, field?: string);
}
/** Whether a value is right for a kind (null always is: the table's own rules decide whether it's allowed). */
export declare function fits(kind: Kind, v: unknown): boolean;
/** A stored value as the engine returns it for its kind. */
export declare function out(kind: Kind, v: unknown): unknown;
/** Conditions from a where, against the fields that may be queried (name → column and kind). */
export declare function conditions(where: Where | undefined, fields: ReadonlyMap<string, {
    col: string;
    kind: Kind;
}>): Cond[];
/** A find's cursor: the last row's order value and key values, opaque to the app (base64url JSON). */
export declare const cursor: {
    make: (values: readonly unknown[]) => string;
    read: (s: string) => unknown[];
};
