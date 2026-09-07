import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';

import WebSocket from 'ws';

import { createOwnerAdmissionPolicy, createOwnerHttpAdmission } from '@/middleware/owner-http-auth.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { createWebSocketServer, watchOwnerSession } from '@/modules/websocket/services/websocket-server.service.js';

/*
 * The upgrade check is the only thing standing between a page the owner
 * happens to visit and a fully authorized socket onto a server that runs shell
 * commands. A WebSocket handshake is not subject to the same-origin policy, and
 * the owner here is implicit - `authenticateWebSocket` takes no argument and
 * always returns them - so "can reach the port" used to be the whole of
 * "authorized". Loopback binding is no defence: the hostile page runs inside
 * the owner's own browser, which can reach loopback.
 */

const owner = () => ({ userId: 'owner', username: 'owner' });

const upgrade = (headers: Record<string, string | undefined>) => ({
  req: { url: '/ws', headers },
  origin: headers.origin ?? '',
  secure: false,
}) as never;

const verify = (
  headers: Record<string, string | undefined>,
  allowedHosts?: string,
) => verifyWebSocketClient(upgrade({ host: '127.0.0.1:3001', ...headers }), {
  authenticateWebSocket: owner,
  allowedHosts,
});

test('a hostile site cannot open a socket onto a loopback server', () => {
  assert.equal(verify({ origin: 'https://evil.example' }), false);
});

test('the opaque origin cannot open a socket', () => {
  // Sandboxed iframes and file:// documents send this.
  assert.equal(verify({ origin: 'null' }), false);
});

test('a hostname that merely looks like loopback is still foreign', () => {
  assert.equal(verify({ origin: 'https://127.0.0.1.evil.example' }), false);
  assert.equal(verify({ origin: 'https://localhost.evil.example' }), false);
});

test('the dev client on another port still connects', () => {
  // Vite serves the UI on 5173 and proxies the socket to 3001, forwarding the
  // original Origin, so a port comparison would break every dev session.
  assert.equal(verify({ origin: 'http://localhost:5173' }), true);
  assert.equal(verify({ origin: 'http://127.0.0.1:5173' }), true);
});

test('a native client that sends no Origin still connects', () => {
  // The Tauri shell and CLI callers omit it. A browser cannot omit it
  // cross-origin, so this costs nothing.
  assert.equal(verify({}), true);
});

test('a host the owner listed in ALLOWED_HOSTS connects', () => {
  assert.equal(verify({ origin: 'https://mac.tail1e211e.ts.net' }, '.tail1e211e.ts.net'), true);
  assert.equal(verify({ origin: 'https://evil.example' }, '.tail1e211e.ts.net'), false);
});

test('the origin check runs before the desktop credential check', () => {
  // Otherwise a rejected origin would still exercise the credential path, and
  // in non-desktop mode that path returns true unconditionally.
  let desktopConsulted = false;

  const allowed = verifyWebSocketClient(upgrade({ host: '127.0.0.1:3001', origin: 'https://evil.example' }), {
    authenticateWebSocket: owner,
    desktopAuth: {
      authenticateWebSocket: () => { desktopConsulted = true; return true; },
    },
  });

  assert.equal(allowed, false);
  assert.equal(desktopConsulted, false);
});

test('a rejected origin never reaches the implicit owner lookup', () => {
  let ownerLookedUp = false;

  const allowed = verifyWebSocketClient(upgrade({ host: '127.0.0.1:3001', origin: 'https://evil.example' }), {
    authenticateWebSocket: () => { ownerLookedUp = true; return owner(); },
  });

  assert.equal(allowed, false);
  assert.equal(ownerLookedUp, false);
});

test('malformed upgrade targets fail closed before authentication instead of throwing', () => {
  for (const url of ['//[', '//%', 'http://[', '//attacker.example/ws']) {
    let lookedUp = false;
    const request = { url, headers: { host: '127.0.0.1:3001' } };
    assert.equal(verifyWebSocketClient({ req: request } as never, {
      authenticateWebSocket: () => { lookedUp = true; return owner(); },
    }), false, url);
    assert.equal(lookedUp, false);
  }
});

