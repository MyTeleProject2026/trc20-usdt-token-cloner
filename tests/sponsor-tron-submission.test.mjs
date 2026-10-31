import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  broadcastValidatedSponsorTransaction,
  buildSponsorUnsignedTransaction,
  validateSponsorSignedTransaction,
  verifySponsorFeeResourceCapacity,
  verifySponsorFeeResourceSource,
} from '../server/sponsor-tron-submission.mjs'

const sponsorAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const receiverAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const tokenContract = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const feeSponsorAddress = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const now = 1_800_000_000_000
const rawDataHex = Buffer.from('fixed test raw data').toString('hex')
const txID = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex')

function response(status, value) {
  return { ok: status >= 200 && status < 300, status, async json() { return value } }
}

function solidifiedHead() {
  return response(200, {
    blockID: '0000000000000064' + 'ab'.repeat(24),
    block_header: { raw_data: { number: 100, timestamp: now - 1000, parentHash: '00'.repeat(32) } },
  })
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
          [feeSponsorAddress]: '41' + '44'.repeat(20),
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
        type_url: 'type.googleapis.com/protocol.TransferContract',
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
  assert.equal(result.reason, 'transaction-transfer-intent-mismatch')
  assert.equal(called, false)
})

test('signature validation refuses multi-signature transfers when the fee budget covers only delegated resources', async () => {
  let providerCalled = false
  const result = await validateSponsorSignedTransaction({
    transfer: transfer(),
    signedTransaction: signedTransfer({ signature: ['a'.repeat(130), 'b'.repeat(130)] }),
    env: {},
    now: () => now,
    fetchImpl: async () => { providerCalled = true; return response(200, {}) },
    tronWebFactory: fakeTronWeb,
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'multisignature-not-covered-by-fee-sponsor-resource-policy')
  assert.equal(providerCalled, false)
})

test('signed exact sponsor intent is verified against the selected testnet node before broadcast', async () => {
  const calls = []
  const result = await validateSponsorSignedTransaction({
    transfer: transfer(),
    signedTransaction: signedTransfer(),
    env: {},
    now: () => now,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return response(200, { result: { code: 'ENOUGH_PERMISSION' }, permission: { threshold: 1 }, current_weight: 1 })
    },
    tronWebFactory: fakeTronWeb,
  })
  assert.equal(result.success, true)
  assert.equal(result.status, 'sponsor-signature-verified')
  assert.equal(result.signaturePermissionVerified, true)
  assert.equal(calls[0].url, 'https://nile.trongrid.io/wallet/getsignweight')
  assert.equal(calls[0].options.redirect, 'error')
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


test('signed transaction JSON must match the exact persisted unsigned signing intent', async () => {
  let called = false
  const original = signedTransfer()
  const altered = signedTransfer({
    raw_data: {
      ...original.raw_data,
      contract: [{
        ...original.raw_data.contract[0],
        parameter: {
          ...original.raw_data.contract[0].parameter,
          value: { ...original.raw_data.contract[0].parameter.value, amount: 2000000 },
        },
      }],
    },
  })
  const result = await validateSponsorSignedTransaction({
    transfer: transfer(),
    signedTransaction: altered,
    expectedUnsignedTransaction: original,
    env: {},
    now: () => now,
    fetchImpl: async () => { called = true; return response(200, {}) },
    tronWebFactory: fakeTronWeb,
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'signed-transaction-does-not-match-persisted-signing-intent')
  assert.equal(called, false)
})

test('native sponsor capacity requires active fee-sponsor delegation and does not count free quota', async () => {
  const transaction = {
    txID,
    raw_data_hex: rawDataHex,
    raw_data: { expiration: now + 60_000, contract: [{ type: 'TransferContract', parameter: { value: {} } }] },
  }
  const principalHex = '41' + '11'.repeat(20)
  const receiverHex = '41' + '22'.repeat(20)
  const feeHex = '41' + '44'.repeat(20)
  const account = {
    address: principalHex,
    frozenV2: [],
    acquired_delegated_frozenV2_balance_for_bandwidth: '1000000',
    acquired_delegated_frozen_balance_for_bandwidth: '0',
    account_resource: {
      acquired_delegated_frozenV2_balance_for_energy: '1000000',
      acquired_delegated_frozen_balance_for_energy: '0',
    },
  }
  const delegation = {
    delegatedResource: [{
      from: feeHex, to: principalHex,
      frozen_balance_for_bandwidth: '1000000',
      frozen_balance_for_energy: '1000000',
      expire_time_for_bandwidth: 0,
      expire_time_for_energy: 0,
    }],
  }
  const baseEnv = { SPONSOR_FEE_NILE_ADDRESS: feeSponsorAddress }
  const enough = await verifySponsorFeeResourceCapacity({
    transfer: transfer(),
    transaction,
    env: baseEnv,
    tronWebFactory: fakeTronWeb,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/walletsolidity/getnowblock')) return solidifiedHead()
      if (url.endsWith('/walletsolidity/getaccount')) {
        const body = JSON.parse(options.body)
        return response(200, body.address === receiverHex ? { address: receiverHex } : account)
      }
      if (url.endsWith('/walletsolidity/getdelegatedresourcev2')) return response(200, delegation)
      return response(200, {
        NetLimit: 10000, NetUsed: 0, freeNetLimit: 1000, freeNetUsed: 0,
        EnergyLimit: 100000, EnergyUsed: 0,
      })
    },
  })
  assert.equal(enough.success, true)
  assert.equal(enough.status, 'sponsor-resource-capacity-verified')
  assert.equal(enough.feeSponsorResourceSourceVerified, true)
  assert.equal(enough.freeBandwidthUsedAsSponsorCoverage, false)
  assert.ok(BigInt(enough.availableBandwidthUnits) >= BigInt(enough.requiredBandwidthUnits))

  const freeQuotaOnly = await verifySponsorFeeResourceCapacity({
    transfer: transfer(),
    transaction,
    env: baseEnv,
    tronWebFactory: fakeTronWeb,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/walletsolidity/getnowblock')) return solidifiedHead()
      if (url.endsWith('/walletsolidity/getaccount')) {
        const body = JSON.parse(options.body)
        return response(200, body.address === receiverHex ? { address: receiverHex } : account)
      }
      if (url.endsWith('/walletsolidity/getdelegatedresourcev2')) return response(200, delegation)
      return response(200, {
        NetLimit: 1, NetUsed: 1, freeNetLimit: 10000, freeNetUsed: 0,
        EnergyLimit: 0, EnergyUsed: 0,
      })
    },
  })
  assert.equal(freeQuotaOnly.success, false)
  assert.equal(freeQuotaOnly.reason, 'sponsor-bandwidth-capacity-insufficient')
})

test('sponsor capacity refuses to attribute principal self-stake to the separate fee sponsor', async () => {
  const transaction = {
    txID, raw_data_hex: rawDataHex,
    raw_data: { expiration: now + 60_000, contract: [{ type: 'TransferContract', parameter: { value: {} } }] },
  }
  const principalHex = '41' + '11'.repeat(20)
  const receiverHex = '41' + '22'.repeat(20)
  const feeHex = '41' + '44'.repeat(20)
  const account = {
    address: principalHex,
    frozenV2: [{ amount: '2000000' }],
    acquired_delegated_frozenV2_balance_for_bandwidth: '1000000',
    account_resource: { acquired_delegated_frozenV2_balance_for_energy: '1000000' },
  }
  const delegation = { delegatedResource: [{
    from: feeHex, to: principalHex,
    frozen_balance_for_bandwidth: '1000000', frozen_balance_for_energy: '1000000',
    expire_time_for_bandwidth: 0, expire_time_for_energy: 0,
  }] }
  const result = await verifySponsorFeeResourceCapacity({
    transfer: transfer(), transaction, env: { SPONSOR_FEE_NILE_ADDRESS: feeSponsorAddress },
    tronWebFactory: fakeTronWeb,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/walletsolidity/getnowblock')) return solidifiedHead()
      if (url.endsWith('/walletsolidity/getaccount')) {
        const body = JSON.parse(options.body)
        return response(200, body.address === receiverHex ? { address: receiverHex } : account)
      }
      if (url.endsWith('/walletsolidity/getdelegatedresourcev2')) return response(200, delegation)
      return response(200, { NetLimit: 10000, NetUsed: 0, EnergyLimit: 100000, EnergyUsed: 0 })
    },
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'fee-sponsor-only-bandwidth-source-required')
})

test('native sponsor capacity rejects an unactivated or unverifiable recipient before resource preflight', async () => {
  const transaction = {
    txID,
    raw_data_hex: rawDataHex,
    raw_data: { expiration: now + 60_000, contract: [{ type: 'TransferContract', parameter: { value: {} } }] },
  }
  let resourceQueryMade = false
  const result = await verifySponsorFeeResourceCapacity({
    transfer: transfer(),
    transaction,
    env: {},
    tronWebFactory: fakeTronWeb,
    fetchImpl: async (url) => {
      if (url.endsWith('/walletsolidity/getaccount')) return response(200, {})
      if (url.endsWith('/wallet/getaccountresource')) resourceQueryMade = true
      return response(200, {
        NetLimit: 10000, NetUsed: 0, freeNetLimit: 1000, freeNetUsed: 0,
        EnergyLimit: 0, EnergyUsed: 0,
      })
    },
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'sponsor-recipient-account-not-active')
  assert.equal(result.receiverAccountActivated, false)
  assert.equal(resourceQueryMade, false)
})

test('TRC20 sponsor capacity fails closed when live constant-contract simulation cannot estimate energy', async () => {
  const tokenTransfer = transfer({ asset: 'USDT', tokenContract, amountBaseUnits: '1000' })
  const transaction = {
    txID,
    raw_data_hex: rawDataHex,
    raw_data: {
      fee_limit: 10000000,
      contract: [{
        type: 'TriggerSmartContract',
        parameter: { value: { contract_address: '41' + '33'.repeat(20), data: 'a9059cbb' + '0'.repeat(128) } },
      }],
    },
  }
  const principalHex = '41' + '11'.repeat(20)
  const receiverHex = '41' + '22'.repeat(20)
  const feeHex = '41' + '44'.repeat(20)
  const account = {
    address: principalHex,
    frozenV2: [],
    acquired_delegated_frozenV2_balance_for_bandwidth: '1000000',
    account_resource: { acquired_delegated_frozenV2_balance_for_energy: '1000000' },
  }
  const delegation = { delegatedResource: [{
    from: feeHex, to: principalHex,
    frozen_balance_for_bandwidth: '1000000', frozen_balance_for_energy: '1000000',
    expire_time_for_bandwidth: 0, expire_time_for_energy: 0,
  }] }
  const result = await verifySponsorFeeResourceCapacity({
    transfer: tokenTransfer,
    transaction,
    env: { SPONSOR_FEE_NILE_ADDRESS: feeSponsorAddress },
    tronWebFactory: fakeTronWeb,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/walletsolidity/getnowblock')) return solidifiedHead()
      if (url.endsWith('/walletsolidity/getaccount')) {
        const body = JSON.parse(options.body)
        return response(200, body.address === receiverHex ? { address: receiverHex } : account)
      }
      if (url.endsWith('/walletsolidity/getdelegatedresourcev2')) return response(200, delegation)
      if (url.endsWith('/wallet/getaccountresource')) return response(200, {
        NetLimit: 10000, NetUsed: 0, freeNetLimit: 1000, freeNetUsed: 0,
        EnergyLimit: 100000, EnergyUsed: 0,
      })
      return response(200, { result: { result: false }, energy_used: 20000 })
    },
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'token-energy-estimate-unavailable')
})


test('post-solidification source snapshot is explicitly not historical delegation proof', async () => {
  const principalHex = '41' + '11'.repeat(20)
  const feeHex = '41' + '44'.repeat(20)
  const principalAccount = {
    address: principalHex,
    frozenV2: [],
    frozen: [],
    acquired_delegated_frozenV2_balance_for_bandwidth: '1000000',
    acquired_delegated_frozen_balance_for_bandwidth: '0',
    account_resource: {
      frozen_balance_for_energy: { frozen_balance: '0' },
      acquired_delegated_frozenV2_balance_for_energy: '1000000',
      acquired_delegated_frozen_balance_for_energy: '0',
    },
  }
  const delegation = {
    from: feeHex, to: principalHex,
    frozen_balance_for_bandwidth: '1000000',
    frozen_balance_for_energy: '1000000',
    expire_time_for_bandwidth: 0,
    expire_time_for_energy: 0,
  }
  const result = await verifySponsorFeeResourceSource({
    transfer: transfer({ status: 'confirmed', asset: 'USDT', tokenContract }),
    env: { SPONSOR_FEE_NILE_ADDRESS: feeSponsorAddress },
    tronWebFactory: fakeTronWeb,
    fetchImpl: async (url) => response(200,
      url.endsWith('/walletsolidity/getaccount') ? principalAccount
        : { delegatedResource: [delegation] }),
  })
  assert.equal(result.success, true)
  assert.equal(result.feeSponsorResourceSourceVerified, true)
  assert.equal(result.sponsorAddress, sponsorAddress)
  assert.equal(result.feeSponsorAddress, feeSponsorAddress)
  assert.equal(result.bandwidthCoverageSource, 'exact-active-fee-sponsor-delegation-only')
  assert.equal(result.energyCoverageSource, 'exact-active-fee-sponsor-delegation-only')
  assert.equal(result.freeBandwidthUsedAsSponsorCoverage, false)
  assert.equal(result.historicalDelegationStateVerified, false)
  assert.equal(result.historicalDelegationProof, null)
  assert.equal(result.historicalDelegationProofReason,
    'solidified-node-delegation-query-does-not-read-state-at-an-arbitrary-block')
  assert.equal(result.delegationSnapshot.bandwidthStakeSun, '1000000')
  assert.equal(result.delegationSnapshot.energyStakeSun, '1000000')
})

test('post-solidification resource source proof rejects an additional principal resource source', async () => {
  const principalHex = '41' + '11'.repeat(20)
  const feeHex = '41' + '44'.repeat(20)
  const principalAccount = {
    address: principalHex,
    frozenV2: [{ type: 'BANDWIDTH', amount: '1000000' }],
    frozen: [],
    acquired_delegated_frozenV2_balance_for_bandwidth: '1000000',
    acquired_delegated_frozen_balance_for_bandwidth: '0',
    account_resource: {
      frozen_balance_for_energy: { frozen_balance: '0' },
      acquired_delegated_frozenV2_balance_for_energy: '1000000',
      acquired_delegated_frozen_balance_for_energy: '0',
    },
  }
  const delegation = {
    from: feeHex, to: principalHex,
    frozen_balance_for_bandwidth: '1000000',
    frozen_balance_for_energy: '1000000',
    expire_time_for_bandwidth: 0,
    expire_time_for_energy: 0,
  }
  const result = await verifySponsorFeeResourceSource({
    transfer: transfer({ status: 'confirmed', asset: 'USDT', tokenContract }),
    env: { SPONSOR_FEE_NILE_ADDRESS: feeSponsorAddress },
    tronWebFactory: fakeTronWeb,
    fetchImpl: async (url) => response(200,
      url.endsWith('/walletsolidity/getaccount') ? principalAccount
        : { delegatedResource: [delegation] }),
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'fee-sponsor-only-bandwidth-source-required')
})
