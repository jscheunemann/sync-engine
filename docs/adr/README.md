# Decisions

Architecture decisions for the sync engine, one file each, append-only: an accepted ADR is never edited except its
Status line; a later ADR supersedes or amends it. **Proposed** ADRs are drafts for the owner: nothing is built on one
until it is accepted.

The engine had no ADR log before 0001; its earlier decisions live in the apps' logs (Clearwork 0096, 0185) and in
`README.md`. 0002 to 0011 together change what the engine is: from a sync library that borrows the app's database
connection to the layer that owns all of an app's data access.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-record-decisions-here.md) | Record the engine's decisions here | Accepted |
| [0002](0002-the-engine-owns-data-access.md) | The engine owns data access; apps send settings and intents | Accepted |
| [0003](0003-apps-speak-in-intents.md) | Apps speak in intents, never SQL | Accepted |
| [0004](0004-backends-are-engine-plugins.md) | Databases and drivers are the engine's plugins | Accepted |
| [0005](0005-one-contract-for-every-backend.md) | One contract suite every backend passes; a second backend proves it | Accepted |
| [0006](0006-schema-from-declarations.md) | Schema and migrations come from the apps' declarations | Accepted |
| [0007](0007-isolation-is-the-engines-job.md) | Per-person isolation is enforced by the engine | Accepted |
| [0008](0008-units-of-work.md) | Units of work replace shared transactions | Accepted |
| [0009](0009-scopes-and-system-intents.md) | Every call carries a scope; cross-person access is a named, audited system intent | Accepted |
| [0010](0010-encryption-stays-pluggable.md) | Encryption stays the app's, as hooks the engine calls | Accepted |
| [0011](0011-version-2-and-the-move.md) | Version 2.0.0, and moving the apps one at a time | Accepted |
| [0012](0012-declared-types-and-their-intents.md) | Declared types: find on declared fields, versioned updates, and the audit table | Accepted |
| [0013](0013-one-backend-for-both-driver-majors.md) | One Postgres backend for driver majors 3 and 4; the pin moves at 2.0.0 | Accepted |
| [0014](0014-records-and-tables-from-declarations.md) | Records and tables from declarations: no app code sees a column | Accepted |
| [0015](0015-sqlite-proves-the-contract.md) | SQLite proves the contract, as a test backend only | Accepted |
