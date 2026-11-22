import test from 'node:test'
import assert from 'node:assert/strict'
import { isMainnetAddress, summarizeResources } from '../server.js'

test('accepts TRON Base58 addresses and rejects malformed or non-TRON addresses', () => {
  assert.equal(isMainnetAddress('TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'), true)
  assert.equal(isMainnetAddress('0x' + '1'.repeat(40)), false)
  assert.equal(isMainnetAddress('not-a-wallet'), false)
  assert.equal(isMainnetAddress('T' + '0'.repeat(33)), false)
  assert.equal(isMainnetAddress('TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'), true)
  assert.equal(isMainnetAddress('TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'), true)
})

test('calculates free Bandwidth, staked/delegated Bandwidth, and Energy separately', () => {
  const result = summarizeResources({
    freeNetLimit: 600, freeNetUsed: 120,
    NetLimit: 1500, NetUsed: 320,
    EnergyLimit: 100000, EnergyUsed: 25000,
    TotalEnergyLimit: 180000000000, TotalEnergyWeight: 3000000000,
    TotalNetLimit: 43200000000, TotalNetWeight: 1200000000,
  }, { balance: 1234567 }, [
    { key: 'getEnergyFee', value: 100 },
    { key: 'getTransactionFee', value: 1000 },
    { key: 'getMaxFeeLimit', value: 15000000000 },
  ])
  assert.deepEqual(result.bandwidth, {
    freeAvailable: 480, freeLimit: 600, freeUsed: 120,
    stakedOrDelegatedAvailable: 1180, stakedOrDelegatedLimit: 1500,
    stakedOrDelegatedUsed: 320,
    totalAvailable: 1660,
    availableAcrossSeparateTransactions: 1660,
    maxSingleTransactionAvailable: 1180,
    singleTransactionCoverageRule: 'free and staked/delegated Bandwidth are not combined for one transaction; one source must cover the full byte cost',
  })
  assert.deepEqual(result.energy, {
    available: 75000, limit: 100000, used: 25000,
    protocolFreeQuota: 0, source: 'staked-or-delegated',
  })
  assert.equal(result.chainParameters.energyFeeSunPerUnit, 100)
  assert.equal(result.chainParameters.bandwidthFeeSunPerByte, 1000)
  assert.equal(result.chainParameters.maxFeeLimitSun, 15000000000)
  assert.deepEqual(result.networkResourceWeights, { totalEnergyLimit: '180000000000', totalEnergyWeight: '3000000000', totalNetLimit: '43200000000', totalNetWeight: '1200000000' })
  assert.equal(result.freeEnergyAvailable, false)
  assert.equal(result.exactDeploymentEnergyEstimate, null)
})

test('treats omitted protobuf numeric values as zero and never reports negative resources', () => {
  const result = summarizeResources({ EnergyUsed: 1, freeNetUsed: 99, NetUsed: 3 }, {}, [])
  assert.equal(result.energy.available, 0)
  assert.equal(result.bandwidth.freeAvailable, 0)
  assert.equal(result.bandwidth.stakedOrDelegatedAvailable, 0)
  assert.equal(result.balanceSun, '0')
})


