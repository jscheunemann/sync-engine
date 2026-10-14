// The device engine against an in-memory server with the same rules as the Postgres one (versions, revs, conflicts,
// op ids, tombstones, an expiring cursor), so the model is checked without a database. test/server.test.ts runs the
// same kind of scenarios against Postgres.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adoptByName, emptyState, key, sync, type Recs, type SyncInput, type SyncState } from '../src/device.ts';
import type { Fields, Op, OpResult, ServerRecord, Transport } from '../src/protocol.ts';
import { uuidv7 } from '../src/ids.ts';

type T = 'notes' | 'lists';
const FIELDS: Record<T, string[]> = { notes: ['title', 'body', 'list_id'], lists: ['name'] };

class MemServer {
  rows = new Map<string, ServerRecord & { type: T }>();
  applied = new Map<string, OpResult>();
  rev = 0;
  purgedRev = 0;
  prefs = { data: {} as Fields, version: 0 };
  clock = 0;
  pushes = 0;
  fail = false;
  now() {
    return new Date(Date.UTC(2026, 9, 14, 12, 0, this.clock++)).toISOString();
  }
  apply(op: Op): OpResult {
    const done = this.applied.get(op.op_id);
    if (done) return { ...done, status: 'duplicate' } as OpResult;
    const k = key(op.type, op.id);
    const cur = this.rows.get(k);
    const now = this.now();
    let res: OpResult;
    if (!cur) {
      if (op.base_version !== null) return { op_id: op.op_id, status: 'not_found' };
      const fields: Fields = Object.fromEntries(FIELDS[op.type as T].map((n) => [n, null]));
      Object.assign(fields, op.fields);
      if (fields.title === 'BAD') return { op_id: op.op_id, status: 'invalid', problems: [{ field: 'title', code: 'not_allowed' }] };
      const row = { ...fields, type: op.type as T, id: op.id, version: 1, rev: ++this.rev, created_at: op.created_at ?? now, updated_at: now, client_updated_at: op.client_updated_at ?? null, deleted_at: op.delete ? now : null };
      this.rows.set(k, row);
      res = { op_id: op.op_id, status: 'applied', record: structuredClone(row) };
    } else {
      if (op.base_version !== cur.version) return { op_id: op.op_id, status: 'conflict', current: structuredClone(cur) };
      if (op.fields?.title === 'BAD') return { op_id: op.op_id, status: 'invalid', problems: [{ field: 'title', code: 'not_allowed' }] };
      Object.assign(cur, op.fields ?? {});
      cur.version++;
      cur.rev = ++this.rev;
      cur.updated_at = now;
      cur.client_updated_at = op.client_updated_at ?? cur.client_updated_at;
      if (op.delete === true) cur.deleted_at ??= now;
      if (op.delete === false) cur.deleted_at = null;
      res = { op_id: op.op_id, status: 'applied', record: structuredClone(cur) };
    }
    this.applied.set(op.op_id, res);
    return res;
  }
  /** Removes tombstones, as a clean-up job would; devices behind it must read everything again. */
  purge() {
    for (const [k, r] of this.rows) if (r.deleted_at) this.rows.delete(k);
    this.purgedRev = this.rev;
  }
  transport(): Transport<T> {
    return {
      push: async (ops) => {
        if (this.fail) throw new Error('offline');
        this.pushes++;
        return ops.map((o) => this.apply(o));
      },
      changes: async (since) => {
        if (this.fail) throw new Error('offline');
        if (since > 0 && since < this.purgedRev) throw Object.assign(new Error('cursor_expired'), { status: 410 });
        const all = [...this.rows.values()].filter((r) => r.rev > since).sort((a, b) => a.rev - b.rev);
        const page = all.slice(0, 2); // small pages, so paging is exercised
        return { changes: page.map((r) => ({ type: r.type, record: structuredClone(r) })), next: all.length > 2 ? page[page.length - 1]!.rev : null };
      },
      getPrefs: async () => structuredClone(this.prefs),
      putPrefs: async (data, base) => {
        if (base !== this.prefs.version) return { conflict: structuredClone(this.prefs) };
        this.prefs = { data: structuredClone(data), version: this.prefs.version + 1 };
        return structuredClone(this.prefs);
      },
    };
  }
}

