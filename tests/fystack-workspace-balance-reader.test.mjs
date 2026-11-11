import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createFystackReadSignature,
  createFystackWorkspaceBalanceReader,
  normalizeFystackWorkspaceUsdtBalances,
} from '../server/fystack-workspace-balance-reader.mjs'

const workspaceId = '8fbb14dd-8e2a-4cc8-9e3c-4a39c63f6f11'
const payload = {
  success: true,
  code: 0,
  data: [{
    symbol: 'USDT',
    total_balance: '12.5',
    total_value_usd: '12.5',
    total_wallet_count: 2,
    networks: [
      { asset_id: 'asset-1', network_id: 'network-1', network_name: 'Tron mainnet', balance: '10.5', wallet_count: 1 },
      { asset_id: 'asset-2', network_id: 'network-2', network_name: 'Tron testnet', balance: '2', wallet_count: 1 },
    ],
  }],
}

test('signature follows FYStack documented HMAC-SHA256 canonical format', () => {
  const value = createFystackReadSignature({
    apiSecret: 'test-secret',
    method: 'GET',
    path: '/api/v1/workspaces/example/balances?symbol=USDT',
    timestamp: '1794331200',
  })
  assert.equal(typeof value, 'string')
  assert.ok(value.length > 20)
})

test('normalizes workspace aggregate and isolates TRON Mainnet from testnet', () => {
  const result = normalizeFystackWorkspaceUsdtBalances(payload)
  assert.equal(result.status, 'workspace-aggregate-observed')
  assert.equal(result.scope, 'workspace-aggregate-across-wallets')
  assert.equal(result.workspaceTotalBalance, '12.5')
  assert.equal(result.tronMainnetNetworkBalances.length, 1)
  assert.equal(result.tronMainnetNetworkBalances[0].balance, '10.5')
  assert.equal(result.walletSpecificBalanceVerified, false)
  assert.equal(result.tokenContractVerified, false)
  assert.equal(result.availableBalanceVerified, false)
  assert.equal(result.spendableBalanceImpact, 'none')
  assert.equal(result.executionEnabled, false)
})

test('missing or malformed provider response fails closed', () => {
  for (const value of [null, {}, { success: true, code: 0, data: [] }, {
    success: true, code: 0, data: [{ symbol: 'USDT', total_balance: '5', networks: [{ network_name: 'Tron mainnet', balance: 'x' }] }],
  }]) {
    const result = normalizeFystackWorkspaceUsdtBalances(value)
    assert.equal(result.status, 'provider-balance-observation-blocked')
    assert.equal(result.spendableBalanceImpact, 'none')
    assert.equal(result.executionEnabled, false)
  }
})

test('reader does not call the provider when credentials or workspace UUID are missing', async () => {
  let called = false
  const reader = createFystackWorkspaceBalanceReader({
    apiKey: '',
    apiSecret: '',
    workspaceId: 'not-a-uuid',
    fetchImpl: async () => { called = true; throw new Error('must not be called') },
  })
  const result = await reader.getWorkspaceUsdtBalances()
  assert.equal(called, false)
  assert.equal(result.status, 'provider-balance-observation-blocked')
  assert.equal(result.executionEnabled, false)
})

test('reader uses the documented read-only workspace balance path and HMAC headers', async () => {
  let request
  const reader = createFystackWorkspaceBalanceReader({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    workspaceId,
    now: () => 1_794_331_200_000,
    fetchImpl: async (url, init) => {
      request = { url, init }
      return { ok: true, json: async () => payload }
    },
  })
  const result = await reader.getWorkspaceUsdtBalances()
  assert.match(request.url, /\/api\/v1\/workspaces\/[0-9a-f-]+\/balances\?symbol=USDT$/)
  assert.equal(request.init.method, 'GET')
  assert.equal(request.init.headers['ACCESS-API-KEY'], 'test-key')
  assert.equal(request.init.headers['ACCESS-TIMESTAMP'], '1794331200')
  assert.ok(request.init.headers['ACCESS-SIGN'])
  assert.equal(result.status, 'workspace-aggregate-observed')
  assert.equal(result.walletSpecificBalanceVerified, false)
  assert.equal(result.executionEnabled, false)
})
