import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const entry = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('root API does not mount retired external provider or payout integrations', () => {
  for (const retired of [
    'tatumRoutes', 'gasFreeRoutes', 'wdkTronRoutes', 'createSponsorDirectPayoutsRouter',
    'createFincraWebhookRouter', 'treasuryPayoutReadinessRoutes', 'ownerTreasuryRoutes',
    'createTreasuryWithdrawalsRouter', 'createOwnerTreasuryFundingLedgerRouter',
  ]) assert.doesNotMatch(entry, new RegExp(retired))
})

test('root runtime uses no Tatum, GasFree, WDK, Fincra, or Fireblocks package dependency', () => {
  const serialized = JSON.stringify(packageManifest)
  for (const retired of ['TATUM_API_KEY', 'GASFREE_', 'FIREBLOCKS_', 'FINCRA_', '@tetherto/wdk-wallet-tron']) {
    assert.doesNotMatch(serialized, new RegExp(retired))
  }
})

test('retained readiness is provider-neutral and does not require a paid resource supplier', () => {
  assert.match(entry, /TronGrid Mainnet only/)
  assert.doesNotMatch(entry, /TATUM_API_KEY|FIREBLOCKS_API_KEY|GASFREE_MAINNET_API_KEY|FINCRA_SECRET_KEY/)
})
