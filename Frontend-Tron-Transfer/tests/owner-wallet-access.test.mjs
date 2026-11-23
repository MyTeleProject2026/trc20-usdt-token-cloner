import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const access = await readFile(new URL('../src/OwnerWalletAccess.jsx', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/TRXMainnetPanel.jsx', import.meta.url), 'utf8')

test('Owner Admin combines a managed password session with a matching TronLink signer', () => {
  assert.ok(app.includes("import OwnerWalletAccess from './OwnerWalletAccess.jsx'"))
  assert.ok(app.includes("createManagedWalletAuthClient({ role: 'owner' })"))
  assert.ok(app.includes('ownerAuthClient.session()'))
  assert.ok(app.includes('ownerAuthClient.logout()'))
  assert.ok(access.includes("createManagedWalletAuthClient({ role: 'owner' })"))
  assert.ok(access.includes('ownerAuth.login(password)'))
  assert.ok(access.includes('ownerAuth.enroll(password, enrollmentToken.trim())'))
  assert.ok(access.includes("signerType: 'tronlink-owner'"))
  assert.ok(access.includes('requestTronLinkConnection(provider, window)'))
  assert.ok(access.includes('tronWeb: connection.tronWeb'))
  assert.doesNotMatch(access, /deriveOwnerAccount|saveOwnerWalletVault|unlockOwnerWalletVault|createOwnerTronWeb|owner-wallet-vault/i)
  assert.doesNotMatch(access, /localStorage|sessionStorage/)
})

test('TRӾ writes use the guarded backend operation API and remain gated by production readiness', () => {
  assert.ok(panel.includes('wallet?.provider?.request'))
  assert.ok(panel.includes("typeof wallet?.tronWeb?.trx?.sign === 'function'"))
  assert.ok(panel.includes("apiRequest('/api/owner/operations/prepare'"))
  assert.ok(panel.includes("'/confirm'"))
  assert.ok(panel.includes('pendingOperation.executionEnabled'))
  assert.ok(panel.includes('Execution remains disabled'))
  assert.ok(panel.includes('disabled={!walletReady || busy'))
  assert.doesNotMatch(panel, /sendAndVerifyContractCall|deployContractWithOwnerSigner|tronWeb\.trx\.sign|sendRawTransaction/)
})

test('Managed Owner password session is separate from the TronLink transaction signer', () => {
  assert.ok(access.includes('managedSession: true'))
  assert.ok(access.includes("signerType: 'tronlink-owner'"))
  assert.ok(access.includes('TronLink holds the signing key and must approve every transaction separately.'))
  assert.doesNotMatch(access, /createOwnerTronWeb|tronWeb\.trx\.sign|sendRawTransaction/)
})
