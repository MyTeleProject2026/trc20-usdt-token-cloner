import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8')

test('wallet vault is reachable without bypassing the signed workspace gate', async () => {
  const entry = await read('src/main.tsx')
  const authGate = await read('src/AuthGate.tsx')
  const workflow = await read('src/WorkflowApp.tsx')
  assert.match(entry, /const isWalletVault = route === '#\/wallet'/)
  assert.match(entry, /isWalletVault\s*\n\s*\? <WalletVault \/>/)
  assert.match(authGate, /href="#\/wallet"/)
  assert.match(workflow, /href="#\/wallet"><Wallet/)
  assert.match(authGate, /\/api\/auth\/tron\/verify/)
})

test('wallet creation, import and restore encrypt key material before local persistence', async () => {
  const vault = await read('src/WalletVault.tsx')
  const crypto = await read('src/wallet-vault-crypto.mjs')
  assert.match(vault, /await web\.createAccount\(\)/)
  assert.match(vault, /encryptWalletPrivateKey\(privateKey, address, chosenPassword\)/)
  assert.match(vault, /decryptWalletPrivateKey\(record, password\)/)
  assert.match(vault, /localStorage\.setItem\(VAULT_KEY, JSON\.stringify\(\{ version: 1, wallets: next \}\)\)/)
  assert.match(crypto, /PBKDF2/)
  assert.match(crypto, /AES-GCM/)
  assert.match(crypto, /iterations: ITERATIONS/)
  assert.doesNotMatch(vault, /fetch\([^\n]*privateKey|JSON\.stringify\(\{[^}]*privateKey/)
})

test('wallet vault signs only a backend-provided login message and never calls a transfer or broadcast method', async () => {
  const vault = await read('src/WalletVault.tsx')
  assert.match(vault, /\/api\/auth\/tron\/challenge/)
  assert.match(vault, /signer\.trx\.signMessageV2\(challenge\.message\)/)
  assert.match(vault, /JSON\.stringify\(\{ address, network, nonce: challenge\.nonce, signature \}\)/)
  assert.doesNotMatch(vault, /trx\.sendTransaction|sendRawTransaction|\.transfer\([^\n]*\.send\(/)
  assert.match(vault, /web\.trx\.getBalance\(unlocked\.record\.address\)/)
  assert.match(vault, /TOKEN_ABI/)
  assert.match(vault, /The contract is not endorsed or allowlisted for transfers/)
})

test('native APK workflow bundles the local wallet UI and keeps the Android build reproducible', async () => {
  const config = JSON.parse(await read('capacitor.config.json'))
  const workflow = await read('.github/workflows/package-installers.yml')
  assert.equal(config.webDir, 'dist-mobile')
  assert.equal(config.server.hostname, 'localhost')
  assert.match(workflow, /npm ci/)
  assert.match(workflow, /npx cap add android/)
  assert.match(workflow, /npx cap sync android/)
  assert.match(workflow, /assembleDebug/)
  assert.match(workflow, /name: tron-token-studio-android-debug-apk/)
})
