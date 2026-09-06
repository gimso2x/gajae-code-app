import express from 'express';

import { createOwnerEventAuthority, OwnerEventError } from '../services/owner-events.js';

export function createOwnerEventsRouter({ env = process.env, repository } = {}) {
  const router = express.Router({ strict: true, caseSensitive: true });
  router.post('/api/internal/events', express.json({ limit: '8kb', strict: true }), (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      let origin;
      try {
        origin = new URL(env.FIREBASE_SESSION_ORIGIN);
        if (origin.protocol !== 'https:' || origin.origin !== env.FIREBASE_SESSION_ORIGIN) throw new Error();
      } catch { throw new OwnerEventError('unavailable'); }
      if (request.headers.host !== origin.host || (request.headers.origin !== undefined && request.headers.origin !== origin.origin)) throw new OwnerEventError('unauthorized');
      const authorization = request.headers.authorization;
      if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/.test(authorization)) throw new OwnerEventError('unauthorized');
      if (!request.is('application/json')) throw new OwnerEventError('invalid');
      // Resolve server-only producer configuration on invocation, never import.
      const authority = createOwnerEventAuthority({
        ownerUid: env.FIREBASE_OWNER_UID, projectId: env.FIREBASE_PROJECT_ID, repository,
        producerSecrets: { gjc: env.GJC_EVENT_PRODUCER_SECRET, board: env.BOARD_EVENT_PRODUCER_SECRET, proxy: env.PROXY_EVENT_PRODUCER_SECRET },
      });
      const result = authority.accept({ source: request.body?.source, credential: authorization.slice(7), event: request.body });
      return response.status(200).json(result);
    } catch (error) {
      const statuses = { unauthorized: 401, unavailable: 503, invalid: 422, conflict: 409 };
      return response.status(error instanceof OwnerEventError ? statuses[error.code] ?? 503 : 503).json({ error: 'Event intake rejected' });
    }
  });
  router.use((error, _request, response, next) => {
    if (error?.type === 'entity.too.large' || error?.type === 'entity.parse.failed') {
      return response.status(422).json({ error: 'Event intake rejected' });
    }
    return next(error);
  });
  return router;
}
