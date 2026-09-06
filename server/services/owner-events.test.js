import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createOwnerEventRepository } from '../modules/database/index.js';

import { createOwnerEventAuthority, OwnerEventError } from './owner-events.js';

const secret = 'board-fixture-secret'.repeat(3);
const event = {
  eventId: 'af112233-4455-4677-8899-aabbccddeeff', source: 'board', type: 'ticket.changed',
  targetId: 'tck-20260907-010203', occurredAt: '2026-09-07T01:02:03+09:00',
  deduplicationKey: 'board:tck-20260907-010203:1',
};
const input = { source: 'board', credential: secret, event };
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gjc-events-'));
  const filename = path.join(directory, 'auth.db');
  let db = new Database(filename);
  const options = { ownerUid: 'owner', projectId: 'fixture', producerSecrets: { board: secret, gjc: 'gjc-fixture-secret'.repeat(3), proxy: 'proxy-fixture-secret'.repeat(3) }, repository: createOwnerEventRepository(() => db) };
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { options, authority: createOwnerEventAuthority(options), db: () => db,
    restart: () => { db.close(); db = new Database(filename); return createOwnerEventAuthority(options); } };
}

test('Board persisted envelope survives restart and reordered identical retries acknowledge without overwrite', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.authority.accept(input), { eventId: event.eventId, accepted: true, duplicate: false });
  const reordered = Object.fromEntries(Object.entries(event).reverse());
  assert.equal(f.restart().accept({ ...input, event: reordered }).duplicate, true);
  assert.deepEqual(f.authority.pending({ source: 'board', limit: 1 }), [event]);
  assert.deepEqual(f.authority.pending({ source: 'gjc' }), []);
  assert.equal(f.db().prepare('SELECT count(*) AS n FROM owner_events').get().n, 1);
  assert.equal(JSON.stringify(f.authority.pending({ source: 'board' })).includes(secret), false);
});

test('source credentials cannot spoof another source and missing config fails before storage', (t) => {
  const f = fixture(t);
  for (const request of [{ ...input, credential: 'firebase.payload.signature' },
    { ...input, source: 'gjc' }, { ...input, event: { ...event, source: 'gjc' } }]) {
    assert.throws(() => f.authority.accept(request), OwnerEventError);
  }
  for (const override of [{ ownerUid: '' }, { projectId: '' }, { producerSecrets: {} }]) {
    assert.throws(() => createOwnerEventAuthority({ ...f.options, ...override }).accept(input), OwnerEventError);
  }
  assert.equal(f.db().prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='owner_events'").get().n, 0);
});

test('strict envelopes reject private extras, invalid dates, identifiers and source types', (t) => {
  const f = fixture(t);
  for (const patch of [{ body: 'private' }, { payload: {} }, { email: 'private' }, { revision: 1 },
    { eventId: 'not-uuid' }, { targetId: 'a'.repeat(129) }, { deduplicationKey: 'x'.repeat(257) },
    { occurredAt: '2026-09-07T01:02:03' }, { occurredAt: '2026-02-30T01:02:03Z' },
    { type: 'task.completed' }, { deduplicationKey: 'board:other:1' }]) {
    assert.throws(() => f.authority.accept({ ...input, event: { ...event, ...patch } }), OwnerEventError);
  }
  for (const limit of [0, 101, 1.5]) assert.throws(() => f.authority.pending({ source: 'board', limit }), OwnerEventError);
});

test('conflicting event id or dedup key preserves original event', (t) => {
  const f = fixture(t);
  f.authority.accept(input);
  for (const patch of [{ type: 'action.requested' }, { deduplicationKey: 'board:tck-20260907-010203:2' },
    { eventId: 'bf112233-4455-4677-8899-aabbccddeeff' }]) {
    assert.throws(() => f.authority.accept({ ...input, event: { ...event, ...patch } }), { code: 'conflict' });
  }
  assert.deepEqual(f.authority.pending({ source: 'board' }), [event]);
  const otherOwner = createOwnerEventAuthority({ ...f.options, ownerUid: 'other' });
  assert.deepEqual(otherOwner.pending({ source: 'board' }), []);
});
