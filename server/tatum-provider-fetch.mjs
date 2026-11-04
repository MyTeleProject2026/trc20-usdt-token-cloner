// Shared, bounded pacing for Tatum REST and TRON gateway requests.
// Tatum's documented Free-plan limit is 3 requests per second; 400 ms between
// request launches reduces bursts from concurrent balance/resource checks.
const APPROVED_ORIGINS = new Set([
  'https://api.tatum.io',
  'https://tron-mainnet.gateway.tatum.io',
  'https://tron-shasta.gateway.tatum.io',
  'https://tron-nile.gateway.tatum.io',
  'https://tron-testnet.gateway.tatum.io',
]);
const DEFAULT_MIN_INTERVAL_MS = 400;

function resolveOrigin(input) {
  const value = typeof input === 'string' || input instanceof URL
    ? String(input)
    : (input && typeof input.url === 'string' ? input.url : '');
  if (!value) return '';
  try { return new URL(value).origin; } catch { return ''; }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function createTatumProviderFetch({
  fetchImpl = globalThis.fetch,
  minimumIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  now = Date.now,
  sleep = delay,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) {
    throw new TypeError('minimumIntervalMs must be a non-negative finite number');
  }
  let nextStartAt = 0;
  let schedule = Promise.resolve();
  return function tatumProviderFetch(input, init) {
    if (!APPROVED_ORIGINS.has(resolveOrigin(input))) return fetchImpl(input, init);
    // Pace starts, not response completion; provider requests can still overlap.
    const slot = schedule.then(async () => {
      const waitMs = Math.max(0, nextStartAt - now());
      if (waitMs > 0) await sleep(waitMs);
      nextStartAt = now() + minimumIntervalMs;
    });
    schedule = slot.catch(() => {});
    return slot.then(() => fetchImpl(input, init));
  };
}

export const tatumProviderFetch = createTatumProviderFetch();
