import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { buildDeploymentOptions, createMainnetDeploymentTransaction, estimateMainnetDeploymentEnergy, formatTronLinkError, isMainnetEnergyEstimateUnavailable } from '../src/trax-mainnet.mjs'

const generated = await fs.readFile(new URL('../src/generated/trax-contract-artifacts.js', import.meta.url), 'utf8')
const artifact = JSON.parse(generated.slice('export default '.length).trim().replace(/;$/, ''))
const tokenSource = await fs.readFile(new URL('../../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')
const compileScript = await fs.readFile(new URL('../scripts/compile-trax-contracts.mjs', import.meta.url), 'utf8')

test('Pinned Solidity compiler artifact exposes owner-issued TRӾ functions', () => {
  assert.equal(artifact.compiler, 'TRON solc 0.8.25')
  assert.equal(artifact.optimizer.enabled, true)
  assert.equal(artifact.optimizer.runs, 200)
  assert.equal(artifact.evmVersion, 'paris')
  assert.equal(artifact.token.contractName, 'Restricted1TRAX')
  assert.ok(artifact.token.bytecode.length > 0)
  assert.ok(artifact.token.deployedBytecode.length > 0)
  assert.equal(artifact.token.deployedBytecode.length % 2, 0)
  const functions = artifact.token.abi.filter(item => item.type === 'function').map(item => item.name)
  for (const name of ['name','symbol','decimals','totalSupply','balanceOf','allowance','transfer','approve','transferFrom','owner','pendingOwner','transferOwnership','acceptOwnership','setPaused','setMintingEnabled','mint','credit','batchCredit']) {
    assert.ok(functions.includes(name), 'Missing TRӾ ABI function: ' + name)
  }
  for (const name of ['reserveVault','redeemForOwner','isLocked','setRecipientLocked']) {
    assert.ok(!functions.includes(name), 'Legacy reserve/lock ABI must be absent: ' + name)
  }
})

test('CreateSmartContract receives ABI JSON text in TronWeb builder options', () => {
  const options = buildDeploymentOptions({
    abi: [{ type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }] }],
    bytecode: '0x6001600055',
  }, 'Restricted1TRAX', 150000000)
  assert.equal(typeof options.abi, 'string')
  assert.deepEqual(JSON.parse(options.abi), [{ type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }] }])
  assert.equal(options.bytecode, '6001600055')
})

test('TRӾ artifacts are compiled directly with the pinned compiler, not TronBox', () => {
  assert.ok(compileScript.includes("import solc from 'solc'"))
  assert.ok(compileScript.includes("compilerVersion !== '0.8.25'"))
  assert.ok(compileScript.includes("evmVersion: 'paris'"))
  assert.doesNotMatch(compileScript.toLowerCase(), /tronbox/)
})

test('the dashboard verifies exact runtime bytecode before owner-issued credits', async () => {
  const helper = await fs.readFile(new URL('../src/trax-mainnet.mjs', import.meta.url), 'utf8')
  assert.ok(helper.includes("postNode(tronWeb, '/wallet/getcontractinfo'"))
  assert.ok(helper.includes('info?.runtimecode'))
  assert.ok(helper.includes('client.trx.getContractInfo(address)'))
  assert.ok(helper.includes('deployed.runtimecode'))
  assert.ok(helper.includes('deployedCode !== expectedCode'))
  assert.ok(helper.includes("String(name) !== 'TRӾ'"))
  assert.ok(helper.includes("String(symbol) !== 'TRAX'"))
  assert.ok(helper.includes('Number(decimals) !== 6'))
})

test('TRӾ metadata, unbacked economics, and owner authorization are explicit', () => {
  assert.ok(tokenSource.includes('pragma solidity ^0.8.25;'))
  assert.ok(tokenSource.includes('string public constant name = unicode"TRӾ";'))
  assert.ok(tokenSource.includes('string public constant symbol = "TRAX";'))
  const transferBody = tokenSource.slice(tokenSource.indexOf('function _transfer('))
  assert.ok(transferBody.includes('emit Transfer(from, to, amount);'))
  assert.doesNotMatch(transferBody, /amount > 0/, 'standard ERC-20 zero-value transfers must be allowed')
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
  assert.ok(tokenSource.includes('require(referenceId != bytes32(0), "referenceId-required")'))
  assert.ok(tokenSource.includes('mapping(bytes32 => bool) public creditReferenceUsed;'))
  assert.ok(tokenSource.includes('require(!creditReferenceUsed[referenceId], "reference-already-used")'))
  assert.ok(tokenSource.includes('emit OwnerCredit(recipient, amount, referenceId)'))
})

