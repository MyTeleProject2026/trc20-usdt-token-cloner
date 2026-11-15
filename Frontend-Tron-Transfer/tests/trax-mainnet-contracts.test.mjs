import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const generated = await fs.readFile(new URL('../src/generated/trax-contract-artifacts.js', import.meta.url), 'utf8')
const artifact = JSON.parse(generated.slice('export default '.length).trim().replace(/;$/, ''))
const tokenSource = await fs.readFile(new URL('../../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')

test('production build compiles exactly the owner-issued TRӾ token artifact', () => {
  assert.equal(artifact.compiler, 'TRON solc 0.8.25')
  assert.equal(artifact.token.contractName, 'Restricted1TRAX')
  assert.ok(Array.isArray(artifact.token.abi))
  assert.match(artifact.token.bytecode, /^(?:[0-9a-f]{2})+$/i)
  assert.match(artifact.token.deployedBytecode, /^(?:[0-9a-f]{2})+$/i)
  assert.equal('vault' in artifact, false)
})

test('legacy reserve vault is not part of the active TRӾ deployment artifact', () => {
  assert.match(tokenSource, /contract Restricted1TRAX/)
  assert.doesNotMatch(tokenSource, /reserveVault|redeemForOwner|releaseForRedemption|insufficient-trx-reserve/)
  assert.match(tokenSource, /function credit\(address recipient, uint256 amount, bytes32 referenceId\)/)
  assert.match(tokenSource, /MAX_BATCH_CREDITS = 50/)
})
