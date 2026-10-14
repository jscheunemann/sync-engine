import { canonical } from './merge.js';
import type { Fields, Op, OpResult, Problem, ServerRecord, Transport } from './protocol.js';
export { canonical };
export type { Op, OpResult, ServerRecord, Transport };
/** A record on the device: its type, id and fields. */
export interface Rec<T extends string = string> {
    type: T;
    id: string;
    fields: Fields;
    /** When it was made. Sent only when the record is created; afterwards the server's value is the one that counts. */
    created_at?: string | null;
    /** From the server. */
    updated_at?: string | null;
}
export type Recs<T extends string = string> = Map<string, Rec<T>>;
/** The key of a record in Recs and in the sync state. */
export declare const key: (type: string, id: string) => string;
export interface Base<T extends string = string> {
    type: T;
    id: string;
    fields: Fields;
    version: number;
    deleted_at: string | null;
    client_updated_at: string | null;
    created_at: string;
    updated_at: string;
    /** How the server stores it: 0 or 1 plaintext to the server, 2 encrypted on the device. */
    enc?: number;
    /** With enc 2: the version of the key it was sealed with (absent in states saved before key rotation existed). */
    kv?: number;
}
export interface SyncState<T extends string = string> {
    cursor: number;
    base: Record<string, Base<T>>;
    /** For each record: a fingerprint of the device's copy and when it was first seen like that. */
    seen: Record<string, {
        h: string;
        at: string;
    }>;
    /** Records the server refused, by fingerprint, so the same refused copy isn't sent again until it changes. */
    refused: Record<string, string>;
    prefs: {
        data: Fields;
        version: number;
    } | null;
    /** The Advanced security mode of the last sync; when it changes, refused records are tried again. */
    sealed?: boolean;
}
export interface SyncInput<T extends string = string> {
    recs: Recs<T>;
    prefs: Fields;
    state: SyncState<T>;
    transport: Transport<T>;
    fieldsOf: (type: T) => readonly string[];
    /**
     * The device's copy with the server's precise values put back wherever the device only keeps a coarser copy that
     * still agrees (a date for a time). Without it every record read from the server would look changed. Default: none.
     */
    stabilize?: (type: T, local: Fields, server: Fields) => Fields;
    /**
     * First sync on a device only: records the device made that are the same thing as one already on the server (a
     * default list with the same name) can be dropped in favour of the server's, rewriting references with
     * `renameRef`. Returns true when it changed anything. `adoptByName` makes the usual one.
     */
    adopt?: (recs: Recs<T>, base: Readonly<Record<string, Base<T>>>, renameRef: (from: string, to: string) => void) => boolean;
    /** The content fields of a type (what end-to-end encryption covers). */
    contentOf?: (type: T) => readonly string[];
    /** End-to-end encryption is on and this device holds the keys: everything with content should end up encrypted. */
    sealed?: boolean;
    /**
     * After a key rotation: the key version a type's records must be sealed with, while earlier ones remain.
     * Records (and the prefs, for 'prefs') sealed with an earlier version are written again, sealed with the new key.
     */
    resealBelow?: (type: T | 'prefs') => number | null;
    now?: () => string;
    newOpId?: () => string;
}
export interface SyncResult<T extends string = string> {
    recs: Recs<T>;
    prefs: Fields;
    state: SyncState<T>;
    /** Something came from the server: the screens should redraw from `recs` and `prefs`. */
    changed: boolean;
    pushed: number;
    pulled: number;
    refused: {
        key: string;
        problems: Problem[];
    }[];
    /** The sync stopped early (offline, signed out, server down); what it did so far is kept. */
    error: unknown;
}
export declare const emptyState: <T extends string = string>() => SyncState<T>;
export declare function sync<T extends string>(input: SyncInput<T>): Promise<SyncResult<T>>;
/** Key by key, into nested objects: what this device changed wins; otherwise the server's. */
export declare function mergeKeys(local: unknown, base: unknown, server: unknown): unknown;
/**
 * The screens may change S while a sync is in flight. `before` is what the sync started from, `now` what the
 * screens hold now, `synced` what the sync produced. Edits made during the sync win field by field; everything else
 * comes from the sync.
 */
export declare function rebase<T extends string>(before: Recs<T>, now: Recs<T>, synced: Recs<T>): Recs<T>;
/**
 * An `adopt` hook for a type whose records are matched by a name (case-insensitive): on a new device, each record it
 * made that has the same name as one on the server is dropped and references to it point at the server's.
 */
export declare function adoptByName<T extends string>(type: T, field: string): NonNullable<SyncInput<T>['adopt']>;
