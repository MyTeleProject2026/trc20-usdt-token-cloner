import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { TronWeb } from 'tronweb'
import { parseTokenUnits, formatTokenUnits, addressesEqual, assertMainnetWallet, buildDeploymentOptions, toWalletSignableTransaction, normalizeMainnetAccountResources, normalizeMainnetPermissionSnapshot, normalizeSignWeightResponse, sameStructuredTransactionData, verifyRawDataHash } from '../src/trax-mainnet.mjs'



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


test('TRON raw_data_hex hash must match txID before signing', async () => {
  const rawDataHex = '0a0101'
  const txID = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex')
  assert.equal(await verifyRawDataHash({ txID, raw_data_hex: rawDataHex }), true)
  await assert.rejects(
    verifyRawDataHash({ txID: 'f'.repeat(64), raw_data_hex: rawDataHex }),
    /does not match SHA-256/,
  )
  await assert.rejects(
    verifyRawDataHash({ txID, raw_data_hex: 'abc' }),
    /invalid txID or raw_data_hex/,
  )
})

test('TRON signed transaction structure comparison ignores object key order but preserves values', () => {
  assert.equal(
    sameStructuredTransactionData({ timestamp: 1, contract: [{ type: 'CreateSmartContract', owner: 'T1' }] },
      { contract: [{ owner: 'T1', type: 'CreateSmartContract' }], timestamp: 1 }),
    true,
  )
  assert.equal(
    sameStructuredTransactionData({ timestamp: 1 }, { timestamp: 2 }),
    false,
  )
})

test('TRON signature-weight preflight allows broadcast only when connected signer reaches threshold', () => {
  const signer = 'T' + '2'.repeat(33)
  const tronWeb = { address: { toHex: (value) => String(value).toLowerCase() } }
  const accepted = normalizeSignWeightResponse({
    result: { code: 'ENOUGH_PERMISSION' },
    current_weight: 2,
    permission: { threshold: 2 },
    approved_list: [signer],
  }, signer, tronWeb)
  assert.deepEqual(accepted, {
    currentWeight: '2',
    threshold: '2',
    approvedSigners: 1,
    enoughPermission: true,
  })
})

test('TRON signature-weight preflight rejects missing weight, unknown signers and malformed responses', () => {
  const signer = 'T' + '2'.repeat(33)
  const other = 'T' + '3'.repeat(33)
  const tronWeb = { address: { toHex: (value) => String(value).toLowerCase() } }
  assert.throws(() => normalizeSignWeightResponse({
    result: { code: 'NOT_ENOUGH_PERMISSION' },
    current_weight: 1,
    permission: { threshold: 2 },
    approved_list: [signer],
  }, signer, tronWeb), /collected weight 1; required threshold 2/)
  assert.throws(() => normalizeSignWeightResponse({
    result: {},
    current_weight: 2,
    permission: { threshold: 2 },
    approved_list: [other],
  }, signer, tronWeb), /not among the transaction’s approved signers/)
  assert.throws(() => normalizeSignWeightResponse({ Error: 'bad request' }, signer, tronWeb), /could not validate/)
})

test('TRON owner permission preflight detects a second signer when one key is below threshold', () => {
  const signer = 'T' + '2'.repeat(33)
  const other = 'T' + '3'.repeat(33)
  const tronWeb = { address: { toHex: (value) => String(value).toLowerCase() } }
  const snapshot = normalizeMainnetPermissionSnapshot({
    owner_permission: {
      id: 0,
      permission_name: 'owner',
      threshold: 2,
      keys: [
        { address: signer, weight: 1 },
        { address: other, weight: 1 },
      ],
    },
    active_permission: [{ id: 2, permission_name: 'active', threshold: 1, keys: [{ address: signer, weight: 1 }] }],
  }, signer, tronWeb)
  assert.equal(snapshot.permissionId, 0)
  assert.equal(snapshot.threshold, '2')
  assert.equal(snapshot.connectedSignerWeight, '1')
  assert.equal(snapshot.requiredAdditionalWeight, '1')
  assert.equal(snapshot.connectedSignerCanAuthorizeAlone, false)
  assert.equal(snapshot.otherOwnerKeyCount, 1)
  assert.deepEqual(snapshot.activePermissions, [{ id: 2, name: 'active', threshold: '1', keyCount: 1 }])
})

test('TRON owner permission preflight recognizes a connected key whose weight meets threshold', () => {
  const signer = 'T' + '2'.repeat(33)
  const tronWeb = { address: { toHex: (value) => String(value).toLowerCase() } }
  const snapshot = normalizeMainnetPermissionSnapshot({
    owner_permission: {
      id: 0,
      threshold: 2,
      keys: [{ address: signer, weight: 2 }],
    },
  }, signer, tronWeb)
  assert.equal(snapshot.connectedSignerWeight, '2')
  assert.equal(snapshot.requiredAdditionalWeight, '0')
  assert.equal(snapshot.connectedSignerCanAuthorizeAlone, true)
})

