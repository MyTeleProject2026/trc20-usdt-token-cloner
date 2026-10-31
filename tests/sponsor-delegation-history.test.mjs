import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createSponsorDelegationHistoryVerifier } from '../server/sponsor-delegation-history.mjs'

const feeSponsor = 'T' + 'A'.repeat(33)
const principal = 'T' + 'B'.repeat(33)
const receiver = 'T' + 'C'.repeat(33)
const feeHex = '41' + 'aa'.repeat(20)
const principalHex = '41' + 'bb'.repeat(20)
const receiverHex = '41' + 'cc'.repeat(20)
const blockId = (height, suffix) => height.toString(16).padStart(16, '0') + suffix.repeat(48)
const tx = (raw, contracts) => {
  const raw_data_hex = Buffer.from(raw).toString('hex')
  return {
    txID: createHash('sha256').update(Buffer.from(raw_data_hex, 'hex')).digest('hex'),
    raw_data_hex,
    raw_data: { contract: contracts },
  }
}
const transferTx = tx('solidified-transfer', [{
  type: 'TransferContract',
  parameter: { value: { owner_address: principalHex, to_address: receiverHex, amount: 2500000 } },
}])
const anchor = {
  blockNumber: 100,
  blockId: blockId(100, 'a'),
  blockTimestampMs: 1_000_000,
  checkedAt: new Date(1_000_001).toISOString(),
}
const preflightEvidence = {
  success: true,
  network: 'nile',
  sponsorAddress: principal,
  feeSponsorAddress: feeSponsor,
  solidifiedAnchor: anchor,
  delegationSnapshot: {
    feeSponsorAddress: feeSponsor,
    assetPrincipalAddress: principal,
    energyStakeSun: '10000000',
    bandwidthStakeSun: '20000000',
    energyExpiry: 0,
    bandwidthExpiry: 0,
    ownEnergySun: '0',
    incomingEnergyLegacySun: '0',
    incomingEnergyV2Sun: '10000000',
    ownBandwidthSun: '0',
    incomingBandwidthLegacySun: '0',
    incomingBandwidthV2Sun: '20000000',
  },
}
const transfer = { network: 'nile', sponsorAddress: principal, receiverAddress: receiver }

function block(height, parentHash, timestamp, transactions = []) {
  return {
    blockID: blockId(height, String.fromCharCode(97 + (height % 20))),
    block_header: { raw_data: { number: height, timestamp, parentHash } },
    transactions,
  }
}

function verifierFor({ blocks, secondaryBlocks = blocks, maxBlockSpan = 256 } = {}) {
  const calls = []
  const verifier = createSponsorDelegationHistoryVerifier({
    env: { TATUM_API_KEY: 'test-only-provider-key' },
    maxBlockSpan,
    tronWebFactory: async () => ({
      isAddress: (value) => [feeSponsor, principal, receiver].includes(value),
      address: { toHex: (value) => ({
        [feeSponsor]: feeHex,
        [principal]: principalHex,
        [receiver]: receiverHex,
      })[value] || '' },
    }),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      const number = JSON.parse(options.body).num
      const sourceBlocks = url.includes('nile.trongrid.io') ? secondaryBlocks : blocks
      const value = sourceBlocks[number]
      return { ok: Boolean(value), status: value ? 200 : 404, json: async () => value || {} }
    },
  })
  return { verifier, calls }
}

function standardBlocks({ middleTransactions = [], targetTransactions = [transferTx], breakParent = false } = {}) {
  const anchorBlock = block(100, '00'.repeat(32), 1_000_000)
  const middleBlock = block(101, breakParent ? 'ff'.repeat(32) : anchorBlock.blockID, 1_003_000, middleTransactions)
  const targetBlock = block(102, middleBlock.blockID, 1_006_000, targetTransactions)
  return { 100: anchorBlock, 101: middleBlock, 102: targetBlock }
}

async function run(verifier, overrides = {}) {
  return verifier({
    transfer,
    preflightEvidence,
    transactionHash: transferTx.txID,
    blockNumber: 102,
    blockTimestampMs: 1_006_000,
    ...overrides,
  })
}

test('solidified history replay verifies a complete unchanged interval and the exact transfer block', async () => {
  const { verifier, calls } = verifierFor({ blocks: standardBlocks() })
  const result = await run(verifier)
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(result.verified, true)
  assert.equal(result.status, 'verified')
  assert.equal(result.verificationMethod, 'solidified-delegation-history-replay')
  assert.equal(result.historyComplete, true)
  assert.equal(result.anchorStateVerified, true)
  assert.equal(result.noInterveningDelegationChanges, true)
  assert.equal(result.transactionHash, transferTx.txID)
  assert.equal(result.blockNumber, 102)
  assert.equal(result.blockTimestampMs, 1_006_000)
  assert.equal(result.scannedBlockCount, 2)
  assert.equal(calls.length, 6)
})

