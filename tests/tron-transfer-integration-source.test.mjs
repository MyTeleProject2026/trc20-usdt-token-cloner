import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const entry = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
const ownerPanel = await readFile(new URL('../Frontend-Tron-Transfer/src/TRXMainnetPanel.jsx', import.meta.url), 'utf8')
const mainnetHelper = await readFile(new URL('../Frontend-Tron-Transfer/src/trax-mainnet.mjs', import.meta.url), 'utf8')
const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('root API does not mount retired external provider or payout integrations', () => {
  for (const retired of [
    'tatumRoutes', 'gasFreeRoutes', 'wdkTronRoutes', 'createSponsorDirectPayoutsRouter',
    'createFincraWebhookRouter', 'treasuryPayoutReadinessRoutes', 'ownerTreasuryRoutes',
    'createTreasuryWithdrawalsRouter', 'createOwnerTreasuryFundingLedgerRouter',
  ]) assert.doesNotMatch(entry, new RegExp(retired))
})

test('root scripts target the existing frontend and Resource API, not the retired root UI server', () => {
  assert.match(packageManifest.scripts.dev, /npm run dev --prefix Frontend-Tron-Transfer/)
  assert.match(packageManifest.scripts.start, /npm start --prefix Frontend-Tron-Transfer\/resource-api/)
})

test('root runtime uses no retired provider or payout package dependency', () => {
  const serialized = JSON.stringify(packageManifest)
  for (const retired of ['TATUM_API_KEY', 'GASFREE_', 'FIREBLOCKS_', 'FINCRA_', '@tetherto/wdk-wallet-tron']) {
    assert.doesNotMatch(serialized, new RegExp(retired))
  }
})

test('retired OKX and Sponsor Direct Payout routes are not mounted by the legacy root server', () => {
  assert.doesNotMatch(entry, /okxDepositStatusRoutes|sponsor-direct-payout|fincra|fireblocks|gasfree/i)
  assert.doesNotMatch(entry, /TATUM_API_KEY|FIREBLOCKS_API_KEY|GASFREE_MAINNET_API_KEY|FINCRA_SECRET_KEY/)
})

test('Owner identity is session-derived and resource acquisition is Sponsor-wallet-only', () => {
  assert.doesNotMatch(ownerPanel, /EXPECTED_OWNER_ADDRESS|TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp/)
  assert.match(ownerPanel, /addressesEqual\(wallet\.tronWeb, wallet\.tronWeb\.defaultAddress\?\.base58, connectedAddress\)/)
  assert.doesNotMatch(mainnetHelper, /TEnergy|tenergy\/promo|claimTenergyPromoForDeployment|free-delegation/)
  assert.match(mainnetHelper, /getMainnetAccountResourceSnapshot/)
})


test('legacy payout, external-sponsor and exchange-status artifacts are absent', async () => {
  const removed = [
    '../server/owner-usdt-transfer.mjs',
    '../server/routes/okx-deposit-status.mjs',
    '../tests/owner-usdt-transfer.test.mjs',
    '../tests/okx-deposit-status.test.mjs',
    '../tests/okx-deposit-status-ui.test.mjs',
    '../docs/SPONSOR_BRIEF.md',
    '../docs/EXTERNAL_SPONSOR_OPERATING_CONTRACT.md',
    '../docs/PRIVATE_OWNER_SPONSORED_MAINNET_WITHDRAWALS.md',
    '../docs/SPONSORED_TRON_TRANSFER.md',
    '../docs/SPONSOR_TESTNET_SIGNING_BROADCAST_PATH.md',
    '../.github/ISSUE_TEMPLATE/individual-sponsor-inquiry.yml',
  ]
  for (const path of removed) {
    await assert.rejects(readFile(new URL(path, import.meta.url)), error => error?.code === 'ENOENT')
  }
})
