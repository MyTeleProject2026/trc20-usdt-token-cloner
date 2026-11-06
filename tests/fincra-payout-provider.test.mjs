import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  buildFincraUsdtTronPayoutPayload,
  getFincraConfig,
  getFincraPayoutByCustomerReference,
  initiateFincraSandboxUsdtTronPayout,
  normalizeFincraPayoutRecord,
  parseFincraUsdtBaseUnits,
  readFincraAccountDiagnostics,
  verifyFincraWebhookSignature,
} from '../server/fincra-payout-provider.mjs'

const recipient = 'TF48MUvZhSDpLFfC414b94Nj4LwqBFbXom'
const sponsorBusiness = 'BUS-123456'
const payoutInput = {
  recipientAddress: recipient,
  beneficiaryName: 'Test Beneficiary',
  amount: '12.345678',
  customerReference: 'tt-payout-000001',
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('Fincra config defaults to sandbox and does not expose credentials in summaries', () => {
  const config = getFincraConfig({
    FINCRA_SECRET_KEY: 'test-secret',
    FINCRA_BUSINESS_ID: sponsorBusiness,
  })
  assert.equal(config.mode, 'sandbox')
  assert.equal(config.baseUrl, 'https://sandboxapi.fincra.com')
  assert.equal(config.sourceCurrency, 'USDT')
  assert.equal(config.apiKey, 'test-secret')
})

test('USDT base-unit parsing rejects invalid precision and malformed values', () => {
  assert.equal(parseFincraUsdtBaseUnits('1'), '1000000')
  assert.equal(parseFincraUsdtBaseUnits('12.345678'), '12345678')
  assert.equal(parseFincraUsdtBaseUnits('0.000001'), '1')
  assert.equal(parseFincraUsdtBaseUnits('1.0000001'), null)
  assert.equal(parseFincraUsdtBaseUnits('-1'), null)
  assert.equal(parseFincraUsdtBaseUnits('01'), null)
})

test('Fincra payload is pinned to same-currency official USDT TRON payout scheme', () => {
  const body = buildFincraUsdtTronPayoutPayload({
    ...payoutInput,
    businessId: sponsorBusiness,
    beneficiaryEmail: 'owner@example.test',
  })
  assert.deepEqual(body, {
    business: sponsorBusiness,
    sourceCurrency: 'USDT',
    destinationCurrency: 'USDT',
    amount: 12.345678,
    customerReference: payoutInput.customerReference,
    description: 'Authorized TRON Mainnet USDT payout',
    paymentDestination: 'crypto_wallet',
    paymentScheme: 'usdt_trc20',
    beneficiary: {
      walletAddress: recipient,
      accountHolderName: 'Test Beneficiary',
      email: 'owner@example.test',
    },
  })
})

test('Fincra payload builder rejects invalid recipients, precision and references', () => {
  assert.throws(() => buildFincraUsdtTronPayoutPayload({
    ...payoutInput, businessId: sponsorBusiness, recipientAddress: 'TNotARealAddress',
  }), /invalid-tron-mainnet-recipient-address/)
  assert.throws(() => buildFincraUsdtTronPayoutPayload({
    ...payoutInput, businessId: sponsorBusiness, amount: '1.0000001',
  }), /amount-must-be-positive/)
  assert.throws(() => buildFincraUsdtTronPayoutPayload({
    ...payoutInput, businessId: sponsorBusiness, customerReference: 'short',
  }), /invalid-unique-customer-reference/)
})

test('Fincra successful status requires exact recipient identity and exact net amount', () => {
  const payout = {
    status: 'successful',
    customerReference: payoutInput.customerReference,
    sourceCurrency: 'USDT',
    destinationCurrency: 'USDT',
    paymentScheme: 'usdt_trc20',
    paymentDestination: 'crypto_wallet',
    beneficiary: { walletAddress: recipient },
    amountReceived: '12.345678',
    amountCharged: '12.400000',
    reference: 'fincra-reference-1',
  }
  const normalized = normalizeFincraPayoutRecord(payout, payoutInput)
  assert.equal(normalized.valid, true)
  assert.equal(normalized.status, 'successful')
  assert.equal(normalized.amountReceivedBaseUnits, '12345678')
  assert.equal(normalized.providerReference, 'fincra-reference-1')
})

test('Fincra successful status with fee-shortened receiver amount is sent to manual review', () => {
  const payout = {
    status: 'successful',
    customerReference: payoutInput.customerReference,
    sourceCurrency: 'USDT',
    destinationCurrency: 'USDT',
    paymentScheme: 'usdt_trc20',
    paymentDestination: 'crypto_wallet',
    beneficiary: { walletAddress: recipient },
    amountReceived: '12.300000',
    amountCharged: '12.400000',
  }
  const normalized = normalizeFincraPayoutRecord(payout, payoutInput)
  assert.equal(normalized.valid, false)
  assert.equal(normalized.status, 'manual-review')
  assert.ok(normalized.reasons.includes('beneficiary-amount-does-not-equal-requested-amount'))
})

test('Fincra payout identity mismatch never becomes a successful local status', () => {
  const payout = {
    status: 'successful',
    customerReference: payoutInput.customerReference,
    sourceCurrency: 'USD',
    destinationCurrency: 'USDT',
    paymentScheme: 'usdt_trc20',
    paymentDestination: 'crypto_wallet',
    beneficiary: { walletAddress: recipient },
    amountReceived: '12.345678',
  }
  const normalized = normalizeFincraPayoutRecord(payout, payoutInput)
  assert.equal(normalized.valid, false)
  assert.equal(normalized.status, 'manual-review')
  assert.ok(normalized.reasons.includes('source-currency-mismatch'))
})

test('Fincra webhook HMAC-SHA512 validation accepts the original payload and rejects tampering', () => {
  const secret = 'webhook-test-secret'
  const payload = { event: 'payout.successful', data: { customerReference: payoutInput.customerReference } }
  const signature = createHmac('sha512', secret).update(JSON.stringify(payload)).digest('hex')
  assert.equal(verifyFincraWebhookSignature(payload, signature, secret), true)
  assert.equal(verifyFincraWebhookSignature(JSON.stringify(payload), signature, secret), true)
  assert.equal(verifyFincraWebhookSignature({ ...payload, event: 'payout.failed' }, signature, secret), false)
  assert.equal(verifyFincraWebhookSignature(payload, 'bad-signature', secret), false)
  assert.equal(verifyFincraWebhookSignature(payload, signature, ''), false)
})

test('Fincra read-only diagnostics verify profile business ID and report sponsor-account USDT balance', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    if (String(url).includes('/profile/business/me')) {
      return jsonResponse({ success: true, data: { _id: sponsorBusiness } })
    }
    return jsonResponse({
      success: true,
      data: [{ id: 'wallet-1', currency: 'USDT', availableBalance: '25.500000' }],
    })
  }
  const diagnostics = await readFincraAccountDiagnostics({
    FINCRA_SECRET_KEY: 'sandbox-key',
    FINCRA_BUSINESS_ID: sponsorBusiness,
  }, { fetchImpl })
  assert.equal(urls.length, 2)
  assert.equal(diagnostics.apiAuthenticated, true)
  assert.equal(diagnostics.businessIdMatches, true)
  assert.equal(diagnostics.usdtWalletFound, true)
  assert.equal(diagnostics.availableUsdtBalance, '25.500000')
  assert.equal(diagnostics.availableUsdtBalanceBaseUnits, '25500000')
  assert.equal(diagnostics.accountBalanceIsSponsorBusinessFunds, true)
  assert.equal(diagnostics.payoutSubmissionEnabled, false)
})

