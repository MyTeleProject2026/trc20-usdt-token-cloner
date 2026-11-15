import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { estimateMainnetDeploymentEnergy, formatTronLinkError } from '../src/trax-mainnet.mjs'

const generated = await fs.readFile(new URL('../src/generated/trax-contract-artifacts.js', import.meta.url), 'utf8')
const artifact = JSON.parse(generated.slice('export default '.length).trim().replace(/;$/, ''))
const tokenSource = await fs.readFile(new URL('../../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')

test('TronBox generated artifact exposes owner-issued TRӾ functions', () => {
  assert.equal(artifact.compiler, 'TRON solc 0.8.25')
  assert.equal(artifact.optimizer.enabled, true)
  assert.equal(artifact.optimizer.runs, 200)
  assert.ok(artifact.token.bytecode.length > 0)
  const functions = artifact.token.abi.filter(item => item.type === 'function').map(item => item.name)
  for (const name of ['name','symbol','decimals','totalSupply','balanceOf','allowance','transfer','approve','transferFrom','owner','pendingOwner','transferOwnership','acceptOwnership','setPaused','setMintingEnabled','mint','credit','batchCredit']) {
    assert.ok(functions.includes(name), 'Missing TRӾ ABI function: ' + name)
  }
  for (const name of ['reserveVault','redeemForOwner','isLocked','setRecipientLocked']) {
    assert.ok(!functions.includes(name), 'Legacy reserve/lock ABI must be absent: ' + name)
  }
})

test('TRӾ metadata, unbacked economics, and owner authorization are explicit', () => {
  assert.ok(tokenSource.includes('pragma solidity ^0.8.25;'))
  assert.ok(tokenSource.includes('string public constant name = unicode"TRӾ";'))
  assert.ok(tokenSource.includes('string public constant symbol = "TRX";'))
  assert.ok(tokenSource.includes('uint8 public constant decimals = 6;'))
  assert.ok(tokenSource.includes('bool public paused = true;'))
  assert.ok(tokenSource.includes('function mint(address recipient, uint256 amount) external onlyOwner whenNotPaused'))
  assert.ok(tokenSource.includes('function credit(address recipient, uint256 amount, bytes32 referenceId)'))
  assert.ok(tokenSource.includes('external onlyOwner whenNotPaused'))
  assert.ok(tokenSource.includes('MAX_BATCH_CREDITS = 50'))
  assert.ok(!/reserveVault|redeemForOwner|releaseForRedemption|insufficient-trx-reserve/.test(tokenSource))
})

test('external credits emit standard Transfer and a nonzero-reference audit event', () => {
  assert.ok(tokenSource.includes('event Transfer(address indexed from, address indexed to, uint256 value)'))
  assert.ok(tokenSource.includes('event OwnerCredit(address indexed recipient, uint256 amount, bytes32 indexed referenceId)'))
  assert.ok(tokenSource.includes('require(referenceId != bytes32(0), "reference-required")'))
  assert.ok(tokenSource.includes('emit OwnerCredit(recipient, amount, referenceId)'))
})

test('deployment Energy estimation never misuses triggerconstantcontract for init bytecode', async () => {
  const helper = await fs.readFile(new URL('../src/trax-mainnet.mjs', import.meta.url), 'utf8')
  const start = helper.indexOf('export async function estimateMainnetDeploymentEnergy')
  const end = helper.indexOf('export async function waitForSolidifiedReceipt', start)
  const estimator = helper.slice(start, end)
  assert.ok(estimator.includes('transactionBuilder.deployConstantContract'))
  assert.ok(estimator.includes("input: '0x' + bytecode"))
  assert.ok(!estimator.includes("'/wallet/estimateenergy'"))
  assert.ok(!estimator.includes("'/wallet/triggerconstantcontract'"))
  assert.ok(estimator.includes('No wallet signature or broadcast was attempted.'))
})


test('deployment Energy estimator calls TronWeb deployConstantContract with the exact init bytecode and owner', async () => {
  const calls = []
  const tronWeb = {
    isAddress: (address) => address === 'TMainnetOwnerAddress',
    transactionBuilder: {
      deployConstantContract: async (options) => {
        calls.push(options)
        return { result: { result: true }, energy_required: 123456 }
      },
    },
  }
  const result = await estimateMainnetDeploymentEnergy(tronWeb, 'TMainnetOwnerAddress', {
    bytecode: '6001600055',
  })
  assert.deepEqual(calls, [{
    ownerAddress: 'TMainnetOwnerAddress',
    input: '0x6001600055',
    confirmed: false,
  }])
  assert.equal(result.energyUsed, '123456')
})


test('TronLink structured provider errors are rendered as useful diagnostics, not [object Object]', () => {
  const error = new Error('provider request failed')
  Object.assign(error, { code: 3038, slug: 'promo_not_eligible', message: 'This address did not receive the promo token from us', field: null, retryable: false })
  const rendered = formatTronLinkError(error, 'Energy claim')
  assert.match(rendered, /3038/)
  assert.match(rendered, /promo_not_eligible/)
  assert.match(rendered, /did not receive the promo token/)
  assert.doesNotMatch(rendered, /\\[object Object\\]/)
})

test('TronLink nested HTTP errors preserve provider response details', () => {
  const error = new Error('Request failed with status code 429')
  error.response = { status: 429, data: { Error: 'request rate exceeded', code: 429 } }
  const rendered = formatTronLinkError(error, 'Deployment preflight')
  assert.match(rendered, /request rate exceeded/)
  assert.match(rendered, /429/)
})
