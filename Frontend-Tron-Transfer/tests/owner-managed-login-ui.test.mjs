import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../src/', import.meta.url)

test('Owner access uses backend password sessions and never imports browser wallet secrets', async () => {
  const ui = await readFile(new URL('OwnerWalletAccess.jsx', root), 'utf8')
  assert.match(ui, /createManagedWalletAuthClient\(\{ role: 'owner' \}\)/)
  assert.match(ui, /ownerAuth\.login\(password\)/)
  assert.match(ui, /ownerAuth\.enroll\(password, enrollmentToken\.trim\(\)\)/)
  assert.doesNotMatch(ui, /deriveOwnerAccount|saveOwnerWalletVault|unlockOwnerWalletVault|privateKey|mnemonic|keystore/i)
  assert.match(ui, /managedSession: true/)
})

test('Owner app restores and revokes the backend session', async () => {
  const app = await readFile(new URL('App.jsx', root), 'utf8')
  assert.match(app, /ownerAuthClient\.session\(\)/)
  assert.match(app, /ownerAuthClient\.logout\(\)/)
  assert.match(app, /backend-managed-owner/)
})

test('TRӾ panel fails closed while server-side operation signing is not enabled', async () => {
  const panel = await readFile(new URL('TRXMainnetPanel.jsx', root), 'utf8')
  assert.match(panel, /Backend-managed TRӾ signing and Mainnet operation preflight are not yet enabled/)
  assert.match(panel, /wallet\?\.tronWeb/)
})
