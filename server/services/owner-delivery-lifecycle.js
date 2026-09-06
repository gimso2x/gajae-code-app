import { createOwnerFcmDelivery } from './owner-fcm-delivery.js';

const POLL_MS = 30_000;
const SHUTDOWN_WAIT_MS = 30_000;
const SOURCES = ['gjc', 'board', 'proxy'];

export function createOwnerDeliveryLifecycle({ env = process.env, createSender = createOwnerFcmDelivery,
  schedule = setTimeout, cancel = clearTimeout, warn = (message) => console.warn(message) } = {}) {
  let state = 'idle';
  let timer;
  let work;
  let sender;
  const block = () => { state = 'blocked'; warn('[FCM] Delivery stopped; operator review required.'); };
  const run = async () => {
    // A referenced timer keeps unresolved SDK work alive even during shutdown;
    // unlike a Promise alone, this prevents accidental process exit.
    let keepAlive;
    const hold = () => { keepAlive = schedule(hold, POLL_MS); };
    hold();
    try {
      for (const source of SOURCES) {
        if (state !== 'running') break;
        const result = await sender.drain({ source, limit: 1 });
        if (['blocked', 'lease-lost', 'disabled', 'busy'].includes(result.status)) {
          if (state === 'running') block();
          break;
        }
      }
    } catch {
      if (state === 'running') block();
    } finally {
      cancel(keepAlive);
      if (state === 'running') timer = schedule(tick, POLL_MS);
    }
  };
  const tick = () => {
    timer = undefined;
    if (state === 'running') work = run();
  };
  return {
    start() {
      if (state !== 'idle') return state;
      if (env.GJC_FCM_DELIVERY_ENABLED !== '1') { state = 'disabled'; return state; }
      if (!env.FIREBASE_OWNER_UID?.trim() || !env.FIREBASE_PROJECT_ID?.trim()) { block(); return state; }
      try {
        sender = createSender({ enabled: true, ownerUid: env.FIREBASE_OWNER_UID, projectId: env.FIREBASE_PROJECT_ID });
      } catch { block(); return state; }
      state = 'running';
      timer = schedule(tick, 0);
      return state;
    },
    async stop() {
      state = 'stopped';
      if (timer !== undefined) { cancel(timer); timer = undefined; }
      if (!work) return { settled: true };
      let deadline;
      const settled = await Promise.race([
        work.then(() => true),
        new Promise((resolve) => { deadline = schedule(() => resolve(false), SHUTDOWN_WAIT_MS); }),
      ]);
      if (deadline !== undefined) cancel(deadline);
      return { settled };
    },
    async settled() { await work; },
  };
}
