import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createTreasuryWithdrawalsRouter, terminalTreasuryWithdrawalVerification, isUnifiedTreasuryOwnerConfiguration, matchesTreasuryWithdrawalRequest, parsePositiveDecimal, remainingThirdPartyFundingPrincipal, requiredTreasuryFeeReserveSun, treasuryFeeCapCovered, treasuryFeeReserveCovered, treasuryUsdtConfiguration, trxConfiguration, unreservedTreasuryBalance, verifyTreasuryTransferEvidence } from '../server/routes/treasury-withdrawals.mjs'

test('treasury payouts require the owner-console and treasury owner address to match exactly', () => {
  const owner = 'T' + 'A'.repeat(33)
  assert.equal(isUnifiedTreasuryOwnerConfiguration({
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
  }), true)
  assert.equal(isUnifiedTreasuryOwnerConfiguration({
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: 'T' + 'B'.repeat(33),
  }), false)
  assert.equal(isUnifiedTreasuryOwnerConfiguration({
    TREASURY_OWNER_ADDRESS: owner,
  }), false)
  assert.equal(isUnifiedTreasuryOwnerConfiguration({
    OWNER_WALLET_ADDRESS: 'invalid',
    TREASURY_OWNER_ADDRESS: 'invalid',
  }), false)
})

test('USDT payout configuration fails closed without a separately identified native TRX fee asset', () => {
  const owner = 'T' + 'A'.repeat(33)
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://example.invalid/db',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    TREASURY_ADDRESS: owner,
    TREASURY_MAX_PAYOUT_USDT: '10',
    TREASURY_DAILY_LIMIT_USDT: '100',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_WITHDRAWALS_ENABLED: 'true',
    TREASURY_SIGNER_MODE: 'fireblocks',
    FIREBLOCKS_API_KEY: 'synthetic-test-api-key',
    FIREBLOCKS_SECRET_KEY_PATH: '/etc/secrets/fireblocks-test.pem',
    FIREBLOCKS_VAULT_ACCOUNT_ID: '123',
    FIREBLOCKS_USDT_ASSET_ID: 'TRON_USDT',
  }
  const missingNativeAsset = treasuryUsdtConfiguration(base)
  assert.equal(missingNativeAsset.enabled, false)
  assert.equal(missingNativeAsset.providerConfigured, true)
  assert.ok(missingNativeAsset.missing.includes('FIREBLOCKS_TRX_ASSET_ID'))

  const withNativeAsset = treasuryUsdtConfiguration({ ...base, FIREBLOCKS_TRX_ASSET_ID: 'TRX' })
  assert.equal(withNativeAsset.enabled, true, 'syntactic config only; runtime readiness still validates provider metadata, balances and vault addresses')

  const featureDisabled = treasuryUsdtConfiguration({
    ...base, FIREBLOCKS_TRX_ASSET_ID: 'TRX', TREASURY_WITHDRAWALS_ENABLED: 'false',
  })
  assert.equal(featureDisabled.configurationComplete, true, 'readiness configuration can be validated while the transfer gate is disabled')
  assert.equal(featureDisabled.featureFlagEnabled, false)
  assert.equal(featureDisabled.enabled, false, 'the environment feature gate remains authoritative')
})

test('native TRX payout never enables through a legacy application-held hot wallet', () => {
  const owner = 'T' + 'A'.repeat(33)
  const config = trxConfiguration({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://example.invalid/db',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    TREASURY_ADDRESS: owner,
    TREASURY_PRIVATE_KEY: 'placeholder-not-a-real-key',
    TREASURY_MAX_PAYOUT_TRX: '10',
    TREASURY_DAILY_LIMIT_TRX: '100',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_TRX_WITHDRAWALS_ENABLED: 'true',
    TREASURY_SIGNER_MODE: 'env-hot-wallet',
  })
  assert.equal(config.enabled, false)
  assert.ok(config.missing.includes('FIREBLOCKS_TRX_ASSET_ID'))
  assert.ok(config.missing.includes('TREASURY_SIGNER_MODE=fireblocks'))
})

