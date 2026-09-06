import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

import Database from 'better-sqlite3';

import { createGjcAppFactory } from '../app-factory.js';
import { createOwnerAdmissionPolicy } from '../middleware/owner-http-auth.js';
import { createOwnerDeviceRepository } from '../modules/database/index.js';

async function fixture(t, uid = 'owner', project = 'fixture', config = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gjc-device-route-'));
  const db = new Database(path.join(directory, 'auth.db'));
  const env = { FIREBASE_OWNER_UID: 'owner', FIREBASE_PROJECT_ID: 'fixture', FIREBASE_SESSION_ORIGIN: 'https://fixture.example', ...config };
  const { server, wss } = createGjcAppFactory({
    authority: {}, orchestrator: { deps: {} }, projection: {}, gitService: {}, chat: {}, shell: {},
    authenticateWebSocket: () => null, authenticateGjcRoute: (_req, res) => res.sendStatus(401),
    validateApiKey: (req, res, next) => req.headers['x-api-key'] === 'fixture' ? next() : res.sendStatus(401),
    ownerPolicy: createOwnerAdmissionPolicy({ env }),
    deviceRegistry: { env, repository: createOwnerDeviceRepository(() => db), verifyIdToken: async (token, revoked) => {
      assert.equal(revoked, true);
      if (token !== 'fixture.payload.signature') throw new Error('Unauthorized');
      return { uid, aud: project, iss: `https://securetoken.google.com/${project}`, exp: Math.floor(Date.now() / 1000) + 3600 };
    } },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => wss.close(resolve)); await new Promise((resolve) => server.close(resolve));
    db.close(); rmSync(directory, { recursive: true, force: true });
  });
  return (method, target, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port: server.address().port, path: target, method, agent: false,
      headers: { Host: 'fixture.example', 'x-api-key': 'fixture', Authorization: 'Bearer fixture.payload.signature', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), cookie: res.headers['set-cookie'] }));
    });
    req.on('error', reject); req.end(payload);
  });
}
const device = { installationId: 'android-fixture', platform: 'android', fcmToken: 'private-fcm-token', enabled: { gjc: true } };

describe('bearer device registry', { concurrency: false }, () => {
  let hosts;
  let desktop;
  before(() => { hosts = process.env.ALLOWED_HOSTS; desktop = process.env.GJC_DESKTOP; process.env.ALLOWED_HOSTS = 'fixture.example'; process.env.GJC_DESKTOP = '0'; });
  after(() => {
    if (hosts === undefined) delete process.env.ALLOWED_HOSTS; else process.env.ALLOWED_HOSTS = hosts;
    if (desktop === undefined) delete process.env.GJC_DESKTOP; else process.env.GJC_DESKTOP = desktop;
  });
  test('owner register read patch rotate and revoke return no token or session grants', async (t) => {
    const send = await fixture(t);
    for (const [method, target, body] of [
      ['POST', '/api/devices', device], ['GET', '/api/devices/android-fixture', undefined],
      ['PATCH', '/api/devices/android-fixture', { enabled: { board: true } }],
      ['PATCH', '/api/devices/android-fixture', { fcmToken: 'new-private-token' }],
      ['DELETE', '/api/devices/android-fixture', undefined],
    ]) {
      const result = await send(method, target, body);
      assert.equal(result.status, 200, method);
      assert.equal(result.cookie, undefined);
      assert.doesNotMatch(result.body, /private|fcmToken|session|code/);
    }
    assert.equal(JSON.parse((await send('GET', '/api/devices/android-fixture')).body).revoked, true);
  });
  test('unknown fields duplicate JSON keys and unauthorized credentials fail closed', async (t) => {
    const send = await fixture(t);
    assert.equal((await send('POST', '/api/devices', { ...device, email: 'private' })).status, 401);
    assert.equal((await send('POST', '/api/devices', '{"installationId":"a","installationId":"b"}')).status, 422);
    assert.equal((await send('POST', '/api/devices')).status, 401);
    assert.equal((await send('PATCH', '/api/devices/android-fixture')).status, 401);
    assert.equal((await send('POST', '/api/devices', { ...device, enabled: JSON.parse('{"gjc":true}') }, { Authorization: 'Bearer private-fcm-token' })).status, 401);
    assert.equal((await send('POST', '/api/devices', device, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await send('POST', '/api/devices', device, { 'x-api-key': '' })).status, 401);
    for (const [method, target] of [['GET', '/api/devices'], ['POST', '/api/devices/'], ['PUT', '/api/devices/android-fixture'], ['GET', '/api/devices/android-fixture/extra']]) {
      assert.equal((await send(method, target)).status, 503);
    }
  });
  test('wrong UID and project cannot register', async (t) => {
    for (const [uid, project] of [['other', 'fixture'], ['owner', 'other']]) {
      const send = await fixture(t, uid, project);
      assert.equal((await send('POST', '/api/devices', device)).status, 401);
    }
  });
  test('missing configured owner or project denies every device operation', async (t) => {
    for (const config of [{ FIREBASE_OWNER_UID: '' }, { FIREBASE_PROJECT_ID: '' }]) {
      const send = await fixture(t, 'owner', 'fixture', config);
      for (const [method, target, body] of [
        ['POST', '/api/devices', device],
        ['GET', '/api/devices/android-fixture', undefined],
        ['PATCH', '/api/devices/android-fixture', { enabled: { gjc: true } }],
        ['DELETE', '/api/devices/android-fixture', undefined],
      ]) {
        assert.equal((await send(method, target, body)).status, 503, method);
      }
    }
  });
});
