import { pathToFileURL } from 'node:url'

const API_BASE_URL = (process.env.PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
const API_BASE_URL = (process.env.PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\\/+$/, '')
const TIMEOUT_MS = 20_000

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertNoSecretFields(value, path = '$') {
  if (typeof value === 'string') {
    if (/\bBearer\s+[A-Za-z0-9._~-]{12,}/i.test(value)) {
      throw new Error(`Sensitive bearer material found in public response at ${path}.`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, `${path}[${index}]`))
    return
  }
  if (!isRecord(value)) return
  const forbiddenKeys = new Set(['apikey', 'apisecret', 'authorization', 'privatekey', 'seedphrase', 'secretvalue', 'tokenvalue'])
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key.toLowerCase().replace(/[_-]/g, ''))) {
      throw new Error(`Sensitive field '${key}' found in public response at ${path}.`)
    }
    assertNoSecretFields(child, `${path}.${key}`)
  }
}

export function validateSponsorshipStatus(payload) {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.sponsorship)) {
    throw new Error('Sponsorship status did not return its expected public response shape.')
  }
  assertNoSecretFields(payload)
  const status = payload.sponsorship
  const policy = status.fundingPolicy
  if (!isRecord(policy)) throw new Error('Sponsorship funding policy is missing.')
  const disabled = status.enabled === false
    && status.mainnetEnabled === false
    && status.canSubmitSponsoredTransfer === false
    && policy.feeSponsorshipAvailable === false
    && policy.sponsorFundedAssetTransfersAvailable === false
    && policy.unpaidFallbackToUserFunds === false
    && policy.userFundsRequiredForSponsoredFlow === false
    && status.receiverBalance?.sponsorAssetGrantEnabled === false
  if (!disabled) {
    throw new Error('Sponsorship API does not satisfy the currently enforced fail-closed contract.')
  }
  return {
    enabled: status.enabled,
    mainnetEnabled: status.mainnetEnabled,
    canSubmitSponsoredTransfer: status.canSubmitSponsoredTransfer,
    unpaidFallbackToUserFunds: policy.unpaidFallbackToUserFunds,
    sponsorAssetGrantEnabled: status.receiverBalance.sponsorAssetGrantEnabled,
  }
}

export function validateGasFreeConfigStatus(payload) {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.networks)
    || !isRecord(payload.networks.mainnet) || !isRecord(payload.networks.nile)) {
    throw new Error('GasFree config status did not return its expected public response shape.')
  }
  assertNoSecretFields(payload)
  for (const network of ['mainnet', 'nile']) {
    if (typeof payload.networks[network].configured !== 'boolean') {
      throw new Error(`GasFree ${network} credential-presence flag is missing or not boolean.`)
    }
  }
  if (payload.providerFundingVerified !== false
    || payload.canSubmitSponsoredTransfer !== false
    || payload.submissionEnabled !== false) {
    throw new Error('GasFree credential diagnostics must not assert funding or enable submissions.')
  }
  return {
    mainnetCredentialsPresent: payload.networks.mainnet.configured,
    nileCredentialsPresent: payload.networks.nile.configured,
    providerFundingVerified: payload.providerFundingVerified,
    canSubmitSponsoredTransfer: payload.canSubmitSponsoredTransfer,
    submissionEnabled: payload.submissionEnabled,
  }
}

async function readEndpoint(path) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}.`)
  return payload
}

export async function runSponsorGateSmoke({ read = readEndpoint } = {}) {
  const [sponsorshipPayload, gasFreePayload] = await Promise.all([
    read('/api/tron/sponsorship/status'),
    read('/api/gasfree/config-status'),
  ])
  return {
    sponsorship: validateSponsorshipStatus(sponsorshipPayload),
    gasFree: validateGasFreeConfigStatus(gasFreePayload),
  }
}

async function main() {
  try {
    const result = await runSponsorGateSmoke()
    // Deliberately output only sanitized booleans; never print credentials or tokens.
    process.stdout.write(\`Public sponsorship gates verified:\n\${JSON.stringify(result, null, 2)}\n\`)
  } catch (error) {
    process.stderr.write(\`Public sponsorship-gate smoke check failed: \${error instanceof Error ? error.message : 'unknown error'}\n\`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
