# 0010. Encryption stays the app's, as hooks the engine calls

- Status: Proposed
- Date: 2026-11-18

## Decision

- **Content encryption stays pluggable,** as `ContentCrypto` is today: the app supplies `seal` and `open` (and, with
  Advanced Data Protection, refuses plaintext); the engine calls them for every field declared as content.
- **Keys never reach the engine's storage logic** beyond what the hooks return, and nothing sealed is ever logged.
- **Which fields are content is part of the declaration** (0006), so a new content field can't be stored unsealed by
  mistake.

## Consequences

- Clearwork's encryption at rest (its ADR 0077) and Advanced Data Protection (0078) keep working unchanged in shape.
