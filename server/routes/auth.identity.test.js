import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import express from 'express';

import { validateApiKey } from '../middleware/auth.js';
import { userDb } from '../modules/database/index.js';
import { getFirebaseIdentityApp } from '../services/firebase-identity.js';

import { createAuthRouter } from './auth.js';
import { firebaseLoginPage } from './firebase-login-page.js';

const projectId = 'fixture-project';
const idToken = 'fixture.payload.signature';
const claims = {
  uid: 'fixture-uid',
  aud: projectId,
  iss: `https://securetoken.google.com/${projectId}`,
  email: 'not-an-owner@example.invalid',
};

async function serve(t, options, admission = (_req, _res, next) => next()) {
  const app = express();
  app.use(express.json());
  app.use('/api', admission);
  app.use(createAuthRouter(options));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });
  const post = (body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/auth/firebase/identity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  post.login = (headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/login`, { headers });
  return post;
}

test('identity fails closed without configured project or with emulator enabled', async (t) => {
  for (const env of [{}, { FIREBASE_PROJECT_ID: ' ' }, {
    FIREBASE_PROJECT_ID: projectId, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  }]) {
    const verifyIdToken = t.mock.fn(async () => claims);
    const post = await serve(t, { env, verifyIdToken });
    const response = await post({ idToken });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Identity verification unavailable' });
    assert.equal(verifyIdToken.mock.callCount(), 0);
  }
});

test('identity rejects malformed input before verification', async (t) => {
  const verifyIdToken = t.mock.fn(async () => claims);
  const post = await serve(t, { env: { FIREBASE_PROJECT_ID: projectId }, verifyIdToken });
  for (const body of [{}, [], { idToken: null }, { idToken: 42 }, { idToken: '' },
    { idToken: 'not-a-token' }, { idToken: ` ${idToken}` }, { idToken: 'a'.repeat(16385) }]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid identity request' });
  }
  assert.equal(verifyIdToken.mock.callCount(), 0);
});

test('async rejection, revoked tokens and wrong-project claims have generic failures', async (t) => {
  for (const verifyIdToken of [
    async () => { await Promise.resolve(); throw new Error(`sensitive ${idToken}`); },
    async () => { throw Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' }); },
    async () => ({ ...claims, aud: 'other-project' }),
    async () => ({ ...claims, iss: 'https://securetoken.google.com/other-project' }),
    async () => ({ ...claims, uid: '' }),
  ]) {
    const post = await serve(t, { env: { FIREBASE_PROJECT_ID: projectId }, verifyIdToken });
    const response = await post({ idToken });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Identity verification failed' });
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('verified identity checks revocation and never reads or enrolls an owner or issues grants', async (t) => {
  const ownerMethods = ['createUser', 'getFirstUser', 'getUserById'].map((name) =>
    t.mock.method(userDb, name, () => { throw new Error('Identity must not access owners'); }));
  const verifyIdToken = t.mock.fn(async () => {
    await Promise.resolve();
    return { ...claims, admin: true, session: 'untrusted-session', code: 'untrusted-code' };
  });
  const post = await serve(t, { env: { FIREBASE_PROJECT_ID: projectId }, verifyIdToken });
  const response = await post({ idToken, email: claims.email, projectId: 'caller-project' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { uid: claims.uid, projectId });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(verifyIdToken.mock.calls[0].arguments, [idToken, true]);
  const rejected = await post({ idToken: 'malformed' });
  assert.equal(rejected.status, 400);
  for (const method of ownerMethods) assert.equal(method.mock.callCount(), 0);
});

test('identity stays behind the existing deployment API key gate', async (t) => {
  const previousKey = process.env.API_KEY;
  const previousDesktop = process.env.GJC_DESKTOP;
  process.env.GJC_DESKTOP = '0';
  process.env.API_KEY = 'fixture-deployment-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousKey;
    if (previousDesktop === undefined) delete process.env.GJC_DESKTOP;
    else process.env.GJC_DESKTOP = previousDesktop;
  });
  const verifyIdToken = t.mock.fn(async () => claims);
  const post = await serve(t, { env: { FIREBASE_PROJECT_ID: projectId }, verifyIdToken }, validateApiKey);
  assert.equal((await post({ idToken })).status, 401);
  assert.equal(verifyIdToken.mock.callCount(), 0);
  assert.equal((await post({ idToken }, { 'x-api-key': 'fixture-deployment-key' })).status, 200);
  assert.equal((await post.login()).status, 503);
  assert.equal((await post.login({ 'x-api-key': 'fixture-deployment-key' })).status, 503);
});

test('Google identity page fails closed and emits nonce-protected in-memory bootstrap', async (t) => {
  const missing = await serve(t, { env: {} });
  const unavailable = await missing.login();
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /<script/);
  const env = {
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_WEB_API_KEY: 'fixture-browser-api-key',
    FIREBASE_AUTH_DOMAIN: 'fixture-project.firebaseapp.com',
    FIREBASE_WEB_APP_ID: 'fixture-app',
  };
  const post = await serve(t, { env });
  const response = await post.login();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  const nonce = html.match(/nonce="([^"]+)"/)[1];
  assert.ok(response.headers.get('content-security-policy').includes(`'nonce-${nonce}'`));
  assert.match(html, /persistence: inMemoryPersistence/);
  assert.match(html, /button.addEventListener\('click'/);
  assert.match(html, /await signInWithPopup/);
  assert.match(html, /body: JSON.stringify\(\{ idToken:/);
  assert.match(html, /status.textContent = 'Verified UID:/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|innerHTML|console\./);
  const malicious = firebaseLoginPage({ ...env, FIREBASE_WEB_API_KEY: '</script><script>alert(1)</script>' });
  assert.equal(malicious.status, 200);
  assert.doesNotMatch(malicious.html, /<script>alert/);
  assert.match(malicious.html, /\\u003c\/script\\u003e/);
  assert.equal(firebaseLoginPage({ ...env, FIREBASE_AUTH_DOMAIN: 'bad.example; script-src *' }).status, 503);
});

test('identity SDK app ownership reuses same project and rejects mismatches without ADC', () => {
  const apps = [];
  let credentials = 0;
  const sdk = {
    getApps: () => apps,
    applicationDefault: () => { credentials++; return {}; },
    initializeApp: (options, name) => {
      const app = { options, name };
      apps.push(app);
      return app;
    },
  };
  const first = getFirebaseIdentityApp(projectId, sdk);
  assert.equal(getFirebaseIdentityApp(projectId, sdk), first);
  assert.equal(apps.length, 1);
  assert.equal(credentials, 1);
  assert.throws(() => getFirebaseIdentityApp('other-project', sdk), /Identity project mismatch/);
  assert.equal(credentials, 1);
});

test('owner login exchanges Google identity for cookies before opening the app', async () => {
  const page = firebaseLoginPage({ FIREBASE_PROJECT_ID: projectId, FIREBASE_WEB_API_KEY: 'fixture-key',
    FIREBASE_AUTH_DOMAIN: 'fixture-project.firebaseapp.com', FIREBASE_WEB_APP_ID: 'fixture-app',
    FIREBASE_OWNER_HTTP_ENABLED: '1', FIREBASE_SESSION_ORIGIN: 'https://fixture.example' });
  const script = page.html.match(/<script type="module" nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  for (const failedPath of [null, '/api/auth/session/code', '/api/auth/session/consume']) {
    let click;
    const elements = { 'sign-in': { addEventListener: (_event, handler) => { click = handler; } },
      status: { textContent: '' } };
    const calls = [];
    let destination;
    let signedOut = false;
    const grant = { code: 'c'.repeat(43), installationId: 'i'.repeat(43) };
    const sdk = { initializeApp: () => ({}), initializeAuth: () => ({}), inMemoryPersistence: {},
      browserPopupRedirectResolver: {}, GoogleAuthProvider: class {},
      signInWithPopup: async () => ({ user: { getIdToken: async () => idToken } }),
      signOut: async () => { signedOut = true; } };
    const run = new (Object.getPrototypeOf(async function () {}).constructor)('sdk', 'document', 'fetch', 'window',
      script.replace(/await import\('[^']+'\)/g, 'sdk'));
    await run(sdk, { getElementById: (id) => elements[id] }, async (url, options) => {
      calls.push(url);
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), url.endsWith('/code') ? { idToken } : grant);
      return { ok: url !== failedPath, json: async () => grant };
    }, { location: { replace: (url) => { assert.equal(signedOut, true); destination = url; } } });
    await click();
    assert.deepEqual(calls, failedPath === '/api/auth/session/code'
      ? ['/api/auth/session/code'] : ['/api/auth/session/code', '/api/auth/session/consume']);
    assert.equal(destination, failedPath ? undefined : '/');
    assert.equal(signedOut, true);
  }
});

test('login matches the board card with one Google action and nonce-scoped styles', () => {
  const env = { FIREBASE_PROJECT_ID: projectId, FIREBASE_WEB_API_KEY: 'fixture-key',
    FIREBASE_AUTH_DOMAIN: 'fixture-project.firebaseapp.com', FIREBASE_WEB_APP_ID: 'fixture-app',
    FIREBASE_OWNER_HTTP_ENABLED: '1' };
  for (const config of [env, {}]) {
    const page = firebaseLoginPage(config);
    assert.match(page.html, /<html lang="ko">/);
    assert.match(page.html, /<main aria-labelledby="title">/);
    assert.match(page.html, /class="brand"/);
    assert.match(page.html, /class="service-name"/);
    assert.match(page.html, /class="google-mark" aria-hidden="true"/);
    assert.equal((page.html.match(/<button\b/g) || []).length, 1);
    assert.doesNotMatch(page.html, /<input\b|deployment-key|keyInput|x-api-key|Deployment API key/);
    assert.match(page.html, /aria-describedby="status"/);
    assert.match(page.html, /aria-live="polite"/);
    assert.match(page.html, /<noscript>/);
    const nonce = page.html.match(/<style nonce="([^"]+)">/)[1];
    assert.ok(page.csp.includes(`style-src 'nonce-${nonce}'`));
    assert.ok(!page.csp.includes('unsafe-inline'));
  }
});
