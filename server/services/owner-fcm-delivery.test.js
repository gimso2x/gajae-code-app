import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createOwnerDeviceRepository, createOwnerEventRepository, createOwnerDeliveryRepository } from '../modules/database/index.js';

import { createOwnerDeliveryAuthority } from './owner-deliveries.js';
import { createOwnerFcmDelivery, classifyOwnerMessagingError, messagingRetryAfter } from './owner-fcm-delivery.js';

const event = { eventId: 'af112233-4455-4677-8899-aabbccddeeff', source: 'board', type: 'action.requested', targetId: 'ticket', occurredAt: '2026-09-07T01:00:00Z', deduplicationKey: 'board:ticket:1' };
const claim = { event, installationId: 'install', fcmToken: 'private-token', claimToken: 'c'.repeat(43) };
function fake(outcome) {
  const sent = [];
  const completed = [];
  let supplied = false;
  const appSdk = { getApps: () => [{ name: 'gjc-firebase-identity', options: { projectId: 'fixture' } }], applicationDefault: () => { throw new Error('ADC must not run'); }, initializeApp: () => { throw new Error('must reuse'); } };
  const authority = { claim: () => supplied ? [] : (supplied = true, [claim]), isSendable: () => true, complete: (result) => completed.push(result) };
  const options = { enabled: true, ownerUid: 'owner', projectId: 'fixture', authority, appSdk,
    messaging: () => ({ send: async (message) => { sent.push(message); if (outcome) throw { code: outcome }; return 'message-id'; } }) };
  return { options, sent, completed };
}

test('official sender boundary receives generic six-field data and action channel without private content', async () => {
  const f = fake();
  await createOwnerFcmDelivery(f.options).drain({ source: 'board' });
  assert.equal(f.completed[0].outcome, 'sent');
  assert.deepEqual(f.sent[0].data, event);
  assert.equal(f.sent[0].android.notification.channelId, 'action_requests');
  assert.equal(f.sent[0].android.priority, 'high');
  assert.equal(f.sent[0].android.ttl, 3600000);
  assert.equal(f.sent[0].token, 'private-token');
  assert.doesNotMatch(JSON.stringify({ notification: f.sent[0].notification, data: f.sent[0].data }), /private-token|owner|install/);
});

test('disabled missing config and postclaim rotation/revocation never invoke SDK', async () => {
  for (const override of [{ enabled: false }, { ownerUid: '' }, { projectId: '' }]) {
    const f = fake();
    assert.equal((await createOwnerFcmDelivery({ ...f.options, ...override }).drain()).status, 'disabled');
    assert.equal(f.sent.length, 0);
  }
  const f = fake();
  f.options.authority.isSendable = () => false;
  await createOwnerFcmDelivery(f.options).drain({ source: 'board' });
  assert.equal(f.sent.length, 0);
  assert.equal(f.completed.length, 0);
});

test('messaging failure classification separates registration payload retry and blocked', async () => {
  for (const [code, expected] of [
    ['messaging/registration-token-not-registered', 'invalid-registration'],
    ['messaging/invalid-argument', 'payload-error'], ['messaging/quota-exceeded', 'retryable'],
    ['messaging/server-unavailable', 'retryable'], ['messaging/internal-error', 'retryable'],
    ['app/network-error', 'retryable'], ['messaging/authentication-error', 'blocked'],
  ]) {
    assert.equal(classifyOwnerMessagingError({ code }), expected);
    const f = fake(code);
    await createOwnerFcmDelivery(f.options).drain({ source: 'board' });
    assert.equal(f.completed[0].outcome, expected);
  }
  const f = fake();
  f.options.appSdk.getApps = () => [{ name: 'gjc-firebase-identity', options: { projectId: 'wrong' } }];
  assert.equal((await createOwnerFcmDelivery(f.options).drain({ source: 'board' })).status, 'blocked');
  assert.equal(f.sent.length, 0);
});

