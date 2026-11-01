import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  buildThirdPartyFundingAuthorizationMessage,
  verifyThirdPartyFundingAuthorization,
  OFFICIAL_TRON_MAINNET_USDT,
  THIRD_PARTY_FUNDING_AUTHORIZATION_FORMAT,
} from '../src/third-party-funding-authorization.mjs'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function makeTronAddress(fill) {
  const payload = Buffer.from('41' + fill.repeat(20), 'hex')
  const firstHash = createHash('sha256').update(payload).digest()
  const checksum = createHash('sha256').update(firstHash).digest().subarray(0, 4)
  const bytes = Buffer.concat([payload, checksum])
  let value = BigInt('0x' + bytes.toString('hex'))
  let encoded = ''
  while (value > 0n) {
    const remainder = Number(value % 58n)
    encoded = BASE58_ALPHABET[remainder] + encoded
    value /= 58n
  }
  return '1'.repeat(bytes.findIndex((byte) => byte !== 0)) + encoded
}
const SPONSOR = makeTronAddress('11')
const VAULT = makeTronAddress('22')
const NOW = Date.parse('2026-11-01T00:00:00.000Z')
const SIGNATURE = '0x' + 'a'.repeat(130)

function manifest(overrides = {}) {
  return {
    format: THIRD_PARTY_FUNDING_AUTHORIZATION_FORMAT,
    authorizationId: 'funding-consent-2026-001',
    network: 'mainnet',
    sponsorAddress: SPONSOR,
    vaultAddress: VAULT,
    usdtContract: OFFICIAL_TRON_MAINNET_USDT,
    maxUsdtBaseUnits: '25000000',
    maxTrxSun: '8000000',
    agreementReference: 'ORG-AGREEMENT-2026-001',
    agreementDocumentSha256: 'b'.repeat(64),
    issuedAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-11-04T00:00:00.000Z',
    signature: SIGNATURE,
    ...overrides,
  }
}

test('canonical funding consent binds source, actual vault, asset, caps and written agreement reference', () => {
  const message = buildThirdPartyFundingAuthorizationMessage(manifest())
  assert.ok(message.includes('Source wallet: ' + SPONSOR))
  assert.ok(message.includes('Destination Fireblocks vault: ' + VAULT))
  assert.match(message, /Maximum USDT principal in base units \(6 decimals\): 25000000/)
  assert.match(message, /Maximum native TRX in SUN \(6 decimals\): 8000000/)
  assert.match(message, /Separate written agreement reference: ORG-AGREEMENT-2026-001/)
  assert.match(message, /SHA-256 of exact executed agreement file: b{64}/)
  assert.match(message, /Version: 2/)
  assert.match(message, /does not by itself authorize subsequent withdrawals/)
})

test('a valid signature from the exact sponsor wallet verifies as incoming-deposit consent only', async () => {
  let verifiedMessage = ''
  const result = await verifyThirdPartyFundingAuthorization(manifest(), {
    expectedVaultAddress: VAULT,
    now: () => NOW,
    verifyMessage: async (message, signature) => {
      verifiedMessage = message
      assert.equal(signature, SIGNATURE)
      return SPONSOR
    },
  })
  assert.equal(result.verified, true)
  assert.equal(result.authorization.scope, 'one-manually-initiated-incoming-deposit')
  assert.equal(result.authorization.subsequentPayoutsAuthorized, false)
  assert.match(verifiedMessage, /TRON Mainnet/)
  assert.match(verifiedMessage, /SHA-256 of exact executed agreement file: b{64}/)
})

test('a signature recovered to a different address is rejected', async () => {
  const result = await verifyThirdPartyFundingAuthorization(manifest(), {
    expectedVaultAddress: VAULT,
    now: () => NOW,
    verifyMessage: async () => VAULT,
  })
  assert.deepEqual(result, {
    verified: false,
    reason: 'authorization-signer-does-not-match-source-wallet',
  })
})

