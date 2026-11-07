import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  createInstitutionalSignerSimulationAdapter,
  OFFICIAL_TRON_USDT_CONTRACT,
  parseInstitutionalUsdtBaseUnits,
} from '../server/institutional-signer-adapter.mjs'

const now = 1_800_000_000_000
const baseIntent = {
  requestId: 'request-12345678',
  organizationId: 'sponsor-org-01',
  vaultAccountReference: 'vault-reference-01',
  network: 'TRON_MAINNET',
  assetSymbol: 'USDT',
  assetContract: OFFICIAL_TRON_USDT_CONTRACT,
  assetDecimals: 6,
  sponsorAddress: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
  recipientAddress: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
  amountUsdt: '125.000001',
  expiresAt: now + 60_000,
  mandateEvidenceReference: 'mandate-evidence-01',
  fundingEvidenceReference: 'funding-evidence-01',
  custodyPolicyReference: 'custody-policy-01',
  reviewerDecisionReferences: ['review-compliance-01', 'review-security-01'],
}

test('USDT amount parser enforces positive six-decimal uint256 base units', () => {
  assert.equal(parseInstitutionalUsdtBaseUnits('1'), '1000000')
  assert.equal(parseInstitutionalUsdtBaseUnits('125.000001'), '125000001')
  assert.equal(parseInstitutionalUsdtBaseUnits('0.000001'), '1')
  for (const value of ['0', '0.0000001', '-1', '1e2', '01', '1.', 1, null]) {
    assert.equal(parseInstitutionalUsdtBaseUnits(value), null, String(value))
  }
})

test('validates and fingerprints a narrowly bound institutional transfer intent', () => {
  const adapter = createInstitutionalSignerSimulationAdapter({ now: () => now })
  const result = adapter.evaluateTransferIntent(baseIntent)
  assert.equal(adapter.mode, 'test-only')
  assert.equal(result.status, 'simulation-only')
  assert.equal(result.reason, 'live-institutional-signer-adapter-not-enabled')
  assert.match(result.requestDigest, /^[a-f0-9]{64}$/)
  assert.equal(result.normalizedIntent.amountBaseUnits, '125000001')
  assert.equal(result.normalizedIntent.asset.contract, OFFICIAL_TRON_USDT_CONTRACT)
  assert.equal(result.evidenceReferencesPresent, true)
  assert.equal(result.evidenceReferencesIndependentlyVerified, false)
  assert.equal(result.institutionalApprovalVerified, false)
  assert.equal(result.fundingVerified, false)
  assert.equal(result.custodyPolicyVerified, false)
})

