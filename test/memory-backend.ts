// A backend in memory, for the intents a declared type takes (find, count, put, update, remove) and the audit log: the
// same contract as Postgres's, so the rules run in every test run, with or without a database. Records, prefs and the
// change feed aren't here (they need Postgres: test/contract.test.ts); part 5 replaces this with SQLite.

import { type Backend, type Cond, isSystem, type Layout, type Query, type Row, RuleError, type Scope, type Unit, type AuditEntry } from '../src/backend.ts';

export interface Memory {
  tables: Map<string, Row[]>;
  audit: (AuditEntry & { at: string })[];
  /** Unique keys per table (columns), besides the declared key; a write breaking one is refused as a database would. */
  unique: Map<string, string[][]>;
}

const norm = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v);

function cmp(a: unknown, b: unknown): number {
  a = norm(a);
  b = norm(b);
  if (a === b) return 0;
  if (a === null || a === undefined) return 1; // nulls last
  if (b === null || b === undefined) return -1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

const eq = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

function holds(row: Row, c: Cond): boolean {
  const v = row[c.col] ?? null;
  switch (c.op) {
    case 'null':
      return v === null;
    case 'notnull':
      return v !== null;
    case 'in':
      return c.value.some((x) => eq(v, x));
    case 'eq':
      return v !== null && eq(v, c.value);
    case 'ne':
      return !eq(v, c.value);
    case 'gt':
      return v !== null && cmp(v, c.value) > 0;
    case 'gte':
      return v !== null && cmp(v, c.value) >= 0;
    case 'lt':
      return v !== null && cmp(v, c.value) < 0;
    case 'lte':
      return v !== null && cmp(v, c.value) <= 0;
  }
}

function matching(rows: Row[], q: Query): Row[] {
  return rows.filter((r) => (q.person === null || r[q.personColumn] === q.person) && q.where.every((c) => holds(r, c)));
}

function sorted(rows: Row[], q: Query): Row[] {
  const dir = q.order?.desc ? -1 : 1;
  const tuple = (r: Row) => [...(q.order ? [r[q.order.col] ?? null] : []), ...q.key.map((k) => r[k])];
  const compare = (a: unknown[], b: unknown[]) => {
    for (let i = 0; i < a.length; i++) {
      const isOrderNull = q.order && i === 0 && (a[0] === null || b[0] === null);
      const c = isOrderNull ? cmp(a[i], b[i]) : dir * cmp(a[i], b[i]);
      if (c) return c;
    }
    return 0;
  };
  let list = [...rows].sort((a, b) => compare(tuple(a), tuple(b)));
  if (q.after) list = list.filter((r) => compare(tuple(r), q.after as unknown[]) > 0);
  return q.limit !== undefined ? list.slice(0, q.limit) : list;
}

export function memoryBackend(mem: Memory, keys: Readonly<Record<string, readonly string[]>>): Backend<Record<string, never>> {
  const unit = (layout: Layout, person: string | null): Unit => {
    const declared = (t: string) => {
      if (!(layout.tables ?? []).includes(t) && !layout.types.includes(t)) throw new Error('unknown_table');
      if (!mem.tables.has(t)) mem.tables.set(t, []);
      return mem.tables.get(t)!;
    };
    const no = () => {
      throw new Error('not_in_memory');
    };
    /** A row against the others in its table: a key or unique column taken is refused, as a database refuses it. */
    const clash = (t: string, others: Row[], row: Row) => {
      for (const cols of [keys[t] ?? ['id'], ...(mem.unique.get(t) ?? [])]) if (others.some((r) => cols.every((c) => eq(r[c], row[c])))) throw new RuleError(`${t}_${cols.join('_')}_key`, 'rule');
    };
    const u: Unit = {
      savepoint: async (fn) => {
        const copy = structuredClone(mem.tables);
        try {
          return await fn(u);
        } catch (e) {
          mem.tables = copy;
          throw e;
        }
      },
      getRow: no, getRows: no, insertRows: no, updateRow: no, tombstoneRows: no, nextRevs: no, purgedRev: no, changesSince: no,
      appliedResult: no, appliedOpIds: no, saveResults: no, getPrefs: no, putPrefs: no,
      select: async (q) => structuredClone(sorted(matching(declared(q.table), q), q)),
      count: async (q) => matching(declared(q.table), q).length,
      insert: async (t, row) => {
        const rows = declared(t);
        const r: Row = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, norm(v)]));
        clash(t, rows, r);
        rows.push(r);
        return structuredClone(r);
      },
      update: async (t, match, changes) => {
        const rows = declared(t);
        const r = rows.find((x) => match.every((c) => holds(x, c)));
        if (!r) return null;
        const next = { ...r, ...Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, norm(v)])) };
        clash(t, rows.filter((x) => x !== r), next);
        Object.assign(r, next);
        return structuredClone(r);
      },
      remove: async (t, match) => {
        const rows = declared(t);
        const keep = rows.filter((x) => !match.every((c) => holds(x, c)));
        const n = rows.length - keep.length;
        mem.tables.set(t, keep);
        return n;
      },
      audit: async (a) => {
        mem.audit.push({ ...a, at: new Date().toISOString() });
      },
    };
    return u;
  };
  return {
    kind: 'memory',
    connect: (_s, layout) => ({
      unit: async <R>(scope: Scope, fn: (u: Unit) => Promise<R>) => {
        const tables = structuredClone(mem.tables);
        const audit = mem.audit.length;
        try {
          return await fn(unit(layout, isSystem(scope) ? null : scope.person));
        } catch (e) {
          mem.tables = tables;
          mem.audit.length = audit;
          throw e;
        }
      },
      close: async () => {},
    }),
  };
}
