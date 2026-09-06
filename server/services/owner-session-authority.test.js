import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createOwnerSessionRepository } from '../modules/database/index.js';

import { createOwnerSessionAuthority, OwnerSessionError } from './owner-session-authority.js';

const env = { FIREBASE_OWNER_UID: 'owner', FIREBASE_PROJECT_ID: 'fixture-project' };
const scope = { installationId: 'installation-a', service: 'gjc' };

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gjc-owner-session-'));
  const filename = path.join(directory, 'auth.db');
  let db = new Database(filename);
  let time = 1_000_000;
  const repository = createOwnerSessionRepository(() => db);
  const identity = { uid: 'owner', projectId: 'fixture-project', expiresAt: time + 24 * 60 * 60_000 };
  const options = { env, repository, now: () => time, verifyIdentity: async () => identity };
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    authority: createOwnerSessionAuthority(options), identity, options,
    db: () => db,
    advance: (ms) => { time += ms; },
    restart: () => { db.close(); db = new Database(filename); return createOwnerSessionAuthority(options); },
  };
}

async function session(authority, installationId = scope.installationId) {
  const input = { ...scope, installationId };
  const { code } = await authority.issueCode({ ...input, idToken: 'fixture-id-token' });
  return { ...input, ...authority.exchangeCode({ ...input, code }) };
}

test('owner exchange persists hashed credentials across restart and enforces 12 hour ceiling', async (t) => {
  const f = fixture(t);
  const issued = await f.authority.issueCode({ ...scope, idToken: 'fixture-id-token' });
  assert.equal(issued.expiresAt, 1_060_000);
  assert.equal(f.db().prepare('SELECT hash FROM owner_exchange_codes').get().hash.includes(issued.code), false);
  const authority = f.restart();
  const result = authority.exchangeCode({ ...scope, code: issued.code });
  assert.equal(result.expiresAt, 1_000_000 + 12 * 60 * 60_000);
  assert.notEqual(f.db().prepare('SELECT hash FROM owner_sessions').get().hash, result.session);
  assert.equal(f.restart().authenticate({ ...scope, session: result.session }).uid, 'owner');
  assert.throws(() => authority.exchangeCode({ ...scope, code: issued.code }), OwnerSessionError);
  f.advance(12 * 60 * 60_000);
  assert.throws(() => authority.authenticate({ ...scope, session: result.session }), OwnerSessionError);
});

test('verified identity fails closed for absent owner, wrong owner/project and asynchronous failure', async (t) => {
  const f = fixture(t);
  for (const options of [
    { env: {} },
    { verifyIdentity: async () => ({ ...f.identity, uid: 'stranger', email: 'owner@example.invalid' }) },
    { verifyIdentity: async () => ({ ...f.identity, projectId: 'wrong' }) },
    { verifyIdentity: async () => ({ ...f.identity, expiresAt: 1_000_000 }) },
    { verifyIdentity: async () => { await Promise.resolve(); throw new Error('private token'); } },
  ]) {
    const authority = createOwnerSessionAuthority({ ...f.options, ...options });
    await assert.rejects(authority.issueCode({ ...scope, idToken: 'fixture' }), OwnerSessionError);
  }
  assert.equal(f.db().prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'owner_exchange_codes'").get().count, 0);
});

test('binding, expiration and competing consumption do not permit replay', async (t) => {
  const f = fixture(t);
  const { code } = await f.authority.issueCode({ ...scope, idToken: 'fixture' });
  for (const override of [{ service: 'other' }, { installationId: 'other' }]) {
    assert.throws(() => f.authority.exchangeCode({ ...scope, ...override, code }), OwnerSessionError);
  }
  const otherOwner = createOwnerSessionAuthority({ ...f.options, env: { ...env, FIREBASE_OWNER_UID: 'other' } });
  assert.throws(() => otherOwner.exchangeCode({ ...scope, code }), OwnerSessionError);
  const secondConnection = new Database(f.db().name);
  t.after(() => secondConnection.close());
  const competing = createOwnerSessionAuthority({
    ...f.options, repository: createOwnerSessionRepository(() => secondConnection),
  });
  const results = await Promise.allSettled([f.authority, competing].map((authority) =>
    Promise.resolve().then(() => authority.exchangeCode({ ...scope, code }))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(f.db().prepare('SELECT count(*) AS count FROM owner_sessions').get().count, 1);
  const expiring = await f.authority.issueCode({ ...scope, idToken: 'fixture' });
  f.advance(60_000);
  assert.throws(() => f.authority.exchangeCode({ ...scope, code: expiring.code }), OwnerSessionError);
});

test('short token lifetime limits both code and session validity', async (t) => {
  const f = fixture(t);
  f.identity.expiresAt = 1_030_000;
  const { code, expiresAt } = await f.authority.issueCode({ ...scope, idToken: 'fixture' });
  assert.equal(expiresAt, f.identity.expiresAt);
  const grant = f.authority.exchangeCode({ ...scope, code });
  assert.equal(grant.expiresAt, f.identity.expiresAt);
  f.advance(30_000);
  assert.throws(() => f.authority.authenticate({ ...scope, session: grant.session }), OwnerSessionError);
});

test('own-session and installation revocation are scoped and persist across restart', async (t) => {
  const f = fixture(t);
  const first = await session(f.authority);
  const second = await session(f.authority);
  const anotherInstallation = await session(f.authority, 'installation-b');
  const pending = await f.authority.issueCode({ ...scope, idToken: 'fixture' });
  assert.throws(() => f.authority.revokeInstallation({ ...first, installationId: 'installation-b' }), OwnerSessionError);
  assert.throws(() => f.authority.authenticate({ ...first, service: 'other' }), OwnerSessionError);
  f.authority.revokeSession(first);
  assert.throws(() => f.authority.authenticate(first), OwnerSessionError);
  assert.equal(f.authority.authenticate(second).installationId, scope.installationId);
  f.authority.revokeInstallation(second);
  const authority = f.restart();
  assert.throws(() => authority.authenticate(second), OwnerSessionError);
  assert.throws(() => authority.exchangeCode({ ...scope, code: pending.code }), OwnerSessionError);
  assert.equal(authority.authenticate(anotherInstallation).installationId, 'installation-b');
});
