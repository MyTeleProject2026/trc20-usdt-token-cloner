import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  broadcastValidatedSponsorTransaction,
  buildSponsorUnsignedTransaction,
  validateSponsorSignedTransaction,
} from '../server/sponsor-tron-submission.mjs'

const sponsorAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const receiverAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const tokenContract = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const now = 1_800_000_000_000
const rawDataHex = Buffer.from('fixed test raw data').toString('hex')
const txID = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex')

function response(status, value) {
  return { ok: status >= 200 && status < 300, status, async json() { return value } }
}

function fakeTronWeb(host) {
  return {
    fullNode: { host },
    address: {
      toHex(address) {
        const values = {
          [sponsorAddress]: '41' + '11'.repeat(20),
          [receiverAddress]: '41' + '22'.repeat(20),
          [tokenContract]: '41' + '33'.repeat(20),
        }
        if (!values[address]) throw new Error('bad-address')
        return values[address]
      },
    },
    transactionBuilder: {
      async sendTrx(to, amount, from) {
        return {
          txID,
          raw_data_hex: rawDataHex,
          raw_data: { contract: [{ type: 'TransferContract' }] },
          testBuilderArgs: { to, amount, from },
        }
      },
      async triggerSmartContract(contract, method, options, args, from) {
        return {
          result: { result: true },
          transaction: {
            txID,
            raw_data_hex: rawDataHex,
            testBuilderArgs: { contract, method, options, args, from },
          },
        }
      },
    },
  }
}

const transfer = (overrides = {}) => ({
  idempotencyKey: 'test-sponsor-transfer-00000001',
  status: 'pending-review',
  network: 'nile',
  purpose: 'asset-grant',
  asset: 'TRX',
  tokenContract: null,
  sponsorAddress,
  receiverAddress,
  amountBaseUnits: '1000000',
  ...overrides,
})

function signedTransfer(overrides = {}) {
  const amount = 1000000
  const raw = {
    timestamp: now,
    expiration: now + 60_000,
    contract: [{
      type: 'TransferContract',
      parameter: {
        type_url: 'type.googleapis.com/protocol.Transaction.Contract',
        value: {
          owner_address: '41' + '11'.repeat(20),
          to_address: '41' + '22'.repeat(20),
          amount,
        },
      },
    }],
  }
  const bytes = rawDataHex
  const hash = createHash('sha256').update(Buffer.from(bytes, 'hex')).digest('hex')
  return {
    txID: hash,
    raw_data_hex: bytes,
    raw_data: raw,
    signature: ['a'.repeat(130)],
    ...overrides,
  }
}

test('unsigned native transaction preparation is testnet-only and uses an exact integer amount', async () => {
  const result = await buildSponsorUnsignedTransaction({
    transfer: transfer(),
    tronWebFactory: fakeTronWeb,
  })
  assert.equal(result.success, true)
  assert.equal(result.status, 'unsigned-testnet-transaction-prepared')
  assert.equal(result.transaction.testBuilderArgs.amount, 1000000)
  assert.equal(result.canSubmitSponsoredTransfer, false)

  const mainnet = await buildSponsorUnsignedTransaction({
    transfer: transfer({ network: 'mainnet' }),
    tronWebFactory: fakeTronWeb,
  })
  assert.equal(mainnet.success, false)
  assert.equal(mainnet.reason, 'unsupported-testnet')
})

test('unsigned token transfer preparation fails closed if TronWeb reports build failure', async () => {
  const badFactory = (host) => ({
    ...fakeTronWeb(host),
    transactionBuilder: {
      async triggerSmartContract() { return { result: { result: false } } },
    },
  })
  const result = await buildSponsorUnsignedTransaction({
    transfer: transfer({ asset: 'USDT', tokenContract, amountBaseUnits: '1234567' }),
    env: {},
    tronWebFactory: badFactory,
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'unsigned-token-transaction-build-failed')
})

test('signature verification rejects an altered transaction id before contacting the node', async () => {
  let called = false
  const tx = signedTransfer({ txID: 'f'.repeat(64) })
  const result = await validateSponsorSignedTransaction({
    transfer: transfer(),
    signedTransaction: tx,
    env: {},
    now: () => now,
    fetchImpl: async () => { called = true; return response(200, {}) },
    tronWebFactory: fakeTronWeb,
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'transaction-id-mismatch')
  assert.equal(called, false)
})

test('signature verification rejects an intent mismatch before contacting the node', async () => {
  let called = false
  const result = await validateSponsorSignedTransaction({
    transfer: transfer({ amountBaseUnits: '1000001' }),
    signedTransaction: signedTransfer(),
    env: {},
    now: () => now,
    fetchImpl: async () => { called = true; return response(200, {}) },
    tronWebFactory: fakeTronWeb,
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'transaction-id-mismatch')
  assert.equal(called, false)
})

test('broadcast refuses Mainnet and never issues a request to a caller-supplied host', async () => {
  let calls = 0
  const result = await broadcastValidatedSponsorTransaction({
    network: 'mainnet',
    signedTransaction: { txID, raw_data_hex: rawDataHex },
    expectedTxID: txID,
    fetchImpl: async () => { calls += 1; return response(200, { result: true, txid: txID }) },
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'unsupported-testnet')
  assert.equal(calls, 0)
})

test('broadcast requires the node to accept the exact expected transaction id', async () => {
  const calls = []
  const result = await broadcastValidatedSponsorTransaction({
    network: 'nile',
    signedTransaction: { txID, raw_data_hex: rawDataHex, signature: ['a'.repeat(130)] },
    expectedTxID: txID,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return response(200, { result: true, txid: 'b'.repeat(64) })
    },
    env: {},
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'broadcast-not-confirmed-by-node')
  assert.equal(calls[0].url, 'https://nile.trongrid.io/wallet/broadcasttransaction')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.redirect, 'error')
})
