import type { Row } from './backend.js';
import { type Kind } from './declare.js';
import type { Fields, Problem, ServerRecord } from './protocol.js';
/** A field: its kind, and whether it's content (what people wrote: kept together, encrypted when the app encrypts). */
export type FieldDecl = Kind | {
    kind: Kind;
    content?: boolean;
};
/** A stored record: its fields, the engine's columns, and `sealed` when the device encrypted its content. */
export interface StoredRecord extends ServerRecord {
    enc: number;
    key_version: number;
    sealed?: string;
}
/** Columns every record table has, by kind, besides the person and the fields. */
export declare const RECORD_COLUMNS: Readonly<Record<string, Kind>>;
/** One record type's mapping, made once from its declaration. */
export declare class RecordType {
    readonly names: readonly string[];
    readonly content: readonly string[];
    /** Each column's kind: the engine's, then the fields stored as columns. */
    readonly columns: Readonly<Record<string, Kind>>;
    /** Columns a find may use. */
    readonly queryable: Readonly<Record<string, Kind>>;
    private readonly fields;
    constructor(name: string, fields: Readonly<Record<string, FieldDecl>>);
    /** Every field null: what a new record starts from when the app gives no defaults. */
    empty(): Fields;
    /** The default shape check, for an app without its own: unknown fields, and values not of their kind. */
    check(changes: Fields): Problem[];
    /** A record's fields as columns, with the content fields gathered in `content`. */
    toColumns(fields: Fields): Row & {
        content: Row;
    };
    /** A row (after the app's crypto opened it), or its JSON form from the change feed, as a record. */
    toRecord(row: Row): StoredRecord;
}
