import { createOwnerSessionAuthority } from '../services/owner-session-authority.js';

/**
 * @typedef {{uid: string | undefined, projectId: string | undefined, installationId: string, service: string, expiresAt: number}} OwnerIdentity
 * @typedef {{session: string, installationId: string, service: string}} OwnerBinding
 * @typedef {{authenticate: (binding: OwnerBinding) => OwnerIdentity | Promise<OwnerIdentity>}} OwnerAuthority
 * @typedef {{env?: Record<string, string | undefined>, getAuthority?: () => OwnerAuthority, now?: () => number}} OwnerAdmissionOptions
 */

const IDENTITY_ENDPOINTS = new Set(['GET /api/auth/firebase/login', 'GET /api/auth/firebase/login/', 'POST /api/auth/firebase/identity']);
const EXCHANGE_ENDPOINTS = new Set(['POST /api/auth/session/code', 'POST /api/auth/session/consume', 'POST /api/auth/session/native-consume']);

export function readOwnerSessionCookies(request) {
  const values = new Map();
  for (const part of (request.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    const name = (separator < 0 ? part : part.slice(0, separator)).trim();
    if (name !== '__Host-gjc-session' && name !== '__Host-gjc-installation') continue;
    if (values.has(name)) throw new Error('Duplicate cookie');
    const value = separator < 0 ? '' : part.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Invalid cookie');
    values.set(name, value);
  }
  return { session: values.get('__Host-gjc-session'), installationId: values.get('__Host-gjc-installation'), service: 'gjc' };
}

/** @param {OwnerAdmissionOptions} options */
export function createOwnerAdmissionPolicy({ env = process.env, getAuthority = () => createOwnerSessionAuthority({ env }), now = Date.now } = {}) {
  const configured = Boolean(env.FIREBASE_PROJECT_ID?.trim()) || env.FIREBASE_OWNER_HTTP_ENABLED === '1';
  const uid = env.FIREBASE_OWNER_UID?.trim();
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  let origin;
  try {
    const parsed = new URL(env.FIREBASE_SESSION_ORIGIN);
    if (parsed.protocol === 'https:' && parsed.origin === env.FIREBASE_SESSION_ORIGIN) origin = parsed;
  } catch { /* Invalid activation configuration remains fail closed. */ }
  /** @type {OwnerAuthority | undefined} */
  let authority;
  const ready = () => env.FIREBASE_OWNER_HTTP_ENABLED === '1' && uid && projectId && origin && !env.FIREBASE_AUTH_EMULATOR_HOST;
  /** @param {OwnerIdentity} identity @param {OwnerBinding} binding */
  const validate = (identity, binding) => {
    if (!identity || identity.uid !== uid || identity.projectId !== projectId
      || identity.installationId !== binding.installationId || identity.service !== 'gjc'
      || !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= now()) throw new Error('Unauthorized');
    return identity;
  };
  return {
    configured,
    ready,
    authenticate(request) {
      if (!ready() || request.headers.host !== origin.host) throw new Error('Unauthorized');
      if (request.headers.origin !== undefined && request.headers.origin !== origin.origin) throw new Error('Unauthorized');
      const binding = readOwnerSessionCookies(request);
      if (!binding.session || !binding.installationId) throw new Error('Unauthorized');
      authority ??= getAuthority();
      const result = authority.authenticate(binding);
      return result instanceof Promise ? result.then((identity) => validate(identity, binding)) : validate(result, binding);
    },
    mutationAllowed(request) { return request.headers.origin === origin?.origin; },
    hostAllowed(request) { return request.headers.host === origin?.host; },
  };
}

/** @param {OwnerAdmissionOptions & {policy?: ReturnType<typeof createOwnerAdmissionPolicy>}} options */
export function createOwnerHttpAdmission(options = {}) {
  const policy = options.policy ?? createOwnerAdmissionPolicy(options);
  return async (request, response, next) => {
    if (!policy.configured) return next();
    response.set('Cache-Control', 'no-store');
    const deny = (status) => response.status(status).json({ error: 'Owner authorization failed' });
    const endpoint = `${request.method} ${request.originalUrl.split('?')[0]}`;
    // Identity-only discovery never grants an owner session; outer admission stays in force.
    if (IDENTITY_ENDPOINTS.has(endpoint)) return next();
    if (!policy.ready()) return deny(503);
    try {
      if (!policy.hostAllowed(request)) return deny(401);
      if (EXCHANGE_ENDPOINTS.has(endpoint)) return next();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !policy.mutationAllowed(request)) return deny(401);
      request.ownerIdentity = await policy.authenticate(request);
    } catch {
      const pathname = request.originalUrl.split('?')[0];
      const pageNavigation = request.method === 'GET' && !/^\/(api|assets)(\/|$)/.test(pathname)
        && request.headers.accept?.includes('text/html')
        && (!request.headers['sec-fetch-mode'] || request.headers['sec-fetch-mode'] === 'navigate');
      if (pageNavigation && policy.hostAllowed(request)
        && (request.headers.origin === undefined || policy.mutationAllowed(request))) {
        return response.redirect(303, '/api/auth/firebase/login');
      }
      return deny(401);
    }
    return next();
  };
}
