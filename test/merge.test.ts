import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical, merge3 } from '../src/merge.ts';
import { mergeKeys, rebase, type Rec, type Recs } from '../src/device.ts';
import { nameId, uuidv7 } from '../src/ids.ts';
import type { Fields } from '../src/protocol.ts';

const side = (fields: Fields, at: string, deleted_at: string | null = null) => ({ fields, client_updated_at: at, deleted_at });

test('merge3: one-sided changes take that side; both-sided take the later edit', () => {
  const base = side({ title: 'A', notes: 'n', minutes: 5 }, 't0');
  const local = side({ title: 'A2', notes: 'n', minutes: 10 }, '2026-10-12T10:00:00Z');
  const server = side({ title: 'A', notes: 'n2', minutes: 15 }, '2026-10-12T09:00:00Z');
  assert.deepEqual(merge3(base, local, server).fields, { title: 'A2', notes: 'n2', minutes: 10 });
});

test('merge3: the server wins a tie', () => {
  const at = '2026-10-12T10:00:00Z';
  assert.deepEqual(merge3(side({ x: 1 }, 't0'), side({ x: 2 }, at), side({ x: 3 }, at)).fields, { x: 3 });
});

test('merge3: a deletion beats an older edit, and a newer edit revives', () => {
  const base = side({ title: 'A' }, '2026-10-12T08:00:00Z');
  const deleted = side({ title: 'A' }, '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z');
  const olderEdit = side({ title: 'B' }, '2026-10-12T09:00:00Z');
  const newerEdit = side({ title: 'B' }, '2026-10-12T11:00:00Z');
  assert.equal(merge3(base, olderEdit, deleted).deleted_at, '2026-10-12T10:00:00Z');
  assert.equal(merge3(base, newerEdit, deleted).deleted_at, null);
  assert.equal(merge3(base, deleted, newerEdit).deleted_at, null);
  assert.equal(merge3(base, deleted, olderEdit).deleted_at, '2026-10-12T10:00:00Z');
});

test('canonical ignores key order, so a jsonb round trip compares equal', () => {
  assert.equal(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), canonical({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
});

test('mergeKeys: setting by setting, into nested objects; this device’s change wins a tie', () => {
  const base = { prefs: { me: 'Me', dayHours: 8 }, plan: null };
  const local = { prefs: { me: 'Me', dayHours: 6 }, plan: { date: '2026-10-12' } };
  const server = { prefs: { me: 'Jason', dayHours: 8 }, plan: { date: '2026-10-11' } };
  assert.deepEqual(mergeKeys(local, base, server), { prefs: { me: 'Jason', dayHours: 6 }, plan: { date: '2026-10-12' } });
});

test('rebase keeps edits made while a sync was in flight, field by field', () => {
  const r = (id: string, fields: Record<string, unknown>): [string, Rec] => [`areas:${id}`, { type: 'areas', id, fields }];
  const before: Recs = new Map([r('1', { title: 'A', standard: null }), r('2', { title: 'B', standard: null })]);
  const now: Recs = new Map([r('1', { title: 'A2', standard: null }), r('3', { title: 'New', standard: null })]); // edited 1, deleted 2, added 3
  const synced: Recs = new Map([r('1', { title: 'A', standard: 'from server' }), r('2', { title: 'B', standard: null }), r('4', { title: 'Pulled', standard: null })]);
  const out = rebase(before, now, synced);
  assert.deepEqual(out.get('areas:1')!.fields, { title: 'A2', standard: 'from server' });
  assert.equal(out.has('areas:2'), false);
  assert.equal(out.get('areas:3')!.fields.title, 'New');
  assert.equal(out.get('areas:4')!.fields.title, 'Pulled');
});

test('ids: UUIDv7 sorts by time; nameId is the same for the same parts on any device', () => {
  const a = uuidv7(1_700_000_000_000), b = uuidv7(1_700_000_000_001);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a < b);
  assert.equal(nameId('plan', '2026-10-12'), nameId('plan', '2026-10-12'));
  assert.notEqual(nameId('plan', '2026-10-12'), nameId('plan', '2026-10-13'));
  assert.match(nameId('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-8/);
});
