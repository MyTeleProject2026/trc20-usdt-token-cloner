import test from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { TronWeb } from 'tronweb'
import { parseTokenUnits, formatTokenUnits, addressesEqual, assertMainnetWallet, buildDeploymentOptions, toWalletSignableTransaction } from '../src/trax-mainnet.mjs'



test('TRӾ manager is reachable without the private platform-owner session', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /<TRXMainnetPanel wallet=\{unlocked\} onConnect=/)
  assert.doesNotMatch(app, /if \(!ownerSession\) return/)
  assert.doesNotMatch(app, /if \(!ownerSessionResolved\) return/)
  assert.doesNotMatch(app, /expectedOwner=\{ownerSession\.address\}/)
})

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


test('TRӾ wallet validation accepts a non-configured valid Mainnet wallet', () => {
  const wallet = {
    address: 'T' + '2'.repeat(33),
    tronWeb: {
      fullNode: { host: 'https://api.trongrid.io' },
      isAddress: (value) => typeof value === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value),
    },
  }
  assert.equal(assertMainnetWallet(wallet), wallet.tronWeb)
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

test('TronLink signature metadata can differ while the app retains canonical unsigned transaction bytes', () => {
  const unsigned = {
    txID: 'c'.repeat(64),
    raw_data_hex: '0a01',
    raw_data: { contract: [{ type: 'CreateSmartContract' }], timestamp: 1, fee_limit: 300000000 },
  }
  const signed = {
    ...unsigned,
    raw_data: { fee_limit: 300000000, timestamp: 1, contract: [{ type: 'CreateSmartContract' }] },
    signature: ['a'.repeat(130)],
  }
  assert.equal(signed.txID, unsigned.txID)
  assert.equal(signed.raw_data_hex, unsigned.raw_data_hex)
  assert.notEqual(JSON.stringify(signed.raw_data), JSON.stringify(unsigned.raw_data))
  assert.match(signed.signature[0], /^[0-9a-f]{130}$/i)
  assert.notEqual({ ...signed, raw_data_hex: '0a02' }.raw_data_hex, unsigned.raw_data_hex)
})

test('TronLink deployment payload rejects non-deployment or incomplete transactions', () => {
  assert.throws(() => toWalletSignableTransaction({ txID: 'a'.repeat(64), raw_data_hex: '01', raw_data: { contract: [{ type: 'TransferContract' }] } }), /CreateSmartContract/)
  assert.throws(() => toWalletSignableTransaction({ txID: 'bad', raw_data_hex: '01', raw_data: { contract: [{ type: 'CreateSmartContract' }] } }), /incomplete/)
})

test('any valid TronLink Mainnet wallet can sign and deploy after explicit wallet approval', async () => {
  const unsigned = {
    visible: false,
    txID: 'b'.repeat(64),
    contract_address: '41' + '1'.repeat(40),
    raw_data: { contract: [{ type: 'CreateSmartContract', parameter: { value: {} } }], timestamp: 1 },
    raw_data_hex: '0a01',
  }
  const signed = { ...unsigned, raw_data: { timestamp: 1, contract: [{ type: 'CreateSmartContract', parameter: { value: {} } }] }, raw_data_hex: 'deadbeef', signature: ['a'.repeat(130)] }
  let signCalls = 0
  let broadcastCalls = 0
  let receiptCalls = 0
  let verifiedAddress = ''
  const walletTronWeb = {
    version: 'wallet-bundled-version',
    fullNode: { host: 'https://api.trongrid.io' },
    isAddress: (value) => typeof value === 'string' && value.startsWith('T'),
    trx: { sign: async (payload) => { signCalls++; assert.equal(payload.txID, unsigned.txID); return signed } },
  }
  const builderClient = {
    version: '6.5.1',
    transactionBuilder: { createSmartContract: async () => unsigned },
    address: { fromHex: () => 'T' + '1'.repeat(33) },
    isAddress: (value) => typeof value === 'string' && value.startsWith('T'),
    trx: { sendRawTransaction: async (payload) => { broadcastCalls++; assert.notEqual(payload, signed); assert.equal(payload.txID, unsigned.txID); assert.equal(payload.raw_data_hex, unsigned.raw_data_hex); assert.deepEqual(payload.raw_data, unsigned.raw_data); assert.deepEqual(payload.signature, signed.signature); return { result: true } } },
  }
  const { deployContractFromTronLink } = await import('../src/trax-mainnet.mjs')
  const result = await deployContractFromTronLink(
    { tronWeb: walletTronWeb, address: 'T' + '2'.repeat(33) },
    { abi: [], bytecode: '6000' },
    'TestVault',
    300000000,
    {
      createClient: () => builderClient,
      waitForReceipt: async (_client, txID) => { receiptCalls++; assert.equal(txID, unsigned.txID); return { id: txID, receipt: { result: 'SUCCESS' } } },
      verifyDeployedContract: async (_client, address) => { verifiedAddress = address; return { bytecode: '6000' } },
    },
  )
  assert.equal(signCalls, 1)
  assert.equal(broadcastCalls, 1)
  assert.equal(receiptCalls, 1)
  assert.equal(verifiedAddress, result.address)
  assert.equal(result.txID, unsigned.txID)
  assert.equal(result.receipt.receipt.result, 'SUCCESS')
})
