import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import express from 'express'
import { createServer } from 'node:http'
import {
  createThirdPartyFundingRouter,
  verifyThirdPartyUsdtDepositEvidence,
  verifyThirdPartyTrxDepositEvidence,
} from '../server/routes/third-party-funding.mjs'
import {
  OFFICIAL_TRON_MAINNET_USDT,
  THIRD_PARTY_FUNDING_AUTHORIZATION_FORMAT,
} from '../src/third-party-funding-authorization.mjs'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function makeTronAddress(fill) {
  const payload = Buffer.from('41' + fill.repeat(20), 'hex')
  const checksum = createHash('sha256').update(
    createHash('sha256').update(payload).digest(),
  ).digest().subarray(0, 4)
  const bytes = Buffer.concat([payload, checksum])
  let value = BigInt('0x' + bytes.toString('hex'))
  let encoded = ''
  while (value > 0n) {
    const remainder = Number(value % 58n)
    encoded = BASE58[remainder] + encoded
    value /= 58n
  }
  return encoded
}

const OWNER = makeTronAddress('01')
const SPONSOR = makeTronAddress('02')
const VAULT = makeTronAddress('03')
const TOKEN_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c'
const SIGNATURE = '0x' + 'a'.repeat(130)
const TOKEN_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const TXID = 'a'.repeat(64)
const AMOUNT_USDT = '25000000'
const AMOUNT_TRX = '8000000'
const ORIGIN = 'https://studio.example'

function hexFor(address) {
  if (address === OWNER) return '41' + '01'.repeat(20)
  if (address === SPONSOR) return '41' + '02'.repeat(20)
  if (address === VAULT) return '41' + '03'.repeat(20)
  if (address === OFFICIAL_TRON_MAINNET_USDT) return TOKEN_HEX
  return ''
}

const tronWeb = {
  address: { toHex: hexFor },
  trx: {
    getConfirmedTransaction: async () => ({}),
    getTransactionInfo: async () => ({}),
  },
}

function confirmedUsdtEvidence(overrides = {}) {
  const from = hexFor(SPONSOR).slice(2).padStart(64, '0')
  const to = hexFor(VAULT).slice(2).padStart(64, '0')
  const amountHex = BigInt(AMOUNT_USDT).toString(16).padStart(64, '0')
  const transaction = {
    txID: TXID,
    ret: [{ contractRet: 'SUCCESS' }],
    raw_data: {
      contract: [{
        type: 'TriggerSmartContract',
        parameter: { value: {
          owner_address: hexFor(SPONSOR),
          contract_address: TOKEN_HEX,
          data: 'a9059cbb' + to + amountHex,
        } },
      }],
    },
  }
  const transactionInfo = {
    id: TXID,
    blockNumber: 123456,
    receipt: { result: 'SUCCESS' },
    log: [{
      address: TOKEN_HEX.slice(2),
      topics: [TOKEN_TOPIC, from, to],
      data: amountHex,
    }],
  }
  return {
    transaction: { ...transaction, ...overrides.transaction },
    transactionInfo: { ...transactionInfo, ...overrides.transactionInfo },
  }
}

function confirmedTrxEvidence(overrides = {}) {
  const transaction = {
    txID: TXID,
    ret: [{ contractRet: 'SUCCESS' }],
    raw_data: {
      contract: [{
        type: 'TransferContract',
        parameter: { value: {
          owner_address: hexFor(SPONSOR),
          to_address: hexFor(VAULT),
          amount: AMOUNT_TRX,
        } },
      }],
    },
  }
  const transactionInfo = {
    id: TXID,
    blockNumber: 123457,
    receipt: { result: 'SUCCESS' },
  }
  return {
    transaction: { ...transaction, ...overrides.transaction },
    transactionInfo: { ...transactionInfo, ...overrides.transactionInfo },
  }
}

