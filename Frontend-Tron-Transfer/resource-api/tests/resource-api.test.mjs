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


test('legacy external resource-claim and promotion endpoints are not mounted', async (t) => {
  const { createServer } = await import('../server.js')
  const server = createServer({ fetchImpl: async () => { throw new Error('external resource provider must never be called') } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port
  for (const path of [
    '/api/tron/resources/free-delegation/status',
    '/api/tron/resources/free-delegation/tenergy/status',
    '/api/tron/tenergy/promo/status',
    '/api/tron/resources/claims/readiness',
  ]) {
    const response = await fetch(base + path)
    assert.equal(response.status, 404, path + ' must not be exposed')
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
  assert.equal(healthBody.rpc, 'TronGrid Mainnet node API key configured')
  assert.equal(healthBody.rpcNode, 'trongrid')
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

test('Owner and Sponsor session enrollment and CSRF headers are permitted by the Resource API CORS preflight', async (t) => {
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
      'access-control-request-headers': 'authorization, content-type, x-sponsor-enrollment-token, x-owner-csrf-token',
    },
  })
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), origin)
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS')
  const allowedHeaders = response.headers.get('access-control-allow-headers').toLowerCase().split(',').map(value => value.trim())
  assert.ok(allowedHeaders.includes('authorization'))
  assert.ok(allowedHeaders.includes('content-type'))
  assert.ok(allowedHeaders.includes('x-sponsor-enrollment-token'))
  assert.ok(allowedHeaders.includes('x-owner-csrf-token'))
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


test('Mainnet resource endpoint serves cached reads before rate limiting and coalesces concurrent misses', async (t) => {
  const { createServer } = await import('../server.js')
  const address = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
  let providerCalls = 0
  const fetchImpl = async (url) => {
    providerCalls += 1
    await new Promise(resolve => setTimeout(resolve, 15))
    let payload
    if (url.endsWith('/wallet/getaccountresource')) payload = {
      EnergyLimit: 90000, EnergyUsed: 10000,
      NetLimit: 800, NetUsed: 100, freeNetLimit: 600, freeNetUsed: 50,
      TotalEnergyLimit: 180000000000, TotalEnergyWeight: 3000000000,
      TotalNetLimit: 43200000000, TotalNetWeight: 1200000000,
    }
    else if (url.endsWith('/wallet/getaccount')) payload = { address, balance: 123456 }
    else if (url.endsWith('/wallet/getchainparameters')) payload = { chainParameter: [] }
    else throw new Error('unexpected RPC request ' + url)
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const server = createServer({ allowedAddress: address, fetchImpl, env: { TRONGRID_API_KEY: 'test-key' } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/resources/' + address
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => fetch(endpoint)))
  assert.equal(concurrent.every(response => response.status === 200), true)
  const payloads = await Promise.all(concurrent.map(response => response.json()))
  assert.equal(payloads.every(payload => payload.address === address && payload.network === 'TRON Mainnet'), true)
  assert.equal(providerCalls, 3)
  for (let index = 0; index < 45; index += 1) {
    const cached = await fetch(endpoint)
    assert.equal(cached.status, 200)
    const cachedPayload = await cached.json()
    assert.equal(cachedPayload.address, address)
    assert.equal(cachedPayload.network, 'TRON Mainnet')
    assert.ok(cachedPayload.energy && cachedPayload.bandwidth && cachedPayload.networkResourceWeights)
  }
  assert.equal(providerCalls, 3)
})


test('Mainnet provider diagnostics verify Tatum and TronGrid independently without exposing credentials', async (t) => {
  const { createServer } = await import('../server.js')
  const calls = []
  const server = createServer({
    env: { TATUM_API_KEY: 'tatum-test-secret', TATUM_TRON_NETWORK: 'mainnet', TRONGRID_API_KEY: 'trongrid-test-secret' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      const blockNumber = String(url).includes('tatum.io') ? 90000123 : 90000124
      return new Response(JSON.stringify({ blockID: 'a'.repeat(64), block_header: { raw_data: { number: blockNumber } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/mainnet/provider-health')
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.network, 'TRON Mainnet')
  assert.deepEqual(payload.providerPriority, ['tatum', 'trongrid'])
  assert.deepEqual(payload.providers.map(provider => provider.reachable), [true, true])
  assert.deepEqual(payload.providers.map(provider => provider.blockNumber), [90000123, 90000124])
  assert.equal(calls.length, 2)
  assert.ok(calls[0].url.startsWith('https://tron-mainnet.gateway.tatum.io/'))
  assert.equal(calls[0].options.headers['x-api-key'], 'tatum-test-secret')
  assert.ok(calls[1].url.startsWith('https://api.trongrid.io/'))
  assert.equal(calls[1].options.headers['TRON-PRO-API-KEY'], 'trongrid-test-secret')
  assert.equal(JSON.stringify(payload).includes('test-secret'), false)
  const cached = await fetch('http://127.0.0.1:' + server.address().port + '/api/mainnet/provider-health')
  assert.equal(cached.status, 200)
  assert.equal(calls.length, 2)
})


test('HTTP response helper safely ignores duplicate writes after a response is complete', async () => {
  const { send } = await import('../server.js')
  const response = {
    headersSent: true,
    writableEnded: true,
    destroyed: false,
    writeHead() { throw new Error('writeHead must not run for a completed response') },
    end() { throw new Error('end must not run for a completed response') },
  }
  assert.equal(send(response, 500, { error: 'late-error' }), false)
})