test('deployment Energy estimation uses the dedicated estimateenergy deployment endpoint', async () => {
  const helper = await fs.readFile(new URL('../src/trax-mainnet.mjs', import.meta.url), 'utf8')
  const start = helper.indexOf('export async function estimateMainnetDeploymentEnergy')
  const end = helper.indexOf('export function isMainnetEnergyEstimateUnavailable', start)
  const estimator = helper.slice(start, end)
  assert.ok(estimator.includes("'/wallet/estimateenergy'"))
  assert.ok(estimator.includes('data: bytecode'))
  assert.ok(estimator.includes('owner_address: tronWeb.address.toHex(ownerAddress)'))
  assert.ok(!estimator.includes("'/wallet/triggerconstantcontract'"))
})

test('deployment Energy estimator sends exact init bytecode to estimateenergy', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return {
      ok: true,
      json: async () => ({ result: { result: true }, energy_required: 123456, energy_penalty: 2345 }),
    }
  }
  try {
    const tronWeb = {
      isAddress: address => address === 'TMainnetOwnerAddress',
      address: { toHex: address => address === 'TMainnetOwnerAddress' ? '41' + '11'.repeat(20) : '' },
    }
    const result = await estimateMainnetDeploymentEnergy(tronWeb, 'TMainnetOwnerAddress', {
      bytecode: '0x6001600055',
    })
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/wallet\/estimateenergy$/)
    assert.deepEqual(calls[0].body, {
      owner_address: '41' + '11'.repeat(20),
      data: '6001600055',
      call_value: 0,
    })
    assert.equal(result.energyUsed, '123456')
    assert.equal(result.energyPenalty, '2345')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an explicitly unsupported deployment Energy estimator is identified without faking a fallback estimate', () => {
  assert.equal(isMainnetEnergyEstimateUnavailable(new Error('This node does not support estimate energy')), true)
  assert.equal(isMainnetEnergyEstimateUnavailable(new Error('Network request failed')), false)
})

test('TRON deployment construction requests the canonical wallet/deploycontract transaction', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const ownerHex = '41' + '11'.repeat(20)
  const predictedHex = '41' + '22'.repeat(20)
  const transaction = {
    visible: false,
    txID: 'a'.repeat(64),
    contract_address: predictedHex,
    raw_data: {
      contract: [{
        type: 'CreateSmartContract',
        parameter: {
          type_url: 'type.googleapis.com/protocol.CreateSmartContract',
          value: {
            owner_address: ownerHex,
            new_contract: {
              bytecode: '6001600055',
              abi: { entrys: [{ type: 'Function', name: 'totalSupply' }] },
            },
          },
        },
      }],
      fee_limit: 150000000,
    },
    raw_data_hex: 'ab'.repeat(20),
  }
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return { ok: true, json: async () => transaction }
  }
  try {
    const tronWeb = {
      isAddress: address => address === 'TMainnetOwnerAddress',
      address: { toHex: address => address === 'TMainnetOwnerAddress' ? ownerHex : '' },
    }
    const result = await createMainnetDeploymentTransaction(tronWeb, {
      abi: JSON.stringify([{ type: 'function', name: 'totalSupply' }]),
      bytecode: '6001600055',
      feeLimit: 150000000,
      originEnergyLimit: 10000000,
      name: 'Restricted1TRAX',
      callValue: 0,
      userFeePercentage: 100,
    }, 'TMainnetOwnerAddress')
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/wallet\/deploycontract$/)
    assert.deepEqual(calls[0].body, {
      owner_address: ownerHex,
      abi: JSON.stringify([{ type: 'function', name: 'totalSupply' }]),
      bytecode: '6001600055',
      fee_limit: 150000000,
      origin_energy_limit: 10000000,
      name: 'Restricted1TRAX',
      call_value: 0,
      consume_user_resource_percent: 100,
      visible: false,
    })
    assert.strictEqual(result, transaction)
    assert.equal(result.raw_data.contract[0].type, 'CreateSmartContract')
  } finally {
    globalThis.fetch = originalFetch
  }
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
