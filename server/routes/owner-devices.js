import express from 'express';

import { createFirebaseSessionIdentityVerifier } from '../services/firebase-identity.js';
import { createOwnerDeviceAuthority } from '../services/owner-devices.js';

export function isOwnerDeviceEndpoint(request) {
  return (request.method === 'POST' && request.path === '/api/devices')
    || (['GET', 'PATCH', 'DELETE'].includes(request.method) && /^\/api\/devices\/[A-Za-z0-9_-]{1,128}$/.test(request.path));
}

function rejectDuplicateKeys(_request, _response, buffer) {
  // Match express.json's empty-body handling before checking actual JSON keys.
  if (buffer.length === 0) return;
  const text = buffer.toString('utf8');
  JSON.parse(text);
  const stack = [];
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g) || [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[index + 1] === ':') {
      const keys = stack[stack.length - 1];
      const key = JSON.parse(token);
      if (keys?.has(key)) throw new Error('Duplicate key');
      keys?.add(key);
    }
  }
}

function fields(body, allowed, required) {
  if (!body || Object.getPrototypeOf(body) !== Object.prototype
    || Object.keys(body).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(body, key))) throw new Error('Invalid request');
}

export function createOwnerDevicesRouter({ env = process.env, repository, verifyIdToken } = {}) {
  const router = express.Router({ strict: true, caseSensitive: true });
  const authority = createOwnerDeviceAuthority({ env, repository, verifyIdentity: createFirebaseSessionIdentityVerifier({ env, verifyIdToken }) });
  router.use(express.json({ limit: '8kb', verify: rejectDuplicateKeys }));
  router.use(async (request, response) => {
    response.set('Cache-Control', 'no-store');
    if (!env.FIREBASE_OWNER_UID?.trim() || !env.FIREBASE_PROJECT_ID?.trim()) {
      return response.status(503).json({ error: 'Device request rejected' });
    }
    try {
      const origin = new URL(env.FIREBASE_SESSION_ORIGIN);
      if (origin.protocol !== 'https:' || origin.origin !== env.FIREBASE_SESSION_ORIGIN) throw new Error('Unavailable');
      if (request.headers.host !== origin.host || (request.headers.origin !== undefined && request.headers.origin !== origin.origin)) throw new Error('Unauthorized');
      const authorization = request.headers.authorization;
      if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/.test(authorization)) throw new Error('Unauthorized');
      const idToken = authorization.slice(7);
      const installationId = request.path.slice('/api/devices/'.length);
      let record;
      if (request.method === 'POST') {
        if (!request.is('application/json')) throw new Error('Invalid request');
        fields(request.body, ['installationId', 'platform', 'fcmToken', 'enabled'], ['installationId', 'platform', 'fcmToken']);
        record = await authority.register({ ...request.body, idToken });
      } else if (request.method === 'PATCH') {
        if (!request.is('application/json')) throw new Error('Invalid request');
        fields(request.body, ['enabled', 'fcmToken'], []);
        if (!Object.keys(request.body).length) throw new Error('Invalid request');
        // Token rotation uses the same atomic upsert as registration, but never creates an absent installation.
        if (Object.hasOwn(request.body, 'fcmToken')) {
          await authority.get({ idToken, installationId });
          record = await authority.register({ ...request.body, idToken, installationId, platform: 'android' });
        } else record = await authority.patchSettings({ idToken, installationId, enabled: request.body.enabled });
      } else {
        if (request.body && Object.keys(request.body).length) throw new Error('Invalid request');
        record = request.method === 'GET'
          ? await authority.get({ idToken, installationId })
          : await authority.revoke({ idToken, installationId });
      }
      return response.json(record);
    } catch {
      return response.status(401).json({ error: 'Device request rejected' });
    }
  });
  router.use((error, _request, response, next) => {
    if (['entity.too.large', 'entity.parse.failed', 'entity.verify.failed'].includes(error?.type)) {
      return response.status(422).json({ error: 'Device request rejected' });
    }
    return next(error);
  });
  return router;
}
