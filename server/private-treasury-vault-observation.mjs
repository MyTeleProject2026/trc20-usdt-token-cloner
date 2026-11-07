import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { isValidTronAddress } from './tron-address.mjs'

const SCHEMA = 'tron-transfer.private-treasury-vault-observation.v1'
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const UINT_RE = /^(?:0|[1-9][0-9]{0,77})$/
const ID_RE = /^[A-Za-z0-9._:-]{8,128}$/
const KEY_ID_RE = /^[A-Za-z0-9._-]{3,128}$/
const SHA256_RE = /^[a-f0-9]{64}$/i
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/
const MAX_OBSERVATION_AGE_MS = 60_000
const MAX_RECEIPT_LIFETIME_MS = 60_000
const MAX_CLOCK_SKEW_MS = 5_000
const MIN_PLATFORM_USDT_BASE_UNITS = 1_000_000_000n
const READ_ONLY_OBSERVATION_READERS = new WeakSet()
const VERIFIED_OBSERVATIONS = new WeakSet()

function fail(reason) {
  return Object.freeze({
    valid: false,
    status: 'vault-observation-rejected',
    reason,
    payoutAuthorized: false,
    signingRequestCreated: false,
    signatureProduced: false,
    transactionSigned: false,
    broadcastAttempted: false,
    mainnetExecutionEnabled: false,
  })
}

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).every((key) => allowed.includes(key))
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('non-safe-json-number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('non-json-object')
  }
  return '{' + Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) throw new Error('undefined-json-value')
    return JSON.stringify(key) + ':' + canonicalJson(value[key])
  }).join(',') + '}'
}

export function canonicalizePrivateTreasuryVaultObservationPayload(payload) {
  return canonicalJson(payload)
}

function uint(value) {
  return typeof value === 'string' && UINT_RE.test(value) ? BigInt(value) : null
}

function available(balance, reserved) {
  return balance !== null && reserved !== null && reserved <= balance ? balance - reserved : null
}

function includesId(values, id) {
  return Array.isArray(values) && values.includes(id)
}

function verifyEd25519(payload, signature, trustedKeys, revokedKeyIds, nowMs, issuedAtMs) {
  if (!exactKeys(signature, ['algorithm', 'keyId', 'value'])
    || signature.algorithm !== 'Ed25519'
    || typeof signature.keyId !== 'string' || !KEY_ID_RE.test(signature.keyId)
    || typeof signature.value !== 'string' || !BASE64URL_RE.test(signature.value)) {
    return { valid: false, reason: 'signature-envelope-invalid' }
  }
  const key = trustedKeys instanceof Map ? trustedKeys.get(signature.keyId) : trustedKeys?.[signature.keyId]
  if (!key || !exactKeys(key, ['status', 'issuer', 'audiences', 'publicKeyPem', 'notBeforeMs', 'notAfterMs'])
    || key.status !== 'active' || typeof key.issuer !== 'string'
    || !Array.isArray(key.audiences) || typeof key.publicKeyPem !== 'string'
    || !Number.isSafeInteger(key.notBeforeMs) || !Number.isSafeInteger(key.notAfterMs)
    || key.notAfterMs <= key.notBeforeMs) {
    return { valid: false, reason: 'signing-key-not-trusted-or-invalid' }
  }
  if (includesId(revokedKeyIds, signature.keyId)) return { valid: false, reason: 'signing-key-revoked' }
  if (issuedAtMs < key.notBeforeMs || nowMs >= key.notAfterMs) {
    return { valid: false, reason: 'signing-key-outside-validity-window' }
  }
  let decoded
  let publicKey
  let bytes
  try {
    decoded = Buffer.from(signature.value, 'base64url')
    if (decoded.length !== 64 || decoded.toString('base64url') !== signature.value) {
      return { valid: false, reason: 'signature-encoding-invalid' }
    }
    publicKey = createPublicKey(key.publicKeyPem)
    if (publicKey.asymmetricKeyType !== 'ed25519') return { valid: false, reason: 'signing-key-algorithm-invalid' }
    bytes = Buffer.from(canonicalJson(payload), 'utf8')
  } catch {
    return { valid: false, reason: 'signature-material-invalid' }
  }
  try {
    if (!verifySignature(null, bytes, publicKey, decoded)) return { valid: false, reason: 'signature-verification-failed' }
  } catch {
    return { valid: false, reason: 'signature-verification-failed' }
  }
  return { valid: true, keyId: signature.keyId, key }
}

