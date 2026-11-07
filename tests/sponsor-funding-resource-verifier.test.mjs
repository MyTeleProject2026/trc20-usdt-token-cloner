import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { verifySponsorFundingAndTronResources } from '../server/sponsor-funding-resource-verifier.mjs'

const now = 1_800_000_000_000
const address = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const expected = {
  organizationId: 'sponsor-org-01',
  vaultId: 'vault-123',
  sponsorAddress: address,
  minimumUsdtBaseUnits: '1000000000',
  minimumTrxSun: '1000000',
  minimumBandwidthUnits: '500',
  minimumEnergyUnits: '1000',
}
const chainObservation = {
  source: 'tron-mainnet-readonly-rpc',
  network: 'TRON_MAINNET',
  finality: 'solidified',
  sponsorAddress: address,
  accountExists: true,
  blockNumber: 99_001_234,
  blockId: 'a'.repeat(64),
  observedAt: now,
  usdtContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  usdtDecimals: 6,
  usdtBalanceBaseUnits: '5000000000',
  trxBalanceSun: '9000000',
  resources: {
    freeNetLimit: '1500',
    freeNetUsed: '200',
    netLimit: '1200',
    netUsed: '300',
    energyLimit: '5000',
    energyUsed: '1000',
  },
}
const custodyObservation = {
  source: 'custody-provider-readonly-vault',
  organizationId: 'sponsor-org-01',
  vaultId: 'vault-123',
  sponsorAddress: address,
  network: 'TRON_MAINNET',
  observationId: 'vault-snapshot-12345',
  observedAt: now,
  usdtContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  usdtDecimals: 6,
  usdtAvailableBaseUnits: '4000000000',
  trxAvailableSun: '8000000',
}

function verify(patch = {}) {
  return verifySponsorFundingAndTronResources({
    expected,
    chainObservation,
    custodyObservation,
    now,
    ...patch,
  })
}

test('passes only when fresh solidified chain and custody observations reconcile', () => {
  const result = verify()
  assert.equal(result.status, 'observations-reconciled-not-cryptographically-attested')
  assert.equal(result.reconciled, true)
  assert.equal(result.verified, false)
  assert.equal(result.balances.reconciledSpendableUsdtBaseUnits, '4000000000')
  assert.equal(result.balances.reconciledSpendableTrxSun, '8000000')
  assert.equal(result.resources.availableBandwidthUnits, '2200')
  assert.equal(result.resources.availableEnergyUnits, '4000')
})

test('fails closed for missing, untrusted, stale, future-dated or non-solidified chain evidence', () => {
  const cases = [
    [{ ...chainObservation, source: 'user-uploaded-screenshot' }, 'trusted-tron-read-source-missing'],
    [{ ...chainObservation, observedAt: now - 60_001 }, 'chain-observation-stale-or-future-dated'],
    [{ ...chainObservation, observedAt: now + 5_001 }, 'chain-observation-stale-or-future-dated'],
    [{ ...chainObservation, finality: 'latest' }, 'chain-observation-not-solidified'],
    [{ ...chainObservation, network: 'NILE_TESTNET' }, 'chain-network-not-tron-mainnet'],
    [{ ...chainObservation, blockId: 'not-a-block-id' }, 'solidified-block-id-invalid'],
  ]
  for (const [chain, reason] of cases) {
    const result = verify({ chainObservation: chain })
    assert.equal(result.verified, false)
    assert.ok(result.reasons.includes(reason), reason)
  }
})

