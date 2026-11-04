import test from 'node:test'
import assert from 'node:assert/strict'
import { verifySolidifiedUsdtTransfer } from '../server/routes/tron-transfer.mjs'

const from = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const to = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const txid = 'ab'.repeat(32)
const amount = '1250000'
const fromHex = '41' + '11'.repeat(20)
const toHex = '41' + '22'.repeat(20)
const contractHex = '41' + '33'.repeat(20)
const amountHex = BigInt(amount).toString(16).padStart(64, '0')
const transferTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function fakeTronWeb() {
  const addresses = new Map([[from, fromHex], [to, toHex], [contract, contractHex]])
  return {
    isAddress(value) { return addresses.has(value) },
    address: { toHex(value) { return addresses.get(value) || '' } },
  }
}

function makeTransaction({
  txID = txid,
  owner = fromHex,
  token = contractHex,
  recipient = toHex,
  amountValue = amount,
  success = true,
} = {}) {
  const recipientBytes = recipient.replace(/^41/, '')
  const data = 'a9059cbb' + '0'.repeat(24) + recipientBytes + BigInt(amountValue).toString(16).padStart(64, '0')
  return {
    txID,
    raw_data: {
      contract: [{
        type: 'TriggerSmartContract',
        parameter: { value: { owner_address: owner, contract_address: token, data } },
      }],
    },
    ret: [{ contractRet: success ? 'SUCCESS' : 'REVERT' }],
  }
}

function makeReceipt({
  id = txid,
  success = true,
  logFrom = fromHex.replace(/^41/, ''),
  logTo = toHex.replace(/^41/, ''),
  logContract = contractHex,
  logAmount = amount,
  duplicate = false,
} = {}) {
  const log = {
    address: logContract,
    topics: [
      transferTopic,
      '0'.repeat(24) + logFrom,
      '0'.repeat(24) + logTo,
    ],
    data: BigInt(logAmount).toString(16).padStart(64, '0'),
  }
  return {
    id,
    blockNumber: 456,
    blockTimeStamp: 1790000000000,
    receipt: { result: success ? 'SUCCESS' : 'FAILED' },
    log: duplicate ? [log, { ...log, topics: [...log.topics] }] : [log],
  }
}

function dependencies({ transaction, receipt } = {}) {
  const calls = []
  return {
    calls,
    providerRequest: async ({ path, network, body }) => {
      calls.push({ path, network, body })
      return path.endsWith('gettransactionbyid')
        ? transaction ?? makeTransaction()
        : receipt ?? makeReceipt()
    },
    tronWebFactory: async () => fakeTronWeb(),
  }
}

async function verify(overrides = {}) {
  const deps = dependencies(overrides)
  const result = await verifySolidifiedUsdtTransfer({}, {
    transactionHash: txid,
    from,
    to,
    amountBaseUnits: amount,
    providerRequest: deps.providerRequest,
    tronWebFactory: deps.tronWebFactory,
  })
  return { result, calls: deps.calls }
}

test('verifies exact Mainnet USDT transfer using solidified transaction body, receipt and unique Transfer event', async () => {
  const { result, calls } = await verify()
  assert.equal(result.verified, true)
  assert.equal(result.status, 'solidified-trc20-transfer-verified')
  assert.equal(result.transactionHash, txid)
  assert.equal(result.contract, contract)
  assert.equal(result.from, from)
  assert.equal(result.to, to)
  assert.equal(result.amountBaseUnits, amount)
  assert.equal(result.blockNumber, 456)
  assert.equal(result.logIndex, 0)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.network === 'mainnet'))
  assert.ok(calls.every(call => call.body.value === txid))
})

test('rejects an unindexed or non-solidified transaction and receipt', async () => {
  const { result } = await verify({
    transaction: makeTransaction(),
    receipt: makeReceipt({ id: 'cd'.repeat(32) }),
  })
  assert.equal(result.verified, false)
  assert.equal(result.status, 'awaiting-solidified-receipt')
})

test('rejects transaction-body sender, contract, recipient or amount mismatches', async () => {
  for (const transaction of [
    makeTransaction({ owner: '41' + '44'.repeat(20) }),
    makeTransaction({ token: '41' + '55'.repeat(20) }),
    makeTransaction({ recipient: '41' + '66'.repeat(20) }),
    makeTransaction({ amountValue: '999' }),
  ]) {
    const { result } = await verify({ transaction, receipt: makeReceipt() })
    assert.equal(result.verified, false)
    assert.equal(result.status, 'solidified-transfer-mismatch')
  }
})

test('requires successful execution in both transaction and receipt', async () => {
  for (const [transaction, receipt] of [
    [makeTransaction({ success: false }), makeReceipt()],
    [makeTransaction(), makeReceipt({ success: false })],
  ]) {
    const { result } = await verify({ transaction, receipt })
    assert.equal(result.verified, false)
    assert.equal(result.status, 'solidified-transaction-failed')
  }
})

test('rejects missing, mismatched or duplicate receipt Transfer events', async () => {
  for (const receipt of [
    makeReceipt({ id: 'de'.repeat(32) }),
    makeReceipt({ logFrom: '77'.repeat(20) }),
    makeReceipt({ logTo: '88'.repeat(20) }),
    makeReceipt({ logContract: '41' + '99'.repeat(20) }),
    makeReceipt({ logAmount: '999' }),
    makeReceipt({ duplicate: true }),
  ]) {
    const { result } = await verify({ transaction: makeTransaction(), receipt })
    assert.equal(result.verified, false)
  }
})