test('native TRX payout does not fall back to the legacy key in Fireblocks signer mode', () => {
  const owner = 'T' + 'A'.repeat(33)
  const config = trxConfiguration({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://example.invalid/db',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    TREASURY_ADDRESS: owner,
    TREASURY_MAX_PAYOUT_TRX: '10',
    TREASURY_DAILY_LIMIT_TRX: '100',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_TRX_WITHDRAWALS_ENABLED: 'true',
    TREASURY_SIGNER_MODE: 'fireblocks',
  })
  assert.equal(config.enabled, false)
})

test('USDT decimal parser converts exact six-decimal amounts to base units', () => {
  assert.equal(parsePositiveDecimal('1'), 1_000_000n)
  assert.equal(parsePositiveDecimal('0.000001'), 1n)
  assert.equal(parsePositiveDecimal('12.340500'), 12_340_500n)
})

test('USDT decimal parser rejects zero, excess precision, exponent notation and malformed input', () => {
  for (const value of ['0', '0.0000001', '-1', '+1', '1e3', '01', '.5', '1.', '', ' 1']) {
    assert.equal(parsePositiveDecimal(value), null, value)
  }
})

test('USDT parser rejects values above uint256 and accepts its exact six-decimal maximum', () => {
  const maxUint256 = (1n << 256n) - 1n
  assert.equal(
    parsePositiveDecimal('115792089237316195423570985008687907853269984665640564039457584007913129.639935'),
    maxUint256,
  )
  assert.equal(parsePositiveDecimal('1'.repeat(78)), null)
  assert.equal(parsePositiveDecimal('9'.repeat(5000)), null)
})

test('real-value USDT and TRX payout submission is hard-disabled even when environment flags are true', async (t) => {
  let sessionLookups = 0
  let providerFactoryCalls = 0
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', createTreasuryWithdrawalsRouter({
    env: {
      TREASURY_WITHDRAWALS_ENABLED: 'true',
      TREASURY_TRX_WITHDRAWALS_ENABLED: 'true',
    },
    sessionLookup: async () => {
      sessionLookups += 1
      throw new Error('owner session lookup must not run while execution is hard-disabled')
    },
    fireblocksClientFactory: () => {
      providerFactoryCalls += 1
      throw new Error('Fireblocks must not be contacted while execution is hard-disabled')
    },
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/treasury`
  for (const path of ['/withdrawals', '/trx-withdrawals']) {
    const response = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://owner.example' },
      body: JSON.stringify({ recipientAddress: 'T' + 'A'.repeat(33), amountUsdt: '1', amountTrx: '1' }),
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      success: false,
      error: 'real-value-payout-execution-disabled-in-this-build',
      submissionEnabled: false,
    })
  }
  assert.equal(sessionLookups, 0)
  assert.equal(providerFactoryCalls, 0)
})

test('treasury endpoint requires an authenticated owner session before touching treasury configuration', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', createTreasuryWithdrawalsRouter({
    env: {},
    sessionLookup: async () => ({ success: true, session: null }),
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  const response = await fetch(`http://127.0.0.1:${address.port}/api/treasury/withdrawals/readiness`, {
    headers: { origin: 'https://owner.example' },
  })
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { success: false, error: 'owner-auth-required' })
})


const treasuryAddress = 'T' + 'A'.repeat(33)
const recipientAddress = 'T' + 'B'.repeat(33)
const txid = 'a'.repeat(64)
const amountBaseUnits = '12345000'
const addressHex = new Map([
  [treasuryAddress, '41' + '11'.repeat(20)],
  [recipientAddress, '41' + '22'.repeat(20)],
  ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '41' + '33'.repeat(20)],
])
const fakeTronWeb = { address: { toHex: (address) => addressHex.get(address) || '' } }
const transferEventTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const usdtContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