test('binds funding observations to the exact organization, vault, sponsor and official USDT contract', () => {
  const cases = [
    [{ organizationId: 'another-org' }, 'custody-organization-mismatch'],
    [{ vaultId: 'another-vault' }, 'custody-vault-mismatch'],
    [{ sponsorAddress: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp' }, 'custody-sponsor-address-mismatch'],
    [{ network: 'NILE_TESTNET' }, 'custody-network-mismatch'],
    [{ usdtContract: 'TWrongContract' }, 'custody-usdt-contract-mismatch'],
  ]
  for (const [patch, reason] of cases) {
    const result = verify({ custodyObservation: { ...custodyObservation, ...patch } })
    assert.equal(result.verified, false)
    assert.ok(result.reasons.includes(reason), reason)
  }
})

test('rejects custody balances greater than the independently observed on-chain balances', () => {
  const result = verify({
    custodyObservation: {
      ...custodyObservation,
      usdtAvailableBaseUnits: '5000000001',
      trxAvailableSun: '9000001',
    },
  })
  assert.ok(result.reasons.includes('custody-usdt-exceeds-chain-balance'))
  assert.ok(result.reasons.includes('custody-trx-exceeds-chain-balance'))
  assert.equal(result.verified, false)
})

test('rejects sandbox, malformed, zero and insufficient balances or resources', () => {
  const cases = [
    [{ ...custodyObservation, source: 'sandbox-ledger' }, 'trusted-custody-read-source-missing'],
    [{ ...custodyObservation, usdtAvailableBaseUnits: '0' }, 'verified-spendable-usdt-below-required-minimum'],
    [{ ...custodyObservation, trxAvailableSun: '0' }, 'verified-spendable-trx-below-required-minimum'],
    [{ ...custodyObservation, usdtAvailableBaseUnits: 'not-a-number' }, 'custody-usdt-available-balance-invalid'],
  ]
  for (const [custody, reason] of cases) {
    const result = verify({ custodyObservation: custody })
    assert.equal(result.verified, false)
    assert.ok(result.reasons.includes(reason), reason)
  }
  const lowResources = verify({
    chainObservation: {
      ...chainObservation,
      resources: {
        freeNetLimit: '100',
        freeNetUsed: '100',
        netLimit: '100',
        netUsed: '100',
        energyLimit: '100',
        energyUsed: '100',
      },
    },
  })
  assert.ok(lowResources.reasons.includes('available-bandwidth-below-required-minimum'))
  assert.ok(lowResources.reasons.includes('available-energy-below-required-minimum'))
})

test('rejects missing resource readings, stale custody data and invalid thresholds', () => {
  const noResources = verify({
    chainObservation: { ...chainObservation, resources: { freeNetLimit: '100' } },
  })
  assert.ok(noResources.reasons.includes('chain-resource-observation-invalid'))
  const staleCustody = verify({
    custodyObservation: { ...custodyObservation, observedAt: now - 60_001 },
  })
  assert.ok(staleCustody.reasons.includes('custody-observation-stale-or-future-dated'))
  const invalidThresholds = verify({
    expected: { ...expected, minimumUsdtBaseUnits: '1.000001', minimumTrxSun: '-1' },
  })
  assert.ok(invalidThresholds.reasons.includes('minimum-usdt-threshold-invalid'))
  assert.ok(invalidThresholds.reasons.includes('minimum-trx-threshold-invalid'))
})

test('verification is readiness evidence only and never authorizes or executes a payout', () => {
  const result = verify()
  for (const field of [
    'providerObservationsCryptographicallyAttestedByThisModule',
    'sandboxBalancesAccepted',
    'payoutAuthorized',
    'signerProviderContacted',
    'signingRequestCreated',
    'signatureProduced',
    'transactionSigned',
    'broadcastAttempted',
    'mainnetExecutionEnabled',
  ]) assert.equal(result.limitations[field], false, field)
})

test('verifier source has no network, key, signing or transaction-submission capability', async () => {
  const source = await readFile(new URL('../server/sponsor-funding-resource-verifier.mjs', import.meta.url), 'utf8')
  for (const forbidden of [
    'fetch(', 'https://', 'http://', 'createPrivateKey', 'privateKey',
    'sendRawTransaction', 'broadcastTransaction', 'createTransaction', 'sign(',
  ]) assert.equal(source.includes(forbidden), false, forbidden)
})
