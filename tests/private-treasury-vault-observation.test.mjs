import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  canonicalizePrivateTreasuryVaultObservationPayload,
  fetchPrivateTreasuryVaultObservation,
  verifyPrivateTreasuryVaultObservation,
  isVerifiedPrivateTreasuryVaultObservation,
  PRIVATE_TREASURY_VAULT_MINIMUM_USDT_BASE_UNITS,
} from '../server/private-treasury-vault-observation.mjs'

const now = 1_800_000_000_000
const issuer = 'private-vault-gateway'
const audience = 'tron-transfer-private-treasury'
const vaultId = 'vault-private-001'
const address = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const trustedKeys = {
  'vault-ed25519-01': {
    status: 'active',
    issuer,
    audiences: [audience],
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    notBeforeMs: now - 86_400_000,
    notAfterMs: now + 86_400_000,
  },
}
const common = {
  expectedIssuer: issuer,
  expectedAudience: audience,
  expectedVaultId: vaultId,
  expectedTreasuryAddress: address,
  minimumUsdtBaseUnits: '1000000000',
  trustedKeys,
  revokedKeyIds: [],
  trustRegistryCheckedAtMs: now,
  seenReceiptIds: [],
  seenObservationIds: [],
  nowMs: now,
}
function payload(patch = {}) {
  return {
    schema: 'tron-transfer.private-treasury-vault-observation.v1',
    issuer,
    audience,
    receiptId: 'receipt-observation-0001',
    observationId: 'observation-snapshot-0001',
    vaultId,
    network: 'TRON_MAINNET',
    treasuryAddress: address,
    issuedAtMs: now - 1000,
    observedAtMs: now - 2000,
    expiresAtMs: now + 20_000,
    chain: { blockNumber: 99_123_456, blockId: 'a'.repeat(64), finality: 'solidified' },
    assets: {
      usdt: {
        contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        decimals: 6,
        balanceBaseUnits: '2000000000',
        reservedBaseUnits: '500000000',
        availableBaseUnits: '1500000000',
      },
      trx: { balanceSun: '9000000', reservedSun: '1000000', availableSun: '8000000' },
    },
    resources: {
      freeBandwidthLimit: '1500',
      freeBandwidthUsed: '200',
      stakedBandwidthLimit: '1200',
      stakedBandwidthUsed: '300',
      energyLimit: '5000',
      energyUsed: '1000',
    },
    reservation: { sequence: 42, snapshotId: 'reservation-snapshot-0001' },
    ...patch,
  }
}
function signed(p = payload()) {
  const signature = sign(null, Buffer.from(canonicalizePrivateTreasuryVaultObservationPayload(p)), privateKey).toString('base64url')
  return { payload: p, signature: { algorithm: 'Ed25519', keyId: 'vault-ed25519-01', value: signature } }
}
function verify(receipt = signed(), options = {}) {
  return verifyPrivateTreasuryVaultObservation(receipt, { ...common, ...options })
}

test('verifies a fresh, signed Mainnet vault observation without granting payout authority', () => {
  const result = verify()
  assert.equal(result.valid, true)
  assert.equal(result.status, 'cryptographically-attested-read-only-vault-observation')
  assert.equal(result.assets.usdt.availableBaseUnits, '1500000000')
  assert.equal(result.assets.trx.availableSun, '8000000')
  assert.equal(result.resources.totalBandwidthAvailable, '2200')
  assert.equal(result.resources.energyAvailable, '4000')
  assert.equal(result.reservation.sequence, 42)
  assert.equal(isVerifiedPrivateTreasuryVaultObservation(result), true)
  assert.match(result.payloadDigest, /^[a-f0-9]{64}$/)
  assert.equal(result.trustRegistryCheckedAtMs, now)
  assert.equal(result.limitations.payoutAuthorized, false)
  assert.equal(result.limitations.ledgerMutationPerformed, false)
  assert.equal(result.limitations.signingRequestCreated, false)
  assert.equal(result.limitations.broadcastAttempted, false)
})

