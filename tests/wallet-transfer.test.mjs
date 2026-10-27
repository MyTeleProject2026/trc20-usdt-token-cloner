import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSignAndBroadcastTransfer,
  estimateTRC20TransferFee,
  parseUnitsDecimal,
  readConfirmedTransferStatus,
} from '../src/wallet-transfer.mjs'

const from = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
const to = 'THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC'
const contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const txid = 'a'.repeat(64)
const ownerHex = '41' + '1'.repeat(40)

function transaction() {
  return { txID: txid, raw_data: { contract: [{ parameter: { value: { owner_address: ownerHex } } }] } }
}

function mockTronWeb(overrides = {}) {
  const calls = { signed: 0, broadcast: 0, broadcastPayload: null }
  const tronWeb = {
    isAddress: value => typeof value === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value),
    address: { fromHex: () => from },
    transactionBuilder: {
      sendTrx: async () => transaction(),
      triggerSmartContract: async () => ({ result: { result: true }, transaction: transaction() }),
      triggerConstantContract: async () => ({ result: { result: true }, energy_used: 100_000 }),
      estimateEnergy: async () => ({ result: { result: true }, energy_required: 100_000 }),
    },
    trx: {
      sign: async tx => { calls.signed += 1; return { ...tx, signature: ['real-signature-placeholder'] } },
      sendRawTransaction: async tx => { calls.broadcast += 1; calls.broadcastPayload = tx; return { result: true, txid } },
      getChainParameters: async () => [{ key: 'getEnergyFee', value: 420 }],
      getConfirmedTransaction: async () => null,
      getTransactionInfo: async () => ({}),
      getTransaction: async () => null,
    },
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'transactionBuilder' || key === 'trx') Object.assign(tronWeb[key], value)
    else Object.assign(tronWeb, { [key]: value })
  }
  return { tronWeb, calls }
}

test('decimal parsing uses integer base units and rejects invalid, zero, excess precision and overflow', () => {
  assert.equal(parseUnitsDecimal('12.340001', 6), '12340001')
  assert.equal(parseUnitsDecimal('1', 0), '1')
  for (const value of ['0', '0.0000001', '-1', '1e3', '1,000']) {
    assert.throws(() => parseUnitsDecimal(value, 6))
  }
})

test('native TRX transfer signs the reviewed transaction and broadcasts only the signed payload', async () => {
  const { tronWeb, calls } = mockTronWeb()
  const result = await buildSignAndBroadcastTransfer({
    tronWeb, from, to, asset: 'TRX', amountBaseUnits: '1500000',
  })
  assert.equal(calls.signed, 1)
  assert.equal(calls.broadcast, 1)
  assert.deepEqual(calls.broadcastPayload.signature, ['real-signature-placeholder'])
  assert.equal(result.txid, txid)
  assert.equal(result.asset, 'TRX')
  assert.equal(result.amountBaseUnits, '1500000')
})

test('TRC-20 transfer requires a successfully built transaction and signs before broadcast', async () => {
  const { tronWeb, calls } = mockTronWeb()
  const result = await buildSignAndBroadcastTransfer({
    tronWeb, from, to, asset: 'TRC20', tokenContract: contract,
    amountBaseUnits: '1234567', feeLimitSun: 30_000_000,
  })
  assert.equal(calls.signed, 1)
  assert.equal(calls.broadcast, 1)
  assert.equal(calls.broadcastPayload.signature.length, 1)
  assert.equal(result.tokenContract, contract)
  assert.equal(result.amountBaseUnits, '1234567')
})

