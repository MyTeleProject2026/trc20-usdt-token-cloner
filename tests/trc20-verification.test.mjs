import test from 'node:test'
import assert from 'node:assert/strict'
import { createTRC20VerificationRouter } from '../server/routes/trc20-verification.mjs'

const sender = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const receiver = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const mainnetUsdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const transactionId = 'ab'.repeat(32)
const senderHex = '41' + '11'.repeat(20)
const receiverHex = '41' + '22'.repeat(20)
const tokenHex = '41' + '33'.repeat(20)
const amountBaseUnits = '100'
const amountHex = BigInt(amountBaseUnits).toString(16).padStart(64, '0')
const eventTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function fakeTronWeb() {
  const addresses = new Map([
    [sender, senderHex],
    [receiver, receiverHex],
    [mainnetUsdt, tokenHex],
  ])
  return {
    isAddress(value) { return addresses.has(value) },
    address: {
      toHex(value) { return addresses.get(value) || '' },
    },
  }
}

function makeTransaction({ contractHexValue = tokenHex, ownerHex = senderHex, selector = 'a9059cbb', toBytes = '22'.repeat(20), amountHexValue = amountHex, success = true } = {}) {
  const calldata = selector + '0'.repeat(24) + toBytes + amountHexValue
  return {
    txID: transactionId,
    raw_data: {
      contract: [{
        type: 'TriggerSmartContract',
        parameter: { value: { owner_address: ownerHex, contract_address: contractHexValue, data: calldata } },
      }],
    },
    ret: [{ contractRet: success ? 'SUCCESS' : 'REVERT' }],
  }
}

function makeReceipt({ logAddress = tokenHex, fromBytes = '11'.repeat(20), toBytes = '22'.repeat(20), amountHexValue = amountHex, success = true, includeId = true } = {}) {
  return {
    ...(includeId ? { id: transactionId } : {}),
    blockNumber: 123,
    blockTimeStamp: 1720000000000,
    receipt: { result: success ? 'SUCCESS' : 'FAILED' },
    log: [{
      address: logAddress,
      topics: [
        eventTopic,
        '0'.repeat(24) + fromBytes,
        '0'.repeat(24) + toBytes,
      ],
      data: amountHexValue,
    }],
  }
}

function createTestRouter({ transaction, receipt } = {}) {
  const requests = []
  const persistenceCalls = []
  const router = createTRC20VerificationRouter({
    env: {},
    tronWebFactory: async () => fakeTronWeb(),
    persistVerification: async (input) => {
      persistenceCalls.push(input)
      return { persisted: true }
    },
    fetchImpl: async (url) => {
      requests.push(url)
      const isTransaction = url.endsWith('/walletsolidity/gettransactionbyid')
      const payload = isTransaction ? (transaction ?? makeTransaction()) : (receipt ?? makeReceipt())
      return { ok: true, json: async () => payload }
    },
  })
  return { router, requests, persistenceCalls }
}

async function invoke(router, query, hash = transactionId) {
  const layer = router.stack.find((item) =>
    item.route?.path === '/verify-trc20-transfer/:hash' && item.route.methods?.get,
  )
  assert.ok(layer, 'verification endpoint should be registered')
  let statusCode = 200
  let payload
  const headers = {}
  const response = {
    setHeader(name, value) { headers[name.toLowerCase()] = value; return this },
    status(code) { statusCode = code; return this },
    json(value) { payload = value; return this },
  }
  await layer.route.stack[0].handle({ params: { hash }, query }, response)
  return { statusCode, payload, headers }
}

function validQuery(overrides = {}) {
  return {
    network: 'mainnet',
    contract: mainnetUsdt,
    from: sender,
    to: receiver,
    amountBaseUnits,
    ...overrides,
  }
}

