import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { notifyWikiStop, renderWikiStartContext } from '@/gjc-wiki-bridge.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gjc-wiki-bridge-'));
}

function writeScript(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return file;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
}

/**
 * Snapshots and restores the named env vars around a test body, deleting each
 * one first. The test runner sets WIKI_DISABLE=1 process-wide (see
 * scripts/run-tests.mjs / scripts/bun-dom-preload.ts) so every test in this
 * file must explicitly opt back in rather than assume an unset ambient state.
 */
async function withEnv(names: string[], overrides: Record<string, string>, body: () => Promise<void> | void): Promise<void> {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
  try {
    await body();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

const ENV_NAMES = ['WIKI_START', 'WIKI_STOP', 'WIKI_DISABLE', 'WIKI_APP_START_TIMEOUT_MS'];

test('renderWikiStartContext returns the fixture script stdout on success', async () => {
  const dir = tempDir();
  const script = writeScript(dir, 'start.sh', 'printf "wiki-context-ok"');
  try {
    await withEnv(ENV_NAMES, { WIKI_START: script }, async () => {
      const out = await renderWikiStartContext('/some/cwd');
      assert.equal(out, 'wiki-context-ok');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderWikiStartContext receives the caller cwd via WIKI_CWD', async () => {
  const dir = tempDir();
  const script = writeScript(dir, 'start.sh', 'printf "%s" "$WIKI_CWD"');
  try {
    await withEnv(ENV_NAMES, { WIKI_START: script }, async () => {
      const out = await renderWikiStartContext('/marker/cwd/value');
      assert.equal(out, '/marker/cwd/value');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderWikiStartContext falls back to empty string when disabled', async () => {
  const dir = tempDir();
  const script = writeScript(dir, 'start.sh', 'printf "should-not-appear"');
  try {
    await withEnv(ENV_NAMES, { WIKI_START: script, WIKI_DISABLE: '1' }, async () => {
      const out = await renderWikiStartContext('/cwd');
      assert.equal(out, '');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderWikiStartContext falls back to empty string when the script is missing', async () => {
  await withEnv(ENV_NAMES, { WIKI_START: '/nonexistent/path/to/wiki-start.sh' }, async () => {
    const out = await renderWikiStartContext('/cwd');
    assert.equal(out, '');
  });
});

test('renderWikiStartContext falls back to empty string on non-zero exit', async () => {
  const dir = tempDir();
  const script = writeScript(dir, 'start.sh', 'printf "partial-output"; exit 1');
  try {
    await withEnv(ENV_NAMES, { WIKI_START: script }, async () => {
      const out = await renderWikiStartContext('/cwd');
      assert.equal(out, '');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderWikiStartContext falls back to empty string on timeout without hanging the caller', async () => {
  const dir = tempDir();
  const script = writeScript(dir, 'start.sh', 'sleep 5; printf "too-late"');
  try {
    await withEnv(ENV_NAMES, { WIKI_START: script, WIKI_APP_START_TIMEOUT_MS: '100' }, async () => {
      const started = Date.now();
      const out = await renderWikiStartContext('/cwd');
      assert.equal(out, '');
      assert.ok(Date.now() - started < 2000, 'must not wait for the full sleep');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('notifyWikiStop delivers the exact session/cwd/transcript payload without blocking the caller', async () => {
  const dir = tempDir();
  const receiptFile = path.join(dir, 'receipt.json');
  const script = writeScript(dir, 'stop.sh', `cat > "${receiptFile}"`);
  try {
    await withEnv(ENV_NAMES, { WIKI_STOP: script }, async () => {
      const before = Date.now();
      notifyWikiStop({ sessionId: 'sess-123', cwd: '/proj/dir', transcriptPath: '/proj/dir/.gjc/sessions/x.jsonl' });
      assert.ok(Date.now() - before < 100, 'notifyWikiStop must return immediately');
      await waitFor(() => fs.existsSync(receiptFile));
      const parsed = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      assert.deepEqual(parsed, {
        session_id: 'sess-123',
        cwd: '/proj/dir',
        transcript_path: '/proj/dir/.gjc/sessions/x.jsonl',
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('notifyWikiStop is a no-op when disabled', async () => {
  const dir = tempDir();
  const receiptFile = path.join(dir, 'receipt.json');
  const script = writeScript(dir, 'stop.sh', `cat > "${receiptFile}"`);
  try {
    await withEnv(ENV_NAMES, { WIKI_STOP: script, WIKI_DISABLE: '1' }, async () => {
      notifyWikiStop({ sessionId: 'sess-x', cwd: '/cwd', transcriptPath: '' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(fs.existsSync(receiptFile), false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('notifyWikiStop tolerates a missing script without throwing', async () => {
  await withEnv(ENV_NAMES, { WIKI_STOP: '/nonexistent/path/to/wiki-stop.sh' }, () => {
    assert.doesNotThrow(() => {
      notifyWikiStop({ sessionId: 'sess', cwd: '/cwd', transcriptPath: '' });
    });
  });
});
