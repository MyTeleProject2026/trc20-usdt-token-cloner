import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const component = await readFile(new URL('../Frontend-Tron-Transfer/src/SponsorWalletManager.jsx', import.meta.url), 'utf8')
const vault = await readFile(new URL('../Frontend-Tron-Transfer/src/sponsor-wallet-vault.mjs', import.meta.url), 'utf8')

test('Sponsor Wallet is import-only and never sends credentials to the API', () => {
  assert.ok(component.includes('Import existing Sponsor Wallet'))
  assert.ok(component.includes("['private-key','Private key']"))
  assert.ok(component.includes("['keystore','Keystore JSON']"))
  assert.ok(component.includes("['mnemonic','Mnemonic phrase']"))
  assert.doesNotMatch(component, /createWallet|Create Wallet/i)
  assert.ok(vault.includes('AES-GCM'))
  assert.ok(vault.includes('PBKDF2'))
  assert.doesNotMatch(component, /JSON.stringify\(\{[^}]*privateKey/i)
})

test('Sponsor Wallet verifies exact unsigned Mainnet transactions before signing', () => {
  assert.ok(component.includes('validateUnsignedResourceTransaction(tronWeb, unsigned'))
  assert.ok(component.includes('FreezeBalanceV2Contract'))
  assert.ok(component.includes('DelegateResourceContract'))
  assert.ok(component.includes('The unsigned delegation receiver does not match'))
  assert.ok(component.includes('transaction expiration is missing'))
  assert.ok(component.includes('signed.txID !== unsigned.txID'))
})

test('Sponsor activity supports persistent local pending records and solidified backend verification', () => {
  assert.ok(component.includes('ACTIVITY_KEY'))
  assert.ok(component.includes('recordActivity(event)'))
  assert.ok(component.includes('/api/tron/sponsorship/resource-delegations/verify-wallet'))
  assert.ok(component.includes('payload.persistence?.persisted !== true'))
  assert.ok(component.includes('solidified-mainnet-verified'))
  assert.ok(component.includes('/api/tron/sponsorship/resource-delegations?network=mainnet'))
  assert.ok(component.includes('Verify Mainnet delegation'))
  assert.ok(component.includes('setLastDelegation(rows.find'))
})

test('background monitoring is quiet and center notifications have a single managed timer', () => {
  assert.ok(component.includes('refresh({ quiet: true })'))
  assert.ok(component.includes('window.clearTimeout(toastTimer.current)'))
  assert.equal((component.match(/<CenterToast/g) || []).length, 1)
})
