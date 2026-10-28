import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createTreasuryWithdrawalsRouter, parsePositiveDecimal } from '../server/routes/treasury-withdrawals.mjs'

test('USDT decimal parser converts exact six-decimal amounts to base units', () => {
  assert.equal(parsePositiveDecimal('1'), 1_000_000n)
  assert.equal(parsePositiveDecimal('0.000001'), 1n)
  assert.equal(parsePositiveDecimal('12.340500'), 12_340_500n)
})

test('USDT decimal parser rejects zero, excess precision, exponent notation and malformed input', () => {
  for (const value of ['0', '0.0000001', '-1', '+1', '1e3', '01', '.5', '1.', '', ' 1']) {
    assert.equal(parsePositiveDecimal(value), null, value)
  }
})

test('treasury endpoint requires an authenticated owner session before touching treasury configuration', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', createTreasuryWithdrawalsRouter({
    env: {},
    sessionLookup: async () => ({ success: true, session: null }),
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  const response = await fetch(`http://127.0.0.1:${address.port}/api/treasury/withdrawals/readiness`, {
    headers: { origin: 'https://owner.example' },
  })
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { success: false, error: 'owner-auth-required' })
})
