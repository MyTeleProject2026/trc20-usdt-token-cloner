import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sponsorFireblocksExternalTxId,
  sponsorFireblocksSubmissionRelease,
  submitSponsorOrganizationFireblocksPayout,
  refreshSponsorOrganizationFireblocksPayout,
} from '../server/sponsor-organization-fireblocks-submission.mjs'

const principal = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const fee = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const receiver = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'
const contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const intent = {
  id: '9001', intentDigest: 'a'.repeat(64), status: 'sponsor_authorization_complete',
  network: 'mainnet', asset: 'USDT', tokenContract: contract, receiverAddress: receiver,
  amountBaseUnits: '2500000', feeCapSun: '300000', principalSponsorAddress: principal,
  feeSponsorAddress: fee, principalOrganizationId: '41', feeOrganizationId: '41',
  principalAccountId: '51', feeAccountId: '52',
  expiresAt: new Date(Date.now() + 300000).toISOString(),
}
const enabledEnv = {
  SPONSOR_ORG_FIREBLOCKS_SUBMISSION_ENABLED: 'true',
  SPONSOR_ORG_FIREBLOCKS_PRODUCTION_RELEASE_APPROVED: 'true',
  SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED: 'true',
  SPONSOR_ORG_FIREBLOCKS_RELEASE_REFERENCE: 'release-review-2026-001',
  FIREBLOCKS_API_KEY: 'api-user-key',
  FIREBLOCKS_SECRET_KEY_PATH: '/etc/secrets/fireblocks.pem',
  FIREBLOCKS_API_BASE: 'https://api.fireblocks.io',
  SPONSOR_FIREBLOCKS_REGISTRY_ORGANIZATION_ID: '41',
  SPONSOR_FIREBLOCKS_REGISTRY_PRINCIPAL_ACCOUNT_ID: '51',
  SPONSOR_FIREBLOCKS_REGISTRY_FEE_ACCOUNT_ID: '52',
  SPONSOR_FIREBLOCKS_PRINCIPAL_VAULT_ACCOUNT_ID: '101',
  SPONSOR_FIREBLOCKS_FEE_VAULT_ACCOUNT_ID: '202',
  SPONSOR_FIREBLOCKS_USDT_ASSET_ID: 'USDT_TRON',
  SPONSOR_FIREBLOCKS_TRX_ASSET_ID: 'TRX',
}

