import { randomBytes } from 'node:crypto';

const SDK_ORIGIN = 'https://www.gstatic.com';
const SDK_VERSION = '12.9.0';

export function firebaseLoginPage(env) {
  const config = {
    apiKey: env.FIREBASE_WEB_API_KEY?.trim(),
    authDomain: env.FIREBASE_AUTH_DOMAIN?.trim(),
    projectId: env.FIREBASE_PROJECT_ID?.trim(),
    appId: env.FIREBASE_WEB_APP_ID?.trim(),
  };
  const available = Object.values(config).every(Boolean)
    && /^[a-z0-9.-]+$/.test(config.authDomain)
    && !env.FIREBASE_AUTH_EMULATOR_HOST;
  const ownerLogin = env.FIREBASE_OWNER_HTTP_ENABLED === '1';
  const nonce = randomBytes(24).toString('base64');
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${SDK_ORIGIN} https://apis.google.com`,
    "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com",
    available ? `frame-src https://${config.authDomain} https://accounts.google.com` : "frame-src 'none'",
    "style-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ');
  const serialized = JSON.stringify(config).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return {
    status: available ? 200 : 503,
    csp,
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ownerLogin ? 'Sign in to Gajae Code' : 'Verify Google identity'}</title></head>
<body><h1>${ownerLogin ? 'Sign in to Gajae Code' : 'Verify Google identity'}</h1>
<p>${ownerLogin ? 'Sign in with the configured owner Google account to open the app.' : 'This verifies identity only. It does not grant access to service data or create a service session.'}</p>
<p>Existing deployment admission is required. If this deployment requires an API key, supply it below for the verification request. This page does not bypass that gate.</p>
<label>Deployment API key (when required) <input id="deployment-key" type="password" autocomplete="off"></label>
<button id="sign-in" type="button" disabled>Verify with Google</button>
<p id="status" role="status">${available ? 'Loading Google sign-in…' : 'Identity verification unavailable'}</p>
${available ? `<script type="module" nonce="${nonce}">
const button = document.getElementById('sign-in');
const status = document.getElementById('status');
const keyInput = document.getElementById('deployment-key');
try {
  const { initializeApp } = await import('${SDK_ORIGIN}/firebasejs/${SDK_VERSION}/firebase-app.js');
  const { initializeAuth, inMemoryPersistence, browserPopupRedirectResolver, GoogleAuthProvider, signInWithPopup, signOut } = await import('${SDK_ORIGIN}/firebasejs/${SDK_VERSION}/firebase-auth.js');
  const config = ${serialized};
  const auth = initializeAuth(initializeApp(config), {
    persistence: inMemoryPersistence,
    popupRedirectResolver: browserPopupRedirectResolver,
  });
  button.disabled = false;
  status.textContent = ${JSON.stringify(ownerLogin ? 'Sign in with your owner account.' : 'Ready to verify identity. No service access will be granted.')};
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Verifying identity…';
    let authenticated = false;
    try {
      const result = await signInWithPopup(auth, new GoogleAuthProvider());
      const headers = { 'Content-Type': 'application/json' };
      if (keyInput.value) headers['x-api-key'] = keyInput.value;
      keyInput.value = '';
      const response = await fetch('${ownerLogin ? '/api/auth/session/code' : '/api/auth/firebase/identity'}', {
        method: 'POST', headers, credentials: 'same-origin', cache: 'no-store',
        body: JSON.stringify({ idToken: await result.user.getIdToken() }),
      });
      if (!response.ok) throw new Error('Identity verification failed');
      ${ownerLogin ? `const grant = await response.json();
      if (!/^[A-Za-z0-9_-]{43}$/.test(grant.code) || !/^[A-Za-z0-9_-]{43}$/.test(grant.installationId)) throw new Error('Invalid grant');
      const consumed = await fetch('/api/auth/session/consume', {
        method: 'POST', headers, credentials: 'same-origin', cache: 'no-store',
        body: JSON.stringify({ code: grant.code, installationId: grant.installationId }),
      });
      if (!consumed.ok) throw new Error('Session exchange failed');
      authenticated = true;` : `const identity = await response.json();
      if (typeof identity.uid !== 'string' || identity.projectId !== config.projectId) throw new Error('Invalid identity');
      status.textContent = 'Verified UID: ' + identity.uid + ' — Project: ' + identity.projectId + '. No service access granted.';`}
    } catch {
      status.textContent = 'Identity verification failed. Check deployment admission or try again.';
    } finally {
      keyInput.value = '';
      try { await signOut(auth); } catch { authenticated = false; status.textContent = 'Identity cleanup failed. Close this page.'; }
      button.disabled = false;
    }
    if (authenticated) window.location.replace('/');
  });
} catch {
  status.textContent = 'Identity verification unavailable';
}
</script>` : ''}
</body></html>`,
  };
}
