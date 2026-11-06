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
    this.events = new Map()
    this.identityStatuses = []
    this.reviewReasons = []
    this.requestUpdates = []
  }

  async connect() { return this }

  async query(sql, values = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.startsWith('insert into trc20_token_clone.fincra_payout_webhook_events')) {
      const digest = values[0]
      if (this.events.has(digest)) return { rows: [] }
      this.events.set(digest, { identity_status: 'unmatched', destination_tag: values[12] || null, review_reasons: JSON.parse(values[16] || '[]') })
      return { rows: [{ event_digest: digest }] }
    }
    if (normalized.startsWith('select identity_status, review_reasons from trc20_token_clone.fincra_payout_webhook_events')) {
      const event = this.events.get(values[0])
      return { rows: event ? [{ ...event }] : [] }
    }
    if (normalized.startsWith('select to_regclass')) {
      return { rows: [{ table_name: this.request ? 'trc20_token_clone.tron_transfer_sponsor_requests' : null }] }
    }
    if (normalized.startsWith('select id, customer_reference')) {
      return { rows: this.request && this.request.customer_reference === values[0] ? [this.request] : [] }
    }
    if (normalized.startsWith('update trc20_token_clone.fincra_payout_webhook_events')) {
      this.identityStatuses.push(values[1])
      const reasons = values[2] ? JSON.parse(values[2]) : []
      if (values[2]) this.reviewReasons.push(reasons)
      const event = this.events.get(values[0])
      if (event) {
        event.identity_status = values[1]
        event.review_reasons = reasons
      }
      return { rows: [] }
    }
    if (normalized.startsWith('update trc20_token_clone.tron_transfer_sponsor_requests')) {
      this.requestUpdates.push({ sql: String(sql), values })
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
  const reorderedData = Object.fromEntries(Object.entries(payoutWebhook().data).reverse())
  const reorderedEvent = normalizeFincraPayoutWebhook({ data: reorderedData, event: 'payout.successful' })
  assert.equal(reorderedEvent.eventDigest, event.eventDigest, 'deduplication must ignore JSON property order')

  const bankPayout = normalizeFincraPayoutWebhook({
    event: 'payout.successful',
    data: { ...payoutWebhook().data, paymentDestination: 'bank_account' },
  })
  assert.equal(bankPayout.targeted, false)
})

test('webhook normalization preserves destination tags in its signed-event identity', () => {
  const event = normalizeFincraPayoutWebhook(payoutWebhook({ destinationTag: 'deposit-2048' }))
  assert.equal(event.destinationTag, 'deposit-2048')
  const changed = normalizeFincraPayoutWebhook(payoutWebhook({ destinationTag: 'other-tag' }))
  assert.notEqual(changed.eventDigest, event.eventDigest)
})

test('normalizer marks mismatched event and provider statuses for review', () => {
  const event = normalizeFincraPayoutWebhook(payoutWebhook({ status: 'failed' }))
  assert.equal(event.targeted, true)
  assert.ok(event.reasons.includes('event-and-payout-status-mismatch'))
})

test('webhook rejects an invalid HMAC signature without connecting to the database', async () => {
  await withServer(null, async (base) => {
    const result = await postWebhook(base, payoutWebhook(), '0'.repeat(128))
    assert.equal(result.response.status, 401)
    assert.equal(result.payload.error, 'invalid-fincra-webhook-signature')
  }, {})
})

test('webhook records an authenticated matching payout event without claiming chain settlement', async () => {
  const database = new FakeDatabase({
    id: 'request-1',
    customer_reference: customerReference,
    recipient_address: recipientAddress,
    destination_tag: 'deposit-2048',
    amount_base_units: '10000000',
    fincra_status: 'processing',
    status: 'provider-processing',
  })
  await withServer(database, async (base) => {
    const result = await postWebhook(base, payoutWebhook({ destinationTag: 'deposit-2048' }))
    assert.equal(result.response.status, 200)
    assert.equal(result.payload.recorded, true)
    assert.equal(result.payload.localRequestMatched, true)
    assert.equal(result.payload.identityStatus, 'matched')
    assert.equal(result.payload.providerPayoutStatus, 'successful')
    assert.equal(result.payload.chainSettlement, 'not-verified')
    assert.equal(database.events.get(normalizeFincraPayoutWebhook(payoutWebhook({ destinationTag: 'deposit-2048' })).eventDigest).destination_tag, 'deposit-2048')
    assert.equal(database.requestUpdates.length, 1)
    assert.match(database.requestUpdates[0].sql, /status=CASE WHEN \$3='successful' THEN 'awaiting-chain-verification' ELSE 'provider-failed' END/)
    assert.deepEqual(database.identityStatuses, ['matched'])
  })
})

