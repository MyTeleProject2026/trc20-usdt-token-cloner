import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const access = await readFile(new URL('../src/OwnerWalletAccess.jsx', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/TRXMainnetPanel.jsx', import.meta.url), 'utf8')
const vault = await readFile(new URL('../src/owner-wallet-vault.mjs', import.meta.url), 'utf8')
const signer = await readFile(new URL('../src/trax-mainnet.mjs', import.meta.url), 'utf8')

test('Owner Admin connects to its independent local encrypted Owner Wallet instead of an injected DApp wallet', () => {
  assert.ok(app.includes("import OwnerWalletAccess from './OwnerWalletAccess.jsx'"))
  assert.ok(app.includes('<OwnerWalletAccess onUnlock={acceptOwnerWallet}'))
  assert.ok(access.includes('encrypted-local-owner-vault'))
  assert.doesNotMatch(app, /discoverTronLinkProvider|requestTronLinkConnection/)
  assert.ok(access.includes('Import and unlock Owner Wallet'))
  assert.ok(access.includes('V3 Keystore JSON'))
  assert.ok(access.includes('Mnemonic phrase'))
  assert.ok(access.includes('Expected owner address'))
  assert.doesNotMatch(access, /fetch\s*\(|XMLHttpRequest|sendBeacon/)
  assert.ok(vault.includes('AES-GCM'))
  assert.ok(vault.includes('PBKDF2'))
})

test('TRӾ owner contract actions consume the local TronWeb signer and no longer instruct operators to use TronLink', () => {
  assert.ok(panel.includes('deployContractWithOwnerSigner(wallet'))
  assert.ok(panel.includes('local Owner Wallet signing'))
  assert.ok(panel.includes('local Owner signature required'))
  assert.doesNotMatch(panel, /Connect owner TronLink|opening TronLink|TronLink approval required/)
})

test('Owner deployment and contract writes require an explicit confirmation before local signing', () => {
  const deploymentStart = signer.indexOf('export async function deployContractWithOwnerSigner')
  const deploymentEnd = signer.indexOf('export const deployContractFromTronLink', deploymentStart)
  const deployment = signer.slice(deploymentStart, deploymentEnd)
  assert.ok(deployment.includes('confirmAction('))
  assert.ok(deployment.indexOf('confirmAction(') < deployment.indexOf('walletTronWeb.trx.sign(walletTransaction)'))
  const callsStart = signer.indexOf('export async function sendAndVerifyContractCall')
  const callsEnd = signer.indexOf('export async function sendNativeTrxFromTronLink', callsStart)
  const calls = signer.slice(callsStart, callsEnd)
  assert.ok(calls.includes('confirmAction('))
  assert.ok(calls.indexOf('confirmAction(') < calls.indexOf('signTransaction(unsigned)'))
  assert.ok(calls.indexOf('confirmAction(') < calls.indexOf('broadcastTransaction(signedTransaction)'))
})
