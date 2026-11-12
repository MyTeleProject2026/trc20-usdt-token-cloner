import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import solc from 'solc'

test('1TRAX and its separate reserve vault compile with restricted owner-controlled rules', async () => {
  const tokenSource = await fs.readFile(new URL('../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')
  const vaultSource = await fs.readFile(new URL('../contracts/OneTraxReserveVault.sol', import.meta.url), 'utf8')
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'Restricted1TRAX.sol': { content: tokenSource }, 'OneTraxReserveVault.sol': { content: vaultSource } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })))
  const errors = (output.errors || []).filter((entry) => entry.severity === 'error')
  assert.deepEqual(errors, [])
  const token = output.contracts?.['Restricted1TRAX.sol']?.Restricted1TRAX
  const vault = output.contracts?.['OneTraxReserveVault.sol']?.OneTraxReserveVault
  assert.ok(token?.evm?.bytecode?.object?.length > 0)
  assert.ok(vault?.evm?.bytecode?.object?.length > 0)
  const tokenFns = token.abi.filter((item) => item.type === 'function').map((item) => item.name)
  const vaultFns = vault.abi.filter((item) => item.type === 'function').map((item) => item.name)
  for (const name of ['name','symbol','decimals','totalSupply','balanceOf','allowance','transfer','approve','transferFrom','mint','redeemForOwner','setPaused','setMintingEnabled','setReserveVault']) assert.ok(tokenFns.includes(name))
  for (const name of ['reserveBalance','setAuthorizedToken','releaseForRedemption']) assert.ok(vaultFns.includes(name))
  assert.match(tokenSource, /mintingEnabled = false/)
  assert.match(tokenSource, /paused = true/)
  assert.ok(tokenSource.includes('revert("1TRAX-non-transferable")'))
  assert.ok(tokenSource.includes('reserveBalance() >= _totalSupply + amount'))
  assert.ok(tokenSource.includes('external onlyOwner nonReentrant'))
  assert.ok(vaultSource.includes('msg.sender == authorizedToken'))
  assert.ok(vaultSource.includes('No owner withdrawal path') || vaultSource.includes('No owner withdrawal'))
})
