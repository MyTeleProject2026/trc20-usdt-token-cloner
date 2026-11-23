import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../src/', import.meta.url)

test('Owner access separates managed password authentication from encrypted local wallet signing', async () => {
  const ui = await readFile(new URL('OwnerWalletAccess.jsx', root), 'utf8')
  assert.ok(ui.includes("createManagedWalletAuthClient({ role: 'owner' })"))
  assert.ok(ui.includes('ownerAuth.login(authPassword)'))
  assert.ok(ui.includes('ownerAuth.enroll(authPassword, enrollmentToken.trim())'))
  assert.ok(ui.includes("import { createOwnerTronWeb, deriveOwnerAccount"))
  assert.ok(ui.includes('saveOwnerWalletVault(account, vaultPassword)'))
  assert.ok(ui.includes('unlockOwnerWalletVault(unlockPassword)'))
  assert.ok(ui.includes("signerType: 'encrypted-local-owner-vault'"))
  assert.ok(ui.includes('Local Mainnet signing · no TronLink connection required'))
  assert.ok(ui.includes('tronWeb.trx.sign'))
  assert.ok(ui.includes('The private key is never sent to the Resource API.'))
  assert.doesNotMatch(ui, /tronlink-provider|tron_requestAccounts|windowObject\?\.tron/i)
  assert.ok(ui.includes('managedSession: true'))
  assert.ok(ui.includes('ownerAuth.recoverPassword(recoveryToken.trim(), authPassword)'))
  assert.ok(ui.includes('One-time Owner recovery token'))
  assert.ok(ui.includes('Confirm new Owner password'))
  assert.ok(ui.includes('Recover Owner password'))
})

test('Owner app restores and revokes the backend session while keeping local signing separate', async () => {
  const app = await readFile(new URL('App.jsx', root), 'utf8')
  assert.ok(app.includes('ownerAuthClient.session()'))
  assert.ok(!app.includes('tronlink-provider.mjs'))
  assert.ok(app.includes('setOwnerAccessOpen(true)'))
  assert.ok(app.includes('Owner Wallet is unlocked'))
  assert.ok(app.includes('ownerAuthClient.logout()'))
  assert.ok(app.includes('encrypted local Owner Wallet is unlocked'))
})

test('TRӾ panel uses the managed Owner session and guarded backend operation workflow', async () => {
  const panel = await readFile(new URL('TRXMainnetPanel.jsx', root), 'utf8')
  assert.ok(panel.includes("wallet?.signerType === 'encrypted-local-owner-vault'"))
  assert.ok(panel.includes("typeof wallet?.tronWeb?.trx?.sign === 'function'"))
  assert.ok(panel.includes("apiRequest('/api/owner/operations/prepare'"))
  assert.ok(panel.includes("'/confirm'"))
  assert.ok(panel.includes('pendingOperation.executionEnabled'))
  assert.ok(panel.includes('solidified Mainnet block'))
  assert.ok(panel.includes('const getOwnerSigner = async () =>'))
  assert.ok(!panel.includes('tronlink-provider.mjs'))
  assert.ok(panel.includes('signer.trx.sign(pendingOperation.unsignedTransaction)'))
  assert.ok(panel.includes('signer.trx.sign(deploymentOperation.unsignedTransaction)'))
  assert.doesNotMatch(panel, /sendAndVerifyContractCall|deployContractWithOwnerSigner|tronWeb\.trx\.sign|sendRawTransaction/)
})

test('Owner account security exposes one-time role-scoped password recovery without displaying session tokens', async () => {
  const ui = await readFile(new URL('OwnerAccountSecurity.jsx', root), 'utf8')
  assert.ok(ui.includes('auth.recoverPassword(recoveryToken.trim(), recoveryPassword)'))
  assert.ok(ui.includes('One-time Owner recovery token'))
  assert.ok(ui.includes('Confirm new Owner password'))
  assert.ok(ui.includes('Recover Owner password'))
  assert.ok(ui.includes('all previous Owner sessions were revoked'))
  assert.doesNotMatch(ui, /sessionToken|privateKey|mnemonic/i)
})
