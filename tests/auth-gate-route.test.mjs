import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const ownerApp = await readFile(new URL('../src/OwnerControlApp.tsx', import.meta.url), 'utf8')
const ownerRoute = await readFile(new URL('../server/routes/owner-auth.mjs', import.meta.url), 'utf8')
const walletVault = await readFile(new URL('../src/WalletVault.tsx', import.meta.url), 'utf8')

test('the bundled app has one owner-only entry point and does not expose legacy routes', () => {
  assert.match(entry, /import OwnerControlApp from '\.\/OwnerControlApp'/)
  assert.match(entry, /<OwnerControlApp \/>/)
  assert.doesNotMatch(entry, /AuthGate|WorkflowApp|SponsorSignerConsole|MainnetExchangeDeposit|OkxDepositStatus|WatchOnlyWallets/)
  assert.match(ownerApp, /<WalletVault \/>/)
  assert.match(ownerApp, /\/api\/owner-auth\/session/)
  assert.match(ownerApp, /\/api\/owner-auth\/login/)
  assert.match(ownerApp, /\/api\/owner-auth\/setup/)
  assert.match(ownerApp, /Owner session active/)
})

test('owner login is separate from TronLink and initializes exactly one account', () => {
  assert.match(ownerApp, /Create your owner account/)
  assert.match(ownerApp, /No TronLink required for app login/)
  assert.match(ownerApp, /wallet keys remain separately encrypted in the local vault/)
  assert.match(ownerRoute, /owner-account-already-initialized/)
  assert.match(ownerRoute, /OWNER_SETUP_KEY/)
  assert.match(ownerRoute, /passwordHasher/)
  assert.match(ownerRoute, /passwordVerifier/)
  assert.match(ownerRoute, /randomBytes\(32\)/)
  assert.match(ownerRoute, /digest\(token\)/)
})

test('owner auth never accepts private-key material and uses opaque origin-bound sessions', () => {
  assert.doesNotMatch(ownerRoute, /req\.body\.(privateKey|seedPhrase|mnemonic)|privateKey:/i)
  assert.match(ownerRoute, /requestOrigin\(req, env\)/)
  assert.match(ownerRoute, /expiresAt/)
  assert.match(ownerRoute, /deleteSession/)
  assert.match(walletVault, /encryptWalletPrivateKey/)
  assert.match(walletVault, /buildSignAndBroadcastTransfer/)
})
