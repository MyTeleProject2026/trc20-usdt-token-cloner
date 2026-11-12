import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import solc from 'solc'
test('Restricted1TRAX compiles with owner-only mint/burn and disabled holder transfers', async () => {
  const source = await fs.readFile(new URL('../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Restricted1TRAX.sol': { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })))
  const errors = (output.errors || []).filter((entry) => entry.severity === 'error')
  assert.deepEqual(errors, [])
  const artifact = output.contracts?.['Restricted1TRAX.sol']?.Restricted1TRAX
  assert.ok(artifact?.evm?.bytecode?.object?.length > 0)
  const names = artifact.abi.filter((item) => item.type === 'function').map((item) => item.name)
  for (const name of ['name','symbol','decimals','totalSupply','balanceOf','allowance','transfer','approve','transferFrom','mint','burnForOwnerRedemption','setPaused','setMintingEnabled']) assert.ok(names.includes(name))
  assert.match(source, /mintingEnabled = false/)
  assert.match(source, /paused = true/)
  assert.ok(source.includes('revert("1TRAX-non-transferable")'))
  assert.ok(source.includes('external onlyOwner'))
})
