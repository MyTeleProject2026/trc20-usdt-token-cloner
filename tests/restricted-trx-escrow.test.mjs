import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import solc from 'solc'

test('RestrictedTRXEscrow compiles and exposes provider funding plus beneficiary-only timed claim', async () => {
  const source = await readFile(new URL('../contracts/RestrictedTRXEscrow.sol', import.meta.url), 'utf8')
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'RestrictedTRXEscrow.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })))
  const errors = (output.errors || []).filter((entry) => entry.severity === 'error')
  assert.deepEqual(errors, [], errors.map((entry) => entry.formattedMessage).join('\n'))
  const artifact = output.contracts?.['RestrictedTRXEscrow.sol']?.RestrictedTRXEscrow
  assert.ok(artifact?.evm?.bytecode?.object)
  const names = artifact.abi.filter((entry) => entry.type === 'function').map((entry) => entry.name)
  assert.ok(names.includes('fundPosition'))
  assert.ok(names.includes('claim'))
  assert.ok(names.includes('restrictedBeneficiary'))
  assert.ok(names.includes('getPosition'))
  assert.ok(names.includes('getBeneficiaryPositionCount'))
  assert.ok(names.includes('getBeneficiaryPositionRequestId'))
  assert.ok(names.includes('totalLockedSun'))
  assert.ok(names.includes('maxPositionSun'))
  assert.ok(names.includes('maxDailyPrincipalSun'))
  assert.ok(names.includes('dailyPrincipalSun'))
  assert.ok(names.includes('setDepositsPaused'))
  assert.equal(names.includes('adminWithdraw'), false)
  assert.equal(names.includes('setFundingLimits'), false)
  assert.equal(names.includes('rescueFunds'), false)
})

test('escrow rejects direct transfers, enforces deployment-time funding caps, and has no admin withdrawal', async () => {
  const source = await readFile(new URL('../contracts/RestrictedTRXEscrow.sol', import.meta.url), 'utf8')
  assert.match(source, /receive\(\) external payable\s*\{\s*revert InvalidRequest\(\);/)
  assert.match(source, /if \(msg\.sender != provider\) revert Unauthorized\(\);/)
  assert.match(source, /beneficiary != restrictedBeneficiary/)
  assert.match(source, /if \(msg\.value > maxPositionSun\) revert PositionLimitExceeded\(\);/)
  assert.match(source, /uint256\(dailyPrincipalSun\) \+ msg\.value > maxDailyPrincipalSun/)
  assert.match(source, /maxDailyPrincipalSun = maxDailyPrincipalSun_;/)
  assert.match(source, /if \(msg\.sender != position\.beneficiary\) revert NotBeneficiary\(\);/)
  assert.match(source, /if \(block\.timestamp < position\.unlockAt\) revert StillLocked\(\);/)
  assert.doesNotMatch(source, /function\s+(adminWithdraw|rescueFunds|seize)\s*\(/)
})
