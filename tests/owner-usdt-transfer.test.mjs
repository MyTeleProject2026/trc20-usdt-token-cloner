import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { TronWeb } from 'tronweb'
import {
  MAINNET_USDT_CONTRACT,
  parseOwnerUsdtAmount,
  buildOwnerUsdtTransferParameter,
  validateOwnerSignedTransaction,
} from '../server/owner-usdt-transfer.mjs'

const tronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io' })
const ownerAddress = tronWeb.address.fromPrivateKey('1'.repeat(64))
const recipientAddress = tronWeb.address.fromPrivateKey('2'.repeat(64))

test('legacy USDT amount helper preserves exact six-decimal integer arithmetic', () => {
  assert.equal(parseOwnerUsdtAmount('1'), '1000000')
  assert.equal(parseOwnerUsdtAmount('0.000001'), '1')
  assert.equal(parseOwnerUsdtAmount('12.340056'), '12340056')
  assert.throws(() => parseOwnerUsdtAmount('0'), /positive USDT amount/)
  assert.throws(() => parseOwnerUsdtAmount('1.0000001'), /six decimal places/)
})

test('legacy USDT transfer parameter encodes the exact recipient and amount', () => {
  const recipientHex = tronWeb.address.toHex(recipientAddress).replace(/^41/i, '').toLowerCase()
  const expected = recipientHex.padStart(64, '0') + (1000000n).toString(16).padStart(64, '0')
  assert.equal(buildOwnerUsdtTransferParameter(recipientAddress, '1000000', tronWeb), expected)
  assert.throws(() => buildOwnerUsdtTransferParameter('invalid-address', '1000000', tronWeb), /Invalid TRON transfer parameter/)
})

function preparedTransaction() {
  const amountBaseUnits = '1000000'
  const rawDataHex = '01'
  const txID = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex')
  const parameter = buildOwnerUsdtTransferParameter(recipientAddress, amountBaseUnits, tronWeb)
  return {
    txID,
    raw_data_hex: rawDataHex,
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{
        type: 'TriggerSmartContract',
        parameter: { value: {
          owner_address: tronWeb.address.toHex(ownerAddress),
          contract_address: tronWeb.address.toHex(MAINNET_USDT_CONTRACT),
          call_value: 0,
          data: 'a9059cbb' + parameter,
        } },
      }],
    },
  }
}

test('legacy signed USDT helper accepts only the exact prepared Mainnet transfer intent', () => {
  const unsigned = preparedTransaction()
  const signed = { ...unsigned, signature: ['a'.repeat(130)] }
  const intent = { ownerAddress, recipientAddress, amountBaseUnits: '1000000', tronWeb }
  assert.deepEqual(validateOwnerSignedTransaction(signed, unsigned, intent), { ok: true })
  const tamperedUnsigned = {
    ...unsigned,
    raw_data: {
      ...unsigned.raw_data,
      contract: [{
        ...unsigned.raw_data.contract[0],
        parameter: { value: { ...unsigned.raw_data.contract[0].parameter.value, data: 'a9059cbb' + '0'.repeat(128) } },
      }],
    },
  }
  const tamperedSigned = { ...tamperedUnsigned, signature: ['a'.repeat(130)] }
  assert.deepEqual(validateOwnerSignedTransaction(tamperedSigned, tamperedUnsigned, intent), {
    ok: false, reason: 'signed-transaction-intent-mismatch',
  })
})