test('invalid sender/recipient, self-transfer, failed build, sender mismatch and rejected broadcast fail closed', async () => {
  const invalid = mockTronWeb({ isAddress: value => value === from || value === contract })
  await assert.rejects(buildSignAndBroadcastTransfer({
    tronWeb: invalid.tronWeb, from, to: 'not-an-address', asset: 'TRX', amountBaseUnits: '1',
  }), /recipient/)
  await assert.rejects(buildSignAndBroadcastTransfer({
    tronWeb: invalid.tronWeb, from, to: from, asset: 'TRX', amountBaseUnits: '1',
  }), /different/)
  assert.equal(invalid.calls.signed, 0)
  assert.equal(invalid.calls.broadcast, 0)

  const failedBuild = mockTronWeb({ transactionBuilder: { triggerSmartContract: async () => ({ result: { result: false } }) } })
  await assert.rejects(buildSignAndBroadcastTransfer({
    tronWeb: failedBuild.tronWeb, from, to, asset: 'TRC20', tokenContract: contract, amountBaseUnits: '1',
  }), /could not be built/)
  assert.equal(failedBuild.calls.signed, 0)
  assert.equal(failedBuild.calls.broadcast, 0)

  let rejected
  rejected = mockTronWeb({ trx: { sendRawTransaction: async () => {
    rejected.calls.broadcast += 1
    return { result: false, code: 'REJECTED' }
  } } })
  await assert.rejects(buildSignAndBroadcastTransfer({
    tronWeb: rejected.tronWeb, from, to, asset: 'TRX', amountBaseUnits: '1',
  }), /did not accept/)
  assert.equal(rejected.calls.signed, 1)
  assert.equal(rejected.calls.broadcast, 1)

  const wrongOwner = mockTronWeb({ address: { fromHex: () => to } })
  await assert.rejects(buildSignAndBroadcastTransfer({
    tronWeb: wrongOwner.tronWeb, from, to, asset: 'TRX', amountBaseUnits: '1',
  }), /sender does not match/)
  assert.equal(wrongOwner.calls.signed, 0)
  assert.equal(wrongOwner.calls.broadcast, 0)
})

test('TRC-20 fee estimate requires successful live simulation and valid energy pricing', async () => {
  const { tronWeb } = mockTronWeb()
  const estimate = await estimateTRC20TransferFee({
    tronWeb, from, to, tokenContract: contract, amountBaseUnits: '1000000',
  })
  assert.equal(estimate.simulationSucceeded, true)
  assert.equal(estimate.energyRequired, 100_000)
  assert.ok(estimate.recommendedFeeSun > 0)

  const failed = mockTronWeb({ transactionBuilder: { triggerConstantContract: async () => ({ result: { result: false } }) } })
  await assert.rejects(estimateTRC20TransferFee({
    tronWeb: failed.tronWeb, from, to, tokenContract: contract, amountBaseUnits: '1000000',
  }), /simulation did not succeed/)
})

test('confirmed transaction needs an explicit successful receipt; ambiguous receipt stays unresolved', async () => {
  const ambiguous = mockTronWeb({ trx: {
    getConfirmedTransaction: async () => ({ txID: txid, ret: [{}] }),
    getTransactionInfo: async () => ({ blockNumber: 55 }),
  } })
  const pending = await readConfirmedTransferStatus(ambiguous.tronWeb, txid)
  assert.equal(pending.status, 'included-unconfirmed')
  assert.equal(pending.solidified, false)

  const success = mockTronWeb({ trx: {
    getConfirmedTransaction: async () => ({ txID: txid, ret: [{ contractRet: 'SUCCESS' }] }),
    getTransactionInfo: async () => ({ blockNumber: 56, receipt: { result: 'SUCCESS' } }),
  } })
  const confirmed = await readConfirmedTransferStatus(success.tronWeb, txid)
  assert.equal(confirmed.status, 'confirmed')
  assert.equal(confirmed.solidified, true)
  assert.equal(confirmed.blockNumber, 56)

  const failed = mockTronWeb({ trx: {
    getConfirmedTransaction: async () => ({ txID: txid, ret: [{ contractRet: 'FAILED' }] }),
    getTransactionInfo: async () => ({ blockNumber: 57, result: 'FAILED' }),
  } })
  const status = await readConfirmedTransferStatus(failed.tronWeb, txid)
  assert.equal(status.status, 'failed')
})
