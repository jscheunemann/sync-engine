import type { Cond, Row } from './backend.js';
/**
 * The kind of a field: what values it takes, how it's stored, and how it comes back (times as ISO strings, numbers as
 * numbers). `ids` is a list of ids; `json` any JSON value. The engine picks each kind's column type (part 4, ADR 0014).
 */
export type Kind = 'text' | 'number' | 'integer' | 'boolean' | 'time' | 'date' | 'id' | 'ids' | 'json';
/** Kinds a find may filter and order by (not lists or JSON). */
export declare const QUERYABLE: readonly Kind[];
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
    /**
     * A view the app's own migrations define (ADR 0018): read like any type, never written; the schema plan checks it's
     * there with the declared columns and never makes it.
     */
    view?: true;
    /**
     * `system` on a person type (ADR 0019): each person reads their own rows, but only system intents write them (a
     * membership, an owner flag). Default: a person writes their own.
     */
    writes?: 'system';
    /** The column naming a row's person (`person` types; default `user_id`). */
    personColumn?: string;
    /** The key, without the person column: `['id']`, `['version']`, or `[]` for one row per person. */
    key: readonly string[];
    /** The columns the engine may read and write, by kind. Others are left to the table's defaults. */
    fields: Readonly<Record<string, Kind>>;
    /** Fields a find may filter and order by (key fields always may). */
    query?: readonly string[];
    /**
     * Values inside a `json` field, by name (ADR 0016): read-only, and usable wherever a query field is (filters, order,
     * a summary's groups and measures). A number or boolean path is null where the stored value isn't one.
     */
    paths?: Readonly<Record<string, {
        from: string;
        path: readonly string[];
        kind: 'text' | 'number' | 'boolean';
    }>>;
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
    nin: readonly unknown[];
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
/** One measure of a summary (ADR 0016), each over the rows its `where` (if any) keeps. */
export type Measure = {
    where?: Where;
} & ({
    count: true;
} | {
    distinct: string;
} | {
    sum: string;
} | {
    avg: string;
} | {
    min: string;
} | {
    max: string;
} | {
    percentile: string;
    p: number;
});
/** A group of a summary: a field, or a time field's local day in a time zone (`YYYY-MM-DD`). */
export type GroupBy = string | {
    day: string;
    zone: string;
    as?: string;
};
export interface SummaryOptions {
    where?: Where;
    by?: readonly GroupBy[];
    measures: Readonly<Record<string, Measure>>;
    /** A measure or group to order by, ascending; `-name` for descending. */
    order?: string;
    /** At most this many groups (default 100, at most 1000). */
    limit?: number;
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
