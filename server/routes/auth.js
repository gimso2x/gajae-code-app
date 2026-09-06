import express from 'express';

import { authenticateToken } from '../middleware/auth.js';
import { isDesktopMode } from '../middleware/desktop-auth.js';
import { createFirebaseIdentityVerifier, createFirebaseSessionIdentityVerifier, FirebaseIdentityError } from '../services/firebase-identity.js';
import { createOwnerSessionAuthority } from '../services/owner-session-authority.js';

import { firebaseLoginPage } from './firebase-login-page.js';
import { createOwnerSessionRouter } from './owner-session-transport.js';

export function createAuthRouter({ env = process.env, verifyIdToken, sessionRepository } = {}) {
  const router = express.Router();
  const verifyIdentity = createFirebaseIdentityVerifier({ env, verifyIdToken });
  const authority = createOwnerSessionAuthority({
    env, repository: sessionRepository,
    verifyIdentity: createFirebaseSessionIdentityVerifier({ env, verifyIdToken }),
  });
  router.use('/session', createOwnerSessionRouter({ authority, env }));

  router.get('/firebase/login', (_req, res) => {
    const page = firebaseLoginPage(env);
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': page.csp,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.status(page.status).type('html').send(page.html);
  });
  // Identity only: admission remains in the app; this grants no service access.
  router.post('/firebase/identity', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const identity = await verifyIdentity(req.body?.idToken);
      return res.json(identity);
    } catch (error) {
      const status = error instanceof FirebaseIdentityError ? error.status : 503;
      const message = error instanceof FirebaseIdentityError ? error.message : 'Identity verification unavailable';
      return res.status(status).json({ error: message });
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json({
      user: req.user,
      // The desktop webview is a loopback origin with no Tauri IPC; the client
      // needs to know it is inside the shell to route external links through
      // the sidecar instead of window.open.
      shell: { desktop: isDesktopMode() },
    });
  });

  return router;
}

export default createAuthRouter();
