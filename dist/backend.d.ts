import type { Kind } from './declare.js';
/** A stored row: the sync columns, the type's own columns, and `content` (an object). */
export type Row = Record<string, unknown>;
/** A unit for one signed-in person: their id, as the app's auth verified it. The engine does nothing else with tokens. */
export interface PersonScope {
    readonly person: string;
}
/**
 * A unit for work that isn't one person's (ADR 0009): a system intent the app declared, by name, and who asked for it
 * when someone did (an owner). It may touch only the types its declaration names, and every intent in it is audited.
 */
export interface SystemScope {
    readonly system: string;
    readonly by?: string;
}
export type Scope = PersonScope | SystemScope;
export declare const isSystem: (s: Scope) => s is SystemScope;
/**
 * How an app's data is laid out, from its declarations (ADR 0014): each table, its columns by kind, and its key. Where
 * the tables are (a Postgres schema, say) is the backend's setting, not the app's.
 */
export interface Layout {
    /** The record types, one table each. */
    readonly types: readonly string[];
    /** Every type the app declared beyond the record types (server and shared types), so a backend refuses others. */
    readonly tables?: readonly string[];
    /**
     * Each type, by name, from the declarations: its table, columns by kind, key, who its rows belong to, and its query
     * fields. Units name types; the backend finds each type's table (and, by its settings, where the table is).
     */
    readonly columns?: Readonly<Record<string, TableLayout>>;
}
/** One table, as the backend needs it to write values by kind and to make or adopt the table (ADR 0014). */
export interface TableLayout {
    /** The table's name (a type's own name unless it declared another). */
    readonly table: string;
    /** A view the app defines: read only, checked by a schema plan, never made. */
    readonly view?: true;
    /** A person type people only read: their role gets read grants only. */
    readonly personReads?: true;
    readonly kinds: Readonly<Record<string, Kind>>;
    readonly key: readonly string[];
    /** `record` (synced from devices), or a declared type's access. */
    readonly access: 'record' | 'person' | 'shared' | 'system';
    /** The column naming a row's person, for record and person tables. */
    readonly person?: string;
    /** Columns a find filters and orders by (indexed). */
    readonly query?: readonly string[];
    /** Values inside JSON columns, by name: a condition, group or measure on one reads it from its column. */
    readonly paths?: Readonly<Record<string, {
        readonly from: string;
        readonly path: readonly string[];
        readonly kind: 'text' | 'number' | 'boolean';
    }>>;
}
/** A database rule refused a write (a check, a unique key, a reference). The core decides what that means for the op. */
export declare class RuleError extends Error {
    /** The rule's name, when the database gives one (a constraint name). */
    readonly rule: string;
    /** `reference`: a row it points at is missing; `rule`: anything else (a check, a unique key, not null). */
    readonly kind: 'reference' | 'rule';
    constructor(rule: string, kind: 'reference' | 'rule');
}
/** One tombstone to write in bulk: the record, its new change number, and the device's time for the change. */
export interface Tombstone {
    id: string;
    rev: bigint;
    clientUpdatedAt: string | null;
}
/** One condition on a column. The core builds these from declared fields only; the backend writes them as it must. */
export type Cond = {
    col: string;
    op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
    value: unknown;
} | {
    col: string;
    op: 'in' | 'nin';
    value: readonly unknown[];
} | {
    col: string;
    op: 'null' | 'notnull';
};
/** A read of rows from one table (ADR 0003's find and count). */
export interface Query {
    table: string;
    /** Keep to this person's rows (through `personColumn`), or null for no person filter (system units, app-wide types). */
    person: string | null;
    personColumn: string;
    where: readonly Cond[];
    /** Order by one column, then by `key` to break ties; and continue after these values (a cursor), when given. */
    order?: {
        col: string;
        desc: boolean;
    };
    key: readonly string[];
    after?: readonly unknown[];
    limit?: number;
}
/** A summary (ADR 0016): conditions, groups and measures on checked columns (a column or a declared path's name). */
export interface SummaryQuery {
    table: string;
    person: string | null;
    personColumn: string;
    where: readonly Cond[];
    by: readonly ({
        col: string;
        as: string;
    } | {
        day: string;
        zone: string;
        as: string;
    })[];
    measures: readonly {
        as: string;
        fn: 'count' | 'distinct' | 'sum' | 'avg' | 'min' | 'max' | 'percentile';
        col?: string;
        p?: number;
        where: readonly Cond[];
    }[];
    order?: {
        as: string;
        desc: boolean;
    };
    limit: number;
}
/** What a system unit did, for the audit log (ADR 0009). Counts and names only, never content. */
export interface AuditEntry {
    intent: string;
    by: string | null;
    type: string;
    action: 'get' | 'find' | 'count' | 'summarize' | 'put' | 'update' | 'remove';
    rows: number;
}
/** One unit of work's view of the database: a transaction, kept to one person (or a declared system intent). */
export interface Unit {
    /** Runs `fn` so that if it throws, only what it did is undone (a savepoint inside the unit). */
    savepoint<R>(fn: (u: Unit) => Promise<R>): Promise<R>;
    /** One record's row, or null. `lock` holds it until the unit ends. */
    getRow(type: string, id: string, lock?: boolean): Promise<Row | null>;
    /** Several records' rows (those that exist), in no particular order. */
    getRows(type: string, ids: readonly string[], lock?: boolean): Promise<Row[]>;
    /** Writes new rows (each with its `rev` and `content`); returns them as stored. A refused write throws RuleError. */
    insertRows(type: string, rows: readonly Row[]): Promise<Row[]>;
    /** Changes one row's columns (and `content`); returns it as stored. A refused write throws RuleError. */
    updateRow(type: string, id: string, cols: Row): Promise<Row>;
    /** Tombstones rows in one go: deleted_at and updated_at `now`, version + 1, each its own rev; returns them as stored. */
    tombstoneRows(type: string, items: readonly Tombstone[], now: string): Promise<Row[]>;
    /** Reserves `n` change numbers in a row for the person and returns the first. */
    nextRevs(n: number): Promise<bigint>;
    /** The change number below which tombstones have been cleaned up (0 when never). */
    purgedRev(): Promise<number>;
    /** Rows of any of `types` changed after `since`, in change order, at most `limit`. */
    changesSince(types: readonly string[], since: number, limit: number): Promise<{
        type: string;
        row: Row;
    }[]>;
    /** The kept result of an op, if it was applied before. */
    appliedResult(opId: string): Promise<unknown | undefined>;
    /** Which of these ops were applied before. */
    appliedOpIds(opIds: readonly string[]): Promise<Set<string>>;
    /** Keeps ops' results, so a repeat returns them. */
    saveResults(list: readonly {
        op_id: string;
        result: unknown;
    }[]): Promise<void>;
    /** The person's prefs document and its version, or null when there is none. `lock` holds it until the unit ends. */
    getPrefs(lock?: boolean): Promise<{
        data: unknown;
        version: number;
    } | null>;
    /** Writes the prefs document: the first version, or the next one; returns the new version. */
    putPrefs(data: unknown, existed: boolean): Promise<number>;
    /** Rows matching a query (any table the app declared). */
    select(q: Query): Promise<Row[]>;
    /** How many rows match a query (its order, cursor and limit are ignored). */
    count(q: Query): Promise<number>;
    /**
     * Writes one row; returns it as stored. A refused write throws RuleError. With `onConflict`, a row whose key is taken
     * instead updates the given columns (`update`, returning the row) or is left as it is (`nothing`, returning null).
     */
    insert(table: string, row: Row, onConflict?: {
        key: readonly string[];
        action: 'update' | 'nothing';
    }): Promise<Row | null>;
    /** Groups and measures of the rows a summary keeps. */
    summarize(q: SummaryQuery): Promise<Row[]>;
    /** Holds a named lock until the unit ends: another unit asking for the same name waits. */
    lock(name: string): Promise<void>;
    /** Changes the row matching `match` (all conditions); returns it as stored, or null when none matches. */
    update(table: string, match: readonly Cond[], cols: Row): Promise<Row | null>;
    /** Removes the rows matching `match`; returns how many. */
    remove(table: string, match: readonly Cond[]): Promise<number>;
    /** Records one audited intent of a system unit. */
    audit(entry: AuditEntry): Promise<void>;
}
/** A backend's connection for one request (on Cloudflare Workers, nothing outlives a request). */
export interface Connection {
    /** Opens a unit (a transaction) for `scope` and runs `fn` in it; commits if it returns, rolls back if it throws. */
    unit<R>(scope: Scope, fn: (u: Unit) => Promise<R>): Promise<R>;
    /** Lets the connection go. */
    close(): Promise<void>;
}
/** What making or adopting an app's tables takes (ADR 0006): steps to read before they run, and what only a person can settle. */
export interface SchemaPlan {
    /** Additive steps, in order: each a line for the owner and the backend's statement. */
    readonly steps: readonly {
        readonly summary: string;
        readonly sql: string;
    }[];
    /** Differences the engine leaves alone (a column of another type): a code each, never a value. */
    readonly conflicts: readonly {
        readonly table: string;
        readonly column?: string;
        readonly issue: string;
        readonly want?: string;
        readonly have?: string;
    }[];
}
/** A database the engine can run on (ADR 0004). `S` is its connection settings. */
export interface Backend<S> {
    readonly kind: string;
    connect(settings: S, layout: Layout): Connection;
    /** The tables an app's layout needs, against what the database has; and applying such a plan. */
    readonly schema?: {
        plan(settings: S, layout: Layout): Promise<SchemaPlan>;
        apply(settings: S, plan: SchemaPlan): Promise<void>;
    };
}
