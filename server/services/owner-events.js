import { createHash, timingSafeEqual } from 'node:crypto';

import { createOwnerEventRepository } from '../modules/database/index.js';

const TYPES = { gjc: ['action.requested', 'task.completed'], board: ['ticket.changed', 'action.requested'], proxy: ['reauth.required'] };
const FIELDS = ['eventId', 'source', 'type', 'targetId', 'occurredAt', 'deduplicationKey'];
const digest = (value) => createHash('sha256').update(value).digest();

export class OwnerEventError extends Error {
  constructor(code) { super('Event intake rejected'); this.code = code; }
}

function validateEnvelope(event, source) {
  if (!event || Object.getPrototypeOf(event) !== Object.prototype
    || Reflect.ownKeys(event).length !== FIELDS.length
    || Reflect.ownKeys(event).some((key) => !FIELDS.includes(key))
    || FIELDS.some((key) => typeof event[key] !== 'string')) throw new OwnerEventError('invalid');
  if (event.source !== source || !TYPES[source].includes(event.type)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.eventId)
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(event.targetId)
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(event.deduplicationKey)) throw new OwnerEventError('invalid');
  const timestamp = event.occurredAt;
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))) throw new OwnerEventError('invalid');
  const [year, month, day] = timestamp.slice(0, 10).split('-').map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) throw new OwnerEventError('invalid');
  if (source === 'board' && (!/^tck-\d{8}-\d{6}x*$/.test(event.targetId)
    || !event.deduplicationKey.startsWith(`board:${event.targetId}:`)
    || !/^[1-9]\d*$/.test(event.deduplicationKey.slice(`board:${event.targetId}:`.length)))) throw new OwnerEventError('invalid');
  // Canonical field order makes retry equivalence independent of JSON key order.
  return Object.fromEntries(FIELDS.map((key) => [key, event[key]]));
}

// Config is explicit server-side producer configuration, never a Firebase ID token.
export function createOwnerEventAuthority({ ownerUid, projectId, producerSecrets = {}, repository = createOwnerEventRepository() } = {}) {
  const secrets = new Map();
  for (const source of Object.keys(TYPES)) {
    const secret = producerSecrets[source];
    if (typeof secret === 'string' && secret.length >= 32 && secret.length <= 4096) secrets.set(source, digest(secret));
  }
  const scope = (source) => {
    if (typeof ownerUid !== 'string' || !ownerUid.trim() || typeof projectId !== 'string' || !projectId.trim()
      || !Object.hasOwn(TYPES, source)) throw new OwnerEventError('unavailable');
    return { uid: ownerUid, project: projectId, source };
  };
  return {
    accept({ source, credential, event }) {
      const binding = scope(source);
      const expected = secrets.get(source);
      if (!expected) throw new OwnerEventError('unavailable');
      if (typeof credential !== 'string' || credential.length > 4096 || !timingSafeEqual(digest(credential), expected)) throw new OwnerEventError('unauthorized');
      const envelope = validateEnvelope(event, source);
      const result = repository.insert(binding, envelope);
      if (result === 'conflict') throw new OwnerEventError('conflict');
      return { eventId: envelope.eventId, accepted: true, duplicate: result === 'duplicate' };
    },
    pending({ source, limit = 20 }) {
      const binding = scope(source);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new OwnerEventError('invalid');
      return repository.pending(binding, limit);
    },
  };
}
