import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../server.js'

const FRONTEND_ORIGIN = 'https://tron-transfer.onrender.com'

test('production Resource API mounts Sponsor readiness and permits Sponsor Admin preflight headers', async t => {
  const server = createServer({
    env: {},
    allowedAddress: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
    readFreeDelegationStatus: async () => ({ success: true }),
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => server.close(resolve)))

  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  const statusResponse = await fetch(baseUrl + '/api/sponsor/status', {
    headers: { origin: FRONTEND_ORIGIN },
  })
  assert.equal(statusResponse.status, 200)
  assert.equal(statusResponse.headers.get('access-control-allow-origin'), FRONTEND_ORIGIN)
  const status = await statusResponse.json()
  assert.equal(status.success, true)
  assert.equal(status.network, 'TRON Mainnet')
  assert.equal(status.transactionExecutionAvailable, false)
  assert.equal(status.databaseReady, false)

  const preflight = await fetch(baseUrl + '/api/sponsor/operations', {
    method: 'OPTIONS',
    headers: {
      origin: FRONTEND_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type,x-sponsor-admin-token,x-csrf-token,x-owner-csrf-token',
    },
  })
  assert.equal(preflight.status, 204)
  const allowedHeaders = preflight.headers.get('access-control-allow-headers') || ''
  assert.match(allowedHeaders, /authorization/i)
  assert.match(allowedHeaders, /content-type/i)
  assert.match(allowedHeaders, /x-sponsor-admin-token/i)
  assert.match(allowedHeaders, /x-csrf-token/i)
  assert.match(allowedHeaders, /x-owner-csrf-token/i)
})
