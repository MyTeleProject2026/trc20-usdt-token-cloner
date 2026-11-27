import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
test('Owner session restores a protected device wallet without storing the Owner Admin password', async () => {
  const ui = await readFile(new URL('../src/OwnerWalletAccess.jsx', import.meta.url), 'utf8')
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.ok(ui.includes('hasOwnerDeviceWallet()'))
  assert.ok(ui.includes('unlockOwnerDeviceWallet()'))
  assert.ok(ui.includes('saveOwnerDeviceWallet(account)'))
  assert.ok(ui.includes('Owner Admin session restored'))
  assert.ok(app.includes("new Event('tron-transfer:owner-session-ended')"))
  assert.ok(app.includes('sponsor-device-ready'))
  assert.doesNotMatch(app, /localStorage\.setItem\([^\n]*ownerAdminPassword/)
})
