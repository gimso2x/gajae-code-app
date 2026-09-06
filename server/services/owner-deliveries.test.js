import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createOwnerDeviceRepository, createOwnerEventRepository, createOwnerDeliveryRepository } from '../modules/database/index.js';

import { createOwnerDeliveryAuthority } from './owner-deliveries.js';

const scope = { uid: 'owner', project: 'fixture', source: 'board' };
const event = { eventId: 'af112233-4455-4677-8899-aabbccddeeff', source: 'board', type: 'ticket.changed', targetId: 'tck-20260907-010203', occurredAt: '2026-09-07T01:02:03Z', deduplicationKey: 'board:tck-20260907-010203:1' };
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gjc-deliveries-'));
  const filename = path.join(directory, 'auth.db');
  let db = new Database(filename);
  let clock = 1000;
  const options = { ownerUid: 'owner', projectId: 'fixture', now: () => clock, repository: createOwnerDeliveryRepository(() => db) };
  const authority = createOwnerDeliveryAuthority(options);
  const devices = createOwnerDeviceRepository(() => db);
  createOwnerEventRepository(() => db).insert(scope, event);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { authority, options, devices, db: () => db, advance: (ms) => { clock += ms; },
    add: (installation, token = installation) => devices.upsert({ uid: scope.uid, project: scope.project, installation }, token, { board: true }),
    restart: () => { db.close(); db = new Database(filename); return createOwnerDeliveryAuthority(options); } };
}
const ack = (claim, outcome, extra = {}) => ({ source: 'board', eventId: claim.event.eventId, installationId: claim.installationId, claimToken: claim.claimToken, outcome, ...extra });

test('no devices stays pending; multi-device claims are distinct across connections and survive restart', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.authority.claim({ source: 'board' }), []);
  assert.equal(f.db().prepare('SELECT status FROM owner_events').get().status, 'pending');
  f.add('one'); f.add('two');
  const second = new Database(f.db().name);
  try {
    const competitor = createOwnerDeliveryAuthority({ ...f.options, repository: createOwnerDeliveryRepository(() => second) });
    const [first] = f.authority.claim({ source: 'board', limit: 1 });
    const [other] = competitor.claim({ source: 'board', limit: 1 });
    assert.notEqual(first.installationId, other.installationId);
    assert.deepEqual(competitor.claim({ source: 'board' }), []);
    f.restart().complete(ack(first, 'sent'));
    assert.equal(f.authority.complete(ack(other, 'payload-error')).status, 'terminal');
    assert.equal(f.db().prepare('SELECT count(*) AS n FROM owner_deliveries').get().n, 2);
  } finally { second.close(); }
});

test('lease fencing retry delay and exhaustion persist without replaying business mutation', (t) => {
  const f = fixture(t); f.add('one');
  let [claim] = f.authority.claim({ source: 'board' });
  f.advance(60000);
  assert.throws(() => f.authority.complete(ack(claim, 'sent')));
  const [replacement] = f.restart().claim({ source: 'board' });
  assert.notEqual(replacement.claimToken, claim.claimToken);
  assert.throws(() => f.authority.complete(ack(claim, 'sent')));
  claim = replacement;
  for (let attempt = 2; attempt <= 8; attempt++) {
    assert.equal(claim.attempt, attempt);
    const result = f.authority.complete(ack(claim, 'retryable', { retryAfterSeconds: 86400 }));
    if (attempt === 8) { assert.equal(result.outcome, 'exhausted'); break; }
    assert.deepEqual(f.authority.claim({ source: 'board' }), []);
    f.advance(86400_000);
    [claim] = f.authority.claim({ source: 'board' });
  }
  assert.deepEqual(f.authority.claim({ source: 'board' }), []);
  assert.equal(f.db().prepare('SELECT count(*) AS n FROM owner_events').get().n, 1);
});

test('invalid old token cannot revoke rotated registration; disabled device is skipped', (t) => {
  const f = fixture(t); f.add('one', 'old-token');
  const [claim] = f.authority.claim({ source: 'board' });
  f.add('one', 'new-token');
  f.authority.complete(ack(claim, 'invalid-registration'));
  assert.equal(f.devices.get({ uid: scope.uid, project: scope.project, installation: 'one' }).revoked, false);
  f.add('two');
  const [second] = f.authority.claim({ source: 'board' });
  f.authority.complete(ack(second, 'retryable'));
  f.devices.patch({ uid: scope.uid, project: scope.project, installation: 'two' }, { board: false });
  f.advance(5000);
  assert.deepEqual(f.authority.claim({ source: 'board' }), []);
  assert.equal(f.db().prepare("SELECT outcome FROM owner_deliveries WHERE installation='two'").get().outcome, 'skipped');
});

test('current invalid registration is disabled and invalid retry controls are rejected', (t) => {
  const f = fixture(t); f.add('one');
  const [claim] = f.authority.claim({ source: 'board' });
  for (const retryAfterSeconds of [-1, 86401, 0.5]) assert.throws(() => f.authority.complete(ack(claim, 'retryable', { retryAfterSeconds })));
  assert.throws(() => f.authority.complete(ack(claim, 'sent', { retryAfterSeconds: 0 })));
  f.authority.complete(ack(claim, 'invalid-registration'));
  assert.equal(f.devices.get({ uid: scope.uid, project: scope.project, installation: 'one' }).revoked, true);
  assert.throws(() => f.authority.complete(ack(claim, 'sent')));
});