function createHarness({ intentOverrides = {}, findResults = [], createResult = null, createError = null } = {}) {
  const loadedIntent = { ...intent, ...intentOverrides }
  const state = { prepared: [], records: [], lookups: 0, creates: [], gets: 0, storeReads: 0, custodyCalls: 0 }
  const submission = {
    id: '1', intentId: loadedIntent.id, intentDigest: loadedIntent.intentDigest,
    externalTxId: sponsorFireblocksExternalTxId(loadedIntent),
    releaseReference: enabledEnv.SPONSOR_ORG_FIREBLOCKS_RELEASE_REFERENCE,
    status: 'prepared', providerTransactionId: null, providerStatus: null, transactionHash: null,
    providerObservationCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  const store = {
    async getPayoutIntentForPreflight() {
      state.storeReads += 1
      return { success: true, intent: loadedIntent, sponsorOwnerApprovalsVerified: true }
    },
    async prepareFireblocksPayoutSubmission(input) {
      state.prepared.push(input)
      return { success: true, duplicate: state.prepared.length > 1, submission: { ...submission } }
    },
    async recordFireblocksPayoutSubmission(input) {
      state.records.push(input)
      return { success: true, submission: {
        ...submission, status: input.status, providerTransactionId: input.providerTransactionId,
        providerStatus: input.providerStatus, transactionHash: input.transactionHash,
        providerObservationCount: state.records.length,
      } }
    },
    async getFireblocksPayoutSubmission() {
      return { success: true, submission: { ...submission } }
    },
  }
  const client = {
    isConfigured: () => true,
    async findTransactionByExternalId(id) {
      state.lookups += 1
      assert.equal(id, submission.externalTxId)
      if (findResults.length) {
        const next = findResults.shift()
        if (next instanceof Error) throw next
        return next
      }
      const error = new Error('not found')
      error.status = 404
      throw error
    },
    async createUsdtTransfer(input) {
      state.creates.push(input)
      if (createError) throw createError
      return createResult || { id: 'fireblocks-request-9001', status: 'SUBMITTED' }
    },
    async getTransaction(id) {
      state.gets += 1
      assert.equal(id, 'fireblocks-request-9001')
      return { id, status: 'COMPLETED', txHash: 'b'.repeat(64) }
    },
  }
  const fireblocksClientFactory = (env) => {
    assert.equal(env.FIREBLOCKS_VAULT_ACCOUNT_ID, '101')
    return client
  }
  const custodyPreflight = async () => {
    state.custodyCalls += 1
    return { success: true, status: 'fireblocks-custody-preflight-passed-review-required' }
  }
  return {
    state, store, client,
    submit: (overrides = {}) => submitSponsorOrganizationFireblocksPayout({
      store, intentId: loadedIntent.id, env: enabledEnv, fireblocksClientFactory, custodyPreflight, ...overrides,
    }),
    refresh: (overrides = {}) => refreshSponsorOrganizationFireblocksPayout({
      store, intentId: loadedIntent.id, env: enabledEnv, fireblocksClientFactory, ...overrides,
    }),
  }
}

test('submission release requires both explicit production gates, mainnet budget activation and a review reference', () => {
  assert.equal(sponsorFireblocksSubmissionRelease({}).enabled, false)
  assert.deepEqual(sponsorFireblocksSubmissionRelease({
    SPONSOR_ORG_FIREBLOCKS_SUBMISSION_ENABLED: 'true',
    SPONSOR_ORG_FIREBLOCKS_PRODUCTION_RELEASE_APPROVED: 'true',
    SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED: 'true',
  }).missing, ['SPONSOR_ORG_FIREBLOCKS_RELEASE_REFERENCE'])
  assert.equal(sponsorFireblocksSubmissionRelease(enabledEnv).enabled, true)
})

test('external transaction ID is deterministic and bound to the immutable intent digest', () => {
  const first = sponsorFireblocksExternalTxId(intent)
  assert.equal(first, 'tssponsor-9001-' + 'a'.repeat(64))
  assert.equal(sponsorFireblocksExternalTxId({ ...intent, intentDigest: 'c'.repeat(64) }), 'tssponsor-9001-' + 'c'.repeat(64))
})

test('provider submission creates one intent-bound Fireblocks request after all preflights pass', async () => {
  const harness = createHarness()
  const result = await harness.submit()
  assert.equal(result.success, true)
  assert.equal(result.status, 'provider-pending')
  assert.equal(result.providerRequestCreated, true)
  assert.equal(result.chainSettlement, 'awaiting-provider-transaction-hash')
  assert.equal(result.reservationRetained, true)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.submissionEnabled, false)
  assert.equal(result.transactionSubmitted, false)
  assert.equal(harness.state.custodyCalls, 1)
  assert.equal(harness.state.prepared.length, 1)
  assert.equal(harness.state.creates.length, 1)
  assert.deepEqual(harness.state.creates[0], {
    recipientAddress: receiver, amountUsdt: '2.5',
    externalTxId: sponsorFireblocksExternalTxId(intent),
    note: 'TRON Token Studio sponsor payout intent 9001',
  })
  assert.equal(harness.state.records[0].providerTransactionId, 'fireblocks-request-9001')
  assert.equal(harness.state.records[0].status, 'provider-pending')
})

test('disabled production release stops before provider calls, custody checks or submission records', async () => {
  const harness = createHarness()
  let factoryCalls = 0
  const result = await harness.submit({ env: { ...enabledEnv, SPONSOR_ORG_FIREBLOCKS_SUBMISSION_ENABLED: 'false' },
    fireblocksClientFactory: () => { factoryCalls += 1; throw new Error('must not be called') } })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'sponsor-fireblocks-production-release-disabled')
  assert.equal(factoryCalls, 0)
  assert.equal(harness.state.custodyCalls, 0)
  assert.equal(harness.state.prepared.length, 0)
})

