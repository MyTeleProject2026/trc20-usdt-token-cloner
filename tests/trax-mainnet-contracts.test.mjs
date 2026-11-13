import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import solc from 'solc'

test('TRӾ and native-TRX reserve vault compile for the TRON Paris-compatible target', async () => {
  const tokenSource = await fs.readFile(new URL('../contracts/Restricted1TR1AX.sol', import.meta.url).catch(()=>new URL('../contracts/Restricted1TRAX.sol', import.meta.url)), 'utf8')
  const vaultSource = await fs.readFile(new URL('../contracts/OneTraxReserveVault.sol', import.meta.url), 'utf8')
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
      'Restricted1TRAX.sol': { content: tokenSource },
      'OneTraxReserveVault.sol': { content: vaultSource },
    },
    settings: {
      evmVersion: 'paris',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  })))
  const errors = (output.errors || []).filter((entry) => entry.severity === 'error')
  assert.deepEqual(errors, [])
  const token = output.contracts?.['Restricted1TRAX.sol']?.Restricted1TRAX
  const vault = output.contracts?.['OneTraxReserveVault.sol']?.OneTraxReserveVault
  assert.ok(token?.evm?.bytecode?.object?.length > 0)
  assert.ok(vault?.evm?.bytecode?.object?.length > 0)
  const tokenFunctions = token.abi.filter((entry) => entry.type === 'function').map((entry) => entry.name)
  const vaultFunctions = vault.abi.filter((entry) => entry.type === 'function').map((entry) => entry.name)
  for (const name of ['name','symbol','decimals','owner','pendingOwner','transferOwnership','acceptOwnership','totalSupply','balanceOf','allowance','isLocked','setRecipientLocked','setReserveVault','setPaused','setMintingEnabled','mint','redeemForOwner','transfer','approve','transferFrom']) {
    assert.ok(tokenFunctions.includes(name), 'missing TRӾ function: ' + name)
  }
  for (const name of ['owner','authorizedToken','reserveBalance','setAuthorizedToken','releaseForRedemption']) assert.ok(vaultFunctions.includes(name))
  assert.ok(tokenSource.includes('name = unicode"TRӾ"'))
  assert.ok(tokenSource.includes('symbol = "TRX"'))
  assert.ok(tokenSource.includes('decimals = 6'))
  assert.ok(tokenSource.includes('require(IOneTraxReserveVault(reserveVault).reserveBalance() >= _totalSupply + amount'))
  assert.ok(tokenSource.includes('function isLocked(address account) public view returns (bool) { return !_unlocked[account]; }'))
  assert.ok(tokenSource.includes('data.ownerLockNonce != _lockNonce[tokenOwner]'))
  assert.ok(tokenSource.includes('data.spenderLockNonce != _lockNonce[spender]'))
  assert.ok(tokenSource.includes('function redeemForOwner'))
  assert.ok(vaultSource.includes('msg.sender == authorizedToken'))
  assert.ok(!/function\s+(withdraw|sweep|rescue)\s*\(/i.test(vaultSource))
})
