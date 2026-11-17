import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyExistingMainnetDeployment, verifySolidifiedDeploymentTransaction } from '../src/trax-mainnet.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const contractAddress = 'TContractAddress111111111111111111'
const txID = 'a'.repeat(64)
const runtime = '6001600055'

function makeClient({ runtimeCode = runtime, deployedOwner = owner, metadata = ['TRӾ', 'TRӾ', 6] } = {}) {
  return {
    isAddress: value => typeof value === 'string' && value.startsWith('T'),
    address: { toHex: value => value, fromHex: value => value },
    trx: { getContractInfo: async () => ({ runtimecode: runtimeCode }) },
    contract: () => ({
      at: async () => ({
        name: () => ({ call: async () => metadata[0] }),
        symbol: () => ({ call: async () => metadata[1] }),
        decimals: () => ({ call: async () => metadata[2] }),
      }),
    }),
    _deployedOwner: deployedOwner,
  }
}

const artifact = { abi: [], deployedBytecode: runtime }

test('recovers an already-broadcast deployment from solidified receipt, exact runtime, owner and metadata', async () => {
  const client = makeClient()
  const result = await verifyExistingMainnetDeployment(client, {
    txID, ownerAddress: owner, artifact, contractAddress,
  }, {
    waitForReceipt: async (_client, requestedTxID) => ({
      id: requestedTxID, receipt: { result: 'SUCCESS' }, blockNumber: 100,
    }),
    verifyDeployedContract: async () => ({ runtimecode: runtime }),
    verifyDeployedOwner: async () => owner,
  })
  assert.equal(result.verified, true)
  assert.equal(result.network, 'mainnet')
  assert.equal(result.address, contractAddress)
  assert.equal(result.txID, txID)
  assert.equal(result.owner, owner)
})

test('refuses recovery when the solidified transaction receipt is not successful', async () => {
  const client = makeClient()
  await assert.rejects(
    verifyExistingMainnetDeployment(client, {
      txID, ownerAddress: owner, artifact, contractAddress,
    }, {
      waitForReceipt: async () => ({ id: txID, receipt: { result: 'FAILED' } }),
      verifyDeployedContract: async () => ({ runtimecode: runtime }),
      verifyDeployedOwner: async () => owner,
    }),
    /not confirmed successful/
  )
})

test('refuses recovery when deployed runtime bytecode differs from the compiled artifact', async () => {
  const client = makeClient()
  await assert.rejects(
    verifyExistingMainnetDeployment(client, {
      txID, ownerAddress: owner, artifact, contractAddress,
    }, {
      waitForReceipt: async () => ({ id: txID, receipt: { result: 'SUCCESS' } }),
      verifyDeployedContract: async () => ({ runtimecode: '6002600055' }),
      verifyDeployedOwner: async () => owner,
    }),
    /exact compiled TRӾ runtime bytecode/
  )
})

test('refuses recovery when the deployed contract owner is not the configured owner wallet', async () => {
  const client = makeClient()
  await assert.rejects(
    verifyExistingMainnetDeployment(client, {
      txID, ownerAddress: owner, artifact, contractAddress,
    }, {
      waitForReceipt: async () => ({ id: txID, receipt: { result: 'SUCCESS' } }),
      verifyDeployedContract: async () => ({ runtimecode: runtime }),
      verifyDeployedOwner: async () => 'TOtherOwnerAddress1111111111111111',
    }),
    /does not match the configured TRӾ owner/
  )
})

test('refuses recovery when TRӾ name, symbol or decimals do not match', async () => {
  const client = makeClient({ metadata: ['Wrong name', 'TRӾ', 6] })
  await assert.rejects(
    verifyExistingMainnetDeployment(client, {
      txID, ownerAddress: owner, artifact, contractAddress,
    }, {
      waitForReceipt: async () => ({ id: txID, receipt: { result: 'SUCCESS' } }),
      verifyDeployedContract: async () => ({ runtimecode: runtime }),
      verifyDeployedOwner: async () => owner,
    }),
    /Expected TRӾ \/ TRӾ \/ 6 decimals/
  )
})

function solidifiedCreateTransaction({ txOwner = owner, bytecode = runtime, abi = [] } = {}) {
  return {
    txID,
    raw_data: {
      contract: [{
        type: 'CreateSmartContract',
        parameter: {
          type_url: 'type.googleapis.com/protocol.CreateSmartContract',
          value: {
            owner_address: txOwner,
            new_contract: { bytecode, abi: { entrys: abi } },
          },
        },
      }],
    },
  }
}

test('accepts the exact authorized CreateSmartContract transaction from solidified Mainnet', async () => {
  const result = await verifySolidifiedDeploymentTransaction(makeClient(), {
    txID, ownerAddress: owner, artifact: { bytecode: runtime, abi: [] },
  }, { fetchSolidifiedTransaction: async () => solidifiedCreateTransaction() })
  assert.equal(result.txID, txID)
  assert.equal(result.owner, owner)
  assert.equal(result.bytecodeVerified, true)
  assert.equal(result.abiVerified, true)
})

test('rejects a solidified deployment transaction signed by another owner', async () => {
  await assert.rejects(
    verifySolidifiedDeploymentTransaction(makeClient(), {
      txID, ownerAddress: owner, artifact: { bytecode: runtime, abi: [] },
    }, { fetchSolidifiedTransaction: async () => solidifiedCreateTransaction({ txOwner: 'TOtherOwner' }) }),
    /does not match the authorized TronLink wallet/
  )
})

test('rejects a solidified transaction containing altered creation bytecode', async () => {
  await assert.rejects(
    verifySolidifiedDeploymentTransaction(makeClient(), {
      txID, ownerAddress: owner, artifact: { bytecode: runtime, abi: [] },
    }, { fetchSolidifiedTransaction: async () => solidifiedCreateTransaction({ bytecode: '6002600055' }) }),
    /does not match the approved TRӾ artifact/
  )
})

test('rejects a solidified transaction containing a different ABI', async () => {
  await assert.rejects(
    verifySolidifiedDeploymentTransaction(makeClient(), {
      txID, ownerAddress: owner, artifact: { bytecode: runtime, abi: [] },
    }, { fetchSolidifiedTransaction: async () => solidifiedCreateTransaction({ abi: [{ type: 'function', name: 'unexpected' }] }) }),
    /ABI does not match the approved TRӾ artifact/
  )
})

test('rejects a solidified transaction with an unexpected contract operation', async () => {
  await assert.rejects(
    verifySolidifiedDeploymentTransaction(makeClient(), {
      txID, ownerAddress: owner, artifact: { bytecode: runtime, abi: [] },
    }, { fetchSolidifiedTransaction: async () => ({ txID, raw_data: { contract: [{ type: 'TransferContract' }] } }) }),
    /not exactly one TRON CreateSmartContract/
  )
})
