import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const contract = await fs.readFile(path.resolve(here, '../../../contracts/Restricted1TRAX.sol'), 'utf8')

test('TRӾ is explicitly owner-issued and has no reserve or redemption dependency', () => {
  assert.match(contract, /contract Restricted1TRAX/)
  assert.match(contract, /function mint\(address recipient, uint256 amount\) external onlyOwner/)
  assert.match(contract, /function credit\(address recipient, uint256 amount, bytes32 reference\)/)
  assert.doesNotMatch(contract, /reserveVault|redeemForOwner|releaseForRedemption|insufficient-trx-reserve/)
})

test('only owner can authorize issuance and pause controls', () => {
  assert.match(contract, /function setMintingEnabled\(bool value\) external onlyOwner/)
  assert.match(contract, /function setPaused\(bool value\) external onlyOwner/)
  assert.match(contract, /function batchCredit\([\s\S]*?external onlyOwner whenNotPaused/)
})

test('external credits emit both standard TRC-20 Transfer and auditable owner-credit events', () => {
  assert.match(contract, /event Transfer\(address indexed from, address indexed to, uint256 value\)/)
  assert.match(contract, /event OwnerCredit\(address indexed recipient, uint256 amount, bytes32 indexed reference\)/)
  assert.match(contract, /emit Transfer\(address\(0\), recipient, amount\)/)
  assert.match(contract, /emit OwnerCredit\(recipient, amount, reference\)/)
})

test('batch credit is bounded and validates parallel array lengths', () => {
  assert.match(contract, /MAX_BATCH_CREDITS = 50/)
  assert.match(contract, /recipients\.length <= MAX_BATCH_CREDITS/)
  assert.match(contract, /amounts\.length == length && references\.length == length/)
})

test('minting rejects zero recipients, zero amounts, and uint256 supply overflow', () => {
  assert.match(contract, /require\(recipient != address\(0\), "zero-recipient"\)/)
  assert.match(contract, /require\(amount > 0, "zero-amount"\)/)
  assert.match(contract, /_totalSupply <= type\(uint256\)\.max - amount/)
})
