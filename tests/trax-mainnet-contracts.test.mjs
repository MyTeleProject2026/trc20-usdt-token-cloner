import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const tokenSource = await fs.readFile(new URL('../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')
const frontendPackage = JSON.parse(await fs.readFile(new URL('../Frontend-Tron-Transfer/package.json', import.meta.url), 'utf8'))
const compileScript = await fs.readFile(new URL('../Frontend-Tron-Transfer/scripts/compile-trax-contracts.mjs', import.meta.url), 'utf8')

test('TRӾ pins the Solidity compiler and token metadata', () => {
  assert.ok(tokenSource.includes('pragma solidity ^0.8.25;'))
  assert.ok(tokenSource.includes('string public constant name = unicode"TRӾ";'))
  assert.ok(tokenSource.includes('string public constant symbol = "TRAX";'))
  assert.ok(tokenSource.includes('uint8 public constant decimals = 6;'))
  assert.equal(frontendPackage.dependencies.solc, '0.8.25')
  assert.ok(compileScript.includes("compilerVersion !== '0.8.25'"))
  assert.match(compileScript, /optimizer:\s*\{\s*enabled:\s*true,\s*runs:\s*200\s*\}/)
})

test('TRӾ exposes owner-only issuance, credit, pause and ownership controls', () => {
  for (const method of ['totalSupply','balanceOf','allowance','mint','credit','batchCredit','setPaused','setMintingEnabled','transferOwnership','acceptOwnership']) {
    assert.match(tokenSource, new RegExp('function\\s+' + method + '\\s*\\('))
  }
  assert.ok(tokenSource.includes('mintingEnabled = false;'))
  assert.ok(tokenSource.includes('paused = true;'))
  assert.ok(tokenSource.includes('external onlyOwner'))
  assert.ok(tokenSource.includes('MAX_BATCH_CREDITS = 50'))
  assert.ok(tokenSource.includes('require(!creditReferenceUsed[referenceId], "reference-already-used")'))
})

test('TRӾ uses an independent unbacked issuance model with no reserve or redemption dependency', () => {
  assert.doesNotMatch(tokenSource, /reserveVault|reserveBalance|redeemForOwner|releaseForRedemption|insufficient-trx-reserve/)
  assert.ok(!compileScript.includes('OneTraxReserveVault.sol'))
  assert.ok(!compileScript.includes('vaultSource'))
})
