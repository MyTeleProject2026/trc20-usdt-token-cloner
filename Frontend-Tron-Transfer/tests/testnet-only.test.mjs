import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('TRӾ workspace renders the dedicated Mainnet contract manager', async () => {
  const app = await read('../src/App.jsx')
  const panel = await read('../src/TRXMainnetPanel.jsx')
  for (const value of ['TRXMainnetPanel']) assert.ok(app.includes(value))
  for (const value of [
    'TRӾ smart-contract manager',
    'Deploy both contracts automatically',
    'Authorize token in vault',
    'Fund the native TRX reserve',
    'Issue restricted TRӾ',
    'Owner-controlled redemption',
  ]) assert.ok(panel.includes(value), 'missing TRӾ manager capability: ' + value)
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
  assert.ok(client.indexOf('assertTransactionPermission(tronWeb, signedTransaction)')
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

test('contract administration is determined by deployed on-chain owners', async () => {
  const panel = await read('../src/TRXMainnetPanel.jsx')
  for (const value of ['token.owner().call()', 'vault.owner().call()', 'connectedAddress']) {
    assert.ok(panel.includes(value), 'missing on-chain owner check: ' + value)
  }
})

test('production build runs the complete frontend regression suite', async () => {
  const pkg = JSON.parse(await read('../package.json'))
  assert.ok(pkg.scripts.build.includes('node --test tests/*.test.mjs'))
  assert.ok(pkg.scripts.build.includes('vite build'))
  assert.equal(pkg.dependencies.tronweb, '6.5.1')
})
