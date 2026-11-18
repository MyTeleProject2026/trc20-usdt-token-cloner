import { createHash } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'
import { parseFincraUsdtBaseUnits, verifyFincraWebhookSignature } from '../fincra-payout-provider.mjs'
import { payoutStatusFromProvider } from '../fincra-payout-status.mjs'
import { getFincraWebhookTransition } from '../fincra-payout-state.mjs'

const { Pool } = pg
const SCHEMA = 'trc20_token_clone'
const EVENT_STATUS = Object.freeze({
  'payout.successful': 'successful',
  'payout.failed': 'failed',
})
const CUSTOMER_REFERENCE_RE = /^[A-Za-z0-9._:-]{8,80}$/

let pool

function clean(value, max = 256) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function getDatabase(env) {
  if (!clean(env.DATABASE_URL, 4096)) return null
  if (pool) return pool
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 3,
    ssl: databaseSslConfig(connectionString, env),
  })
  pool.on('error', (error) => console.error('Fincra webhook database error:', error?.code || 'unknown'))
  return pool
}

function optionalAmount(value) {
  if (value === undefined || value === null || value === '') return { present: false, value: null }
  const parsed = parseFincraUsdtBaseUnits(value)
  return parsed === null
    ? { present: true, value: null, invalid: true }
    : { present: true, value: parsed, invalid: false }
}

/**
 * Normalize only Fincra's documented final payout events for the exact
 * same-currency USDT TRC20 crypto-wallet route. Unrelated payout events are
 * acknowledged but are not stored or applied to Tron Transfer requests.
 */
export function normalizeFincraPayoutWebhook(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    return { valid: false, reason: 'invalid-fincra-webhook-payload' }
  }

  const eventType = clean(payload.event, 64).toLowerCase()
  const expectedStatus = EVENT_STATUS[eventType]
  if (!expectedStatus) return { valid: true, targeted: false, reason: 'unsupported-fincra-event' }

  const data = payload.data
  const sourceCurrency = clean(data.sourceCurrency, 8).toUpperCase()
  const destinationCurrency = clean(data.destinationCurrency, 8).toUpperCase()
  const paymentScheme = clean(data.paymentScheme, 32).toLowerCase()
  const paymentDestination = clean(data.paymentDestination, 32).toLowerCase()
  const targeted = sourceCurrency === 'USDT'
    && destinationCurrency === 'USDT'
    && paymentScheme === 'usdt_trc20'
    && paymentDestination === 'crypto_wallet'
  if (!targeted) return { valid: true, targeted: false, reason: 'unsupported-payout-route' }

  const customerReference = clean(data.customerReference, 80)
  const providerStatus = payoutStatusFromProvider(data.status)
  const recipientAddress = clean(
    data.beneficiary?.walletAddress
      || data.beneficiary?.address
      || data.beneficiary?.accountNumber
      || data.recipient?.walletAddress
      || data.recipient?.address
      || data.recipient?.accountNumber
      || data.walletAddress,
    64,
  )
  const destinationTag = clean(data.beneficiary?.destinationTag || data.recipient?.destinationTag || data.destinationTag, 128)
  const amountCharged = optionalAmount(data.amountCharged)
  const amountReceived = optionalAmount(data.amountReceived)
  const fee = optionalAmount(data.fee)
  const reasons = []

  if (!CUSTOMER_REFERENCE_RE.test(customerReference)) reasons.push('customer-reference-missing-or-invalid')
  if (providerStatus !== expectedStatus) reasons.push('event-and-payout-status-mismatch')
  if (!isValidTronAddress(recipientAddress)) reasons.push('recipient-tron-address-missing-or-invalid')
  if (amountCharged.invalid || amountReceived.invalid || fee.invalid) reasons.push('payout-amount-invalid')
  if (amountReceived.present && amountReceived.value !== null && BigInt(amountReceived.value) <= 0n) {
    reasons.push('payout-amount-received-not-positive')
  }
  if (amountCharged.present && amountCharged.value !== null && amountReceived.value !== null
    && BigInt(amountCharged.value) < BigInt(amountReceived.value)) {
    reasons.push('amount-charged-below-amount-received')
  }
  if (fee.present && fee.value !== null && amountCharged.value !== null
    && BigInt(fee.value) > BigInt(amountCharged.value)) {
    reasons.push('payout-fee-exceeds-amount-charged')
  }
  if (expectedStatus === 'successful' && (!amountReceived.present || amountReceived.value === null)) {
    reasons.push('successful-payout-net-amount-missing')
  }

  return {
    valid: true,
    targeted: true,
    eventType,
    providerStatus,
    customerReference: CUSTOMER_REFERENCE_RE.test(customerReference) ? customerReference : null,
    providerReference: clean(data.reference || data.transactionReference, 128) || null,
    payoutId: data.id == null ? null : clean(String(data.id), 128) || null,
    sourceCurrency,
    destinationCurrency,
    paymentScheme,
    paymentDestination,
    recipientAddress: isValidTronAddress(recipientAddress) ? recipientAddress : null,
    destinationTag: destinationTag || null,
    amountChargedBaseUnits: amountCharged.value,
    amountReceivedBaseUnits: amountReceived.value,
    feeBaseUnits: fee.value,
    reasons,
    eventDigest: createHash('sha256').update(JSON.stringify({
      eventType, customerReference, providerReference: clean(data.reference || data.transactionReference, 128) || null,
      payoutId: data.id == null ? null : clean(String(data.id), 128) || null,
      providerStatus, sourceCurrency, destinationCurrency, paymentScheme, paymentDestination,
      recipientAddress, destinationTag: destinationTag || null, amountChargedBaseUnits: amountCharged.value,
      amountReceivedBaseUnits: amountReceived.value, feeBaseUnits: fee.value, reasons,
    }), 'utf8').digest('hex'),
  }
}

