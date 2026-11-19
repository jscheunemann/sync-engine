# 0020. Views system intents may remove rows from

- Status: Accepted
- Date: 2026-11-18
- Amends: 0018 (views are read only, unless declared removable)

## Context

Fitness Tracker reads Auth's users (emails, sign-in times, whether an account still exists), and deleting an account
deletes the person's Auth user. The owner chose to reach them through the engine rather than Auth's admin API, which
would have put the service_role key in the Worker.

Auth's own table mustn't be declared directly: a schema plan would turn on row-level security there, and Auth would
stop working. So the app's migration defines a narrow view over it (id, email, sign-in times), and the engine reads
that. Deleting an account is the one write, and it removes the row.

## Decision

- **`view: { remove: true }` on a `system` type** is a view that system intents writing it may remove rows from, by
  key. Puts and updates are still refused (`read_only`), and person scopes never reach it (it's `system`).
- **The schema plan grants the system role `select` and `delete` on such a view,** and nothing else. It still never
  makes, alters or secures the view: those stay the app's migration's.
- **Any other `view` value, or a removable view on a non-system type, is refused** when the engine is made.

## Consequences

- Fitness Tracker's account deletion and its owner screens reach Auth's users through a named, audited system intent
  and a view over four columns. No admin key goes in the Worker, and no grant on Auth's table goes to the Worker's role.
- The view's definition (which columns of Auth's table the app sees) sits in the app's migrations, where the owner
  reviews it.
