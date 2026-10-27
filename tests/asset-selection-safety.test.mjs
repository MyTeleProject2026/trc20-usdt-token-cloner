import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')

test('the asset principal stage offers only a native TRX asset or an explicitly selected TRC-20 contract', () => {
  assert.ok(app.includes("type AssetKind = 'TRX' | 'TRC20'"))
  assert.ok(app.includes("setAssetKind('TRX')"))
  assert.ok(app.includes("setAssetKind('TRC20')"))
  assert.ok(app.includes('Token contract address on'))
  assert.ok(app.includes('ADDRESS_PATTERN.test(tokenContract.trim())'))
  assert.ok(app.includes('This is not official Mainnet USDT'))
  assert.ok(!app.includes("setAssetKind('USDT')"))
})

test('sender and receiver validation controls readiness while stages remain directly navigable', () => {
  assert.ok(app.includes("type NetworkId = 'shasta' | 'nile'"))
  assert.ok(app.includes('checkedWalletNetwork(tronWeb, network)'))
  assert.ok(app.includes('const senderStageValid = ADDRESS_PATTERN.test(senderAddress)'))
  assert.ok(app.includes('const receiverStageValid = ADDRESS_PATTERN.test(receiverAddress)'))
  assert.ok(app.includes('const canEnterStep = (index: number) => index >= 0 && index < STEPS.length'))
  assert.ok(app.includes('Every section can be opened directly. Validation still controls Continue and final review status.'))
  assert.ok(app.includes('disabled={!stageCompletion[step]}'))
})

test('changing test networks clears stale wallet and receiver data', () => {
  assert.ok(app.includes('setNetwork(next)'))
  assert.ok(app.includes('setSenderAddress(\'\')'))
  assert.ok(app.includes('setNativeSnapshot(null)'))
  assert.ok(app.includes('setSenderTokenSnapshot(null)'))
  assert.ok(app.includes('setReceiverSnapshot(null)'))
  assert.ok(app.includes('setReceiverAddress(\'\')'))
})

test('wallet inspection uses TronLink or watch-only public address without collecting private keys', () => {
  assert.ok(app.includes('Connect TronLink'))
  assert.ok(app.includes('Watch-only address'))
  assert.ok(app.includes('Inspect watch-only wallet'))
  assert.ok(!app.includes('privateKey'))
  assert.ok(app.includes('does not ask for a seed phrase'))
  assert.ok(app.includes('sendDirectTestnetTransfer'))
  assert.ok(app.includes('sendRawTransaction(signed)'))
  assert.ok(app.includes("if (network !== 'nile' && network !== 'shasta')"))
  assert.ok(!entry.includes('TransferSimulator'))
})
