import type { Layout, SchemaPlan } from './backend.js';
import type { Kind } from './declare.js';
/** What the database has in one schema, as the plan needs it. */
export interface Catalog {
    schema: boolean;
    /** Table → column → its type (`udt_name`: `text`, `int4`, `_uuid`…). */
    columns: Record<string, Record<string, string>>;
    functions: string[];
    /** Table → whether row-level security is enabled and forced. */
    rls: Record<string, {
        enabled: boolean;
        forced: boolean;
    }>;
    /** Table → its policies' names. */
    policies: Record<string, string[]>;
    indexes: string[];
    /** Table or function (`fn:name`) → role → its privileges, lower case (`select`, `execute`…). */
    grants: Record<string, Record<string, string[]>>;
    /** The roles that may use the schema. */
    usage: string[];
}
export type Plan = SchemaPlan;
export interface PlanOptions {
    schema: string;
    /** The role person units run as, and the system units' role (grants and policies are made for each given). */
    role?: string;
    systemRole?: string;
    /** The setting row-level security reads the person from. */
    personSetting: string;
}
/** The column type each kind gets in a new table or column. */
export declare const PG_TYPE: Readonly<Record<Kind, string>>;
/** The plan for one app's layout against what its schema has. */
export declare function plan(layout: Layout, have: Catalog, o: PlanOptions): Plan;
/** The catalog query, for a backend that runs it (Postgres's: `inspect` in postgres.ts). */
export declare const CATALOG_SQL: {
    schema: string;
    columns: string;
    functions: string;
    rls: string;
    policies: string;
    indexes: string;
    grants: string;
    usage: string;
};