test('Fincra diagnostics also accept a single-wallet object response', async () => {
  const fetchImpl = async (url) => String(url).includes('/profile/business/me')
    ? jsonResponse({ success: true, data: { _id: sponsorBusiness } })
    : jsonResponse({ success: true, data: { id: 'wallet-2', currency: 'USDT', availableBalance: '3.000001' } })
  const diagnostics = await readFincraAccountDiagnostics({
    FINCRA_SECRET_KEY: 'sandbox-key',
    FINCRA_BUSINESS_ID: sponsorBusiness,
  }, { fetchImpl })
  assert.equal(diagnostics.businessIdMatches, true)
  assert.equal(diagnostics.usdtWalletFound, true)
  assert.equal(diagnostics.availableUsdtBalanceBaseUnits, '3000001')
})

test('Fincra diagnostics do not call the provider without server-side credentials', async () => {
  let called = false
  const diagnostics = await readFincraAccountDiagnostics({}, {
    fetchImpl: async () => { called = true; throw new Error('must not be called') },
  })
  assert.equal(called, false)
  assert.equal(diagnostics.configured, false)
  assert.equal(diagnostics.apiAuthenticated, false)
  assert.equal(diagnostics.availableUsdtBalance, null)
})

test('Fincra live environment is not accepted by the sandbox submit helper', async () => {
  await assert.rejects(
    initiateFincraSandboxUsdtTronPayout({
      FINCRA_ENVIRONMENT: 'live',
      FINCRA_SECRET_KEY: 'live-key',
      FINCRA_BUSINESS_ID: sponsorBusiness,
      FINCRA_SANDBOX_PAYOUTS_ENABLED: 'true',
    }, payoutInput),
    /live-fincra-submission-not-enabled-in-this-release/,
  )
})

test('Fincra sandbox payout submit is disabled unless its explicit sandbox gate is on', async () => {
  await assert.rejects(
    initiateFincraSandboxUsdtTronPayout({
      FINCRA_SECRET_KEY: 'sandbox-key',
      FINCRA_BUSINESS_ID: sponsorBusiness,
    }, payoutInput),
    /fincra-sandbox-submission-disabled/,
  )
})

test('Fincra sandbox submit and customer-reference lookup use documented endpoints', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (options.method === 'POST') {
      return jsonResponse({ success: true, data: { id: 10, reference: 'provider-ref', customerReference: payoutInput.customerReference, status: 'processing' } })
    }
    return jsonResponse({ success: true, data: { customerReference: payoutInput.customerReference, status: 'processing' } })
  }
  const env = {
    FINCRA_SECRET_KEY: 'sandbox-key',
    FINCRA_BUSINESS_ID: sponsorBusiness,
    FINCRA_SANDBOX_PAYOUTS_ENABLED: 'true',
  }
  const accepted = await initiateFincraSandboxUsdtTronPayout(env, payoutInput, { fetchImpl })
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.sandboxOnly, true)
  assert.equal(accepted.settlementConfirmed, false)
  assert.equal(accepted.status, 'processing')
  const found = await getFincraPayoutByCustomerReference(env, payoutInput.customerReference, { fetchImpl })
  assert.equal(found.status, 'processing')
  assert.match(calls[0].url, /\/disbursements\/payouts$/)
  assert.match(calls[1].url, /\/disbursements\/payouts\/customer-reference\//)
  assert.equal(calls[0].options.headers['api-key'], 'sandbox-key')
  const submittedBody = JSON.parse(calls[0].options.body)
  assert.equal(submittedBody.paymentScheme, 'usdt_trc20')
  assert.equal(submittedBody.beneficiary.walletAddress, recipient)
})
