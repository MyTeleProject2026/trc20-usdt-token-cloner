import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import express from 'express'
import { TronWeb } from 'tronweb'
import { createRestrictedTrxEscrowVerificationRouter } from '../server/routes/restricted-trx-escrow-verification.mjs'

const beneficiary = 'TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT'
const owner = beneficiary
const ownerHex = TronWeb.address.toHex(owner)
const contractHex = '41' + 'c'.repeat(40)
const contract = TronWeb.address.fromHex(contractHex)
const txid = 'a'.repeat(64)
const requestId = 'b'.repeat(64)
const amountSun = 6200000000n
const unlockAt = 1900000000n
const word = (value) => BigInt(value).toString(16).padStart(64, '0')
const beneficiaryWord = '0'.repeat(24) + ownerHex.replace(/^41/i, '').toLowerCase()
const fundSelector = TronWeb.sha3('fundPosition(bytes32,address,uint64)').slice(2, 10).toLowerCase()
const eventTopic = TronWeb.sha3('PositionFunded(bytes32,address,uint256,uint64)').toLowerCase()

function createEvidenceClient() {
  const transaction = {
    txID: txid,
    raw_data: { contract: [{
      type: 'TriggerSmartContract',
      parameter: { value: {
        contract_address: contractHex,
        owner_address: ownerHex,
        call_value: amountSun.toString(),
        data: fundSelector + requestId + beneficiaryWord + word(3600),
      } },
    }] },
  }
  const receipt = {
    id: txid,
    blockNumber: 100,
    receipt: { result: 'SUCCESS' },
    log: [{
      address: contractHex,
      topics: [eventTopic, '0x' + requestId, '0x' + beneficiaryWord],
      data: word(amountSun) + word(unlockAt),
    }],
  }
  return {
    async getContractRuntimeCode() { return { runtimeCode: '60016000' } },
    async getSolidifiedTransaction() {
      return { found: true, solidifiedReceiptFound: true, transaction, receipt }
    },
    async getSolidifiedAccount() {
      return { balanceSun: '7000000000' }
    },
    async triggerSolidifiedConstantContract({ functionSelector }) {
      if (functionSelector === 'getPosition(bytes32)') {
        return { resultHex: beneficiaryWord + word(amountSun) + word(unlockAt) + word(0) }
      }
      if (functionSelector === 'totalLockedSun()') return { resultHex: word(amountSun) }
      if (functionSelector === 'provider()') return { resultHex: beneficiaryWord }
      if (functionSelector === 'restrictedBeneficiary()') return { resultHex: beneficiaryWord }
      throw new Error('unexpected constant function')
    },
  }
}

async function withServer(t, router, callback) {
  const app = express()
  app.use('/api/restricted-trx/escrow', router)
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  await callback('http://127.0.0.1:' + address.port)
}

function makeRouter({ sessionAddress = owner, publicClient = createEvidenceClient() } = {}) {
  return createRestrictedTrxEscrowVerificationRouter({
    env: {
      TREASURY_OWNER_ADDRESS: owner,
      RESTRICTED_TRX_ESCROW_CONTRACT: contract,
      RESTRICTED_TRX_BENEFICIARY_ADDRESS: beneficiary,
      RESTRICTED_TRX_ESCROW_RUNTIME_CODE_SHA256: createHash('sha256').update('60016000', 'hex').digest('hex'),
    },
    getSession: async ({ origin }) => ({
      success: true,
      session: { address: sessionAddress, network: 'mainnet', origin },
    }),
    publicClient,
    now: () => 1900000000000,
  })
}

test('owner verification route confirms on-chain escrow evidence using solidified reads', async (t) => {
  await withServer(t, makeRouter(), async (baseUrl) => {
    const response = await fetch(baseUrl + '/verify/0x' + requestId + '/' + txid, {
      headers: {
        Authorization: 'Bearer ' + 'A'.repeat(43),
        Origin: 'https://tron-transfer.example',
      },
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.verified, true)
    assert.equal(payload.result.amountSun, amountSun.toString())
    assert.equal(payload.bitpieWalletBalanceChanged, false)
  })
})

test('owner verification route denies sessions for a different wallet', async (t) => {
  await withServer(t, makeRouter({ sessionAddress: contract }), async (baseUrl) => {
    const response = await fetch(baseUrl + '/verify/0x' + requestId + '/' + txid, {
      headers: {
        Authorization: 'Bearer ' + 'A'.repeat(43),
        Origin: 'https://tron-transfer.example',
      },
    })
    assert.equal(response.status, 403)
  })
})

test('owner verification route rejects malformed identifiers before node calls', async (t) => {
  let calls = 0
  const client = {
    async getSolidifiedTransaction() { calls++; throw new Error('should not query') },
    async getSolidifiedAccount() { calls++; throw new Error('should not query') },
    async triggerSolidifiedConstantContract() { calls++; throw new Error('should not query') },
  }
  await withServer(t, makeRouter({ publicClient: client }), async (baseUrl) => {
    const response = await fetch(baseUrl + '/verify/not-a-request/' + txid, {
      headers: {
        Authorization: 'Bearer ' + 'A'.repeat(43),
        Origin: 'https://tron-transfer.example',
      },
    })
    assert.equal(response.status, 400)
    assert.equal(calls, 0)
  })
})

test('owner verification rejects a contract whose deployed runtime hash does not match the audited pin', async (t) => {
  const client = createEvidenceClient()
  client.getContractRuntimeCode = async () => ({ runtimeCode: '6002' })
  await withServer(t, makeRouter({ publicClient: client }), async (baseUrl) => {
    const response = await fetch(baseUrl + '/verify/0x' + requestId + '/' + txid, {
      headers: {
        Authorization: 'Bearer ' + 'A'.repeat(43),
        Origin: 'https://tron-transfer.example',
      },
    })
    const payload = await response.json()
    assert.equal(response.status, 409)
    assert.equal(payload.error, 'escrow-runtime-code-hash-mismatch')
    assert.equal(payload.creditableAmountSun, '0')
  })
})

test('owner verification rejects a contract pinned to a different beneficiary address', async (t) => {
  const client = createEvidenceClient()
  const original = client.triggerSolidifiedConstantContract
  client.triggerSolidifiedConstantContract = async (args) => {
    if (args.functionSelector === 'restrictedBeneficiary()') {
      return { resultHex: '0'.repeat(24) + 'd'.repeat(40) }
    }
    return original(args)
  }
  await withServer(t, makeRouter({ publicClient: client }), async (baseUrl) => {
    const response = await fetch(baseUrl + '/verify/0x' + requestId + '/' + txid, {
      headers: {
        Authorization: 'Bearer ' + 'A'.repeat(43),
        Origin: 'https://tron-transfer.example',
      },
    })
    const payload = await response.json()
    assert.equal(response.status, 409)
    assert.equal(payload.error, 'configured-beneficiary-does-not-match-immutable-contract-beneficiary')
    assert.equal(payload.creditableAmountSun, '0')
  })
})
