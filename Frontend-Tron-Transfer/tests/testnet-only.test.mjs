import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('TRӾ workspace renders a single owner-issued Mainnet token deployment flow', async () => {
  const app = await read('../src/App.jsx')
  const panel = await read('../src/TRXMainnetPanel.jsx')
  assert.ok(panel.includes("const DEFAULT_FEE_CAP = '150'"))
  assert.ok(panel.includes('const deployToken'))
  assert.ok(panel.includes('deployContractFromTronLink(wallet, TRAX_TOKEN_ARTIFACT'))
  assert.ok(panel.includes('Restricted1TRAX'))
  assert.ok(panel.includes('Deploy TRӾ automatically'))
  assert.ok(panel.includes('verifyTRAXTokenContract'))
  assert.doesNotMatch(panel, /TRAX_VAULT_ARTIFACT|vaultAddress|deployVault|preflightContractDeployments/)
  assert.doesNotMatch(panel, /\.call\(\)/, 'all Mainnet contract reads must use the paced RPC queue')
  assert.ok(panel.includes('callMainnetView('))
  assert.ok(panel.includes('getMainnetNativeBalance('))
  assert.ok(app.includes('TRXMainnetPanel'))
})

test('TRӾ frontend uses Mainnet deployment gates and validates the signer before broadcast', async () => {
  const client = await read('../src/trax-mainnet.mjs')
  for (const value of [
    "TRON_MAINNET_HOST = 'https://api.trongrid.io'",
    'MAINNET_DEPLOYMENT_SIGNING_ENABLED = true',
    'MAINNET_DEPLOYMENT_BROADCAST_ENABLED = true',
    'assertTransactionIntegrity(tronWeb, unsigned',
    'verifyTransactionSigner(tronWeb, signedTransaction, wallet.address)',
    'assertTransactionPermission(tronWeb, signedTransaction, wallet.address)',
    'sendRawTransaction(signedTransaction)',
  ]) assert.ok(client.includes(value), 'missing deployment guard: ' + value)
  assert.ok(client.indexOf('assertTransactionPermission(tronWeb, signedTransaction, wallet.address)')
    < client.indexOf('sendRawTransaction(signedTransaction)'))
})

test('wallet discovery supports injected TRON providers without importing private keys', async () => {
  const provider = await read('../src/tronlink-provider.mjs')
  for (const value of [
    'TIP6963:announceProvider',
    'windowObject?.tron',
    'windowObject?.okxwallet',
    'windowObject?.bitkeep',
    'windowObject?.tokenpocket',
    'windowObject?.trustwallet',
    'tron_requestAccounts',
  ]) assert.ok(provider.includes(value), 'missing provider discovery path: ' + value)
  assert.doesNotMatch(provider, /privateKey\s*[:=]/i)
})

test('contract administration checks the configured owner against the on-chain token owner', async () => {
  const panel = await read('../src/TRXMainnetPanel.jsx')
  for (const value of ['callMainnetView(token.owner())', 'EXPECTED_OWNER_ADDRESS', 'connectedAddress']) {
    assert.ok(panel.includes(value), 'missing on-chain owner check: ' + value)
  }
  assert.doesNotMatch(panel, /vaultAddress|vaultOwner|TRAX_VAULT_ARTIFACT/)
})

test('production build runs the complete frontend regression suite', async () => {
  const pkg = JSON.parse(await read('../package.json'))
  assert.ok(pkg.scripts.build.includes('node --test tests/*.test.mjs'))
  assert.ok(pkg.scripts.build.includes('vite build'))
  assert.equal(pkg.dependencies.tronweb, '6.5.2')
  assert.equal(pkg.overrides.tmp, '0.2.7')
})
