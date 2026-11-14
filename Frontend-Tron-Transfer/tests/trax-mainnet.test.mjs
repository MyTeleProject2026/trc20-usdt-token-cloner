import test from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { TronWeb } from 'tronweb'
import { decodeTronBroadcastFailure, parseTokenUnits, formatTokenUnits, addressesEqual, assertMainnetWallet, buildDeploymentOptions, toWalletSignableTransaction, sha256HexFromBytes, verifyTransactionSigner, assertTransactionIntegrity, assertTransactionPermission, deployContractFromTronLink, MAINNET_DEPLOYMENT_SIGNING_ENABLED, MAINNET_DEPLOYMENT_BROADCAST_ENABLED, normalizeMainnetAccountResources, normalizeMainnetPermissionSnapshot, normalizeDeploymentEnergyEstimate, calculateDeploymentResourceBudget } from '../src/trax-mainnet.mjs'



test('TRӾ manager is reachable without the private platform-owner session', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /<TRXMainnetPanel wallet=\{unlocked\} onConnect=/)
  assert.doesNotMatch(app, /if \(!ownerSession\) return/)
  assert.doesNotMatch(app, /if \(!ownerSessionResolved\) return/)
  assert.doesNotMatch(app, /expectedOwner=\{ownerSession\.address\}/)
})


test('TRON Mainnet resource snapshot calculates available Energy and Bandwidth from live limits and usage', () => {
  const snapshot = normalizeMainnetAccountResources({
    EnergyLimit: 10000, EnergyUsed: 3000,
    freeNetLimit: 600, freeNetUsed: 120,
    NetLimit: 1500, NetUsed: 320,
  }, { chainParameter: [
    { key: 'getEnergyFee', value: 100 },
    { key: 'getTransactionFee', value: 1000 },
    { key: 'getMaxFeeLimit', value: 15000000000 },
  ] }, 2500000)
  assert.equal(snapshot.energyAvailable, '7000')
  assert.equal(snapshot.freeBandwidthAvailable, '480')
  assert.equal(snapshot.stakedBandwidthAvailable, '1180')
  assert.equal(snapshot.nativeBalanceSun, '2500000')
  assert.equal(snapshot.energyFeeSun, '100')
  assert.equal(snapshot.bandwidthFeeSun, '1000')
  assert.equal(snapshot.maxFeeLimitSun, '15000000000')
})

test('TRON Mainnet owner permission snapshot detects a connected signer below threshold', () => {
  const signer = 'T' + '1'.repeat(33)
  const other = 'T' + '2'.repeat(33)
  const tronWeb = { address: { toHex: value => value === signer ? '41' + '1'.repeat(40) : String(value).toLowerCase() } }
  const result = normalizeMainnetPermissionSnapshot({
    owner_permission: {
      id: 0, threshold: 2,
      keys: [{ address: signer, weight: 1 }, { address: other, weight: 1 }],
    },
  }, signer, tronWeb)
  assert.equal(result.connectedSignerCanAuthorizeAlone, false)
  assert.equal(result.connectedSignerWeight, '1')
  assert.equal(result.requiredAdditionalWeight, '1')
  assert.equal(result.otherOwnerKeyCount, 1)
})

test('TRON Mainnet deployment simulation requires a successful positive Energy result', () => {
  assert.deepEqual(normalizeDeploymentEnergyEstimate({
    result: { result: true }, energy_used: 250000, energy_penalty: 50000,
  }), { energyUsed: '250000', energyPenalty: '50000' })
  assert.throws(
    () => normalizeDeploymentEnergyEstimate({ result: { result: false, code: 'CONTRACT_VALIDATE_ERROR' } }),
    /simulation failed/,
  )
  assert.throws(
    () => normalizeDeploymentEnergyEstimate({ result: { result: true }, energy_used: 0 }),
    /zero Energy/,
  )
})

