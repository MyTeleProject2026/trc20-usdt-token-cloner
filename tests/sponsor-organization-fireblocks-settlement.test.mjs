import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyAndSettleSponsorOrganizationFireblocksPayout } from '../server/sponsor-organization-fireblocks-settlement.mjs'

const hash = 'a'.repeat(64)
const context = {
  intentId: '9001', intentDigest: 'b'.repeat(64), network: 'mainnet', asset: 'USDT',
  tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  receiverAddress: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
  principalSponsorAddress: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
  feeSponsorAddress: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
  amountBaseUnits: '2500000', feeCapSun: '300000',
  externalTxId: 'tssponsor-9001-' + 'b'.repeat(64),
  transactionHash: hash, submissionStatus: 'broadcast-accepted',
  chainVerificationStatus: 'pending', chainVerificationReason: null,
  chainVerificationBlockNumber: null, observedFeeSun: null,
  observedEnergyUsage: null, observedNetUsage: null,
  principalSettlementStatus: 'pending',
  feeSettlementStatus: 'pending-resource-reconciliation', chainVerifiedAt: null,
}

function makeHarness({ currentContext = context, verification = {
  verified: true, status: 'confirmed',
  reason: 'confirmed-solidified-successful-receipt-and-transfer-event', blockNumber: 12345,
} } = {}) {
  const state = { refreshCalls: 0, confirmedReads: 0, infoReads: 0, evidenceCalls: [], records: [] }
  let latestContext = { ...currentContext }
  const store = {
    async getFireblocksPayoutSettlementContext(id) {
      assert.equal(id, '9001')
      return { success: true, context: { ...latestContext } }
    },
    async recordFireblocksPayoutChainVerification(input) {
      state.records.push(input)
      latestContext = {
        ...latestContext,
        chainVerificationStatus: input.verificationStatus,
        chainVerificationReason: input.verificationReason,
        chainVerificationBlockNumber: String(input.blockNumber),
        observedFeeSun: input.feeSun,
        observedEnergyUsage: input.energyUsage,
        observedNetUsage: input.netUsage,
        principalSettlementStatus: input.verificationStatus === 'confirmed' ? 'settled' : 'released',
        feeSettlementStatus: input.feeSun && BigInt(input.feeSun) > BigInt(latestContext.feeCapSun)
          ? 'over-cap-manual-review' : 'pending-resource-reconciliation',
        chainVerifiedAt: new Date().toISOString(),
      }
      return { success: true, duplicate: false, verificationStatus: input.verificationStatus,
        principalSettlementStatus: latestContext.principalSettlementStatus,
        feeSettlementStatus: latestContext.feeSettlementStatus, feeReservationRetained: true }
    },
  }
  const refreshProviderStatus = async ({ intentId }) => {
    state.refreshCalls += 1
    assert.equal(intentId, '9001')
    return { success: true, status: 'broadcast-accepted' }
  }
  const tronWebFactory = async () => ({
    trx: {
      async getConfirmedTransaction(txid) {
        state.confirmedReads += 1
        assert.equal(txid, hash)
        return { txID: hash }
      },
      async getTransactionInfo(txid) {
        state.infoReads += 1
        assert.equal(txid, hash)
        return { id: hash, blockNumber: 12345, fee: 50000, net_usage: 220, receipt: { energy_usage_total: 9000 } }
      },
    },
  })
  const verifyTransferEvidence = async (_tronWeb, input) => {
    state.evidenceCalls.push(input)
    return verification
  }
  return {
    state, store,
    run: (overrides = {}) => verifyAndSettleSponsorOrganizationFireblocksPayout({
      store, intentId: '9001', refreshProviderStatus, tronWebFactory, verifyTransferEvidence, ...overrides,
    }),
  }
}

