// Records from declarations (ADR 0014): the engine maps fields to columns and back; no app code sees a column.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordType } from '../src/records.ts';

const t = new RecordType('tasks', { title: 'text', size: 'integer', est: 'number', done: 'boolean', due_at: 'time', tags: 'ids', due: 'json', notes: { kind: 'text', content: true }, steps: { kind: 'json', content: true } });
const row = {
  user_id: 'u', id: 'a', rev: '12', version: 3, created_at: new Date('2026-11-18T10:00:00Z'), updated_at: '2026-11-18T11:00:00+00:00', client_updated_at: null, deleted_at: null,
  enc: 0, key_version: 0, title: 'Plan', size: 2, est: 1.5, done: false, due_at: '2026-11-20T15:00:00Z', tags: '{b1,b2}', due: { kind: 'floating', date: '2026-11-20', time: '09:00' },
  content: { notes: 'words', steps: [1, 2] },
};

test('fields are columns or content, as declared; the engine’s columns are its own', () => {
  assert.deepEqual(t.content, ['notes', 'steps']);
  assert.deepEqual(Object.keys(t.columns).filter((c) => !['id', 'rev', 'version', 'created_at', 'updated_at', 'client_updated_at', 'deleted_at', 'content', 'enc', 'key_version'].includes(c)), ['title', 'size', 'est', 'done', 'due_at', 'tags', 'due']);
  assert.deepEqual(Object.keys(t.queryable).sort(), ['created_at', 'deleted_at', 'done', 'due_at', 'est', 'id', 'rev', 'size', 'title', 'updated_at']);
  const fields = { title: 'Plan', size: 2, est: 1.5, done: false, due_at: '2026-11-20T15:00:00.000Z', tags: ['b1'], due: { kind: 'fixed', at: '2026-11-20T15:00:00.000Z' }, notes: 'words', steps: null };
  assert.deepEqual(t.toColumns(fields), { title: 'Plan', size: 2, est: 1.5, done: false, due_at: '2026-11-20T15:00:00.000Z', tags: ['b1'], due: { kind: 'fixed', at: '2026-11-20T15:00:00.000Z' }, content: { notes: 'words' } });
});

test('a row comes back as a record: times as ISO, numbers as numbers, id lists as arrays, content from content', () => {
  const r = t.toRecord(row);
  assert.deepEqual(
    { ...r },
    { id: 'a', version: 3, rev: 12, created_at: '2026-11-18T10:00:00.000Z', updated_at: '2026-11-18T11:00:00.000Z', client_updated_at: null, deleted_at: null, enc: 0, key_version: 0,
      title: 'Plan', size: 2, est: 1.5, done: false, due_at: '2026-11-20T15:00:00.000Z', tags: ['b1', 'b2'], due: { kind: 'floating', date: '2026-11-20', time: '09:00' }, notes: 'words', steps: [1, 2] },
  );
  assert.deepEqual(t.toRecord({ ...row, tags: [], content: JSON.stringify({ notes: 'x' }) }).tags, []);
  assert.deepEqual(t.toRecord({ ...row, tags: '{}' }).tags, []);
  assert.deepEqual(t.toRecord({ ...row, tags: null }).tags, [], 'no list is an empty list');
});

test('sealed by the device: the ciphertext comes back as sealed, the content fields null', () => {
  const r = t.toRecord({ ...row, enc: 2, key_version: 4, content: { c: 'CIPHER' } });
  assert.equal(r.sealed, 'CIPHER');
  assert.equal(r.notes, null);
  assert.equal(r.title, 'Plan', 'columns are still read');
});

test('the default shape check: unknown fields and values not of their kind', () => {
  assert.deepEqual(t.check({ title: 'x', size: 2, tags: ['a'], due: { any: 1 } }), []);
  assert.deepEqual(t.check({ nope: 1, size: 1.5, tags: ['a,b'], done: 'yes', due_at: 'soon' }), [
    { field: 'nope', code: 'unknown' }, { field: 'size', code: 'invalid' }, { field: 'tags', code: 'invalid' }, { field: 'done', code: 'invalid' }, { field: 'due_at', code: 'invalid' },
  ]);
  assert.deepEqual(t.empty().title, null);
});

test('field names can’t take the engine’s columns or the person, and must be plain names', () => {
  for (const f of ['id', 'rev', 'content', 'user_id', 'sealed', 'enc']) assert.throws(() => new RecordType('x', { [f]: 'text' }), /reserved_field/);
  for (const f of ['Title', 'a-b', '1a', 'a b']) assert.throws(() => new RecordType('x', { [f]: 'text' }), /bad_field_name/);
});
