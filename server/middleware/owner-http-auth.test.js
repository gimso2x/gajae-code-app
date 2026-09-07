import assert from 'node:assert/strict';
import test from 'node:test';

import { createOwnerHttpAdmission } from './owner-http-auth.js';

const env = {
  FIREBASE_OWNER_HTTP_ENABLED: '1', FIREBASE_PROJECT_ID: 'fixture', FIREBASE_OWNER_UID: 'owner',
  FIREBASE_SESSION_ORIGIN: 'https://fixture.example',
};
const installationId = 'i'.repeat(43);
const session = 's'.repeat(43);
const cookie = `__Host-gjc-session=${session}; __Host-gjc-installation=${installationId}`;
const identity = { uid: 'owner', projectId: 'fixture', installationId, service: 'gjc', expiresAt: 2000 };
function setup(options = {}) {
  let calls = 0;
  const middleware = createOwnerHttpAdmission({
    env, now: () => 1000,
    getAuthority: () => ({ authenticate: async (binding) => {
      calls++;
      assert.deepEqual(binding, { session, installationId, service: 'gjc' });
      return identity;
    } }),
    ...options,
  });
  return {
    calls: () => calls,
    async request(overrides = {}) {
      const request = { method: 'GET', originalUrl: '/api/auth/user', headers: { host: 'fixture.example', cookie }, ...overrides };
      const result = { next: false, status: null, body: null };
      const response = {
        set() {},
        status(status) { result.status = status; return this; },
        json(body) { result.body = body; return this; },
        redirect(status, location) { result.status = status; result.body = location; return this; },
      };
      await middleware(request, response, () => { result.next = true; });
      return { ...result, identity: request.ownerIdentity };
    },
  };
}

test('owner HTTP admission authenticates protected API, files and root without replacing legacy user', async () => {
  const fixture = setup();
  for (const originalUrl of ['/api/auth/user', '/api/projects', '/api/files/read', '/assets/index.js', '/']) {
    const result = await fixture.request({ originalUrl });
    assert.equal(result.next, true);
    assert.deepEqual(result.identity, identity);
  }
  assert.equal(fixture.calls(), 5);
});

test('only explicit method/path bootstrap endpoints bypass owner sessions', async () => {
  const fixture = setup();
  const headers = { host: 'fixture.example' };
  for (const [method, originalUrl] of [
    ['GET', '/api/auth/firebase/login'], ['POST', '/api/auth/firebase/identity'],
    ['POST', '/api/auth/session/code'], ['POST', '/api/auth/session/consume'],
    ['POST', '/api/auth/session/native-consume'],
  ]) assert.equal((await fixture.request({ method, originalUrl, headers })).next, true);
  assert.equal(fixture.calls(), 0);
  for (const originalUrl of ['/api/auth/user', '/api/auth/session/logout', '/api/auth/other',
    '/api/auth/firebase/identity/extra', '/assets/index.js', '/api/files', '/']) {
    assert.equal((await fixture.request({ originalUrl, headers })).status, 401);
  }
  assert.equal((await fixture.request({ method: 'GET', originalUrl: '/api/auth/session/code', headers })).status, 401);
});

test('configured Firebase without secure explicit activation fails closed; unconfigured desktop remains untouched', async () => {
  for (const config of [
    { ...env, FIREBASE_OWNER_UID: '' }, { ...env, FIREBASE_OWNER_HTTP_ENABLED: '' },
    { ...env, FIREBASE_SESSION_ORIGIN: 'http://fixture.example' }, { ...env, FIREBASE_PROJECT_ID: '' },
  ]) {
    const result = await setup({ env: config, getAuthority: () => { throw new Error('must remain lazy'); } }).request();
    assert.equal(result.status, 503);
  }
  const result = await setup({ env: { GJC_DESKTOP: '1' }, getAuthority: () => { throw new Error('no auth'); } })
    .request({ headers: {}, user: { id: 1 } });
  assert.equal(result.next, true);
  assert.equal(result.identity, undefined);
});

test('nonowner, expired, wrong binding and authority errors never fall back or leak', async () => {
  for (const value of [{ ...identity, uid: 'other' }, { ...identity, expiresAt: 1000 },
    { ...identity, installationId: 'other' }, { ...identity, projectId: 'other' }, null]) {
    const fixture = setup({ getAuthority: () => ({ authenticate: async () => value }) });
    const result = await fixture.request({ user: { id: 1 } });
    assert.equal(result.status, 401);
    assert.equal(result.next, false);
  }
  const result = await setup({ getAuthority: () => { throw new Error('secret token'); } }).request();
  assert.deepEqual(result.body, { error: 'Owner authorization failed' });
});

test('exact mutation Origin and unique opaque cookie pair are mandatory', async () => {
  const fixture = setup();
  for (const origin of [undefined, 'null', 'https://evil.example', 'https://fixture.example/']) {
    const headers = { host: 'fixture.example', cookie, ...(origin === undefined ? {} : { origin }) };
    assert.equal((await fixture.request({ method: 'POST', headers })).status, 401);
  }
  assert.equal((await fixture.request({ method: 'POST', headers: { host: 'fixture.example', cookie, origin: 'https://fixture.example' } })).next, true);
  for (const invalidCookie of ['', `__Host-gjc-session=${session}`, `${cookie}; __Host-gjc-session=${session}`, `${cookie}; __Host-gjc-installation=${installationId}`]) {
    assert.equal((await fixture.request({ headers: { host: 'fixture.example', cookie: invalidCookie } })).status, 401);
  }
  assert.equal((await fixture.request({ headers: { host: 'evil.example', cookie } })).status, 401);
});

test('unauthenticated page navigation reaches login without opening API or foreign origins', async () => {
  const fixture = setup();
  const headers = { host: 'fixture.example', accept: 'text/html', 'sec-fetch-mode': 'navigate' };
  for (const originalUrl of ['/', '/session/example']) {
    const result = await fixture.request({ originalUrl, headers });
    assert.equal(result.status, 303);
    assert.equal(result.body, '/api/auth/firebase/login');
    assert.equal(result.next, false);
  }
  for (const overrides of [
    { originalUrl: '/api/projects' }, { originalUrl: '/assets/index.js' },
    { method: 'POST' }, { headers: { ...headers, host: 'evil.example' } },
    { headers: { ...headers, origin: 'https://evil.example' } },
    { headers: { ...headers, 'sec-fetch-mode': 'cors' } },
  ]) {
    assert.equal((await fixture.request({ originalUrl: '/', headers, ...overrides })).status, 401);
  }
  assert.equal((await fixture.request({ originalUrl: '/', headers: { ...headers, cookie } })).next, true);
});