function validEvidence({ receiptResult = 'SUCCESS', amount = amountBaseUnits, recipient = recipientAddress } = {}) {
  const recipientHex = addressHex.get(recipient).slice(2)
  const data = 'a9059cbb' + recipientHex.padStart(64, '0')
    + BigInt(amount).toString(16).padStart(64, '0')
  const senderTopic = '0x' + addressHex.get(treasuryAddress).slice(2).padStart(64, '0')
  const recipientTopic = '0x' + recipientHex.padStart(64, '0')
  return {
    transaction: {
      txID: txid,
      raw_data: { contract: [{
        type: 'TriggerSmartContract',
        parameter: { value: {
          owner_address: addressHex.get(treasuryAddress),
          contract_address: addressHex.get(usdtContract),
          data,
        } },
      }] },
    },
    transactionInfo: {
      id: txid,
      blockNumber: 12345,
      receipt: receiptResult ? { result: receiptResult } : {},
      log: [{
        address: addressHex.get(usdtContract).slice(2),
        topics: ['0x' + transferEventTopic, senderTopic, recipientTopic],
        data: '0x' + BigInt(amount).toString(16).padStart(64, '0'),
      }],
    },
  }
}

function verify(input = validEvidence()) {
  return verifyTreasuryTransferEvidence(fakeTronWeb, {
    ...input,
    transactionHash: txid,
    treasuryAddress,
    recipientAddress,
    amountBaseUnits,
  })
}

test('treasury receipt verifier confirms only the exact official-USDT transfer and successful solidified receipt', () => {
  assert.deepEqual(verify(), {
    verified: true,
    status: 'confirmed',
    reason: 'confirmed-solidified-successful-receipt-and-transfer-event',
    blockNumber: 12345,
  })
})

test('treasury receipt verifier rejects a different recipient, amount, sender, or token contract', () => {
  assert.equal(verify(validEvidence({ recipient: treasuryAddress })).status, 'verification-mismatch')
  assert.equal(verify(validEvidence({ amount: '12345001' })).status, 'verification-mismatch')

  const wrongSender = validEvidence()
  wrongSender.transaction.raw_data.contract[0].parameter.value.owner_address = '41' + '44'.repeat(20)
  assert.equal(verify(wrongSender).reason, 'sender-or-token-contract-mismatch')

  const wrongContract = validEvidence()
  wrongContract.transaction.raw_data.contract[0].parameter.value.contract_address = '41' + '55'.repeat(20)
  assert.equal(verify(wrongContract).reason, 'sender-or-token-contract-mismatch')
})

test('treasury receipt verifier reports failed contract execution as failed, not received USDT', () => {
  assert.deepEqual(verify(validEvidence({ receiptResult: 'REVERT' })), {
    verified: true,
    status: 'failed',
    reason: 'confirmed-solidified-failed-receipt',
    blockNumber: 12345,
  })
})

test('treasury receipt verifier leaves missing receipt evidence pending', () => {
  const evidence = validEvidence({ receiptResult: null })
  assert.equal(verify(evidence).status, 'awaiting-confirmed-receipt')
  assert.equal(verify(evidence).verified, false)
})

test('treasury receipt verifier rejects a transaction hash that does not match the returned transaction', () => {
  const evidence = validEvidence()
  evidence.transaction.txID = 'b'.repeat(64)
  assert.equal(verify(evidence).verified, false)
})

test('treasury receipt verifier refuses success when the official USDT Transfer event is missing or mismatched', () => {
  const missing = validEvidence()
  missing.transactionInfo.log = []
  assert.equal(verify(missing).status, 'verification-mismatch')
  assert.equal(verify(missing).reason, 'official-usdt-transfer-event-missing-or-mismatched')

  const wrongAmount = validEvidence()
  wrongAmount.transactionInfo.log[0].data = '0x' + BigInt(amountBaseUnits + '1').toString(16).padStart(64, '0')
  assert.equal(verify(wrongAmount).reason, 'official-usdt-transfer-event-missing-or-mismatched')

  const duplicate = validEvidence()
  duplicate.transactionInfo.log.push({ ...duplicate.transactionInfo.log[0], topics: [...duplicate.transactionInfo.log[0].topics] })
  assert.equal(verify(duplicate).reason, 'official-usdt-transfer-event-missing-or-mismatched')
})