test('request digest binds recipient, amount, organization, network and evidence references', () => {
  const adapter = createInstitutionalSignerSimulationAdapter({ now: () => now })
  const original = adapter.evaluateTransferIntent(baseIntent)
  for (const patch of [
    { recipientAddress: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8' },
    { amountUsdt: '125.000002' },
    { organizationId: 'sponsor-org-02' },
    { network: 'NILE_TESTNET' },
    { fundingEvidenceReference: 'funding-evidence-02' },
  ]) {
    const changed = adapter.evaluateTransferIntent({ ...baseIntent, ...patch })
    assert.equal(changed.status, 'simulation-only')
    assert.notEqual(changed.requestDigest, original.requestDigest)
  }
})

test('rejects wrong chain, wrong token contract, malformed addresses and invalid amounts', () => {
  const adapter = createInstitutionalSignerSimulationAdapter({ now: () => now })
  const invalid = [
    { network: 'NILE_TESTNET' },
    { assetContract: 'TWrongContractAddress' },
    { assetDecimals: 18 },
    { sponsorAddress: 'not-a-tron-address' },
    { recipientAddress: baseIntent.sponsorAddress },
    { amountUsdt: '0' },
    { amountUsdt: '1.0000001' },
    { requestId: 'short' },
    { organizationId: '' },
  ]
  for (const patch of invalid) {
    const result = adapter.evaluateTransferIntent({ ...baseIntent, ...patch })
    assert.equal(result.status, 'blocked-invalid-or-incomplete-intent')
    assert.equal(result.requestDigest, null)
    assert.equal(result.payoutAuthorized, false)
  }
})

test('requires opaque references for mandate, funding, custody policy and two distinct reviewer decisions', () => {
  const adapter = createInstitutionalSignerSimulationAdapter({ now: () => now })
  const invalid = [
    { mandateEvidenceReference: '' },
    { fundingEvidenceReference: null },
    { custodyPolicyReference: 'short' },
    { reviewerDecisionReferences: ['review-compliance-01'] },
    { reviewerDecisionReferences: ['review-compliance-01', 'review-compliance-01'] },
    { reviewerDecisionReferences: ['review-compliance-01', ''] },
  ]
  for (const patch of invalid) {
    const result = adapter.evaluateTransferIntent({ ...baseIntent, ...patch })
    assert.equal(result.status, 'blocked-invalid-or-incomplete-intent')
    assert.equal(result.evidenceReferencesPresent, false)
    assert.equal(result.payoutAuthorized, false)
  }
})

test('rejects expired, excessively long-lived and non-integer authorization expiry', () => {
  const adapter = createInstitutionalSignerSimulationAdapter({ now: () => now })
  for (const expiresAt of [now, now - 1, now + 120_001, String(now + 1000), Number.MAX_SAFE_INTEGER + 1]) {
    const result = adapter.evaluateTransferIntent({ ...baseIntent, expiresAt })
    assert.equal(result.status, 'blocked-invalid-or-incomplete-intent')
    assert.equal(result.requestDigest, null)
  }
})

test('never contacts a signer, creates a signing request, signs, broadcasts or authorizes payout', () => {
  const adapter = createInstitutionalSignerSimulationAdapter({ now: () => now })
  const result = adapter.evaluateTransferIntent(baseIntent)
  for (const field of [
    'signerProviderContacted',
    'signingRequestCreated',
    'signatureProduced',
    'transactionSigned',
    'broadcastAttempted',
    'payoutAuthorized',
    'mainnetExecutionEnabled',
  ]) assert.equal(result[field], false, field)
  assert.deepEqual(adapter.capabilities, {
    validatesIntent: true,
    createsRequestDigest: true,
    contactsSignerProvider: false,
    createsSigningRequest: false,
    signsTransactions: false,
    broadcastsTransactions: false,
    authorizesPayouts: false,
    enablesMainnetExecution: false,
  })
})

test('adapter source has no network client, key loader, transaction submission or signing primitive', async () => {
  const source = await readFile(new URL('../server/institutional-signer-adapter.mjs', import.meta.url), 'utf8')
  for (const forbidden of [
    'fetch(', 'https://', 'http://', 'readFile', 'createPrivateKey',
    'privateKey', 'sendRawTransaction', 'broadcastTransaction',
    'createTransaction', 'sign(',
  ]) assert.equal(source.includes(forbidden), false, forbidden)
})
test('live treasury USDT and TRX submission routes remain hard-disabled before any provider call', async () => {
  const route = await readFile(new URL('../server/routes/treasury-withdrawals.mjs', import.meta.url), 'utf8')
  assert.match(route, /const REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true/)
  for (const [path, providerCall] of [
    ["router.post('/withdrawals',", 'fireblocks.createUsdtTransfer('],
    ["router.post('/trx-withdrawals',", 'fireblocks.createTrxTransfer('],
  ]) {
    const start = route.indexOf(path)
    assert.notEqual(start, -1, path)
    const handler = route.slice(start, route.indexOf("\n  router.", start + path.length) < 0
      ? route.length : route.indexOf("\n  router.", start + path.length))
    const hardGate = handler.indexOf('if (REAL_VALUE_PAYOUT_EXECUTION_DISABLED)')
    const auth = handler.indexOf('authenticateOwner(')
    const submission = handler.indexOf(providerCall)
    assert.ok(hardGate >= 0, 'hard execution gate must exist')
    assert.ok(auth > hardGate, 'hard execution gate must run before owner-auth processing')
    assert.ok(submission > hardGate, 'provider submission must remain downstream of the hard gate')
  }
})