/** A device: its records, prefs and sync state, and a clock for when edits are made. */
class Device {
  recs: Recs<T> = new Map();
  prefs: Fields = {};
  state: SyncState<T> = emptyState();
  t = 0;
  readonly server: MemServer;
  readonly name: string;
  readonly extra: Partial<SyncInput<T>>;
  constructor(server: MemServer, name: string, extra: Partial<SyncInput<T>> = {}) {
    this.server = server;
    this.name = name;
    this.extra = extra;
  }
  set(type: T, id: string, fields: Fields) {
    const k = key(type, id);
    const cur = this.recs.get(k);
    this.recs.set(k, { type, id, fields: { ...Object.fromEntries(FIELDS[type].map((n) => [n, null])), ...cur?.fields, ...fields } });
  }
  get(type: T, id: string) {
    return this.recs.get(key(type, id))?.fields;
  }
  async sync(at?: string) {
    const now = at ?? new Date(Date.UTC(2026, 9, 14, 13, 0, this.t++)).toISOString();
    const r = await sync<T>({ recs: this.recs, prefs: this.prefs, state: this.state, transport: this.server.transport(), fieldsOf: (t) => FIELDS[t], now: () => now, ...this.extra });
    this.recs = r.recs;
    this.prefs = r.prefs;
    this.state = r.state;
    return r;
  }
}

test('two devices editing different fields of one record offline keep both edits', async () => {
  const s = new MemServer();
  const a = new Device(s, 'a'), b = new Device(s, 'b');
  const id = uuidv7();
  a.set('notes', id, { title: 'Plan', body: 'v1' });
  await a.sync();
  await b.sync();
  assert.deepEqual(b.get('notes', id), { title: 'Plan', body: 'v1', list_id: null });
  a.set('notes', id, { title: 'Plan A' });
  b.set('notes', id, { body: 'v2' });
  await a.sync();
  const rb = await b.sync(); // conflict: merges with A's newer copy, then pushes again
  assert.equal(rb.error, null);
  await a.sync();
  for (const d of [a, b]) assert.deepEqual(d.get('notes', id), { title: 'Plan A', body: 'v2', list_id: null }, d.name);
  assert.equal(s.rows.get(key('notes', id))!.version, 3);
});

test('the same field changed on both devices: the later edit wins', async () => {
  const s = new MemServer();
  const a = new Device(s, 'a'), b = new Device(s, 'b');
  const id = uuidv7();
  a.set('notes', id, { title: 'one' });
  await a.sync();
  await b.sync();
  b.set('notes', id, { title: 'from b, later' });
  a.set('notes', id, { title: 'from a, earlier' });
  await a.sync('2026-10-14T13:00:00Z');
  await b.sync('2026-10-14T14:00:00Z');
  await a.sync('2026-10-14T15:00:00Z');
  assert.equal(a.get('notes', id)!.title, 'from b, later');
  assert.equal(b.get('notes', id)!.title, 'from b, later');
});

test('a deletion beats an older edit; an edit made after the deletion brings it back', async () => {
  const s = new MemServer();
  const a = new Device(s, 'a'), b = new Device(s, 'b');
  const x = uuidv7(), y = uuidv7();
  a.set('notes', x, { title: 'x' });
  a.set('notes', y, { title: 'y' });
  await a.sync();
  await b.sync();
  // both deleted on a at 13:00; on b, x was edited at 12:00 (before) and y at 16:00 (after)
  a.recs.delete(key('notes', x));
  a.recs.delete(key('notes', y));
  await a.sync('2026-10-14T13:00:00Z');
  b.set('notes', x, { title: 'x edited before' });
  await b.sync('2026-10-14T12:00:00Z');
  assert.equal(b.get('notes', x), undefined, 'the older edit loses to the deletion');
  b.set('notes', y, { title: 'y edited after' });
  await b.sync('2026-10-14T16:00:00Z');
  assert.equal(s.rows.get(key('notes', y))!.deleted_at, null, 'the newer edit revives it on the server');
  await a.sync('2026-10-14T17:00:00Z');
  assert.equal(a.get('notes', y)?.title, 'y edited after', 'a newer edit revives it');
});

