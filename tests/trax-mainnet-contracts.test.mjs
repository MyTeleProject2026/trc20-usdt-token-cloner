import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const tokenSource = await fs.readFile(new URL('../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')
const vaultSource = await fs.readFile(new URL('../contracts/OneTraxReserveVault.sol', import.meta.url), 'utf8')
const tronboxConfig = await fs.readFile(new URL('../Frontend-Tron-Transfer/trax-build/tronbox-config.js', import.meta.url), 'utf8')

test('TRӾ source pins the exact TRON Solidity compiler release and metadata', () => {
  assert.ok(tokenSource.includes('pragma solidity 0.8.25;'))
  assert.ok(tokenSource.includes('string public constant name = unicode"TRӾ";'))
  assert.ok(tokenSource.includes('string public constant symbol = "TRX";'))
  assert.ok(tokenSource.includes('uint8 public constant decimals = 6;'))
  assert.ok(tronboxConfig.includes("version: '0.8.25'"))
  assert.match(tronboxConfig, /optimizer:\s*\{\s*enabled:\s*true,\s*runs:\s*200\s*\}/)
})

test('TRӾ source exposes owner-controlled minting, lock management and redemption', () => {
  for (const method of ['totalSupply','balanceOf','allowance','isLocked','setRecipientLocked','mint','redeemForOwner','setPaused','setMintingEnabled']) {
    assert.match(tokenSource, new RegExp('function\\s+' + method + '\\s*\\('))
  }
  assert.ok(tokenSource.includes('mintingEnabled = false;'))
  assert.ok(tokenSource.includes('paused = true;'))
  assert.ok(tokenSource.includes('external onlyOwner'))
  assert.ok(tokenSource.includes('reserveBalance() >= _totalSupply + amount'))
})

test('TRӾ locked-account rules invalidate delegated approvals', () => {
  assert.ok(tokenSource.includes('struct AllowanceData { uint256 amount; uint256 ownerLockNonce; uint256 spenderLockNonce; }'))
  assert.ok(tokenSource.includes('if (wasLocked != locked) _lockNonce[account] += 1;'))
  assert.ok(tokenSource.includes('data.ownerLockNonce != _lockNonce[tokenOwner]'))
  assert.ok(tokenSource.includes('data.spenderLockNonce != _lockNonce[spender]'))
  assert.ok(tokenSource.includes('require(_unlocked[msg.sender] && _unlocked[from] && _unlocked[to]'))
})

test('native TRX reserve vault permits releases only through the authorized token contract', () => {
  assert.ok(vaultSource.includes('pragma solidity 0.8.25;'))
  assert.ok(vaultSource.includes('msg.sender == authorizedToken'))
  assert.ok(vaultSource.includes('address(this).balance >= amount'))
  assert.ok(!/function\s+(withdraw|sweep|rescue)\s*\(/i.test(vaultSource))
})
