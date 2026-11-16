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
    estimateEnergy: async (_client, address, method, args, owner) => {
      estimateCalls += 1
      assert.equal(address, 'TToken')
      assert.equal(method.functionSelector, 'credit(address,uint256,bytes32)')
      assert.equal(owner, 'TOwner')
      assert.equal(args[1], '1000000')
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

test('exact-call Energy estimator uses estimateenergy and returns a validated result', async () => {
  let constantCalls = 0
  const tronWeb = {
    isAddress: value => value.startsWith('T'),
    address: { toHex: value => value },
    transactionBuilder: {
      estimateEnergy: async (contract, selector, options, params, owner) => {
        assert.equal(contract, 'TToken')
        assert.equal(selector, 'credit(address,uint256,bytes32)')
        assert.equal(owner, 'TOwner')
        assert.equal(options.parametersV2[1], '1000000')
        assert.deepEqual(params, [])
        return { result: { result: true }, energy_required: 321 }
      },
      triggerConstantContract: async () => {
        constantCalls += 1
        throw new Error('fallback should not execute')
      },
    },
  }
  const method = { abi: { name: 'credit' }, functionSelector: 'credit(address,uint256,bytes32)' }
  const result = await estimateMainnetContractCallEnergy(tronWeb, 'TToken', method, args, 'TOwner')
  assert.deepEqual(result, { energyUsed: '321', energyPenalty: '0' })
  assert.equal(constantCalls, 0)
})

test('exact-call Energy estimator falls back to read-only triggerconstantcontract on unsupported estimator', async () => {
  const calls = []
  const tronWeb = {
    isAddress: value => value.startsWith('T'),
    address: { toHex: value => value },
    transactionBuilder: {
      estimateEnergy: async () => { throw new Error('This node does not support estimate energy') },
      triggerConstantContract: async (contract, selector, options, params, owner) => {
        calls.push({ contract, selector, options, params, owner })
        return { result: { result: true }, energy_used: 654, energy_penalty: 12 }
      },
    },
  }
  const method = { abi: { name: 'credit' }, functionSelector: 'credit(address,uint256,bytes32)' }
  const result = await estimateMainnetContractCallEnergy(tronWeb, 'TToken', method, args, 'TOwner')
  assert.deepEqual(result, { energyUsed: '654', energyPenalty: '12' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.parametersV2[1], '1000000')
})
