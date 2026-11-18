# 0004. Databases and drivers are the engine's plugins

- Status: Proposed
- Date: 2026-11-18

## Decision

- **The engine's core knows no database.** It turns intents into calls on a small internal **backend** interface:
  begin a unit of work, read and write rows of a declared type, next change number, apply the schema.
- **A backend implements that interface for one database**, using whichever drivers it supports. The first is
  **Postgres**, supporting **Postgres.js 3 and 4** (and `pg`, if ever needed); it chooses by what's installed, and
  a version it doesn't know is refused at start-up with a clear message, never a wrong write.
- **The app picks a backend by kind in its settings** (`{ kind: 'postgres', hyperdrive: env.HYPERDRIVE }`). The engine
  ships its backends as optional entry points (`@jscheunemann/sync-engine/postgres`), so an app loads only the one it
  uses.
- **No peer dependencies.** A backend's driver is the engine's own dependency, pinned and updated by the engine. An app
  never moves its driver for the engine, and Dependabot can't propose an upgrade npm refuses to install.
- **Backend-specific strengths stay inside the backend:** on Postgres, row-level security as a second guard (0007),
  `jsonb`, `next_rev()` in one statement. Another backend meets the same contract (0005) its own way.

## Consequences

- Postgres.js 3 → 4 becomes an engine change: a backend update, its contract tests on both versions, a minor release.
  No app changes.
- Running on Cloudflare Workers through Hyperdrive and on keel's sandbox is the Postgres backend's job, proven by its
  tests and by each app's preview before production.
