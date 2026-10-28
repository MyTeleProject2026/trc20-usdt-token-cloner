import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTreasuryWithdrawalAuthorizationMessage,
  isTreasuryAuthorizationExpiryValid,
  OFFICIAL_TRON_MAINNET_USDT,
} from '../src/treasury-withdrawal-auth.mjs'
import { verifyTreasuryOwnerPayoutSignature } from '../server/routes/treasury-withdrawals.mjs'

const ownerAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const treasuryAddress = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax'
const recipientAddress = 'TLPsmx7qvAq5QGJSYxCBkXb6j9bQvVQ3yP'
const base = {
  origin: 'https://tron-token-studio.example',
  ownerAddress,
  treasuryAddress,
  recipientAddress,
  amountBaseUnits: '12345000',
  idempotencyKey: 'withdrawal-12345678-1234-4123-8123-123456789abc',
  authorizationExpiresAt: 1_800_000_000_000,
}

test('owner payout signature message binds origin, identities, official token, exact amount, request key and expiry', () => {
  const message = buildTreasuryWithdrawalAuthorizationMessage(base)
  for (const expected of [
    'Network: TRON Mainnet',
    `Origin: ${base.origin}`,
    `Owner: ${ownerAddress}`,
    `Treasury: ${treasuryAddress}`,
    `Token contract: ${OFFICIAL_TRON_MAINNET_USDT}`,
    'Token decimals: 6',
    `Recipient: ${recipientAddress}`,
    'Amount base units: 12345000',
    `Idempotency key: ${base.idempotencyKey}`,
    `Expires at Unix milliseconds: ${base.authorizationExpiresAt}`,
  ]) assert.ok(message.includes(expected), expected)
  assert.match(message, /does not mint or create tokens/)
})

test('owner payout signature message rejects invalid addresses, base-unit amount, key and expiry', () => {
  for (const patch of [
    { ownerAddress: 'not-an-address' },
    { treasuryAddress: '' },
    { recipientAddress: 'T' },
    { amountBaseUnits: '0' },
    { amountBaseUnits: '01' },
    { amountBaseUnits: '1.2' },
    { idempotencyKey: 'short' },
    { authorizationExpiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { origin: '' },
  ]) {
    assert.throws(() => buildTreasuryWithdrawalAuthorizationMessage({ ...base, ...patch }))
  }
})

test('owner payout signatures expire no later than two minutes after they were created', () => {
  const now = 1_800_000_000_000
  assert.equal(isTreasuryAuthorizationExpiryValid(now + 1, now), true)
  assert.equal(isTreasuryAuthorizationExpiryValid(now + 120_000, now), true)
  assert.equal(isTreasuryAuthorizationExpiryValid(now, now), false)
  assert.equal(isTreasuryAuthorizationExpiryValid(now - 1, now), false)
  assert.equal(isTreasuryAuthorizationExpiryValid(now + 120_001, now), false)
  assert.equal(isTreasuryAuthorizationExpiryValid('1800000000001', now), false)
})


test('treasury withdrawal authorization verifier accepts only the recovered owner address', async () => {
  const signature = '0x' + 'a'.repeat(130)
  let observed = null
  const tronWeb = {
    trx: {
      verifyMessageV2: async (message, suppliedSignature) => {
        observed = { message, signature: suppliedSignature }
        return ownerAddress
      },
    },
  }
  assert.equal(await verifyTreasuryOwnerPayoutSignature(tronWeb, {
    message: 'exact request',
    signature,
    expectedOwnerAddress: ownerAddress,
  }), true)
  assert.deepEqual(observed, { message: 'exact request', signature })
  assert.equal(await verifyTreasuryOwnerPayoutSignature(tronWeb, {
    message: 'exact request',
    signature,
    expectedOwnerAddress: recipientAddress,
  }), false)
})

test('treasury withdrawal authorization verifier fails closed for malformed signatures and verifier errors', async () => {
  let called = false
  const tronWeb = { trx: { verifyMessageV2: async () => { called = true; return ownerAddress } } }
  assert.equal(await verifyTreasuryOwnerPayoutSignature(tronWeb, {
    message: 'request',
    signature: 'not-a-signature',
    expectedOwnerAddress: ownerAddress,
  }), false)
  assert.equal(called, false)
  assert.equal(await verifyTreasuryOwnerPayoutSignature({
    trx: { verifyMessageV2: async () => { throw new Error('verification failed') } },
  }, {
    message: 'request',
    signature: '0x' + 'a'.repeat(130),
    expectedOwnerAddress: ownerAddress,
  }), false)
  assert.equal(await verifyTreasuryOwnerPayoutSignature({}, {
    message: 'request',
    signature: '0x' + 'a'.repeat(130),
    expectedOwnerAddress: ownerAddress,
  }), false)
})
