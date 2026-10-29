import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_API_BASE_URL = 'https://trc20-usdt-token-cloner-api.onrender.com'

const ENDPOINTS = Object.freeze({
  health: '/health',
  readiness: '/api/readiness',
  sponsorshipStatus: '/api/tron/sponsorship/status',
  integrationReadiness: '/api/tron/sponsorship/integration-readiness',
  testnetPilot: '/api/tron/sponsorship/testnet-pilot-readiness?network=both&refresh=1',
})

const SAFE_BACKEND_FLAGS = [
  'tatumApiKeyConfigured',
  'databaseUrlConfigured',
  'frontendOriginConfigured',
  'sponsorAdminTokenConfigured',
  'testnetSignedBroadcastExplicitlyEnabled',
  'agreementReferenceVariablePresent',
]

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeText(value, fallback = null) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 160) : fallback
}

function safeBoolean(value) {
  return typeof value === 'boolean' ? value : null
}

function safeStringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string').slice(0, 100).map((item) => item.slice(0, 160))
}

export function normalizeApiBaseUrl(value = DEFAULT_API_BASE_URL) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search || url.hash) {
    throw new TypeError('API base URL must be an HTTPS origin without credentials, path, query, or fragment')
  }
  return url.origin
}

function summarizeNetworkReadiness(value) {
  return {
    feeSponsorAddressConfigured: safeBoolean(value?.addressMonitoring?.feeSponsorAddressConfigured),
    assetPrincipalSponsorAddressConfigured: safeBoolean(value?.addressMonitoring?.assetPrincipalSponsorAddressConfigured),
    roleAddressesDistinct: safeBoolean(value?.addressMonitoring?.roleAddressesDistinct),
    usdtContractAllowlisted: safeBoolean(value?.tokenContractAllowlist?.usdt),
    vtrcContractAllowlisted: safeBoolean(value?.tokenContractAllowlist?.vtrc),
    gasFreeCredentialsConfigured: safeBoolean(value?.gasFree?.credentialsConfigured),
    gasFreeDiscoveryReachabilityVerified: safeBoolean(value?.gasFree?.discoveryReachabilityVerified),
    gasFreeSubmissionAdapterIntegrated: safeBoolean(value?.gasFree?.submitSignBroadcastAdapterIntegrated),
  }
}

function summarizePilotNetwork(value) {
  return {
    preflightStatus: safeText(value?.preflightStatus),
    node: {
      reachable: safeBoolean(value?.networkNode?.reachable),
      status: safeText(value?.networkNode?.status),
    },
    roles: {
      feeSponsorAddressConfigured: safeBoolean(value?.roleConfiguration?.feeSponsorAddressConfigured),
      assetPrincipalSponsorAddressConfigured: safeBoolean(value?.roleConfiguration?.assetPrincipalSponsorAddressConfigured),
      distinct: safeBoolean(value?.roleConfiguration?.rolesDistinct),
      feeSponsorBalanceRead: safeBoolean(value?.roleConfiguration?.feeSponsorOnChainBalanceRead),
      assetPrincipalBalanceRead: safeBoolean(value?.roleConfiguration?.assetPrincipalSponsorOnChainBalanceRead),
    },
    feeSponsorResources: {
      read: safeBoolean(value?.feeSponsorResources?.read),
      status: safeText(value?.feeSponsorResources?.status),
      activeDelegationObserved: safeBoolean(value?.feeSponsorResources?.delegation?.activeDelegationObserved),
    },
    blockers: safeStringList(value?.blockers),
  }
}

