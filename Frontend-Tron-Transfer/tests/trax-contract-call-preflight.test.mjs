import test from 'node:test'
import assert from 'node:assert/strict'
import { sendAndVerifyContractCall, estimateMainnetContractCallEnergy } from '../src/trax-mainnet.mjs'

const TX_ID = '1'.repeat(64)
const RAW_DATA_HEX = 'ab'.repeat(100)

function resourceSnapshot({ energy = '1000', freeBandwidth = '1000', stakedBandwidth = '0' } = {}) {
  return {
    energyFeeSun: '100',
    bandwidthFeeSun: '1000',
    energyAvailable: energy,
    freeBandwidthAvailable: freeBandwidth,
    stakedBandwidthAvailable: stakedBandwidth,
    maxFeeLimitSun: '15000000000',
  }
}

function makeHarness({ snapshots = [resourceSnapshot(), resourceSnapshot()], estimateError = null } = {}) {
  let resourceReads = 0
  let signCalls = 0
  let broadcastCalls = 0
  let estimateCalls = 0
  let buildCalls = 0
  const unsigned = {
    txID: TX_ID,
    raw_data_hex: RAW_DATA_HEX,
    raw_data: {
      fee_limit: 150000000,
      contract: [{
        type: 'TriggerSmartContract',
        Permission_id: 0,
        parameter: { value: {
          owner_address: 'TOwner',
          contract_address: 'TToken',
          data: 'deadbeef' + '00'.repeat(32),
          call_value: 0,
        } },
      }],
    },
  }
  const methodInstance = {
    abi: { type: 'function', name: 'credit', stateMutability: 'nonpayable', inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'referenceId', type: 'bytes32' },
    ] },
    functionSelector: 'credit(address,uint256,bytes32)',
    signature: 'deadbeef',
    contract: { address: 'TToken', deployed: true },
  }
  const tokenContract = { address: 'TToken', deployed: true, methodInstances: { credit: methodInstance } }
  const tronWeb = {
    defaultAddress: { base58: 'TOwner', hex: 'TOwner' },
    isAddress: value => typeof value === 'string' && value.startsWith('T'),
    address: { toHex: value => value, fromHex: value => value },
    utils: { transaction: { txCheck: () => true } },
    trx: { sign: async transaction => ({ ...transaction, signature: ['ab'.repeat(65)] }), sendRawTransaction: async () => ({ result: true }) },
    transactionBuilder: {
      triggerSmartContract: async (address, selector, options, params, issuer) => {
        buildCalls += 1
        assert.equal(address, 'TToken')
        assert.equal(selector, 'credit(address,uint256,bytes32)')
        assert.equal(options.funcABIV2.name, 'credit')
        assert.deepEqual(options.parametersV2, ['TOwner', '1000000', '0x' + '11'.repeat(32)])
        assert.deepEqual(params, [])
        assert.equal(issuer, 'TOwner')
        return { result: { result: true }, transaction: unsigned }
      },
    },
  }
  const dependencies = {
    readResources: async () => {
      const index = Math.min(resourceReads, snapshots.length - 1)
      resourceReads += 1
      return snapshots[index]
    },
    readPermissions: async () => ({ connectedSignerCanAuthorizeAlone: true }),
    estimateEnergy: async (_client, address, encodedData, owner) => {
      estimateCalls += 1
      assert.equal(address, 'TToken')
      assert.equal(encodedData, 'deadbeef' + '00'.repeat(32))
      assert.equal(owner, 'TOwner')
      if (estimateError) throw estimateError
      return { energyUsed: '10' }
    },
    waitForReceipt: async (_client, txID) => ({ id: txID, receipt: { result: 'SUCCESS' } }),
    signTransaction: async transaction => {
      signCalls += 1
      return { ...transaction, signature: ['ab'.repeat(65)] }
    },
    broadcastTransaction: async transaction => {
      broadcastCalls += 1
      assert.equal(transaction.txID, TX_ID)
      return { result: true }
    },
    checkTransactionIntegrity: () => true,
    hashRawData: async () => TX_ID,
    checkTransactionSigner: () => true,
    checkTransactionPermission: async () => true,
  }
  return {
    tronWeb, tokenContract, dependencies,
    counts: () => ({ resourceReads, signCalls, broadcastCalls, estimateCalls, buildCalls }),
  }
}

const args = ['TOwner', '1000000', '0x' + '11'.repeat(32)]

test('every contract write preflights exact Energy and Bandwidth before TronLink signature', async () => {
  const h = makeHarness()
  const result = await sendAndVerifyContractCall(h.tronWeb, h.tokenContract, 'credit', args, 150000000, 'TOwner', h.dependencies)
  assert.equal(result.txID, TX_ID)
  assert.equal(result.receipt.receipt.result, 'SUCCESS')
  assert.equal(result.resourceBudget.requiredTrxSun, '0')
  assert.deepEqual(h.counts(), { resourceReads: 2, signCalls: 1, broadcastCalls: 1, estimateCalls: 1, buildCalls: 1 })
})

test('Energy shortfall blocks before asking TronLink to sign', async () => {
  const h = makeHarness({ snapshots: [resourceSnapshot({ energy: '0' })] })
  await assert.rejects(
    sendAndVerifyContractCall(h.tronWeb, h.tokenContract, 'credit', args, 150000000, 'TOwner', h.dependencies),
    /ZERO-TRX-BURN PROTECTION BLOCKED TRӾ CREDIT OPERATION/
  )
  assert.equal(h.counts().signCalls, 0)
  assert.equal(h.counts().broadcastCalls, 0)
})