test('treasury fee preflight requires real native TRX to cover the configured maximum fee cap', () => {
  assert.equal(treasuryFeeCapCovered('50000000', '50000000'), true)
  assert.equal(treasuryFeeCapCovered('50000001', '50000000'), true)
  assert.equal(treasuryFeeCapCovered('49999999', '50000000'), false)
  assert.equal(treasuryFeeCapCovered('0', '1'), false)
  assert.equal(treasuryFeeCapCovered('invalid', '50000000'), false)
  assert.equal(treasuryFeeCapCovered('50000000', '0'), false)
  assert.equal(treasuryFeeCapCovered('50000000', '1e6'), false)
})

test('cross-asset fee reserve budgets one fee cap per unresolved payout plus the new request', () => {
  const feeCap = '50000000'
  assert.equal(requiredTreasuryFeeReserveSun(feeCap, '0', '0'), '50000000')
  assert.equal(requiredTreasuryFeeReserveSun(feeCap, '1', '0'), '100000000')
  assert.equal(requiredTreasuryFeeReserveSun(feeCap, '0', '2'), '150000000')
  assert.equal(requiredTreasuryFeeReserveSun(feeCap, '2', '3'), '300000000')
  assert.equal(requiredTreasuryFeeReserveSun('0', '0', '0'), null)
  assert.equal(requiredTreasuryFeeReserveSun(feeCap, '-1', '0'), null)
  assert.equal(requiredTreasuryFeeReserveSun(feeCap, '01', '0'), null)
  assert.equal(requiredTreasuryFeeReserveSun('1000000000', '999999999999', '0'), null)
})

test('cross-asset fee reserve requires both on-chain and provider-available TRX to cover the full reserve', () => {
  assert.equal(treasuryFeeReserveCovered('100000000', '100000000', '100000000'), true)
  assert.equal(treasuryFeeReserveCovered('99999999', '100000000', '100000000'), false)
  assert.equal(treasuryFeeReserveCovered('100000000', '99999999', '100000000'), false)
  assert.equal(treasuryFeeReserveCovered('100000000', '100000000', '150000000'), false)
  assert.equal(treasuryFeeReserveCovered('invalid', '100000000', '100000000'), false)
  assert.equal(treasuryFeeReserveCovered('100000000', 'invalid', '100000000'), false)
})

test('third-party principal is limited to verified deposits minus every committed withdrawal', () => {
  assert.equal(remainingThirdPartyFundingPrincipal('25000000', '0'), '25000000')
  assert.equal(remainingThirdPartyFundingPrincipal('25000000', '10000000'), '15000000')
  assert.equal(remainingThirdPartyFundingPrincipal('25000000', '25000000'), '0')
  assert.equal(remainingThirdPartyFundingPrincipal('25000000', '26000000'), '0')
  assert.equal(remainingThirdPartyFundingPrincipal('bad', '0'), null)
  assert.equal(remainingThirdPartyFundingPrincipal('25000000', 'bad'), null)
})

test('treasury available-balance calculation reserves ambiguous or pending payouts conservatively', () => {
  assert.equal(unreservedTreasuryBalance('10000000', '2500000'), '7500000')
  assert.equal(unreservedTreasuryBalance('10000000', '10000000'), '0')
  assert.equal(unreservedTreasuryBalance('10000000', '12000000'), '0')
  assert.equal(unreservedTreasuryBalance('bad', '0'), null)
  assert.equal(unreservedTreasuryBalance('100', '1.5'), null)
})

test('withdrawal idempotency binds an existing key to the exact owner, treasury, recipient, token and amount', () => {
  const row = {
    owner_address: treasuryAddress,
    treasury_address: treasuryAddress,
    recipient_address: recipientAddress,
    token_contract: usdtContract,
    amount_base_units: amountBaseUnits,
  }
  const request = {
    ownerAddress: treasuryAddress,
    treasuryAddress,
    recipientAddress,
    amountBaseUnits,
  }
  assert.equal(matchesTreasuryWithdrawalRequest(row, request), true)
  assert.equal(matchesTreasuryWithdrawalRequest(row, { ...request, recipientAddress: treasuryAddress }), false)
  assert.equal(matchesTreasuryWithdrawalRequest(row, { ...request, amountBaseUnits: '1' }), false)
  assert.equal(matchesTreasuryWithdrawalRequest(row, { ...request, ownerAddress: recipientAddress }), false)
})