test('settlement verifies the exact provider hash and settles only principal while retaining fee resources', async () => {
  const harness = makeHarness()
  const result = await harness.run()
  assert.equal(result.success, true)
  assert.equal(result.status, 'confirmed')
  assert.equal(result.principalSettlementStatus, 'settled')
  assert.equal(result.feeSettlementStatus, 'pending-resource-reconciliation')
  assert.equal(result.feeReservationRetained, true)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.submissionEnabled, false)
  assert.equal(result.transactionSubmitted, false)
  assert.equal(harness.state.refreshCalls, 1)
  assert.equal(harness.state.confirmedReads, 1)
  assert.equal(harness.state.infoReads, 1)
  assert.equal(harness.state.records.length, 1)
  assert.deepEqual(harness.state.records[0], {
    intentId: '9001', intentDigest: context.intentDigest, externalTxId: context.externalTxId,
    transactionHash: hash, verificationStatus: 'confirmed',
    verificationReason: 'confirmed-solidified-successful-receipt-and-transfer-event',
    blockNumber: 12345, feeSun: '50000', energyUsage: '9000', netUsage: '220',
  })
  assert.equal(harness.state.evidenceCalls[0].treasuryAddress, context.principalSponsorAddress)
  assert.equal(harness.state.evidenceCalls[0].recipientAddress, context.receiverAddress)
  assert.equal(harness.state.evidenceCalls[0].amountBaseUnits, context.amountBaseUnits)
})

test('solidified failed receipt releases principal reservation but keeps network-fee/resource reservation', async () => {
  const harness = makeHarness({ verification: {
    verified: true, status: 'failed', reason: 'confirmed-solidified-failed-receipt', blockNumber: 12346,
  } })
  const result = await harness.run()
  assert.equal(result.success, true)
  assert.equal(result.status, 'failed')
  assert.equal(result.principalSettlementStatus, 'released')
  assert.equal(result.feeReservationRetained, true)
  assert.equal(harness.state.records[0].verificationStatus, 'failed')
})

test('fee observation above the approved cap marks manual reconciliation and never releases the fee reservation', async () => {
  const harness = makeHarness()
  const result = await harness.run({
    tronWebFactory: async () => ({ trx: {
      getConfirmedTransaction: async () => ({ txID: hash }),
      getTransactionInfo: async () => ({ id: hash, blockNumber: 12345, fee: 400000, net_usage: 220, receipt: { energy_usage_total: 9000 } }),
    } }),
  })
  assert.equal(result.success, true)
  assert.equal(result.feeSettlementStatus, 'over-cap-manual-review')
  assert.equal(result.feeReservationRetained, true)
  assert.equal(harness.state.records[0].feeSun, '400000')
})

test('missing confirmed receipt leaves all reservations untouched and does not call settlement store', async () => {
  const harness = makeHarness({ verification: {
    verified: false, status: 'awaiting-confirmed-receipt', reason: 'confirmed-transaction-or-receipt-unavailable',
  } })
  const result = await harness.run()
  assert.equal(result.success, false)
  assert.equal(result.reason, 'awaiting-confirmed-receipt')
  assert.equal(result.reservationRetained, true)
  assert.equal(harness.state.records.length, 0)
})

test('settlement refuses wrong network, token, receiver or missing provider hash before querying the chain', async () => {
  for (const change of [
    { network: 'nile' },
    { asset: 'TRX', tokenContract: null },
    { tokenContract: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE' },
    { transactionHash: null },
  ]) {
    const harness = makeHarness({ currentContext: { ...context, ...change } })
    const result = await harness.run()
    assert.equal(result.success, false)
    assert.equal(result.reason, change.transactionHash === null ? 'provider-chain-transaction-hash-not-available' : 'settlement-requires-official-mainnet-usdt-intent')
    assert.equal(harness.state.confirmedReads, 0)
    assert.equal(harness.state.records.length, 0)
  }
})

test('already chain-verified intent returns stored principal and fee settlement states without re-verifying', async () => {
  const harness = makeHarness({ currentContext: {
    ...context, chainVerificationStatus: 'confirmed',
    chainVerificationReason: 'confirmed-solidified-successful-receipt-and-transfer-event',
    chainVerificationBlockNumber: '12345', principalSettlementStatus: 'settled',
    chainVerifiedAt: new Date().toISOString(),
  } })
  const result = await harness.run()
  assert.equal(result.success, true)
  assert.equal(result.duplicate, true)
  assert.equal(result.principalSettlementStatus, 'settled')
  assert.equal(result.feeReservationRetained, true)
  assert.equal(harness.state.confirmedReads, 0)
  assert.equal(harness.state.records.length, 0)
})