/**
 * Verify a provider-neutral, Ed25519-signed financial vault observation.
 *
 * This is a pure verifier: it does not fetch, mutate a ledger, reserve funds,
 * authorize a withdrawal, create a transaction, contact a signer, sign, or
 * broadcast. Callers must supply a current pinned trust/revocation snapshot and
 * a read of previously consumed receipt/observation IDs. A future state-changing
 * consumer would additionally need an atomic durable claim before using an ID.
 */
export function verifyPrivateTreasuryVaultObservation(receipt, {
  expectedIssuer,
  expectedAudience = 'tron-transfer-private-treasury',
  expectedVaultId,
  expectedTreasuryAddress,
  minimumUsdtBaseUnits = '1000000000',
  trustedKeys,
  revokedKeyIds,
  trustRegistryCheckedAtMs,
  seenReceiptIds,
  seenObservationIds,
  nowMs = Date.now(),
  maxObservationAgeMs = MAX_OBSERVATION_AGE_MS,
  maxReceiptLifetimeMs = MAX_RECEIPT_LIFETIME_MS,
  maxTrustRegistryAgeMs = 60_000,
} = {}) {
  if (!exactKeys(receipt, ['payload', 'signature']) || !exactKeys(receipt.payload, [
    'schema', 'issuer', 'audience', 'receiptId', 'observationId', 'vaultId', 'network',
    'treasuryAddress', 'issuedAtMs', 'observedAtMs', 'expiresAtMs', 'chain',
    'assets', 'resources', 'reservation',
  ])) return fail('receipt-envelope-or-payload-invalid')

  const p = receipt.payload
  if (p.schema !== SCHEMA) return fail('receipt-schema-unsupported')
  if (typeof expectedIssuer !== 'string' || !expectedIssuer.trim()
    || p.issuer !== expectedIssuer || p.audience !== expectedAudience) return fail('receipt-issuer-or-audience-mismatch')
  if (typeof expectedVaultId !== 'string' || !expectedVaultId.trim() || p.vaultId !== expectedVaultId) return fail('vault-id-mismatch')
  if (!isValidTronAddress(expectedTreasuryAddress) || p.treasuryAddress !== expectedTreasuryAddress) {
    return fail('treasury-address-mismatch-or-invalid')
  }
  if (p.network !== 'TRON_MAINNET') return fail('network-not-tron-mainnet')
  if (typeof p.receiptId !== 'string' || !ID_RE.test(p.receiptId)
    || typeof p.observationId !== 'string' || !ID_RE.test(p.observationId)) return fail('receipt-or-observation-id-invalid')

  if (!Number.isSafeInteger(nowMs) || nowMs <= 0
    || !Number.isSafeInteger(trustRegistryCheckedAtMs)
    || trustRegistryCheckedAtMs > nowMs + MAX_CLOCK_SKEW_MS
    || nowMs - trustRegistryCheckedAtMs > maxTrustRegistryAgeMs
    || !Number.isSafeInteger(maxTrustRegistryAgeMs) || maxTrustRegistryAgeMs < 1
    || !Array.isArray(revokedKeyIds) || !Array.isArray(seenReceiptIds) || !Array.isArray(seenObservationIds)) {
    return fail('fresh-trust-and-replay-state-required')
  }
  if (!Number.isSafeInteger(maxObservationAgeMs) || maxObservationAgeMs < 1
    || maxObservationAgeMs > MAX_OBSERVATION_AGE_MS
    || !Number.isSafeInteger(maxReceiptLifetimeMs) || maxReceiptLifetimeMs < 1
    || maxReceiptLifetimeMs > MAX_RECEIPT_LIFETIME_MS) return fail('verification-window-invalid')

  if (!Number.isSafeInteger(p.issuedAtMs) || !Number.isSafeInteger(p.observedAtMs)
    || !Number.isSafeInteger(p.expiresAtMs)
    || p.issuedAtMs > nowMs + MAX_CLOCK_SKEW_MS
    || p.observedAtMs > p.issuedAtMs + MAX_CLOCK_SKEW_MS
    || nowMs - p.observedAtMs > maxObservationAgeMs
    || p.expiresAtMs <= nowMs
    || p.expiresAtMs <= p.issuedAtMs
    || p.expiresAtMs - p.issuedAtMs > maxReceiptLifetimeMs) return fail('receipt-time-window-invalid')

  if (seenReceiptIds.includes(p.receiptId) || seenObservationIds.includes(p.observationId)) {
    return fail('receipt-or-observation-replayed')
  }

  const signature = verifyEd25519(p, receipt.signature, trustedKeys, revokedKeyIds, nowMs, p.issuedAtMs)
  if (!signature.valid) return fail(signature.reason)
  if (signature.key.issuer !== p.issuer || !signature.key.audiences.includes(p.audience)) {
    return fail('signing-key-issuer-or-audience-not-authorized')
  }

  if (!exactKeys(p.chain, ['blockNumber', 'blockId', 'finality'])
    || !Number.isSafeInteger(p.chain.blockNumber) || p.chain.blockNumber < 1
    || typeof p.chain.blockId !== 'string' || !SHA256_RE.test(p.chain.blockId)
    || p.chain.finality !== 'solidified') return fail('solidified-chain-anchor-invalid')

  if (!exactKeys(p.assets, ['usdt', 'trx'])
    || !exactKeys(p.assets.usdt, ['contract', 'decimals', 'balanceBaseUnits', 'reservedBaseUnits', 'availableBaseUnits'])
    || !exactKeys(p.assets.trx, ['balanceSun', 'reservedSun', 'availableSun'])) return fail('asset-observation-shape-invalid')
  const usdt = p.assets.usdt
  const trx = p.assets.trx
  if (usdt.contract !== USDT_CONTRACT || usdt.decimals !== 6) return fail('official-usdt-identity-invalid')
  const usdtBalance = uint(usdt.balanceBaseUnits)
  const usdtReserved = uint(usdt.reservedBaseUnits)
  const usdtAvailable = uint(usdt.availableBaseUnits)
  const expectedUsdtAvailable = available(usdtBalance, usdtReserved)
  if (expectedUsdtAvailable === null || usdtAvailable === null || usdtAvailable !== expectedUsdtAvailable) {
    return fail('usdt-balance-reservation-arithmetic-invalid')
  }
  const trxBalance = uint(trx.balanceSun)
  const trxReserved = uint(trx.reservedSun)
  const trxAvailable = uint(trx.availableSun)
  const expectedTrxAvailable = available(trxBalance, trxReserved)
  if (expectedTrxAvailable === null || trxAvailable === null || trxAvailable !== expectedTrxAvailable) {
    return fail('trx-balance-reservation-arithmetic-invalid')
  }

  const minimumUsdt = uint(minimumUsdtBaseUnits)
  if (minimumUsdt === null || minimumUsdt < MIN_PLATFORM_USDT_BASE_UNITS
    || usdtAvailable < minimumUsdt) return fail('available-usdt-below-1000-platform-minimum')

  if (!exactKeys(p.resources, [
    'freeBandwidthLimit', 'freeBandwidthUsed', 'stakedBandwidthLimit',
    'stakedBandwidthUsed', 'energyLimit', 'energyUsed',
  ])) return fail('network-resource-observation-shape-invalid')
  const freeLimit = uint(p.resources.freeBandwidthLimit)
  const freeUsed = uint(p.resources.freeBandwidthUsed)
  const stakedLimit = uint(p.resources.stakedBandwidthLimit)
  const stakedUsed = uint(p.resources.stakedBandwidthUsed)
  const energyLimit = uint(p.resources.energyLimit)
  const energyUsed = uint(p.resources.energyUsed)
  if ([freeLimit, freeUsed, stakedLimit, stakedUsed, energyLimit, energyUsed].some((value) => value === null)) {
    return fail('network-resource-observation-invalid')
  }
  const freeAvailable = freeLimit > freeUsed ? freeLimit - freeUsed : 0n
  const stakedAvailable = stakedLimit > stakedUsed ? stakedLimit - stakedUsed : 0n
  const energyAvailable = energyLimit > energyUsed ? energyLimit - energyUsed : 0n

  if (!exactKeys(p.reservation, ['sequence', 'snapshotId'])
    || !Number.isSafeInteger(p.reservation.sequence) || p.reservation.sequence < 0
    || typeof p.reservation.snapshotId !== 'string' || !ID_RE.test(p.reservation.snapshotId)) {
    return fail('reservation-snapshot-binding-invalid')
  }

  const verified = Object.freeze({
    valid: true,
    status: 'cryptographically-attested-read-only-vault-observation',
    schema: SCHEMA,
    issuer: p.issuer,
    audience: p.audience,
    vaultId: p.vaultId,
    treasuryAddress: p.treasuryAddress,
    receiptId: p.receiptId,
    observationId: p.observationId,
    payloadDigest: createHash('sha256').update(canonicalJson(p), 'utf8').digest('hex'),
    trustRegistryCheckedAtMs,
    signingKeyId: signature.keyId,
    chain: Object.freeze({ ...p.chain }),
    assets: Object.freeze({
      usdt: Object.freeze({
        contract: usdt.contract,
        decimals: 6,
        balanceBaseUnits: usdtBalance.toString(),
        reservedBaseUnits: usdtReserved.toString(),
        availableBaseUnits: usdtAvailable.toString(),
      }),
      trx: Object.freeze({
        balanceSun: trxBalance.toString(),
        reservedSun: trxReserved.toString(),
        availableSun: trxAvailable.toString(),
      }),
    }),
    resources: Object.freeze({
      freeBandwidthAvailable: freeAvailable.toString(),
      stakedBandwidthAvailable: stakedAvailable.toString(),
      totalBandwidthAvailable: (freeAvailable + stakedAvailable).toString(),
      energyAvailable: energyAvailable.toString(),
    }),
    reservation: Object.freeze({ ...p.reservation }),
    issuedAtMs: p.issuedAtMs,
    observedAtMs: p.observedAtMs,
    expiresAtMs: p.expiresAtMs,
    limitations: Object.freeze({
      sourceObservationCryptographicallyAttested: true,
      chainBlockIndependentlyQueriedByThisVerifier: false,
      vaultOwnershipVerified: false,
      signerAuthorityVerified: false,
      creditFacilityVerified: false,
      payoutAuthorized: false,
      ledgerMutationPerformed: false,
      reservationCreated: false,
      providerContactedByVerifier: false,
      signingRequestCreated: false,
      signatureProduced: false,
      transactionSigned: false,
      broadcastAttempted: false,
      mainnetExecutionEnabled: false,
    }),
  })
  VERIFIED_OBSERVATIONS.add(verified)
  return verified
}