test('verifies a direct TRC-20 transfer against the matching solidified event and persists exact evidence', async () => {
  const { router, requests, persistenceCalls } = createTestRouter()
  const result = await invoke(router, validQuery())
  assert.equal(result.statusCode, 200)
  assert.equal(result.payload.success, true)
  assert.equal(result.payload.verified, true)
  assert.equal(result.payload.status, 'solidified-trc20-transfer-verified')
  assert.equal(result.payload.assetIdentity, 'official-mainnet-usdt-contract')
  assert.equal(result.payload.checks.transferEventMatches, true)
  assert.equal(result.payload.checks.transactionBodyMatches, true)
  assert.equal(result.payload.checks.solidifiedReceiptPresent, true)
  assert.equal(result.payload.verificationPersistence.persisted, true)
  assert.equal(persistenceCalls.length, 1)
  assert.equal(persistenceCalls[0].status, 'verified-on-chain')
  assert.equal(persistenceCalls[0].logIndex, 0)
  assert.equal(persistenceCalls[0].amountBaseUnits, amountBaseUnits)
  assert.equal(result.payload.transactionBroadcast, false)
  assert.equal(requests.length, 2, 'should read transaction body and receipt from the fixed solidity host')
})

test('requires the exact amount, sender, receiver, token contract and direct transfer calldata', async () => {
  const { router } = createTestRouter()
  const wrongAmount = await invoke(router, validQuery({ amountBaseUnits: '101' }))
  assert.equal(wrongAmount.payload.verified, false)
  assert.equal(wrongAmount.payload.status, 'solidified-transfer-mismatch')
  assert.equal(wrongAmount.payload.checks.amountMatches, false)

  const badReceiver = await invoke(router, validQuery({ to: sender }))
  assert.equal(badReceiver.payload.verified, false)
  assert.equal(badReceiver.payload.checks.receiverMatches, false)

  const badSelector = createTestRouter({ transaction: makeTransaction({ selector: '23b872dd' }) })
  const transferFrom = await invoke(badSelector.router, validQuery())
  assert.equal(transferFrom.payload.verified, false)
  assert.equal(transferFrom.payload.checks.directTokenTransferCall, false)
})

test('does not confirm before the solidified transaction body and receipt are both present', async () => {
  const { router } = createTestRouter({ receipt: makeReceipt({ includeId: false }) })
  const result = await invoke(router, validQuery())
  assert.equal(result.statusCode, 202)
  assert.equal(result.payload.verified, false)
  assert.equal(result.payload.status, 'awaiting-solidified-receipt')
})

test('fails closed when the execution receipt reports a reverted transfer', async () => {
  const { router } = createTestRouter({
    transaction: makeTransaction({ success: false }),
    receipt: makeReceipt({ success: false }),
  })
  const result = await invoke(router, validQuery())
  assert.equal(result.payload.verified, false)
  assert.equal(result.payload.status, 'solidified-transaction-failed')
})

test('uses the supplied zero-based receipt log index and rejects mismatches', async () => {
  const { router } = createTestRouter()
  const matching = await invoke(router, validQuery({ eventIndex: '0' }))
  assert.equal(matching.payload.verified, true)
  assert.equal(matching.payload.eventIndex, 0)

  const mismatching = await invoke(router, validQuery({ eventIndex: '1' }))
  assert.equal(mismatching.payload.verified, false)
  assert.equal(mismatching.payload.checks.transferEventMatches, false)
})

test('rejects malformed input before contacting the chain provider', async () => {
  const { router, requests } = createTestRouter()
  const badAmount = await invoke(router, validQuery({ amountBaseUnits: '1.01' }))
  assert.equal(badAmount.statusCode, 400)
  assert.equal(badAmount.payload.error, 'invalid-amount')

  const badNetwork = await invoke(router, validQuery({ network: 'other-chain' }))
  assert.equal(badNetwork.statusCode, 400)
  assert.equal(badNetwork.payload.error, 'invalid-network')

  assert.equal(requests.length, 0)
})
