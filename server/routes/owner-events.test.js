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
import { createOwnerEventRepository } from '../modules/database/index.js';

const secret = 'fixture-board-secret'.repeat(3);
const event = { eventId: 'af112233-4455-4677-8899-aabbccddeeff', source: 'board', type: 'ticket.changed', targetId: 'tck-20260907-010203', occurredAt: '2026-09-07T01:02:03+09:00', deduplicationKey: 'board:tck-20260907-010203:1' };
async function fixture(t, override = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gjc-event-http-'));
  const db = new Database(path.join(directory, 'auth.db'));
  const env = { FIREBASE_PROJECT_ID: 'fixture', FIREBASE_OWNER_UID: 'owner', FIREBASE_SESSION_ORIGIN: 'https://fixture.example', BOARD_EVENT_PRODUCER_SECRET: secret, ...override };
  const { server, wss } = createGjcAppFactory({
    authority: {}, orchestrator: { deps: {} }, gitService: {}, projection: {},
    authenticateWebSocket: () => null, authenticateGjcRoute: (_req, res) => res.sendStatus(401),
    validateApiKey: (req, res, next) => req.headers['x-api-key'] === 'fixture-key' ? next() : res.sendStatus(401),
    chat: {}, shell: {}, ownerPolicy: createOwnerAdmissionPolicy({ env }),
    eventIntake: { env, repository: createOwnerEventRepository(() => db) },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    db.close(); rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    send: (body = event, headers = {}, target = '/api/internal/events', method = 'POST', label = `${method} ${target}`) => new Promise((resolve, reject) => {
      const payload = ['GET', 'HEAD'].includes(method) ? '' : JSON.stringify(body);
      const fail = (error) => reject(new Error(`${label}: transport failure`, { cause: error }));
      const req = request({ host: '127.0.0.1', port: server.address().port, path: target, method, agent: false,
        headers: { Host: 'fixture.example', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': 'fixture-key', Authorization: `Bearer ${secret}`, ...headers },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('Response aborted')));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', fail);
      req.end(payload);
    }),
  };
}

describe('machine intake behind production host admission', { concurrency: false }, () => {
  let previousAllowedHosts;
  let previousDesktop;
  before(() => {
    previousAllowedHosts = process.env.ALLOWED_HOSTS;
    previousDesktop = process.env.GJC_DESKTOP;
    process.env.ALLOWED_HOSTS = 'fixture.example,other-fixture.example';
    process.env.GJC_DESKTOP = '0';
  });
  after(() => {
    if (previousAllowedHosts === undefined) delete process.env.ALLOWED_HOSTS;
    else process.env.ALLOWED_HOSTS = previousAllowedHosts;
    if (previousDesktop === undefined) delete process.env.GJC_DESKTOP;
    else process.env.GJC_DESKTOP = previousDesktop;
  });

test('machine intake durably acknowledges duplicate Board envelope and rejects conflicting or private content', async (t) => {
  const f = await fixture(t);
  const first = await f.send();
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).accepted, true);
  assert.equal((await f.send()).status, 200);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM owner_events').get().n, 1);
  assert.equal((await f.send({ ...event, type: 'action.requested' })).status, 409);
  assert.equal((await f.send({ ...event, body: 'private' })).status, 422);
  assert.equal((await f.send({ ...event, body: 'x'.repeat(9000) })).status, 422);
});

test('machine credentials do not bypass source, Host, deployment key or exact path guards', async (t) => {
  const f = await fixture(t);
  for (const [label, headers] of [
    ['missing bearer', { Authorization: '' }],
    ['Firebase token is not producer credential', { Authorization: 'Bearer firebase.user.token' }],
    ['admitted Host differs from intake Host', { Host: 'other-fixture.example' }],
    ['missing deployment key', { 'x-api-key': '' }],
  ]) {
    assert.equal((await f.send(event, headers, '/api/internal/events', 'POST', label)).status, 401, label);
  }
  assert.equal((await f.send(event, { Host: 'evil.example' }, '/api/internal/events', 'POST', 'outer Host rejection')).status, 403, 'outer Host rejection');
  assert.equal((await f.send({ ...event, source: 'gjc' }, {}, '/api/internal/events', 'POST', 'unconfigured source')).status, 503, 'unconfigured source');
  assert.equal((await f.send(event, {}, '/api/internal/events', 'GET')).status, 503, 'GET remains protected');
  assert.equal((await f.send(event, {}, '/api/internal/events/')).status, 503, 'trailing slash remains protected');
  assert.equal((await f.send(event, {}, '/api/internal/events/other')).status, 503, 'nested path remains protected');
});

test('missing producer or owner configuration fails closed', async (t) => {
  for (const override of [{ BOARD_EVENT_PRODUCER_SECRET: '' }, { FIREBASE_OWNER_UID: '' }, { FIREBASE_PROJECT_ID: '' }]) {
    const f = await fixture(t, override);
    assert.equal((await f.send()).status, 503);
  }
});
});
