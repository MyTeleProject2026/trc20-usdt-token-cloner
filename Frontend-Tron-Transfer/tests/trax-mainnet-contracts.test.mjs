import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { assertZeroTrxBurnBudget, calculateDeploymentResourceBudget, buildDeploymentOptions, createMainnetDeploymentTransaction, estimateMainnetDeploymentEnergy, formatTronLinkError, isMainnetEnergyEstimateUnavailable, claimTenergyPromoForDeployment, predictMainnetContractAddress } from '../src/trax-mainnet.mjs'

const generated = await fs.readFile(new URL('../src/generated/trax-contract-artifacts.js', import.meta.url), 'utf8')
const artifact = JSON.parse(generated.slice('export default '.length).trim().replace(/;$/, ''))
const tokenSource = await fs.readFile(new URL('../../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')
const compileScript = await fs.readFile(new URL('../scripts/compile-trax-contracts.mjs', import.meta.url), 'utf8')

test('Pinned Solidity compiler artifact exposes owner-issued TRӾ functions', () => {
  assert.equal(artifact.compiler, 'TRON solc 0.8.25')
  assert.equal(artifact.optimizer.enabled, true)
  assert.equal(artifact.optimizer.runs, 1)
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
  assert.ok(helper.includes("String(symbol) !== 'TRӾ'"))
  assert.ok(helper.includes('Number(decimals) !== 6'))
})

test('TRӾ metadata, unbacked economics, and owner authorization are explicit', () => {
  assert.ok(tokenSource.includes('pragma solidity ^0.8.25;'))
  assert.ok(tokenSource.includes('string public constant name = unicode"TRӾ";'))
  assert.ok(tokenSource.includes('string public constant symbol = unicode"TRӾ";'))
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

test('deployment Energy estimation prefers estimateenergy and supports the documented triggerconstantcontract fallback', async () => {
  const helper = await fs.readFile(new URL('../src/trax-mainnet.mjs', import.meta.url), 'utf8')
  const start = helper.indexOf('export async function estimateMainnetDeploymentEnergy')
  const end = helper.indexOf('export function isMainnetEnergyEstimateUnavailable', start)
  const estimator = helper.slice(start, end)
  assert.ok(estimator.includes("'/wallet/estimateenergy'"))
  assert.ok(estimator.includes("'/wallet/triggerconstantcontract'"))
  assert.ok(estimator.includes('data: bytecode'))
  assert.ok(estimator.includes('owner_address: tronWeb.address.toHex(ownerAddress)'))
})

test('hex-encoded unsupported estimateenergy node error is recognized', () => {
  const hex = Buffer.from('this node does not support estimate energy', 'utf8').toString('hex')
  assert.equal(isMainnetEnergyEstimateUnavailable(new Error('TRON Mainnet deployment Energy estimation failed: ' + hex)), true)
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
      visible: false,
    })
    assert.equal(result.energyUsed, '123456')
    assert.equal(result.energyPenalty, '2345')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('unsupported estimateenergy falls back to read-only triggerconstantcontract deployment simulation', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    if (url.endsWith('/wallet/estimateenergy')) {
      return { ok: false, status: 404, text: async () => 'this node does not support estimate energy' }
    }
    return { ok: true, json: async () => ({ result: { result: true }, energy_used: 765432 }) }
  }
  try {
    const tronWeb = {
      isAddress: address => address === 'TMainnetOwnerAddress',
      address: { toHex: address => address === 'TMainnetOwnerAddress' ? '41' + '11'.repeat(20) : '' },
    }
    const result = await estimateMainnetDeploymentEnergy(tronWeb, 'TMainnetOwnerAddress', { bytecode: '0x6001600055' })
    assert.equal(calls.length, 2)
    assert.match(calls[0].url, /\/wallet\/estimateenergy$/)
    assert.match(calls[1].url, /\/wallet\/triggerconstantcontract$/)
    assert.deepEqual(calls[1].body, {
      owner_address: '41' + '11'.repeat(20),
      data: '6001600055',
      call_value: 0,
      visible: false,
    })
    assert.equal(result.energyUsed, '765432')
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
  const transaction = {
    visible: false,
    txID: 'a'.repeat(64),
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
    return { ok: true, json: async () => ({ result: { result: true }, transaction }) }
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

test('deployment resource budget requires zero Energy and Bandwidth burn for the zero-cost path', () => {
  const resourceSnapshot = {
    energyFeeSun: '100',
    bandwidthFeeSun: '1000',
    energyAvailable: '1000',
    freeBandwidthAvailable: '1000',
    stakedBandwidthAvailable: '0',
        maxFeeLimitSun: '15000000000',
  }
  const budget = calculateDeploymentResourceBudget({
    energyRequired: '100',
    resourceSnapshot,
    rawDataHex: 'ab'.repeat(100),
    feeLimitSun: '12500',
  })
  assert.equal(budget.requiredTrxSun, '0')
  assert.equal(budget.energyBurnSun, '0')
  assert.equal(budget.bandwidthBurnSun, '0')
  assert.equal(assertZeroTrxBurnBudget(budget), true)

  assert.throws(() => calculateDeploymentResourceBudget({
    energyRequired: '100',
    resourceSnapshot: { ...resourceSnapshot, energyAvailable: '0' },
    rawDataHex: 'ab'.repeat(100),
    feeLimitSun: '12500',
  }), /ZERO-TRX-BURN PROTECTION BLOCKED DEPLOYMENT.*0\.012500 TRX.*No wallet prompt/)
})

test('zero-cost deployment guard blocks any estimated Energy or Bandwidth TRX burn before signing', () => {
  assert.equal(assertZeroTrxBurnBudget({ requiredTrxSun: '0', energyBurnSun: '0', bandwidthBurnSun: '0' }), true)
  assert.throws(() => assertZeroTrxBurnBudget({
    requiredTrxSun: '7080000', energyBurnSun: '0', bandwidthBurnSun: '7080000',
  }), /Zero-TRX deployment preflight blocked.*7\.080000 TRX.*Bandwidth.*No wallet prompt/)
  assert.throws(() => assertZeroTrxBurnBudget({
    requiredTrxSun: '10000000', energyBurnSun: '9000000', bandwidthBurnSun: '1000000',
  }), /Zero-TRX deployment preflight blocked.*10\.000000 TRX.*Energy.*Bandwidth/)
})

test('zero-TRX protection explains an unaffordable resource shortfall before wallet signing', () => {
  const resourceSnapshot = {
    energyFeeSun: '100',
    bandwidthFeeSun: '1000',
    energyAvailable: '0',
    freeBandwidthAvailable: '0',
    stakedBandwidthAvailable: '0',
        maxFeeLimitSun: '15000000000',
  }
  assert.throws(() => calculateDeploymentResourceBudget({
    energyRequired: '100',
    resourceSnapshot,
    rawDataHex: 'ab'.repeat(100),
    feeLimitSun: '12500',
  }), /ZERO-TRX-BURN PROTECTION BLOCKED DEPLOYMENT.*0\.246500 TRX.*No wallet prompt, signature, or broadcast was attempted/)
})

test('predicted TRON contract address matches TronWeb genContractAddress algorithm', () => {
  const ownerHex = '41' + '11'.repeat(20)
  const txID = '22'.repeat(32)
  const inputs = []
  const predictedHex = '41' + 'ab'.repeat(20)
  const tronWeb = {
    isAddress: address => address === 'TMainnetOwnerAddress' || address === 'TPredictedContractAddress',
    address: {
      toHex: address => address === 'TMainnetOwnerAddress' ? ownerHex : '',
      fromHex: hex => hex === predictedHex ? 'TPredictedContractAddress' : '',
    },
    utils: {
      code: { hexStr2byteArray: value => { inputs.push(value); return Array.from(Buffer.from(value, 'hex')) } },
      ethersUtils: { keccak256: bytes => '0x' + 'ab'.repeat(32) },
    },
  }
  assert.equal(predictMainnetContractAddress(tronWeb, 'TMainnetOwnerAddress', txID), 'TPredictedContractAddress')
  assert.deepEqual(inputs, [txID + ownerHex])
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


const PROMO_OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const PROMO_OWNER_HEX = '41' + '11'.repeat(20)

function promoWallet(signMessageV2 = async () => 'ab'.repeat(65)) {
  return {
    address: PROMO_OWNER,
    tronWeb: {
      fullNode: { host: 'https://api.trongrid.io' },
      isAddress: address => address === PROMO_OWNER,
      address: { toHex: address => address === PROMO_OWNER ? PROMO_OWNER_HEX : '' },
      trx: { signMessageV2 },
    },
  }
}

function promoFetchResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

test('eligible TEnergy promo is claimed with an off-chain wallet message and verified by Mainnet delegation reads', async () => {
  const calls = []
  let statusReads = 0
  let resourceReads = 0
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
    if (url.includes('/api/tron/resources/free-delegation/status')) {
      return promoFetchResponse({
        success: true,
        inboundDelegations: {
          records: [{ energyStakeSun: '5000000', energyExpireTime: 0 }],
        },
      })
    }
    if (url.includes('/api/tron/tenergy/promo/status')) {
      statusReads += 1
      return promoFetchResponse({
        success: true,
        promo: { state: 'active', grant: { resource: 'energy', amount: 65000 } },
        redemption: statusReads === 1 ? null : {
          status: 'delegated', energy: 65000, expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      })
    }
    if (url.endsWith('/api/tron/tenergy/promo/challenge')) {
      return promoFetchResponse({
        success: true, address: PROMO_OWNER, nonce: 'nonce-12345678',
        message: 'Sign this exact TEnergy promo challenge.',
      })
    }
    if (url.endsWith('/api/tron/tenergy/promo/redeem')) {
      return promoFetchResponse({
        success: true, redemption: { status: 'granting', energy: 65000 },
      })
    }
    throw new Error('unexpected promo request: ' + url)
  }
  const result = await claimTenergyPromoForDeployment(promoWallet(), PROMO_OWNER, {
    fetchImpl,
    pollAttempts: 3,
    pollIntervalMs: 0,
    readResources: async () => {
      resourceReads += 1
      return resourceReads === 1
        ? { energyLimit: '100', energyAvailable: '100' }
        : { energyLimit: '65100', energyAvailable: '65100' }
    },
  })
  assert.equal(result.status, 'delegated-and-chain-verified')
  assert.equal(result.energyVerified, true)
  assert.equal(result.bandwidthCovered, false)
  const redeem = calls.find(call => call.url.endsWith('/api/tron/tenergy/promo/redeem'))
  assert.deepEqual(redeem.body, { address: PROMO_OWNER, nonce: 'nonce-12345678', signature: 'ab'.repeat(65) })
  assert.ok(statusReads >= 2)
})

test('actual TEnergy 3038 promo_not_eligible response is normalized and never prompts or retries', async () => {
  let signatureCalls = 0
  let providerCalls = 0
  const fetchImpl = async (url) => {
    providerCalls += 1
    if (url.includes('/api/tron/tenergy/promo/status')) {
      return promoFetchResponse({ success: true, promo: { state: 'active', grant: { resource: 'energy', amount: 65000 } }, redemption: null })
    }
    if (url.endsWith('/api/tron/tenergy/promo/challenge')) {
      return promoFetchResponse({
        success: false,
        provider: 'TEnergy',
        network: 'mainnet',
        error: 3038,
        message: 'This address did not receive the promo token from us',
        retryable: false,
      }, 403)
    }
    throw new Error('No resource query, signature, or redemption should follow a permanent provider rejection')
  }
  const wallet = promoWallet(async () => { signatureCalls += 1; return 'ab'.repeat(65) })
  const readResources = async () => ({ energyLimit: '0', energyAvailable: '0' })
  const first = await claimTenergyPromoForDeployment(wallet, PROMO_OWNER, { fetchImpl, readResources })
  assert.equal(first.status, 'promo-not-eligible')
  assert.equal(first.providerCode, '3038')
  assert.equal(first.retryable, false)
  assert.match(first.message, /not included in the one-time promotional distribution/)
  assert.equal(signatureCalls, 0)
  assert.equal(providerCalls, 2)

  const second = await claimTenergyPromoForDeployment(wallet, PROMO_OWNER, {
    fetchImpl,
    readResources: async () => { throw new Error('Permanent ineligibility cache should return before Mainnet reads') },
  })
  assert.equal(second.status, 'promo-not-eligible')
  assert.equal(second.providerCode, '3038')
  assert.equal(second.retryable, false)
  assert.equal(signatureCalls, 0)
  assert.equal(providerCalls, 2)
})

test('declining the off-chain promo message does not submit a claim or a TRON transaction', async () => {
  let redeemCalls = 0
  const fetchImpl = async (url) => {
    if (url.includes('/api/tron/resources/free-delegation/status')) return promoFetchResponse({ success: true, inboundDelegations: { records: [] } })
    if (url.includes('/api/tron/tenergy/promo/status')) return promoFetchResponse({
      success: true, promo: { state: 'active', grant: { resource: 'energy', amount: 65000 } }, redemption: null,
    })
    if (url.endsWith('/api/tron/tenergy/promo/challenge')) return promoFetchResponse({
      success: true, nonce: 'nonce-12345678', address: PROMO_OWNER, message: 'Exact challenge',
    })
    if (url.endsWith('/api/tron/tenergy/promo/redeem')) { redeemCalls += 1; return promoFetchResponse({}) }
    throw new Error('unexpected request')
  }
  const wallet = promoWallet(async () => { throw Object.assign(new Error('User rejected the request'), { code: 4001 }) })
  const result = await claimTenergyPromoForDeployment(wallet, PROMO_OWNER, {
    fetchImpl,
    readResources: async () => ({ energyLimit: '0', energyAvailable: '0' }),
  })
  assert.equal(result.status, 'claim-signature-declined')
  assert.equal(redeemCalls, 0)
})


test('a previously accepted but pending promo claim resumes polling without requesting a second signature', async () => {
  let statusReads = 0
  let signatureCalls = 0
  let resourceReads = 0
  const fetchImpl = async (url) => {
    if (url.includes('/api/tron/resources/free-delegation/status')) {
      return promoFetchResponse({ success: true, inboundDelegations: { records: [{ energyStakeSun: '5000000', energyExpireTime: 0 }] } })
    }
    if (url.includes('/api/tron/tenergy/promo/status')) {
      statusReads += 1
      return promoFetchResponse({
        success: true,
        promo: { state: 'active', grant: { resource: 'energy', amount: 65000 } },
        redemption: { status: statusReads === 1 ? 'granting' : 'delegated', energy: 65000 },
      })
    }
    throw new Error('a pending claim must not request another challenge or redeem operation')
  }
  const wallet = promoWallet(async () => { signatureCalls += 1; return 'ab'.repeat(65) })
  const result = await claimTenergyPromoForDeployment(wallet, PROMO_OWNER, {
    fetchImpl,
    pollAttempts: 2,
    pollIntervalMs: 0,
    readResources: async () => {
      resourceReads += 1
      return resourceReads === 1
        ? { energyLimit: '100', energyAvailable: '100' }
        : { energyLimit: '65100', energyAvailable: '65100' }
    },
  })
  assert.equal(result.status, 'delegated-and-chain-verified')
  assert.equal(result.energyVerified, true)
  assert.equal(signatureCalls, 0)
  assert.ok(statusReads >= 2)
})
