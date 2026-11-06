import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { createFincraWebhookRouter, normalizeFincraPayoutWebhook } from '../server/routes/fincra-webhook.mjs'

const secret = 'test-fincra-webhook-secret'
const recipientAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const customerReference = 'tt-payout-000001'

function payoutWebhook(overrides = {}) {
  const data = {
    id: 12345,
    reference: 'fincra-reference-123',
    customerReference,
    amountCharged: 10.5,
    amountReceived: 10,
    fee: 0.5,
    recipient: { walletAddress: recipientAddress },
    sourceCurrency: 'USDT',
    destinationCurrency: 'USDT',
    paymentScheme: 'usdt_trc20',
    paymentDestination: 'crypto_wallet',
    status: 'successful',
    ...overrides,
  }
  return { event: 'payout.successful', data }
}

function signature(payload, key = secret) {
  return createHmac('sha512', key).update(JSON.stringify(payload)).digest('hex')
}

class FakeDatabase {
  constructor(request = null) {
    this.request = request
    this.events = new Set()
    this.identityStatuses = []
    this.requestUpdates = []
  }

  async connect() { return this }

  async query(sql, values = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.startsWith('insert into trc20_token_clone.fincra_payout_webhook_events')) {
      const digest = values[0]
      if (this.events.has(digest)) return { rows: [] }
      this.events.add(digest)
      return { rows: [{ event_digest: digest }] }
    }
    if (normalized.startsWith('select id, customer_reference')) {
      return { rows: this.request && this.request.customer_reference === values[0] ? [this.request] : [] }
    }
    if (normalized.startsWith('update trc20_token_clone.fincra_payout_webhook_events')) {
      this.identityStatuses.push(values[1])
      return { rows: [] }
    }
    if (normalized.startsWith('update trc20_token_clone.tron_transfer_sponsor_requests')) {
      this.requestUpdates.push(values)
      return { rows: [] }
    }
    return { rows: [] }
  }

  release() {}
}

async function withServer(database, run, envOverrides = {}) {
  const app = express()
  app.use('/api/tron-transfer/fincra/webhook', express.raw({ type: 'application/json', limit: '32kb' }))
  app.use('/api/tron-transfer', createFincraWebhookRouter({
    env: { FINCRA_WEBHOOK_SECRET: secret, FINCRA_ENVIRONMENT: 'sandbox', ...envOverrides },
    databaseFactory: () => database,
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run('http://127.0.0.1:' + server.address().port)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function postWebhook(base, payload, sig = signature(payload)) {
  const response = await fetch(base + '/api/tron-transfer/fincra/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', signature: sig },
    body: JSON.stringify(payload),
  })
  return { response, payload: await response.json() }
}

test('normalizer accepts only exact USDT TRC20 crypto-wallet payout events', () => {
  const event = normalizeFincraPayoutWebhook(payoutWebhook())
  assert.equal(event.valid, true)
  assert.equal(event.targeted, true)
  assert.equal(event.eventType, 'payout.successful')
  assert.equal(event.providerStatus, 'successful')
  assert.equal(event.amountReceivedBaseUnits, '10000000')

  const bankPayout = normalizeFincraPayoutWebhook({
    event: 'payout.successful',
    data: { ...payoutWebhook().data, paymentDestination: 'bank_account' },
  })
  assert.equal(bankPayout.targeted, false)
})

test('normalizer marks mismatched event and provider statuses for review', () => {
  const event = normalizeFincraPayoutWebhook(payoutWebhook({ status: 'failed' }))
  assert.equal(event.targeted, true)
  assert.ok(event.reasons.includes('event-and-payout-status-mismatch'))
})

test('webhook rejects an invalid HMAC signature without connecting to the database', async () => {
  let databaseCalls = 0
  await withServer(null, async (base) => {
    const result = await postWebhook(base, payoutWebhook(), '0'.repeat(128))
    assert.equal(result.response.status, 401)
    assert.equal(result.payload.error, 'invalid-fincra-webhook-signature')
  }, {})
  assert.equal(databaseCalls, 0)
})

test('webhook records an authenticated matching payout event without claiming chain settlement', async () => {
  const database = new FakeDatabase({
    id: 'request-1',
    customer_reference: customerReference,
    recipient_address: recipientAddress,
    amount_base_units: '10000000',
    fincra_status: 'processing',
  })
  await withServer(database, async (base) => {
    const result = await postWebhook(base, payoutWebhook())
    assert.equal(result.response.status, 200)
    assert.equal(result.payload.recorded, true)
    assert.equal(result.payload.localRequestMatched, true)
    assert.equal(result.payload.identityStatus, 'matched')
    assert.equal(result.payload.providerPayoutStatus, 'successful')
    assert.equal(result.payload.chainSettlement, 'not-verified')
    assert.equal(database.requestUpdates.length, 1)
    assert.deepEqual(database.identityStatuses, ['matched'])
  })
})

test('webhook delivery is idempotent for the same signed event', async () => {
  const database = new FakeDatabase({
    id: 'request-1',
    customer_reference: customerReference,
    recipient_address: recipientAddress,
    amount_base_units: '10000000',
    fincra_status: 'processing',
  })
  await withServer(database, async (base) => {
    const first = await postWebhook(base, payoutWebhook())
    const second = await postWebhook(base, payoutWebhook())
    assert.equal(first.payload.recorded, true)
    assert.equal(second.payload.duplicate, true)
    assert.equal(database.requestUpdates.length, 1)
  })
})

test('webhook amount or recipient mismatch is persisted for review and never applied to the request', async () => {
  const database = new FakeDatabase({
    id: 'request-1',
    customer_reference: customerReference,
    recipient_address: recipientAddress,
    amount_base_units: '10000000',
    fincra_status: 'processing',
  })
  await withServer(database, async (base) => {
    const result = await postWebhook(base, payoutWebhook({ amountReceived: 9 }))
    assert.equal(result.response.status, 200)
    assert.equal(result.payload.localRequestMatched, false)
    assert.equal(result.payload.identityStatus, 'review-required')
    assert.equal(database.requestUpdates.length, 0)
    assert.deepEqual(database.identityStatuses, ['review-required'])
  })
})

test('webhook without a configured webhook secret fails closed', async () => {
  await withServer(null, async (base) => {
    const result = await postWebhook(base, payoutWebhook())
    assert.equal(result.response.status, 503)
    assert.equal(result.payload.error, 'fincra-webhook-secret-not-configured')
  }, { FINCRA_WEBHOOK_SECRET: '' })
})

test('webhook acknowledges an event with no matching local request as unmatched', async () => {
  const database = new FakeDatabase(null)
  await withServer(database, async (base) => {
    const result = await postWebhook(base, payoutWebhook())
    assert.equal(result.response.status, 200)
    assert.equal(result.payload.localRequestMatched, false)
    assert.equal(result.payload.identityStatus, 'unmatched')
  })
})
