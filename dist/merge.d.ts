import type { Fields } from './protocol.js';
export interface Side {
    fields: Fields;
    deleted_at: string | null;
    client_updated_at: string | null;
}
/** JSON with object keys sorted, so the same value always prints the same (Postgres jsonb reorders keys). */
export declare function canonical(v: unknown): string;
export declare function merge3(base: Side, local: Side, server: Side): Side;
