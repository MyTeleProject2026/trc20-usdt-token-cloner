import { createHash } from 'node:crypto'

export const INSTITUTIONAL_SIGNER_SIMULATION_SCHEMA = 'tron-transfer.institutional-signer-simulation.v1'
export const OFFICIAL_TRON_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const MAX_UINT256 = (1n << 256n) - 1n

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  return '{' + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
}

function requiredReference(value) {
  return typeof value === 'string' && value.trim().length >= 8 && value.trim().length <= 256
}

export function parseInstitutionalUsdtBaseUnits(value) {
  if (typeof value !== 'string' || value.length > 86
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  if (whole.length > 78) return null
  try {
    const units = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
    return units > 0n && units <= MAX_UINT256 ? units.toString() : null
  } catch {
    return null
  }
}

/**
 * Offline institutional-signer adapter contract.
 *
 * This adapter deliberately has no provider client, key loader, signing method,
 * transaction-submission method, or network dependency. It validates and hashes
 * an intent for test/review purposes only. Evidence references are opaque labels;
 * their presence is not proof of approval, funding, custody, or signer authority.
 */
export function createInstitutionalSignerSimulationAdapter({ now = () => Date.now() } = {}) {
  if (typeof now !== 'function') throw new TypeError('A clock function is required.')

  function evaluateTransferIntent(input = {}) {
    const currentTime = now()
    const intent = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    const amountBaseUnits = parseInstitutionalUsdtBaseUnits(intent.amountUsdt)
    const expiryValid = Number.isSafeInteger(intent.expiresAt)
      && Number.isSafeInteger(currentTime)
      && intent.expiresAt > currentTime
      && intent.expiresAt <= currentTime + 120_000
    const identityValid = typeof intent.organizationId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(intent.organizationId)
      && requiredReference(intent.vaultAccountReference)
      && typeof intent.requestId === 'string'
      && IDENTIFIER_PATTERN.test(intent.requestId)
    const assetValid = intent.network === 'TRON_MAINNET'
      && intent.assetSymbol === 'USDT'
      && intent.assetContract === OFFICIAL_TRON_USDT_CONTRACT
      && intent.assetDecimals === 6
    const addressesValid = ADDRESS_PATTERN.test(intent.sponsorAddress || '')
      && ADDRESS_PATTERN.test(intent.recipientAddress || '')
      && intent.sponsorAddress !== intent.recipientAddress
    const evidenceReferencesPresent = requiredReference(intent.mandateEvidenceReference)
      && requiredReference(intent.fundingEvidenceReference)
      && requiredReference(intent.custodyPolicyReference)
      && Array.isArray(intent.reviewerDecisionReferences)
      && intent.reviewerDecisionReferences.length >= 2
      && intent.reviewerDecisionReferences.every(requiredReference)
      && new Set(intent.reviewerDecisionReferences).size === intent.reviewerDecisionReferences.length

    const valid = Boolean(amountBaseUnits && expiryValid && identityValid
      && assetValid && addressesValid && evidenceReferencesPresent)

    const normalized = valid ? {
      schema: INSTITUTIONAL_SIGNER_SIMULATION_SCHEMA,
      requestId: intent.requestId,
      organizationId: intent.organizationId,
      vaultAccountReference: intent.vaultAccountReference.trim(),
      network: intent.network,
      asset: {
        symbol: intent.assetSymbol,
        contract: intent.assetContract,
        decimals: intent.assetDecimals,
      },
      sponsorAddress: intent.sponsorAddress,
      recipientAddress: intent.recipientAddress,
      amountBaseUnits,
      expiresAt: intent.expiresAt,
      evidenceReferences: {
        mandate: intent.mandateEvidenceReference.trim(),
        funding: intent.fundingEvidenceReference.trim(),
        custodyPolicy: intent.custodyPolicyReference.trim(),
        reviewerDecisions: intent.reviewerDecisionReferences.map((value) => value.trim()).sort(),
      },
    } : null

    return Object.freeze({
      schema: INSTITUTIONAL_SIGNER_SIMULATION_SCHEMA,
      status: valid ? 'simulation-only' : 'blocked-invalid-or-incomplete-intent',
      reason: valid ? 'live-institutional-signer-adapter-not-enabled' : 'intent-validation-failed',
      requestDigest: normalized
        ? createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex')
        : null,
      normalizedIntent: normalized,
      evidenceReferencesPresent,
      evidenceReferencesIndependentlyVerified: false,
      institutionalApprovalVerified: false,
      fundingVerified: false,
      custodyPolicyVerified: false,
      signerProviderContacted: false,
      signingRequestCreated: false,
      signatureProduced: false,
      transactionSigned: false,
      broadcastAttempted: false,
      payoutAuthorized: false,
      mainnetExecutionEnabled: false,
    })
  }

  return Object.freeze({
    mode: 'test-only',
    capabilities: Object.freeze({
      validatesIntent: true,
      createsRequestDigest: true,
      contactsSignerProvider: false,
      createsSigningRequest: false,
      signsTransactions: false,
      broadcastsTransactions: false,
      authorizesPayouts: false,
      enablesMainnetExecution: false,
    }),
    evaluateTransferIntent,
  })
}

export default createInstitutionalSignerSimulationAdapter