test('TRON Mainnet deployment budget includes Energy margin, Bandwidth and TRX shortfall', () => {
  const budget = calculateDeploymentResourceBudget({
    energyRequired: '100000',
    resourceSnapshot: {
      energyAvailable: '100000', freeBandwidthAvailable: '600', stakedBandwidthAvailable: '349',
      nativeBalanceSun: '2000000', energyFeeSun: '100', bandwidthFeeSun: '1000', maxFeeLimitSun: '15000000000',
    },
    rawDataHex: 'ab'.repeat(200),
    feeLimitSun: '20000000',
  })
  assert.equal(budget.energyWithSafetyMargin, '120000')
  assert.equal(budget.energyShortfall, '20000')
  assert.equal(budget.bandwidthShortfall, '0')
  assert.equal(budget.requiredTrxSun, '2000000')
})

test('TRON Mainnet deployment budget blocks insufficient resources before wallet signing', () => {
  assert.throws(() => calculateDeploymentResourceBudget({
    energyRequired: '250000',
    resourceSnapshot: {
      energyAvailable: '131000', freeBandwidthAvailable: '600', stakedBandwidthAvailable: '349',
      nativeBalanceSun: '0', energyFeeSun: '100', bandwidthFeeSun: '1000', maxFeeLimitSun: '15000000000',
    },
    rawDataHex: 'ab'.repeat(3000),
    feeLimitSun: '300000000',
  }), /Insufficient Mainnet resources/)
})

test('TRON Mainnet deployment code uses one injected provider and keeps minting gated by reserve checks', async () => {
  const helper = await readFile(new URL('../src/trax-mainnet.mjs', import.meta.url), 'utf8')
  const panel = await readFile(new URL('../src/TRXMainnetPanel.jsx', import.meta.url), 'utf8')
  assert.ok(helper.includes('const walletTronWeb = assertMainnetWallet(wallet)'))
  assert.ok(helper.includes('readResources(tronWeb, wallet.address)'))
  assert.ok(helper.includes('estimateEnergy(tronWeb, wallet.address, artifact)'))
  assert.ok(helper.includes('await walletTronWeb.trx.sign(walletTransaction)'))
  assert.ok(helper.includes('await walletTronWeb.trx.sendRawTransaction(signedTransaction)'))
  assert.ok(!helper.includes('createClient ='))
  assert.ok(panel.includes('const configuredOwnerMatches = walletReady'))
  assert.ok(panel.includes('getMainnetAccountResourceSnapshot'))
  assert.ok(panel.includes('getMainnetAccountPermissionSnapshot'))
})

test('TronWeb 6.5.1 exposes a constructible named TronWeb class', () => {
  assert.equal(typeof TronWeb, 'function')
  const client = new TronWeb({ fullHost: 'https://api.trongrid.io' })
  assert.equal(typeof client.transactionBuilder.createSmartContract, 'function')
  assert.equal(typeof client.trx.sendRawTransaction, 'function')
  assert.equal(typeof client.trx.getSignWeight, 'function')
  assert.equal(typeof client.utils?.transaction?.txCheck, 'function')
  assert.equal(typeof client.utils?.crypto?.ecRecover, 'function')
})

