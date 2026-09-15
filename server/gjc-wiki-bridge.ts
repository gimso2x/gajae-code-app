import { spawn as spawnChild } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Bridges the app's in-process GJC SDK runs to the shell-only wiki lifecycle
 * scripts (`~/my-wiki/wiki-system/bin/{wiki-start,wiki-stop}.sh`) that the
 * `gjc()` shell wrapper (gjc-config/integrations/wiki/gjc-wiki-wrapper.sh)
 * normally invokes around a CLI invocation. The app never runs that wrapper —
 * it creates SDK sessions directly (see gjc-bun-sdk-adapter.ts #runInner) — so
 * without this bridge, app chat sessions get neither the wiki-start context
 * injection nor the wiki-stop session-note recording that terminal `gjc`
 * usage gets for free.
 *
 * Granularity note: the shell wrapper injects/records once per `gjc`
 * invocation, not once per logical session lifetime — a wrapper invocation
 * that resumes an existing session still re-runs wiki-start and re-triggers
 * wiki-stop at shell exit. The app's closest equivalent to "one gjc
 * invocation" is one #run()/#runInner() call (one worker `run` RPC, whether
 * it creates or resumes a SessionManager), so this bridge fires once per
 * #run(), not once per SessionManager lifetime. Delegated subagent runs
 * (GjcDelegationExecutor) construct their own SDK sessions outside
 * #run()/#runInner() entirely and never reach this module.
 */

const DEFAULT_WIKI_ROOT = path.join(os.homedir(), 'my-wiki', 'wiki-system', 'bin');

/** External safety bound. wiki-start.sh already time-bounds its own remote/local work; this is defense in depth against a hung subprocess, not the primary timeout. Overridable for hermetic tests. */
function startTimeoutMs(): number {
  const raw = Number(process.env.WIKI_APP_START_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
}

export type WikiStopPayload = {
  sessionId: string;
  cwd: string;
  /** Absolute path to the session's transcript JSONL file, or '' if unavailable. */
  transcriptPath: string;
};

function isDisabled(): boolean {
  return process.env.WIKI_DISABLE === '1';
}

function startScriptPath(): string {
  return process.env.WIKI_START || path.join(DEFAULT_WIKI_ROOT, 'wiki-start.sh');
}

function stopScriptPath(): string {
  return process.env.WIKI_STOP || path.join(DEFAULT_WIKI_ROOT, 'wiki-stop.sh');
}

/**
 * Renders the wiki orienteering context exactly as the shell wrapper's
 * `_gjc_wiki_start` does, for injection into an SDK session's systemPrompt.
 *
 * Never throws and never blocks indefinitely: disabled, missing, failing, and
 * timed-out scripts all resolve to `''`, which the caller must treat as "no
 * wiki context available" — never as a reason to fail or delay the chat turn.
 */
export async function renderWikiStartContext(cwd: string): Promise<string> {
  if (isDisabled()) return '';
  const script = startScriptPath();
  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawnChild('bash', [script], {
        env: { ...process.env, WIKI_CWD: cwd },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish('');
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish('');
    }, startTimeoutMs());
    timer.unref();
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? out : '');
    });
  });
}

/**
 * Fires the wiki-stop session-note recording for a completed top-level run,
 * mirroring `_gjc_wiki_stop_bg`'s payload contract exactly (stdin JSON with
 * `session_id`/`cwd`/`transcript_path`; `learned_state_path` is a shell-wrapper-
 * only concept and is intentionally omitted here).
 *
 * Detached and unref'd: never awaited by the caller, never delays run cleanup,
 * never keeps the worker process alive, and any failure is swallowed. Disabled
 * or missing script silently no-ops.
 */
export function notifyWikiStop(payload: WikiStopPayload): void {
  if (isDisabled()) return;
  const script = stopScriptPath();
  let child;
  try {
    child = spawnChild('bash', [script], {
      env: process.env,
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch {
    return;
  }
  child.on('error', () => { /* best-effort; nothing to recover */ });
  // A quickly-exiting child (e.g. a missing script) can close its stdin pipe
  // before or during this write, which surfaces as an async EPIPE on the
  // stream itself rather than as a synchronous throw or a child 'error'
  // event. Unhandled, that crashes the host process; this is best-effort
  // delivery, so swallow it the same way a failed spawn is swallowed above.
  child.stdin?.on('error', () => { /* best-effort; nothing to recover */ });
  try {
    child.stdin?.end(JSON.stringify({
      session_id: payload.sessionId,
      cwd: payload.cwd,
      transcript_path: payload.transcriptPath,
    }));
  } catch { /* best-effort */ }
  child.unref();
}
