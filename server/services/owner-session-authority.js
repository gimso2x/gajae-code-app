import { createHash, randomBytes } from 'node:crypto';

import { createOwnerSessionRepository } from '../modules/database/index.js';

const CODE_TTL_MS = 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const SERVICE = 'gjc';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');

export class OwnerSessionError extends Error {
  constructor() { super('Owner authorization failed'); }
}

export function createOwnerSessionAuthority({
  env = process.env,
  verifyIdentity,
  repository = createOwnerSessionRepository(),
  now = Date.now,
} = {}) {
  const uid = env.FIREBASE_OWNER_UID?.trim();
  const project = env.FIREBASE_PROJECT_ID?.trim();
  const scope = ({ installationId, service }) => {
    if (!uid || !project || service !== SERVICE || typeof installationId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(installationId)) throw new OwnerSessionError();
    return { uid, project, installation: installationId, service };
  };
  const binding = (input, value) => {
    const result = scope(input);
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new OwnerSessionError();
    return { ...result, hash: hash(value) };
  };
  return {
    async issueCode(input) {
      const owner = scope(input);
      if (typeof verifyIdentity !== 'function') throw new OwnerSessionError();
      let identity;
      try { identity = await verifyIdentity(input.idToken); } catch { throw new OwnerSessionError(); }
      const time = now();
      if (!identity || identity.uid !== uid || identity.projectId !== project
        || !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= time) throw new OwnerSessionError();
      // ponytail: no refresh/revocation polling yet; never outlive verified token validity.
      const sessionExpires = Math.min(time + SESSION_TTL_MS, identity.expiresAt);
      const expiresAt = Math.min(time + CODE_TTL_MS, sessionExpires);
      const code = opaque();
      repository.insertCode({ ...owner, hash: hash(code), expires: expiresAt, sessionExpires });
      return { code, expiresAt };
    },
    exchangeCode(input) {
      const owner = binding(input, input.code);
      const session = opaque();
      const consumed = repository.consumeCode(owner, hash(session), now());
      if (!consumed) throw new OwnerSessionError();
      return { session, expiresAt: consumed.expiresAt };
    },
    authenticate(input) {
      const owner = binding(input, input.session);
      const session = repository.authenticate(owner, now());
      if (!session) throw new OwnerSessionError();
      return { uid, projectId: project, installationId: owner.installation, service: SERVICE, expiresAt: session.expiresAt };
    },
    revokeSession(input) {
      if (!repository.revokeSession(binding(input, input.session), now())) throw new OwnerSessionError();
    },
    revokeInstallation(input) {
      if (!repository.revokeInstallation(binding(input, input.session), now())) throw new OwnerSessionError();
    },
  };
}
