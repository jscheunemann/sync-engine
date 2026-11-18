# 0002. The engine owns data access; apps send settings and intents

- Status: Proposed
- Date: 2026-11-18
- Origin: the owner: "The app should only send what's needed to create a connection and the needed sql intents, not
  the connection itself. Could I swap Postgres with MariaDB at the sync engine without impacting implementing apps?"

## Context

Today the app opens the database connection, starts the transaction and hands it to `applyOp`, `readChanges` and the
rest. The engine's public types are the driver's (`Db = postgres.Sql | postgres.TransactionSql`), it calls the
driver's API directly (27 tagged-template queries, `savepoint`, `json`) and it declares `postgres ^3.4.7` as a peer.
So the driver's major version is a joint decision of every app and the engine, and the apps cannot tell the engine
apart from Postgres. Beyond sync, each app's server also reads and writes its own tables directly (members,
invitations, feedback, messages, MCP grants and reviews, keys, analytics, …), so even a perfect engine would leave the
apps tied to Postgres.

The test the owner set: **Postgres could be replaced by another database at the engine, and no app would change.**

## Decision

- **The engine owns everything between an app and its data:** the connection, the driver, the SQL, transactions,
  schema and migrations, per-person isolation and the change feed.
- **An app gives the engine two things:** connection *settings* (a URL, or a platform binding such as Cloudflare
  Hyperdrive, plus a backend kind: 0004) once at start-up, and *intents* (0003) on every call, each with a scope
  (0009).
- **Nothing database-shaped crosses the boundary:** no SQL text, no connection or transaction objects, no driver types
  in the engine's public API, no driver in the apps' `package.json` for the engine's sake.
- **All of an app's server data goes through the engine,** not only synced records: the tables listed above become
  declared types (0003, 0006). An app that still needs its own database access is a gap in the engine to close, not
  an exception to allow.
- The engine is still one library inside each app's Worker. It is not a separate service: no network hop, no new
  deployment.

## Consequences

- The owner's test becomes a contract test (0005), not a promise.
- The package outgrows its name; renaming it (say `data-engine`) is left to the owner and changes nothing here.
- Each app's server code shrinks to its rules, routes and hooks. Moving them is a large change, done one app at a
  time (0011).