test('preserves the 1,000 USDT minimum and rejects an observation below it', () => {
  assert.equal(PRIVATE_TREASURY_VAULT_MINIMUM_USDT_BASE_UNITS, '1000000000')
  const low = payload({ assets: {
    ...payload().assets,
    usdt: { ...payload().assets.usdt, balanceBaseUnits: '1200000000', reservedBaseUnits: '300000000', availableBaseUnits: '900000000' },
  } })
  assert.equal(verify(signed(low)).reason, 'available-usdt-below-1000-platform-minimum')
  assert.equal(verify(signed(), { minimumUsdtBaseUnits: '999999999' }).reason, 'available-usdt-below-1000-platform-minimum')
})

test('rejects altered payloads, unknown keys, revoked keys and key issuer/audience mismatch', () => {
  const altered = signed()
  altered.payload.assets.usdt.availableBaseUnits = '1900000000'
  assert.equal(verify(altered).reason, 'signature-verification-failed')
  assert.equal(verify(signed(), { trustedKeys: {} }).reason, 'signing-key-not-trusted-or-invalid')
  assert.equal(verify(signed(), { revokedKeyIds: ['vault-ed25519-01'] }).reason, 'signing-key-revoked')
  const wrongIssuerKey = { ...trustedKeys, 'vault-ed25519-01': { ...trustedKeys['vault-ed25519-01'], issuer: 'other-issuer' } }
  assert.equal(verify(signed(), { trustedKeys: wrongIssuerKey }).reason, 'signing-key-issuer-or-audience-not-authorized')
})

test('binds receipt to expected issuer, audience, vault, Mainnet and exact treasury address', () => {
  assert.equal(verify(signed(payload({ issuer: 'other' }))).reason, 'receipt-issuer-or-audience-mismatch')
  assert.equal(verify(signed(payload({ audience: 'other' }))).reason, 'receipt-issuer-or-audience-mismatch')
  assert.equal(verify(signed(), { expectedVaultId: 'different-vault' }).reason, 'vault-id-mismatch')
  assert.equal(verify(signed(payload({ network: 'NILE_TESTNET' }))).reason, 'network-not-tron-mainnet')
  assert.equal(verify(signed(), { expectedTreasuryAddress: 'not-an-address' }).reason, 'treasury-address-mismatch-or-invalid')
})

test('rejects stale, expired, overlong, or replayed observations and missing replay/trust state', () => {
  assert.equal(verify(signed(payload({ observedAtMs: now - 60_001 }))).reason, 'receipt-time-window-invalid')
  assert.equal(verify(signed(payload({ expiresAtMs: now }))).reason, 'receipt-time-window-invalid')
  assert.equal(verify(signed(payload({ expiresAtMs: now + 60_001 }))).reason, 'receipt-time-window-invalid')
  assert.equal(verify(signed(), { seenReceiptIds: ['receipt-observation-0001'] }).reason, 'receipt-or-observation-replayed')
  assert.equal(verify(signed(), { seenObservationIds: ['observation-snapshot-0001'] }).reason, 'receipt-or-observation-replayed')
  assert.equal(verify(signed(), { seenReceiptIds: undefined }).reason, 'fresh-trust-and-replay-state-required')
  assert.equal(verify(signed(), { trustRegistryCheckedAtMs: now - 60_001 }).reason, 'fresh-trust-and-replay-state-required')
})