function getWebhookRequestMatchReasons(row, event) {
  const reasons = [...(event?.reasons || [])]
  if (!row) {
    reasons.push('local-payout-request-not-found')
    return reasons
  }
  if (event.customerReference !== row.customer_reference) reasons.push('customer-reference-mismatch')
  const transition = getFincraWebhookTransition({
    requestStatus: row.status,
    previousProviderStatus: row.fincra_status,
    providerStatus: event.providerStatus,
  })
  if (!transition.allowed) reasons.push(transition.reason)
  if (event.recipientAddress !== row.recipient_address) reasons.push('recipient-mismatch')
  if ((event.destinationTag || '') !== (row.destination_tag || '')) reasons.push('destination-tag-mismatch')
  if (event.sourceCurrency !== 'USDT' || event.destinationCurrency !== 'USDT') reasons.push('currency-route-mismatch')
  if (event.paymentScheme !== 'usdt_trc20' || event.paymentDestination !== 'crypto_wallet') {
    reasons.push('payment-scheme-or-destination-mismatch')
  }

  const requestedAmount = String(row.amount_base_units)
  if (event.amountReceivedBaseUnits !== null && event.amountReceivedBaseUnits !== requestedAmount) {
    reasons.push('beneficiary-net-amount-mismatch')
  }
  if (event.providerStatus === 'successful' && event.amountReceivedBaseUnits !== requestedAmount) {
    reasons.push('successful-net-amount-does-not-match-request')
  }

  return [...new Set(reasons)]
}

async function ensureSchema(client) {
  await client.query('CREATE SCHEMA IF NOT EXISTS ' + SCHEMA)
  await client.query(
    'CREATE TABLE IF NOT EXISTS ' + SCHEMA + '.fincra_payout_webhook_events (' +
    'event_digest CHAR(64) PRIMARY KEY, environment TEXT NOT NULL CHECK (environment IN (\'sandbox\',\'live\')), ' +
    'event_type TEXT NOT NULL CHECK (event_type IN (\'payout.successful\',\'payout.failed\')), ' +
    'customer_reference TEXT, provider_reference TEXT, provider_payout_id TEXT, provider_status TEXT NOT NULL, ' +
    'source_currency TEXT, destination_currency TEXT, payment_scheme TEXT, payment_destination TEXT, ' +
    'recipient_address TEXT, destination_tag TEXT, amount_charged_base_units NUMERIC(78,0), amount_received_base_units NUMERIC(78,0), ' +
    'fee_base_units NUMERIC(78,0), identity_status TEXT NOT NULL DEFAULT \'unmatched\' ' +
    'CHECK (identity_status IN (\'unmatched\',\'matched\',\'review-required\')), ' +
    'received_at TIMESTAMPTZ NOT NULL DEFAULT now())'
  )
  await client.query(
    'ALTER TABLE ' + SCHEMA + '.fincra_payout_webhook_events ADD COLUMN IF NOT EXISTS destination_tag TEXT'
  )
  await client.query(
    'ALTER TABLE ' + SCHEMA + '.fincra_payout_webhook_events ADD COLUMN IF NOT EXISTS review_reasons JSONB NOT NULL DEFAULT \'[]\'::jsonb'
  )
  await client.query(
    'CREATE INDEX IF NOT EXISTS fincra_payout_webhook_customer_reference_idx ON ' +
    SCHEMA + '.fincra_payout_webhook_events (customer_reference, received_at DESC)'
  )
}

