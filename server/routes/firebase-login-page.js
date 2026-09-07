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
    `style-src 'nonce-${nonce}'`, "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ');
  const serialized = JSON.stringify(config).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return {
    status: available ? 200 : 503,
    csp,
    html: `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ownerLogin ? 'GJC 로그인' : 'Google 계정 확인'}</title>
<style nonce="${nonce}">
:root { color-scheme: dark; font-family: system-ui, sans-serif; --background: 0 0% 8%; --foreground: 40 8% 93%; --card: 0 0% 12%; --border: 0 0% 23%; --primary: 16 90% 57%; --muted-foreground: 0 0% 60%; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 1.25rem; background: hsl(var(--background)); color: hsl(var(--foreground)); }
main { width: 100%; max-width: 28rem; padding: clamp(1.25rem, 5vw, 2.5rem); border: 1px solid hsl(var(--border)); border-radius: 1rem; background: hsl(var(--card)); }
h1 { margin-top: 0; font-size: 1.75rem; letter-spacing: -.025em; }
p { line-height: 1.65; overflow-wrap: anywhere; }
button { width: 100%; min-height: 3rem; padding: .75rem 1rem; border: 1px solid hsl(var(--border)); border-radius: .5rem; font: inherit; font-weight: 700; background: hsl(var(--foreground)); color: hsl(var(--background)); cursor: pointer; }
button:hover:not(:disabled) { background: hsl(var(--foreground) / .9); }
button:disabled { cursor: wait; opacity: .65; }
button:focus-visible { outline: 3px solid hsl(var(--primary)); outline-offset: 4px; }
#status { min-height: 3.3em; margin-bottom: 0; color: hsl(var(--muted-foreground)); font-size: .875rem; }
</style>
</head><body>
<main aria-labelledby="title">
<h1 id="title">${ownerLogin ? 'GJC 로그인' : 'Google 계정 확인'}</h1>
<p>${ownerLogin ? '등록된 소유자 Google 계정으로 로그인해 주세요. 로그인 창이 새로 열립니다.' : 'Google 계정을 확인합니다. 서비스 접근 권한은 부여되지 않습니다.'}</p>
<button id="sign-in" type="button" disabled aria-describedby="status">Google로 로그인</button>
<p id="status" role="status" aria-live="polite" aria-atomic="true">${available ? '로그인 모듈을 불러오는 중입니다.' : '로그인을 사용할 수 없습니다. 관리자에게 설정 확인을 요청해 주세요.'}</p>
<noscript><p>로그인하려면 브라우저에서 JavaScript를 허용해 주세요.</p></noscript>
</main>
${available ? `<script type="module" nonce="${nonce}">
const button = document.getElementById('sign-in');
const status = document.getElementById('status');
try {
  const { initializeApp } = await import('${SDK_ORIGIN}/firebasejs/${SDK_VERSION}/firebase-app.js');
  const { initializeAuth, inMemoryPersistence, browserPopupRedirectResolver, GoogleAuthProvider, signInWithPopup, signOut } = await import('${SDK_ORIGIN}/firebasejs/${SDK_VERSION}/firebase-auth.js');
  const config = ${serialized};
  const auth = initializeAuth(initializeApp(config), {
    persistence: inMemoryPersistence,
    popupRedirectResolver: browserPopupRedirectResolver,
  });
  button.disabled = false;
  status.textContent = '준비되었습니다. 버튼을 눌러 로그인해 주세요.';
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = '로그인 중…';
    status.textContent = 'Google 로그인 창에서 계정을 선택해 주세요.';
    let authenticated = false;
    try {
      const result = await signInWithPopup(auth, new GoogleAuthProvider());
      const headers = { 'Content-Type': 'application/json' };
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
    } catch (error) {
      status.textContent = '로그인을 완료하지 못했습니다. 등록된 계정과 네트워크를 확인한 뒤 다시 시도해 주세요.';
      if (error?.code === 'auth/popup-closed-by-user' || error?.code === 'auth/cancelled-popup-request') status.textContent = '로그인을 취소했습니다. 다시 시도할 수 있습니다.';
      if (error?.code === 'auth/popup-blocked') status.textContent = '로그인 팝업이 차단되었습니다. 이 사이트의 팝업을 허용한 뒤 다시 시도해 주세요.';
    } finally {
      try { await signOut(auth); } catch { authenticated = false; status.textContent = '로그인 정보 정리를 완료하지 못했습니다. 페이지를 새로 열어 주세요.'; }
      button.disabled = false;
      button.textContent = 'Google로 다시 로그인';
    }
    if (authenticated) window.location.replace('/');
  });
} catch {
  status.textContent = '로그인 모듈을 불러오지 못했습니다. 네트워크와 브라우저 차단 설정을 확인한 뒤 새로고침해 주세요.';
}
</script>` : ''}
</body></html>`,
  };
}
