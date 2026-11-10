import test from 'node:test'
import assert from 'node:assert/strict'
import { createFystackWalletListReader, normalizeFystackWalletInventory } from '../server/fystack-wallet-list-reader.mjs'

const workspaceId = '8fbb14dd-8e2a-4cc8-9e3c-4a39c63f6f11'
const walletId = '7f00773a-abbd-434b-b322-7b4016b3ff4a'
const payload = [{ id: walletId, name: 'Tron', role: 'wallet_admin', wallet_type: 'mpc', value_usd: '0', top_assets: [] }]

test('matches configured wallet from documented workspace wallet inventory', () => {
  const result = normalizeFystackWalletInventory(payload, { expectedWalletId: walletId })
  assert.equal(result.status, 'wallet-inventory-observed')
  assert.equal(result.walletIdentityMatched, true)
  assert.equal(result.matchedWallet.walletType, 'mpc')
  assert.equal(result.matchedWallet.displayedValueUsd, '0')
  assert.equal(result.walletSpecificUsdtBalanceVerified, false)
  assert.equal(result.availableUsdtVerified, false)
  assert.equal(result.displayedUsdValueIsSpendable, false)
  assert.equal(result.executionEnabled, false)
})

test('does not treat workspace wallet display value as token balance', () => {
  const result = normalizeFystackWalletInventory(payload, { expectedWalletId: walletId })
  assert.equal(result.matchedWallet.displayedValueUsd, '0')
  assert.equal(result.availableUsdtVerified, false)
  assert.equal(result.heldUsdtVerified, false)
  assert.equal(result.tokenContractVerified, false)
  assert.equal(result.payoutAuthorizationGranted, false)
})

test('fails closed for missing inventory and unknown wallet ID', () => {
  assert.equal(normalizeFystackWalletInventory(null).status, 'wallet-inventory-unavailable')
  const result = normalizeFystackWalletInventory(payload, { expectedWalletId: '00000000-0000-4000-8000-000000000000' })
  assert.equal(result.status, 'configured-wallet-not-found')
  assert.equal(result.matchedWallet, null)
})

test('reader makes only a signed GET to the documented wallet inventory endpoint', async () => {
  let request
  const reader = createFystackWalletListReader({
    apiKey: 'test-key', apiSecret: 'test-secret', workspaceId,
    now: () => 1_794_331_200_000,
    fetchImpl: async (url, init) => { request = { url, init }; return { ok: true, json: async () => payload } },
  })
  const result = await reader.getWorkspaceWallets({ expectedWalletId: walletId })
  assert.match(request.url, /\/api\/v1\/workspaces\/[0-9a-f-]+\/wallets\?limit=100&offset=0$/)
  assert.equal(request.init.method, 'GET')
  assert.equal(request.init.headers['ACCESS-API-KEY'], 'test-key')
  assert.equal(request.init.headers['ACCESS-TIMESTAMP'], '1794331200')
  assert.ok(request.init.headers['ACCESS-SIGN'])
  assert.equal(result.walletIdentityMatched, true)
  assert.equal(result.executionEnabled, false)
})

test('invalid configuration does not call provider', async () => {
  let called = false
  const reader = createFystackWalletListReader({ workspaceId: 'bad', fetchImpl: async () => { called = true } })
  const result = await reader.getWorkspaceWallets({ expectedWalletId: walletId })
  assert.equal(called, false)
  assert.equal(result.status, 'wallet-inventory-unavailable')
})
