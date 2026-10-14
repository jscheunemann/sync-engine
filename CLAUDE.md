# sync-engine: notes for Claude

The record sync shared by **Clearwork** (github.com/jscheunemann/clearwork) and **Fitness Tracker**
(github.com/jscheunemann/fitness-tracker). Read `README.md` for the model before changing anything.

## Rules

- **Both apps run this code.** A change in behaviour is a change in both apps' sync. Anything that changes what a device
  or the server does (merge rules, what's pushed, conflict handling, the protocol) is a new **major** version and needs
  the owner's go-ahead; additions that change nothing for existing callers are a minor version; fixes a patch.
- **Apps install it from a git tag** (`github:jscheunemann/sync-engine#vX.Y.Z`). After a change: bump `version` in
  `package.json`, `npm run build`, commit `dist/` with the source, merge, then tag `vX.Y.Z` on `main`.
- **`dist/` is committed** and must match the source (CI checks). Node can't strip types inside `node_modules`, so the
  apps need the compiled JavaScript and `.d.ts` files.
- **Nothing app-specific here.** Record types, field rules, columns, encryption and app data mapping belong to each app,
  through `RecordStore`, `ContentCrypto` and the `SyncInput` hooks (`stabilize`, `adopt`).
- **Every rule gets a test**: the in-memory server in `test/device.test.ts`, and the real Postgres path in
  `test/server.test.ts` (needs `TEST_DATABASE_URL`).
- Tests run TypeScript directly with Node's type stripping: relative imports use `.ts`, and no enums, namespaces or
  parameter properties.
- No user data in logs or errors; problems carry a field and a code, never a value.

## Commands

```sh
npm run check   # type-check, tests, build, and dist/ up to date
TEST_DATABASE_URL=postgres://… npm test   # include the Postgres tests
```