test('TRON owner permission preflight rejects missing and malformed thresholds', () => {
  const signer = 'T' + '2'.repeat(33)
  const tronWeb = { address: { toHex: (value) => String(value).toLowerCase() } }
  assert.throws(() => normalizeMainnetPermissionSnapshot({}, signer, tronWeb), /owner permission/)
  assert.throws(() => normalizeMainnetPermissionSnapshot({
    owner_permission: { threshold: 'bad', keys: [{ address: signer, weight: 1 }] },
  }, signer, tronWeb), /invalid owner permission threshold/)
})

test('TRON Mainnet resource snapshot computes remaining Energy and Bandwidth from limits minus usage', () => {
  const snapshot = normalizeMainnetAccountResources(
    {
      EnergyLimit: 10000,
      EnergyUsed: 3000,
      freeNetLimit: 600,
      freeNetUsed: 120,
      NetLimit: 1500,
      NetUsed: 320,
    },
    {
      chainParameter: [
        { key: 'getEnergyFee', value: 100 },
        { key: 'getTransactionFee', value: 1000 },
        { key: 'getMaxFeeLimit', value: 15000000000 },
      ],
    },
    2500000,
  )
  assert.equal(snapshot.energyAvailable, '7000')
  assert.equal(snapshot.freeBandwidthAvailable, '480')
  assert.equal(snapshot.stakedBandwidthAvailable, '1180')
  assert.equal(snapshot.nativeBalanceSun, '2500000')
  assert.equal(snapshot.energyFeeSun, '100')
  assert.equal(snapshot.bandwidthFeeSun, '1000')
  assert.equal(snapshot.maxFeeLimitSun, '15000000000')
})

test('TRON Mainnet resource snapshot safely treats omitted protobuf resource fields as zero', () => {
  const snapshot = normalizeMainnetAccountResources(
    {},
    { chainParameter: [{ key: 'getEnergyFee', value: 100 }] },
    0,
  )
  assert.equal(snapshot.energyAvailable, '0')
  assert.equal(snapshot.freeBandwidthAvailable, '0')
  assert.equal(snapshot.stakedBandwidthAvailable, '0')
  assert.equal(snapshot.nativeBalanceSun, '0')
})

test('TRON Mainnet resource snapshot rejects missing Energy fee and malformed resource data', () => {
  assert.throws(
    () => normalizeMainnetAccountResources({}, { chainParameter: [] }, 0),
    /valid current Energy fee/,
  )
  assert.throws(
    () => normalizeMainnetAccountResources({ EnergyLimit: 'not-a-number' }, { chainParameter: [{ key: 'getEnergyFee', value: 100 }] }, 0),
    /invalid resource field/,
  )
})

test('TRӾ deployment builds on the injected TronLink client and keeps the safety hold non-broadcasting', async () => {
  const walletAddress = 'T' + '2'.repeat(33)
  const predictedAddress = 'T' + '1'.repeat(33)
  const ownerHex = '41' + '2'.repeat(40)
  let unsigned = {
    visible: false,
    txID: createHash('sha256').update(Buffer.from('0a01', 'hex')).digest('hex'),
    contract_address: '41' + '1'.repeat(40),
    raw_data: {
      contract: [{
        type: 'CreateSmartContract',
        parameter: { value: { owner_address: ownerHex } },
      }],
      timestamp: 1,
    },
    raw_data_hex: '0a01',
  }
  let signCalls = 0
  let broadcastCalls = 0
  let buildCalls = 0
  let builderContext = null
  const walletTronWeb = {
    version: 'wallet-bundled-version',
    fullNode: { host: 'https://api.trongrid.io' },
    isAddress: (value) => typeof value === 'string' && value.startsWith('T'),
    address: {
      fromHex: (value) => value === unsigned.contract_address ? predictedAddress
        : value === ownerHex ? walletAddress : 'T' + '3'.repeat(33),
      toHex: (value) => String(value).toLowerCase(),
    },
    transactionBuilder: {
      async createSmartContract(options, owner) {
        builderContext = this
        buildCalls++
        assert.equal(owner, walletAddress)
        assert.equal(options.feeLimit, 300000000)
        return unsigned
      },
    },
    trx: {
      sign: async () => { signCalls++; throw new Error('sign must not be called') },
      sendRawTransaction: async () => { broadcastCalls++; return { result: true } },
    },
  }
  const { deployContractFromTronLink } = await import('../src/trax-mainnet.mjs')
  await assert.rejects(
    deployContractFromTronLink(
      { tronWeb: walletTronWeb, address: walletAddress },
      { abi: [], bytecode: '6000' },
      'TestVault',
      300000000,
    ),
    /Deployment safety hold.*No transaction was sent/,
  )
  assert.equal(buildCalls, 1)
  assert.equal(builderContext, walletTronWeb.transactionBuilder)
  assert.equal(signCalls, 0)
  assert.equal(broadcastCalls, 0)

  unsigned = {
    ...unsigned,
    raw_data: {
      ...unsigned.raw_data,
      contract: [{
        ...unsigned.raw_data.contract[0],
        parameter: { value: { owner_address: '41' + '3'.repeat(40) } },
      }],
    },
  }
  await assert.rejects(
    deployContractFromTronLink(
      { tronWeb: walletTronWeb, address: walletAddress },
      { abi: [], bytecode: '6000' },
      'TestVault',
      300000000,
    ),
    /owner does not match the connected TronLink account/,
  )
  assert.equal(signCalls, 0)
  assert.equal(broadcastCalls, 0)
})