function summarizePayload(name, body) {
  if (!isRecord(body)) return { validJsonObject: false }

  if (name === 'health') {
    return { status: safeText(body.status), service: safeText(body.service) }
  }

  if (name === 'readiness') {
    return {
      success: safeBoolean(body.success),
      status: safeText(body.status),
      database: {
        configured: safeBoolean(body.database?.configured),
        ready: safeBoolean(body.database?.ready),
        status: safeText(body.database?.status),
      },
      providers: {
        tatum: {
          configured: safeBoolean(body.providers?.tatum?.configured),
          reachable: safeBoolean(body.providers?.tatum?.reachable),
          status: safeText(body.providers?.tatum?.status),
        },
        frontendOriginConfigured: safeBoolean(body.providers?.frontendOrigin?.configured),
      },
    }
  }

  if (name === 'sponsorshipStatus') {
    return {
      status: safeText(body.status),
      enabled: safeBoolean(body.enabled),
      mainnetEnabled: safeBoolean(body.mainnetEnabled),
      canSubmitSponsoredTransfer: safeBoolean(body.canSubmitSponsoredTransfer),
      displayOnlySponsorCredit: safeBoolean(body.receiverBalance?.displayOnlySponsorCredit),
      externalSponsorConfirmed: safeBoolean(body.fundingPolicy?.externalSponsorConfirmed),
      sponsorFundingVerified: safeBoolean(body.fundingPolicy?.sponsorFundingVerified),
      unpaidFallbackToUserFunds: safeBoolean(body.fundingPolicy?.unpaidFallbackToUserFunds),
    }
  }

  if (name === 'integrationReadiness') {
    const backendConfiguration = isRecord(body.backendConfiguration)
      ? Object.fromEntries(SAFE_BACKEND_FLAGS.map((key) => [key, safeBoolean(body.backendConfiguration[key])]))
      : null
    const networks = isRecord(body.networks)
      ? Object.fromEntries(['mainnet', 'nile', 'shasta'].map((network) => [
          network, summarizeNetworkReadiness(body.networks[network]),
        ]))
      : null
    return {
      success: safeBoolean(body.success),
      status: safeText(body.status),
      backendConfiguration,
      networks,
      submission: {
        enabled: safeBoolean(body.submission?.enabled),
        canSubmitSponsoredTransfer: safeBoolean(body.submission?.canSubmitSponsoredTransfer),
        userFundedFallbackAllowed: safeBoolean(body.submission?.userFundedFallbackAllowed),
        blockerCount: Number.isSafeInteger(body.submission?.blockerCount) ? body.submission.blockerCount : null,
        blockers: safeStringList(body.submission?.blockers),
      },
    }
  }

  if (name === 'testnetPilot') {
    const networks = isRecord(body.networks)
      ? Object.fromEntries(['nile', 'shasta'].map((network) => [
          network, summarizePilotNetwork(body.networks[network]),
        ]))
      : null
    return {
      success: safeBoolean(body.success),
      status: safeText(body.status),
      networks,
      submission: {
        enabled: safeBoolean(body.submission?.enabled),
        canSubmitSponsoredTransfer: safeBoolean(body.submission?.canSubmitSponsoredTransfer),
        userFundedFallbackAllowed: safeBoolean(body.submission?.userFundedFallbackAllowed),
      },
    }
  }

  return { validJsonObject: false }
}

