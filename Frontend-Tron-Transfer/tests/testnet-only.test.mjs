import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('frontend exposes only Nile and Shasta RPC networks', () => {
  assert.match(app, /nile: \{ label: 'Nile Testnet', rpc: 'https:\/\/nile\.trongrid\.io'/)
  assert.match(app, /shasta: \{ label: 'Shasta Testnet', rpc: 'https:\/\/api\.shasta\.trongrid\.io'/)
  assert.doesNotMatch(app, /https:\/\/api\.trongrid\.io/)
  assert.match(app, /<option value="nile">Nile Testnet<\/option><option value="shasta">Shasta Testnet<\/option>/)
})

test('recipient inspection defaults to Nile and keeps explicit Mainnet and Shasta choices', () => {
  assert.match(app, /const \[recipientNetwork, setRecipientNetwork\] = useState\('nile'\)/)
  assert.match(app, /<option value="mainnet">TRON Mainnet<\/option>/)
  assert.match(app, /<option value="nile">Nile Testnet<\/option>/)
  assert.match(app, /<option value="shasta">Shasta Testnet<\/option>/)
})

test('frontend uses the shared local-signing and encrypted-keystore helpers', () => {
  assert.match(app, /buildSignAndBroadcastTransfer/)
  assert.match(app, /encryptWalletPrivateKey/)
  assert.match(app, /decryptWalletPrivateKey/)
  assert.match(app, /verifyTransferRecordOnChain/)
  assert.equal(packageJson.scripts.build, 'vite build')
})

test('frontend never claims that a testnet transfer credits a third-party Mainnet exchange', () => {
  assert.match(app, /exchange's Mainnet deposit account is not credited by a testnet transaction/)
  assert.match(app, /This sends only from the unlocked wallet's own testnet balance/)
})