test('checks balance, reservation and resource fields as exact integer arithmetic', () => {
  const badUsdt = payload({ assets: {
    ...payload().assets,
    usdt: { ...payload().assets.usdt, availableBaseUnits: '1500000001' },
  } })
  assert.equal(verify(signed(badUsdt)).reason, 'usdt-balance-reservation-arithmetic-invalid')
  const badTrx = payload({ assets: {
    ...payload().assets,
    trx: { ...payload().assets.trx, availableSun: '1' },
  } })
  assert.equal(verify(signed(badTrx)).reason, 'trx-balance-reservation-arithmetic-invalid')
  const badContract = payload({ assets: {
    ...payload().assets,
    usdt: { ...payload().assets.usdt, contract: 'TWrongContract' },
  } })
  assert.equal(verify(signed(badContract)).reason, 'official-usdt-identity-invalid')
  const badBlock = payload({ chain: { blockNumber: 99, blockId: 'bad', finality: 'solidified' } })
  assert.equal(verify(signed(badBlock)).reason, 'solidified-chain-anchor-invalid')
  const badReservation = payload({ reservation: { sequence: -1, snapshotId: 'reservation-snapshot-0001' } })
  assert.equal(verify(signed(badReservation)).reason, 'reservation-snapshot-binding-invalid')
})

test('read-only gateway client uses one allowlisted HTTPS GET and rejects redirects', async () => {
  let captured
  const result = await fetchPrivateTreasuryVaultObservation({
    gatewayBaseUrl: 'https://vault.example.test/',
    allowedOrigins: ['https://vault.example.test'],
    vaultId,
    bearerToken: 'test-token-with-sufficient-length',
    fetchImpl: async (url, init) => {
      captured = { url, init }
      return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(signed()) }
    },
    timeoutMs: 1000,
  })
  assert.equal(result.readOnly, true)
  assert.equal(captured.init.method, 'GET')
  assert.equal(captured.init.redirect, 'error')
  assert.equal(captured.init.headers.Authorization, 'Bearer test-token-with-sufficient-length')
  assert.equal(captured.url, 'https://vault.example.test/v1/vaults/vault-private-001/observations/latest')
  await assert.rejects(() => fetchPrivateTreasuryVaultObservation({
    gatewayBaseUrl: 'http://vault.example.test/',
    allowedOrigins: ['http://vault.example.test'],
    vaultId,
    bearerToken: 'test-token-with-sufficient-length',
    fetchImpl: async () => { throw new Error('must-not-fetch') },
  }), /private-vault-gateway-origin-not-allowlisted/)
  await assert.rejects(() => fetchPrivateTreasuryVaultObservation({
    gatewayBaseUrl: 'https://attacker.example.test/',
    allowedOrigins: ['https://vault.example.test'],
    vaultId,
    bearerToken: 'test-token-with-sufficient-length',
    fetchImpl: async () => { throw new Error('must-not-fetch') },
  }), /private-vault-gateway-origin-not-allowlisted/)
})

test('financial vault observation adapter is provider-independent and contains no signing or broadcast path', async () => {
  const source = await readFile(new URL('../server/private-treasury-vault-observation.mjs', import.meta.url), 'utf8')
  assert.match(source, /method: 'GET'/)
  assert.match(source, /redirect: 'error'/)
  assert.doesNotMatch(source, /fireblocks|fincra|sponsor_direct_payouts|signMessage|broadcastTransaction/i)
  assert.match(source, /payoutAuthorized: false/)
  assert.match(source, /transactionSigned: false/)
  assert.match(source, /broadcastAttempted: false/)
})


test('brands only genuine verifier results and rejects reconstructed or invalid results', () => {
  const receipt = signed()
  const verified = verify(receipt)
  assert.equal(isVerifiedPrivateTreasuryVaultObservation(verified), true)
  assert.equal(isVerifiedPrivateTreasuryVaultObservation({ ...verified }), false)
  assert.equal(isVerifiedPrivateTreasuryVaultObservation({ valid: true }), false)
  const invalidSignature = { ...receipt, signature: { ...receipt.signature, value: Buffer.alloc(64).toString('base64url') } }
  const rejected = verify(invalidSignature)
  assert.equal(rejected.valid, false)
  assert.equal(isVerifiedPrivateTreasuryVaultObservation(rejected), false)
  const altered = signed()
  altered.payload.assets.usdt.availableBaseUnits = '1400000000'
  assert.equal(isVerifiedPrivateTreasuryVaultObservation(verify(altered)), false)
})