export function isVerifiedPrivateTreasuryVaultObservation(value) {
  return Boolean(value && typeof value === 'object' && VERIFIED_OBSERVATIONS.has(value))
}

/**
 * Provider-neutral read-only HTTP client. It performs exactly one HTTPS GET
 * against an explicitly allowlisted origin and rejects redirects. It does not
 * interpret the response as trusted; callers must pass the returned receipt
 * through verifyPrivateTreasuryVaultObservation.
 */
export async function fetchPrivateTreasuryVaultObservation({
  gatewayBaseUrl,
  allowedOrigins,
  vaultId,
  bearerToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  if (typeof gatewayBaseUrl !== 'string' || typeof vaultId !== 'string'
    || !ID_RE.test(vaultId) || typeof bearerToken !== 'string'
    || bearerToken.length < 16 || bearerToken.length > 4096
    || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1000 || timeoutMs > 15_000 || !Array.isArray(allowedOrigins)) {
    throw new TypeError('private-vault-observation-client-configuration-invalid')
  }
  let base
  try { base = new URL(gatewayBaseUrl) } catch { throw new TypeError('private-vault-gateway-url-invalid') }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || base.pathname !== '/' || !allowedOrigins.includes(base.origin)) {
    throw new TypeError('private-vault-gateway-origin-not-allowlisted')
  }
  const url = new URL('/v1/vaults/' + encodeURIComponent(vaultId) + '/observations/latest', base.origin)
  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + bearerToken,
    },
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response || response.ok !== true) throw new Error('private-vault-observation-read-failed')
  const contentLength = response.headers?.get?.('content-length')
  if (contentLength && (!/^(?:0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > 65_536)) {
    throw new Error('private-vault-observation-response-too-large')
  }
  let body
  try { body = await response.text() } catch { throw new Error('private-vault-observation-response-invalid') }
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 65_536) {
    throw new Error('private-vault-observation-response-too-large')
  }
  let receipt
  try { receipt = JSON.parse(body) } catch { throw new Error('private-vault-observation-response-invalid') }
  if (!exactKeys(receipt, ['payload', 'signature'])
    || !Object.hasOwn(receipt, 'payload') || !Object.hasOwn(receipt, 'signature')) {
    throw new Error('private-vault-observation-envelope-invalid')
  }
  return Object.freeze({ receipt, fetchedAtMs: Date.now(), readOnly: true })
}