test('Bandwidth shortfall blocks even when Energy is sufficient', async () => {
  const h = makeHarness({ snapshots: [resourceSnapshot({ freeBandwidth: '0', stakedBandwidth: '0' })] })
  await assert.rejects(
    sendAndVerifyContractCall(h.tronWeb, h.tokenContract, 'credit', args, 150000000, 'TOwner', h.dependencies),
    /ZERO-TRX-BURN PROTECTION BLOCKED TRӾ CREDIT OPERATION/
  )
  assert.equal(h.counts().signCalls, 0)
  assert.equal(h.counts().broadcastCalls, 0)
})

test('resource loss while TronLink is open discards the signed transaction before broadcast', async () => {
  const h = makeHarness({
    snapshots: [
      resourceSnapshot(),
      resourceSnapshot({ energy: '0' }),
    ],
  })
  await assert.rejects(
    sendAndVerifyContractCall(h.tronWeb, h.tokenContract, 'credit', args, 150000000, 'TOwner', h.dependencies),
    /signed TRӾ credit, but it was NOT broadcast/
  )
  assert.equal(h.counts().signCalls, 1)
  assert.equal(h.counts().broadcastCalls, 0)
})

test('unavailable Energy simulation fails closed without signing or broadcasting', async () => {
  const h = makeHarness({ estimateError: new Error('Mainnet estimateenergy unavailable and triggerconstantcontract unavailable') })
  await assert.rejects(
    sendAndVerifyContractCall(h.tronWeb, h.tokenContract, 'credit', args, 150000000, 'TOwner', h.dependencies),
    /Energy preflight failed/
  )
  assert.equal(h.counts().buildCalls, 0)
  assert.equal(h.counts().signCalls, 0)
  assert.equal(h.counts().broadcastCalls, 0)
})

test('owner write rejects a signer address different from the supplied payer', async () => {
  const h = makeHarness()
  h.tronWeb.defaultAddress.base58 = 'TOther'
  await assert.rejects(
    sendAndVerifyContractCall(h.tronWeb, h.tokenContract, 'credit', args, 150000000, 'TOwner', h.dependencies),
    /signing address does not match/
  )
  assert.equal(h.counts().signCalls, 0)
  assert.equal(h.counts().broadcastCalls, 0)
})

test('exact encoded-call Energy estimator uses the queued estimateenergy API', async () => {
  const requests = []
  const encodedData = 'deadbeef' + '11'.repeat(64)
  const result = await estimateMainnetContractCallEnergy(
    { isAddress: value => value.startsWith('T'), address: { toHex: value => value } },
    'TToken',
    encodedData,
    'TOwner',
    async (_tronWeb, path, body) => {
      requests.push({ path, body })
      return { result: { result: true }, energy_required: 321 }
    }
  )
  assert.deepEqual(result, { energyUsed: '321', energyPenalty: '0' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/wallet/estimateenergy')
  assert.equal(requests[0].body.data, encodedData)
  assert.equal(requests[0].body.owner_address, 'TOwner')
  assert.equal(requests[0].body.contract_address, 'TToken')
  assert.equal(requests[0].body.call_value, 0)
  assert.equal(requests[0].body.visible, false)
})

test('exact encoded-call estimator falls back to queued triggerconstantcontract only when estimateenergy is unsupported', async () => {
  const requests = []
  const encodedData = 'deadbeef' + '22'.repeat(64)
  const result = await estimateMainnetContractCallEnergy(
    { isAddress: value => value.startsWith('T'), address: { toHex: value => value } },
    'TToken',
    encodedData,
    'TOwner',
    async (_tronWeb, path, body) => {
      requests.push({ path, body })
      if (path === '/wallet/estimateenergy') throw new Error('This node does not support estimate energy')
      return { result: { result: true }, energy_used: 654, energy_penalty: 12 }
    }
  )
  assert.deepEqual(result, { energyUsed: '654', energyPenalty: '12' })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].path, '/wallet/estimateenergy')
  assert.equal(requests[1].path, '/wallet/triggerconstantcontract')
  assert.equal(requests[1].body.data, encodedData)
})

test('all TRӾ owner writes use the zero-burn preflight helper, never method.send', async () => {
  const { readFile } = await import('node:fs/promises')
  const panel = await readFile(new URL('../src/TRXMainnetPanel.jsx', import.meta.url), 'utf8')
  const ownership = await readFile(new URL('../src/TRAXOwnershipControls.jsx', import.meta.url), 'utf8')
  const helper = await readFile(new URL('../src/trax-mainnet.mjs', import.meta.url), 'utf8')
  const allWrites = panel + '\n' + ownership
  const calls = allWrites.split('\n').filter(line => line.includes('sendAndVerifyContractCall('))
  assert.equal(calls.length, 12)
  assert.doesNotMatch(allWrites, /sendAndVerifyContractCall\(tronWeb,\s*token\.[A-Za-z0-9_]+\(/)
  assert.match(helper, /requestNode\(tronWeb, '\/wallet\/estimateenergy', request\)/)
  assert.match(helper, /requestNode\(tronWeb, '\/wallet\/triggerconstantcontract', request\)/)
  assert.match(helper, /assertZeroTrxBurnBudget\(initialBudget\)/)
  assert.match(helper, /assertZeroTrxBurnBudget\(finalBudget\)/)
  const writeHelper = helper.slice(helper.indexOf('export async function sendAndVerifyContractCall'), helper.indexOf('export async function sendNativeTrxFromTronLink'))
  assert.doesNotMatch(writeHelper, /getBalance\(|\/wallet\/getaccount['"]|method\.send\(/)
})