test('TRON deployment broadcast diagnostics distinguish Bandwidth, Energy and TRX balance failures', () => {
  const tronWeb = { toUtf8: value => value }
  const txID = 'f'.repeat(64)
  assert.match(
    decodeTronBroadcastFailure(tronWeb, { result: false, message: 'Account resource insufficient error' }, txID),
    /Bandwidth requirement/,
  )
  assert.match(
    decodeTronBroadcastFailure(tronWeb, { result: false, code: 'OUT_OF_ENERGY' }, txID),
    /Energy\/fee budget is insufficient/,
  )
  assert.match(
    decodeTronBroadcastFailure(tronWeb, { result: false, message: 'balance is not sufficient' }, txID),
    /insufficient TRX/,
  )
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

test('TronLink signed transaction retains its transaction identity', () => {
  const unsigned = {
    txID: '426e75c2b5c719ae46005abc57144fde1b70294c0d2adf82a36a4de6e0578830',
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

test('TRON deployment integrity check fails closed when protobuf payload and txID disagree', () => {
  const transaction = { txID: 'a'.repeat(64), raw_data: {}, raw_data_hex: '01' }
  assert.equal(assertTransactionIntegrity({ utils: { transaction: { txCheck: () => true } } }, transaction), true)
  assert.throws(
    () => assertTransactionIntegrity({ utils: { transaction: { txCheck: () => false } } }, transaction),
    /protobuf integrity validation/,
  )
  assert.throws(() => assertTransactionIntegrity({}, transaction), /integrity checker is unavailable/)
})

test('TRON deployment signature must recover the connected contract owner', () => {
  const expected = 'T' + '1'.repeat(33)
  const tronWeb = {
    address: { fromHex: () => expected, toHex: value => String(value).toLowerCase() },
    isAddress: value => typeof value === 'string' && value.startsWith('T'),
    utils: { crypto: { ecRecover: (txID, signature) => {
      assert.equal(txID, 'a'.repeat(64))
      assert.equal(signature, 'b'.repeat(130))
      return '41' + '1'.repeat(40)
    } } },
  }
  const transaction = {
    txID: 'a'.repeat(64),
    raw_data: { contract: [{ parameter: { value: { owner_address: '41' + '1'.repeat(40) } } }] },
    signature: ['b'.repeat(130)],
  }
  assert.deepEqual(verifyTransactionSigner(tronWeb, transaction, expected), {
    ownerAddress: expected, recoveredAddress: expected,
  })
  assert.throws(() => verifyTransactionSigner(tronWeb, transaction, 'T' + '2'.repeat(33)), /does not match/)
  assert.throws(() => verifyTransactionSigner(tronWeb, { ...transaction, signature: [] }, expected), /exactly one/)
})

test('TRON signer recovery verifies a real locally generated secp256k1 transaction signature', async () => {
  // Fixed throwaway key used only by this offline test; it has no funds and is
  // never used by the application or any Mainnet transaction.
  const privateKey = '0000000000000000000000000000000000000000000000000000000000000001'
  const signerClient = new TronWeb({ fullHost: 'https://api.trongrid.io', privateKey })
  const signerAddress = signerClient.address.fromPrivateKey(privateKey)
  const ownerHex = signerClient.address.toHex(signerAddress)
  const txID = '426e75c2b5c719ae46005abc57144fde1b70294c0d2adf82a36a4de6e0578830'
  const unsigned = {
    txID,
    raw_data_hex: '0a01',
    raw_data: { contract: [{ type: 'CreateSmartContract', parameter: { value: { owner_address: ownerHex } } }] },
  }
  const signature = signerClient.utils.crypto.ECKeySign(
    Buffer.from(txID, 'hex'),
    Buffer.from(privateKey, 'hex'),
  )
  const signed = { ...unsigned, signature: [signature] }
  assert.equal(verifyTransactionSigner(signerClient, signed, signerAddress).recoveredAddress, signerAddress)
  assert.throws(() => verifyTransactionSigner(signerClient, signed, 'T' + '1'.repeat(33)), /does not match/)
})

test('Mainnet deployment uses one injected TronLink client and completes only after preflight and on-chain verification', async () => {
  assert.equal(MAINNET_DEPLOYMENT_SIGNING_ENABLED, true)
  assert.equal(MAINNET_DEPLOYMENT_BROADCAST_ENABLED, true)

  const ownerAddress = 'T' + '1'.repeat(33)
  const ownerHex = '41' + '1'.repeat(40)
  const unsigned = {
    visible: false,
    txID: '426e75c2b5c719ae46005abc57144fde1b70294c0d2adf82a36a4de6e0578830',
    contract_address: ownerHex,
    raw_data: {
      contract: [{ type: 'CreateSmartContract', parameter: { value: { owner_address: ownerHex } } }],
      timestamp: 1,
      fee_limit: 300000000,
    },
    raw_data_hex: '0a01',
  }
  const signed = {
    txID: unsigned.txID,
    raw_data_hex: unsigned.raw_data_hex,
    raw_data: { contract: [{ type: 'CreateSmartContract', parameter: { value: { owner_address: ownerHex } } }], timestamp: '1', fee_limit: '300000000' },
    signature: ['a'.repeat(130)],
  }
  let signCalls = 0, broadcastCalls = 0, receiptCalls = 0, buildCalls = 0
  let readResourceClient, readPermissionClient, estimateClient, verifyClient, ownerVerifyClient
  const tronWeb = {
    version: 'TronLink-test-provider',
    fullNode: { host: 'https://api.trongrid.io' },
    isAddress: value => typeof value === 'string' && value.startsWith('T'),
    address: {
      fromHex: value => String(value).toLowerCase() === ownerHex ? ownerAddress : 'T' + '2'.repeat(33),
      toHex: value => value === ownerAddress ? ownerHex : String(value).toLowerCase(),
    },
    utils: {
      transaction: { txCheck: () => true },
      crypto: { ecRecover: () => ownerHex },
    },
    transactionBuilder: {
      async createSmartContract() {
        buildCalls++
        assert.strictEqual(this, tronWeb.transactionBuilder)
        return unsigned
      },
    },
    trx: {
      sign: async payload => {
        signCalls++
        assert.equal(payload.txID, unsigned.txID)
        assert.equal(payload.raw_data_hex, unsigned.raw_data_hex)
        return signed
      },
      getSignWeight: async tx => {
        assert.equal(tx.txID, unsigned.txID)
        assert.equal(tx.raw_data_hex, unsigned.raw_data_hex)
        assert.deepEqual(tx.raw_data, unsigned.raw_data)
        assert.deepEqual(tx.signature, signed.signature)
        return {
          result: { code: 'ENOUGH_PERMISSION' },
          current_weight: 1,
          permission: { id: 0, permission_name: 'owner', threshold: 1, keys: [{ address: ownerHex, weight: 1 }] },
          approved_list: [ownerHex],
        }
      },
      sendRawTransaction: async tx => {
        broadcastCalls++
        assert.equal(tx.txID, unsigned.txID)
        assert.equal(tx.raw_data_hex, unsigned.raw_data_hex)
        assert.deepEqual(tx.signature, signed.signature)
        return { result: true }
      },
    },
  }
  const result = await deployContractFromTronLink(
    { tronWeb, address: ownerAddress },
    { abi: [], bytecode: '6000' },
    'TestVault',
    300000000,
    {
      createVerifier: () => tronWeb,
      readResources: async client => {
        readResourceClient = client
        return {
          energyAvailable: '500000', freeBandwidthAvailable: '600', stakedBandwidthAvailable: '349',
          nativeBalanceSun: '0', energyFeeSun: '100', bandwidthFeeSun: '1000', maxFeeLimitSun: '15000000000',
        }
      },
      readPermissions: async client => {
        readPermissionClient = client
        return { connectedSignerCanAuthorizeAlone: true, connectedSignerWeight: '1', threshold: '1', requiredAdditionalWeight: '0' }
      },
      estimateEnergy: async client => { estimateClient = client; return { energyUsed: '100000', energyPenalty: '0' } },
      waitForReceipt: async (client, txID) => {
        receiptCalls++
        assert.strictEqual(client, tronWeb)
        assert.equal(txID, unsigned.txID)
        return { receipt: { result: 'SUCCESS' } }
      },
      verifyDeployedContract: async (client, address) => {
        verifyClient = client
        assert.equal(address, ownerAddress)
        return { bytecode: '6000' }
      },
      verifyDeployedOwner: async (client, artifact, address) => {
        ownerVerifyClient = client
        assert.equal(address, ownerAddress)
        assert.deepEqual(artifact.abi, [])
        return ownerAddress
      },
    },
  )
  assert.equal(buildCalls, 1)
  assert.equal(signCalls, 1)
  assert.equal(broadcastCalls, 1)
  assert.equal(receiptCalls, 1)
  assert.strictEqual(readResourceClient, tronWeb)
  assert.strictEqual(readPermissionClient, tronWeb)
  assert.strictEqual(estimateClient, tronWeb)
  assert.strictEqual(verifyClient, tronWeb)
  assert.strictEqual(ownerVerifyClient, tronWeb)
  assert.equal(result.owner, ownerAddress)
  assert.equal(result.txID, unsigned.txID)
  assert.equal(result.address, ownerAddress)
})

test('TRON deployment never broadcasts if signer recovery rejects the connected wallet', async () => {
  const ownerAddress = 'T' + '1'.repeat(33)
  const ownerHex = '41' + '1'.repeat(40)
  const otherHex = '41' + '2'.repeat(40)
  const unsigned = {
    txID: '426e75c2b5c719ae46005abc57144fde1b70294c0d2adf82a36a4de6e0578830',
    contract_address: ownerHex,
    raw_data_hex: '0a01',
    raw_data: { contract: [{ type: 'CreateSmartContract', parameter: { value: { owner_address: ownerHex } } }], timestamp: 1, fee_limit: 300000000 },
  }
  const signed = { ...unsigned, signature: ['a'.repeat(130)] }
  let broadcasts = 0
  const tronWeb = {
    fullNode: { host: 'https://api.trongrid.io' },
    isAddress: value => typeof value === 'string' && value.startsWith('T'),
    address: {
      fromHex: value => String(value).toLowerCase() === ownerHex ? ownerAddress : 'T' + '2'.repeat(33),
      toHex: value => String(value).toLowerCase(),
    },
    utils: { transaction: { txCheck: () => true }, crypto: { ecRecover: () => otherHex } },
    transactionBuilder: { createSmartContract: async () => unsigned },
    trx: {
      sign: async () => signed,
      getSignWeight: async () => ({ result: { code: 'ENOUGH_PERMISSION' } }),
      sendRawTransaction: async () => { broadcasts++; return { result: true } },
    },
  }
  await assert.rejects(
    () => deployContractFromTronLink(
      { tronWeb, address: ownerAddress },
      { abi: [], bytecode: '6000' },
      'TestVault',
      300000000,
      {
        createVerifier: () => tronWeb,
        readResources: async () => ({
          energyAvailable: '500000', freeBandwidthAvailable: '600', stakedBandwidthAvailable: '349',
          nativeBalanceSun: '0', energyFeeSun: '100', bandwidthFeeSun: '1000', maxFeeLimitSun: '15000000000',
        }),
        readPermissions: async () => ({ connectedSignerCanAuthorizeAlone: true, connectedSignerWeight: '1', threshold: '1', requiredAdditionalWeight: '0' }),
        estimateEnergy: async () => ({ energyUsed: '100000', energyPenalty: '0' }),
      },
    ),
    /does not match both the deployment owner_address and connected wallet/,
  )
  assert.equal(broadcasts, 0)
})

const TEST_SIGNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const TEST_SIGNER_HEX = '418bedec556c0b3179c8d86debf512c69ac28d74a4'
const TEST_TRONWEB = {
  isAddress: value => value === TEST_SIGNER,
  address: { toHex: value => value === TEST_SIGNER ? TEST_SIGNER_HEX : String(value).toLowerCase() },
}

function permissionResponse({ code, weight = 1, threshold = 1, permissionId = 0, keys = [{ address: TEST_SIGNER_HEX, weight: 1 }], approved = [TEST_SIGNER_HEX] } = {}) {
  const result = {}
  if (code !== undefined) result.code = code
  return {
    result,
    current_weight: weight,
    permission: { id: permissionId, permission_name: permissionId === 0 ? 'owner' : 'active', threshold, keys },
    approved_list: approved,
  }
}

test('TRON permission preflight accepts explicit ENOUGH_PERMISSION with matching signer and key', async () => {
  const transaction = { txID: 'a'.repeat(64), raw_data: { contract: [{}] }, signature: ['b'.repeat(130)] }
  const response = permissionResponse({ code: 'ENOUGH_PERMISSION' })
  const accepted = await assertTransactionPermission({
    ...TEST_TRONWEB,
    trx: { getSignWeight: async () => response },
  }, transaction, TEST_SIGNER)
  assert.strictEqual(accepted, response)
})

test('TRON permission preflight accepts proto3 result:{} when node weight and authorized key prove threshold', async () => {
  const transaction = { txID: 'a'.repeat(64), raw_data: { contract: [{}] }, signature: ['b'.repeat(130)] }
  const response = permissionResponse()
  const accepted = await assertTransactionPermission({
    ...TEST_TRONWEB,
    trx: { getSignWeight: async () => response },
  }, transaction, TEST_SIGNER)
  assert.strictEqual(accepted, response)
})

test('TRON permission preflight accepts explicit numeric proto enum zero as ENOUGH_PERMISSION', async () => {
  const transaction = { txID: 'a'.repeat(64), raw_data: { contract: [{}] }, signature: ['b'.repeat(130)] }
  const response = permissionResponse({ code: 0 })
  const accepted = await assertTransactionPermission({
    ...TEST_TRONWEB,
    trx: { getSignWeight: async () => response },
  }, transaction, TEST_SIGNER)
  assert.strictEqual(accepted, response)
})

test('TRON permission preflight rejects explicit insufficient weight and unknown errors', async () => {
  const transaction = { txID: 'a'.repeat(64), raw_data: { contract: [{}] }, signature: ['b'.repeat(130)] }
  await assert.rejects(
    () => assertTransactionPermission({
      ...TEST_TRONWEB,
      trx: { getSignWeight: async () => permissionResponse({ code: 'NOT_ENOUGH_PERMISSION', weight: 1, threshold: 2, permissionId: 0 }) },
    }, transaction, TEST_SIGNER),
    /NOT_ENOUGH_PERMISSION/,
  )
  await assert.rejects(
    () => assertTransactionPermission({
      ...TEST_TRONWEB,
      trx: { getSignWeight: async () => permissionResponse({ code: 'PERMISSION_ERROR' }) },
    }, transaction, TEST_SIGNER),
    /PERMISSION_ERROR/,
  )
})

test('TRON permission preflight rejects missing signer approval even if reported weight meets threshold', async () => {
  const transaction = { txID: 'a'.repeat(64), raw_data: { contract: [{}] }, signature: ['b'.repeat(130)] }
  await assert.rejects(
    () => assertTransactionPermission({
      ...TEST_TRONWEB,
      trx: { getSignWeight: async () => permissionResponse({ approved: [] }) },
    }, transaction, TEST_SIGNER),
    /approved_list|permission key/,
  )
})

test('TRON permission preflight rejects a connected signer missing from permission.keys', async () => {
  const transaction = { txID: 'a'.repeat(64), raw_data: { contract: [{}] }, signature: ['b'.repeat(130)] }
  await assert.rejects(
    () => assertTransactionPermission({
      ...TEST_TRONWEB,
      trx: { getSignWeight: async () => permissionResponse({ keys: [{ address: '418888888888888888888888888888888888888888', weight: 1 }] }) },
    }, transaction, TEST_SIGNER),
    /not a key in the selected permission/,
  )
})

test('TRON permission preflight rejects a permission ID mismatch', async () => {
  const transaction = { txID: 'a'.repeat(64), raw_data: { contract: [{ Permission_id: 2 }] }, signature: ['b'.repeat(130)] }
  await assert.rejects(
    () => assertTransactionPermission({
      ...TEST_TRONWEB,
      trx: { getSignWeight: async () => permissionResponse({ permissionId: 0 }) },
    }, transaction, TEST_SIGNER),
    /permission ID/,
  )
})

test('TRON permission preflight requires a valid connected signer and provider method', async () => {
  const transaction = { txID: 'a'.repeat(64), raw_data: { contract: [{}] }, signature: ['b'.repeat(130)] }
  await assert.rejects(() => assertTransactionPermission({}, transaction, TEST_SIGNER), /preflight is unavailable/)
  await assert.rejects(
    () => assertTransactionPermission({ trx: { getSignWeight: async () => permissionResponse() } }, transaction, TEST_SIGNER),
    /Expected connected TRON signer/,
  )
})
