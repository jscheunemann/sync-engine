export declare function uuidv7(now?: number, random?: (n: number) => Uint8Array): string;
/**
 * A fixed id worked out from its parts, for records that are a pair or a key rather than a thing someone made (a
 * meeting's attendee, an action's dependency, the daily plan for a date). Two devices adding the same pair offline
 * pick the same id, so sync sees one record, not two. UUIDv8 layout; not a security boundary (FNV-1a, not a hash
 * anyone needs to trust).
 */
export declare function nameId(...parts: string[]): string;
