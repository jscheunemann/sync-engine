# DATA-01. Data access belongs to the data layer

- Status: Accepted
- Date: 2026-11-18
- Category: DATA (how systems store and reach their data)

Written for the platform ADR set: no product, domain or vendor names beyond the kinds of thing involved.

## Context

A shared library that borrows each application's database connection ties every application to that database, its
dialect and its driver's major version, and turns a driver upgrade into a joint decision of every application.

## Decision

1. **A data layer owns all data access:** connections, drivers, queries, transactions, schema and migrations,
   per-person isolation and change feeds. Applications never hold a connection or a transaction.
2. **Applications give it connection settings and intents:** a small, declared vocabulary (apply changes, read by id,
   find by declared fields, count, write server-side records, a unit of work). Never query text.
3. **Databases are plugins of the data layer.** Each passes one contract suite, which includes isolation across
   people. A second, unlike backend runs the same suite to prove no database assumption leaked into the core.
4. **Schema comes from declarations;** migrations are planned by the data layer and applied under the owner's control,
   staging first.
5. **Every call carries a scope.** Cross-person access is a named, declared system intent, and is audited.
6. **Content encryption is a hook** the data layer calls for every field declared as content.
7. **The data layer has no peer dependency on any driver.** Applications pin its version and move when they choose.

## Consequences

- Replacing the database, or upgrading its driver, changes no application.
- Applications' server code reduces to rules, routes and hooks.
