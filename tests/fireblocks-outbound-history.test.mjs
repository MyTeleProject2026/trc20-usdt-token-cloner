import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseFireblocksOutboundHistoryTransaction,
  reconcileFireblocksOutboundHistory,
} from '../server/routes/fireblocks-outbound-history.mjs'

const config = {
  vaultAccountId: '123',
  usdtAssetId: 'TRON_USDT',
  trxAssetId: 'TRON',
}
const recipient = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'

function providerTransfer({
  id = 'provider-tx-1',
  assetId = config.usdtAssetId,
  amount = '2.500000',
  externalTxId = null,
  destinationAddress = recipient,
  status = 'COMPLETED',
  txHash = 'a'.repeat(64),
  operation = 'TRANSFER',
  sourceId = config.vaultAccountId,
} = {}) {
  return {
    id,
    operation,
    status,
    assetId,
    amount,
    externalTxId,
    txHash,
    createdAt: 1_798_000_000_000,
    source: { type: 'VAULT_ACCOUNT', id: sourceId },
    destination: {
      type: 'ONE_TIME_ADDRESS',
      oneTimeAddress: { address: destinationAddress },
    },
  }
}

function parse(transaction) {
  const result = parseFireblocksOutboundHistoryTransaction(transaction, config)
  assert.equal(result.valid, true, result.reason)
  return result.entry
}

test('Fireblocks outbound transaction parser accepts exact vault-sourced USDT and TRX transfers', () => {
  const usdt = parse(providerTransfer())
  assert.equal(usdt.assetCode, 'USDT')
  assert.equal(usdt.amountBaseUnits, '2500000')
  assert.equal(usdt.sourceType, 'VAULT_ACCOUNT')
  assert.equal(usdt.sourceId, config.vaultAccountId)
  assert.equal(usdt.destinationAddress, recipient)
  assert.equal(usdt.terminalNoBroadcast, false)

  const trx = parse(providerTransfer({
    id: 'provider-trx-1',
    assetId: config.trxAssetId,
    amount: '12.000001',
  }))
  assert.equal(trx.assetCode, 'TRX')
  assert.equal(trx.amountBaseUnits, '12000001')
})

test('Fireblocks outbound parser fails closed for unsupported source, operation, asset and amount', () => {
  const cases = [
    [providerTransfer({ sourceId: '999' }), 'fireblocks-history-source-vault-mismatch'],
    [providerTransfer({ operation: 'CONTRACT_CALL' }), 'fireblocks-history-unsupported-operation'],
    [providerTransfer({ assetId: 'UNKNOWN_TOKEN' }), 'fireblocks-history-unsupported-asset'],
    [providerTransfer({ amount: '1.0000001' }), 'fireblocks-history-amount-invalid'],
    [providerTransfer({ amount: 2.5 }), 'fireblocks-history-amount-invalid'],
    [providerTransfer({ destinationAddress: 'invalid' }), 'fireblocks-history-destination-address-invalid'],
    [providerTransfer({ txHash: 'not-a-transaction-hash' }), 'fireblocks-history-transaction-hash-invalid'],
  ]
  for (const [transaction, reason] of cases) {
    const result = parseFireblocksOutboundHistoryTransaction(transaction, config)
    assert.equal(result.valid, false)
    assert.equal(result.reason, reason)
  }
})

test('Fireblocks outbound reconciliation excludes matching app payouts and counts untracked vault outflows', () => {
  const appUsdt = {
    idempotency_key: 'app-usdt-payout-0000000001',
    provider_transaction_id: 'provider-app-usdt',
    recipient_address: recipient,
    amount_base_units: '2500000',
    status: 'confirmed',
  }
  const appTrx = {
    idempotency_key: 'app-trx-payout-0000000001',
    provider_transaction_id: 'provider-app-trx',
    recipient_address: recipient,
    amount_base_units: '1000000',
    status: 'broadcast-accepted',
  }
  const entries = [
    parse(providerTransfer({
      id: 'provider-app-usdt',
      amount: '2.500000',
      externalTxId: appUsdt.idempotency_key,
    })),
    parse(providerTransfer({
      id: 'provider-app-trx',
      assetId: config.trxAssetId,
      amount: '1.000000',
      externalTxId: appTrx.idempotency_key,
    })),
    parse(providerTransfer({
      id: 'console-usdt-transfer',
      amount: '3.125000',
      destinationAddress: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
    })),
    parse(providerTransfer({
      id: 'console-trx-transfer',
      assetId: config.trxAssetId,
      amount: '4.000000',
      destinationAddress: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
    })),
  ]
  const result = reconcileFireblocksOutboundHistory({
    entries,
    usdtRequests: [appUsdt],
    trxRequests: [appTrx],
    ...config,
  })
  assert.equal(result.verified, true)
  assert.deepEqual(result.blockers, [])
  assert.equal(result.externalUsdtBaseUnits, '3125000')
  assert.equal(result.externalTrxBaseUnits, '4000000')
  assert.equal(result.transactionCount, 4)
  assert.match(result.reconciliationDigest, /^[0-9a-f]{64}$/)
})

test('Fireblocks outbound reconciliation blocks when an app request and provider history disagree', () => {
  const appRequest = {
    idempotency_key: 'app-usdt-payout-0000000002',
    provider_transaction_id: 'provider-app-mismatch',
    recipient_address: recipient,
    amount_base_units: '2500000',
    status: 'provider-pending',
  }
  const result = reconcileFireblocksOutboundHistory({
    entries: [parse(providerTransfer({
      id: 'provider-app-mismatch',
      amount: '2.000000',
      externalTxId: appRequest.idempotency_key,
    }))],
    usdtRequests: [appRequest],
    trxRequests: [],
    ...config,
  })
  assert.equal(result.verified, false)
  assert.ok(result.blockers.includes('fireblocks-history-application-transaction-mismatch'))
})

test('Fireblocks outbound reconciliation blocks if a committed application transaction is absent', () => {
  const appRequest = {
    idempotency_key: 'app-usdt-payout-0000000003',
    provider_transaction_id: 'provider-transaction-missing',
    recipient_address: recipient,
    amount_base_units: '2500000',
    status: 'broadcast-accepted',
  }
  const result = reconcileFireblocksOutboundHistory({
    entries: [],
    usdtRequests: [appRequest],
    trxRequests: [],
    ...config,
  })
  assert.equal(result.verified, false)
  assert.ok(result.blockers.includes('fireblocks-history-application-transaction-missing'))
})

test('Fireblocks terminal no-broadcast failures are not counted as external asset outflows', () => {
  const failed = parse(providerTransfer({
    id: 'provider-failed-transfer',
    status: 'FAILED',
    txHash: null,
  }))
  const result = reconcileFireblocksOutboundHistory({
    entries: [failed],
    usdtRequests: [],
    trxRequests: [],
    ...config,
  })
  assert.equal(result.verified, true)
  assert.equal(result.externalUsdtBaseUnits, '0')
})
