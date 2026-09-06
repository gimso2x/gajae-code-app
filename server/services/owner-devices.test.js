import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createOwnerDeviceRepository } from '../modules/database/index.js';

import { createOwnerDeviceAuthority, OwnerDeviceError } from './owner-devices.js';

const input = { idToken: 'fixture', installationId: 'installation-a', platform: 'android', fcmToken: 'fixture-token-old' };
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gjc-devices-'));
  const filename = path.join(directory, 'auth.db');
  let db = new Database(filename);
  const options = {
    env: { FIREBASE_OWNER_UID: 'owner', FIREBASE_PROJECT_ID: 'fixture' },
    now: () => 1000,
    verifyIdentity: async () => ({ uid: 'owner', projectId: 'fixture', expiresAt: 2000 }),
    repository: createOwnerDeviceRepository(() => db),
  };
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    options, authority: createOwnerDeviceAuthority(options), db: () => db,
    restart: () => { db.close(); db = new Database(filename); return createOwnerDeviceAuthority(options); },
  };
}

test('rotation replaces stale token atomically and patches preserve settings across restart', async (t) => {
  const f = fixture(t);
  const record = await f.authority.register({ ...input, enabled: { gjc: true, proxy: true } });
  assert.deepEqual(record, { installationId: input.installationId, platform: 'android', enabled: { gjc: true, board: false, proxy: true }, revoked: false });
  assert.equal(JSON.stringify(record).includes(input.fcmToken), false);
  await f.authority.register({ ...input, fcmToken: 'fixture-token-new' });
  assert.deepEqual(f.db().prepare('SELECT fcm_token FROM owner_devices').all(), [{ fcm_token: 'fixture-token-new' }]);
  await f.authority.patchSettings({ ...input, enabled: { board: true } });
  assert.deepEqual((await f.restart().get(input)).enabled, { gjc: true, board: true, proxy: true });
});

test('missing owner, wrong owner/project, expiry and async verifier failure never mutate storage', async (t) => {
  const f = fixture(t);
  for (const override of [
    { env: { FIREBASE_PROJECT_ID: 'fixture' } },
    { verifyIdentity: async () => ({ uid: 'other', projectId: 'fixture', expiresAt: 2000 }) },
    { verifyIdentity: async () => ({ uid: 'owner', projectId: 'other', expiresAt: 2000 }) },
    { verifyIdentity: async () => ({ uid: 'owner', projectId: 'fixture', expiresAt: 1000 }) },
    { verifyIdentity: async () => { throw new Error('private'); } },
  ]) {
    const authority = createOwnerDeviceAuthority({ ...f.options, ...override });
    await assert.rejects(authority.register(input), OwnerDeviceError);
    await assert.rejects(authority.revoke(input), OwnerDeviceError);
  }
  assert.equal(f.db().prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='owner_devices'").get().n, 0);
});

test('platform token installation and settings validation reject unknown or nonboolean input', async (t) => {
  const f = fixture(t);
  for (const patch of [{ platform: 'ios' }, { installationId: '../device' }, { installationId: '' },
    { fcmToken: '' }, { fcmToken: 't'.repeat(4097) }, { fcmToken: 'with space' },
    { enabled: { other: true } }, { enabled: { gjc: 1 } }, { enabled: [] },
    { enabled: JSON.parse('{"__proto__":true}') }]) {
    await assert.rejects(f.authority.register({ ...input, ...patch }), OwnerDeviceError);
  }
  await f.authority.register(input);
  await assert.rejects(f.authority.patchSettings({ ...input, enabled: { unknown: false } }), OwnerDeviceError);
});

test('revoke deletes private token only for owner installation and persistence retains revoked state', async (t) => {
  const f = fixture(t);
  await f.authority.register(input);
  const other = { ...input, installationId: 'installation-b', fcmToken: 'other-token' };
  await f.authority.register(other);
  const revoked = await f.authority.revoke(input);
  assert.equal(revoked.revoked, true);
  assert.equal(f.db().prepare('SELECT fcm_token FROM owner_devices WHERE installation = ?').get(input.installationId).fcm_token, null);
  assert.equal((await f.restart().get(input)).revoked, true);
  assert.equal((await f.authority.get(other)).revoked, false);
  await assert.rejects(f.authority.patchSettings({ ...input, enabled: { gjc: true } }), OwnerDeviceError);
  await assert.rejects(f.authority.revoke({ ...input, installationId: 'absent' }), OwnerDeviceError);
});
