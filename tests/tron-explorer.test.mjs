import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  getTronScanAddressUrl,
  getTronScanNetworkLabel,
  getTronScanTransactionUrl,
} from '../src/tron-explorer.mjs'

const txId = 'A'.repeat(64)
const address = 'T' + 'A'.repeat(33)

test('transaction links stay on the exact network and use the official explorer origin', () => {
  assert.equal(getTronScanTransactionUrl('mainnet', txId), `https://tronscan.org/#/transaction/${txId.toLowerCase()}`)
  assert.equal(getTronScanTransactionUrl('nile', txId), `https://nile.tronscan.org/#/transaction/${txId.toLowerCase()}`)
  assert.equal(getTronScanTransactionUrl('shasta', txId), `https://shasta.tronscan.org/#/transaction/${txId.toLowerCase()}`)
  assert.equal(getTronScanTransactionUrl('shasta', 'not-a-transaction-id'), null)
  assert.equal(getTronScanTransactionUrl('https://attacker.invalid', txId), null)
  assert.equal(getTronScanTransactionUrl('mainnet\n', txId), null)
})

test('address links are limited to known networks and TRON-shaped addresses', () => {
  assert.equal(getTronScanAddressUrl('nile', address), `https://nile.tronscan.org/#/address/${address}`)
  assert.equal(getTronScanAddressUrl('shasta', address), `https://shasta.tronscan.org/#/address/${address}`)
  assert.equal(getTronScanAddressUrl('mainnet', address), `https://tronscan.org/#/address/${address}`)
  assert.equal(getTronScanAddressUrl('nile', 'https://attacker.invalid'), null)
  assert.equal(getTronScanAddressUrl('invalid', address), null)
})

test('explorer labels make the selected chain explicit', () => {
  assert.equal(getTronScanNetworkLabel('mainnet'), 'Mainnet TronScan')
  assert.equal(getTronScanNetworkLabel('nile'), 'Nile TronScan')
  assert.equal(getTronScanNetworkLabel('shasta'), 'Shasta TronScan')
  assert.equal(getTronScanNetworkLabel('unknown'), null)
})

test('the app explains testnet isolation and does not present explorer links as conversion', async () => {
  const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
  assert.ok(app.includes('getTronScanTransactionUrl'))
  assert.ok(app.includes('getTronScanAddressUrl'))
  assert.match(app, /cannot be converted to Mainnet/i)
  assert.match(app, /does not move assets|cannot convert tokens/i)
  assert.match(app, /This does not confirm exchange credit/)
})


test('sponsor console verifies accepted transfers and links the exact transaction on the selected explorer', async () => {
  const consoleSource = await readFile(new URL('../src/SponsorSignerConsole.tsx', import.meta.url), 'utf8')
  assert.ok(consoleSource.includes("getTronScanTransactionUrl(lastIntent?.reservation?.network, lastResult?.transactionHash)"))
  assert.ok(consoleSource.includes("getTronScanNetworkLabel(lastIntent?.reservation?.network)"))
  assert.ok(consoleSource.includes("verifyReceiverSettlement(prepared.payload, submitted.payload)"))
  assert.ok(consoleSource.includes('Preflight is read-only; sponsor signature and resource gates still apply'))
  assert.equal(consoleSource.includes('Signing and submission remain disabled'), false)
  assert.match(consoleSource, /Open \{transferExplorerLabel \|\| 'transaction'\} in TronScan/)
  assert.match(consoleSource, /keep the same transaction ID for the operator's manual retry/)
})

test('sponsor console restores only the role matching the active TronLink account and explains missing reservations', async () => {
  const consoleSource = await readFile(new URL('../src/SponsorSignerConsole.tsx', import.meta.url), 'utf8')
  assert.match(consoleSource, /const provider = getInjectedTronProvider\(\)/)
  assert.match(consoleSource, /const candidates = \[window\.tron, window\.tronLink\]/)
  assert.match(consoleSource, /method: 'eth_requestAccounts'/)
  assert.match(consoleSource, /await requestTronWalletAccess\(provider\)/)
  assert.match(consoleSource, /provider\.on\('accountsChanged', onAccountsChanged\)/)
  assert.match(consoleSource, /provider\.on\('chainChanged', onChainChanged\)/)
  assert.match(consoleSource, /activeAddress === wallet\.address/)
  assert.match(consoleSource, /activeAddress === feeWallet\.address/)
  assert.match(consoleSource, /setWalletNeedsReconnect\(!assetRoleActive\)/)
  assert.match(consoleSource, /setFeeWalletNeedsReconnect\(!feeRoleActive\)/)
  assert.match(consoleSource, /Both public role addresses are retained for reference/)
  assert.match(consoleSource, /No approved reservation was found for that key/)
  assert.match(consoleSource, /docs\/SPONSOR_RESERVATION_IDEMPOTENCY\.md/)
  assert.match(consoleSource, /feeWalletNeedsReconnect/)
})
