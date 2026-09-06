import { createOwnerDeviceRepository } from '../modules/database/index.js';

export class OwnerDeviceError extends Error {
  constructor() { super('Device authorization or request failed'); }
}

const settingsPatch = (enabled) => {
  if (!enabled || Object.getPrototypeOf(enabled) !== Object.prototype
    || Reflect.ownKeys(enabled).some((key) => !['gjc', 'board', 'proxy'].includes(key) || typeof enabled[key] !== 'boolean')) {
    throw new OwnerDeviceError();
  }
  return enabled;
};

export function createOwnerDeviceAuthority({ env = process.env, verifyIdentity, repository = createOwnerDeviceRepository(), now = Date.now } = {}) {
  const uid = env.FIREBASE_OWNER_UID?.trim();
  const project = env.FIREBASE_PROJECT_ID?.trim();
  const authorize = async (input) => {
    if (!uid || !project || typeof verifyIdentity !== 'function'
      || typeof input.installationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.installationId)) throw new OwnerDeviceError();
    let identity;
    try { identity = await verifyIdentity(input.idToken); } catch { throw new OwnerDeviceError(); }
    if (!identity || identity.uid !== uid || identity.projectId !== project
      || !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= now()) throw new OwnerDeviceError();
    // Installation IDs partition one owner's records; they do not attest physical device ownership.
    return { uid, project, installation: input.installationId };
  };
  const required = (record) => { if (!record) throw new OwnerDeviceError(); return record; };
  return {
    async register(input) {
      const scope = await authorize(input);
      if (input.platform !== 'android' || typeof input.fcmToken !== 'string'
        || input.fcmToken.length < 1 || input.fcmToken.length > 4096 || /\s/.test(input.fcmToken)) throw new OwnerDeviceError();
      const enabled = settingsPatch(input.enabled === undefined ? {} : input.enabled);
      return repository.upsert(scope, input.fcmToken, enabled);
    },
    async get(input) { return required(repository.get(await authorize(input))); },
    async patchSettings(input) {
      const scope = await authorize(input);
      return required(repository.patch(scope, settingsPatch(input.enabled)));
    },
    async revoke(input) { return required(repository.revoke(await authorize(input))); },
  };
}