test('webhook cannot advance a withdrawal that has not reached a submitted reconciliation state', async () => {
  const database = new FakeDatabase({
    id: 'request-awaiting-authorization',
    customer_reference: customerReference,
    recipient_address: recipientAddress,
    destination_tag: null,
    amount_base_units: '10000000',
    fincra_status: null,
    status: 'awaiting-provider-authorization',
  })
  await withServer(database, async (base) => {
    const result = await postWebhook(base, payoutWebhook())
    assert.equal(result.response.status, 200)
    assert.equal(result.payload.identityStatus, 'review-required')
    assert.equal(result.payload.localRequestMatched, false)
    assert.equal(database.requestUpdates.length, 0)
    assert.ok(database.reviewReasons[0].includes('payout-not-in-submitted-or-reconciliation-state'))
  })
})

test('webhook destination-tag mismatch is recorded for review and not applied', async () => {
  const database = new FakeDatabase({
    id: 'request-tagged',
    customer_reference: customerReference,
    recipient_address: recipientAddress,
    destination_tag: 'expected-tag',
    amount_base_units: '10000000',
    fincra_status: 'processing',
    status: 'provider-processing',
  })
  await withServer(database, async (base) => {
    const result = await postWebhook(base, payoutWebhook({ destinationTag: 'different-tag' }))
    assert.equal(result.response.status, 200)
    assert.equal(result.payload.identityStatus, 'review-required')
    assert.equal(result.payload.localRequestMatched, false)
    assert.equal(database.requestUpdates.length, 0)
    assert.ok(database.reviewReasons[0].includes('destination-tag-mismatch'))
  })
})

test('webhook delivery is idempotent for the same signed event', async () => {
  const database = new FakeDatabase({
    id: 'request-1',
    customer_reference: customerReference,
    recipient_address: recipientAddress,
    amount_base_units: '10000000',
    fincra_status: 'processing',
    status: 'provider-processing',
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
    status: 'provider-processing',
  })
  await withServer(database, async (base) => {
    const result = await postWebhook(base, payoutWebhook({ amountReceived: 9 }))
    assert.equal(result.response.status, 200)
    assert.equal(result.payload.localRequestMatched, false)
    assert.equal(result.payload.identityStatus, 'review-required')
    assert.equal(database.requestUpdates.length, 0)
    assert.deepEqual(database.identityStatuses, ['review-required'])
    assert.ok(database.reviewReasons[0].includes('beneficiary-net-amount-mismatch'))
    assert.ok(database.reviewReasons[0].includes('successful-net-amount-does-not-match-request'))
    const duplicate = await postWebhook(base, payoutWebhook({ amountReceived: 9 }))
    assert.equal(duplicate.response.status, 200)
    assert.equal(duplicate.payload.duplicate, true)
    assert.equal(duplicate.payload.identityStatus, 'review-required')
    assert.equal(database.requestUpdates.length, 0, 'a mismatched duplicate must remain manual-review only')
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


test('webhook encryption-key environment alias is accepted without requiring an API key', async () => {
  const database = new FakeDatabase({
    id: 'request-1',
    customer_reference: customerReference,
    recipient_address: recipientAddress,
    amount_base_units: '10000000',
    fincra_status: 'processing',
    status: 'provider-processing',
  })
  await withServer(database, async (base) => {
    const result = await postWebhook(base, payoutWebhook())
    assert.equal(result.response.status, 200)
    assert.equal(result.payload.localRequestMatched, true)
  }, {
    FINCRA_WEBHOOK_SECRET: '',
    FINCRA_WEBHOOK_ENCRYPTION_KEY: secret,
  })
})

test('same Fincra webhook can reconcile later after its local request is created, without reapplying once matched', async () => {
  const database = new FakeDatabase(null)
  await withServer(database, async (base) => {
    const first = await postWebhook(base, payoutWebhook())
    assert.equal(first.response.status, 200)
    assert.equal(first.payload.recorded, true)
    assert.equal(first.payload.identityStatus, 'unmatched')
    assert.equal(database.requestUpdates.length, 0)

    database.request = {
      id: 'request-created-later',
      customer_reference: customerReference,
      recipient_address: recipientAddress,
      amount_base_units: '10000000',
      fincra_status: 'processing',
    status: 'provider-processing',
    }

    const replay = await postWebhook(base, payoutWebhook())
    assert.equal(replay.response.status, 200)
    assert.equal(replay.payload.duplicate, true)
    assert.equal(replay.payload.reprocessed, true)
    assert.equal(replay.payload.localRequestMatched, true)
    assert.equal(replay.payload.identityStatus, 'matched')
    assert.equal(database.requestUpdates.length, 1)

    const thirdDelivery = await postWebhook(base, payoutWebhook())
    assert.equal(thirdDelivery.response.status, 200)
    assert.equal(thirdDelivery.payload.duplicate, true)
    assert.equal(thirdDelivery.payload.reprocessed, undefined)
    assert.equal(thirdDelivery.payload.identityStatus, 'matched')
    assert.equal(database.requestUpdates.length, 1, 'a matched event must not reapply on later duplicate deliveries')
  })
})
