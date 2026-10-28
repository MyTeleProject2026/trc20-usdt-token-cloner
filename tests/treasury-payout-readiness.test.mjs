import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createTreasuryPayoutReadinessRouter } from '../server/routes/treasury-payout-readiness.mjs'

const address = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const token = 'test-admin-token-that-is-long-enough-32chars'

async function withServer(options, run) {
  const app = express()
  app.use('/api', createTreasuryPayoutReadinessRouter(options))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('treasury readiness endpoint rejects missing admin authorization', async () => {
  await withServer({ env: { TREASURY_ADMIN_API_TOKEN: token } }, async (base) => {
    const response = await fetch(base + '/api/treasury/payout-readiness')
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error, 'unauthorized')
  })
})

test('treasury readiness fails closed when no treasury address is configured', async () => {
  await withServer({ env: { TREASURY_ADMIN_API_TOKEN: token } }, async (base) => {
    const response = await fetch(base + '/api/treasury/payout-readiness', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.status, 'treasury-address-not-configured')
    assert.equal(payload.fundingVerified, false)
    assert.equal(payload.transferSubmissionEnabled, false)
  })
})

test('treasury readiness reports actual read-only chain balances but never enables payout submission', async () => {
  const env = {
    TREASURY_ADMIN_API_TOKEN: token,
    TREASURY_MAINNET_ADDRESS: address,
  }
  let observedAddress = ''
  await withServer({
    env,
    tronWebFactory: async () => ({
      isAddress: (value) => value === address,
      trx: { getBalance: async (value) => { observedAddress = value; return '1500000' } },
      contract: (abi, contractAddress) => {
        assert.equal(contractAddress, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
        assert.equal(abi[0].name, 'balanceOf')
        return { balanceOf: (owner) => ({ call: async () => {
          assert.equal(owner, address)
          return '1234567'
        } }) }
      },
    }),
  }, async (base) => {
    const response = await fetch(base + '/api/treasury/payout-readiness', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.status, 'treasury-usdt-balance-verified')
    assert.equal(payload.fundingVerified, true)
    assert.equal(payload.treasuryAddress, address)
    assert.equal(payload.token.balance, '1.234567')
    assert.equal(payload.native.balance, '1.5')
    assert.equal(payload.transferSubmissionEnabled, false)
    assert.equal(observedAddress, address)
  })
})

test('provider failure does not claim funding or authorize a payout', async () => {
  await withServer({
    env: { TREASURY_ADMIN_API_TOKEN: token, TREASURY_MAINNET_ADDRESS: address },
    tronWebFactory: async () => { throw new Error('private provider detail must not leak') },
  }, async (base) => {
    const response = await fetch(base + '/api/treasury/payout-readiness', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const payload = await response.json()
    assert.equal(response.status, 503)
    assert.equal(payload.fundingVerified, false)
    assert.equal(payload.transferSubmissionEnabled, false)
    assert.equal(JSON.stringify(payload).includes('private provider detail'), false)
  })
})
