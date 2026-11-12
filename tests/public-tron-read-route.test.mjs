import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import { TronWeb } from 'tronweb'
import { createPublicTronReadRouter } from '../server/routes/public-tron-read.mjs'

const owner = TronWeb.address.fromHex('41' + '1'.repeat(40))
const target = owner
const token = 'A'.repeat(43)
const origin = 'https://tron-transfer.example'

async function withServer(t, router, callback) {
  const app = express()
  app.use('/api/public-tron', router)
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await callback('http://127.0.0.1:' + server.address().port)
}

test('public TRON proxy requires a matching Mainnet owner session before reading', async (t) => {
  let calls = 0
  const router = createPublicTronReadRouter({
    env: { TREASURY_OWNER_ADDRESS: owner },
    getSession: async ({ origin: requestOrigin }) => ({
      success: true, session: { address: owner, network: 'mainnet', origin: requestOrigin },
    }),
    publicClient: {
      async getSolidifiedAccount() { calls++; return { address: target, balanceSun: '123', spendableBalanceOnly: true } },
    },
  })
  await withServer(t, router, async (baseUrl) => {
    const denied = await fetch(baseUrl + '/api/public-tron/account/' + target)
    assert.equal(denied.status, 401)
    assert.equal(calls, 0)
    const allowed = await fetch(baseUrl + '/account/' + target, {
      headers: { Authorization: 'Bearer ' + token, Origin: origin },
    })
    const payload = await allowed.json()
    assert.equal(allowed.status, 200)
    assert.equal(payload.success, true)
    assert.equal(payload.data.balanceSun, '123')
    assert.equal(calls, 1)
  })
})

test('public TRON proxy rejects another wallet session', async (t) => {
  let calls = 0
  const otherAddress = TronWeb.address.fromHex('41' + 'd'.repeat(40))
  const router = createPublicTronReadRouter({
    env: { TREASURY_OWNER_ADDRESS: owner },
    getSession: async ({ origin: requestOrigin }) => ({
      success: true, session: { address: otherAddress, network: 'mainnet', origin: requestOrigin },
    }),
    publicClient: { async getSolidifiedAccount() { calls++; return { balanceSun: '0' } } },
  })
  await withServer(t, router, async (baseUrl) => {
    const response = await fetch(baseUrl + '/account/' + target, {
      headers: { Authorization: 'Bearer ' + token, Origin: origin },
    })
    assert.equal(response.status, 403)
    assert.equal(calls, 0)
  })
})

test('public TRON proxy rejects non-Mainnet sessions', async (t) => {
  const router = createPublicTronReadRouter({
    env: { TREASURY_OWNER_ADDRESS: owner },
    getSession: async ({ origin: requestOrigin }) => ({
      success: true, session: { address: owner, network: 'nile', origin: requestOrigin },
    }),
    publicClient: { async getSolidifiedAccount() { throw new Error('must not read') } },
  })
  await withServer(t, router, async (baseUrl) => {
    const response = await fetch(baseUrl + '/account/' + target, {
      headers: { Authorization: 'Bearer ' + token, Origin: origin },
    })
    assert.equal(response.status, 401)
  })
})

test('owner can discover escrow positions indexed for the Bitpie address using solidified contract reads', async (t) => {
  const requestId = '0x' + 'b'.repeat(64)
  const beneficiaryHex = TronWeb.address.toHex(target).replace(/^41/i, '').toLowerCase()
  const addressWord = '0'.repeat(24) + beneficiaryHex
  const word = (value) => BigInt(value).toString(16).padStart(64, '0')
  const unlockAt = 1900000000n
  const client = {
    async triggerSolidifiedConstantContract({ functionSelector }) {
      if (functionSelector === 'getBeneficiaryPositionCount(address)') return { resultHex: word(1) }
      if (functionSelector === 'getBeneficiaryPositionRequestId(address,uint256)') return { resultHex: 'b'.repeat(64) }
      if (functionSelector === 'getPosition(bytes32)') {
        return { resultHex: addressWord + word(6200000000) + word(unlockAt) + word(0) }
      }
      throw new Error('unexpected constant selector')
    },
  }
  const router = createPublicTronReadRouter({
    env: { TREASURY_OWNER_ADDRESS: owner },
    getSession: async ({ origin: requestOrigin }) => ({
      success: true, session: { address: owner, network: 'mainnet', origin: requestOrigin },
    }),
    publicClient: client,
  })
  await withServer(t, router, async (baseUrl) => {
    const headers = { Authorization: 'Bearer ' + token, Origin: origin }
    const countResponse = await fetch(baseUrl + '/api/public-tron/escrow/' + target + '/beneficiary/' + target + '/count', { headers })
    const countPayload = await countResponse.json()
    assert.equal(countResponse.status, 200)
    assert.equal(countPayload.data.count, '1')
    const idResponse = await fetch(baseUrl + '/escrow/' + target + '/beneficiary/' + target + '/request/0', { headers })
    const idPayload = await idResponse.json()
    assert.equal(idResponse.status, 200)
    assert.equal(idPayload.data.requestId, requestId)
    const positionResponse = await fetch(baseUrl + '/escrow/' + target + '/position/' + requestId, { headers })
    const positionPayload = await positionResponse.json()
    assert.equal(positionResponse.status, 200)
    assert.equal(positionPayload.data.beneficiary, target)
    assert.equal(positionPayload.data.amountSun, '6200000000')
    assert.equal(positionPayload.data.claimed, false)
  })
})