test('the optional deployment API key protects WebSocket upgrades before owner lookup', (t) => {
  const previous = process.env.API_KEY;
  const desktop = process.env.GJC_DESKTOP;
  process.env.API_KEY = 'fixture-deployment-key';
  delete process.env.GJC_DESKTOP;
  t.after(() => {
    if (previous === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previous;
    if (desktop === undefined) delete process.env.GJC_DESKTOP;
    else process.env.GJC_DESKTOP = desktop;
  });
  for (const key of [undefined, '', 'incorrect', 'fixture-deployment-key']) {
    let lookedUp = false;
    const valid = key === 'fixture-deployment-key';
    assert.equal(verifyWebSocketClient(upgrade({ host: '127.0.0.1:3001', 'x-api-key': key }), {
      authenticateWebSocket: () => { lookedUp = true; return owner(); },
    }), valid);
    assert.equal(lookedUp, valid);
  }
});

test('the live gateway rejects unauthorized and malformed upgrades and still accepts an authenticated client', async (t) => {
  const previous = process.env.API_KEY;
  const desktop = process.env.GJC_DESKTOP;
  process.env.API_KEY = 'fixture-gateway-key';
  delete process.env.GJC_DESKTOP;
  t.after(() => {
    if (previous === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previous;
    if (desktop === undefined) delete process.env.GJC_DESKTOP;
    else process.env.GJC_DESKTOP = desktop;
  });
  const server = createServer();
  let attached = 0;
  const gateway = createWebSocketServer(server, {
    verifyClient: { authenticateWebSocket: () => { attached++; return owner(); } },
    chat: {} as never,
    shell: {} as never,
    browser: (socket) => socket.send('authenticated'),
  });
  t.after(async () => {
    for (const socket of gateway.clients) socket.terminate();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const rejectUpgrade = (target: string) => new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port: address.port, path: target,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    }, (response) => { response.resume(); resolve(response.statusCode); });
    request.once('error', reject);
    request.once('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('Unauthenticated upgrade succeeded')); });
    request.end();
  });
  for (const target of ['/ws', '/shell', '/desktop-notifications', '/ws/browser?sessionId=one', '//[']) {
    assert.equal(await rejectUpgrade(target), 401, target);
  }
  assert.equal(attached, 0);
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/browser`, { headers: { 'x-api-key': 'fixture-gateway-key' } });
  const message = once(client, 'message');
  t.after(() => client.terminate());
  assert.equal(String((await message)[0]), 'authenticated');
  assert.equal(attached, 1);
});

test('configured owner policy protects every upgrade without legacy fallback', async () => {
  const env = { FIREBASE_PROJECT_ID: 'fixture', FIREBASE_OWNER_UID: 'owner', FIREBASE_OWNER_HTTP_ENABLED: '1', FIREBASE_SESSION_ORIGIN: 'https://fixture.example' };
  const installationId = 'i'.repeat(43);
  const session = 's'.repeat(43);
  let revoked = false;
  let legacy = 0;
  const policy = createOwnerAdmissionPolicy({ env, getAuthority: () => ({ authenticate: () => {
    if (revoked) throw new Error('private');
    return { uid: 'owner', projectId: 'fixture', installationId, service: 'gjc', expiresAt: Date.now() + 10000 };
  } }) });
  for (const url of ['/ws', '/shell', '/desktop-notifications', '/ws/browser']) {
    const info = { req: { url, headers: { host: 'fixture.example', origin: 'https://fixture.example', cookie: `__Host-gjc-session=${session}; __Host-gjc-installation=${installationId}` } } };
    const dependencies = { ownerPolicy: policy, allowedHosts: 'fixture.example', authenticateWebSocket: () => { legacy++; return owner(); } };
    assert.equal(await verifyWebSocketClient(info as never, dependencies), true);
    revoked = true;
    assert.equal(await verifyWebSocketClient(info as never, dependencies), false);
    revoked = false;
    delete (info.req.headers as Record<string, unknown>).cookie;
    assert.equal(await verifyWebSocketClient(info as never, dependencies), false);
  }
  assert.equal(legacy, 0);
});

test('missing owner permits only identity discovery, never exchange or protected access', async () => {
  const admission = createOwnerHttpAdmission({ env: { FIREBASE_PROJECT_ID: 'fixture' } });
  for (const [method, originalUrl, allowed] of [
    ['GET', '/login', true], ['POST', '/api/auth/firebase/identity', true],
    ['POST', '/api/auth/session/code', false], ['POST', '/api/auth/session/consume', false], ['GET', '/api/auth/user', false],
  ] as const) {
    let passed = false;
    let status = 0;
    await admission({ method, originalUrl, headers: {} }, {
      set() {}, status(value: number) { status = value; return this; }, json() {},
    }, () => { passed = true; });
    assert.equal(passed, allowed);
    if (!allowed) assert.equal(status, 503);
  }
});

test('WebSocket revalidation closes rejected sessions without leaking reason and clears on close', async () => {
  const socket = new EventEmitter() as EventEmitter & { close: (code: number, reason: string) => void };
  let closed = 0;
  socket.close = (code, reason) => { assert.equal(code, 1008); assert.equal(reason, 'Owner authorization failed'); closed++; socket.emit('close'); };
  const policy = { configured: true, authenticate: () => { throw new Error('private revocation detail'); } };
  watchOwnerSession(socket as never, {} as never, policy as never);
  await Promise.resolve();
  assert.equal(closed, 1);
});

test('WebSocket expiry and local revocation close on bounded fake-clock checks', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  for (const reason of ['expiry', 'revocation'] as const) {
    const start = Date.now();
    const installationId = 'i'.repeat(43);
    let revoked = false;
    let calls = 0;
    let closes = 0;
    const socket = new EventEmitter() as EventEmitter & { close: (code: number, message: string) => void };
    socket.close = (code, message) => {
      assert.equal(code, 1008);
      assert.equal(message, 'Owner authorization failed');
      closes++;
      socket.emit('close');
    };
    const policy = createOwnerAdmissionPolicy({
      env: { FIREBASE_PROJECT_ID: 'fixture', FIREBASE_OWNER_UID: 'owner', FIREBASE_OWNER_HTTP_ENABLED: '1', FIREBASE_SESSION_ORIGIN: 'https://fixture.example' },
      getAuthority: () => ({ authenticate: () => {
        calls++;
        if (revoked) throw new Error('private revoke');
        return { uid: 'owner', projectId: 'fixture', installationId, service: 'gjc', expiresAt: start + (reason === 'expiry' ? 2000 : 60000) };
      } }),
    });
    const request = { headers: { host: 'fixture.example', cookie: `__Host-gjc-session=${'s'.repeat(43)}; __Host-gjc-installation=${installationId}` } };
    watchOwnerSession(socket as never, request as never, policy);
    await Promise.resolve();
    assert.equal(calls, 1);
    revoked = reason === 'revocation';
    t.mock.timers.tick(reason === 'expiry' ? 1999 : 14999);
    await Promise.resolve();
    assert.equal(closes, 0);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(closes, 1);
    assert.equal(calls, 2);
    t.mock.timers.tick(60000);
    await Promise.resolve();
    assert.equal(calls, 2);
  }
});

test('WebSocket close and error cancel pending revalidation timers', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  for (const event of ['close', 'error']) {
    let calls = 0;
    const socket = new EventEmitter();
    const policy = {
      configured: true,
      authenticate: () => { calls++; return { expiresAt: Date.now() + 60000 }; },
    };
    watchOwnerSession(socket as never, {} as never, policy as never);
    await Promise.resolve();
    socket.emit(event);
    t.mock.timers.tick(60000);
    await Promise.resolve();
    assert.equal(calls, 1);
  }
});
