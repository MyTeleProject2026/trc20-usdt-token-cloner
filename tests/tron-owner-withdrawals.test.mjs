import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { TronWeb } from 'tronweb'
import {
  MAINNET_USDT_CONTRACT,
  parseOwnerUsdtAmount,
  buildOwnerUsdtTransferParameter,
  validateOwnerSignedTransaction,
} from '../server/routes/tron-owner-withdrawals.mjs'

const ownerAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const recipientAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const tronWeb = new TronWeb({ fullHost: 'https://tron-mainnet.gateway.tatum.io' })

test('owner USDT amount parser converts exact six-decimal base units', () => {
  assert.equal(parseOwnerUsdtAmount('1'), '1000000')
  assert.equal(parseOwnerUsdtAmount('12.340056'), '12340056')
  assert.equal(parseOwnerUsdtAmount('0.000001'), '1')
})

test('owner USDT amount parser rejects zero, excess precision and non-decimal values', () => {
  for (const value of ['0', '0.000000', '0.0000001', '-1', '1e2', '01', '1,000', 1]) {
    assert.throws(() => parseOwnerUsdtAmount(value))
  }
})

test('TRC20 ABI parameter encodes recipient and six-decimal amount exactly', () => {
  const parameter = buildOwnerUsdtTransferParameter(recipientAddress, '1234567', tronWeb)
  assert.equal(parameter.length, 128)
  assert.match(parameter, /^[0-9a-f]{128}$/)
  const recipientBytes = tronWeb.address.toHex(recipientAddress).replace(/^41/i, '').toLowerCase()
  assert.equal(parameter.slice(24, 64), recipientBytes)
  assert.equal(BigInt('0x' + parameter.slice(64)).toString(), '1234567')
  assert.throws(() => buildOwnerUsdtTransferParameter('not-an-address', '1', tronWeb))
  assert.throws(() => buildOwnerUsdtTransferParameter(recipientAddress, '0', tronWeb))
})

function preparedTransfer(overrides = {}) {
  const amountBaseUnits = '25000000'
  const parameter = buildOwnerUsdtTransferParameter(recipientAddress, amountBaseUnits, tronWeb)
  const rawData = {
    contract: [{
      type: 'TriggerSmartContract',
      parameter: {
        value: {
          owner_address: tronWeb.address.toHex(ownerAddress),
          contract_address: tronWeb.address.toHex(MAINNET_USDT_CONTRACT),
          call_value: 0,
          data: 'a9059cbb' + parameter,
        },
      },
    }],
    expiration: Date.now() + 5 * 60 * 1000,
    timestamp: Date.now(),
  }
  const rawDataHex = 'deadbeef'
  const txID = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex')
  const unsigned = {
    txID,
    raw_data_hex: rawDataHex,
    raw_data: rawData,
  }
  const signed = { ...unsigned, signature: ['a'.repeat(130)] }
  return {
    unsigned,
    signed,
    intent: { ownerAddress, recipientAddress, amountBaseUnits, tronWeb },
    ...overrides,
  }
}

test('signed withdrawal must preserve the persisted owner, recipient, contract and amount intent', () => {
  const item = preparedTransfer()
  assert.deepEqual(validateOwnerSignedTransaction(item.signed, item.unsigned, item.intent), { ok: true })
})

test('signed withdrawal rejects a changed recipient, token contract, amount or raw transaction', () => {
  const item = preparedTransfer()
  const wrongRecipient = preparedTransfer()
  wrongRecipient.signed.raw_data.contract[0].parameter.value.data =
    'a9059cbb' + buildOwnerUsdtTransferParameter(ownerAddress, item.intent.amountBaseUnits, tronWeb)
  assert.equal(validateOwnerSignedTransaction(wrongRecipient.signed, wrongRecipient.unsigned, item.intent).ok, false)

  const wrongContract = preparedTransfer()
  wrongContract.signed.raw_data.contract[0].parameter.value.contract_address = tronWeb.address.toHex(recipientAddress)
  assert.equal(validateOwnerSignedTransaction(wrongContract.signed, wrongContract.unsigned, wrongContract.intent).ok, false)

  const wrongAmount = preparedTransfer()
  wrongAmount.signed.raw_data.contract[0].parameter.value.data =
    'a9059cbb' + buildOwnerUsdtTransferParameter(recipientAddress, '25000001', tronWeb)
  assert.equal(validateOwnerSignedTransaction(wrongAmount.signed, wrongAmount.unsigned, wrongAmount.intent).ok, false)

  const changedRaw = { ...item.signed, raw_data_hex: 'cafebabe' }
  assert.equal(validateOwnerSignedTransaction(changedRaw, item.unsigned, item.intent).ok, false)
})

test('signed withdrawal rejects a missing or multiple-signature payload', () => {
  const item = preparedTransfer()
  assert.equal(validateOwnerSignedTransaction({ ...item.signed, signature: [] }, item.unsigned, item.intent).reason, 'owner-signature-required')
  assert.equal(validateOwnerSignedTransaction({ ...item.signed, signature: ['a'.repeat(130), 'b'.repeat(130)] }, item.unsigned, item.intent).reason, 'owner-signature-required')
})
