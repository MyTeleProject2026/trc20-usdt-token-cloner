import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { TronWeb } from 'tronweb'
import {
  classifySponsorDirectSettlement,
  verifySponsorDirectMainnetTransfer,
} from '../server/routes/sponsor-direct-payouts.mjs'
import {
  buildOwnerUsdtTransferParameter,
  MAINNET_USDT_CONTRACT,
} from '../server/routes/tron-owner-withdrawals.mjs'

const sponsorAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const recipientAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const transactionHash = 'a'.repeat(64)
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const tronWeb = new TronWeb({ fullHost: 'https://tron-mainnet.gateway.tatum.io' })

function transfer(overrides = {}) {
  return {
    transaction_hash: transactionHash,
    sponsor_address: sponsorAddress,
    recipient_address: recipientAddress,
    token_contract: MAINNET_USDT_CONTRACT,
    amount_base_units: '25000000',
    ...overrides,
  }
}

function verified(overrides = {}) {
  return {
    verified: true,
    transactionHash,
    contract: MAINNET_USDT_CONTRACT,
    from: sponsorAddress,
    to: recipientAddress,
    amountBaseUnits: '25000000',
    blockNumber: 123456,
    logIndex: 0,
    ...overrides,
  }
}

test('settlement classifier confirms only exact solidified Mainnet USDT evidence', () => {
  assert.deepEqual(
    classifySponsorDirectSettlement({ transfer: transfer(), verification: verified() }),
    { status: 'confirmed', blockNumber: 123456, logIndex: 0, reason: null },
  )
})

test('settlement classifier sends any transaction identity mismatch to manual review', () => {
  const result = classifySponsorDirectSettlement({
    transfer: transfer(),
    verification: verified({ to: sponsorAddress }),
  })
  assert.equal(result.status, 'manual-review')
  assert.equal(result.reason, 'solidified-evidence-identity-mismatch')
})

test('settlement classifier keeps an unsolidified receipt pending', () => {
  const result = classifySponsorDirectSettlement({
    transfer: transfer(),
    verification: { verified: false, status: 'awaiting-solidified-receipt' },
  })
  assert.equal(result.status, 'pending')
  assert.equal(result.reason, 'awaiting-solidified-receipt')
})

test('settlement classifier marks a solidified failed transaction as failed', () => {
  const result = classifySponsorDirectSettlement({
    transfer: transfer(),
    verification: { verified: false, status: 'solidified-transaction-failed' },
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'confirmed-solidified-transaction-failed')
})

test('settlement classifier sends a malformed stored intent to manual review', () => {
  const result = classifySponsorDirectSettlement({
    transfer: transfer({ token_contract: recipientAddress }),
    verification: verified(),
  })
  assert.equal(result.status, 'manual-review')
  assert.equal(result.reason, 'stored-settlement-intent-invalid')
})

test('settlement classifier never treats provider errors or missing evidence as confirmation', () => {
  const result = classifySponsorDirectSettlement({
    transfer: transfer(),
    verification: { verified: false, status: 'solidified-provider-unavailable' },
  })
  assert.equal(result.status, 'pending')
})

function makeSolidifiedFixture({ recipient = recipientAddress, amountBaseUnits = '25000000', duplicateLog = false } = {}) {
  const fromHex = tronWeb.address.toHex(sponsorAddress)
  const toHex = tronWeb.address.toHex(recipient)
  const contractHex = tronWeb.address.toHex(MAINNET_USDT_CONTRACT)
  const parameter = buildOwnerUsdtTransferParameter(recipient, amountBaseUnits, tronWeb)
  const rawDataHex = '0a02abcd'
  const txHash = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex')
  const event = {
    address: contractHex,
    topics: [
      TRANSFER_TOPIC,
      fromHex.replace(/^41/i, '').padStart(64, '0'),
      toHex.replace(/^41/i, '').padStart(64, '0'),
    ],
    data: BigInt(amountBaseUnits).toString(16).padStart(64, '0'),
  }
  const transaction = {
    txID: txHash,
    raw_data_hex: rawDataHex,
    raw_data: {
      contract: [{
        type: 'TriggerSmartContract',
        parameter: {
          value: {
            owner_address: fromHex,
            contract_address: contractHex,
            call_value: 0,
            data: 'a9059cbb' + parameter,
          },
        },
      }],
    },
    ret: [{ contractRet: 'SUCCESS' }],
  }
  const receipt = {
    id: txHash,
    blockNumber: 123456,
    result: 'SUCCESS',
    receipt: { result: 'SUCCESS' },
    log: duplicateLog ? [event, event] : [event],
  }
  return { transaction, receipt, txHash }
}

test('Mainnet verifier checks exact sponsor transaction body and solidified Transfer event', async () => {
  const fixture = makeSolidifiedFixture()
  const result = await verifySponsorDirectMainnetTransfer(
    { TATUM_API_KEY: 'test-key' },
    { transactionHash: fixture.txHash, from: sponsorAddress, to: recipientAddress, amountBaseUnits: '25000000' },
    {
      tronWebFactory: async () => tronWeb,
      providerPost: async (_env, path) => path.endsWith('gettransactionbyid') ? fixture.transaction : fixture.receipt,
    },
  )
  assert.equal(result.verified, true)
  assert.equal(result.transactionHash, fixture.txHash)
  assert.equal(result.contract, MAINNET_USDT_CONTRACT)
  assert.equal(result.from, sponsorAddress)
  assert.equal(result.to, recipientAddress)
  assert.equal(result.amountBaseUnits, '25000000')
  assert.equal(result.blockNumber, 123456)
  assert.equal(result.logIndex, 0)
})

test('Mainnet verifier rejects a mismatched transaction body', async () => {
  const fixture = makeSolidifiedFixture({ recipient: sponsorAddress })
  const result = await verifySponsorDirectMainnetTransfer(
    { TATUM_API_KEY: 'test-key' },
    { transactionHash: fixture.txHash, from: sponsorAddress, to: recipientAddress, amountBaseUnits: '25000000' },
    {
      tronWebFactory: async () => tronWeb,
      providerPost: async (_env, path) => path.endsWith('gettransactionbyid') ? fixture.transaction : fixture.receipt,
    },
  )
  assert.equal(result.verified, false)
  assert.equal(result.status, 'solidified-transfer-mismatch')
})

test('Mainnet verifier rejects duplicate matching Transfer events as ambiguous', async () => {
  const fixture = makeSolidifiedFixture({ duplicateLog: true })
  const result = await verifySponsorDirectMainnetTransfer(
    { TATUM_API_KEY: 'test-key' },
    { transactionHash: fixture.txHash, from: sponsorAddress, to: recipientAddress, amountBaseUnits: '25000000' },
    {
      tronWebFactory: async () => tronWeb,
      providerPost: async (_env, path) => path.endsWith('gettransactionbyid') ? fixture.transaction : fixture.receipt,
    },
  )
  assert.equal(result.verified, false)
  assert.equal(result.status, 'ambiguous-transfer-event')
})