test('USDT readiness still probes provider and chain funding while transfer submission remains disabled', async (t) => {
  const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
  const treasury = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
  const usdtContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  const usdtAssetId = 'TRON_USDT'
  const trxAssetId = 'TRX'
  const sessionToken = 'a'.repeat(43)
  const env = {
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    TREASURY_ADDRESS: treasury,
    TREASURY_WITHDRAWALS_ENABLED: 'false',
    TREASURY_SIGNER_MODE: 'fireblocks',
    TREASURY_MAX_PAYOUT_USDT: '10',
    TREASURY_DAILY_LIMIT_USDT: '100',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    FIREBLOCKS_API_KEY: 'test-provider-key',
    FIREBLOCKS_SECRET_KEY_PATH: '/tmp/fireblocks-api-key.pem',
    FIREBLOCKS_VAULT_ACCOUNT_ID: '123',
    FIREBLOCKS_USDT_ASSET_ID: usdtAssetId,
    FIREBLOCKS_TRX_ASSET_ID: trxAssetId,
  }
  let metadataReads = 0
  let balanceReads = 0
  const app = express()
  app.use('/api/treasury', createTreasuryWithdrawalsRouter({
    env,
    sessionLookup: async ({ tokenHash, origin }) => ({
      success: true,
      session: {
        address: owner,
        network: 'mainnet',
        origin,
      },
    }),
    tronWebFactory: () => ({
      isAddress: (value) => typeof value === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value),
      address: {
        toHex: (value) => value === usdtContract
          ? '41' + '33'.repeat(20)
          : value === treasury
            ? '41' + '11'.repeat(20)
            : value === owner
              ? '41' + '22'.repeat(20)
              : '',
      },
      trx: { getBalance: async (address) => {
        assert.equal(address, treasury)
        balanceReads += 1
        return '100000000'
      } },
      contract: () => ({
        at: async (address) => {
          assert.equal(address, usdtContract)
          return {
            decimals: () => ({ call: async () => 6 }),
            symbol: () => ({ call: async () => 'USDT' }),
            balanceOf: (address) => ({ call: async () => {
              assert.equal(address, treasury)
              return '1000000'
            } }),
          }
        },
      }),
    }),
    fireblocksClientFactory: () => ({
      isConfigured: () => true,
      isTrxAssetConfigured: () => true,
      getVaultAccount: async () => ({
        id: '123',
        name: 'Test Treasury',
        assets: [{ id: usdtAssetId }, { id: trxAssetId }],
      }),
      getAssetMetadata: async (assetId = usdtAssetId) => {
        metadataReads += 1
        return assetId === trxAssetId
          ? { id: trxAssetId, assetClass: 'NATIVE', symbol: 'TRX', decimals: 6 }
          : { id: usdtAssetId, contractAddress: usdtContract }
      },
      getVaultAccountAsset: async (assetId = usdtAssetId) => ({ id: assetId, available: '1' }),
      getAssetAddresses: async () => ({ addresses: [treasury] }),
    }),
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/treasury/withdrawals/readiness`, {
    headers: {
      authorization: 'Bearer ' + sessionToken,
      origin: 'https://owner.example',
    },
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.configuration.configurationComplete, false, 'database config is intentionally absent in this fixture')
  assert.equal(payload.configuration.featureFlagEnabled, false)
  assert.equal(payload.configuration.enabled, false)
  assert.equal(payload.withdrawalsEnabled, false)
  assert.equal(payload.preflightChecksPassed, false)
  assert.equal(payload.executionEnabled, false)
  assert.equal(payload.executionBlocker, 'real-value-payout-execution-disabled-in-this-build')
  assert.ok(payload.payoutBlockers.includes('real-value-payout-execution-disabled-in-this-build'))
  assert.ok(payload.payoutBlockers.includes('usdt-payout-feature-disabled'))
  assert.ok(payload.payoutBlockers.includes('database-not-ready'))
  assert.equal(payload.providerAssetIdentityVerified, true, 'readiness should still verify Fireblocks asset metadata')
  assert.equal(payload.providerVaultAccountVerified, true, 'readiness should verify the configured Fireblocks vault account ID')
  assert.equal(payload.providerUsdtAssetActivated, true, 'readiness should verify that USDT is activated in the vault')
  assert.equal(payload.providerTrxAssetActivated, true, 'readiness should verify that TRX is activated in the vault')
  assert.equal(payload.providerVaultAddressVerified, true, 'readiness should still verify the configured vault address')
  assert.equal(payload.nativeTrxAssetIdentityVerified, true)
  assert.ok(metadataReads >= 2)
  assert.ok(balanceReads >= 1)
})

test('native TRX readiness reports the immutable real-value execution gate separately from preflight', async (t) => {
  const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
  const sessionToken = 'a'.repeat(43)
  const app = express()
  app.use('/api/treasury', createTreasuryWithdrawalsRouter({
    env: {
      OWNER_WALLET_ADDRESS: owner,
      TREASURY_OWNER_ADDRESS: owner,
      TREASURY_TRX_WITHDRAWALS_ENABLED: 'false',
    },
    sessionLookup: async ({ origin }) => ({
      success: true,
      session: { address: owner, network: 'mainnet', origin },
    }),
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/treasury/trx-withdrawals/readiness`, {
    headers: { authorization: 'Bearer ' + sessionToken, origin: 'https://owner.example' },
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.withdrawalsEnabled, false)
  assert.equal(payload.preflightChecksPassed, false)
  assert.equal(payload.executionEnabled, false)
  assert.equal(payload.executionBlocker, 'real-value-payout-execution-disabled-in-this-build')
  assert.ok(payload.payoutBlockers.includes('real-value-payout-execution-disabled-in-this-build'))
})

test('native TRX configuration distinguishes an incomplete setup from a deliberately closed payout gate', () => {
  const owner = 'T' + 'A'.repeat(33)
  const config = trxConfiguration({
    DATABASE_URL: 'postgresql://example.invalid/db',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    TREASURY_ADDRESS: owner,
    TREASURY_MAX_PAYOUT_TRX: '10',
    TREASURY_DAILY_LIMIT_TRX: '100',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_SIGNER_MODE: 'fireblocks',
    TREASURY_TRX_WITHDRAWALS_ENABLED: 'false',
    FIREBLOCKS_API_BASE: 'https://api.fireblocks.io',
    FIREBLOCKS_API_KEY: 'synthetic-test-api-key',
    FIREBLOCKS_SECRET_KEY_PATH: '/tmp/fireblocks-test.pem',
    FIREBLOCKS_VAULT_ACCOUNT_ID: '123',
    FIREBLOCKS_TRX_ASSET_ID: 'TRX',
  })
  assert.equal(config.configurationComplete, true)
  assert.equal(config.featureFlagEnabled, false)
  assert.equal(config.enabled, false)
  assert.deepEqual(config.missing, [])
})


test('Fireblocks terminal failure is not misreported as a verified on-chain failure', () => {
  const result = terminalTreasuryWithdrawalVerification({
    status: 'failed',
    failure_code: 'fireblocks-terminal-failed',
  })
  assert.deepEqual(result, {
    terminal: true,
    success: false,
    verification: {
      verified: false,
      status: 'provider-failed',
      reason: 'provider-terminal-failure-not-chain-verified',
    },
  })
})

test('previously verified solidified USDT success can be returned as verified', () => {
  assert.deepEqual(terminalTreasuryWithdrawalVerification({
    status: 'confirmed',
    failure_code: null,
  }), {
    terminal: true,
    success: true,
    verification: {
      verified: true,
      status: 'confirmed',
      reason: 'previously-verified-solidified-receipt',
    },
  })
})

test('failed USDT withdrawal is chain-verified only when its failure code came from the solidified receipt verifier', () => {
  assert.deepEqual(terminalTreasuryWithdrawalVerification({
    status: 'failed',
    failure_code: 'confirmed-solidified-failed-receipt',
  }), {
    terminal: true,
    success: false,
    verification: {
      verified: true,
      status: 'failed',
      reason: 'confirmed-solidified-failed-receipt',
    },
  })
  assert.equal(terminalTreasuryWithdrawalVerification({
    status: 'provider-pending',
    failure_code: 'confirmed-solidified-failed-receipt',
  }).terminal, false)
})
