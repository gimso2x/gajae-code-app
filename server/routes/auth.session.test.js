import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

import { createOwnerSessionRepository } from '../modules/database/index.js';
import { createFirebaseIdentityVerifier, createFirebaseSessionIdentityVerifier } from '../services/firebase-identity.js';

import { createAuthRouter } from './auth.js';

const origin = 'https://fixture.example';
async function fixture(t, owner = 'owner') {
  const directory = mkdtempSync(path.join(tmpdir(), 'gjc-session-route-'));
  const db = new Database(path.join(directory, 'auth.db'));
  const app = express();
  const received = [];
  app.use((req, _res, next) => {
    received.push(req.headers);
    next();
  });
  app.use(express.json());
  app.use('/api', (req, res, next) => req.headers['x-api-key'] === 'fixture-key' ? next() : res.sendStatus(401));
  app.use(createAuthRouter({
    env: { FIREBASE_PROJECT_ID: 'fixture', FIREBASE_OWNER_UID: owner, FIREBASE_SESSION_ORIGIN: origin },
    sessionRepository: createOwnerSessionRepository(() => db),
    verifyIdToken: async (_token, checkRevoked) => {
      assert.equal(checkRevoked, true);
      return { uid: 'owner', aud: 'fixture', iss: 'https://securetoken.google.com/fixture', exp: Math.floor(Date.now() / 1000) + 3600 };
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close(); await once(server, 'close');
    db.close(); rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    // Native transport must preserve the explicit Host and omit browser fetch
    // metadata. Fetch implementations can rewrite these controlled headers.
    post: (endpoint, body, headers = {}) => new Promise((resolve, reject) => {
      const request = httpRequest({
        hostname: '127.0.0.1', port: server.address().port,
        path: `/api/auth/session/${endpoint}`, method: 'POST',
        headers: { 'Content-Type': 'application/json', Host: 'fixture.example', 'x-api-key': 'fixture-key', ...headers },
      }, (response) => {
        const actual = received.shift();
        try {
          assert.equal(actual.host, headers.Host ?? 'fixture.example');
          assert.equal(actual.origin, headers.Origin);
          assert.equal(actual['sec-fetch-site'], headers['Sec-Fetch-Site']);
          assert.equal(actual['sec-fetch-mode'], undefined);
        } catch (error) {
          response.resume();
          reject(error);
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            for (const item of Array.isArray(value) ? value : [value]) {
              if (item !== undefined) responseHeaders.append(name, item);
            }
          }
          resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), {
            status: response.statusCode, headers: responseHeaders,
          }));
        });
      });
      request.on('error', reject);
      request.end(JSON.stringify(body));
    }),
  };
}

async function code(f) {
  const response = await f.post('code', { idToken: 'fixture.payload.signature' });
  assert.equal(response.status, 200);
  return response.json();
}

test('native one-use POST creates secure bound cookies, fixed redirect and scoped logout', async (t) => {
  const f = await fixture(t);
  const issued = await code(f);
  assert.match(issued.installationId, /^[A-Za-z0-9_-]{43}$/);
  const response = await f.post('native-consume', { ...issued, redirect: 'https://evil.example' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
  const setCookies = response.headers.getSetCookie();
  assert.equal(setCookies.length, 2);
  for (const value of setCookies) {
    assert.match(value, /HttpOnly/); assert.match(value, /Secure/); assert.match(value, /SameSite=Lax/);
    assert.match(value, /Path=\//); assert.doesNotMatch(value, /Domain=/);
  }
  const cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
  assert.equal((await f.post('native-consume', issued)).status, 401);
  assert.equal((await f.post('logout', {}, { Cookie: cookie })).status, 401);
  assert.equal((await f.post('logout', {}, { Cookie: cookie, Origin: 'https://evil.example' })).status, 401);
  assert.equal((await f.post('logout', {}, { Cookie: cookie, Origin: origin })).status, 204);
  assert.equal(f.db.prepare('SELECT revoked FROM owner_sessions').get().revoked, 1);
  assert.equal((await f.post('logout', {}, { Cookie: cookie, Origin: origin })).status, 401);
});

test('browser consume requires exact Origin; native omission never skips code/binding or admission', async (t) => {
  const f = await fixture(t);
  const issued = await code(f);
  assert.equal((await f.post('consume', issued)).status, 401);
  assert.equal((await f.post('native-consume', issued, { Origin: 'null' })).status, 401);
  assert.equal((await f.post('native-consume', issued, { 'Sec-Fetch-Site': 'cross-site' })).status, 401);
  assert.equal((await f.post('native-consume', issued, { 'x-api-key': '' })).status, 401);
  assert.equal((await f.post('native-consume', { ...issued, installationId: 'a'.repeat(43) })).status, 401);
  assert.equal((await f.post('consume', issued, { Origin: origin, Host: 'evil.example' })).status, 401);
  assert.equal((await f.post('consume', issued, { Origin: origin })).status, 303);
});

test('missing configured owner never issues a code', async (t) => {
  const f = await fixture(t, '');
  assert.equal((await f.post('code', { idToken: 'fixture.payload.signature' })).status, 401);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'owner_exchange_codes'").get().n, 0);
});

test('session identity adapter validates verified exp without exposing expiry in identity response', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const claims = { uid: 'owner', aud: 'fixture', iss: 'https://securetoken.google.com/fixture', exp };
  const options = {
    env: { FIREBASE_PROJECT_ID: 'fixture' },
    verifyIdToken: async (_token, revoked) => { assert.equal(revoked, true); return claims; },
  };
  assert.deepEqual(await createFirebaseSessionIdentityVerifier(options)('fixture.payload.signature'), {
    uid: 'owner', projectId: 'fixture', expiresAt: exp * 1000,
  });
  assert.deepEqual(await createFirebaseIdentityVerifier(options)('fixture.payload.signature'), {
    uid: 'owner', projectId: 'fixture',
  });
  for (const invalid of [undefined, null, String(exp), 1.5, 0, Number.MAX_SAFE_INTEGER]) {
    claims.exp = invalid;
    await assert.rejects(createFirebaseSessionIdentityVerifier(options)('fixture.payload.signature'), {
      message: 'Identity verification failed',
    });
  }
});

test('native WebView opaque Origin exchanges only a valid single-use bound grant', async (t) => {
  const f = await fixture(t);
  const issued = await code(f);
  const headers = { Origin: 'null', 'Sec-Fetch-Site': 'none' };
  assert.equal((await f.post('code', { idToken: 'fixture.payload.signature' }, headers)).status, 401);
  assert.equal((await f.post('consume', issued, headers)).status, 401);
  assert.equal((await f.post('native-consume', issued, { ...headers, 'Sec-Fetch-Site': 'cross-site' })).status, 401);
  assert.equal((await f.post('native-consume', { ...issued, installationId: 'x'.repeat(43) }, headers)).status, 401);
  const consumed = await f.post('native-consume', issued, headers);
  assert.equal(consumed.status, 303);
  assert.equal(consumed.headers.getSetCookie().length, 2);
  assert.equal((await f.post('native-consume', issued, headers)).status, 401);
});
