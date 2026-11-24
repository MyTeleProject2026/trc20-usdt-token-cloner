import test from 'node:test'
import assert from 'node:assert/strict'
import { getIncomingNativeTrxTransfers, getIncomingUsdtTransfers, formatDepositAmount } from '../src/wallet-deposits.mjs'

const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const addressHex = '41' + '11'.repeat(20)
const txid = 'a'.repeat(64)

test('native TRX deposit history includes only confirmed incoming TransferContract records', () => {
  const rows = getIncomingNativeTrxTransfers([
    { txID: txid, block_timestamp: 200, raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { to_address: addressHex, amount: 1250000 } } }] } },
    { txID: 'b'.repeat(64), block_timestamp: 300, raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { to_address: '41' + '22'.repeat(20), amount: 9000000 } } }] } },
    { txID: 'c'.repeat(64), raw_data: { contract: [{ type: 'TriggerSmartContract', parameter: { value: { to_address: addressHex, amount: 9999999 } } }] } },
    { txID: 'bad', raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { to_address: addressHex, amount: 1 } } }] } },
  ], address, addressHex)
  assert.deepEqual(rows, [{ txid, amountSun: '1250000', timestamp: 200 }])
  assert.equal(formatDepositAmount(rows[0].amountSun), '1.25')
})

test('official USDT deposit history includes only incoming positive token transfers', () => {
  const rows = getIncomingUsdtTransfers([
    { transaction_id: txid, from: 'TFromAddress1111111111111111111111', to: address, value: '2500000', block_timestamp: 100 },
    { transaction_id: 'b'.repeat(64), from: address, to: 'TReceiver111111111111111111111111', value: '1000000', block_timestamp: 200 },
    { transaction_id: 'c'.repeat(64), to: address, value: '0', block_timestamp: 300 },
  ], address)
  assert.deepEqual(rows, [{ txid, value: '2500000', timestamp: 100 }])
  assert.equal(formatDepositAmount(rows[0].value), '2.5')
})
