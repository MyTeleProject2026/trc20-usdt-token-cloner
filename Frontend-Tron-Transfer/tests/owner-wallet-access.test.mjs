import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const access = await readFile(new URL('../src/OwnerWalletAccess.jsx', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/TRXMainnetPanel.jsx', import.meta.url), 'utf8')
const sidebar = await readFile(new URL('../src/TRAXSidebar.jsx', import.meta.url), 'utf8')

test('Owner Admin combines a managed application session with the independent encrypted local Owner vault', () => {
  assert.ok(app.includes("import OwnerWalletAccess from './OwnerWalletAccess.jsx'"))
  assert.ok(app.includes("createManagedWalletAuthClient({ role: 'owner' })"))
  assert.ok(app.includes('ownerAuthClient.session()'))
  assert.ok(!app.includes('TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'))
  assert.ok(app.includes("session.role === 'owner'"))
  assert.ok(!app.includes('tronlink-provider.mjs'))
  assert.ok(app.includes('ownerAuthClient.logout()'))
  assert.ok(access.includes("createManagedWalletAuthClient({ role: 'owner' })"))
  assert.ok(access.includes('status.ownerAddress'))
  assert.ok(access.includes('expectedOwnerAddress'))
  assert.ok(!access.includes('EXPECTED_OWNER_ADDRESS'))
  assert.ok(!access.includes('TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'))
  assert.ok(access.includes('ownerAuth.login(authPassword, OWNER_ADMIN_LOGIN_EMAIL)'))
  assert.ok(access.includes('ownerAuth.enroll(authPassword, enrollmentToken.trim(), initialAuthPassword)'))
  assert.ok(access.includes('Existing Owner password'))
  assert.ok(access.includes('Confirm new Owner password'))
  assert.ok(access.includes('initialAuthPassword.length < 12'))
  assert.doesNotMatch(access, /One-time Owner enrollment token/)
  assert.ok(access.includes('deriveOwnerAccount({ mode, value: credential, secretPassword: keystorePassword })'))
  assert.ok(access.includes('saveOwnerWalletVault(account, vaultPassword)'))
  assert.ok(access.includes('unlockOwnerWalletVault(unlockPassword)'))
  assert.ok(access.includes("signerType: 'encrypted-local-owner-vault'"))
  assert.ok(access.includes('tronWeb.trx?.sign'))
  assert.ok(access.includes('no TronLink connection required'))
  assert.doesNotMatch(access, /requestTronLinkConnection|discoverTronLinkProvider/)
})

test('TRӾ writes use the guarded backend operation API and local Owner signing while production gates remain authoritative', () => {
  assert.ok(panel.includes("wallet?.signerType === 'encrypted-local-owner-vault'"))
  assert.ok(panel.includes("typeof wallet?.tronWeb?.trx?.sign === 'function'"))
  assert.ok(panel.includes("apiRequest('/api/owner/operations/prepare'"))
  assert.ok(panel.includes("'/confirm'"))
  assert.ok(panel.includes('pendingOperation.executionEnabled'))
  assert.ok(panel.includes('Execution remains disabled'))
  assert.ok(panel.includes('disabled={!walletReady || busy'))
  assert.ok(panel.includes('signer.trx.sign(pendingOperation.unsignedTransaction)'))
  assert.ok(panel.includes('signer.trx.sign(deploymentOperation.unsignedTransaction)'))
  assert.doesNotMatch(panel, /requestTronLinkConnection|sendAndVerifyContractCall|deployContractWithOwnerSigner|sendRawTransaction/)
})

test('Owner sidebar describes the local vault action as unlocking, not connecting an external wallet', () => {
  assert.ok(sidebar.includes('Unlock Owner Wallet'))
  assert.ok(sidebar.includes("'Locked'"))
  assert.equal(sidebar.includes('Connect Owner Wallet'), false)
  assert.equal(sidebar.includes('Not connected'), false)
})

test('Owner application authentication is separate from the local transaction-signing key', () => {
  assert.ok(access.includes('managedSession: true'))
  assert.ok(access.includes("signerType: 'encrypted-local-owner-vault'"))
  assert.ok(access.includes('The private key is never sent to the Resource API'))
  assert.ok(access.includes('AES') || access.includes('encrypted local Owner Wallet'))
  assert.doesNotMatch(access, /TronLink holds the signing key/)
})
