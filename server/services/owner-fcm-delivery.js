import { getMessaging } from 'firebase-admin/messaging';

import { getFirebaseIdentityApp } from './firebase-identity.js';
import { createOwnerDeliveryAuthority } from './owner-deliveries.js';

const TTL_MS = 60 * 60_000;
const TYPES = { gjc: ['action.requested', 'task.completed'], board: ['ticket.changed', 'action.requested'], proxy: ['reauth.required'] };

export function classifyOwnerMessagingError(error) {
  const code = error?.code;
  if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code)) return 'invalid-registration';
  if (['messaging/invalid-argument', 'messaging/invalid-payload', 'messaging/payload-size-limit-exceeded', 'messaging/invalid-data-payload-key'].includes(code)) return 'payload-error';
  if (['messaging/quota-exceeded', 'messaging/message-rate-exceeded', 'messaging/device-message-rate-exceeded',
    'messaging/server-unavailable', 'messaging/unavailable', 'messaging/internal-error', 'app/network-error', 'app/network-timeout',
    'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) return 'retryable';
  // Auth, configuration and unknown failures stop this obligation rather than hotloop.
  return 'blocked';
}

function messageFor(claim) {
  const event = claim.event;
  if (!Object.hasOwn(TYPES, event.source) || !TYPES[event.source].includes(event.type)) throw new Error('Invalid event');
  const fields = ['eventId', 'source', 'type', 'targetId', 'occurredAt', 'deduplicationKey'];
  if (fields.some((key) => typeof event[key] !== 'string')) throw new Error('Invalid event');
  const action = ['action.requested', 'reauth.required'].includes(event.type);
  return {
    token: claim.fcmToken,
    notification: { title: action ? 'Action required' : 'Update available', body: 'Open the app to view details.' },
    data: Object.fromEntries(fields.map((key) => [key, event[key]])),
    android: {
      priority: action ? 'high' : 'normal',
      // One-hour transport TTL is conservative, not a lossless delivery promise.
      ttl: TTL_MS,
      notification: { channelId: action ? 'action_requests' : 'updates', tag: event.eventId },
    },
  };
}

export function createOwnerFcmDelivery({ enabled = false, ownerUid, projectId, authority,
  messaging = getMessaging, appSdk } = {}) {
  let active = false;
  let queue;
  let sender;
  return {
    async drain({ source, limit = 20 } = {}) {
      if (enabled !== true || typeof ownerUid !== 'string' || !ownerUid.trim() || typeof projectId !== 'string' || !projectId.trim()) return { status: 'disabled', processed: 0 };
      if (!Object.hasOwn(TYPES, source) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid drain request');
      if (active) return { status: 'busy', processed: 0 };
      active = true;
      let processed = 0;
      try {
        queue ??= authority ?? createOwnerDeliveryAuthority({ ownerUid, projectId });
        while (processed < limit) {
          const [claim] = queue.claim({ source, limit: 1 });
          if (!claim) break;
          const key = { source, eventId: claim.event.eventId, installationId: claim.installationId, claimToken: claim.claimToken };
          if (!queue.isSendable(key)) break;
          let outcome;
          let retryAfterSeconds;
          let leaseLost = false;
          let message;
          try { message = messageFor(claim); } catch { outcome = 'payload-error'; }
          if (!outcome) {
            try {
              sender ??= messaging(getFirebaseIdentityApp(projectId, appSdk));
              // Official SDK send has no AbortSignal API. Await settlement; do not
              // race a timeout and retry an unresolved send. SDK HTTP timeout is 15s,
              // but credential work/retries mean this is not a total-call deadline.
              if (!queue.isSendable(key)) break;
              const renewal = setInterval(() => {
                if (leaseLost) return;
                try { if (!queue.renew(key)) leaseLost = true; } catch { leaseLost = true; }
              }, 20_000);
              renewal.unref();
              try { await sender.send(message); } finally { clearInterval(renewal); }
              outcome = 'sent';
            } catch (error) {
              outcome = classifyOwnerMessagingError(error);
              if (outcome === 'retryable') retryAfterSeconds = messagingRetryAfter(error);
            }
          }
          if (leaseLost) return { status: 'lease-lost', processed };
          queue.complete({ ...key, outcome, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) });
          processed++;
          if (outcome === 'blocked') return { status: 'blocked', processed };
        }
        return { status: 'idle', processed };
      } finally { active = false; }
    },
  };
}

export function messagingRetryAfter(error, now = Date.now()) {
  // Firebase Admin 14.3 exposes HttpResponse.headers on FirebaseError.
  const headers = error?.httpResponse?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const entries = Object.entries(headers).filter(([name]) => name.toLowerCase() === 'retry-after');
  if (entries.length !== 1 || typeof entries[0][1] !== 'string') return undefined;
  const value = entries[0][1].trim();
  let seconds;
  if (/^\d+$/.test(value)) seconds = Number(value);
  else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    const date = Date.parse(value);
    if (!Number.isFinite(date)) return undefined;
    seconds = Math.max(0, Math.ceil((date - now) / 1000));
  } else return undefined;
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86400 ? seconds : undefined;
}