test('a new device pulls first and adopts records it made that the server already has, by name', async () => {
  const s = new MemServer();
  const a = new Device(s, 'a');
  const inbox = uuidv7();
  a.set('lists', inbox, { name: 'Inbox' });
  await a.sync();
  const b = new Device(s, 'b', { adopt: adoptByName<T>('lists', 'name') });
  const myInbox = uuidv7(), note = uuidv7();
  b.set('lists', myInbox, { name: 'inbox' });
  b.set('notes', note, { title: 'in my inbox', list_id: myInbox });
  await b.sync();
  assert.equal([...s.rows.values()].filter((r) => r.type === 'lists').length, 1, 'no second Inbox');
  assert.equal(b.get('notes', note)!.list_id, inbox, 'references now point at the server’s list');
  assert.equal(s.rows.get(key('notes', note))!.list_id, inbox);
});

test('a refused record doesn’t hold up the others and isn’t sent again until it changes', async () => {
  const s = new MemServer();
  const a = new Device(s, 'a');
  const bad = uuidv7(), good = uuidv7();
  a.set('notes', bad, { title: 'BAD' });
  a.set('notes', good, { title: 'fine' });
  const r = await a.sync();
  assert.deepEqual(r.refused.map((x) => x.key), [key('notes', bad)]);
  assert.ok(s.rows.has(key('notes', good)));
  const before = s.pushes;
  await a.sync();
  assert.equal(s.pushes, before, 'nothing new to send');
  a.set('notes', bad, { title: 'now fine' });
  await a.sync();
  assert.equal(s.rows.get(key('notes', bad))!.title, 'now fine');
});

test('the same op sent twice is applied once', async () => {
  const s = new MemServer();
  const op: Op = { op_id: uuidv7(), type: 'notes', id: uuidv7(), base_version: null, fields: { title: 't' } };
  const t = s.transport();
  const [first] = await t.push([op]);
  const [again] = await t.push([op]);
  assert.equal(first!.status, 'applied');
  assert.equal(again!.status, 'duplicate');
  assert.equal(s.rev, 1);
});

test('offline: the sync stops, keeps what it did, and finishes next time', async () => {
  const s = new MemServer();
  const a = new Device(s, 'a');
  const id = uuidv7();
  a.set('notes', id, { title: 'offline' });
  s.fail = true;
  const r = await a.sync();
  assert.ok(r.error);
  assert.equal(s.rows.size, 0);
  s.fail = false;
  assert.equal((await a.sync()).error, null);
  assert.equal(s.rows.get(key('notes', id))!.title, 'offline');
});

test('a cursor older than a clean-up reads everything again and drops what the server no longer has', async () => {
  const s = new MemServer();
  const a = new Device(s, 'a'), b = new Device(s, 'b');
  const keep = uuidv7(), gone = uuidv7();
  a.set('notes', keep, { title: 'keep' });
  a.set('notes', gone, { title: 'gone' });
  await a.sync();
  await b.sync();
  a.recs.delete(key('notes', gone));
  await a.sync();
  s.purge();
  a.set('notes', keep, { title: 'keep, edited' });
  await a.sync();
  const r = await b.sync();
  assert.equal(r.error, null);
  assert.equal(b.get('notes', gone), undefined);
  assert.equal(b.get('notes', keep)!.title, 'keep, edited');
});

test('prefs: settings changed on two devices merge key by key', async () => {
  const s = new MemServer();
  const a = new Device(s, 'a'), b = new Device(s, 'b');
  a.prefs = { theme: 'dark', units: 'lb' };
  await a.sync();
  await b.sync();
  assert.deepEqual(b.prefs, { theme: 'dark', units: 'lb' });
  a.prefs = { ...a.prefs, theme: 'light' };
  b.prefs = { ...b.prefs, units: 'kg' };
  await a.sync();
  await b.sync();
  await a.sync();
  assert.deepEqual(a.prefs, { theme: 'light', units: 'kg' });
  assert.deepEqual(b.prefs, { theme: 'light', units: 'kg' });
});

test('stabilize: a coarser copy that still agrees with the server is not a change', async () => {
  const s = new MemServer();
  const day = (v: unknown) => (typeof v === 'string' ? v.slice(0, 10) : v);
  const a = new Device(s, 'a', { stabilize: (_t, local, server) => (day(local.title) === day(server.title) ? { ...local, title: server.title } : local) });
  const id = uuidv7();
  a.set('notes', id, { title: '2026-10-14T09:30:00Z' });
  await a.sync();
  a.set('notes', id, { title: '2026-10-14' }); // the screen only keeps the date
  const pushes = s.pushes;
  await a.sync();
  assert.equal(s.pushes, pushes, 'nothing sent');
  assert.equal(s.rows.get(key('notes', id))!.title, '2026-10-14T09:30:00Z');
});