test('an existing Fireblocks request is recovered by externalTxId without creating another request', async () => {
  const existing = { id: 'fireblocks-request-existing', status: 'PENDING_SIGNATURE' }
  const harness = createHarness({ findResults: [existing] })
  const result = await harness.submit()
  assert.equal(result.success, true)
  assert.equal(result.status, 'provider-pending')
  assert.equal(harness.state.creates.length, 0)
  assert.equal(harness.state.custodyCalls, 0)
  assert.equal(harness.state.prepared.length, 1)
})

test('an ambiguous provider submission recovers the same permanent externalTxId and never invents a chain hash', async () => {
  const ambiguous = new Error('timeout after request may have reached provider')
  const existing = { id: 'fireblocks-request-recovered', status: 'SUBMITTED' }
  const notFound = Object.assign(new Error('not found'), { status: 404 })
  const harness = createHarness({ createError: ambiguous, findResults: [notFound, notFound, existing] })
  const result = await harness.submit()
  assert.equal(result.success, true)
  assert.equal(result.status, 'provider-pending')
  assert.equal(harness.state.creates.length, 1)
  assert.equal(harness.state.lookups, 3)
  assert.equal(result.submission.transactionHash, null)
})

test('a provider outcome that remains unknown is persisted and keeps the sponsor reservation', async () => {
  const ambiguous = new Error('timeout')
  const notFound = Object.assign(new Error('not found'), { status: 404 })
  const harness = createHarness({ createError: ambiguous, findResults: [notFound, notFound, Object.assign(new Error('lookup unavailable'), { status: 503 })] })
  const result = await harness.submit()
  assert.equal(result.success, false)
  assert.equal(result.reason, 'fireblocks-provider-outcome-unknown')
  assert.equal(result.reservationRetained, true)
  assert.equal(harness.state.records.length, 1)
  assert.equal(harness.state.records[0].status, 'provider-unknown')
})

test('provider custody preflight failure prevents database preparation and Fireblocks transfer request', async () => {
  const harness = createHarness()
  const result = await harness.submit({ custodyPreflight: async () => ({ success: false, reason: 'provider-balance-low' }) })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'fireblocks-custody-preflight-not-passed')
  assert.equal(harness.state.prepared.length, 0)
  assert.equal(harness.state.creates.length, 0)
})

test('provider refresh reads existing transaction status only and never creates a transfer', async () => {
  const existing = { id: 'fireblocks-request-recovered', status: 'COMPLETED', txHash: 'b'.repeat(64) }
  const harness = createHarness({ findResults: [existing] })
  const result = await harness.refresh()
  assert.equal(result.success, true)
  assert.equal(result.status, 'broadcast-accepted')
  assert.equal(result.submission.transactionHash, 'b'.repeat(64))
  assert.equal(result.chainSettlement, 'solidified-chain-verification-required')
  assert.equal(harness.state.gets, 0, 'no provider ID in this fixture, so lookup by external ID is used')
  assert.equal(harness.state.creates.length, 0)
})

test('refresh with a provider transaction ID uses get-transaction and reports only chain verification pending', async () => {
  const harness = createHarness()
  harness.store.getFireblocksPayoutSubmission = async () => ({ success: true, submission: {
    id: '1', intentId: '9001', intentDigest: intent.intentDigest, externalTxId: sponsorFireblocksExternalTxId(intent),
    providerTransactionId: 'fireblocks-request-9001', status: 'provider-pending',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } })
  const result = await harness.refresh()
  assert.equal(result.success, true)
  assert.equal(result.status, 'broadcast-accepted')
  assert.equal(result.submission.transactionHash, 'b'.repeat(64))
  assert.equal(harness.state.gets, 1)
  assert.equal(harness.state.creates.length, 0)
})

test('submission rejects split organizations and non-Mainnet/non-USDT intents before contacting provider', async () => {
  const split = createHarness({ intentOverrides: { feeOrganizationId: '42' } })
  const splitResult = await split.submit()
  assert.equal(splitResult.success, false)
  assert.equal(splitResult.reason, 'dual-approved-official-mainnet-usdt-intent-required')
  assert.equal(split.state.lookups, 0)
  const testnet = createHarness({ intentOverrides: { network: 'nile' } })
  const testnetResult = await testnet.submit()
  assert.equal(testnetResult.success, false)
  assert.equal(testnet.state.lookups, 0)
})
