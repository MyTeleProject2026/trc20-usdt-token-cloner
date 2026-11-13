import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const generated = await fs.readFile(new URL('../src/generated/trax-contract-artifacts.js', import.meta.url), 'utf8')
const artifact = JSON.parse(generated.replace(/^export default /, '').replace(/;\\s*$/, ''))
const tokenSource = await fs.readFile(new URL('../../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')
const vaultSource = await fs.readFile(new URL('../../contracts/OneTraxReserveVault.sol', import.meta.url), 'utf8')

test('TronBox generated TRON-solc artifacts include both TRӾ Mainnet contracts', () => {
  assert.equal(artifact.compiler, 'TRON solc 0.8.25')
  assert.equal(artifact.optimizer.enabled, true)
  assert.equal(artifact.optimizer.runs, 200)
  assert.ok(artifact.token.bytecode.length > 0)
  assert.ok(artifact.vault.bytecode.length > 0)
  const tokenFunctions = artifact.token.abi.filter((item) => item.type === 'function').map((item) => item.name)
  const vaultFunctions = artifact.vault.abi.filter((item) => item.type === 'function').map((item) => item.name)
  for (const name of ['name','symbol','decimals','totalSupply','balanceOf','allowance','transfer','approve','transferFrom','owner','isLocked','setRecipientLocked','setReserveVault','setPaused','setMintingEnabled','mint','redeemForOwner']) {
    assert.ok(tokenFunctions.includes(name), 'Missing TRӾ ABI function: ' + name)
  }
  for (const name of ['owner','authorizedToken','reserveBalance','setAuthorizedToken','releaseForRedemption']) {
    assert.ok(vaultFunctions.includes(name), 'Missing reserve vault ABI function: ' + name)
  }
})

test('TRӾ metadata and default issuance protections remain exact', () => {
  assert.ok(tokenSource.includes('pragma solidity 0.8.25;'))
  assert.ok(tokenSource.includes('string public constant name = unicode"TRӾ";'))
  assert.ok(tokenSource.includes('string public constant symbol = "TRX";'))
  assert.ok(tokenSource.includes('uint8 public constant decimals = 6;'))
  assert.ok(tokenSource.includes('mintingEnabled = false;'))
  assert.ok(tokenSource.includes('paused = true;'))
  assert.ok(tokenSource.includes('external onlyOwner'))
  assert.ok(tokenSource.includes('reserveBalance() >= _totalSupply + amount'))
  assert.ok(tokenSource.includes('require(!_unlocked[recipient]'))
})

test('locked accounts cannot transfer, approve, or use delegated allowances', () => {
  assert.ok(tokenSource.includes('function isLocked(address account) public view returns (bool)'))
  assert.ok(tokenSource.includes('require(_unlocked[msg.sender], "sender-locked")'))
  assert.ok(tokenSource.includes('require(spender != address(0) && _unlocked[spender], "spender-locked")'))
  assert.ok(tokenSource.includes('require(_unlocked[msg.sender] && _unlocked[from] && _unlocked[to], "account-locked")'))
  assert.ok(tokenSource.includes('struct AllowanceData { uint256 amount; uint256 ownerLockNonce; uint256 spenderLockNonce; }'))
  assert.ok(tokenSource.includes('if (wasLocked != locked) _lockNonce[account] += 1;'))
  assert.ok(tokenSource.includes('data.ownerLockNonce != _lockNonce[tokenOwner]'))
  assert.ok(tokenSource.includes('data.spenderLockNonce != _lockNonce[spender]'))
})

test('native TRX vault can only release funds through its authorized token contract', () => {
  assert.ok(vaultSource.includes('pragma solidity 0.8.25;'))
  assert.ok(vaultSource.includes('msg.sender == authorizedToken'))
  assert.ok(vaultSource.includes('address(this).balance >= amount'))
  assert.ok(!/function\s+(withdraw|sweep|rescue)\s*\(/i.test(vaultSource))
  assert.ok(tokenSource.includes('external onlyOwner nonReentrant'))
  assert.ok(tokenSource.includes('releaseForRedemption(recipient, amount, redemptionReference)'))
})
