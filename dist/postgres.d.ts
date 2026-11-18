import { type Backend } from './backend.js';
/** How to reach the database. On Cloudflare Workers, pass Hyperdrive's connection string as `url`. */
export interface PostgresSettings {
    url: string;
    /** Connections at most, per session (default 5). */
    max?: number;
    /** The setting the database's row-level security reads for the person (default `app.user_id`). */
    personSetting?: string;
    /** Run every unit as this database role (`set local role`), for a database user that may switch to it. */
    role?: string;
    /**
     * The role system units run as (ADR 0009): one the database lets past row-level security for the tables system
     * intents reach. Without it, system units are refused.
     */
    systemRole?: string;
}
/** The Postgres backend. */
export declare const postgres: Backend<PostgresSettings>;
