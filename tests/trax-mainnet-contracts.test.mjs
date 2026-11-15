import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import solc from 'solc'

test('owner-issued TRӾ compiles for the TRON Paris-compatible target', async () => {
  const tokenSource = await fs.readFile(new URL('../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')
  const frontendPackage = JSON.parse(await fs.readFile(new URL('../Frontend-Tron-Transfer/package.json', import.meta.url), 'utf8'))
  const compileScript = await fs.readFile(new URL('../Frontend-Tron-Transfer/scripts/compile-trax-contracts.mjs', import.meta.url), 'utf8')
  assert.equal(frontendPackage.dependencies.solc, '0.8.25')
  assert.equal(frontendPackage.overrides.tmp, '0.2.7')
  assert.ok(compileScript.includes("compilerVersion !== '0.8.25'"))
  assert.ok(compileScript.includes("evmVersion: 'paris'"))
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'Restricted1TRAX.sol': { content: tokenSource } },
    settings: {
      evmVersion: 'paris',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  })))
  const errors = (output.errors || []).filter(entry => entry.severity === 'error')
  assert.deepEqual(errors, [])
  const token = output.contracts?.['Restricted1TRAX.sol']?.Restricted1TRAX
  assert.ok(token?.evm?.bytecode?.object?.length > 0)
  const functions = token.abi.filter(entry => entry.type === 'function').map(entry => entry.name)
  for (const name of ['name','symbol','decimals','owner','pendingOwner','transferOwnership','acceptOwnership','totalSupply','balanceOf','allowance','setPaused','setMintingEnabled','mint','credit','batchCredit','transfer','approve','transferFrom']) {
    assert.ok(functions.includes(name), 'missing TRӾ function: ' + name)
  }
  for (const name of ['isLocked','setRecipientLocked','setReserveVault','redeemForOwner']) {
    assert.ok(!functions.includes(name), 'legacy reserve/lock function must not exist: ' + name)
  }
  assert.ok(tokenSource.includes('name = unicode"TRӾ"'))
  assert.ok(tokenSource.includes('symbol = "TRAX"'))
  assert.ok(tokenSource.includes('decimals = 6'))
  assert.ok(tokenSource.includes('MAX_BATCH_CREDITS = 50'))
  assert.ok(tokenSource.includes('require(_totalSupply <= type(uint256).max - amount'))
  assert.ok(!/reserveVault|redeemForOwner|releaseForRedemption|insufficient-trx-reserve/.test(tokenSource))
})

test('owner issuance starts disabled and the token starts paused', async () => {
  const source = await fs.readFile(new URL('../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')
  assert.match(source, /bool public paused = true;/)
  assert.match(source, /bool public mintingEnabled;/)
  assert.match(source, /function setMintingEnabled\(bool value\) external onlyOwner/)
  assert.match(source, /function setPaused\(bool value\) external onlyOwner/)
})

test('external credit emits standard mint Transfer and OwnerCredit audit event', async () => {
  const source = await fs.readFile(new URL('../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')
  assert.match(source, /event Transfer\(address indexed from, address indexed to, uint256 value\)/)
  assert.match(source, /event OwnerCredit\(address indexed recipient, uint256 amount, bytes32 indexed referenceId\)/)
  assert.match(source, /emit Transfer\(address\(0\), recipient, amount\)/)
  assert.match(source, /emit OwnerCredit\(recipient, amount, referenceId\)/)
})