test('solidified history replay rejects a delegation change involving the fee sponsor or principal', async () => {
  const mutation = tx('fee-sponsor-undelegates', [{
    type: 'UnDelegateResourceContract',
    parameter: { value: {
      owner_address: feeHex, receiver_address: principalHex, resource: 'ENERGY', balance: 1000000,
    } },
  }])
  const { verifier } = verifierFor({ blocks: standardBlocks({ middleTransactions: [mutation] }) })
  const result = await run(verifier)
  assert.equal(result.success, false)
  assert.equal(result.reason, 'historical-delegation-state-changed-during-interval')
  assert.equal(result.contractType, 'UnDelegateResourceContract')
})

test('solidified history replay rejects any intervening stake-source mutation by a sponsor role', async () => {
  const mutation = tx('principal-stakes-own-energy', [{
    type: 'FreezeBalanceV2Contract',
    parameter: { value: { owner_address: principalHex, resource: 'ENERGY', frozen_balance: 5000000 } },
  }])
  const { verifier } = verifierFor({ blocks: standardBlocks({ middleTransactions: [mutation] }) })
  const result = await run(verifier)
  assert.equal(result.success, false)
  assert.equal(result.reason, 'historical-delegation-state-changed-during-interval')
  assert.equal(result.contractType, 'FreezeBalanceV2Contract')
})

test('solidified history replay rejects block and transaction-list disagreement between providers', async () => {
  const primary = standardBlocks()
  const secondary = standardBlocks()
  secondary[101] = {
    ...secondary[101],
    blockID: blockId(101, 'f'),
  }
  const { verifier } = verifierFor({ blocks: primary, secondaryBlocks: secondary })
  const result = await run(verifier)
  assert.equal(result.success, false)
  assert.equal(result.reason, 'historical-delegation-secondary-provider-disagreement')
  assert.equal(result.failedBlockNumber, 101)
})

test('solidified history replay rejects decoded contract payload disagreement between providers', async () => {
  const primary = standardBlocks()
  const secondary = standardBlocks()
  primary[101] = { ...primary[101], transactions: [transferTx] }
  secondary[101] = {
    ...secondary[101],
    transactions: [{
      ...transferTx,
      raw_data: {
        contract: [{
          type: 'DelegateResourceContract',
          parameter: { value: {
            owner_address: feeHex, receiver_address: receiverHex, resource: 'ENERGY', balance: 1,
          } },
        }],
      },
    }],
  }
  const { verifier } = verifierFor({ blocks: primary, secondaryBlocks: secondary })
  const result = await run(verifier)
  assert.equal(result.success, false)
  assert.equal(result.reason, 'historical-delegation-secondary-provider-disagreement')
  assert.equal(result.failedBlockNumber, 101)
})

test('solidified history replay rejects a provider that omits the block transaction list', async () => {
  const primary = standardBlocks()
  const secondary = standardBlocks()
  delete secondary[101].transactions
  const { verifier } = verifierFor({ blocks: primary, secondaryBlocks: secondary })
  const result = await run(verifier)
  assert.equal(result.success, false)
  assert.equal(result.reason, 'historical-delegation-secondary-provider-disagreement')
  assert.equal(result.failedBlockNumber, 101)
})

test('solidified history replay rejects a broken parent-hash chain', async () => {
  const { verifier } = verifierFor({ blocks: standardBlocks({ breakParent: true }) })
  const result = await run(verifier)
  assert.equal(result.success, false)
  assert.equal(result.reason, 'historical-delegation-block-chain-incomplete')
  assert.equal(result.failedBlockNumber, 101)
})

test('solidified history replay rejects malformed transaction identifiers rather than skipping a block entry', async () => {
  const invalid = { ...transferTx, txID: 'f'.repeat(64) }
  const { verifier } = verifierFor({ blocks: standardBlocks({ targetTransactions: [invalid] }) })
  const result = await run(verifier)
  assert.equal(result.success, false)
  assert.equal(result.reason, 'historical-delegation-transaction-id-invalid')
})

test('solidified history replay rejects a target transaction absent from its claimed block', async () => {
  const { verifier } = verifierFor({ blocks: standardBlocks({ targetTransactions: [] }) })
  const result = await run(verifier)
  assert.equal(result.success, false)
  assert.equal(result.reason, 'historical-delegation-target-block-or-transaction-mismatch')
})

test('solidified history replay rejects an interval above its bounded scan maximum', async () => {
  const { verifier } = verifierFor({ blocks: {}, maxBlockSpan: 1 })
  const result = await run(verifier)
  assert.equal(result.success, false)
  assert.equal(result.reason, 'historical-delegation-block-span-exceeds-limit')
})
