import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('frontend exposes only Nile and Shasta RPC networks', () => {
  assert.ok(app.includes("nile: { label: 'Nile Testnet', rpc: API_BASE + '/api/tatum/rpc/nile'"))
  assert.ok(app.includes("shasta: { label: 'Shasta Testnet', rpc: API_BASE + '/api/tatum/rpc/shasta'"))
  assert.equal(app.includes('trongrid.io'), false)
  assert.match(app, /<option value="nile">Nile Testnet<\/option><option value="shasta">Shasta Testnet<\/option>/)
})

test('frontend uses the shared local-signing and encrypted-keystore helpers', () => {
  assert.match(app, /buildSignAndBroadcastTransfer/)
  assert.match(app, /encryptWalletPrivateKey/)
  assert.match(app, /decryptWalletPrivateKey/)
  assert.match(app, /verifyTransferRecordOnChain/)
  assert.equal(packageJson.scripts.build, 'vite build')
})

test('frontend never claims that a testnet transfer credits a third-party Mainnet exchange', () => {
  assert.match(app, /do not create official Mainnet Tether deposits/)
  assert.match(app, /exchange's Mainnet deposit account is not credited/)
})