/**
 * Create a worker-compatible observation reader backed only by the bounded,
 * allowlisted HTTPS GET client above. The WeakSet brand prevents arbitrary
 * callbacks from being passed as read-only readers by accident.
 */
export function createPrivateTreasuryVaultReadOnlyObservationReader({
  gatewayBaseUrl,
  allowedOrigins,
  bearerToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  if (!Array.isArray(allowedOrigins)) throw new TypeError('private-vault-read-only-reader-allowlist-required')
  const config = Object.freeze({
    gatewayBaseUrl,
    allowedOrigins: Object.freeze([...allowedOrigins]),
    bearerToken,
    fetchImpl,
    timeoutMs,
  })
  const reader = async (vault) => {
    if (!vault || typeof vault.vaultId !== 'string') {
      throw new TypeError('private-vault-read-only-reader-vault-required')
    }
    return fetchPrivateTreasuryVaultObservation({ ...config, vaultId: vault.vaultId })
  }
  READ_ONLY_OBSERVATION_READERS.add(reader)
  return Object.freeze(reader)
}

export function isPrivateTreasuryVaultReadOnlyObservationReader(reader) {
  return typeof reader === 'function' && READ_ONLY_OBSERVATION_READERS.has(reader)
}

export const PRIVATE_TREASURY_VAULT_OBSERVATION_SCHEMA = SCHEMA
export const PRIVATE_TREASURY_VAULT_OFFICIAL_USDT_CONTRACT = USDT_CONTRACT
export const PRIVATE_TREASURY_VAULT_MINIMUM_USDT_BASE_UNITS = MIN_PLATFORM_USDT_BASE_UNITS.toString()
