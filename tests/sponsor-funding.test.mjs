import test from 'node:test'
import assert from 'node:assert/strict'
import { createSponsorFundingReader } from '../server/sponsor-funding.mjs'

const sponsorAddress = 'T' + 'A'.repeat(33)
const tokenAddress = 'T' + 'B'.repeat(33)
const hex = 'a'.repeat(40)

function fakeTronWeb(host) {
  assert.match(host, /^https:\/\/tron-(mainnet|shasta|nile)\.gateway\.tatum\.io$/)
  return {
    isAddress(value) { return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value) },
    address: { toHex(value) { return '41' + (value === sponsorAddress ? hex : 'b'.repeat(40)) } },
  }
}

test('sponsor funding read is fail-closed when no network-specific address is configured', async () => {
  const reader = createSponsorFundingReader({ env: {}, fetchImpl: async () => { throw new Error('must not call') } })
  const result = await reader('nile')
  assert.equal(result.status, 'sponsor-address-not-configured')
  assert.deepEqual(result.requiredEnvironment, ['SPONSOR_NILE_ADDRESS'])
  assert.equal(result.onChainBalanceRead, false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
})

test('sponsor funding read requires server-side Tatum credentials', async () => {
  const reader = createSponsorFundingReader({
    env: { SPONSOR_NILE_ADDRESS: sponsorAddress },
    fetchImpl: async () => { throw new Error('must not call') },
  })
  const result = await reader('nile')
  assert.equal(result.status, 'provider-credentials-missing')
  assert.deepEqual(result.requiredEnvironment, ['TATUM_API_KEY'])
  assert.equal(result.sponsorFundingVerified, false)
})

test('testnet sponsor funding reads native TRX only and ignores testnet token lookalikes', async () => {
  const requests = []
  const env = {
    TATUM_API_KEY: 'server-test-key',
    SPONSOR_NILE_ADDRESS: sponsorAddress,
  }
  const reader = createSponsorFundingReader({
    env,
    tronWebFactory: async (host) => fakeTronWeb(host),
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      if (url.endsWith('/walletsolidity/getaccount')) {
        return { ok: true, json: async () => ({ address: '41' + hex, balance: 1234567 }) }
      }
      throw new Error('unexpected URL')
    },
  })
  const result = await reader('nile')
  assert.equal(result.status, 'solidified-sponsor-balances-read')
  assert.equal(result.native.balanceSun, '1234567')
  assert.equal(result.native.balanceTRX, '1.234567')
  assert.equal(result.tokens.length, 0)
  assert.equal(result.tokenBalancesComplete, true)
  assert.equal(result.sponsorFundingVerified, false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.submissionEnabled, false)
  assert.ok(requests.every(({ options }) => options.headers['x-api-key'] === 'server-test-key'))
  assert.equal(JSON.stringify(result).includes('server-test-key'), false)
  assert.ok(requests.every(({ url }) => url.startsWith('https://tron-nile.gateway.tatum.io/')))

  const requestsAfterFreshRead = requests.length
  const cached = await reader('nile')
  assert.equal(cached.cache.status, 'cached')
  assert.equal(cached.native.balanceSun, '1234567')
  assert.equal(requests.length, requestsAfterFreshRead, 'fresh snapshot should avoid duplicate provider calls')

  const forcedRefresh = await reader('nile', { refresh: true })
  assert.equal(forcedRefresh.cache.status, 'fresh')
  assert.equal(forcedRefresh.native.balanceSun, '1234567')
  assert.ok(requests.length > requestsAfterFreshRead, 'explicit refresh should bypass a successful cache once')
  const afterForceRefresh = requests.length
  const throttledRefresh = await reader('nile', { refresh: true })
  assert.equal(throttledRefresh.cache.status, 'refresh-throttled')
  assert.equal(throttledRefresh.cache.refreshThrottled, true)
  assert.equal(requests.length, afterForceRefresh, 'repeated forced refreshes should not multiply provider calls')
})

