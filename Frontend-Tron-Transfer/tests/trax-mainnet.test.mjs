import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { TronWeb } from 'tronweb'
import { parseTokenUnits, formatTokenUnits, addressesEqual, assertMainnetWallet, buildDeploymentOptions, toWalletSignableTransaction } from '../src/trax-mainnet.mjs'



test('any valid TronLink Mainnet account can be used without a platform-owner allowlist', () => {
  const address = 'T' + '2'.repeat(33)
  const tronWeb = {
    fullNode: { host: 'https://api.trongrid.io' },
    isAddress: (value) => value === address,
  }
  assert.equal(assertMainnetWallet({ address, tronWeb }), tronWeb)
  assert.throws(
    () => assertMainnetWallet({ address, tronWeb: { ...tronWeb, fullNode: { host: 'https://api.shasta.trongrid.io' } } }),
    /Wrong network/,
  )
})

test('public TRӾ workspace bypasses private platform login but keeps on-chain owner enforcement', async () => {
  const app = await fs.readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const panel = await fs.readFile(new URL('../src/TRXMainnetPanel.jsx', import.meta.url), 'utf8')
  const token = await fs.readFile(new URL('../../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')
  const vault = await fs.readFile(new URL('../../contracts/OneTraxReserveVault.sol', import.meta.url), 'utf8')
  assert.ok(app.includes('!ownerSession && !publicTraxMode'))
  assert.ok(app.includes('Open TRӾ deployment without owner login'))
  assert.ok(panel.includes('token.owner().call()'))
  assert.ok(panel.includes('vault.owner().call()'))
  assert.ok(panel.includes('addressesEqual(tronWeb, owner, connectedAddress)'))
  assert.ok(panel.includes('addressesEqual(tronWeb, vaultOwner, connectedAddress)'))
  assert.ok(panel.includes('existingToken.owner().call()'))
  assert.ok(panel.includes('existingVault.owner().call()'))
  assert.ok(panel.includes('prepareUnsignedDeployment'))
  assert.ok(panel.includes('No signing or broadcast occurred'))
  assert.ok(panel.includes('These diagnostic payloads are not saved or reusable'))
  assert.ok(panel.includes('Minting activation is disabled in this build'))
  assert.ok(panel.includes('TRӾ minting is disabled in this build'))
  assert.ok(!panel.includes('token.setMintingEnabled(true)'))
  assert.ok(!panel.includes('token.mint(recipient,units)'))
  assert.ok(token.includes('constructor() {\n        owner = msg.sender;'))
  assert.ok(vault.includes('constructor() { owner = msg.sender; }'))
  assert.ok(token.includes('modifier onlyOwner() { require(msg.sender == owner, "owner-only"); _; }'))
  assert.ok(vault.includes('modifier onlyOwner() { require(msg.sender == owner, "owner-only"); _; }'))
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

test('TRӾ deployment safety hold validates payload but never signs or broadcasts', async () => {
  const unsigned = {
    visible: false,
    txID: 'b'.repeat(64),
    contract_address: '41' + '1'.repeat(40),
    raw_data: { contract: [{ type: 'CreateSmartContract', parameter: { value: {} } }], timestamp: 1 },
    raw_data_hex: '0a01',
  }
  let signCalls = 0
  let broadcastCalls = 0
  const walletTronWeb = {
    version: 'wallet-bundled-version',
    fullNode: { host: 'https://api.trongrid.io' },
    isAddress: (value) => typeof value === 'string' && value.startsWith('T'),
    trx: { sign: async () => { signCalls++; throw new Error('sign must not be called') } },
  }
  const builderClient = {
    version: '6.5.1',
    transactionBuilder: { createSmartContract: async () => unsigned },
    address: { fromHex: () => 'T' + '1'.repeat(33) },
    isAddress: (value) => typeof value === 'string' && value.startsWith('T'),
    trx: { sendRawTransaction: async () => { broadcastCalls++; return { result: true } } },
  }
  const { deployContractFromTronLink } = await import('../src/trax-mainnet.mjs')
  await assert.rejects(
    deployContractFromTronLink(
      { tronWeb: walletTronWeb, address: 'T' + '2'.repeat(33) },
      { abi: [], bytecode: '6000' },
      'TestVault',
      300000000,
      { createClient: () => builderClient },
    ),
    /Deployment safety hold.*No transaction was sent/,
  )
  assert.equal(signCalls, 0)
  assert.equal(broadcastCalls, 0)
})