test('blocked authentication persists terminal across restart and expired lease', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'gjc-fcm-'));
  const filename = path.join(directory, 'auth.db');
  let db = new Database(filename);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  createOwnerEventRepository(() => db).insert({ uid: 'owner', project: 'fixture', source: 'board' }, event);
  createOwnerDeviceRepository(() => db).upsert({ uid: 'owner', project: 'fixture', installation: 'install' }, 'private-token', { board: true });
  let clock = 1000;
  const authority = createOwnerDeliveryAuthority({ ownerUid: 'owner', projectId: 'fixture', now: () => clock, repository: createOwnerDeliveryRepository(() => db) });
  const f = fake('messaging/authentication-error');
  await createOwnerFcmDelivery({ ...f.options, authority }).drain({ source: 'board' });
  db.close(); db = new Database(filename); clock += 120000;
  assert.deepEqual(authority.claim({ source: 'board' }), []);
  assert.deepEqual(db.prepare('SELECT status,outcome FROM owner_deliveries').get(), { status: 'terminal', outcome: 'blocked' });
});

test('SDK httpResponse Retry-After supports bounded seconds and HTTP date', async () => {
  const error = (value) => ({ httpResponse: { headers: { 'retry-after': value } } });
  assert.equal(messagingRetryAfter(error('120'), 0), 120);
  assert.equal(messagingRetryAfter(error('Thu, 01 Jan 1970 00:01:00 GMT'), 0), 60);
  for (const value of ['86401', '-1', '1.5', ['10'], 'bad']) assert.equal(messagingRetryAfter(error(value)), undefined);
  assert.equal(messagingRetryAfter({ headers: { 'retry-after': '10' } }), undefined);
  const f = fake();
  f.options.messaging = () => ({ send: async () => { throw { code: 'messaging/quota-exceeded', ...error('120') }; } });
  await createOwnerFcmDelivery(f.options).drain({ source: 'board' });
  assert.equal(f.completed[0].retryAfterSeconds, 120);
});

test('unresolved sends renew every 20 seconds and stop renewal on settlement or lease loss', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const lost of [false, true]) {
    const f = fake();
    let renewals = 0;
    f.options.authority.renew = () => { renewals++; return !lost; };
    let settle;
    f.options.messaging = () => ({ send: () => new Promise((resolve) => { settle = resolve; }) });
    const sender = createOwnerFcmDelivery(f.options);
    const pending = sender.drain({ source: 'board' });
    assert.equal((await sender.drain({ source: 'board' })).status, 'busy');
    t.mock.timers.tick(20000);
    assert.equal(renewals, 1);
    settle('message');
    const result = await pending;
    assert.equal(result.status, lost ? 'lease-lost' : 'idle');
    assert.equal(f.completed.length, lost ? 0 : 1);
    t.mock.timers.tick(60000);
    assert.equal(renewals, 1);
  }
});

test('transactional lease renewal rejects expired or replaced tokens', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'gjc-renew-'));
  const db = new Database(path.join(directory, 'auth.db'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  createOwnerEventRepository(() => db).insert({ uid: 'owner', project: 'fixture', source: 'board' }, event);
  createOwnerDeviceRepository(() => db).upsert({ uid: 'owner', project: 'fixture', installation: 'install' }, 'private-token', { board: true });
  let clock = 1000;
  const queue = createOwnerDeliveryAuthority({ ownerUid: 'owner', projectId: 'fixture', now: () => clock, repository: createOwnerDeliveryRepository(() => db) });
  const [leased] = queue.claim({ source: 'board' });
  const key = { source: 'board', eventId: event.eventId, installationId: 'install', claimToken: leased.claimToken };
  clock += 20000;
  assert.equal(queue.renew(key), true);
  clock = 61000;
  assert.deepEqual(queue.claim({ source: 'board' }), []);
  clock = 81000;
  assert.equal(queue.renew(key), false);
  const [replacement] = queue.claim({ source: 'board' });
  assert.notEqual(replacement.claimToken, key.claimToken);
  assert.equal(queue.renew(key), false);
  assert.throws(() => queue.complete({ ...key, outcome: 'sent' }));
});
