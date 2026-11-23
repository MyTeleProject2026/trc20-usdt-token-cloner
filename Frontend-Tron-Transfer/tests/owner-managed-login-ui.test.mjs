import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../src/', import.meta.url)

test('Owner access uses backend password sessions and never imports browser wallet secrets', async () => {
  const ui = await readFile(new URL('OwnerWalletAccess.jsx', root), 'utf8')
  assert.ok(ui.includes("createManagedWalletAuthClient({ role: 'owner' })"))
  assert.ok(ui.includes('ownerAuth.login(password)'))
  assert.ok(ui.includes('ownerAuth.enroll(password, enrollmentToken.trim())'))
  // Security copy may mention secrets to prohibit pasting them. Assert the
  // absence of actual browser key-management APIs, not warning vocabulary.
  assert.doesNotMatch(ui, /deriveOwnerAccount|saveOwnerWalletVault|unlockOwnerWalletVault|createOwnerTronWeb|tronWeb\.trx\.sign|sendRawTransaction/i)
  assert.ok(ui.includes('managedSession: true'))
  assert.ok(ui.includes('ownerAuth.recoverPassword(recoveryToken.trim(), password)'))
  assert.ok(ui.includes('One-time Owner recovery token'))
  assert.ok(ui.includes('Confirm new Owner password'))
  assert.ok(ui.includes('Recover Owner password'))
})

test('Owner app restores and revokes the backend session', async () => {
  const app = await readFile(new URL('App.jsx', root), 'utf8')
  assert.ok(app.includes('ownerAuthClient.session()'))
  assert.ok(app.includes('ownerAuthClient.logout()'))
  assert.ok(app.includes('backend-managed-owner'))
})

test('TRӾ panel uses the managed Owner session and guarded backend operation workflow', async () => {
  const panel = await readFile(new URL('TRXMainnetPanel.jsx', root), 'utf8')
  assert.ok(panel.includes('wallet?.managedSession && connectedAddress === EXPECTED_OWNER_ADDRESS'))
  assert.ok(panel.includes("apiRequest('/api/owner/operations/prepare'"))
  assert.ok(panel.includes("'/confirm'"))
  assert.ok(panel.includes('pendingOperation.executionEnabled'))
  assert.ok(panel.includes('solidified Mainnet block'))
  assert.doesNotMatch(panel, /sendAndVerifyContractCall|deployContractWithOwnerSigner|tronWeb\.trx\.sign|sendRawTransaction/)
})
