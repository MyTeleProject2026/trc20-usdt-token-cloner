import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateDeploymentResourceBudget } from '../src/trax-mainnet.mjs'
import fs from 'node:fs/promises'

const generated = await fs.readFile(new URL('../src/generated/trax-contract-artifacts.js', import.meta.url), 'utf8')
const artifact = JSON.parse(generated.slice('export default '.length).trim().replace(/;$/, ''))
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

const budgetSnapshot = (overrides = {}) => ({
  energyFeeSun: '100',
  bandwidthFeeSun: '1000',
  energyAvailable: '1000',
  freeBandwidthAvailable: '600',
  stakedBandwidthAvailable: '0',
  nativeBalanceSun: '100000000',
  maxFeeLimitSun: '15000000000',
  ...overrides,
})

test('deployment budget allows TRX to cover a measured Energy and Bandwidth shortfall', () => {
  const budget = calculateDeploymentResourceBudget({
    energyRequired: '1000',
    resourceSnapshot: budgetSnapshot({ energyAvailable: '0' }),
    rawDataHex: 'ab'.repeat(1000),
    feeLimitSun: '120000',
  })
  assert.equal(budget.energyShortfall, '1200')
  assert.equal(budget.bandwidthShortfall, '1134')
  assert.equal(budget.requiredTrxSun, String(1200 * 100 + 1134 * 1000))
})

test('deployment budget refuses TRX fallback when the wallet balance is below the estimate', () => {
  assert.throws(() => calculateDeploymentResourceBudget({
    energyRequired: '1000',
    resourceSnapshot: budgetSnapshot({ energyAvailable: '0', nativeBalanceSun: '1000' }),
    rawDataHex: 'ab'.repeat(1000),
    feeLimitSun: '120000',
  }), /Insufficient TRX for the estimated Mainnet resource shortfall/)
})

test('deployment budget still succeeds without burning TRX when resources fully cover the transaction', () => {
  const budget = calculateDeploymentResourceBudget({
    energyRequired: '1000',
    resourceSnapshot: budgetSnapshot({
      energyAvailable: '1200',
      freeBandwidthAvailable: '5000',
      nativeBalanceSun: '0',
    }),
    rawDataHex: 'ab'.repeat(1000),
    feeLimitSun: '120000',
  })
  assert.equal(budget.requiredTrxSun, '0')
})
