import test from 'node:test'
import assert from 'node:assert/strict'
import { createGasFreeRouter } from '../server/routes/gasfree.mjs'

function getRoute(router, routePath = '/capabilities') {
  const layer = router.stack.find((item) =>
    item.route?.path === routePath && item.route.methods?.get,
  )
  assert.ok(layer, `GET ${routePath} must be registered`)
  return layer.route.stack[0].handle
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

test('GasFree config status reports credential presence without exposing secrets or enabling transfers', async () => {
  const router = createGasFreeRouter({
    isConfigured: (network) => network === 'nile',
  })
  const res = responseRecorder()
  await getRoute(router, '/config-status')({ query: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.status, 'credentials-missing')
  assert.equal(res.body.networks.mainnet.configured, false)
  assert.deepEqual(res.body.networks.mainnet.requiredEnvironment, [
    'GASFREE_MAINNET_API_KEY', 'GASFREE_MAINNET_API_SECRET',
  ])
  assert.equal(res.body.networks.nile.configured, true)
  assert.equal(res.body.providerReachabilityVerified, false)
  assert.equal(res.body.providerFundingVerified, false)
  assert.equal(res.body.canSubmitSponsoredTransfer, false)
  assert.equal(res.body.submissionEnabled, false)
  assert.equal(JSON.stringify(res.body).includes('secret-value'), false)
})

test('GasFree route rejects unknown networks before calling provider', async () => {
  let called = false
  const router = createGasFreeRouter({ getCapabilities: async () => { called = true } })
  const res = responseRecorder()
  await getRoute(router)({ query: { network: 'shasta' } }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.status, 'invalid-network')
  assert.equal(called, false)
})

test('GasFree route distinguishes missing access from a provider failure and never submits', async () => {
  const notConfigured = createGasFreeRouter({ getCapabilities: async () => ({
    configured: false, reachable: false, network: 'mainnet', reason: 'credentials-not-configured',
    requiredEnvironment: ['GASFREE_MAINNET_API_KEY', 'GASFREE_MAINNET_API_SECRET'],
  }) })
  const first = responseRecorder()
  await getRoute(notConfigured)({ query: { network: 'mainnet' } }, first)
  assert.equal(first.statusCode, 503)
  assert.equal(first.body.status, 'not-configured')

  const failed = createGasFreeRouter({ getCapabilities: async () => ({
    configured: true, reachable: false, network: 'nile', reason: 'provider-auth-rejected', providerStatus: 403,
  }) })
  const second = responseRecorder()
  await getRoute(failed)({ query: { network: 'nile' } }, second)
  assert.equal(second.statusCode, 502)
  assert.equal(second.body.status, 'provider-auth-rejected')
})

test('GasFree success route keeps provider funding and transaction submissions unverified', async () => {
  const router = createGasFreeRouter({ getCapabilities: async () => ({
    configured: true, reachable: true, network: 'mainnet', networkLabel: 'TRON Mainnet',
    providerCount: 1, supportedTokenCount: 1, providers: [], tokens: [],
    providerFundingVerified: true, canSubmitSponsoredTransfer: true, submissionEnabled: true,
    feePolicy: 'fees charged in transferred token',
  }) })
  const res = responseRecorder()
  await getRoute(router)({ query: { network: 'mainnet' } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.status, 'provider-capabilities-read')
  assert.equal(res.body.providerFundingVerified, false)
  assert.equal(res.body.canSubmitSponsoredTransfer, false)
  assert.equal(res.body.submissionEnabled, false)
})


test('GasFree account route validates network/address before provider access', async () => {
  let calls = 0
  const router = createGasFreeRouter({
    getAccount: async () => { calls += 1; return { configured: true, reachable: true } },
  })
  const badNetwork = responseRecorder()
  await getRoute(router, '/account')({ query: { network: 'shasta', address: 'T' + 'A'.repeat(33) } }, badNetwork)
  assert.equal(badNetwork.statusCode, 400)
  assert.equal(calls, 0)

  const badAddress = responseRecorder()
  await getRoute(router, '/account')({ query: { network: 'nile', address: 'bad' } }, badAddress)
  assert.equal(badAddress.statusCode, 400)
  assert.equal(badAddress.body.status, 'invalid-address')
  assert.equal(calls, 0)
})

test('GasFree account route exposes only read-only provider metadata and no submission capability', async () => {
  const address = 'T' + 'A'.repeat(33)
  const router = createGasFreeRouter({
    getAccount: async (network, accountAddress) => ({
      configured: true, reachable: true, network, accountLookupVerified: true,
      providerFundingVerified: true,
      canSubmitSponsoredTransfer: true,
      submissionEnabled: true,
      account: {
        accountAddress, gasFreeAddress: 'T' + 'B'.repeat(33),
        active: true, nonce: 4, allowSubmit: true, assets: [],
        chainFinalityVerified: false,
      },
    }),
  })
  const res = responseRecorder()
  await getRoute(router, '/account')({ query: { network: 'nile', address } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.status, 'provider-account-read')
  assert.equal(res.body.account.chainFinalityVerified, false)
  assert.equal(res.body.providerFundingVerified, false)
  assert.equal(res.body.canSubmitSponsoredTransfer, false)
  assert.equal(res.body.submissionEnabled, false)
})

test('GasFree trace route rejects unsafe IDs before provider access', async () => {
  let calls = 0
  const router = createGasFreeRouter({
    getTrace: async () => { calls += 1; return { configured: true, reachable: true } },
  })
  const res = responseRecorder()
  await getRoute(router, '/trace')({ query: { network: 'mainnet', traceId: '../private' } }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.status, 'invalid-trace-id')
  assert.equal(calls, 0)
})

test('GasFree trace route explicitly distinguishes provider state from chain verification', async () => {
  const router = createGasFreeRouter({
    getTrace: async (network, traceId) => ({
      configured: true, reachable: true, network, traceLookupVerified: true,
      providerFundingVerified: true,
      canSubmitSponsoredTransfer: true,
      submissionEnabled: true,
      trace: { traceId, state: 'SUCCEED', transactionId: 'a'.repeat(64), verifiedOnChain: false },
    }),
  })
  const res = responseRecorder()
  await getRoute(router, '/trace')({ query: { network: 'mainnet', traceId: 'trace_1' } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.status, 'provider-trace-read')
  assert.equal(res.body.trace.state, 'SUCCEED')
  assert.equal(res.body.trace.verifiedOnChain, false)
  assert.equal(res.body.providerFundingVerified, false)
  assert.equal(res.body.canSubmitSponsoredTransfer, false)
  assert.equal(res.body.submissionEnabled, false)
})


test('GasFree explicitly refuses sponsored submission without contacting provider or falling back to user funds', async () => {
  let calls = 0
  const router = createGasFreeRouter({
    submitTransfer: async () => { calls += 1; throw new Error('must not be called') },
    getCapabilities: async () => { calls += 1; throw new Error('must not be called') },
  })
  const layer = router.stack.find((item) =>
    item.route?.path === '/submit' && item.route.methods?.post,
  )
  assert.ok(layer, 'POST /submit must be registered')
  const res = responseRecorder()
  await layer.route.stack[0].handle({ body: { network: 'mainnet', amount: '100' } }, res)
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.status, 'sponsored-submission-disabled')
  assert.equal(res.body.enabled, false)
  assert.equal(res.body.providerSubmissionAttempted, false)
  assert.equal(res.body.transactionBroadcast, false)
  assert.equal(res.body.providerFundingVerified, false)
  assert.equal(res.body.externalSponsorConfirmed, false)
  assert.equal(res.body.feePolicyConfirmed, false)
  assert.equal(res.body.canSubmitSponsoredTransfer, false)
  assert.equal(res.body.submissionEnabled, false)
  assert.equal(res.body.unpaidFallbackToUserFunds, false)
  assert.ok(res.body.requiredBeforeEnablement.includes('atomic-separate-fee-and-principal-budget-reservation'))
  assert.equal(calls, 0)
})


test('GasFree trace route persists trace evidence only after independent chain verification', async () => {
  const suppliedTrace = {
    traceId: 'trace_verified_1',
    state: 'SUCCEED',
    transactionId: 'a'.repeat(64),
    tokenAddress: '41' + '4'.repeat(40),
    gasFreeAddress: '41' + '2'.repeat(40),
    receiverAddress: '41' + '3'.repeat(40),
    amountBaseUnits: '12345',
    verifiedOnChain: false,
  }
  let verificationInput = null
  let persistenceInput = null
  const router = createGasFreeRouter({
    getTrace: async (network, traceId) => ({
      configured: true, reachable: true, network, traceLookupVerified: true,
      trace: { ...suppliedTrace, traceId },
    }),
  }, {
    verifyOnChain: async (input) => {
      verificationInput = input
      return {
        verified: true,
        status: 'verified-on-chain',
        txId: 'a'.repeat(64),
        blockNumber: 123,
        tokenContractAddress: '41' + '4'.repeat(40),
        fromAddress: '41' + '2'.repeat(40),
        toAddress: '41' + '3'.repeat(40),
        amountSun: '12345',
        logIndex: 0,
      }
    },
    persistVerifiedTrace: async (input) => {
      persistenceInput = input
      return { persisted: true }
    },
  })
  const res = responseRecorder()
  await getRoute(router, '/trace')({ query: { network: 'nile', traceId: suppliedTrace.traceId } }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(verificationInput.network, 'nile')
  assert.equal(verificationInput.trace.traceId, suppliedTrace.traceId)
  assert.equal(res.body.trace.verifiedOnChain, true)
  assert.equal(res.body.trace.chainVerification.status, 'verified-on-chain')
  assert.deepEqual(res.body.trace.verificationPersistence, { persisted: true })
  assert.equal(persistenceInput.network, 'nile')
  assert.equal(persistenceInput.status, 'verified-on-chain')
  assert.equal(persistenceInput.logIndex, 0)
  assert.equal(res.body.providerFundingVerified, false)
  assert.equal(res.body.canSubmitSponsoredTransfer, false)
  assert.equal(res.body.submissionEnabled, false)
})

test('GasFree trace route never persists or promotes an unverified chain result', async () => {
  let persistCalls = 0
  const router = createGasFreeRouter({
    getTrace: async (network, traceId) => ({
      configured: true, reachable: true, network,
      trace: { traceId, transactionId: 'b'.repeat(64), verifiedOnChain: false },
    }),
  }, {
    verifyOnChain: async () => ({
      verified: false, status: 'not-verified', reason: 'matching-transfer-event-not-found',
    }),
    persistVerifiedTrace: async () => { persistCalls += 1; return { persisted: true } },
  })
  const res = responseRecorder()
  await getRoute(router, '/trace')({ query: { network: 'mainnet', traceId: 'trace_mismatch' } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.trace.verifiedOnChain, false)
  assert.equal(res.body.trace.chainVerification.verified, false)
  assert.deepEqual(res.body.trace.verificationPersistence, { persisted: false, reason: 'transfer-not-verified' })
  assert.equal(persistCalls, 0)
})


test('GasFree trace retry bypasses cache once per refresh window and then throttles repeats', async () => {
  let providerCalls = 0
  const router = createGasFreeRouter({
    getTrace: async (network, traceId) => {
      providerCalls += 1
      return {
        configured: true,
        reachable: true,
        network,
        traceLookupVerified: true,
        trace: {
          traceId,
          state: 'PENDING',
          senderAddress: null,
          gasFreeAddress: null,
          receiverAddress: null,
          providerAddress: null,
          tokenAddress: null,
          transactionId: null,
          verifiedOnChain: false,
          note: 'pending test trace',
        },
      }
    },
  }, {
    verifyOnChain: async () => ({
      verified: false,
      status: 'awaiting-transaction-id',
      reason: 'provider-trace-has-no-transaction-id',
    }),
  })
  const handler = getRoute(router, '/trace')
  const first = responseRecorder()
  await handler({ query: { network: 'nile', traceId: 'trace_retry_1' } }, first)
  assert.equal(first.statusCode, 200)
  assert.equal(providerCalls, 1)

  const forced = responseRecorder()
  await handler({ query: { network: 'nile', traceId: 'trace_retry_1', refresh: '1' } }, forced)
  assert.equal(forced.statusCode, 200)
  assert.equal(providerCalls, 2)

  const throttled = responseRecorder()
  await handler({ query: { network: 'nile', traceId: 'trace_retry_1', refresh: '1' } }, throttled)
  assert.equal(throttled.statusCode, 200)
  assert.equal(providerCalls, 2)
  assert.equal(throttled.body.status, 'provider-trace-read')
  assert.equal(throttled.body.trace.verifiedOnChain, false)
})
