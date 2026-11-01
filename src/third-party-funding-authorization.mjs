import { Trx } from 'tronweb'
import { isValidTronAddress } from '../server/tron-address.mjs'

const LEGACY_THIRD_PARTY_FUNDING_AUTHORIZATION_FORMAT = 'tron-token-studio/third-party-funding-authorization/v1'
export const THIRD_PARTY_FUNDING_AUTHORIZATION_FORMAT = 'tron-token-studio/third-party-funding-authorization/v2'
export const OFFICIAL_TRON_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$/
const BASE_UNITS_PATTERN = /^[1-9][0-9]{0,77}$/
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_AUTHORIZATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_FUTURE_ISSUED_AT_MS = 5 * 60 * 1000

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validIsoTimestamp(value) {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function validateFields(manifest, { expectedVaultAddress, nowMs = Date.now() } = {}) {
  if (!isRecord(manifest)) return { valid: false, reason: 'manifest-must-be-json-object' }

  const isLegacyV1 = manifest.format === LEGACY_THIRD_PARTY_FUNDING_AUTHORIZATION_FORMAT
  const isV2 = manifest.format === THIRD_PARTY_FUNDING_AUTHORIZATION_FORMAT
  const allowed = new Set([
    'format', 'authorizationId', 'network', 'sponsorAddress', 'vaultAddress',
    'usdtContract', 'maxUsdtBaseUnits', 'maxTrxSun', 'agreementReference',
    ...(isV2 ? ['agreementDocumentSha256'] : []),
    'issuedAt', 'expiresAt', 'signature',
  ])
  if (Object.keys(manifest).some((key) => !allowed.has(key))) {
    return { valid: false, reason: 'manifest-contains-unsupported-fields' }
  }
  if (!isLegacyV1 && !isV2) {
    return { valid: false, reason: 'unsupported-authorization-format' }
  }
  if (isV2 && (typeof manifest.agreementDocumentSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(manifest.agreementDocumentSha256))) {
    return { valid: false, reason: 'agreement-document-sha256-required' }
  }
  if (manifest.network !== 'mainnet') return { valid: false, reason: 'authorization-network-must-be-mainnet' }
  if (typeof manifest.authorizationId !== 'string' || !IDENTIFIER_PATTERN.test(manifest.authorizationId)) {
    return { valid: false, reason: 'authorization-id-invalid' }
  }
  if (typeof manifest.agreementReference !== 'string' || !IDENTIFIER_PATTERN.test(manifest.agreementReference)) {
    return { valid: false, reason: 'agreement-reference-required' }
  }
  if (!ADDRESS_PATTERN.test(String(manifest.sponsorAddress || ''))
    || !isValidTronAddress(manifest.sponsorAddress)) {
    return { valid: false, reason: 'sponsor-address-invalid' }
  }
  if (!ADDRESS_PATTERN.test(String(manifest.vaultAddress || ''))
    || !isValidTronAddress(manifest.vaultAddress)) {
    return { valid: false, reason: 'fireblocks-vault-address-invalid' }
  }
  if (manifest.sponsorAddress === manifest.vaultAddress) {
    return { valid: false, reason: 'sponsor-and-vault-address-must-be-distinct' }
  }
  if (!ADDRESS_PATTERN.test(String(expectedVaultAddress || ''))
    || !isValidTronAddress(expectedVaultAddress)
    || manifest.vaultAddress !== expectedVaultAddress) {
    return { valid: false, reason: 'manifest-vault-does-not-match-configured-treasury' }
  }
  if (manifest.usdtContract !== OFFICIAL_TRON_MAINNET_USDT) {
    return { valid: false, reason: 'official-mainnet-usdt-contract-mismatch' }
  }
  if (typeof manifest.maxUsdtBaseUnits !== 'string' || !BASE_UNITS_PATTERN.test(manifest.maxUsdtBaseUnits)
    || BigInt(manifest.maxUsdtBaseUnits) > MAX_UINT256) {
    return { valid: false, reason: 'maximum-usdt-base-units-invalid' }
  }
  if (typeof manifest.maxTrxSun !== 'string' || !BASE_UNITS_PATTERN.test(manifest.maxTrxSun)
    || BigInt(manifest.maxTrxSun) > MAX_UINT256) {
    return { valid: false, reason: 'maximum-trx-sun-invalid' }
  }
  if (!validIsoTimestamp(manifest.issuedAt) || !validIsoTimestamp(manifest.expiresAt)) {
    return { valid: false, reason: 'authorization-timestamps-must-be-canonical-iso8601' }
  }

  const issuedAt = Date.parse(manifest.issuedAt)
  const expiresAt = Date.parse(manifest.expiresAt)
  if (issuedAt > nowMs + MAX_FUTURE_ISSUED_AT_MS) {
    return { valid: false, reason: 'authorization-issued-at-is-in-the-future' }
  }
  if (expiresAt <= nowMs || expiresAt <= issuedAt) {
    return { valid: false, reason: 'authorization-expired-or-expiry-invalid' }
  }
  if (expiresAt - issuedAt > MAX_AUTHORIZATION_TTL_MS) {
    return { valid: false, reason: 'authorization-validity-exceeds-seven-days' }
  }

  return { valid: true }
}

/**
 * Canonical text for the third-party source wallet to sign with TronLink.
 * It authorizes one manually initiated incoming deposit only. It is not a
 * withdrawal instruction, a transfer signature, or a delegation of key control.
 */
export function buildThirdPartyFundingAuthorizationMessage(manifest) {
  const validation = validateFields(manifest, {
    expectedVaultAddress: manifest?.vaultAddress,
    nowMs: Date.now(),
  })
  if (!validation.valid) throw new TypeError(validation.reason)
  const fields = [
    manifest.authorizationId,
    manifest.sponsorAddress,
    manifest.vaultAddress,
    manifest.usdtContract,
    manifest.maxUsdtBaseUnits,
    manifest.maxTrxSun,
    manifest.agreementReference,
    ...(manifest.format === THIRD_PARTY_FUNDING_AUTHORIZATION_FORMAT ? [manifest.agreementDocumentSha256] : []),
    manifest.issuedAt,
    manifest.expiresAt,
  ]
  if (fields.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new TypeError('All authorization message fields are required')
  }

  return [
    'TRON Token Studio third-party treasury funding consent',
    manifest.format === THIRD_PARTY_FUNDING_AUTHORIZATION_FORMAT ? 'Version: 2' : 'Version: 1',
    'Purpose: authorize one manually initiated incoming deposit to the named Fireblocks vault only.',
    'Network: TRON Mainnet',
    `Authorization ID: ${manifest.authorizationId}`,
    `Source wallet: ${manifest.sponsorAddress}`,
    `Destination Fireblocks vault: ${manifest.vaultAddress}`,
    `Official TRON USDT contract: ${manifest.usdtContract}`,
    `Maximum USDT principal in base units (6 decimals): ${manifest.maxUsdtBaseUnits}`,
    `Maximum native TRX in SUN (6 decimals): ${manifest.maxTrxSun}`,
    `Separate written agreement reference: ${manifest.agreementReference}`,
    ...(manifest.format === THIRD_PARTY_FUNDING_AUTHORIZATION_FORMAT
      ? [`SHA-256 of exact executed agreement file: ${manifest.agreementDocumentSha256}`]
      : []),
    `Issued at: ${manifest.issuedAt}`,
    `Expires at: ${manifest.expiresAt}`,
    'This consent is limited to the incoming deposit stated above and its caps.',
    'It does not authorize Tron Token Studio to access this wallet, hold its private key, or initiate a transaction from it.',
    'It does not by itself authorize subsequent withdrawals from the Fireblocks vault; those require the separate written agreement and Fireblocks controls.',
  ].join('\n')
}

export async function verifyThirdPartyFundingAuthorization(manifest, {
  expectedVaultAddress,
  now = () => Date.now(),
  verifyMessage = (message, signature) => Trx.verifyMessageV2(message, signature),
} = {}) {
  const fields = validateFields(manifest, { expectedVaultAddress, nowMs: now() })
  if (!fields.valid) return { verified: false, reason: fields.reason }
  if (typeof manifest.signature !== 'string' || !SIGNATURE_PATTERN.test(manifest.signature)) {
    return { verified: false, reason: 'authorization-signature-invalid-format' }
  }

  let recoveredAddress
  try {
    recoveredAddress = await verifyMessage(buildThirdPartyFundingAuthorizationMessage(manifest), manifest.signature)
  } catch {
    return { verified: false, reason: 'authorization-signature-verification-failed' }
  }
  if (recoveredAddress !== manifest.sponsorAddress) {
    return { verified: false, reason: 'authorization-signer-does-not-match-source-wallet' }
  }

  return {
    verified: true,
    authorization: {
      format: THIRD_PARTY_FUNDING_AUTHORIZATION_FORMAT,
      authorizationId: manifest.authorizationId,
      network: 'mainnet',
      sponsorAddress: manifest.sponsorAddress,
      vaultAddress: manifest.vaultAddress,
      usdtContract: OFFICIAL_TRON_MAINNET_USDT,
      maxUsdtBaseUnits: manifest.maxUsdtBaseUnits,
      maxTrxSun: manifest.maxTrxSun,
      agreementReference: manifest.agreementReference,
      agreementDocumentSha256: manifest.format === THIRD_PARTY_FUNDING_AUTHORIZATION_FORMAT
        ? manifest.agreementDocumentSha256 : null,
      issuedAt: manifest.issuedAt,
      expiresAt: manifest.expiresAt,
      scope: 'one-manually-initiated-incoming-deposit',
      subsequentPayoutsAuthorized: false,
    },
  }
}
