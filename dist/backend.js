// The backend interface (ADR 0004): what the engine's core asks of a database, and nothing more. The core turns intents
// into these calls; a backend turns them into its own database's queries. No SQL, connection or driver type appears here,
// and a backend never sees an app's rules: it stores and returns rows.
//
// Every call happens inside a unit (one transaction) opened for one scope, and a backend must keep it to that scope's
// person on every read and write (ADR 0007): the core never asks for "all rows".
/** A database rule refused a write (a check, a unique key, a reference). The core decides what that means for the op. */
export class RuleError extends Error {
    /** The rule's name, when the database gives one (a constraint name). */
    rule;
    /** `reference`: a row it points at is missing; `rule`: anything else (a check, a unique key, not null). */
    kind;
    constructor(rule, kind) {
        super('db_rule');
        this.rule = rule;
        this.kind = kind;
    }
}