test('sponsor funding read rejects invalid networks and ignores testnet token allowlists', async () => {
  const reader = createSponsorFundingReader({
    env: {
      TATUM_API_KEY: 'server-test-key',
      SPONSOR_NILE_ADDRESS: sponsorAddress,
      SPONSOR_VTRC_NILE_CONTRACTS: 'not-an-address',
    },
    tronWebFactory: async (host) => fakeTronWeb(host),
    fetchImpl: async () => ({ ok: true, json: async () => ({ address: '41' + hex, balance: 0 }) }),
  })
  assert.equal((await reader('shasta')).status, 'sponsor-address-not-configured')
  const invalidNetwork = await reader('attacker')
  assert.equal(invalidNetwork.status, 'invalid-network')
  const malformed = await reader('nile')
  assert.equal(malformed.status, 'solidified-sponsor-balances-read')
  assert.equal(malformed.tokens.length, 0)
  assert.equal(malformed.tokenBalancesComplete, true)
  assert.equal(malformed.sponsorFundingVerified, false)
  assert.equal(malformed.canSubmitSponsoredTransfer, false)
})

test('official Mainnet USDT funding read does not treat a failed token query as a zero balance', async () => {
  const reader = createSponsorFundingReader({
    env: { TATUM_API_KEY: 'server-test-key', SPONSOR_MAINNET_ADDRESS: sponsorAddress },
    tronWebFactory: async (host) => fakeTronWeb(host),
    fetchImpl: async (url) => {
      if (url.endsWith('/walletsolidity/getaccount')) return { ok: true, json: async () => ({ address: '41' + hex, balance: 0 }) }
      return { ok: false, status: 503 }
    },
  })
  const result = await reader('mainnet')
  assert.equal(result.native.balanceSun, '0')
  assert.equal(result.tokens[0].status, 'unavailable')
  assert.equal(Object.hasOwn(result.tokens[0], 'balanceBaseUnits'), false)
  assert.equal(result.tokenBalancesComplete, false)
})


