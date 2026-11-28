const REQUIRED_RESOURCE_PATHS = [
  'energy.available',
  'energy.limit',
  'energy.used',
  'bandwidth.freeAvailable',
  'bandwidth.stakedOrDelegatedAvailable',
  'bandwidth.maxSingleTransactionAvailable',
  'balanceSun',
  'rpc.providersUsed',
]

function readPath(value, path) {
  return path.split('.').reduce((current, key) => current == null ? undefined : current[key], value)
}

function isNonNegativeInteger(value) {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
}

/**
 * Validate the live owner resource API response without hiding which field failed.
 * This is telemetry validation only; it is never a deployment authorization.
 */
export function validateMainnetResourceSnapshot(body, expectedOwner, now = Date.now(), maxAgeMs = 45_000) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { state: 'warning', detail: 'Resource response is not a JSON object.' }
  }
  if (body.network !== 'TRON Mainnet') {
    return { state: 'warning', detail: 'Resource response network mismatch: expected TRON Mainnet.' }
  }
  if (body.address !== expectedOwner) {
    return { state: 'warning', detail: 'Resource response owner mismatch: expected the configured owner address.' }
  }
  for (const path of REQUIRED_RESOURCE_PATHS) {
    const value = readPath(body, path)
    if (path === 'rpc.providersUsed') {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !Object.keys(value).length
        || Object.values(value).some(provider => typeof provider !== 'string' || !provider.trim())) {
        return { state: 'warning', detail: 'Resource response schema mismatch at rpc.providersUsed.' }
      }
    } else if (!isNonNegativeInteger(value)) {
      return { state: 'warning', detail: 'Resource response schema mismatch at ' + path + '.' }
    }
  }
  const checkedAt = Date.parse(body.checkedAt)
  if (!Number.isFinite(checkedAt)) {
    return { state: 'warning', detail: 'Resource response schema mismatch at checkedAt (missing or invalid timestamp).' }
  }
  const ageMs = now - checkedAt
  if (ageMs < -5_000) {
    return { state: 'warning', detail: 'Resource snapshot timestamp is unexpectedly in the future.' }
  }
  if (ageMs > maxAgeMs) {
    return { state: 'warning', detail: 'Resource snapshot is stale (' + Math.round(ageMs / 1000) + 's old); refresh before using it for readiness checks.' }
  }
  return {
    state: 'online',
    detail: 'Live Mainnet resource snapshot validated · ' + Object.keys(body.rpc.providersUsed).length + ' provider route(s) reported · ' + Math.max(0, Math.round(ageMs / 1000)) + 's old.',
  }
}
