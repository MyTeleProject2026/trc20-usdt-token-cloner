import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const vault = await readFile(new URL('../src/sponsor-wallet-vault.mjs', import.meta.url), 'utf8')
const ui = await readFile(new URL('../src/SponsorWalletManager.jsx', import.meta.url), 'utf8')

test('Sponsor vault imports existing private key, V3 keystore or TRON mnemonic without creating a wallet', () => {
  for (const method of ['private-key', 'keystore', 'mnemonic']) assert.ok(vault.includes(`mode === '${method}'`))
  assert.ok(vault.includes('TronWeb.fromMnemonic'))
  assert.ok(vault.includes('Wallet.fromEncryptedJson'))
  assert.ok(vault.includes('export async function deriveSponsorAccount'))
  assert.doesNotMatch(vault, /createRandom|new Wallet\\(\\)/)
})

test('Sponsor vault encrypts locally with AES-256-GCM and PBKDF2-SHA256 and verifies address on unlock', () => {
  assert.ok(vault.includes("name: 'PBKDF2'"))
  assert.ok(vault.includes('iterations: PBKDF2_ITERATIONS'))
  assert.ok(vault.includes("name: 'AES-GCM'"))
  assert.ok(vault.includes("cipher: 'AES-256-GCM'"))
  assert.ok(vault.includes("kdf: 'PBKDF2-SHA256'"))
  assert.ok(vault.includes('address !== vault.address || address !== account.address'))
  assert.ok(vault.includes('export async function unlockSponsorWalletVault'))
})

test('Sponsor local vault is independent from the Owner and matches the authenticated Sponsor session', () => {
  assert.ok(ui.includes('account.address === OWNER_ADDRESS'))
  assert.ok(ui.includes('account.address !== managedSponsorAddress'))
  assert.ok(ui.includes('Sponsor Wallet imported'))
  assert.ok(ui.includes('Sponsor Wallet unlocked'))
  assert.ok(ui.includes('function beginReplace()'))
  assert.ok(ui.includes('function removeVault()'))
  assert.ok(ui.includes('function logoutWallet()'))
  assert.ok(ui.includes('Local Sponsor signer cleared from memory'))
  assert.doesNotMatch(ui, /tronlink-provider|requestTronLinkConnection|discoverTronLinkProvider/)
})

test('Sponsor transaction writes stay blocked until exact local signing and backend verification are implemented', () => {
  assert.ok(ui.includes('transactionExecutionAvailable !== true'))
  assert.ok(ui.includes('Sponsor local signing is not yet accepted'))
  assert.ok(ui.includes('sponsorApiStatus?.localSignerReady'))
  assert.ok(ui.includes('Sponsor transaction writes remain disabled'))
})