test('the consent must target the configured Fireblocks vault, not an unrelated watch-only address', async () => {
  const result = await verifyThirdPartyFundingAuthorization(manifest({
    vaultAddress: SPONSOR,
  }), {
    expectedVaultAddress: VAULT,
    now: () => NOW,
    verifyMessage: async () => { throw new Error('verification must not run for invalid scope') },
  })
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'sponsor-and-vault-address-must-be-distinct')
})

test('the manifest rejects a different destination vault before verifying signatures', async () => {
  const otherVault = 'T' + 'A'.repeat(33)
  const result = await verifyThirdPartyFundingAuthorization(manifest({
    vaultAddress: otherVault,
  }), {
    expectedVaultAddress: VAULT,
    now: () => NOW,
    verifyMessage: async () => { throw new Error('verification must not run for invalid scope') },
  })
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'fireblocks-vault-address-invalid')
})

test('the manifest rejects non-official USDT, malformed amounts and unsupported fields', async () => {
  const cases = [
    [manifest({ usdtContract: 'fake-usdt-contract' }), 'official-mainnet-usdt-contract-mismatch'],
    [manifest({ maxUsdtBaseUnits: '1.25' }), 'maximum-usdt-base-units-invalid'],
    [manifest({ maxTrxSun: '0' }), 'maximum-trx-sun-invalid'],
    [manifest({ agreementDocumentSha256: 'not-a-sha256' }), 'agreement-document-sha256-required'],
    [manifest({ agreementDocumentSha256: undefined }), 'agreement-document-sha256-required'],
    [manifest({ privateKey: 'must-not-be-accepted' }), 'manifest-contains-unsupported-fields'],
  ]
  for (const [input, reason] of cases) {
    const result = await verifyThirdPartyFundingAuthorization(input, {
      expectedVaultAddress: VAULT,
      now: () => NOW,
      verifyMessage: async () => SPONSOR,
    })
    assert.equal(result.verified, false)
    assert.equal(result.reason, reason)
  }
})

test('the manifest rejects expired, overlong and future-issued authorizations', async () => {
  const cases = [
    [manifest({ expiresAt: '2026-10-31T23:59:59.000Z' }), 'authorization-expired-or-expiry-invalid'],
    [manifest({ expiresAt: '2026-11-10T00:00:00.000Z' }), 'authorization-validity-exceeds-seven-days'],
    [manifest({ issuedAt: '2026-11-01T00:10:00.000Z' }), 'authorization-issued-at-is-in-the-future'],
  ]
  for (const [input, reason] of cases) {
    const result = await verifyThirdPartyFundingAuthorization(input, {
      expectedVaultAddress: VAULT,
      now: () => NOW,
      verifyMessage: async () => SPONSOR,
    })
    assert.equal(result.verified, false)
    assert.equal(result.reason, reason)
  }
})

test('invalid signature format is rejected without invoking signature recovery', async () => {
  const result = await verifyThirdPartyFundingAuthorization(manifest({ signature: 'not-a-signature' }), {
    expectedVaultAddress: VAULT,
    now: () => NOW,
    verifyMessage: async () => { throw new Error('verification must not run') },
  })
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'authorization-signature-invalid-format')
})


test('legacy v1 consent remains verifiable for historical evidence but carries no agreement digest', async () => {
  const legacy = manifest({
    format: 'tron-token-studio/third-party-funding-authorization/v1',
  })
  delete legacy.agreementDocumentSha256
  const result = await verifyThirdPartyFundingAuthorization(legacy, {
    expectedVaultAddress: VAULT,
    now: () => NOW,
    verifyMessage: async (message) => {
      assert.match(message, /Version: 1/)
      assert.doesNotMatch(message, /SHA-256 of exact executed agreement file/)
      return SPONSOR
    },
  })
  assert.equal(result.verified, true)
  assert.equal(result.authorization.agreementDocumentSha256, null)
})
