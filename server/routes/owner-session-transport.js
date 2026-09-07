import { randomBytes } from 'node:crypto';

import express from 'express';

import { readOwnerSessionCookies } from '../middleware/owner-http-auth.js';

const SESSION_COOKIE = '__Host-gjc-session';
const INSTALLATION_COOKIE = '__Host-gjc-installation';
const cookieOptions = { secure: true, httpOnly: true, sameSite: 'lax', path: '/' };

export function createOwnerSessionRouter({ authority, env }) {
  const router = express.Router();
  let origin;
  try {
    const url = new URL(env.FIREBASE_SESSION_ORIGIN);
    if (url.protocol === 'https:' && url.origin === env.FIREBASE_SESSION_ORIGIN) origin = url.origin;
  } catch { /* Missing or malformed origin disables session transport. */ }
  const admit = (request, allowNative) => {
    if (!origin || request.headers.host !== new URL(origin).host) throw new Error('Unavailable');
    if (request.headers.origin === origin) return;
    // Native WebView POST has no Origin: only explicit native exchange accepts
    // omission, backed by the short-lived one-use code and opaque binding.
    // Sec-Fetch-Site denies known browser cross-site requests; Origin is not auth.
    if (allowNative && request.headers.origin === undefined
      && (!request.headers['sec-fetch-site'] || request.headers['sec-fetch-site'] === 'none')) return;
    if (allowNative && request.originalUrl === '/api/auth/session/native-consume'
      && request.headers.origin === 'null' && request.headers['sec-fetch-site'] === 'none') return;
    throw new Error('Forbidden origin');
  };
  const route = (handler) => async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try { await handler(request, response); } catch {
      response.status(401).json({ error: 'Owner authorization failed' });
    }
  };
  router.post('/code', route(async (request, response) => {
    admit(request, true);
    // Server-selected opaque installation binding; never accept a header ID.
    const installationId = randomBytes(32).toString('base64url');
    const grant = await authority.issueCode({ idToken: request.body?.idToken, installationId, service: 'gjc' });
    response.json({ ...grant, installationId });
  }));
  const consume = (allowNative) => route(async (request, response) => {
    admit(request, allowNative);
    const installationId = request.body?.installationId;
    if (typeof installationId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(installationId)) throw new Error('Invalid binding');
    const grant = authority.exchangeCode({ code: request.body?.code, installationId, service: 'gjc' });
    const options = { ...cookieOptions, expires: new Date(grant.expiresAt) };
    response.cookie(SESSION_COOKIE, grant.session, options);
    response.cookie(INSTALLATION_COOKIE, installationId, options);
    response.redirect(303, '/');
  });
  router.post('/consume', consume(false));
  router.post('/native-consume', express.urlencoded({ extended: false, limit: '4kb' }), consume(true));
  router.post('/logout', route(async (request, response) => {
    admit(request, false);
    authority.revokeSession(readOwnerSessionCookies(request));
    response.clearCookie(SESSION_COOKIE, cookieOptions);
    response.clearCookie(INSTALLATION_COOKIE, cookieOptions);
    response.status(204).end();
  }));
  return router;
}
