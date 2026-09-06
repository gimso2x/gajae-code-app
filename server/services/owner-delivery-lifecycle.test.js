import assert from 'node:assert/strict';
import test from 'node:test';

import { createOwnerDeliveryLifecycle } from './owner-delivery-lifecycle.js';

function scheduler() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  return {
    schedule(callback, delay) { const token = ++id; timers.set(token, { callback, at: now + delay }); return token; },
    cancel(token) { timers.delete(token); },
    tick(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = end;
    },
    count: () => timers.size,
  };
}
const enabled = { GJC_FCM_DELIVERY_ENABLED: '1', FIREBASE_OWNER_UID: 'owner', FIREBASE_PROJECT_ID: 'fixture' };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('disabled or incomplete configuration never constructs sender and start is idempotent', async () => {
  for (const env of [{}, { ...enabled, FIREBASE_OWNER_UID: '' }]) {
    let calls = 0;
    const clock = scheduler();
    const lifecycle = createOwnerDeliveryLifecycle({ env, ...clock, warn: () => {}, createSender: () => { calls++; throw new Error(); } });
    const state = lifecycle.start();
    assert.equal(lifecycle.start(), state);
    assert.equal(calls, 0);
    assert.equal(clock.count(), 0);
    assert.deepEqual(await lifecycle.stop(), { settled: true });
  }
});

test('sources run sequentially and poll only thirty seconds after settlement', async () => {
  const clock = scheduler();
  const sources = [];
  let finish;
  const lifecycle = createOwnerDeliveryLifecycle({ env: enabled, ...clock,
    createSender: () => ({ drain: ({ source, limit }) => {
      assert.equal(limit, 1); sources.push(source);
      return new Promise((resolve) => { finish = resolve; });
    } }),
  });
  lifecycle.start(); lifecycle.start(); clock.tick(0);
  assert.deepEqual(sources, ['gjc']);
  clock.tick(90000); await flush();
  assert.deepEqual(sources, ['gjc']);
  finish({ status: 'idle' }); await flush(); assert.deepEqual(sources, ['gjc', 'board']);
  finish({ status: 'idle' }); await flush(); assert.deepEqual(sources, ['gjc', 'board', 'proxy']);
  finish({ status: 'idle' }); await flush();
  clock.tick(29999); assert.equal(sources.length, 3);
  clock.tick(1); assert.equal(sources.length, 4);
  const stopping = lifecycle.stop();
  finish({ status: 'idle' }); await flush();
  assert.deepEqual(await stopping, { settled: true });
  clock.tick(60000); assert.equal(sources.length, 4); assert.equal(clock.count(), 0);
});

test('bounded stop reports unresolved send without cancellation and retains liveness until real settlement', async () => {
  const clock = scheduler();
  let finish;
  const lifecycle = createOwnerDeliveryLifecycle({ env: enabled, ...clock,
    createSender: () => ({ drain: () => new Promise((resolve) => { finish = resolve; }) }),
  });
  lifecycle.start(); clock.tick(0);
  const stopping = lifecycle.stop(); clock.tick(30000); await flush();
  assert.deepEqual(await stopping, { settled: false });
  assert.equal(clock.count(), 1);
  finish({ status: 'idle' }); await lifecycle.settled();
  assert.equal(clock.count(), 0);
  assert.deepEqual(await lifecycle.stop(), { settled: true });
});

test('blocked result stops future polling with generic operator notice', async () => {
  const clock = scheduler();
  const logs = [];
  let calls = 0;
  const lifecycle = createOwnerDeliveryLifecycle({ env: enabled, ...clock, warn: (message) => logs.push(message),
    createSender: () => ({ drain: async () => { calls++; return { status: 'blocked' }; } }),
  });
  lifecycle.start(); clock.tick(0); await flush(); clock.tick(120000);
  assert.equal(calls, 1); assert.equal(clock.count(), 0);
  assert.deepEqual(logs, ['[FCM] Delivery stopped; operator review required.']);
  assert.equal(lifecycle.start(), 'blocked');
  await lifecycle.stop();
});
