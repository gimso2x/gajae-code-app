import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type VerifyClientCallbackAsync } from 'ws';

import { createOwnerAdmissionPolicy } from '@/middleware/owner-http-auth.js';
import { handleDesktopNotificationsConnection } from '@/modules/notifications/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type UpgradeVerifier = Parameters<typeof verifyWebSocketClient>[1];
type GatewayDependencies = {
  verifyClient: UpgradeVerifier;
  chat: Parameters<typeof handleChatConnection>[2]; shell: Parameters<typeof handleShellConnection>[1];
  browser?: (ws: Parameters<typeof handleChatConnection>[0], request: AuthenticatedWebSocketRequest) => void;
};

function startHeartbeat(socket: Parameters<typeof handleChatConnection>[0]): void {
  const heartbeat = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    // Closing a socket can race with the periodic probe.
    try { socket.ping(); } catch { /* raced with close */ }
  }, 30_000);

  const stopHeartbeat = () => clearInterval(heartbeat);
  socket.on('close', stopHeartbeat);
  socket.on('error', stopHeartbeat);
}

export function watchOwnerSession(socket: Parameters<typeof handleChatConnection>[0], request: AuthenticatedWebSocketRequest,
  policy: ReturnType<typeof createOwnerAdmissionPolicy>): void {
  if (!policy.configured) return;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const stop = () => { stopped = true; clearTimeout(timer); };
  socket.once('close', stop);
  socket.once('error', stop);
  const check = async () => {
    try {
      const identity = await policy.authenticate(request);
      if (stopped) return;
      const delay = Math.max(1, Math.min(15_000, identity.expiresAt - Date.now()));
      timer = setTimeout(() => { void check(); }, delay);
      timer.unref();
    } catch {
      if (!stopped) socket.close(1008, 'Owner authorization failed');
      stop();
    }
  };
  void check();
}

function connectionPath(request: AuthenticatedWebSocketRequest): string {
  return new URL(request.url ?? '/', 'http://localhost').pathname;
}

export function createWebSocketServer(server: HttpServer, dependencies: GatewayDependencies): WebSocketServer {
  const ownerPolicy = dependencies.verifyClient.ownerPolicy ?? createOwnerAdmissionPolicy();
  const verification = {
    verifyClient: ((info, done) => {
      try {
        void Promise.resolve(verifyWebSocketClient(info, { ...dependencies.verifyClient, ownerPolicy }))
          .then((accepted) => done(accepted, accepted ? undefined : 401), () => done(false, 401));
      } catch { done(false, 401); }
    }) as VerifyClientCallbackAsync<AuthenticatedWebSocketRequest>,
  };
  const gateway = new WebSocketServer({ ...verification, server });

  gateway.on('connection', (socket, rawRequest) => {
    startHeartbeat(socket);
    const request = rawRequest as AuthenticatedWebSocketRequest;
    watchOwnerSession(socket, request, ownerPolicy);
    const pathname = connectionPath(request);
    const routeHandlers: Record<string, () => boolean> = {
      '/shell': () => {
        handleShellConnection(socket, dependencies.shell);
        return true;
      },
      '/ws': () => {
        handleChatConnection(socket, request, dependencies.chat);
        return true;
      },
      '/desktop-notifications': () => {
        handleDesktopNotificationsConnection(socket, request);
        return true;
      },
      '/ws/browser': () => {
        if (!dependencies.browser) return false;
        dependencies.browser(socket, request);
        return true;
      },
    };
    if (routeHandlers[pathname]?.()) return;

    console.log('[WARN] Unknown WebSocket path:', pathname);
    socket.close();
  });
  return gateway;
}
