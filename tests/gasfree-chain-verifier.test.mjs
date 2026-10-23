import test from 'node:test'
import assert from 'node:assert/strict'
import { createGasFreeChainVerifier } from '../server/gasfree-chain-verifier.mjs'

const TX_ID = 'a'.repeat(64)
const user = 'T' + 'A'.repeat(33)
const gasFreeAddress = 'T' + 'B'.repeat(33)
const receiver = 'T' + 'C'.repeat(33)
const token = 'T' + 'D'.repeat(33)
const amountBaseUnits = '12345'
const transferTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const hexByAddress = new Map([
  [user, '41' + '1'.repeat(40)],
  [gasFreeAddress, '41' + '2'.repeat(40)],
  [receiver, '41' + '3'.repeat(40)],
  [token, '41' + '4'.repeat(40)],
])
const fakeTronWebFactory = async () => ({
  isAddress: (value) => hexByAddress.has(value),
  address: { toHex: (value) => hexByAddress.get(value) },
})

function providerResponse(payload, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => payload }
}

function makeChainFixtures({ mismatchedReceiver = false } = {}) {
  const fromHex = hexByAddress.get(gasFreeAddress).slice(2)
  const toHex = hexByAddress.get(receiver).slice(2)
  const tokenHex = hexByAddress.get(token)
  return {
    transaction: { txID: TX_ID, ret: [{ contractRet: 'SUCCESS' }] },
    receipt: {
      id: TX_ID,
      blockNumber: 123,
      result: 'SUCCESS',
      receipt: { result: 'SUCCESS' },
      log: [{
        address: tokenHex,
        topics: [
          transferTopic,
          fromHex.padStart(64, '0'),
          (mismatchedReceiver ? '4'.repeat(40) : toHex).padStart(64, '0'),
        ],
        data: BigInt(amountBaseUnits).toString(16).padStart(64, '0'),
      }],
    },
  }
}

function trace(overrides = {}) {
  return {
    transactionId: TX_ID,
    tokenAddress: token,
    gasFreeAddress,
    receiverAddress: receiver,
    amountBaseUnits,
    ...overrides,
  }
}

test('GasFree chain verifier refuses incomplete provider traces without network calls', async () => {
  let calls = 0
  const verify = createGasFreeChainVerifier({
    fetchImpl: async () => { calls += 1; throw new Error('must not call') },
    tronWebFactory: fakeTronWebFactory,
  })
  const result = await verify({ network: 'nile', trace: trace({ receiverAddress: null }) })
  assert.equal(result.verified, false)
  assert.equal(result.status, 'incomplete-provider-trace')
  assert.equal(result.reason, 'required-transfer-fields-missing')
  assert.equal(calls, 0)
})

test('GasFree chain verifier confirms only an exact solidified TRC-20 Transfer event', async () => {
  const fixtures = makeChainFixtures()
  const requested = []
  const verify = createGasFreeChainVerifier({
    env: {},
    tronWebFactory: fakeTronWebFactory,
    fetchImpl: async (url, options) => {
      requested.push({ url, options })
      if (url.endsWith('/walletsolidity/gettransactionbyid')) return providerResponse(fixtures.transaction)
      if (url.endsWith('/walletsolidity/gettransactioninfobyid')) return providerResponse(fixtures.receipt)
      throw new Error('unexpected endpoint')
    },
  })
  const result = await verify({ network: 'nile', trace: trace() })
  assert.equal(result.verified, true)
  assert.equal(result.status, 'verified-on-chain')
  assert.equal(result.txId, TX_ID)
  assert.equal(result.blockNumber, 123)
  assert.equal(result.amountSun, amountBaseUnits)
  assert.equal(result.tokenContractAddress, '4'.repeat(40))
  assert.equal(result.fromAddress, '2'.repeat(40))
  assert.equal(result.toAddress, '3'.repeat(40))
  assert.equal(requested.length, 2)
  assert.ok(requested.every((item) => item.url.startsWith('https://nile.trongrid.io/')))
  assert.ok(requested.every((item) => item.options.method === 'POST'))
  assert.ok(requested.every((item) => !('TRON-PRO-API-KEY' in item.options.headers)))
})

test('GasFree chain verifier rejects a successful receipt with a mismatched Transfer event', async () => {
  const fixtures = makeChainFixtures({ mismatchedReceiver: true })
  const verify = createGasFreeChainVerifier({
    env: {},
    tronWebFactory: fakeTronWebFactory,
    fetchImpl: async (url) => url.endsWith('/walletsolidity/gettransactionbyid')
      ? providerResponse(fixtures.transaction)
      : providerResponse(fixtures.receipt),
  })
  const result = await verify({ network: 'mainnet', trace: trace() })
  assert.equal(result.verified, false)
  assert.equal(result.status, 'not-verified')
  assert.equal(result.reason, 'matching-transfer-event-not-found')
})

test('GasFree chain verifier fails closed when solidified provider is unavailable', async () => {
  const verify = createGasFreeChainVerifier({
    env: { TRONGRID_API_KEY: 'server-only-test-key' },
    tronWebFactory: fakeTronWebFactory,
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers['TRON-PRO-API-KEY'], 'server-only-test-key')
      return providerResponse({}, false)
    },
  })
  const result = await verify({ network: 'mainnet', trace: trace() })
  assert.equal(result.verified, false)
  assert.equal(result.status, 'verification-unavailable')
  assert.equal(result.reason, 'solidified-provider-unavailable')
  assert.equal(JSON.stringify(result).includes('server-only-test-key'), false)
})
