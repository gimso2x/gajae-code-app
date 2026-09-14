/**
 * Builds the app's normalized provider quota snapshot from the GJC runtime's
 * own usage source.
 *
 * `/usage` is owned by the bundled runtime and reads the account inventory,
 * which projects `AuthStorage`'s `UsageReport` cache. This module consumes the
 * same structured reports rather than the command's rendered text, so the
 * sidebar indicator and `/usage` can never disagree and `/usage` itself is
 * untouched.
 *
 * Everything here is pure apart from the injected `fetchProviderUsage`, so the
 * selection, clamping, state classification and per-provider failure isolation
 * are testable without a worker, an SDK, or a network.
 */

import {
  boundProviderQuotaWindows,
  clampQuotaPercent,
  providerQuotaDisplayName,
  representativeQuotaWindow,
  type ProviderQuotaEntry,
  type ProviderQuotaReason,
  type ProviderQuotaSnapshot,
  type ProviderQuotaStatus,
  type ProviderQuotaWindow,
} from '../shared/providerQuota.js';

/** Matches the runtime's per-credential usage TTL; older observations are stale. */
export const PROVIDER_QUOTA_FRESH_MS = 5 * 60_000;

/** Structural narrowing of the runtime's `UsageLimit`; nothing secret is read. */
export type ProviderUsageLimitLike = {
  id?: unknown;
  label?: unknown;
  window?: { id?: unknown; label?: unknown; durationMs?: unknown; resetsAt?: unknown } | null;
  amount?: {
    used?: unknown;
    limit?: unknown;
    remaining?: unknown;
    usedFraction?: unknown;
    remainingFraction?: unknown;
    unit?: unknown;
  } | null;
  status?: unknown;
};

/** Structural narrowing of the runtime's `SafeUsageReport` (never carries `raw`). */
export type ProviderUsageReportLike = {
  provider?: unknown;
  fetchedAt?: unknown;
  limits?: readonly ProviderUsageLimitLike[];
  metadata?: Record<string, unknown>;
};

/** Structural narrowing of one `AccountInventoryRow`. */
export type ProviderQuotaInventoryRow = {
  provider: string;
  disabled: boolean;
  disabledCause?: string | null;
  health?: { status?: unknown; reason?: unknown } | null;
  usage?: { report: ProviderUsageReportLike; fetchedAt?: unknown; freshness?: unknown } | null;
};

export type ProviderQuotaBuildInput = {
  rows: readonly ProviderQuotaInventoryRow[];
  /**
   * Refreshes one provider's reports. Rejections are contained per provider:
   * one failing provider must never blank the rest of the row.
   */
  fetchProviderUsage: (provider: string) => Promise<readonly ProviderUsageReportLike[] | null | undefined>;
  now?: number;
};

/**
 * Plan identifiers the providers actually emit (`pro`, `plus`, `max_20x`).
 * Whitespace is refused on purpose: it is what lets an arbitrary metadata
 * string — `Bearer <token>`, an error sentence — masquerade as a plan.
 */
const PLAN_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,23}$/u;
const WINDOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Percentages are display values; binary-float noise must not cross the wire. */
const percent = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : Math.round(value * 100) / 100;

const text = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/gu, ' ').trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : undefined;
};

/** Identifiers are rejected when oversized; truncating them could merge limits. */
const identifier = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== 'string' || value.length > maxLength) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Derives the remaining share from whichever shape the provider reported.
 * Providers disagree on which fields they populate, so every equivalent
 * expression is accepted and the result is clamped once, here.
 */
function remainingPercentOf(amount: NonNullable<ProviderUsageLimitLike['amount']>): number | undefined {
  const remainingFraction = finite(amount.remainingFraction);
  if (remainingFraction !== undefined) return percent(clampQuotaPercent(remainingFraction * 100));

  const usedFraction = finite(amount.usedFraction);
  if (usedFraction !== undefined) return percent(clampQuotaPercent(100 - usedFraction * 100));

  const limit = finite(amount.limit);
  const remaining = finite(amount.remaining);
  if (remaining !== undefined && limit !== undefined && limit > 0) {
    return percent(clampQuotaPercent((remaining / limit) * 100));
  }

  const used = finite(amount.used);
  if (used !== undefined && limit !== undefined && limit > 0) {
    return percent(clampQuotaPercent(100 - (used / limit) * 100));
  }
  // A percent-unit limit reports `used` as the percentage itself.
  if (used !== undefined && amount.unit === 'percent') return percent(clampQuotaPercent(100 - used));

  return undefined;
}

