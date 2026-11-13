import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTokenUnits, formatTokenUnits, addressesEqual, buildDeploymentOptions, toWalletSignableTransaction } from '../src/trax-mainnet.mjs'

test('TRӾ amount conversion preserves six decimal places exactly', () => {
  assert.equal(parseTokenUnits('100'), '100000000')
  assert.equal(parseTokenUnits('0.000001'), '1')
  assert.equal(parseTokenUnits('12.345678'), '12345678')
  assert.equal(formatTokenUnits('100000000'), '100')
  assert.equal(formatTokenUnits('12345678'), '12.345678')
})

test('TRӾ amount parser rejects invalid precision and non-positive values', () => {
  for (const value of ['', '0', '0.0', '-1', '1e3', '1.0000001', '01', 'NaN']) {
    assert.throws(() => parseTokenUnits(value))
  }
})

test('TRӾ address comparison normalizes TRON address forms', () => {
  const tronWeb = { address: { toHex: (value) => value.toLowerCase() } }
  assert.equal(
    addressesEqual(tronWeb, 'TABC', 'tabc'),
    true,
  )
})

test('TRӾ deployment options pass ABI as structured array, not JSON text', () => {
  const abi = [{ type: 'constructor', inputs: [] }]
  const options = buildDeploymentOptions({ abi, bytecode: '0x60006000' }, 'Restricted1TRAX', 300000000)
  assert.equal(options.abi, abi)
  assert.deepEqual(options.abi, abi)
  assert.equal(options.bytecode, '60006000')
  assert.equal(options.feeLimit, 300000000)
  assert.equal(options.callValue, 0)
  assert.equal(options.name, 'Restricted1TRAX')
})

test('TRӾ deployment options reject missing ABI, malformed bytecode and invalid fee cap', () => {
  assert.throws(() => buildDeploymentOptions({ abi: '{}', bytecode: '6000' }, 'Broken', 300000000), /ABI/)
  assert.throws(() => buildDeploymentOptions({ abi: [], bytecode: '0xzz' }, 'Broken', 300000000), /bytecode/)
  assert.throws(() => buildDeploymentOptions({ abi: [], bytecode: '6000' }, 'Broken', 0), /fee cap/)
})

test('TronLink deployment payload preserves the exact createSmartContract transaction including contract_address', () => {
  const raw_data = { contract: [{ type: 'CreateSmartContract', parameter: { value: {} } }], timestamp: 1 }
  const tx = { visible: false, txID: 'a'.repeat(64), raw_data, raw_data_hex: '0a01', contract_address: 'T' + '1'.repeat(33) }
  const payload = toWalletSignableTransaction(tx)
  assert.strictEqual(payload, tx)
  assert.deepEqual(payload, tx)
  assert.equal(payload.contract_address, tx.contract_address)
})

test('TronLink deployment payload rejects non-deployment or incomplete transactions', () => {
  assert.throws(() => toWalletSignableTransaction({ txID: 'a'.repeat(64), raw_data_hex: '01', raw_data: { contract: [{ type: 'TransferContract' }] } }), /CreateSmartContract/)
  assert.throws(() => toWalletSignableTransaction({ txID: 'bad', raw_data_hex: '01', raw_data: { contract: [{ type: 'CreateSmartContract' }] } }), /incomplete/)
})

test('TRӾ deployment signs the original builder object and broadcasts the returned signed object', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const unsigned = {
    visible: false,
    txID: 'b'.repeat(64),
    contract_address: '41' + '1'.repeat(40),
    raw_data: { contract: [{ type: 'CreateSmartContract', parameter: { value: {} } }], timestamp: 1 },
    raw_data_hex: '0a01',
  }
  const signed = { ...unsigned, signature: ['c'.repeat(130)] }
  let signedInput
  let broadcastInput
  globalThis.window = { setTimeout: (fn) => setTimeout(fn, 0) }
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => String(url).includes('gettransactionbyid')
      ? { txID: unsigned.txID, raw_data: unsigned.raw_data }
      : { id: unsigned.txID, receipt: { result: 'SUCCESS' } },
  })
  const tronWeb = {
    fullNode: { host: 'https://api.trongrid.io' },
    isAddress: (value) => typeof value === 'string' && value.startsWith('T'),
    address: { fromHex: () => 'T' + '1'.repeat(33) },
    transactionBuilder: { createSmartContract: async () => unsigned },
    trx: {
      sign: async (tx) => { signedInput = tx; return signed },
      sendRawTransaction: async (tx) => { broadcastInput = tx; return { result: true } },
      getContract: async () => ({ bytecode: '6000' }),
    },
  }
  try {
    const { deployContractFromTronLink } = await import('../src/trax-mainnet.mjs')
    const result = await deployContractFromTronLink(
      { tronWeb, address: 'T' + '2'.repeat(33) },
      { abi: [], bytecode: '6000' },
      'TestVault',
      300000000,
    )
    assert.strictEqual(signedInput, unsigned)
    assert.strictEqual(broadcastInput, signed)
    assert.equal(result.txID, unsigned.txID)
    assert.equal(result.address, 'T' + '1'.repeat(33))
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})
