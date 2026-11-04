import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  createFincraClient,
  fincraConfiguration,
  isValidFincraAmount,
  verifyFincraWebhookSignature,
} from '../server/fincra-client.mjs'

const BASE_ENV = {
  FINCRA_API_BASE: 'https://sandboxapi.fincra.com',
  FINCRA_API_KEY: 'test-secret-key',
  FINCRA_BUSINESS_ID: 'business-123',
  FINCRA_WEBHOOK_SECRET: 'test-webhook-secret',
  FINCRA_SOURCE_CURRENCY: 'USDT',
  FINCRA_PAYOUTS_ENABLED: 'false',
}

test('Fincra configuration defaults to sandbox and rejects unapproved API origins', () => {
  const config = fincraConfiguration({ ...BASE_ENV, FINCRA_API_BASE: undefined })
  assert.equal(config.apiBase, 'https://sandboxapi.fincra.com')
  assert.equal(config.environment, 'sandbox')
  assert.equal(config.configured, true)
  assert.equal(fincraConfiguration({ ...BASE_ENV, FINCRA_API_BASE: 'https://attacker.example' }).configured, false)
})

test('Fincra payout capability is disabled unless explicitly enabled', () => {
  const disabled = createFincraClient({ env: BASE_ENV, fetchImpl: async () => { throw new Error('must not call') } })
  assert.equal(disabled.isConfigured(), true)
  assert.equal(disabled.isEnabled(), false)
  const enabled = createFincraClient({ env: { ...BASE_ENV, FINCRA_PAYOUTS_ENABLED: 'true' } })
  assert.equal(enabled.isEnabled(), true)
})

test('amount validation accepts six-decimal strings and rejects exponent, zero, negatives and excess precision', () => {
  assert.equal(isValidFincraAmount('12'), true)
  assert.equal(isValidFincraAmount('12.000001'), true)
  assert.equal(isValidFincraAmount('0'), false)
  assert.equal(isValidFincraAmount('-1'), false)
  assert.equal(isValidFincraAmount('1e2'), false)
  assert.equal(isValidFincraAmount('1.0000001'), false)
})

test('stablecoin payout is pinned to USDT TRC20 with required beneficiary fields', async () => {
  const calls = []
  const client = createFincraClient({
    env: BASE_ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 8, reference: 'provider-ref', customerReference: 'tts-payout-reference-001', status: 'processing' } }) }
    },
  })
  const response = await client.createUsdtTrc20Payout({
    amount: '10.25',
    customerReference: 'tts-payout-reference-001',
    walletAddress: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
    accountHolderName: 'Test Recipient',
  })
  assert.equal(response.data.status, 'processing')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://sandboxapi.fincra.com/disbursements/payouts')
  assert.equal(calls[0].options.headers['api-key'], BASE_ENV.FINCRA_API_KEY)
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.destinationCurrency, 'USDT')
  assert.equal(body.paymentDestination, 'crypto_wallet')
  assert.equal(body.paymentScheme, 'usdt_trc20')
  assert.equal(body.beneficiary.walletAddress, 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2')
  assert.equal(body.beneficiary.accountHolderName, 'Test Recipient')
  assert.equal(body.amount, 10.25)
  assert.equal(calls[0].options.redirect, 'error')
})

test('cross-currency payout requires a quote reference', async () => {
  const client = createFincraClient({ env: { ...BASE_ENV, FINCRA_SOURCE_CURRENCY: 'USD' } })
  await assert.rejects(() => client.createUsdtTrc20Payout({
    amount: '10',
    customerReference: 'tts-payout-reference-002',
    walletAddress: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
    accountHolderName: 'Test Recipient',
  }), /quote reference is required/)
})

test('network failure is explicitly ambiguous and does not invite duplicate payout creation', async () => {
  const client = createFincraClient({ env: BASE_ENV, fetchImpl: async () => { throw new Error('network unavailable') } })
  await assert.rejects(
    () => client.createUsdtTrc20Payout({
      amount: '1',
      customerReference: 'tts-payout-reference-003',
      walletAddress: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
      accountHolderName: 'Test Recipient',
    }),
    (error) => error.code === 'fincra-network-outcome-unknown',
  )
})

test('Fincra webhook uses HMAC SHA512 over the parsed payload and rejects tampering', () => {
  const payload = { event: 'payout.successful', data: { customerReference: 'tts-payout-reference-004' } }
  const signature = createHmac('sha512', BASE_ENV.FINCRA_WEBHOOK_SECRET).update(JSON.stringify(payload)).digest('hex')
  assert.equal(verifyFincraWebhookSignature(payload, signature, BASE_ENV.FINCRA_WEBHOOK_SECRET), true)
  assert.equal(verifyFincraWebhookSignature({ ...payload, data: { customerReference: 'tampered' } }, signature, BASE_ENV.FINCRA_WEBHOOK_SECRET), false)
  assert.equal(verifyFincraWebhookSignature(payload, '00', BASE_ENV.FINCRA_WEBHOOK_SECRET), false)
})

test('Fincra customer-reference and provider-reference status lookups use encoded path segments', async () => {
  const paths = []
  const client = createFincraClient({
    env: BASE_ENV,
    fetchImpl: async (url) => {
      paths.push(url)
      return { ok: true, status: 200, json: async () => ({ success: true, data: { status: 'processing' } }) }
    },
  })
  await client.getPayoutByCustomerReference('tts-payout-reference-005')
  await client.getPayoutByTransactionReference('provider-ref-123')
  assert.deepEqual(paths, [
    'https://sandboxapi.fincra.com/disbursements/payouts/customer-reference/tts-payout-reference-005',
    'https://sandboxapi.fincra.com/disbursements/payouts/reference/provider-ref-123',
  ])
})