/** Projects one runtime limit onto the renderer-facing window shape. */
export function normalizeQuotaWindow(limit: ProviderUsageLimitLike, index: number): ProviderQuotaWindow | null {
  const amount = limit.amount ?? {};
  const hasLimitId = limit.id !== undefined && limit.id !== null;
  const limitId = identifier(limit.id, 64);
  const windowId = identifier(limit.window?.id, 64);
  const id = limitId !== undefined && WINDOW_ID.test(limitId)
    ? limitId
    : hasLimitId
      ? `window-${index}`
      : windowId !== undefined && WINDOW_ID.test(windowId)
        ? windowId
        : `window-${index}`;
  // A provider can use one duration id for several model or feature limits;
  // the limit label is the useful detail in that case (for example an
  // Antigravity model name or Codex's Spark bucket).
  const label = text(limit.label, 64) ?? text(limit.window?.label, 64) ?? id;
  const remainingPercent = remainingPercentOf(amount);
  const used = finite(amount.used);
  const amountLimit = finite(amount.limit);
  const unit = text(amount.unit, 16);
  const resetsAt = finite(limit.window?.resetsAt);
  const resetAt = resetsAt !== undefined && resetsAt > 0 ? new Date(resetsAt).toISOString() : undefined;

  return {
    id,
    label,
    ...(remainingPercent === undefined ? {} : { remainingPercent }),
    ...(used === undefined ? {} : { used }),
    ...(amountLimit === undefined ? {} : { limit: amountLimit }),
    ...(unit === undefined || unit === 'unknown' ? {} : { unit }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

export function normalizeQuotaWindows(report: ProviderUsageReportLike): ProviderQuotaWindow[] {
  const limits = Array.isArray(report.limits) ? report.limits : [];
  const windows: ProviderQuotaWindow[] = [];
  for (const [index, limit] of limits.entries()) {
    const window = normalizeQuotaWindow(limit, index);
    if (window) windows.push(window);
  }
  return boundProviderQuotaWindows(windows);
}

function planOf(report: ProviderUsageReportLike): string | undefined {
  const planType = report.metadata?.planType ?? report.metadata?.plan;
  const label = text(planType, 40);
  return label !== undefined && PLAN_LABEL.test(label) ? label : undefined;
}

type Observation = {
  windows: ProviderQuotaWindow[];
  fetchedAt: number;
  plan?: string;
  accounts?: number;
  stale: boolean;
};

function observationOf(report: ProviderUsageReportLike, fallbackFetchedAt: number, stale: boolean): Observation {
  const plan = planOf(report);
  const accounts = typeof report.metadata?.accounts === 'number' && report.metadata.accounts > 0
    ? report.metadata.accounts
    : undefined;
  return {
    windows: normalizeQuotaWindows(report),
    fetchedAt: finite(report.fetchedAt) ?? fallbackFetchedAt,
    ...(plan === undefined ? {} : { plan }),
    ...(accounts === undefined ? {} : { accounts }),
    stale,
  };
}

/**
 * Among a provider's accounts, the indicator represents the one with the most
 * headroom: that is the account the runtime's own credential ranking would
 * reach for next, so showing the most-drained account would misstate what the
 * person can actually spend.
 */
function representativeObservation(observations: readonly Observation[]): Observation | undefined {
  let best: Observation | undefined;
  let bestPercent: number | undefined;
  for (const observation of observations) {
    const percent = clampQuotaPercent(representativeQuotaWindow(observation.windows)?.remainingPercent);
    if (best === undefined) {
      best = observation;
      bestPercent = percent;
      continue;
    }
    if (percent === undefined) continue;
    if (bestPercent === undefined || percent > bestPercent) {
      best = observation;
      bestPercent = percent;
    }
  }
  return best;
}

type ProviderGroup = {
  provider: string;
  rows: ProviderQuotaInventoryRow[];
  activeRows: ProviderQuotaInventoryRow[];
  hasAuthFailure: boolean;
  allActiveFailed: boolean;
};

function groupRows(rows: readonly ProviderQuotaInventoryRow[]): ProviderGroup[] {
  const groups = new Map<string, ProviderQuotaInventoryRow[]>();
  for (const row of rows) {
    const provider = text(row.provider, 128);
    if (!provider) continue;
    const existing = groups.get(provider);
    if (existing) existing.push(row);
    else groups.set(provider, [row]);
  }

  return [...groups.entries()]
    .map(([provider, providerRows]) => {
      const activeRows = providerRows.filter((row) => !row.disabled);
      return {
        provider,
        rows: providerRows,
        activeRows,
        hasAuthFailure: providerRows.some((row) => row.disabled && row.disabledCause === 'auth_failure'),
        allActiveFailed: activeRows.length > 0 && activeRows.every((row) => row.health?.status === 'failed'),
      };
    })
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

function cachedObservations(group: ProviderGroup, now: number): Observation[] {
  const observations: Observation[] = [];
  for (const row of group.rows) {
    const usage = row.usage;
    if (!usage?.report) continue;
    const fetchedAt = finite(usage.fetchedAt) ?? finite(usage.report.fetchedAt) ?? 0;
    observations.push(observationOf(usage.report, fetchedAt, usage.freshness !== 'fresh' || now - fetchedAt > PROVIDER_QUOTA_FRESH_MS));
  }
  return observations;
}

function entryOf(
  group: ProviderGroup,
  status: ProviderQuotaStatus,
  reason: ProviderQuotaReason | undefined,
  observation: Observation | undefined,
  now: number,
): ProviderQuotaEntry {
  const fetchedAt = observation?.fetchedAt;
  return {
    provider: group.provider,
    providerName: providerQuotaDisplayName(group.provider),
    ...(observation?.plan === undefined ? {} : { plan: observation.plan }),
    accounts: observation?.accounts ?? (group.activeRows.length > 0 ? group.activeRows.length : group.rows.length),
    windows: observation?.windows ?? [],
    status,
    ...(reason === undefined ? {} : { reason }),
    stale: observation === undefined ? false : observation.stale || now - observation.fetchedAt > PROVIDER_QUOTA_FRESH_MS,
    fetchedAt: new Date(fetchedAt !== undefined && fetchedAt > 0 ? fetchedAt : now).toISOString(),
  };
}

/**
 * Assembles one snapshot. Providers are refreshed concurrently with settled
 * semantics so a single provider's outage, timeout or re-auth requirement
 * cannot suppress the others.
 */
export async function buildProviderQuotaSnapshot(input: ProviderQuotaBuildInput): Promise<ProviderQuotaSnapshot> {
  const now = input.now ?? Date.now();
  const groups = groupRows(input.rows);
  // A provider is "connected" when it still holds a credential, or when its
  // only credentials were disabled by an auth failure — the latter is exactly
  // the case the re-auth state exists to surface.
  const connected = groups.filter((group) => group.activeRows.length > 0 || group.hasAuthFailure);

  const settled = await Promise.allSettled(
    connected.map(async (group) => {
      if (group.activeRows.length === 0) return null;
      return (await input.fetchProviderUsage(group.provider)) ?? null;
    }),
  );

  const providers = connected.map((group, index) => {
    const cached = cachedObservations(group, now);

    if (group.activeRows.length === 0) {
      return entryOf(group, 'reauth', 'reauth_required', representativeObservation(cached), now);
    }

    const result = settled[index]!;
    if (result.status === 'rejected') {
      // Keep the last-known windows for the tooltip, but never present a
      // failed refresh as a valid quota reading.
      return entryOf(group, 'error', 'fetch_failed', representativeObservation(cached), now);
    }

    const fetched = (result.value ?? []).map((report) => observationOf(report, now, false));
    const observations = fetched.length > 0 ? fetched : cached;

    if (group.allActiveFailed) {
      return entryOf(group, 'reauth', 'reauth_required', representativeObservation(observations), now);
    }
    if (observations.length === 0) {
      return entryOf(group, 'unsupported', 'usage_unsupported', undefined, now);
    }

    const observation = representativeObservation(observations);
    if (!observation || representativeQuotaWindow(observation.windows) === undefined) {
      // Connected and reporting, but not in a proportion this indicator can
      // draw. Show an empty ring rather than inventing a percentage.
      return entryOf(group, 'unsupported', 'no_usage_data', observation, now);
    }
    return entryOf(group, 'ok', undefined, observation, now);
  });

  return { providers: providers.sort(compareForDisplay), fetchedAt: new Date(now).toISOString() };
}

/**
 * Display order for the compact row.
 *
 * A person may have many connected providers while only a few expose a quota
 * at all, so the ones that actually draw an arc come first and the permanently
 * quota-less ones trail off into the row's overflow. Ordering is by state
 * rather than by remaining share on purpose: an ambient indicator that
 * reshuffles itself as quotas move is unreadable, so within a state the order
 * is stable and alphabetical.
 */
const STATUS_ORDER: Readonly<Record<ProviderQuotaStatus, number>> = {
  ok: 0,
  reauth: 1,
  error: 2,
  unsupported: 3,
};

function compareForDisplay(left: ProviderQuotaEntry, right: ProviderQuotaEntry): number {
  const byStatus = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
  return byStatus !== 0 ? byStatus : left.provider.localeCompare(right.provider);
}
export type CliProxyAuthFile = {
  name?: string;
  account?: string;
  email?: string;
  provider?: string;
  auth_index?: string;
  project_id?: string;
  disabled?: boolean;
  quota?: {
    observed_at?: string;
    signals?: Record<string, string>;
  };
};

export function parseCliProxyAuthFiles(files: readonly CliProxyAuthFile[]): {
  claudeLimits: ProviderUsageLimitLike[];
  codexLimits: ProviderUsageLimitLike[];
} {
  const claudeLimits: ProviderUsageLimitLike[] = [];
  const codexLimits: ProviderUsageLimitLike[] = [];

  for (const file of files) {
    const signals = file.quota?.signals;
    if (!signals || typeof signals !== 'object') continue;

    if (file.provider === 'claude' && claudeLimits.length === 0) {
      const util5hStr = signals['Anthropic-Ratelimit-Unified-5h-Utilization'];
      const reset5hStr = signals['Anthropic-Ratelimit-Unified-5h-Reset'];
      const util7dStr = signals['Anthropic-Ratelimit-Unified-7d-Utilization'];
      const reset7dStr = signals['Anthropic-Ratelimit-Unified-7d-Reset'];

      const util5h = util5hStr !== undefined ? parseFloat(util5hStr) : NaN;
      const reset5h = reset5hStr !== undefined ? parseInt(reset5hStr, 10) : NaN;
      const util7d = util7dStr !== undefined ? parseFloat(util7dStr) : NaN;
      const reset7d = reset7dStr !== undefined ? parseInt(reset7dStr, 10) : NaN;

      if (Number.isFinite(util5h)) {
        claudeLimits.push({
          id: 'claude:5h',
          label: 'Claude (5h)',
          window: {
            id: '5h',
            label: 'Claude (5h)',
            resetsAt: Number.isFinite(reset5h) ? reset5h * 1000 : undefined,
          },
          amount: {
            usedFraction: util5h,
            remainingFraction: Math.max(0, 1 - util5h),
          },
        });
      }
      if (Number.isFinite(util7d)) {
        claudeLimits.push({
          id: 'claude:7d',
          label: 'Claude (7d)',
          window: {
            id: '7d',
            label: 'Claude (7d)',
            resetsAt: Number.isFinite(reset7d) ? reset7d * 1000 : undefined,
          },
          amount: {
            usedFraction: util7d,
            remainingFraction: Math.max(0, 1 - util7d),
          },
        });
      }
    }

    if (file.provider === 'codex' && codexLimits.length === 0) {
      const primUsedStr = signals['X-Codex-Primary-Used-Percent'];
      const primResetStr = signals['X-Codex-Primary-Reset-At'];
      const secUsedStr = signals['X-Codex-Secondary-Used-Percent'];
      const secResetStr = signals['X-Codex-Secondary-Reset-At'];

      const primUsed = primUsedStr !== undefined ? parseFloat(primUsedStr) : NaN;
      const primReset = primResetStr !== undefined ? parseInt(primResetStr, 10) : NaN;
      const secUsed = secUsedStr !== undefined ? parseFloat(secUsedStr) : NaN;
      const secReset = secResetStr !== undefined ? parseInt(secResetStr, 10) : NaN;

      if (Number.isFinite(primUsed)) {
        codexLimits.push({
          id: 'codex:5h',
          label: 'Codex (5h)',
          window: {
            id: '5h',
            label: 'Codex (5h)',
            resetsAt: Number.isFinite(primReset) ? primReset * 1000 : undefined,
          },
          amount: {
            used: primUsed,
            unit: 'percent',
            remainingFraction: Math.max(0, (100 - primUsed) / 100),
          },
        });
      }
      if (Number.isFinite(secUsed)) {
        codexLimits.push({
          id: 'codex:weekly',
          label: 'Codex (Weekly)',
          window: {
            id: 'weekly',
            label: 'Codex (Weekly)',
            resetsAt: Number.isFinite(secReset) ? secReset * 1000 : undefined,
          },
          amount: {
            used: secUsed,
            unit: 'percent',
            remainingFraction: Math.max(0, (100 - secUsed) / 100),
          },
        });
      }
    }
  }

  return { claudeLimits, codexLimits };
}

export function parseZaiQuotaLimits(zaiPayload: unknown): ProviderUsageLimitLike[] {
  if (!zaiPayload || typeof zaiPayload !== 'object') return [];
  const payload = zaiPayload as { success?: boolean; data?: { limits?: Array<Record<string, unknown>> } };
  if (payload.success !== true || !Array.isArray(payload.data?.limits)) return [];

  const limits: ProviderUsageLimitLike[] = [];
  for (const item of payload.data.limits) {
    const type = item.type;
    const unit = item.unit;
    const num = item.number;
    const percentage = typeof item.percentage === 'number' ? item.percentage : parseFloat(String(item.percentage));
    const nextReset = typeof item.nextResetTime === 'number' ? item.nextResetTime : parseInt(String(item.nextResetTime), 10);

    if (type === 'TOKENS_LIMIT' && Number.isFinite(percentage)) {
      if (num === 5 || unit === 3) {
        limits.push({
          id: 'zai:5h',
          label: 'Z.ai (5h)',
          window: {
            id: '5h',
            label: 'Z.ai (5h)',
            resetsAt: Number.isFinite(nextReset) ? nextReset : undefined,
          },
          amount: {
            usedFraction: Math.min(1, Math.max(0, percentage / 100)),
            remainingFraction: Math.min(1, Math.max(0, (100 - percentage) / 100)),
          },
        });
      } else if (num === 1 || unit === 6) {
        limits.push({
          id: 'zai:weekly',
          label: 'Z.ai (Weekly)',
          window: {
            id: 'weekly',
            label: 'Z.ai (Weekly)',
            resetsAt: Number.isFinite(nextReset) ? nextReset : undefined,
          },
          amount: {
            usedFraction: Math.min(1, Math.max(0, percentage / 100)),
            remainingFraction: Math.min(1, Math.max(0, (100 - percentage) / 100)),
          },
        });
      }
    }
  }
  return limits;
}
export function parseAntigravityQuotaSummary(bodyStr: string): ProviderUsageLimitLike[] {
  try {
    const data = JSON.parse(bodyStr) as {
      groups?: Array<{ displayName?: string; buckets?: Array<Record<string, unknown>> }>;
    };
    const limits: ProviderUsageLimitLike[] = [];
    for (const group of data.groups ?? []) {
      for (const bucket of group.buckets ?? []) {
        const remainingFraction = typeof bucket.remainingFraction === 'number'
          ? bucket.remainingFraction
          : typeof bucket.remainingFraction === 'string'
            ? parseFloat(bucket.remainingFraction)
            : NaN;
        if (!Number.isFinite(remainingFraction)) continue;

        const window = String(bucket.window ?? '').toLowerCase();
        const resetTime = typeof bucket.resetTime === 'string' ? Date.parse(bucket.resetTime) : NaN;
        const resetsAt = Number.isFinite(resetTime) ? resetTime : undefined;

        if (window === '5h' || bucket.bucketId === 'gemini-5h') {
          limits.push({
            id: 'gemini:5h',
            label: 'Gemini (5h)',
            window: {
              id: '5h',
              label: 'Gemini (5h)',
              resetsAt,
            },
            amount: {
              remainingFraction,
              usedFraction: Math.max(0, 1 - remainingFraction),
            },
          });
        } else if (window === 'weekly' || bucket.bucketId === 'gemini-weekly') {
          limits.push({
            id: 'gemini:weekly',
            label: 'Gemini (Weekly)',
            window: {
              id: 'weekly',
              label: 'Gemini (Weekly)',
              resetsAt,
            },
            amount: {
              remainingFraction,
              usedFraction: Math.max(0, 1 - remainingFraction),
            },
          });
        }
      }
    }
    return limits;
  } catch {
    return [];
  }
}

export type Gimso2xProxyQuotaOptions = {
  proxyBaseUrl?: string;
  managementKey?: string;
  zaiApiKey?: string;
  fetchFn?: typeof fetch;
};

export async function fetchGimso2xProxyUsageReports(
  provider: string,
  options: Gimso2xProxyQuotaOptions = {},
): Promise<readonly ProviderUsageReportLike[] | undefined> {
  const proxyBaseUrl = options.proxyBaseUrl
    || process.env.GIMSO2XPROXY_BASE_URL
    || 'https://proxy.gimso2x.com';
  const managementKey = options.managementKey
    || process.env.GIMSO2XPROXY_MANAGEMENT_KEY
    || process.env.CLIPROXYAPI_MANAGEMENT_KEY
    || '';
  const zaiApiKey = options.zaiApiKey
    || process.env.GIMSO2XPROXY_ZAI_API_KEY
    || process.env.ZAI_API_KEY
    || '';
  const fetchFn = options.fetchFn || globalThis.fetch;

  if (provider !== 'gimso2xproxy') {
    return undefined;
  }

  let claudeLimits: ProviderUsageLimitLike[] = [];
  let codexLimits: ProviderUsageLimitLike[] = [];
  let antigravityLimits: ProviderUsageLimitLike[] = [];
  let zaiLimits: ProviderUsageLimitLike[] = [];
  let totalAccounts = 0;

  const promises: Promise<void>[] = [];

  if (managementKey) {
    promises.push(
      (async () => {
        try {
          const res = await fetchFn(`${proxyBaseUrl.replace(/\/+$/, '')}/v0/management/auth-files`, {
            headers: { 'X-Management-Key': managementKey },
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const data = (await res.json()) as { files?: CliProxyAuthFile[] };
            if (Array.isArray(data.files)) {
              totalAccounts = data.files.filter((f) => !f.disabled).length;
              const parsed = parseCliProxyAuthFiles(data.files);
              claudeLimits = parsed.claudeLimits;
              codexLimits = parsed.codexLimits;

              const agFile = data.files.find(
                (f) => f.provider === 'antigravity' && !f.disabled && f.auth_index,
              );
              if (agFile?.auth_index) {
                try {
                  const agRes = await fetchFn(`${proxyBaseUrl.replace(/\/+$/, '')}/v0/management/api-call`, {
                    method: 'POST',
                    headers: {
                      'X-Management-Key': managementKey,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      authIndex: agFile.auth_index,
                      method: 'POST',
                      url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
                      header: {
                        Authorization: 'Bearer $TOKEN$',
                        'Content-Type': 'application/json',
                        'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)',
                      },
                      body: JSON.stringify({ project: agFile.project_id || 'aicode-consumers' }),
                    }),
                    signal: AbortSignal.timeout(5000),
                  });
                  if (agRes.ok) {
                    const agData = (await agRes.json()) as { status_code?: number; body?: string };
                    if (agData.status_code === 200 && agData.body) {
                      antigravityLimits = parseAntigravityQuotaSummary(agData.body);
                    }
                  }
                } catch {
                  // Fall through safely
                }
              }
            }
          }
        } catch {
          // Network errors are contained
        }
      })(),
    );
  }

  if (zaiApiKey && provider === 'gimso2xproxy') {
    promises.push(
      (async () => {
        try {
          const res = await fetchFn('https://api.z.ai/api/monitor/usage/quota/limit', {
            headers: { Authorization: `Bearer ${zaiApiKey}` },
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const data = await res.json();
            zaiLimits = parseZaiQuotaLimits(data);
          }
        } catch {
          // Network errors are contained
        }
      })(),
    );
  }

  await Promise.allSettled(promises);


  const allLimits = [...claudeLimits, ...codexLimits, ...antigravityLimits, ...zaiLimits];
  if (allLimits.length === 0) return undefined;

  return [
    {
      provider: 'gimso2xproxy',
      fetchedAt: Date.now(),
      limits: allLimits,
      metadata: { plan: 'team', accounts: totalAccounts > 0 ? totalAccounts : undefined },
    },
  ];
}
