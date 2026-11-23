import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const access = await readFile(new URL('../src/OwnerWalletAccess.jsx', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/TRXMainnetPanel.jsx', import.meta.url), 'utf8')

test('Owner Admin uses the independent backend-managed password account', () => {
  assert.ok(app.includes("import OwnerWalletAccess from './OwnerWalletAccess.jsx'"))
  assert.ok(app.includes("createManagedWalletAuthClient({ role: 'owner' })"))
  assert.ok(app.includes('ownerAuthClient.session()'))
  assert.ok(app.includes('ownerAuthClient.logout()'))
  assert.ok(access.includes("createManagedWalletAuthClient({ role: 'owner' })"))
  assert.ok(access.includes('ownerAuth.login(password)'))
  assert.ok(access.includes('ownerAuth.enroll(password, enrollmentToken.trim())'))
  assert.ok(access.includes('backend-managed-owner'))
  assert.doesNotMatch(access, /deriveOwnerAccount|saveOwnerWalletVault|unlockOwnerWalletVault|createOwnerTronWeb|privateKey|owner-wallet-vault/i)
  assert.doesNotMatch(access, /localStorage|sessionStorage/)
})

test('TRӾ writes remain fail-closed until backend operation signing is integrated', () => {
  assert.ok(panel.includes('Backend-managed TRӾ signing and Mainnet operation preflight are not yet enabled'))
  assert.ok(panel.includes('const walletReady = Boolean(wallet?.tronWeb && connectedAddress === EXPECTED_OWNER_ADDRESS)'))
  assert.ok(panel.includes('disabled={!walletReady || busy'))
})

test('Managed Owner session is not represented as a browser-side transaction signer', () => {
  assert.ok(access.includes('managedSession: true'))
  assert.ok(access.includes('signerType: \'backend-managed-owner\''))
  assert.ok(access.includes('Contract signing remains disabled'))
  assert.doesNotMatch(access, /createOwnerTronWeb|tronWeb\.trx\.sign|sendRawTransaction/)
})
