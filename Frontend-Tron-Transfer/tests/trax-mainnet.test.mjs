import test from 'node:test'
import assert from 'node:assert/strict'
import { TronWeb } from 'tronweb'
import { parseTokenUnits, formatTokenUnits, addressesEqual, buildDeploymentOptions, toWalletSignableTransaction } from '../src/trax-mainnet.mjs'


test('TronWeb 6.5.1 exposes a constructible named TronWeb class', () => {
  assert.equal(typeof TronWeb, 'function')
  const client = new TronWeb({ fullHost: 'https://api.trongrid.io' })
  assert.equal(typeof client.transactionBuilder.createSmartContract, 'function')
  assert.equal(typeof client.trx.sendRawTransaction, 'function')
})

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

test('TronLink deployment payload contains only the documented protocol transaction fields', () => {
  const raw_data = { contract: [{ type: 'CreateSmartContract', parameter: { value: {} } }], timestamp: 1 }
  const tx = { visible: false, txID: 'a'.repeat(64), raw_data, raw_data_hex: '0a01', contract_address: 'T' + '1'.repeat(33) }
  const payload = toWalletSignableTransaction(tx)
  assert.notStrictEqual(payload, tx)
  assert.deepEqual(payload, { visible: false, txID: tx.txID, raw_data: tx.raw_data, raw_data_hex: tx.raw_data_hex })
  assert.notStrictEqual(payload.raw_data, tx.raw_data)
  assert.equal(Object.hasOwn(payload, 'contract_address'), false)
})

test('TronLink deployment payload rejects non-deployment or incomplete transactions', () => {
  assert.throws(() => toWalletSignableTransaction({ txID: 'a'.repeat(64), raw_data_hex: '01', raw_data: { contract: [{ type: 'TransferContract' }] } }), /CreateSmartContract/)
  assert.throws(() => toWalletSignableTransaction({ txID: 'bad', raw_data_hex: '01', raw_data: { contract: [{ type: 'CreateSmartContract' }] } }), /incomplete/)
})

test('TRӾ deployment builds with pinned TronWeb and signs with injected TronLink provider', async () => {
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
  let clientCreated = false
  globalThis.window = { setTimeout: (fn) => setTimeout(fn, 0) }
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => String(url).includes('gettransactionbyid')
      ? { txID: unsigned.txID, raw_data: unsigned.raw_data }
      : { id: unsigned.txID, receipt: { result: 'SUCCESS' } },
  })
  const walletTronWeb = {
    version: 'wallet-bundled-version',
    fullNode: { host: 'https://api.trongrid.io' },
    isAddress: (value) => typeof value === 'string' && value.startsWith('T'),
    trx: { sign: async (tx) => { signedInput = tx; return signed } },
  }
  const builderClient = {
    version: '6.5.1',
    transactionBuilder: { createSmartContract: async () => unsigned },
    address: { fromHex: () => 'T' + '1'.repeat(33) },
    isAddress: (value) => typeof value === 'string' && value.startsWith('T'),
    trx: {
      sendRawTransaction: async (tx) => { broadcastInput = tx; return { result: true } },
      getContract: async () => ({ bytecode: '6000' }),
    },
  }
  try {
    const { deployContractFromTronLink } = await import('../src/trax-mainnet.mjs')
    const result = await deployContractFromTronLink(
      { tronWeb: walletTronWeb, address: 'T' + '2'.repeat(33) },
      { abi: [], bytecode: '6000' },
      'TestVault',
      300000000,
      { createClient: () => { clientCreated = true; return builderClient } },
    )
    assert.equal(clientCreated, true)
    assert.notStrictEqual(signedInput, unsigned)
    assert.deepEqual(signedInput, { visible: false, txID: unsigned.txID, raw_data: unsigned.raw_data, raw_data_hex: unsigned.raw_data_hex })
    assert.equal(Object.hasOwn(signedInput, 'contract_address'), false)
    assert.strictEqual(broadcastInput, signed)
    assert.equal(result.txID, unsigned.txID)
    assert.equal(result.address, 'T' + '1'.repeat(33))
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})
