import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('TRӾ workspace renders the dedicated Mainnet contract manager', async () => {
  const app = await read('../src/App.jsx')
  const panel = await read('../src/TRXMainnetPanel.jsx')
  assert.match(app, /TRXMainnetPanel/)
  assert.match(panel, /TRӾ smart-contract manager/)
  assert.match(panel, /Deploy both contracts automatically/)
  assert.match(panel, /Authorize token in vault/)
  assert.match(panel, /Fund the native TRX reserve/)
  assert.match(panel, /Issue restricted TRӾ/)
  assert.match(panel, /Owner-controlled redemption/)
})

test('TRӾ frontend uses the Mainnet-only deployment client and explicit transaction gates', async () => {
  const client = await read('../src/trax-mainnet.mjs')
  assert.match(client, /TRON_MAINNET_HOST = 'https:\\/\\/api\\.trongrid\\.io'/)
  assert.match(client, /MAINNET_DEPLOYMENT_SIGNING_ENABLED = true/)
  assert.match(client, /MAINNET_DEPLOYMENT_BROADCAST_ENABLED = true/)
  assert.match(client, /assertTransactionIntegrity\\(tronWeb, unsigned/)
  assert.match(client, /verifyTransactionSigner\\(tronWeb, signedTransaction, wallet\\.address\\)/)
  assert.match(client, /assertTransactionPermission\\(tronWeb, signedTransaction\\)/)
  assert.match(client, /sendRawTransaction\\(signedTransaction\\)/)
  assert.ok(client.indexOf('assertTransactionPermission(tronWeb, signedTransaction)')
    < client.indexOf('sendRawTransaction(signedTransaction)'))
})

test('wallet discovery accepts supported injected TRON providers without importing private keys', async () => {
  const provider = await read('../src/tronlink-provider.mjs')
  assert.match(provider, /TIP6963:announceProvider/)
  assert.match(provider, /windowObject\\?\\.tron/)
  assert.match(provider, /windowObject\\?\\.okxwallet/)
  assert.match(provider, /windowObject\\?\\.bitkeep/)
  assert.match(provider, /windowObject\\?\\.tokenpocket/)
  assert.match(provider, /windowObject\\?\\.trustwallet/)
  assert.match(provider, /tron_requestAccounts/)
  assert.doesNotMatch(provider, /privateKey\\s*[:=]/i)
})

test('owner administration is determined by the deployed contracts, not a fixed address', async () => {
  const panel = await read('../src/TRXMainnetPanel.jsx')
  assert.match(panel, /token\\.owner\\(\\)\\.call\\(\\)/)
  assert.match(panel, /vault\\.owner\\(\\)\\.call\\(\\)/)
  assert.match(panel, /connectedAddress/)
})

test('frontend production build includes the complete regression suite', async () => {
  const pkg = JSON.parse(await read('../package.json'))
  assert.match(pkg.scripts.build, /node --test tests\\/\\*\\.test\\.mjs/)
  assert.match(pkg.scripts.build, /vite build/)
  assert.equal(pkg.dependencies.tronweb, '6.5.1')
})
