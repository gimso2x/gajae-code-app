import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const IDENTITY_APP_NAME = 'gjc-firebase-identity';

export function getFirebaseIdentityApp(projectId, sdk = { applicationDefault, getApps, initializeApp }) {
  const existing = sdk.getApps().find((app) => app.name === IDENTITY_APP_NAME);
  if (existing) {
    if (existing.options.projectId !== projectId) throw new Error('Identity project mismatch');
    return existing;
  }
  return sdk.initializeApp({ projectId, credential: sdk.applicationDefault() }, IDENTITY_APP_NAME);
}

export class FirebaseIdentityError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createVerifiedIdentity({
  env = process.env,
  verifyIdToken,
  includeExpiry = false,
} = {}) {
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  let auth;

  return async (idToken) => {
    // Identity verification is not an emulator or an owner/session bootstrap.
    if (!projectId || env.FIREBASE_AUTH_EMULATOR_HOST) {
      throw new FirebaseIdentityError(503, 'Identity verification unavailable');
    }
    if (typeof idToken !== 'string' || idToken.length > 16384
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken)) {
      throw new FirebaseIdentityError(400, 'Invalid identity request');
    }

    if (!verifyIdToken && !auth) {
      try {
        // ADC is resolved only when an identity request actually needs the SDK.
        auth = getAuth(getFirebaseIdentityApp(projectId));
      } catch {
        throw new FirebaseIdentityError(503, 'Identity verification unavailable');
      }
    }

    try {
      const decoded = await (verifyIdToken
        ? verifyIdToken(idToken, true)
        : auth.verifyIdToken(idToken, true));
      if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid || decoded.uid.length > 128
        || decoded.aud !== projectId || decoded.iss !== `https://securetoken.google.com/${projectId}`) {
        throw new Error('Invalid identity');
      }
      if (includeExpiry) {
        const expiresAt = decoded.exp * 1000;
        if (!Number.isSafeInteger(decoded.exp) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
          throw new Error('Invalid identity expiry');
        }
        return { uid: decoded.uid, projectId, expiresAt };
      }
      return { uid: decoded.uid, projectId };
    } catch {
      throw new FirebaseIdentityError(401, 'Identity verification failed');
    }
  };
}
export function createFirebaseIdentityVerifier(options = {}) {
  return createVerifiedIdentity(options);
}

export function createFirebaseSessionIdentityVerifier(options = {}) {
  return createVerifiedIdentity({ ...options, includeExpiry: true });
}