const allChecks = {
  fireblocksApiAuthenticated: true,
  vaultAccountVerified: true,
  usdtAssetActivated: true,
  officialUsdtAssetVerified: true,
  usdtAddressMatches: true,
  trxAssetActivated: true,
  nativeTrxAssetVerified: true,
  trxAddressMatches: true,
  officialUsdtChainVerified: true,
  treasuryTrxChainBalanceRead: true,
  databaseReady: true,
}
function inventorySnapshot(overrides = {}) {
  return {
    id: '77',
    repository: 'MyTeleProject2026/trc20-usdt-token-cloner',
    branch: 'main',
    commitSha: 'b'.repeat(40),
    verificationStatus: 'verified',
    checkedAt: new Date().toISOString(),
    configuration: {
      network: 'mainnet',
      signerMode: 'fireblocks',
      treasuryAddress: VAULT,
      usdtContract: OFFICIAL_TRON_MAINNET_USDT,
      usdtDecimals: 6,
      trxDecimals: 6,
      vaultAccountId: '123',
      usdtAssetId: 'TRON_USDT',
      trxAssetId: 'TRX',
      apiKeyConfigured: true,
    },
    checks: { ...allChecks },
    balances: {
      fireblocksUsdtAvailableBaseUnits: '50000000',
      chainUsdtBalanceBaseUnits: '50000000',
      fireblocksTrxAvailableBaseUnits: '16000000',
      chainTrxBalanceSun: '16000000',
    },
    ...overrides,
  }
}

function manifest(overrides = {}) {
  const issuedAt = new Date(Date.now() - 30_000).toISOString()
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  return {
    format: THIRD_PARTY_FUNDING_AUTHORIZATION_FORMAT,
    authorizationId: 'funding-consent-test-001',
    network: 'mainnet',
    sponsorAddress: SPONSOR,
    vaultAddress: VAULT,
    usdtContract: OFFICIAL_TRON_MAINNET_USDT,
    maxUsdtBaseUnits: AMOUNT_USDT,
    maxTrxSun: AMOUNT_TRX,
    agreementReference: 'TEST-AGREEMENT-001',
    issuedAt,
    expiresAt,
    signature: SIGNATURE,
    ...overrides,
  }
}

const ENV = {
  OWNER_WALLET_ADDRESS: OWNER,
  TREASURY_OWNER_ADDRESS: OWNER,
  TREASURY_ADDRESS: VAULT,
  TREASURY_SIGNER_MODE: 'fireblocks',
}
const SESSION = async ({ tokenHash, origin }) => ({
  success: true,
  session: { address: OWNER, network: 'mainnet', origin, tokenHash },
})