/**
 * Receives signed Fincra payout events. It stores minimal metadata and applies
 * provider-status transitions only to an exactly matching request already in a
 * submitted/reconciliation state. It never initiates a payout or marks an
 * on-chain transfer confirmed.
 */
export function createFincraWebhookRouter({
  env = process.env,
  databaseFactory = getDatabase,
} = {}) {
  const router = Router()
  let schemaPromise = null

  async function readySchema(client) {
    if (!schemaPromise) {
      schemaPromise = ensureSchema(client).catch((error) => {
        schemaPromise = null
        throw error
      })
    }
    await schemaPromise
  }

  router.post('/fincra/webhook', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')

    const secret = clean(env.FINCRA_WEBHOOK_SECRET || env.FINCRA_WEBHOOK_ENCRYPTION_KEY, 4096)
    if (!secret) return res.status(503).json({ success: false, error: 'fincra-webhook-secret-not-configured' })

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === 'string' ? Buffer.from(req.body, 'utf8') : null
    if (!rawBody || rawBody.length === 0 || rawBody.length > 32 * 1024) {
      return res.status(400).json({ success: false, error: 'invalid-fincra-webhook-body' })
    }

    const signature = clean(req.headers?.signature, 256)
    if (!verifyFincraWebhookSignature(rawBody, signature, secret)) {
      return res.status(401).json({ success: false, error: 'invalid-fincra-webhook-signature' })
    }

    let payload
    try {
      payload = JSON.parse(rawBody.toString('utf8'))
    } catch {
      return res.status(400).json({ success: false, error: 'invalid-fincra-webhook-json' })
    }

    const event = normalizeFincraPayoutWebhook(payload)
    if (!event.valid) return res.status(400).json({ success: false, error: event.reason })
    if (!event.targeted) {
      return res.status(200).json({
        success: true,
        received: true,
        processed: false,
        reason: event.reason,
      })
    }

    if (!event.customerReference) {
      return res.status(200).json({
        success: true,
        received: true,
        processed: false,
        reason: 'customer-reference-missing-or-invalid',
      })
    }

    let db
    try {
      db = databaseFactory(env)
    } catch {
      return res.status(503).json({ success: false, error: 'fincra-webhook-database-unavailable' })
    }
    if (!db || typeof db.connect !== 'function') {
      return res.status(503).json({ success: false, error: 'fincra-webhook-database-unavailable' })
    }

    let client
    try {
      client = await db.connect()
      await readySchema(client)
      await client.query('BEGIN')

      const environment = env.FINCRA_ENVIRONMENT === 'live' ? 'live' : 'sandbox'
      const inserted = await client.query(
        'INSERT INTO ' + SCHEMA + '.fincra_payout_webhook_events ' +
        '(event_digest, environment, event_type, customer_reference, provider_reference, provider_payout_id, ' +
        'provider_status, source_currency, destination_currency, payment_scheme, payment_destination, recipient_address, destination_tag, ' +
        'amount_charged_base_units, amount_received_base_units, fee_base_units, review_reasons, identity_status) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,\'unmatched\') ' +
        'ON CONFLICT (event_digest) DO NOTHING RETURNING event_digest',
        [
          event.eventDigest, environment, event.eventType, event.customerReference,
          event.providerReference, event.payoutId, event.providerStatus, event.sourceCurrency,
          event.destinationCurrency, event.paymentScheme, event.paymentDestination, event.recipientAddress,
          event.destinationTag, event.amountChargedBaseUnits, event.amountReceivedBaseUnits, event.feeBaseUnits, JSON.stringify(event.reasons),
        ],
      )

      const duplicate = inserted.rows.length === 0
      if (duplicate) {
        // A previously unmatched delivery may be retried after the local intent
        // is created. Reconcile that same event only when absence of the local
        // request was its sole prior blocker; matched/reviewed events are terminal
        // for webhook replay and can never trigger another payout.
        const existingEvent = await client.query(
          'SELECT identity_status, review_reasons FROM ' + SCHEMA + '.fincra_payout_webhook_events ' +
          'WHERE event_digest=$1 FOR UPDATE',
          [event.eventDigest],
        )
        const prior = existingEvent.rows[0]
        if (!prior) throw new Error('duplicate-fincra-event-record-missing')
        const priorReasons = Array.isArray(prior.review_reasons) ? prior.review_reasons : []
        const safeToRetryMatch = prior.identity_status === 'unmatched'
          && event.reasons.length === 0
          && priorReasons.length === 1
          && priorReasons[0] === 'local-payout-request-not-found'
        if (!safeToRetryMatch) {
          await client.query('COMMIT')
          return res.status(200).json({
            success: true, received: true, duplicate: true, processed: false,
            localRequestMatched: prior.identity_status === 'matched',
            identityStatus: prior.identity_status,
            reason: prior.identity_status === 'unmatched'
              ? 'local-payout-request-still-not-found'
              : 'duplicate-event-already-reconciled-or-requires-review',
          })
        }
      }

      const requestTable = await client.query(
        'SELECT to_regclass($1) AS table_name',
        [SCHEMA + '.tron_transfer_sponsor_requests'],
      )
      let found = { rows: [] }
      if (requestTable.rows[0]?.table_name) {
        await client.query('ALTER TABLE ' + SCHEMA + '.tron_transfer_sponsor_requests ADD COLUMN IF NOT EXISTS destination_tag TEXT')
        found = await client.query(
          'SELECT id, customer_reference, recipient_address, destination_tag, amount_base_units, fincra_status, status ' +
          'FROM ' + SCHEMA + '.tron_transfer_sponsor_requests WHERE customer_reference=$1 LIMIT 1 FOR UPDATE',
          [event.customerReference],
        )
      }
      const row = found.rows[0] || null
      const reviewReasons = getWebhookRequestMatchReasons(row, event)
      const matched = reviewReasons.length === 0
      const identityStatus = matched ? 'matched' : row ? 'review-required' : 'unmatched'

      await client.query(
        'UPDATE ' + SCHEMA + '.fincra_payout_webhook_events SET identity_status=$2, review_reasons=$3::jsonb WHERE event_digest=$1',
        [event.eventDigest, identityStatus, JSON.stringify(reviewReasons)],
      )

      if (matched) {
        const transition = getFincraWebhookTransition({
          requestStatus: row.status,
          previousProviderStatus: row.fincra_status,
          providerStatus: event.providerStatus,
        })
        if (!transition.allowed) throw new Error('fincra-webhook-transition-not-allowed')
        await client.query(
          'UPDATE ' + SCHEMA + '.tron_transfer_sponsor_requests SET ' +
          'status=$8, ' +
          'fincra_reference=COALESCE($2,fincra_reference), fincra_status=$3, fincra_webhook_event=$4, ' +
          'fincra_webhook_received_at=now(), fincra_amount_charged_base_units=$5, ' +
          'fincra_amount_received_base_units=$6, fincra_fee_base_units=$7, ' +
          'fincra_submitted_at=COALESCE(fincra_submitted_at,now()), ' +
          'fincra_successful_at=CASE WHEN $3=\'successful\' THEN COALESCE(fincra_successful_at,now()) ELSE fincra_successful_at END, ' +
          'updated_at=now() WHERE id=$1',
          [
            row.id, event.providerReference, event.providerStatus, event.eventType,
            event.amountChargedBaseUnits, event.amountReceivedBaseUnits, event.feeBaseUnits,
            transition.nextStatus,
          ],
        )
      }

      await client.query('COMMIT')
      return res.status(200).json({
        success: true,
        received: true,
        recorded: !duplicate,
        duplicate,
        reprocessed: duplicate && matched,
        localRequestMatched: matched,
        identityStatus,
        providerPayoutStatus: event.providerStatus,
        chainSettlement: 'not-verified',
        note: matched
          ? 'Fincra provider status was recorded. TRON Mainnet settlement still requires independent transaction-receipt verification.'
          : 'The signed event was recorded for review but was not applied to a local payout request.',
      })
    } catch {
      if (client) {
        try { await client.query('ROLLBACK') } catch {}
      }
      return res.status(503).json({ success: false, error: 'fincra-webhook-processing-unavailable' })
    } finally {
      client?.release()
    }
  })

  return router
}

export default createFincraWebhookRouter()
