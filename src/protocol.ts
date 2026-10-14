// The sync protocol shared by every app on this engine: what a record looks like on the wire, the ops a device sends
// (POST /sync/push), what each op comes back as, and the change feed (GET /sync/changes). See README.md for the model.

export type Fields = Record<string, unknown>;

/** One problem with a record or an op: the field (or op key) and a short code, never the value. */
export interface Problem {
  field: string;
  code: string;
}

/** A record as the server stores and returns it: the app's fields plus the sync columns. */
export interface ServerRecord {
  id: string;
  /** Changes to this row so far; a write must name the version it was based on (optimistic concurrency). */
  version: number;
  /** The person's change counter when this row last changed; a device's cursor is the highest rev it has seen. */
  rev: number;
  created_at: string;
  updated_at: string;
  /** When the change was made on the device, for merging (the later edit wins a field both sides changed). */
  client_updated_at: string | null;
  /** A tombstone: rows are never deleted by the API. */
  deleted_at: string | null;
  [field: string]: unknown;
}

/** One change a device sends. */
export interface Op {
  /** A fresh UUID per op; sending the same op again returns its first result (idempotency). */
  op_id: string;
  type: string;
  id: string;
  /** null: create. n: change or delete the record at version n; anything else is a conflict. */
  base_version: number | null;
  /** The fields that changed (all of them on create). */
  fields?: Fields;
  /** true tombstones; false brings a tombstone back. */
  delete?: boolean;
  client_updated_at?: string | null;
  /** When the record was made on the device. Only used when the op creates the record. */
  created_at?: string | null;
  /** Every field of the device's copy, for a transport that encrypts (never sent as it is). */
  full?: Fields;
  /** Content the device encrypted, with its key's version (apps with end-to-end encryption). */
  sealed?: string;
  key_version?: number;
}

export type OpResult =
  | { op_id: string; status: 'applied' | 'duplicate'; record: ServerRecord; type?: string; id?: string; created?: boolean }
  | { op_id: string; status: 'conflict'; current: ServerRecord | null; type?: string; id?: string }
  | { op_id: string; status: 'not_found'; type?: string; id?: string }
  | { op_id: string; status: 'invalid'; problems: Problem[]; type?: string; id?: string };

/** A page of the change feed: every record changed after the cursor, in rev order. next is null on the last page. */
export interface ChangesPage<T extends string = string> {
  changes: { type: T; record: ServerRecord }[];
  next: number | null;
}

/** How a device reaches the server. An app can wrap one (to encrypt, or to reach iCloud) without the engine knowing. */
export interface Transport<T extends string = string> {
  push(ops: Op[]): Promise<OpResult[]>;
  /** Throws an error with status 410 when the cursor is too old (tombstones it needed were cleaned up). */
  changes(since: number): Promise<ChangesPage<T>>;
  /** `sealed`: the server's copy was encrypted on a device. Version 0: nothing saved yet. */
  getPrefs(): Promise<{ data: Fields; version: number; sealed?: boolean; kv?: number }>;
  /** Resolves with { conflict } instead of throwing when base_version is stale. */
  putPrefs(data: Fields, baseVersion: number): Promise<{ data: Fields; version: number } | { conflict: { data: Fields; version: number } }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
export const isInstant = (v: unknown): v is string => typeof v === 'string' && INSTANT_RE.test(v) && !Number.isNaN(Date.parse(v));

const OP_KEYS = new Set(['op_id', 'type', 'id', 'base_version', 'fields', 'delete', 'client_updated_at', 'created_at', 'sealed', 'key_version']);
const SEALED_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_SEALED = 1_500_000;

/** Checks an op's shape before it touches the database. `isType` says which record types this app has. */
export function checkOp<T extends string>(raw: unknown, isType: (t: unknown) => t is T): { op: Op & { type: T } } | { problems: Problem[]; op_id?: string } {
  const problems: Problem[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problems: [{ field: 'op', code: 'type' }] };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!OP_KEYS.has(k)) problems.push({ field: k, code: 'unknown' });
  if (!isUuid(o.op_id)) problems.push({ field: 'op_id', code: 'type' });
  if (!isType(o.type)) problems.push({ field: 'type', code: 'not_allowed' });
  if (!isUuid(o.id)) problems.push({ field: 'id', code: 'type' });
  if (o.base_version !== null && o.base_version !== undefined && !(Number.isInteger(o.base_version) && (o.base_version as number) >= 1)) {
    problems.push({ field: 'base_version', code: 'type' });
  }
  if (o.fields !== undefined && (!o.fields || typeof o.fields !== 'object' || Array.isArray(o.fields))) problems.push({ field: 'fields', code: 'type' });
  if (o.delete !== undefined && typeof o.delete !== 'boolean') problems.push({ field: 'delete', code: 'type' });
  if (o.client_updated_at !== undefined && o.client_updated_at !== null && !isInstant(o.client_updated_at)) {
    problems.push({ field: 'client_updated_at', code: 'type' });
  }
  if (o.created_at !== undefined && o.created_at !== null && !isInstant(o.created_at)) problems.push({ field: 'created_at', code: 'type' });
  if (o.sealed !== undefined) {
    if (typeof o.sealed !== 'string' || o.sealed.length < 24 || o.sealed.length > MAX_SEALED || !SEALED_RE.test(o.sealed)) problems.push({ field: 'sealed', code: 'type' });
    if (!Number.isInteger(o.key_version) || (o.key_version as number) < 1) problems.push({ field: 'key_version', code: 'type' });
  } else if (o.key_version !== undefined) problems.push({ field: 'key_version', code: 'without_sealed' });
  if (problems.length) return { problems, op_id: isUuid(o.op_id) ? o.op_id : undefined };
  return {
    op: {
      op_id: o.op_id as string,
      type: o.type as T,
      id: (o.id as string).toLowerCase(),
      base_version: (o.base_version as number | null | undefined) ?? null,
      fields: (o.fields as Fields | undefined) ?? undefined,
      delete: o.delete as boolean | undefined,
      client_updated_at: (o.client_updated_at as string | null | undefined) ?? null,
      created_at: (o.created_at as string | null | undefined) ?? null,
      ...(o.sealed !== undefined ? { sealed: o.sealed as string, key_version: o.key_version as number } : {}),
    },
  };
}