async function withServer(options, callback) {
  const app = express()
  app.use(express.json({ limit: '32kb' }))
  app.use('/api/treasury', createThirdPartyFundingRouter({
    env: ENV,
    sessionLookup: SESSION,
    ...options,
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    await callback('http://127.0.0.1:' + address.port + '/api/treasury')
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function ownerHeaders() {
  return { authorization: 'Bearer ' + 'x'.repeat(43), origin: ORIGIN }
}

test('USDT deposit verifier requires exact confirmed TRC20 call and official Transfer event', () => {
  const result = verifyThirdPartyUsdtDepositEvidence(tronWeb, {
    ...confirmedUsdtEvidence(), transactionHash: TXID,
    sponsorAddress: SPONSOR, vaultAddress: VAULT, maxUsdtBaseUnits: AMOUNT_USDT,
  })
  assert.equal(result.verified, true)
  assert.equal(result.asset, 'USDT')
  assert.equal(result.amountBaseUnits, AMOUNT_USDT)
  assert.equal(result.blockNumber, 123456)
  assert.equal(result.evidenceIndex, 0)
})

test('USDT deposit verifier rejects wrong sender, recipient, contract, event amount and unconfirmed receipts', () => {
  const base = confirmedUsdtEvidence()
  const cases = [
    { transaction: { raw_data: { contract: [{ type: 'TriggerSmartContract', parameter: { value: {
      owner_address: hexFor(VAULT), contract_address: TOKEN_HEX, data: base.transaction.raw_data.contract[0].parameter.value.data,
    } } }] } } },
    { transactionInfo: { receipt: { result: 'FAILED' } } },
    { transactionInfo: { log: [] } },
    { transactionInfo: { blockNumber: 0 } },
  ]
  for (const overrides of cases) {
    const result = verifyThirdPartyUsdtDepositEvidence(tronWeb, {
      ...base, ...confirmedUsdtEvidence(overrides), transactionHash: TXID,
      sponsorAddress: SPONSOR, vaultAddress: VAULT, maxUsdtBaseUnits: AMOUNT_USDT,
    })
    assert.equal(result.verified, false)
  }
  const tooHigh = verifyThirdPartyUsdtDepositEvidence(tronWeb, {
    ...base, transactionHash: TXID, sponsorAddress: SPONSOR, vaultAddress: VAULT,
    maxUsdtBaseUnits: '1',
  })
  assert.equal(tooHigh.verified, false)
})

test('TRX deposit verifier requires exact solidified native transfer and bounded SUN amount', () => {
  const result = verifyThirdPartyTrxDepositEvidence(tronWeb, {
    ...confirmedTrxEvidence(), transactionHash: TXID,
    sponsorAddress: SPONSOR, vaultAddress: VAULT, maxTrxSun: AMOUNT_TRX,
  })
  assert.equal(result.verified, true)
  assert.equal(result.asset, 'TRX')
  assert.equal(result.amountBaseUnits, AMOUNT_TRX)
  const tooHigh = verifyThirdPartyTrxDepositEvidence(tronWeb, {
    ...confirmedTrxEvidence(), transactionHash: TXID,
    sponsorAddress: SPONSOR, vaultAddress: VAULT, maxTrxSun: '1',
  })
  assert.equal(tooHigh.verified, false)
})

test('third-party authorization cannot be persisted without a fresh verified Fireblocks inventory snapshot', async () => {
  let writes = 0
  await withServer({
    readLatestSnapshot: async () => ({ success: true, snapshot: null }),
    verifyAuthorization: async () => ({ verified: true }),
    store: {
      persistAuthorization: async () => { writes += 1; return { persisted: true } },
      getAuthorization: async () => ({ success: true, authorization: null }),
      listAuthorizations: async () => ({ success: true, authorizations: [] }),
      persistDeposit: async () => ({ persisted: true }),
      markDepositFireblocksVerified: async () => ({ verified: true }),
      revokeAuthorization: async () => ({ revoked: true }),
    },
  }, async (baseUrl) => {
    const response = await fetch(baseUrl + '/third-party-funding/authorizations', {
      method: 'POST',
      headers: { ...ownerHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: manifest(), agreementReviewAcknowledged: true }),
    })
    const payload = await response.json()
    assert.equal(response.status, 503)
    assert.equal(payload.error, 'verified-fireblocks-inventory-snapshot-required')
    assert.equal(writes, 0)
  })
})

test('authorization registration requires explicit owner acknowledgement of a reviewed agreement', async () => {
  let writes = 0
  await withServer({
    readLatestSnapshot: async () => ({ success: true, snapshot: inventorySnapshot() }),
    verifyAuthorization: async () => ({ verified: true }),
    store: {
      persistAuthorization: async () => { writes += 1; return { persisted: true } },
      getAuthorization: async () => ({ success: true, authorization: null }),
      listAuthorizations: async () => ({ success: true, authorizations: [] }),
      persistDeposit: async () => ({ persisted: true }),
      markDepositFireblocksVerified: async () => ({ verified: true }),
      revokeAuthorization: async () => ({ revoked: true }),
    },
  }, async (baseUrl) => {
    const response = await fetch(baseUrl + '/third-party-funding/authorizations', {
      method: 'POST',
      headers: { ...ownerHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: manifest(), agreementReviewAcknowledged: false }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, 'written-agreement-review-acknowledgement-required')
    assert.equal(writes, 0)
  })
})

test('owner can register verified scoped consent only after inventory and written-agreement review', async () => {
  let saved = null
  await withServer({
    readLatestSnapshot: async () => ({ success: true, snapshot: inventorySnapshot() }),
    verifyAuthorization: async (value, options) => {
      assert.equal(options.expectedVaultAddress, VAULT)
      return { verified: value.sponsorAddress === SPONSOR }
    },
    store: {
      persistAuthorization: async (input) => { saved = input; return { persisted: true, duplicate: false, status: 'awaiting-deposit' } },
      getAuthorization: async () => ({ success: true, authorization: null }),
      listAuthorizations: async () => ({ success: true, authorizations: [] }),
      persistDeposit: async () => ({ persisted: true }),
      markDepositFireblocksVerified: async () => ({ verified: true }),
      revokeAuthorization: async () => ({ revoked: true }),
    },
  }, async (baseUrl) => {
    const response = await fetch(baseUrl + '/third-party-funding/authorizations', {
      method: 'POST',
      headers: { ...ownerHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: manifest(), agreementReviewAcknowledged: true }),
    })
    const payload = await response.json()
    assert.equal(response.status, 201)
    assert.equal(payload.success, true)
    assert.equal(payload.legalAuthorityIndependentlyVerified, false)
    assert.equal(payload.payoutExecutionAuthorized, false)
    assert.equal(saved.agreementReviewedBy, OWNER)
    assert.match(saved.signatureHash, /^[0-9a-f]{64}$/)
    assert.match(saved.messageHash, /^[0-9a-f]{64}$/)
  })
})

test('deposit route persists only confirmed transaction evidence from the authorized source to exact vault', async () => {
  const deposit = confirmedUsdtEvidence()
  let saved = null
  await withServer({
    tronWebFactory: () => ({
      ...tronWeb,
      trx: {
        getConfirmedTransaction: async () => deposit.transaction,
        getTransactionInfo: async () => deposit.transactionInfo,
      },
    }),
    store: {
      persistAuthorization: async () => ({ persisted: true }),
      getAuthorization: async () => ({
        success: true,
        authorization: {
          authorizationId: 'funding-consent-test-001', sponsorAddress: SPONSOR,
          vaultAddress: VAULT, maxUsdtBaseUnits: AMOUNT_USDT, maxTrxSun: AMOUNT_TRX,
          expiresAt: new Date(Date.now() + 60_000), status: 'awaiting-deposit',
        },
        deposits: [],
      }),
      listAuthorizations: async () => ({ success: true, authorizations: [] }),
      persistDeposit: async (input) => { saved = input; return { persisted: true, duplicate: false } },
      markDepositFireblocksVerified: async () => ({ verified: true }),
      revokeAuthorization: async () => ({ revoked: true }),
    },
  }, async (baseUrl) => {
    const response = await fetch(baseUrl + '/third-party-funding/authorizations/funding-consent-test-001/deposits', {
      method: 'POST',
      headers: { ...ownerHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ asset: 'USDT', transactionHash: TXID }),
    })
    const payload = await response.json()
    assert.equal(response.status, 201)
    assert.equal(payload.status, 'chain-confirmed-awaiting-fireblocks-inventory')
    assert.equal(payload.payoutExecutionAuthorized, false)
    assert.equal(saved.amountBaseUnits, AMOUNT_USDT)
    assert.equal(saved.senderAddress, SPONSOR)
    assert.equal(saved.recipientAddress, VAULT)
  })
})

test('deposit route returns pending while the transaction is not solidified and writes nothing', async () => {
  let writes = 0
  await withServer({
    tronWebFactory: () => ({
      ...tronWeb,
      trx: {
        getConfirmedTransaction: async () => ({}),
        getTransactionInfo: async () => ({}),
      },
    }),
    store: {
      persistAuthorization: async () => ({ persisted: true }),
      getAuthorization: async () => ({
        success: true,
        authorization: {
          authorizationId: 'funding-consent-test-001', sponsorAddress: SPONSOR,
          vaultAddress: VAULT, maxUsdtBaseUnits: AMOUNT_USDT, maxTrxSun: AMOUNT_TRX,
          expiresAt: new Date(Date.now() + 60_000), status: 'awaiting-deposit',
        },
        deposits: [],
      }),
      listAuthorizations: async () => ({ success: true, authorizations: [] }),
      persistDeposit: async () => { writes += 1; return { persisted: true } },
      markDepositFireblocksVerified: async () => ({ verified: true }),
      revokeAuthorization: async () => ({ revoked: true }),
    },
  }, async (baseUrl) => {
    const response = await fetch(baseUrl + '/third-party-funding/authorizations/funding-consent-test-001/deposits', {
      method: 'POST',
      headers: { ...ownerHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ asset: 'USDT', transactionHash: TXID }),
    })
    const payload = await response.json()
    assert.equal(response.status, 202)
    assert.equal(payload.status, 'awaiting-solidification')
    assert.equal(writes, 0)
  })
})

test('Fireblocks reconciliation requires a later inventory snapshot with provider and chain balances', async () => {
  let marked = null
  const checkedAt = new Date().toISOString()
  const snapshot = inventorySnapshot({ checkedAt })
  await withServer({
    readLatestSnapshot: async () => ({ success: true, snapshot }),
    store: {
      persistAuthorization: async () => ({ persisted: true }),
      getAuthorization: async () => ({
        success: true,
        authorization: { vaultAddress: VAULT, status: 'deposit-evidence-recorded' },
        deposits: [{
          asset: 'USDT', transactionHash: TXID, recipientAddress: VAULT,
          amountBaseUnits: AMOUNT_USDT, chainVerifiedAt: new Date(Date.now() - 5_000).toISOString(),
        }],
      }),
      listAuthorizations: async () => ({ success: true, authorizations: [] }),
      persistDeposit: async () => ({ persisted: true }),
      markDepositFireblocksVerified: async (input) => { marked = input; return { verified: true, duplicate: false } },
      revokeAuthorization: async () => ({ revoked: true }),
    },
  }, async (baseUrl) => {
    const response = await fetch(baseUrl + '/third-party-funding/authorizations/funding-consent-test-001/deposits/fireblocks-reconcile', {
      method: 'POST',
      headers: { ...ownerHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ asset: 'USDT', transactionHash: TXID }),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.status, 'fireblocks-inventory-verified')
    assert.equal(payload.payoutExecutionAuthorized, false)
    assert.equal(marked.vaultAccountId, '123')
    assert.equal(marked.availableBalanceBaseUnits, '50000000')
  })
})

test('Fireblocks reconciliation refuses a snapshot older than the on-chain deposit', async () => {
  const snapshot = inventorySnapshot({ checkedAt: new Date(Date.now() - 60_000).toISOString() })
  await withServer({
    readLatestSnapshot: async () => ({ success: true, snapshot }),
    store: {
      persistAuthorization: async () => ({ persisted: true }),
      getAuthorization: async () => ({
        success: true,
        authorization: { vaultAddress: VAULT, status: 'deposit-evidence-recorded' },
        deposits: [{
          asset: 'USDT', transactionHash: TXID, recipientAddress: VAULT,
          amountBaseUnits: AMOUNT_USDT, chainVerifiedAt: new Date().toISOString(),
        }],
      }),
      listAuthorizations: async () => ({ success: true, authorizations: [] }),
      persistDeposit: async () => ({ persisted: true }),
      markDepositFireblocksVerified: async () => ({ verified: true }),
      revokeAuthorization: async () => ({ revoked: true }),
    },
  }, async (baseUrl) => {
    const response = await fetch(baseUrl + '/third-party-funding/authorizations/funding-consent-test-001/deposits/fireblocks-reconcile', {
      method: 'POST',
      headers: { ...ownerHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ asset: 'USDT', transactionHash: TXID }),
    })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error, 'fireblocks-inventory-snapshot-predates-deposit')
  })
})

test('owner revocation writes a durable revoked status', async () => {
  let revoked = null
  await withServer({
    store: {
      persistAuthorization: async () => ({ persisted: true }),
      getAuthorization: async () => ({ success: true, authorization: null }),
      listAuthorizations: async () => ({ success: true, authorizations: [] }),
      persistDeposit: async () => ({ persisted: true }),
      markDepositFireblocksVerified: async () => ({ verified: true }),
      revokeAuthorization: async (input) => { revoked = input; return { revoked: true, duplicate: false, status: 'revoked' } },
    },
  }, async (baseUrl) => {
    const response = await fetch(baseUrl + '/third-party-funding/authorizations/funding-consent-test-001/revoke', {
      method: 'POST',
      headers: { ...ownerHeaders(), 'content-type': 'application/json' },
      body: '{}',
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.status, 'revoked')
    assert.equal(revoked.revokedBy, OWNER)
  })
})