test('sponsor funding reader rejects a native balance response for a different sponsor address', async () => {
  const reader = createSponsorFundingReader({
    env: { TATUM_API_KEY: 'server-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress },
    tronWebFactory: async (host) => fakeTronWeb(host),
    fetchImpl: async (url) => {
      assert.ok(url.endsWith('/walletsolidity/getaccount'))
      return { ok: true, json: async () => ({ address: '41' + 'c'.repeat(40), balance: '999999999' }) }
    },
  })
  const result = await reader('nile')
  assert.equal(result.status, 'solidified-balance-read-failed')
  assert.equal(result.onChainBalanceRead, false)
  assert.equal(Object.hasOwn(result, 'native'), false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
})

test('sponsorship funding HTTP route is read-only and reports missing sponsor address without querying a provider', async () => {
  const nativeTronRoutes = (await import('../server/routes/native-tron.mjs')).default
  const layer = nativeTronRoutes.stack.find((item) =>
    item.route?.path === '/sponsorship/funding-status' && item.route.methods?.get,
  )
  assert.ok(layer, 'GET /sponsorship/funding-status route must be registered')

  const savedAddress = process.env.SPONSOR_NILE_ADDRESS
  const savedKey = process.env.TATUM_API_KEY
  delete process.env.SPONSOR_NILE_ADDRESS
  delete process.env.TATUM_API_KEY
  try {
    let statusCode = 200
    let responseBody
    const responseHeaders = {}
    const response = {
      status(code) { statusCode = code; return this },
      setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; return this },
      json(body) { responseBody = body; return this },
    }
    await layer.route.stack[0].handle({ query: { network: 'nile' } }, response)
    assert.equal(statusCode, 503)
    assert.equal(responseHeaders['cache-control'], 'no-store')
    assert.equal(responseHeaders.pragma, 'no-cache')
    assert.equal(responseBody.success, false)
    assert.equal(responseBody.funding.status, 'sponsor-address-not-configured')
    assert.equal(responseBody.funding.onChainBalanceRead, false)
    assert.equal(responseBody.funding.canSubmitSponsoredTransfer, false)
    assert.ok(responseBody.limitations.some((item) => item.includes('never is signed') || item.includes('never signed') || item.includes('No transfer is signed')))

    statusCode = 200
    responseBody = null
    await layer.route.stack[0].handle({ query: { network: 'nile', refresh: 'true' } }, response)
    assert.equal(statusCode, 400)
    assert.equal(responseBody.error, 'invalid-refresh')
  } finally {
    if (savedAddress === undefined) delete process.env.SPONSOR_NILE_ADDRESS
    else process.env.SPONSOR_NILE_ADDRESS = savedAddress
    if (savedKey === undefined) delete process.env.TATUM_API_KEY
    else process.env.TATUM_API_KEY = savedKey
  }
})


test('sponsor funding reader pins Mainnet USDT snapshots to the official Tether TRON contract', async () => {
  const requests = []
  const reader = createSponsorFundingReader({
    env: {
      TATUM_API_KEY: 'server-test-key',
      SPONSOR_MAINNET_ADDRESS: sponsorAddress,
      // Even a user-supplied different contract must not redefine official Mainnet USDT.
      SPONSOR_USDT_MAINNET_CONTRACTS: tokenAddress,
    },
    tronWebFactory: async (host) => fakeTronWeb(host),
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      if (url.endsWith('/walletsolidity/getaccount')) {
        return { ok: true, json: async () => ({ address: '41' + hex, balance: 0 }) }
      }
      const body = JSON.parse(options.body)
      const isDecimals = body.function_selector === 'decimals()'
      return { ok: true, json: async () => ({
        result: { result: true },
        constant_result: [(isDecimals ? 6n : 0n).toString(16).padStart(64, '0')],
      }) }
    },
  })
  const result = await reader('mainnet')
  assert.equal(result.status, 'solidified-sponsor-balances-read')
  assert.equal(result.tokens.length, 1)
  assert.equal(result.tokens[0].asset, 'USDT')
  assert.equal(result.tokens[0].tokenContract, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
  const tokenRead = requests.find(({ url }) => url.endsWith('/walletsolidity/triggerconstantcontract'))
  assert.ok(tokenRead)
  assert.equal(JSON.parse(tokenRead.options.body).contract_address.toLowerCase().startsWith('41'), true)
  assert.notEqual(result.tokens[0].tokenContract, tokenAddress)
})


test('sponsor budget ledger endpoint rejects unconfigured and invalid admin tokens', async () => {
  const nativeTronRoutes = (await import('../server/routes/native-tron.mjs')).default
  const layer = nativeTronRoutes.stack.find((item) =>
    item.route?.path === '/sponsorship/budgets' && item.route.methods?.get,
  )
  assert.ok(layer, 'GET /sponsorship/budgets route must be registered')

  const savedToken = process.env.SPONSOR_ADMIN_API_TOKEN
  try {
    delete process.env.SPONSOR_ADMIN_API_TOKEN
    let statusCode = 200
    let responseBody
    const response = {
      status(code) { statusCode = code; return this },
      json(body) { responseBody = body; return this },
    }
    await layer.route.stack[0].handle({ query: {}, headers: {} }, response)
    assert.equal(statusCode, 503)
    assert.equal(responseBody.error, 'sponsor-admin-not-configured')
    assert.equal(Object.hasOwn(responseBody, 'budgets'), false)

    process.env.SPONSOR_ADMIN_API_TOKEN = 'x'.repeat(40)
    statusCode = 200
    responseBody = null
    await layer.route.stack[0].handle({ query: {}, headers: { authorization: 'Bearer incorrect-token' } }, response)
    assert.equal(statusCode, 401)
    assert.equal(responseBody.error, 'unauthorized')
    assert.equal(Object.hasOwn(responseBody, 'budgets'), false)

    // The token must be checked before input validation or database access.
    statusCode = 200
    responseBody = null
    await layer.route.stack[0].handle({ query: { network: 'attacker' }, headers: { authorization: 'Bearer ' + process.env.SPONSOR_ADMIN_API_TOKEN } }, response)
    assert.equal(statusCode, 400)
    assert.equal(responseBody.error, 'invalid-network')
  } finally {
    if (savedToken === undefined) delete process.env.SPONSOR_ADMIN_API_TOKEN
    else process.env.SPONSOR_ADMIN_API_TOKEN = savedToken
  }
})


test('sponsor budget draft and listing routes require the server-only admin token', async () => {
  const nativeTronRoutes = (await import('../server/routes/native-tron.mjs')).default
  const findRoute = (path, method) => nativeTronRoutes.stack.find((item) =>
    item.route?.path === path && item.route.methods?.[method],
  )
  const draftLayer = findRoute('/sponsorship/budgets', 'post')
  const listLayer = findRoute('/sponsorship/budgets', 'get')
  const pauseLayer = findRoute('/sponsorship/budgets/:id/pause', 'post')
  const activateLayer = findRoute('/sponsorship/budgets/:id/activate', 'post')
  assert.ok(draftLayer, 'POST /sponsorship/budgets must be registered')
  assert.ok(listLayer, 'GET /sponsorship/budgets must be registered')
  assert.ok(pauseLayer, 'POST /sponsorship/budgets/:id/pause must be registered')
  assert.ok(activateLayer, 'POST /sponsorship/budgets/:id/activate must be registered')

  const saved = {
    token: process.env.SPONSOR_ADMIN_API_TOKEN,
    nileAddress: process.env.SPONSOR_NILE_ADDRESS,
    agreementReferences: process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES,
    mainnetActivation: process.env.SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED,
  }
  const response = () => {
    let statusCode = 200
    let responseBody
    const responseHeaders = {}
    return {
      status(code) { statusCode = code; return this },
      setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; return this },
      json(body) { responseBody = body; return this },
      get statusCode() { return statusCode },
      get responseBody() { return responseBody },
      get responseHeaders() { return responseHeaders },
    }
  }

  try {
    delete process.env.SPONSOR_ADMIN_API_TOKEN
    const draftMissing = response()
    await draftLayer.route.stack[0].handle({ headers: {}, body: { network: 'nile' } }, draftMissing)
    assert.equal(draftMissing.statusCode, 503)
    assert.equal(draftMissing.responseBody.error, 'sponsor-admin-not-configured')
    assert.equal(draftMissing.responseHeaders['cache-control'], 'no-store')
    assert.equal(draftMissing.responseHeaders.vary, 'Authorization')

    const listMissing = response()
    await listLayer.route.stack[0].handle({ headers: {}, query: {} }, listMissing)
    assert.equal(listMissing.statusCode, 503)
    assert.equal(listMissing.responseBody.error, 'sponsor-admin-not-configured')
    assert.equal(listMissing.responseHeaders['cache-control'], 'no-store')
    assert.equal(listMissing.responseHeaders.vary, 'Authorization')

    const activateMissing = response()
    await activateLayer.route.stack[0].handle({
      headers: {}, params: { id: '1' },
      body: { consentReference: 'agreement-test-001', reviewReference: 'review-ticket-001' },
    }, activateMissing)
    assert.equal(activateMissing.statusCode, 503)
    assert.equal(activateMissing.responseBody.error, 'sponsor-admin-not-configured')
    assert.equal(activateMissing.responseHeaders['cache-control'], 'no-store')

    process.env.SPONSOR_ADMIN_API_TOKEN = 'y'.repeat(40)
    const unauthorized = response()
    await draftLayer.route.stack[0].handle({
      headers: { authorization: 'Bearer wrong-token' },
      body: { network: 'nile' },
    }, unauthorized)
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(unauthorized.responseBody.error, 'unauthorized')

    delete process.env.SPONSOR_NILE_ADDRESS
    const noAddress = response()
    await draftLayer.route.stack[0].handle({
      headers: { authorization: 'Bearer ' + process.env.SPONSOR_ADMIN_API_TOKEN },
      body: {
        network: 'nile',
        sponsorReference: 'review-only',
        purpose: 'asset-grant',
        asset: 'TRX',
        budgetBaseUnits: '1000000',
      },
    }, noAddress)
    assert.equal(noAddress.statusCode, 503)
    assert.equal(noAddress.responseBody.error, 'sponsor-address-not-configured')
    assert.equal(noAddress.responseBody.canReserve, undefined)

    delete process.env.SPONSOR_NILE_ADDRESS
    const pauseMissingToken = response()
    await pauseLayer.route.stack[0].handle({
      headers: {}, params: { id: '1' }, body: { reasonCode: 'emergency-stop' },
    }, pauseMissingToken)
    assert.equal(pauseMissingToken.statusCode, 401)
    assert.equal(pauseMissingToken.responseBody.error, 'unauthorized')
    assert.equal(pauseMissingToken.responseHeaders['cache-control'], 'no-store')
    assert.equal(pauseMissingToken.responseHeaders.vary, 'Authorization')

    const invalidPauseId = response()
    await pauseLayer.route.stack[0].handle({
      headers: { authorization: 'Bearer ' + process.env.SPONSOR_ADMIN_API_TOKEN },
      params: { id: '0' }, body: { reasonCode: 'emergency-stop' },
    }, invalidPauseId)
    assert.equal(invalidPauseId.statusCode, 400)
    assert.equal(invalidPauseId.responseBody.error, 'invalid-budget-id')

    const invalidPauseReason = response()
    await pauseLayer.route.stack[0].handle({
      headers: { authorization: 'Bearer ' + process.env.SPONSOR_ADMIN_API_TOKEN },
      params: { id: '1' }, body: { reasonCode: 'pay-anything' },
    }, invalidPauseReason)
    assert.equal(invalidPauseReason.statusCode, 400)
    assert.equal(invalidPauseReason.responseBody.error, 'invalid-pause-reason')

    process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = 'signed-agreement-allowed'
    const unapprovedAgreement = response()
    await activateLayer.route.stack[0].handle({
      headers: { authorization: 'Bearer ' + process.env.SPONSOR_ADMIN_API_TOKEN },
      params: { id: '1' },
      body: { consentReference: 'agreement-not-approved', reviewReference: 'review-ticket-001' },
    }, unapprovedAgreement)
    assert.equal(unapprovedAgreement.statusCode, 403)
    assert.equal(unapprovedAgreement.responseBody.error, 'agreement-reference-not-approved')
    assert.equal(unapprovedAgreement.responseHeaders['cache-control'], 'no-store')
    assert.equal(unapprovedAgreement.responseHeaders.vary, 'Authorization')
  } finally {
    if (saved.token === undefined) delete process.env.SPONSOR_ADMIN_API_TOKEN
    else process.env.SPONSOR_ADMIN_API_TOKEN = saved.token
    if (saved.nileAddress === undefined) delete process.env.SPONSOR_NILE_ADDRESS
    else process.env.SPONSOR_NILE_ADDRESS = saved.nileAddress
    if (saved.agreementReferences === undefined) delete process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
    else process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = saved.agreementReferences
    if (saved.mainnetActivation === undefined) delete process.env.SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED
    else process.env.SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED = saved.mainnetActivation
  }
})


