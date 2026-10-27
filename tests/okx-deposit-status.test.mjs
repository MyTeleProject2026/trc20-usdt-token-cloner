import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import express from 'express'
import { readFile } from 'node:fs/promises'
import { createOkxDepositStatusRouter } from '../server/routes/okx-deposit-status.mjs'

const env = {
  OKX_API_KEY: 'test-okx-api-key-12345',
  OKX_API_SECRET: 'test-okx-api-secret-12345',
  OKX_API_PASSPHRASE: 'test-okx-passphrase-12345',
  OKX_STATUS_ACCESS_TOKEN: 'test-status-access-token-12345',
}
const authorization = `Bearer ${env.OKX_STATUS_ACCESS_TOKEN}`
const fixedNow = new Date('2026-10-27T00:00:00.000Z')

async function withServer({ serverEnv = env, fetchImpl = async () => { throw new Error('unexpected upstream call') } } = {}, run) {
  const app = express()
  app.use('/api/okx', createOkxDepositStatusRouter({
    env: serverEnv,
    fetchImpl,
    now: () => fixedNow,
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    await run(baseUrl)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

function okxResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

async function getJson(url, token = authorization) {
  const response = await fetch(url, {
    headers: token ? { authorization: token } : {},
  })
  return { response, body: await response.json() }
}

test('missing server configuration fails closed and is never cacheable', async () => {
  let upstreamCalls = 0
  await withServer({
    serverEnv: {},
    fetchImpl: async () => { upstreamCalls += 1; return okxResponse({ code: '0', data: [] }) },
  }, async (baseUrl) => {
    const { response, body } = await getJson(`${baseUrl}/api/okx/deposit-status`)
    assert.equal(response.status, 503)
    assert.equal(body.status, 'not-configured')
    assert.match(response.headers.get('cache-control') || '', /no-store/)
  })
  assert.equal(upstreamCalls, 0)
})

test('a missing or incorrect bearer token is rejected before contacting OKX', async () => {
  let upstreamCalls = 0
  await withServer({ fetchImpl: async () => { upstreamCalls += 1; return okxResponse({ code: '0', data: [] }) } }, async (baseUrl) => {
    const withoutToken = await getJson(`${baseUrl}/api/okx/deposit-status`, '')
    assert.equal(withoutToken.response.status, 401)
    assert.equal(withoutToken.body.error, 'unauthorized')

    const wrongToken = await getJson(`${baseUrl}/api/okx/deposit-status`, 'Bearer not-the-token-123456')
    assert.equal(wrongToken.response.status, 401)
    assert.equal(wrongToken.body.error, 'unauthorized')
  })
  assert.equal(upstreamCalls, 0)
})

test('a valid request is HMAC-signed and displays only fields in the real OKX record', async () => {
  let request
  const actualRecord = {
    ccy: 'USDT',
    chain: 'USDT-TRC20',
    amt: '1.250000',
    txId: 'fee235b3e812857d36bb0426917f0df1802',
    to: 'TExampleReceiverAddress',
    state: '1',
    actualDepBlkConfirm: '2',
    ts: '1674038705000',
  }
  await withServer({
    fetchImpl: async (url, init) => {
      request = { url: String(url), ...init }
      return okxResponse({ code: '0', msg: '', data: [actualRecord] })
    },
  }, async (baseUrl) => {
    const query = new URLSearchParams({
      ccy: 'usdt',
      txId: actualRecord.txId,
      limit: '10',
    })
    const { response, body } = await getJson(`${baseUrl}/api/okx/deposit-status?${query}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store, private')
    assert.equal(body.success, true)
    assert.equal(body.exchange, 'OKX')
    assert.equal(body.count, 1)
    assert.equal(body.deposits[0].amount, actualRecord.amt)
    assert.equal(body.deposits[0].transactionId, actualRecord.txId)
    assert.equal(body.deposits[0].statusCode, '1')
    assert.equal(body.deposits[0].status, 'credited-not-withdrawable')
    assert.equal(body.deposits[0].actualDepositBlockchainConfirmed, '2')
    assert.equal(body.deposits[0].recordedAt, actualRecord.ts)
    assert.equal('creditedAt' in body.deposits[0], false)
    assert.equal('balance' in body.deposits[0], false)
    assert.match(body.deposits[0].source, /OKX authenticated/)
    assert.equal(request.method, 'GET')
    assert.equal(request.redirect, 'error')
    assert.ok(request.signal)
    assert.equal(new URL(request.url).origin, 'https://www.okx.com')
    assert.equal(new URL(request.url).pathname, '/api/v5/asset/deposit-history')
    assert.equal(new URL(request.url).searchParams.get('ccy'), 'USDT')
    assert.equal(new URL(request.url).searchParams.get('txId'), actualRecord.txId)

    const requestPath = new URL(request.url).pathname + new URL(request.url).search
    const timestamp = request.headers['OK-ACCESS-TIMESTAMP']
    const expectedSignature = createHmac('sha256', env.OKX_API_SECRET)
      .update(timestamp + 'GET' + requestPath)
      .digest('base64')
    assert.equal(timestamp, fixedNow.toISOString())
    assert.equal(request.headers['OK-ACCESS-KEY'], env.OKX_API_KEY)
    assert.equal(request.headers['OK-ACCESS-PASSPHRASE'], env.OKX_API_PASSPHRASE)
    assert.equal(request.headers['OK-ACCESS-SIGN'], expectedSignature)
  })
})

test('invalid filters fail with 400 without making an upstream request', async () => {
  let upstreamCalls = 0
  await withServer({
    fetchImpl: async () => { upstreamCalls += 1; return okxResponse({ code: '0', data: [] }) },
  }, async (baseUrl) => {
    for (const [query, error] of [
      ['ccy=USDT%2Fbad', 'invalid-currency'],
      ['txId=short', 'invalid-transaction-id'],
      ['limit=101', 'invalid-limit'],
      ['after=not-a-timestamp', 'invalid-after'],
      ['before=123', 'invalid-before'],
    ]) {
      const { response, body } = await getJson(`${baseUrl}/api/okx/deposit-status?${query}`)
      assert.equal(response.status, 400, query)
      assert.equal(body.error, error, query)
    }
  })
  assert.equal(upstreamCalls, 0)
})

test('upstream errors do not expose raw exchange messages or invent a deposit state', async () => {
  await withServer({
    fetchImpl: async () => okxResponse({
      code: '50111',
      msg: 'sensitive provider error detail',
      data: [],
    }),
  }, async (baseUrl) => {
    const { response, body } = await getJson(`${baseUrl}/api/okx/deposit-status`)
    assert.equal(response.status, 502)
    assert.equal(body.success, false)
    assert.equal(body.status, 'exchange-api-error')
    assert.equal(body.upstreamCode, '50111')
    assert.equal(JSON.stringify(body).includes('sensitive provider error detail'), false)
    assert.equal('deposits' in body, false)
  })
})

test('an empty exchange result is represented as zero records, never a synthetic credit', async () => {
  await withServer({
    fetchImpl: async () => okxResponse({ code: '0', msg: '', data: [] }),
  }, async (baseUrl) => {
    const { response, body } = await getJson(`${baseUrl}/api/okx/deposit-status`)
    assert.equal(response.status, 200)
    assert.equal(body.success, true)
    assert.equal(body.count, 0)
    assert.deepEqual(body.deposits, [])
    assert.match(body.note, /missing record is not proof of a failed deposit/i)
  })
})

test('API route remains read-only and server-side credentials are redacted', async () => {
  const route = await readFile(new URL('../server/routes/okx-deposit-status.mjs', import.meta.url), 'utf8')
  const index = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
  const guard = await readFile(new URL('../server/credential-guard.mjs', import.meta.url), 'utf8')

  assert.match(index, /import okxDepositStatusRoutes from '\.\/routes\/okx-deposit-status\.mjs'/)
  assert.match(index, /app\.use\('\/api\/okx', okxDepositStatusRoutes\)/)
  assert.match(route, /\/api\/v5\/asset\/deposit-history/)
  assert.doesNotMatch(route, /\/withdrawal|\/transfer|\bPOST\b|\bPUT\b|\bDELETE\b/i)
  for (const name of ['OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE', 'OKX_STATUS_ACCESS_TOKEN']) {
    assert.match(route, new RegExp(name))
    assert.match(guard, new RegExp(name))
  }
})