async function requestEndpoint({ baseUrl, name, route, fetchImpl, timeoutMs }) {
  try {
    const response = await fetchImpl(new URL(route, baseUrl), {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    let body
    let jsonParsed = true
    try {
      body = await response.json()
    } catch {
      jsonParsed = false
    }
    return {
      httpStatus: Number.isInteger(response.status) ? response.status : null,
      httpOk: response.ok === true,
      jsonParsed,
      summary: jsonParsed ? summarizePayload(name, body) : { validJsonObject: false },
      _body: jsonParsed && isRecord(body) ? body : null,
    }
  } catch (error) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return {
      httpStatus: null,
      httpOk: false,
      jsonParsed: false,
      errorCategory: isTimeout ? 'timeout' : 'network-or-transport-error',
      summary: { validJsonObject: false },
      _body: null,
    }
  }
}

export async function collectTestnetPreflight({
  baseUrl = process.env.TESTNET_PREFLIGHT_API_BASE_URL || DEFAULT_API_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  now = () => new Date(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Fetch implementation is required')
  const normalizedBaseUrl = normalizeApiBaseUrl(baseUrl)

  const responses = await Promise.all(Object.entries(ENDPOINTS).map(async ([name, route]) => [
    name,
    await requestEndpoint({ baseUrl: normalizedBaseUrl, name, route, fetchImpl, timeoutMs }),
  ]))
  const endpoints = Object.fromEntries(responses.map(([name, result]) => {
    const { _body, ...safeResult } = result
    return [name, safeResult]
  }))
  const raw = Object.fromEntries(responses.map(([name, result]) => [name, result._body]))

  const contractViolations = []
  const endpointIssues = []
  const addViolation = (code) => contractViolations.push(code)
  const addEndpointIssue = (code) => endpointIssues.push(code)

  for (const [name, value] of Object.entries(endpoints)) {
    if (!value.httpOk) addEndpointIssue(`${name}:http-${value.httpStatus ?? 'unavailable'}`)
    if (!value.jsonParsed || value.summary?.validJsonObject === false) {
      addEndpointIssue(`${name}:invalid-json-response`)
    }
  }

  if (raw.health?.status !== 'ok') addViolation('health-contract-not-ok')
  if (raw.readiness && typeof raw.readiness.success !== 'boolean') addViolation('readiness-success-flag-missing')

  const sponsorStatus = raw.sponsorshipStatus
  if (sponsorStatus) {
    if (sponsorStatus.enabled !== false) addViolation('sponsorship-enabled-flag-must-be-false')
    if (sponsorStatus.mainnetEnabled !== false) addViolation('mainnet-enabled-flag-must-be-false')
    if (sponsorStatus.canSubmitSponsoredTransfer !== false) addViolation('sponsored-submit-flag-must-be-false')
    if (sponsorStatus.receiverBalance?.displayOnlySponsorCredit !== false) {
      addViolation('display-only-sponsor-credit-must-be-disabled')
    }
    if (sponsorStatus.fundingPolicy?.unpaidFallbackToUserFunds !== false) {
      addViolation('user-funded-fallback-must-be-disabled')
    }
  }

  const integration = raw.integrationReadiness
  if (integration?.submission) {
    if (integration.submission.enabled !== false) addViolation('integration-submit-flag-must-be-false')
    if (integration.submission.canSubmitSponsoredTransfer !== false) addViolation('integration-sponsored-submit-must-be-false')
    if (integration.submission.userFundedFallbackAllowed !== false) addViolation('integration-user-funded-fallback-must-be-false')
  } else {
    addViolation('integration-submission-contract-missing')
  }

  const pilot = raw.testnetPilot
  if (pilot?.submission) {
    if (pilot.submission.enabled !== false) addViolation('testnet-pilot-submit-flag-must-be-false')
    if (pilot.submission.canSubmitSponsoredTransfer !== false) addViolation('testnet-pilot-sponsored-submit-must-be-false')
    if (pilot.submission.userFundedFallbackAllowed !== false) addViolation('testnet-pilot-user-funded-fallback-must-be-false')
  } else {
    addViolation('testnet-pilot-submission-contract-missing')
  }
  for (const network of ['nile', 'shasta']) {
    const item = pilot?.networks?.[network]
    if (!item) {
      addViolation(`testnet-pilot-${network}-diagnostic-missing`)
      continue
    }
    if (item.canSubmitSponsoredTransfer !== false
      || item.submissionEnabled !== false
      || item.userFundedFallbackAllowed !== false) {
      addViolation(`testnet-pilot-${network}-network-submit-contract-not-fail-closed`)
    }
  }

  const blockers = []
  const pushBlocker = (source, code) => {
    if (typeof code === 'string' && code.length > 0) blockers.push({ source, code: code.slice(0, 160) })
  }
  if (raw.readiness?.success !== true) {
    pushBlocker('readiness', `dependencies-${safeText(raw.readiness?.status, 'unavailable')}`)
  }
  if (raw.sponsorshipStatus?.enabled !== true) pushBlocker('sponsorship', 'external-sponsored-transfer-not-activated')
  for (const code of integration?.submission?.blockers ?? []) pushBlocker('integration-readiness', code)
  for (const network of ['nile', 'shasta']) {
    for (const code of pilot?.networks?.[network]?.blockers ?? []) {
      pushBlocker(network, code)
    }
  }
  for (const code of endpointIssues) pushBlocker('diagnostic-runner', code)
  for (const code of contractViolations) pushBlocker('safety-contract', code)

  const uniqueBlockers = [...new Map(blockers.map((item) => [`${item.source}:${item.code}`, item])).values()]
  const reportedSubmissionEnabled = sponsorStatus?.enabled === true
    || sponsorStatus?.canSubmitSponsoredTransfer === true
    || integration?.submission?.enabled === true
    || integration?.submission?.canSubmitSponsoredTransfer === true
    || pilot?.submission?.enabled === true
    || pilot?.submission?.canSubmitSponsoredTransfer === true
    || ['nile', 'shasta'].some((network) => pilot?.networks?.[network]?.canSubmitSponsoredTransfer === true
      || pilot?.networks?.[network]?.submissionEnabled === true)
  const diagnosticsComplete = endpointIssues.length === 0 && contractViolations.length === 0
  const readinessHealthy = raw.readiness?.success === true
  return {
    generatedAt: now().toISOString(),
    apiOrigin: new URL(normalizedBaseUrl).origin,
    mode: 'read-only; GET requests only; no signing or broadcast',
    diagnosticsStatus: diagnosticsComplete ? 'complete' : 'incomplete',
    readinessHealthy,
    sponsoredTransferStatus: uniqueBlockers.length === 0
      ? 'preflight-clear-awaiting-live-e2e-evidence'
      : 'blocked-by-prerequisites',
    step4Complete: false,
    liveTransferEvidenceRecorded: false,
    safetyInvariants: {
      mainnetSubmissionEnabled: sponsorStatus?.mainnetEnabled === true,
      sponsoredSubmissionEnabled: reportedSubmissionEnabled,
      userFundedFallbackAllowed: sponsorStatus?.fundingPolicy?.unpaidFallbackToUserFunds === true
        || integration?.submission?.userFundedFallbackAllowed === true
        || pilot?.submission?.userFundedFallbackAllowed === true,
      displayOnlySponsorCreditEnabled: sponsorStatus?.receiverBalance?.displayOnlySponsorCredit === true,
      contractViolations,
    },
    endpoints,
    blockerCount: uniqueBlockers.length,
    blockers: uniqueBlockers,
    disclaimer: 'This report records read-only diagnostic responses only. It is not evidence that a transaction was signed, broadcast, solidified, received, or credited by an exchange.',
  }
}

async function main() {
  const outputPath = path.resolve(process.env.TESTNET_PREFLIGHT_OUTPUT || 'testnet-preflight-report.json')
  const report = await collectTestnetPreflight()
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({
    outputFile: path.basename(outputPath),
    diagnosticsStatus: report.diagnosticsStatus,
    readinessHealthy: report.readinessHealthy,
    sponsoredTransferStatus: report.sponsoredTransferStatus,
    step4Complete: report.step4Complete,
    liveTransferEvidenceRecorded: report.liveTransferEvidenceRecorded,
    blockerCount: report.blockerCount,
    contractViolations: report.safetyInvariants.contractViolations,
  }, null, 2))
  if (report.diagnosticsStatus !== 'complete') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Keep unexpected errors sanitized; never print raw URLs, responses or secrets.
    console.error('Testnet preflight failed before a report could be completed.')
    process.exitCode = 1
  })
}