test('free-delegation route is Mainnet-wallet restricted and returns injected live status', async (t) => {
  const { createServer } = await import('../server.js')
  const expected = {
    success: true,
    network: 'mainnet',
    status: 'mainnet-resource-snapshot-read',
    address: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
    resourceRead: true,
    policy: { mode: 'free-delegation', walletApprovalRequired: true },
    transactionActions: { unsignedTransactionCreated: false, walletSignatureRequested: false, transactionBroadcast: false },
  }
  let calls = 0
  const server = createServer({
    allowedAddress: expected.address,
    readFreeDelegationStatus: async (address, options) => {
      calls += 1
      assert.equal(address, expected.address)
      assert.equal(options.refresh, true)
      return expected
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port
  const allowed = await fetch(base + '/api/tron/resources/free-delegation/status?address=' + expected.address + '&refresh=1')
  assert.equal(allowed.status, 200)
  assert.deepEqual(await allowed.json(), expected)
  const denied = await fetch(base + '/api/tron/resources/free-delegation/status?address=TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL')
  assert.equal(denied.status, 403)
  assert.equal(calls, 1)
})

test('TEnergy promo routes are Mainnet-only, wallet-restricted, and use a message signature rather than a transaction', async (t) => {
  const { createServer } = await import('../server.js')
  const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    let payload
    if (url.endsWith('/promo')) payload = { network: 'mainnet', state: 'active', left_today: 5, grant: { resource: 'energy', amount: 50000, duration_seconds: 3600 } }
    else if (url.endsWith('/promo/redeem/challenge')) payload = { address, nonce: 'nonce-12345678', message: 'Sign this exact TEnergy promo message' }
    else if (url.endsWith('/promo/redeem')) payload = { address, status: 'granting', energy: 50000, method: 'signature' }
    else if (url.endsWith('/promo/redemptions/' + address)) payload = { address, status: 'delegated', energy: 50000, method: 'signature' }
    else throw new Error('unexpected provider URL ' + url)
    return new Response(JSON.stringify(payload), { status: url.endsWith('/promo/redeem/challenge') || url.endsWith('/promo/redeem') ? 201 : 200, headers: { 'content-type': 'application/json' } })
  }
  const server = createServer({ allowedAddress: address, fetchImpl })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port + '/api/tron/resources/free-delegation/tenergy'
  const challenge = await fetch(base + '/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) })
  assert.equal(challenge.status, 201)
  assert.equal((await challenge.json()).challenge.message, 'Sign this exact TEnergy promo message')
  const redeem = await fetch(base + '/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, nonce: 'nonce-12345678', signature: 'a'.repeat(130) }) })
  assert.equal(redeem.status, 201)
  assert.equal((await redeem.json()).redemption.status, 'granting')
  assert.equal(calls.every(call => call.url.startsWith('https://api.tenergy.me/v1/')), true)
})

test('TEnergy promo routes reject other wallets and malformed signatures before contacting the provider', async (t) => {
  const { createServer } = await import('../server.js')
  const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
  const server = createServer({ allowedAddress: address, fetchImpl: async () => { throw new Error('provider must not be called') } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port + '/api/tron/resources/free-delegation/tenergy/redeem'
  const denied = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL', nonce: 'nonce-12345678', signature: 'a'.repeat(130) }) })
  assert.equal(denied.status, 403)
  const malformed = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, nonce: 'nonce-12345678', signature: 'not-a-signature' }) })
  assert.equal(malformed.status, 400)
})


test('TRӾ deploy-flow TEnergy aliases are served by the production resource API', async (t) => {
  const { createServer } = await import('../server.js')
  const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
  const providerCalls = []
  let redemptionReads = 0
  const fetchImpl = async (url, options = {}) => {
    providerCalls.push({ url, options })
    if (url.endsWith('/promo')) {
      return new Response(JSON.stringify({
        network: 'mainnet', state: 'active', left_today: 5,
        grant: { resource: 'energy', amount: 65000, duration_seconds: 3600 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.endsWith('/promo/redeem/challenge')) {
      return new Response(JSON.stringify({
        address, nonce: 'nonce-12345678', message: 'Sign this exact TEnergy deployment claim.',
        expires_at: new Date(Date.now() + 600000).toISOString(),
      }), { status: 201, headers: { 'content-type': 'application/json' } })
    }
    if (url.endsWith('/promo/redeem')) {
      return new Response(JSON.stringify({
        address, status: 'granting', energy: 65000, method: 'signature',
      }), { status: 201, headers: { 'content-type': 'application/json' } })
    }
    if (url.endsWith('/promo/redemptions/' + address)) {
      redemptionReads += 1
      if (redemptionReads === 1) {
        return new Response(JSON.stringify({ code: 'promo_not_redeemed' }), {
          status: 404, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        address, status: 'delegated', energy: 65000, method: 'signature',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error('unexpected provider URL ' + url)
  }
  const server = createServer({ allowedAddress: address, fetchImpl })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port + '/api/tron/tenergy/promo'
  const status = await fetch(base + '/status?address=' + address)
  assert.equal(status.status, 200)
  const statusBody = await status.json()
  assert.equal(statusBody.promo.state, 'active')
  assert.equal(statusBody.promo.grant.resource, 'energy')
  assert.equal(statusBody.resourceCoverage.bandwidth, false)
  assert.equal(statusBody.resourceCoverage.contractDeploymentFee, false)
  assert.equal(statusBody.requiresOwnerMessageSignature, true)

  const challenge = await fetch(base + '/challenge', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  })
  assert.equal(challenge.status, 201)
  const challengeBody = await challenge.json()
  assert.equal(challengeBody.address, address)
  assert.equal(challengeBody.nonce, 'nonce-12345678')
  assert.equal(challengeBody.message, 'Sign this exact TEnergy deployment claim.')

  const redeem = await fetch(base + '/redeem', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, nonce: 'nonce-12345678', signature: 'a'.repeat(130) }),
  })
  assert.equal(redeem.status, 201)
  assert.equal((await redeem.json()).redemption.status, 'granting')

  const refreshed = await fetch(base + '/status?address=' + address)
  assert.equal(refreshed.status, 200)
  assert.equal((await refreshed.json()).redemption.status, 'delegated')
  assert.ok(providerCalls.every(call => call.url.startsWith('https://api.tenergy.me/v1/')))
})


test('TEnergy promo polling has an independent rate budget from Mainnet resource reads', async (t) => {
  const { createServer } = await import('../server.js')
  const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
  const server = createServer({
    allowedAddress: address,
    readFreeDelegationStatus: async () => ({
      success: true, network: 'mainnet', resourceRead: true,
      inboundDelegations: { records: [] },
    }),
    fetchImpl: async (url) => {
      if (url.endsWith('/promo')) return new Response(JSON.stringify({
        network: 'mainnet', state: 'active', left_today: 5,
        grant: { resource: 'energy', amount: 65000 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.endsWith('/promo/redemptions/' + address)) return new Response('{}', {
        status: 404, headers: { 'content-type': 'application/json' },
      })
      throw new Error('unexpected provider request: ' + url)
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port
  for (let i = 0; i < 20; i += 1) {
    const promo = await fetch(base + '/api/tron/tenergy/promo/status?address=' + address)
    assert.equal(promo.status, 200)
    const resources = await fetch(base + '/api/tron/resources/free-delegation/status?address=' + address)
    assert.equal(resources.status, 200)
  }
})

test('does not treat free and staked Bandwidth as additive for a single transaction', () => {
  const result = summarizeResources({
    freeNetLimit: 600, freeNetUsed: 0,
    NetLimit: 350, NetUsed: 0,
    EnergyLimit: 0, EnergyUsed: 0,
  }, { balance: 0 }, [])
  assert.equal(result.bandwidth.totalAvailable, 950)
  assert.equal(result.bandwidth.availableAcrossSeparateTransactions, 950)
  assert.equal(result.bandwidth.maxSingleTransactionAvailable, 600)
  assert.equal(result.bandwidth.maxSingleTransactionAvailable >= 7000, false)
})


test('Mainnet resource reads use an optional server-side TronGrid API key without exposing it', async (t) => {
  const { createServer } = await import('../server.js')
  const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
  const secret = 'test-server-only-trongrid-key'
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    let payload
    if (url.endsWith('/wallet/getaccountresource')) payload = {
      EnergyLimit: 120000, EnergyUsed: 20000,
      NetLimit: 900, NetUsed: 100, freeNetLimit: 600, freeNetUsed: 50,
    }
    else if (url.endsWith('/wallet/getaccount')) payload = { balance: 0 }
    else if (url.endsWith('/wallet/getchainparameters')) payload = { chainParameter: [
      { key: 'getEnergyFee', value: 100 },
      { key: 'getTransactionFee', value: 1000 },
      { key: 'getMaxFeeLimit', value: 15000000000 },
    ] }
    else throw new Error('unexpected TronGrid URL ' + url)
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const server = createServer({ fetchImpl, env: { TRONGRID_API_KEY: secret } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port
  const health = await fetch(base + '/health')
  const healthBody = await health.json()
  assert.equal(healthBody.rpc, 'TronGrid API key configured')
  assert.equal(JSON.stringify(healthBody).includes(secret), false)
  const response = await fetch(base + '/v1/resources/' + address)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.energy.available, 100000)
  assert.equal(body.bandwidth.maxSingleTransactionAvailable, 800)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(call => call.options.headers['TRON-PRO-API-KEY'] === secret))
  assert.equal(JSON.stringify(body).includes(secret), false)
})


test('TEnergy promo rate limit ignores caller-controlled X-Forwarded-For rotation', async (t) => {
  const { createServer } = await import('../server.js')
  const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
  const server = createServer({
    allowedAddress: address,
    fetchImpl: async (url) => {
      if (url.endsWith('/promo')) return new Response(JSON.stringify({ network: 'mainnet', state: 'active' }), { status: 200 })
      if (url.endsWith('/promo/redemptions/' + address)) return new Response('{}', { status: 404 })
      throw new Error('unexpected provider request: ' + url)
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const url = 'http://127.0.0.1:' + server.address().port + '/api/tron/tenergy/promo/status?address=' + address

  let lastStatus = 0
  for (let i = 0; i < 31; i += 1) {
    const response = await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.' + (i + 1) } })
    lastStatus = response.status
    if (i < 30) assert.equal(response.status, 200)
  }
  assert.equal(lastStatus, 429)
})


test('confirmed Sponsor Wallet transaction history uses TronGrid Mainnet with a bounded limit', async (t) => {
  const { createServer, MAINNET_RPC } = await import('../server.js')
  const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
  const requests = []
  const server = createServer({
    env: { TRONGRID_API_KEY: 'test-public-read-key' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      const isTrc20 = String(url).includes('/transactions/trc20?')
      return { ok: true, status: 200, json: async () => ({ data: [isTrc20 ? { transaction_id: 'b'.repeat(64), from: address, to: address, value: '70000000' } : { txID: 'a'.repeat(64), block_timestamp: 1790000000000 }] }) }
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port
  const response = await fetch(base + '/v1/transactions/' + address + '?limit=20')
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.address, address)
  assert.equal(payload.network, 'TRON Mainnet')
  assert.equal(payload.source, 'trongrid-confirmed-history')
  assert.equal(payload.data[0].txID, 'a'.repeat(64))
  assert.equal(payload.trc20Transfers[0].transaction_id, 'b'.repeat(64))
  assert.equal(payload.trc20Available, true)
  assert.equal(requests.length, 2)
  const parsed = new URL(requests.find((request) => !request.url.includes('/trc20?')).url)
  assert.equal(parsed.origin, MAINNET_RPC)
  assert.equal(parsed.pathname, '/v1/accounts/' + address + '/transactions')
  assert.equal(parsed.searchParams.get('only_confirmed'), 'true')
  assert.equal(parsed.searchParams.get('limit'), '20')
  assert.equal(parsed.searchParams.get('order_by'), 'block_timestamp,desc')
  const tokenRequest = requests.find((request) => request.url.includes('/trc20?'))
  assert.ok(tokenRequest)
  const tokenParsed = new URL(tokenRequest.url)
  assert.equal(tokenParsed.pathname, '/v1/accounts/' + address + '/transactions/trc20')
  assert.equal(tokenParsed.searchParams.get('contract_address'), 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
  assert.equal(tokenParsed.searchParams.get('only_confirmed'), 'true')
  assert.equal(requests[0].options.headers['TRON-PRO-API-KEY'], 'test-public-read-key')
})

test('confirmed Sponsor Wallet transaction history rejects invalid addresses and limits', async (t) => {
  const { createServer } = await import('../server.js')
  const server = createServer({ fetchImpl: async () => { throw new Error('should not call upstream') } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port
  assert.equal((await fetch(base + '/v1/transactions/not-a-wallet')).status, 400)
  assert.equal((await fetch(base + '/v1/transactions/TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp?limit=100')).status, 400)
})

test('Sponsor admin-token header is permitted by the Resource API CORS preflight', async (t) => {
  const { createServer } = await import('../server.js')
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port
  const origin = 'https://tron-transfer.onrender.com'
  const response = await fetch(base + '/api/sponsor/intent', {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type, x-sponsor-admin-token',
    },
  })
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), origin)
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS')
  const allowedHeaders = response.headers.get('access-control-allow-headers').toLowerCase().split(',').map(value => value.trim())
  assert.ok(allowedHeaders.includes('authorization'))
  assert.ok(allowedHeaders.includes('content-type'))
  assert.ok(allowedHeaders.includes('x-sponsor-admin-token'))
})

test('Resource API CORS preflight still rejects an unapproved browser origin', async (t) => {
  const { createServer } = await import('../server.js')
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/sponsor/intent', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://attacker.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type, x-sponsor-admin-token',
    },
  })
  assert.equal(response.status, 403)
})


test('managed wallet identity endpoint exposes public readiness only and never private keys', async (t) => {
  const { createServer } = await import('../server.js')
  const ownerKey = '1'.repeat(64)
  const sponsorKey = '2'.repeat(64)
  const server = createServer({
    allowedAddress: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
    env: {
      TRON_OWNER_PRIVATE_KEY: ownerKey,
      TRON_OWNER_ADDRESS: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
      SPONSOR_MAINNET_PRIVATE_KEY: sponsorKey,
      SPONSOR_MAINNET_ADDRESS: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL',
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/wallets/managed-identities')
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.custody, 'backend-configured-identities')
  assert.equal(payload.signingMode, 'not-migrated')
  assert.equal(payload.privateKeysExposed, false)
  assert.equal(payload.executionEnabled, false)
  assert.equal(payload.passwordEnrollmentAvailable, false)
  const serialized = JSON.stringify(payload)
  assert.equal(serialized.includes(ownerKey), false)
  assert.equal(serialized.includes(sponsorKey), false)
})