test('sponsor funding reader rejects official USDT decimal mismatch', async () => {
  const reader = createSponsorFundingReader({
    env: { TATUM_API_KEY: 'server-test-key', SPONSOR_MAINNET_ADDRESS: sponsorAddress },
    tronWebFactory: async (host) => fakeTronWeb(host),
    fetchImpl: async (url, options) => {
      if (url.endsWith('/walletsolidity/getaccount')) {
        return { ok: true, json: async () => ({ address: '41' + hex, balance: 0 }) }
      }
      const isDecimals = JSON.parse(options.body).function_selector === 'decimals()'
      return { ok: true, json: async () => ({
        result: { result: true },
        constant_result: [(isDecimals ? 18n : 0n).toString(16).padStart(64, '0')],
      }) }
    },
  })
  const result = await reader('mainnet')
  assert.equal(result.status, 'solidified-sponsor-balances-read')
  assert.equal(result.tokens.length, 1)
  assert.equal(result.tokens[0].status, 'unavailable')
  assert.equal(Object.hasOwn(result.tokens[0], 'balanceBaseUnits'), false)
})


test('sponsor funding reader rejects imprecise JSON numeric balances', async () => {
  const reader = createSponsorFundingReader({
    env: { TATUM_API_KEY: 'server-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress },
    tronWebFactory: async (host) => fakeTronWeb(host),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ address: '41' + hex, balance: Number.MAX_SAFE_INTEGER + 2 }),
    }),
  })
  const result = await reader('nile')
  assert.equal(result.status, 'solidified-balance-read-failed')
  assert.equal(result.onChainBalanceRead, false)
  assert.equal(Object.hasOwn(result, 'native'), false)
})

