import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  assertOwnerMainnetTransferAccess,
  ownerMainnetTransferAccessError,
} from '../src/owner-transfer-policy.mjs'

const ownerAddress = 'T' + 'A'.repeat(33)
const now = Date.parse('2026-10-28T10:00:00.000Z')
const validSnapshot = {
  success: true,
  ownerAccessVerified: true,
  status: 'on-chain-funding-read',
  network: 'mainnet',
  onChainBalanceRead: true,
  treasuryAddress: ownerAddress,
  checkedAt: new Date(now).toISOString(),
}

test('testnet transfer review does not require Mainnet owner verification', () => {
  assert.equal(ownerMainnetTransferAccessError({
    network: 'nile',
    from: ownerAddress,
    snapshot: null,
    now,
  }), null)
  assert.equal(assertOwnerMainnetTransferAccess({
    network: 'shasta',
    from: ownerAddress,
    snapshot: null,
    now,
  }), true)
})

test('Mainnet transfer is denied before a verified owner treasury check', () => {
  const error = ownerMainnetTransferAccessError({
    network: 'mainnet', from: ownerAddress, snapshot: null, now,
  })
  assert.match(error, /owner-only/i)
  assert.throws(() => assertOwnerMainnetTransferAccess({
    network: 'mainnet', from: ownerAddress, snapshot: null, now,
  }), /owner-only/i)
})

test('Mainnet owner check must prove current Mainnet chain balance and status', () => {
  for (const patch of [
    { ownerAccessVerified: false },
    { status: 'read-only' },
    { network: 'nile' },
    { onChainBalanceRead: false },
  ]) {
    assert.notEqual(ownerMainnetTransferAccessError({
      network: 'mainnet',
      from: ownerAddress,
      snapshot: { ...validSnapshot, ...patch },
      now,
    }), null)
  }
})

test('Mainnet sends are denied if local signing address differs from configured treasury', () => {
  assert.match(ownerMainnetTransferAccessError({
    network: 'mainnet',
    from: 'T' + 'B'.repeat(33),
    snapshot: validSnapshot,
    now,
  }), /not the configured owner treasury/i)
})

test('expired or future-dated owner checks fail closed', () => {
  const stale = { ...validSnapshot, checkedAt: new Date(now - 5 * 60 * 1000 - 1).toISOString() }
  const future = { ...validSnapshot, checkedAt: new Date(now + 31 * 1000).toISOString() }
  assert.match(ownerMainnetTransferAccessError({
    network: 'mainnet', from: ownerAddress, snapshot: stale, now,
  }), /expired/i)
  assert.match(ownerMainnetTransferAccessError({
    network: 'mainnet', from: ownerAddress, snapshot: future, now,
  }), /expired/i)
})

test('fresh authenticated owner treasury snapshot matching the local signer is allowed', () => {
  assert.equal(ownerMainnetTransferAccessError({
    network: 'mainnet', from: ownerAddress, snapshot: validSnapshot, now,
  }), null)
  assert.equal(assertOwnerMainnetTransferAccess({
    network: 'mainnet', from: ownerAddress, snapshot: validSnapshot, now,
  }), true)
})

test('Wallet Vault checks the owner policy at review and broadcast, not just in the UI button', async () => {
  const ui = await readFile(new URL('../src/WalletVault.tsx', import.meta.url), 'utf8')
  assert.ok(ui.includes("import { assertOwnerMainnetTransferAccess } from './owner-transfer-policy.mjs'"))
  assert.match(ui, /async function prepareTransfer\(\)[\s\S]{0,800}assertOwnerMainnetTransferAccess/)
  assert.match(ui, /async function broadcastTransfer\(\)[\s\S]{0,900}assertOwnerMainnetTransferAccess/)
})
