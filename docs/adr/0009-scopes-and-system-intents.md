# 0009. Every call carries a scope; cross-person access is a named, audited system intent

- Status: Proposed
- Date: 2026-11-18

## Context

Some of the apps' server work isn't one person's: an invitation looked up by code before sign-in, the owner reading all
feedback, analytics across viewers, the MCP review queue.

## Decision

- **Every call carries a scope.** A **person scope** names the signed-in person; the app's auth verified them, the
  engine trusts that id and does nothing else with tokens.
- **A system scope is named and narrow:** `system('read_feedback', { by: ownerId })`. The app declares each system
  intent with the types it may touch and whether it reads or writes; the engine refuses anything else.
- **Every system intent is audited** by the engine: who, which intent, when, how many rows, never content.
- **`shared` types** (an app's settings, release lists) are declared as such and are readable by any person scope,
  writable only through a system intent.

## Consequences

- Role checks (who is an owner) stay in the app; the engine enforces that a system intent was declared and records
  that it ran. This is the base for the platform's role-based access and audit decisions.