test('sponsor funding reader briefly caches provider failures to avoid retry storms', async () => {
  let calls = 0
  const reader = createSponsorFundingReader({
    env: { TATUM_API_KEY: 'server-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress },
    tronWebFactory: async (host) => fakeTronWeb(host),
    fetchImpl: async () => {
      calls += 1
      return { ok: false, status: 503 }
    },
  })
  const first = await reader('nile')
  assert.equal(first.status, 'solidified-balance-read-failed')
  assert.equal(first.cache.status, 'fresh')
  const second = await reader('nile')
  assert.equal(second.status, 'solidified-balance-read-failed')
  assert.equal(second.cache.status, 'cached')
  assert.equal(calls, 1, 'recent provider errors should be briefly cached instead of retried for every caller')
})


test('sponsor reconciliation endpoint is protected and refuses missing chain evidence', async () => {
  const nativeTronRoutes = (await import('../server/routes/native-tron.mjs')).default
  const layer = nativeTronRoutes.stack.find((item) =>
    item.route?.path === '/sponsorship/reconciliation' && item.route.methods?.get,
  )
  assert.ok(layer, 'GET /sponsorship/reconciliation must be registered')

  const keys = ['SPONSOR_ADMIN_API_TOKEN', 'SPONSOR_NILE_ADDRESS', 'TATUM_API_KEY']
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  let statusCode = 200
  let responseBody
  const headers = {}
  const response = {
    status(code) { statusCode = code; return this },
    setHeader(name, value) { headers[name.toLowerCase()] = value; return this },
    json(body) { responseBody = body; return this },
  }
  try {
    for (const key of keys) delete process.env[key]
    await layer.route.stack[0].handle({ query: { network: 'nile' }, headers: {} }, response)
    assert.equal(statusCode, 503)
    assert.equal(responseBody.error, 'sponsor-admin-not-configured')
    assert.equal(headers['cache-control'], 'no-store')
    assert.equal(headers.vary, 'Authorization')

    process.env.SPONSOR_ADMIN_API_TOKEN = 'z'.repeat(40)
    statusCode = 200
    responseBody = null
    await layer.route.stack[0].handle({
      query: { network: 'nile' },
      headers: { authorization: 'Bearer wrong-token' },
    }, response)
    assert.equal(statusCode, 401)
    assert.equal(responseBody.error, 'unauthorized')

    statusCode = 200
    responseBody = null
    await layer.route.stack[0].handle({
      query: { network: 'attacker' },
      headers: { authorization: 'Bearer ' + process.env.SPONSOR_ADMIN_API_TOKEN },
    }, response)
    assert.equal(statusCode, 400)
    assert.equal(responseBody.error, 'invalid-network')

    delete process.env.SPONSOR_NILE_ADDRESS
    delete process.env.TATUM_API_KEY
    statusCode = 200
    responseBody = null
    await layer.route.stack[0].handle({
      query: { network: 'nile' },
      headers: { authorization: 'Bearer ' + process.env.SPONSOR_ADMIN_API_TOKEN },
    }, response)
    assert.equal(statusCode, 503)
    assert.equal(responseBody.success, false)
    assert.equal(responseBody.error, 'fresh-sponsor-balance-unavailable')
    assert.notEqual(responseBody.reconciliation?.status, 'covered')
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})


test('protected sponsor transfer history route is read-only and validates filters', async () => {
  const nativeTronRoutes = (await import('../server/routes/native-tron.mjs')).default
  const layer = nativeTronRoutes.stack.find((item) =>
    item.route?.path === '/sponsorship/transfers' && item.route.methods?.get,
  )
  assert.ok(layer, 'GET /sponsorship/transfers must be registered')
  const savedToken = process.env.SPONSOR_ADMIN_API_TOKEN
  const makeResponse = () => {
    let statusCode = 200
    let body
    const headers = {}
    return {
      status(code) { statusCode = code; return this },
      json(value) { body = value; return this },
      setHeader(name, value) { headers[name] = value },
      get statusCode() { return statusCode },
      get body() { return body },
      headers,
    }
  }
  try {
    delete process.env.SPONSOR_ADMIN_API_TOKEN
    let res = makeResponse()
    await layer.route.stack[0].handle({ headers: {}, query: {} }, res)
    assert.equal(res.statusCode, 503)
    assert.equal(res.body.error, 'sponsor-admin-not-configured')
    assert.equal(res.headers['Cache-Control'], 'no-store')

    process.env.SPONSOR_ADMIN_API_TOKEN = 'z'.repeat(40)
    res = makeResponse()
    await layer.route.stack[0].handle({ headers: { authorization: 'Bearer wrong-token' }, query: {} }, res)
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.error, 'unauthorized')

    res = makeResponse()
    await layer.route.stack[0].handle({
      headers: { authorization: 'Bearer ' + process.env.SPONSOR_ADMIN_API_TOKEN },
      query: { status: 'unverified' },
    }, res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error, 'invalid-status')

    res = makeResponse()
    await layer.route.stack[0].handle({
      headers: { authorization: 'Bearer ' + process.env.SPONSOR_ADMIN_API_TOKEN },
      query: { limit: '101' },
    }, res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error, 'invalid-limit')
  } finally {
    if (savedToken === undefined) delete process.env.SPONSOR_ADMIN_API_TOKEN
    else process.env.SPONSOR_ADMIN_API_TOKEN = savedToken
  }
})
