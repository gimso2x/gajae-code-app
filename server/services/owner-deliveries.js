import { createOwnerDeliveryRepository, DELIVERY_RETRY_AFTER_MAX_SECONDS } from '../modules/database/index.js';

export function createOwnerDeliveryAuthority({ ownerUid, projectId, repository = createOwnerDeliveryRepository(), now = Date.now } = {}) {
  const scope = (source) => {
    if (typeof ownerUid !== 'string' || !ownerUid.trim() || typeof projectId !== 'string' || !projectId.trim()
      || !['gjc', 'board', 'proxy'].includes(source)) throw new Error('Delivery request rejected');
    return { uid: ownerUid, project: projectId, source };
  };
  const time = () => {
    const value = now();
    // Leave room for the largest retry delay and lease arithmetic.
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 86400_000) throw new Error('Delivery request rejected');
    return value;
  };
  return {
    claim({ source, limit = 20 }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Delivery request rejected');
      return repository.claim(scope(source), limit, time());
    },
    isSendable(input) {
      return repository.isSendable(scope(input.source), input, time());
    },
    renew(input) {
      return repository.renew(scope(input.source), input, time());
    },
    complete(input) {
      if (!['sent', 'retryable', 'payload-error', 'invalid-registration', 'blocked'].includes(input.outcome)
        || typeof input.claimToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.claimToken)
        || typeof input.eventId !== 'string' || typeof input.installationId !== 'string') throw new Error('Delivery request rejected');
      if (input.retryAfterSeconds !== undefined && (input.outcome !== 'retryable'
        || !Number.isInteger(input.retryAfterSeconds) || input.retryAfterSeconds < 0
        || input.retryAfterSeconds > DELIVERY_RETRY_AFTER_MAX_SECONDS)) throw new Error('Delivery request rejected');
      return repository.complete(scope(input.source), input, time());
    },
  };
}
