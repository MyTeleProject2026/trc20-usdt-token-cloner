import test from 'node:test'
import assert from 'node:assert/strict'
import { claimTenergyPromoForDeployment } from '../src/trax-mainnet.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const other = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'

function wallet(address = owner) {
  let signCalls = 0
  return {
    address,
    get signCalls() { return signCalls },
    tronWeb: {
      fullNode: { host: 'https://api.trongrid.io' },
      isAddress: value => typeof value === 'string' && value.startsWith('T'),
      address: { toHex: value => value },
      trx: { async signMessageV2() { signCalls += 1; return 'a'.repeat(130) } },
    },
  }
}

function jsonResponse(payload, ok = true) {
  return { ok, async json() { return payload } }
}

test('rejects a different connected wallet before contacting the promotion provider', async () => {
  const connected = wallet(other)
  let fetchCalls = 0
  await assert.rejects(
    claimTenergyPromoForDeployment(connected, owner, {
      fetchImpl: async () => { fetchCalls += 1; return jsonResponse({}) },
      readResources: async () => ({ energyLimit: '0', energyAvailable: '0' }),
    }),
    /restricted to the connected TRӾ owner wallet/,
  )
  assert.equal(fetchCalls, 0)
  assert.equal(connected.signCalls, 0)
})

test('provider code 3038 is treated as permanent ineligibility without a wallet signature', async () => {
  const connected = wallet()
  let fetchCalls = 0
  const fetchImpl = async (url, options = {}) => {
    fetchCalls += 1
    if (String(url).includes('/status?')) {
      return jsonResponse({ success: true, promo: { state: 'active', grant: { resource: 'energy' } }, redemption: null })
    }
    if (String(url).endsWith('/challenge')) {
      assert.equal(options.method, 'POST')
      assert.equal(JSON.parse(options.body).address, owner)
      return jsonResponse({ success: false, code: 3038, retryable: false }, false)
    }
    throw new Error('Unexpected provider request')
  }
  const result = await claimTenergyPromoForDeployment(connected, owner, {
    fetchImpl,
    readResources: async () => ({ energyLimit: '100', energyAvailable: '100' }),
  })
  assert.equal(result.status, 'promo-not-eligible')
  assert.equal(result.providerCode, '3038')
  assert.equal(result.retryable, false)
  assert.equal(result.energyVerified, false)
  assert.equal(connected.signCalls, 0)
  assert.equal(fetchCalls, 2)
})

test('cached permanent ineligibility prevents repeated provider requests and signatures', async () => {
  const connected = wallet()
  let fetchCalls = 0
  const fetchImpl = async (url) => {
    fetchCalls += 1
    if (String(url).includes('/status?')) {
      return jsonResponse({ success: true, promo: { state: 'active', grant: { resource: 'energy' } }, redemption: null })
    }
    if (String(url).endsWith('/challenge')) {
      return jsonResponse({ success: false, code: 3038, retryable: false }, false)
    }
    throw new Error('Unexpected provider request')
  }
  const options = {
    fetchImpl,
    readResources: async () => ({ energyLimit: '100', energyAvailable: '100' }),
  }
  const first = await claimTenergyPromoForDeployment(connected, owner, options)
  const second = await claimTenergyPromoForDeployment(connected, owner, options)
  assert.equal(first.status, 'promo-not-eligible')
  assert.equal(second.status, 'promo-not-eligible')
  assert.equal(fetchCalls, 2)
  assert.equal(connected.signCalls, 0)
})
