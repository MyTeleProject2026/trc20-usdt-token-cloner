import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import express from 'express'
import { createServer } from 'node:http'
import { createTreasuryWithdrawalsRouter, terminalTreasuryWithdrawalVerification, fireblocksPayoutLedgerState, isUnifiedTreasuryOwnerConfiguration, isTreasuryRecipientAllowed, matchesTreasuryWithdrawalRequest, parseTreasuryRecipientAllowlist, parseTreasurySponsorApproverAllowlist, buildTreasuryRecipientApprovalMessage, buildTreasuryRecipientRevocationMessage, recoverTreasurySponsorRecipientApprover, verifyTreasurySponsorRecipientApproval, parsePositiveDecimal, requiredTreasuryFeeReserveSun, treasuryFeeCapCovered, treasuryFeeReserveCovered, treasuryUsdtConfiguration, trxConfiguration, unreservedTreasuryBalance, verifyTreasuryTransferEvidence, calculateSponsorPrincipalBudgetState, sponsorPrincipalBudgetCapMatches, treasuryPayoutExecutionState, treasuryTrxPayoutExecutionState, buildTreasuryRealValueReleaseMessage, verifyTreasuryRealValueReleaseAuthorization, buildTreasuryRealValueReleaseRevocationMessage } from '../server/routes/treasury-withdrawals.mjs'


test('Mainnet USDT payout readiness and submission fail closed without fresh Fireblocks outbound history', async () => {
  const source = await readFile(new URL('../server/routes/treasury-withdrawals.mjs', import.meta.url), 'utf8')
  const historyRoute = await readFile(new URL('../server/routes/fireblocks-outbound-history.mjs', import.meta.url), 'utf8')
  assert.match(source, /getFireblocksOutboundHistoryStatus/)
  assert.match(source, /fireblocks-vault-outbound-history-not-reconciled/)
  assert.match(source, /BigInt\(applicationCommittedBaseUnits\) \+ BigInt\(externalOutboundUsdtBaseUnits\)/)
  assert.match(source, /AND status <> 'rejected'/, 'failed or ambiguous app requests remain committed')
  assert.match(source, /if \(outboundHistory\.verified\) \{\s*sponsorPrincipalBudget = calculateSponsorPrincipalBudgetState/)
  assert.match(historyRoute, /createFireblocksReadOnlyClient/)
  assert.match(historyRoute, /fireblocksReadOnlyConfiguration/)
  assert.doesNotMatch(historyRoute, /!cfg\.providerConfigured/, 'history sync must not require the payout API identity')
  assert.match(historyRoute, /pg_try_advisory_lock\(hashtextextended/)
  assert.match(historyRoute, /scan_after_ms/, 'scan cursor must persist the incremental lower boundary')
  assert.match(historyRoute, /fireblocksHistoryScanAfterMs/, 'completed scans must advance from the prior upper boundary with an overlap')
  assert.match(historyRoute, /WHERE vault_account_id=\$1 ORDER BY provider_transaction_id/, 'reconciliation must include cumulative persisted provider history')
  assert.match(historyRoute, /last_seen_run_id=\$2/, 'the current incremental window must be count-checked separately')
  assert.match(historyRoute, /now\(\) - historyEndMs/, 'freshness must be measured from the covered provider-history boundary')
})

test('Mainnet USDT transfer submission has an immutable source-controlled build lock', async () => {
  const source = await readFile(new URL('../server/routes/treasury-withdrawals.mjs', import.meta.url), 'utf8')
  assert.match(source, /const REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true/)
  assert.match(source, /payoutsPreflightReady && sponsorReleaseAuthorized\s*&&\s*!REAL_VALUE_PAYOUT_EXECUTION_DISABLED/)
  const post = source.slice(source.indexOf("router.post('/withdrawals'"))
  assert.match(post, /if \(REAL_VALUE_PAYOUT_EXECUTION_DISABLED\)[\s\S]{0,300}real-value-payout-execution-disabled-in-this-build/)
})

test('USDT payout execution requires successful preflight and separate sponsor release authorization', () => {
  const missingRelease = treasuryPayoutExecutionState(true, false)
  assert.equal(missingRelease.payoutsPreflightReady, true)
  assert.equal(missingRelease.sponsorReleaseAuthorized, false)
  assert.equal(missingRelease.withdrawalsEnabled, false)
  assert.equal(missingRelease.executionEnabled, false)
  assert.equal(missingRelease.executionBlocker, 'real-value-payout-execution-disabled-in-this-build')
  const authorized = treasuryPayoutExecutionState(true, true)
  assert.equal(authorized.sponsorReleaseAuthorized, true)
  assert.equal(authorized.withdrawalsEnabled, false)
  assert.equal(authorized.executionEnabled, false)
  assert.equal(authorized.executionBlocker, 'real-value-payout-execution-disabled-in-this-build')
  const blockedPreflight = treasuryPayoutExecutionState(false, true)
  assert.equal(blockedPreflight.sponsorReleaseAuthorized, true)
  assert.equal(blockedPreflight.withdrawalsEnabled, false)
  assert.equal(blockedPreflight.executionEnabled, false)
  assert.equal(blockedPreflight.executionBlocker, 'real-value-payout-execution-disabled-in-this-build')
  const trx = treasuryTrxPayoutExecutionState(true)
  assert.equal(trx.withdrawalsEnabled, false)
  assert.equal(trx.executionBlocker, 'native-trx-payout-execution-disabled-in-this-build')
})

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
    TREASURY_SPONSOR_ORGANIZATION_REFERENCE: 'authorized-sponsor-org-001',
    TREASURY_SPONSOR_AGREEMENT_REFERENCE: 'sponsor-agreement-2026-001',
    TREASURY_SPONSOR_TOTAL_BUDGET_USDT: '1000',
    TREASURY_ALLOWED_RECIPIENT_ADDRESSES: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp,TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
    SPONSOR_APPROVED_AGREEMENT_REFERENCES: 'sponsor-agreement-2026-001|authorized-sponsor-org-001|mainnet|' + owner + '|asset-grant|USDT|TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
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

test('schema migration keeps unverified provider terminal results reserved for both USDT and TRX', async () => {
  const source = await readFile(new URL('../server/routes/treasury-withdrawals.mjs', import.meta.url), 'utf8')
  assert.equal(source.split("failure_code='fireblocks-terminal-unverified-' || COALESCE(NULLIF(provider_status, ''), 'unknown')").length - 1, 2)
  assert.equal(source.split("COALESCE(failure_code, '') LIKE 'fireblocks-terminal-%'").length - 1, 2)
})

test('provider terminal failures without a chain hash remain unresolved and do not release principal budget', () => {
  assert.deepEqual(fireblocksPayoutLedgerState({
    localStatus: 'failed',
    terminalFailure: true,
    providerStatus: 'FAILED',
    transactionHash: null,
  }), {
    status: 'broadcast-unknown',
    failureCode: 'fireblocks-terminal-unverified-failed',
  })
  assert.deepEqual(fireblocksPayoutLedgerState({
    localStatus: 'broadcast-accepted',
    terminalFailure: true,
    providerStatus: 'FAILED',
    transactionHash: 'a'.repeat(64),
  }), { status: 'broadcast-accepted', failureCode: null })
  assert.deepEqual(fireblocksPayoutLedgerState({
    localStatus: 'provider-pending',
    terminalFailure: false,
    providerStatus: 'PENDING_SIGNATURE',
    transactionHash: null,
  }), { status: 'provider-pending', failureCode: null })
})

test('principal budget SQL counts legacy and partially unpinned sponsor rows as blockers in both preflight and reservation', async () => {
  const source = await readFile(new URL('../server/routes/treasury-withdrawals.mjs', import.meta.url), 'utf8')
  assert.equal(source.split('sponsor_agreement_budget_base_units IS NULL').length - 1, 2)
  assert.equal(source.split('OR sponsor_agreement_reference IS NULL').length - 1, 4)
})

test('sponsor agreement principal cap cannot silently change after the first reservation', () => {
  assert.equal(sponsorPrincipalBudgetCapMatches('1000000000'), true)
  assert.equal(sponsorPrincipalBudgetCapMatches('1000000000', {
    minimumStoredBudgetBaseUnits: '1000000000', maximumStoredBudgetBaseUnits: '1000000000',
  }), true)
  assert.equal(sponsorPrincipalBudgetCapMatches('2000000000', {
    minimumStoredBudgetBaseUnits: '1000000000', maximumStoredBudgetBaseUnits: '1000000000',
  }), false)
  assert.equal(sponsorPrincipalBudgetCapMatches('1000000000', {
    minimumStoredBudgetBaseUnits: '900000000', maximumStoredBudgetBaseUnits: '1000000000',
  }), false)
  assert.equal(sponsorPrincipalBudgetCapMatches('1000000000', { unpinnedAgreementRows: '1' }), false)
  assert.equal(sponsorPrincipalBudgetCapMatches('0'), false)
})

test('third-party USDT principal budget uses exact base units and includes unresolved reservations', () => {
  assert.deepEqual(calculateSponsorPrincipalBudgetState('1000000000', '250000000', '500000000'), {
    totalBudgetBaseUnits: '1000000000',
    usedBaseUnits: '250000000',
    remainingBaseUnits: '750000000',
    requestedBaseUnits: '500000000',
    withinBudget: true,
  })
  const exhausted = calculateSponsorPrincipalBudgetState('1000000000', '750000000', '250000001')
  assert.equal(exhausted.withinBudget, false)
  assert.equal(exhausted.remainingBaseUnits, '250000000')
  assert.equal(calculateSponsorPrincipalBudgetState('1000000000', '1000000001', '1').withinBudget, false)
  assert.equal(calculateSponsorPrincipalBudgetState('1e6', '0', '1'), null)
  assert.equal(calculateSponsorPrincipalBudgetState('1000000000', '-1', '1'), null)
})

test('USDT sponsor configuration requires a traceable organization, agreement and aggregate principal cap', () => {
  const owner = 'T' + 'A'.repeat(33)
  const base = {
    DATABASE_URL: 'postgresql://example.invalid/db',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    TREASURY_ADDRESS: owner,
    TREASURY_MAX_PAYOUT_USDT: '10',
    TREASURY_DAILY_LIMIT_USDT: '100',
    TREASURY_SPONSOR_ORGANIZATION_REFERENCE: 'authorized-sponsor-org-001',
    TREASURY_SPONSOR_AGREEMENT_REFERENCE: 'sponsor-agreement-2026-001',
    TREASURY_SPONSOR_TOTAL_BUDGET_USDT: '1000',
    TREASURY_ALLOWED_RECIPIENT_ADDRESSES: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp,TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
    SPONSOR_APPROVED_AGREEMENT_REFERENCES: 'sponsor-agreement-2026-001|authorized-sponsor-org-001|mainnet|' + owner + '|asset-grant|USDT|TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_SIGNER_MODE: 'fireblocks',
    FIREBLOCKS_API_KEY: 'synthetic-test-api-key',
    FIREBLOCKS_SECRET_KEY_PATH: '/etc/secrets/fireblocks-test.pem',
    FIREBLOCKS_VAULT_ACCOUNT_ID: '123',
    FIREBLOCKS_USDT_ASSET_ID: 'TRON_USDT',
    FIREBLOCKS_TRX_ASSET_ID: 'TRX',
  }
  assert.equal(treasuryUsdtConfiguration(base).configurationComplete, true)
  assert.equal(treasuryUsdtConfiguration({
    ...base, TREASURY_SPONSOR_AGREEMENT_REFERENCE: '',
  }).configurationComplete, false)
  assert.ok(treasuryUsdtConfiguration({
    ...base, TREASURY_SPONSOR_AGREEMENT_REFERENCE: 'bad value with spaces',
  }).missing.includes('TREASURY_SPONSOR_AGREEMENT_REFERENCE'))
  assert.equal(treasuryUsdtConfiguration({
    ...base, SPONSOR_APPROVED_AGREEMENT_REFERENCES: 'sponsor-agreement-2026-001|authorized-sponsor-org-001|nile|' + owner + '|asset-grant|USDT|TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  }).sponsorAgreementScopeApproved, false, 'testnet agreement must not authorize Mainnet USDT principal')
  assert.equal(treasuryUsdtConfiguration({
    ...base, SPONSOR_APPROVED_AGREEMENT_REFERENCES: 'sponsor-agreement-2026-001|authorized-sponsor-org-001|mainnet|T' + 'B'.repeat(33) + '|asset-grant|USDT|TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  }).sponsorAgreementScopeApproved, false, 'approval for another sponsor wallet must not authorize this treasury')
  assert.equal(treasuryUsdtConfiguration({
    ...base, TREASURY_SPONSOR_TOTAL_BUDGET_USDT: '5',
  }).configurationComplete, false, 'aggregate sponsor cap must cover both the per-payout and daily caps')
})

test('USDT principal-sponsor destination allowlist validates Base58Check addresses and rejects unapproved recipients', () => {
  const first = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
  const second = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
  const parsed = parseTreasuryRecipientAllowlist(first + ', ' + second)
  assert.equal(parsed.valid, true)
  assert.deepEqual(parsed.addresses, [first, second])
  assert.equal(isTreasuryRecipientAllowed(first, parsed.addresses), true)
  assert.equal(isTreasuryRecipientAllowed(first.toLowerCase(), parsed.addresses), false)
  assert.equal(isTreasuryRecipientAllowed('TJRabPrwbZy45sbavfcjinPJC18kjpRTv8', parsed.addresses), false)
  assert.equal(parseTreasuryRecipientAllowlist('').valid, false)
  assert.equal(parseTreasuryRecipientAllowlist(first + ',' + first).valid, false)
  assert.equal(parseTreasuryRecipientAllowlist(first + ',invalid').valid, false)
  assert.equal(parseTreasuryRecipientAllowlist(first.slice(0, -1) + '3').valid, false)
  assert.equal(parseTreasuryRecipientAllowlist(Array(101).fill(first).join(',')).valid, false)
  assert.equal(parseTreasuryRecipientAllowlist('x'.repeat(8193)).valid, false)
})

test('USDT configuration blocks missing or malformed sponsor-approved recipient destinations', () => {
  const owner = 'T' + 'A'.repeat(33)
  const base = {
    DATABASE_URL: 'postgresql://example.invalid/db',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    TREASURY_ADDRESS: owner,
    TREASURY_MAX_PAYOUT_USDT: '10',
    TREASURY_DAILY_LIMIT_USDT: '100',
    TREASURY_SPONSOR_ORGANIZATION_REFERENCE: 'authorized-sponsor-org-001',
    TREASURY_SPONSOR_AGREEMENT_REFERENCE: 'sponsor-agreement-2026-001',
    TREASURY_SPONSOR_TOTAL_BUDGET_USDT: '1000',
    SPONSOR_APPROVED_AGREEMENT_REFERENCES: 'sponsor-agreement-2026-001|authorized-sponsor-org-001|mainnet|' + owner + '|asset-grant|USDT|TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_SIGNER_MODE: 'fireblocks',
    FIREBLOCKS_API_KEY: 'synthetic-test-api-key',
    FIREBLOCKS_SECRET_KEY_PATH: '/etc/secrets/fireblocks-test.pem',
    FIREBLOCKS_VAULT_ACCOUNT_ID: '123',
    FIREBLOCKS_USDT_ASSET_ID: 'TRON_USDT',
    FIREBLOCKS_TRX_ASSET_ID: 'TRX',
  }
  assert.equal(treasuryUsdtConfiguration({
    ...base, TREASURY_ALLOWED_RECIPIENT_ADDRESSES: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
  }).configurationComplete, true)
  assert.equal(treasuryUsdtConfiguration({
    ...base, TREASURY_ALLOWED_RECIPIENT_ADDRESSES: '',
  }).configurationComplete, false)
  assert.equal(treasuryUsdtConfiguration({
    ...base, TREASURY_ALLOWED_RECIPIENT_ADDRESSES: 'TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  }).configurationComplete, false)
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

test('USDT submission requires authenticated owner plus sponsor release; native TRX remains disabled', async (t) => {
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
      throw new Error('owner identity configuration is intentionally absent in this fail-closed fixture')
    },
    fireblocksClientFactory: () => {
      providerFactoryCalls += 1
      throw new Error('Fireblocks must not be contacted before sponsor release')
    },
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/treasury`
  const usdt = await fetch(baseUrl + '/withdrawals', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://owner.example' },
    body: JSON.stringify({ recipientAddress: 'T' + 'A'.repeat(33), amountUsdt: '1' }),
  })
  assert.equal(usdt.status, 401)
  assert.deepEqual(await usdt.json(), { success: false, error: 'owner-auth-required' })
  const trx = await fetch(baseUrl + '/trx-withdrawals', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://owner.example' },
    body: JSON.stringify({ recipientAddress: 'T' + 'A'.repeat(33), amountTrx: '1' }),
  })
  assert.equal(trx.status, 503)
  assert.deepEqual(await trx.json(), {
    success: false,
    error: 'native-trx-payout-execution-disabled-in-this-build',
    submissionEnabled: false,
  })
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
    sponsor_organization_reference: 'authorized-sponsor-org-001',
    sponsor_agreement_reference: 'sponsor-agreement-2026-001',
    sponsor_agreement_budget_base_units: '1000000000',
    amount_base_units: amountBaseUnits,
  }
  const request = {
    ownerAddress: treasuryAddress,
    treasuryAddress,
    recipientAddress,
    amountBaseUnits,
    sponsorOrganizationReference: 'authorized-sponsor-org-001',
    sponsorAgreementReference: 'sponsor-agreement-2026-001',
    sponsorAgreementBudgetBaseUnits: '1000000000',
  }
  assert.equal(matchesTreasuryWithdrawalRequest(row, request), true)
  assert.equal(matchesTreasuryWithdrawalRequest(row, { ...request, recipientAddress: treasuryAddress }), false)
  assert.equal(matchesTreasuryWithdrawalRequest(row, { ...request, amountBaseUnits: '1' }), false)
  assert.equal(matchesTreasuryWithdrawalRequest(row, { ...request, ownerAddress: recipientAddress }), false)
  assert.equal(matchesTreasuryWithdrawalRequest(row, { ...request, sponsorAgreementReference: 'different-agreement' }), false)
  assert.equal(matchesTreasuryWithdrawalRequest(row, { ...request, sponsorOrganizationReference: 'different-org' }), false)
  assert.equal(matchesTreasuryWithdrawalRequest(row, { ...request, sponsorAgreementBudgetBaseUnits: '2000000000' }), false)
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
    FIREBLOCKS_READONLY_API_KEY: 'test-viewer-key',
    FIREBLOCKS_READONLY_SECRET_KEY_PATH: '/tmp/fireblocks-viewer-key.pem',
    FIREBLOCKS_READONLY_API_BASE: 'https://api.fireblocks.io',
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
    fireblocksReadOnlyClientFactory: () => ({
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
  assert.equal(payload.releaseAuthorization.authorized, false)
  assert.equal(payload.releaseAuthorization.reason, 'real-value-execution-switch-disabled')
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
  assert.equal(payload.executionBlocker, 'native-trx-payout-execution-disabled-in-this-build')
  assert.ok(payload.payoutBlockers.includes('native-trx-payout-execution-disabled-in-this-build'))
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
  assert.deepEqual(result, { terminal: false }, 'a provider terminal status alone is not independent chain evidence')
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


const RECIPIENT_APPROVAL_FIXTURES = {
  owner: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
  treasury: 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax',
  recipient: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
  sponsorSigner: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
  requestId: '2b3b6e9b-5978-4b7e-bc6c-3f40d6ab12ef',
}

test('sponsor recipient approver configuration requires independent, unique, checksum-valid TRON signers', () => {
  const { owner, treasury, sponsorSigner } = RECIPIENT_APPROVAL_FIXTURES
  assert.deepEqual(parseTreasurySponsorApproverAllowlist(sponsorSigner, {
    excludedAddresses: [owner, treasury],
  }), { valid: true, addresses: [sponsorSigner], reason: null })
  assert.equal(parseTreasurySponsorApproverAllowlist(owner, {
    excludedAddresses: [owner, treasury],
  }).reason, 'sponsor-approver-must-be-independent-of-owner-and-treasury')
  assert.equal(parseTreasurySponsorApproverAllowlist(sponsorSigner + ',' + sponsorSigner).reason,
    'sponsor-approver-allowlist-contains-duplicates')
  assert.equal(parseTreasurySponsorApproverAllowlist('not-a-tron-address').valid, false)
  assert.equal(parseTreasurySponsorApproverAllowlist('').valid, false)
})

test('sponsor-signed recipient approval message binds the exact Mainnet USDT scope and has canonical newlines', () => {
  const { owner, treasury, recipient, requestId } = RECIPIENT_APPROVAL_FIXTURES
  const message = buildTreasuryRecipientApprovalMessage({
    requestId,
    sponsorOrganizationReference: 'authorized-sponsor-org-001',
    sponsorAgreementReference: 'sponsor-agreement-2026-001',
    treasuryAddress: treasury,
    recipientAddress: recipient,
    requesterAddress: owner,
    requesterOrigin: 'https://tron-token-studio.example',
    reason: 'Approve the recipient exchange deposit address for this sponsor agreement',
    expiresAt: 1_800_000_000_000,
  })
  for (const expected of [
    'Network: TRON Mainnet',
    'Asset: USDT',
    'Token contract: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    'Sponsor organization reference: authorized-sponsor-org-001',
    'Sponsor agreement reference: sponsor-agreement-2026-001',
    `Treasury source address: ${treasury}`,
    `Approved recipient: ${recipient}`,
    `Requested by owner: ${owner}`,
    `Request ID: ${requestId}`,
    'does not authorize, sign, or execute a token transfer',
  ]) assert.ok(message.includes(expected), expected)
  assert.ok(message.includes('\n'), 'approval payload must have real newline separators')
  assert.equal(message.includes('\\n'), false, 'approval payload must not contain literal backslash-n separators')
  assert.throws(() => buildTreasuryRecipientApprovalMessage({
    requestId, sponsorOrganizationReference: 'bad ref',
    sponsorAgreementReference: 'sponsor-agreement-2026-001',
    treasuryAddress: treasury, recipientAddress: recipient, requesterAddress: owner,
    requesterOrigin: 'https://tron-token-studio.example', reason: 'approve address',
    expiresAt: 1_800_000_000_000,
  }))
})

test('sponsor recipient revocation message binds the original approved request hash', () => {
  const { treasury, recipient, requestId } = RECIPIENT_APPROVAL_FIXTURES
  const message = buildTreasuryRecipientRevocationMessage({
    requestId,
    sponsorOrganizationReference: 'authorized-sponsor-org-001',
    sponsorAgreementReference: 'sponsor-agreement-2026-001',
    treasuryAddress: treasury,
    recipientAddress: recipient,
    approvalMessageHash: 'a'.repeat(64),
    requesterOrigin: 'https://tron-token-studio.example',
  })
  assert.ok(message.includes(`Request ID: ${requestId}`))
  assert.ok(message.includes(`Recipient to revoke: ${recipient}`))
  assert.ok(message.includes(`Original approval message SHA-256: ${'a'.repeat(64)}`))
  assert.ok(message.includes('does not execute a token transfer'))
  assert.throws(() => buildTreasuryRecipientRevocationMessage({
    requestId, sponsorOrganizationReference: 'authorized-sponsor-org-001',
    sponsorAgreementReference: 'sponsor-agreement-2026-001',
    treasuryAddress: treasury, recipientAddress: recipient,
    approvalMessageHash: 'invalid', requesterOrigin: 'https://tron-token-studio.example',
  }))
})

test('sponsor recipient signature recovery accepts only a configured sponsor signer', async () => {
  const { sponsorSigner } = RECIPIENT_APPROVAL_FIXTURES
  const message = 'exact sponsor approval payload'
  const signature = '0x' + 'a'.repeat(130)
  const tronWeb = { trx: { verifyMessageV2: async (observedMessage, observedSignature) => {
    assert.equal(observedMessage, message)
    assert.equal(observedSignature, signature)
    return sponsorSigner
  } } }
  assert.equal(await recoverTreasurySponsorRecipientApprover(tronWeb, {
    message, signature, allowedSignerAddresses: [sponsorSigner],
  }), sponsorSigner)
  assert.equal(await recoverTreasurySponsorRecipientApprover(tronWeb, {
    message, signature, allowedSignerAddresses: ['TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'],
  }), null)
  assert.equal(await recoverTreasurySponsorRecipientApprover(tronWeb, {
    message, signature: 'malformed', allowedSignerAddresses: [sponsorSigner],
  }), null)
  assert.equal(await recoverTreasurySponsorRecipientApprover({
    trx: { verifyMessageV2: async () => { throw new Error('verification failed') } },
  }, { message, signature, allowedSignerAddresses: [sponsorSigner] }), null)
})

test('USDT configuration supports independently sponsor-signed destinations without a static recipient list', () => {
  const { owner, sponsorSigner } = RECIPIENT_APPROVAL_FIXTURES
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://example.invalid/db',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    TREASURY_ADDRESS: owner,
    TREASURY_MAX_PAYOUT_USDT: '10',
    TREASURY_DAILY_LIMIT_USDT: '100',
    TREASURY_SPONSOR_ORGANIZATION_REFERENCE: 'authorized-sponsor-org-001',
    TREASURY_SPONSOR_AGREEMENT_REFERENCE: 'sponsor-agreement-2026-001',
    TREASURY_SPONSOR_TOTAL_BUDGET_USDT: '1000',
    TREASURY_SPONSOR_APPROVER_ADDRESSES: sponsorSigner,
    SPONSOR_APPROVED_AGREEMENT_REFERENCES: 'sponsor-agreement-2026-001|authorized-sponsor-org-001|mainnet|' + owner + '|asset-grant|USDT|TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_WITHDRAWALS_ENABLED: 'true',
    TREASURY_SIGNER_MODE: 'fireblocks',
    FIREBLOCKS_API_KEY: 'synthetic-test-api-key',
    FIREBLOCKS_SECRET_KEY_PATH: '/etc/secrets/fireblocks-test.pem',
    FIREBLOCKS_VAULT_ACCOUNT_ID: '123',
    FIREBLOCKS_USDT_ASSET_ID: 'TRON_USDT',
    FIREBLOCKS_TRX_ASSET_ID: 'TRX',
  }
  const config = treasuryUsdtConfiguration(base)
  assert.equal(config.configurationComplete, true)
  assert.equal(config.recipientAllowlistValid, false)
  assert.equal(config.sponsorApproverAddressesValid, true)
  assert.equal(config.sponsorApproverCount, 1)
  assert.equal(config.recipientApprovalMode, 'sponsor-signed')
  assert.ok(!config.missing.some((item) => item.includes('TREASURY_ALLOWED_RECIPIENT_ADDRESSES')))
  const ownerCannotSelfApprove = treasuryUsdtConfiguration({
    ...base,
    TREASURY_SPONSOR_APPROVER_ADDRESSES: owner,
  })
  assert.equal(ownerCannotSelfApprove.configurationComplete, false)
  assert.equal(ownerCannotSelfApprove.sponsorApproverAddressesValid, false)
})

test('stored sponsor recipient approval is accepted only when its canonical hash and recovered signer match', async () => {
  const { owner, treasury, recipient, sponsorSigner, requestId } = RECIPIENT_APPROVAL_FIXTURES
  const approvalRow = {
    request_id: requestId,
    sponsor_organization_reference: 'authorized-sponsor-org-001',
    sponsor_agreement_reference: 'sponsor-agreement-2026-001',
    treasury_address: treasury,
    recipient_address: recipient,
    token_contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    requester_owner_address: owner,
    requester_origin: 'https://tron-token-studio.example',
    request_reason: 'Approve the recipient exchange deposit address for this sponsor agreement',
    approval_expires_at: new Date(1_800_000_000_000),
    status: 'approved',
    approver_address: sponsorSigner,
    approval_signature: '0x' + 'b'.repeat(130),
  }
  const message = buildTreasuryRecipientApprovalMessage({
    requestId,
    sponsorOrganizationReference: approvalRow.sponsor_organization_reference,
    sponsorAgreementReference: approvalRow.sponsor_agreement_reference,
    treasuryAddress: treasury,
    recipientAddress: recipient,
    requesterAddress: owner,
    requesterOrigin: approvalRow.requester_origin,
    reason: approvalRow.request_reason,
    expiresAt: approvalRow.approval_expires_at.getTime(),
  })
  approvalRow.approval_message_hash = createHash('sha256').update(message, 'utf8').digest('hex')
  const tronWeb = { trx: { verifyMessageV2: async () => sponsorSigner } }
  assert.equal(await verifyTreasurySponsorRecipientApproval(tronWeb, approvalRow, {
    allowedSignerAddresses: [sponsorSigner],
  }), true)
  assert.equal(await verifyTreasurySponsorRecipientApproval(tronWeb, approvalRow, {
    allowedSignerAddresses: ['TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'],
  }), false)
  assert.equal(await verifyTreasurySponsorRecipientApproval(tronWeb, {
    ...approvalRow,
    approval_message_hash: '0'.repeat(64),
  }, { allowedSignerAddresses: [sponsorSigner] }), false)
  assert.equal(await verifyTreasurySponsorRecipientApproval(tronWeb, {
    ...approvalRow,
    status: 'revoked',
  }, { allowedSignerAddresses: [sponsorSigner] }), false)
})


test('Mainnet USDT release message binds exact sponsor, vault, limits, asset IDs and recipient policy', () => {
  const now = 1_700_000_000_000
  const { owner, sponsorSigner } = RECIPIENT_APPROVAL_FIXTURES
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://example.invalid/db',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    TREASURY_ADDRESS: owner,
    TREASURY_MAX_PAYOUT_USDT: '10',
    TREASURY_DAILY_LIMIT_USDT: '100',
    TREASURY_SPONSOR_ORGANIZATION_REFERENCE: 'authorized-sponsor-org-001',
    TREASURY_SPONSOR_AGREEMENT_REFERENCE: 'sponsor-agreement-2026-001',
    TREASURY_SPONSOR_TOTAL_BUDGET_USDT: '1000',
    TREASURY_SPONSOR_APPROVER_ADDRESSES: sponsorSigner,
    SPONSOR_APPROVED_AGREEMENT_REFERENCES: 'sponsor-agreement-2026-001|authorized-sponsor-org-001|mainnet|' + owner + '|asset-grant|USDT|TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_WITHDRAWALS_ENABLED: 'true',
    TREASURY_SIGNER_MODE: 'fireblocks',
    FIREBLOCKS_API_KEY: 'synthetic-test-api-key',
    FIREBLOCKS_SECRET_KEY_PATH: '/etc/secrets/fireblocks-test.pem',
    FIREBLOCKS_VAULT_ACCOUNT_ID: '123',
    FIREBLOCKS_USDT_ASSET_ID: 'TRON_USDT',
    FIREBLOCKS_TRX_ASSET_ID: 'TRX',
    TREASURY_REAL_VALUE_EXECUTION_ENABLED: 'true',
    TREASURY_REAL_VALUE_RELEASE_REFERENCE: 'mainnet-release-test-001',
    TREASURY_REAL_VALUE_RELEASE_EXPIRES_AT: String(now + 7 * 24 * 60 * 60 * 1000),
  }
  const message = buildTreasuryRealValueReleaseMessage(base, { now })
  for (const expected of [
    'authorize the platform to submit real Mainnet USDT withdrawals',
    'Network: TRON Mainnet',
    'Asset: genuine Tether USDT',
    'Token contract: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    'Sponsor organization reference: authorized-sponsor-org-001',
    'Sponsor agreement reference: sponsor-agreement-2026-001',
    'Fireblocks vault account ID: 123',
    'Fireblocks USDT asset ID: TRON_USDT',
    'Fireblocks native TRX asset ID: TRX',
    'Maximum single payout USDT: 10',
    'Daily USDT payout limit: 100',
    'Total sponsor USDT principal commitment: 1000',
    'Release reference: mainnet-release-test-001',
  ]) assert.ok(message.includes(expected), expected)
  assert.ok(message.includes('\n'), 'signed release payload uses canonical newlines')
  const changedLimits = buildTreasuryRealValueReleaseMessage({
    ...base,
    TREASURY_MAX_PAYOUT_USDT: '11',
  }, { now })
  assert.notEqual(changedLimits, message, 'changing a cap invalidates the prior sponsor signature')
  assert.throws(() => buildTreasuryRealValueReleaseMessage({
    ...base,
    TREASURY_REAL_VALUE_RELEASE_EXPIRES_AT: String(now + 31 * 24 * 60 * 60 * 1000),
  }, { now }), /no more than 30 days/)
})

test('real-value release authorization accepts only an approved sponsor signer over the current scope', async () => {
  const now = 1_700_000_000_000
  const { owner, sponsorSigner } = RECIPIENT_APPROVAL_FIXTURES
  const signature = '0x' + 'c'.repeat(130)
  const env = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://example.invalid/db',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    TREASURY_ADDRESS: owner,
    TREASURY_MAX_PAYOUT_USDT: '10',
    TREASURY_DAILY_LIMIT_USDT: '100',
    TREASURY_SPONSOR_ORGANIZATION_REFERENCE: 'authorized-sponsor-org-001',
    TREASURY_SPONSOR_AGREEMENT_REFERENCE: 'sponsor-agreement-2026-001',
    TREASURY_SPONSOR_TOTAL_BUDGET_USDT: '1000',
    TREASURY_SPONSOR_APPROVER_ADDRESSES: sponsorSigner,
    SPONSOR_APPROVED_AGREEMENT_REFERENCES: 'sponsor-agreement-2026-001|authorized-sponsor-org-001|mainnet|' + owner + '|asset-grant|USDT|TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_WITHDRAWALS_ENABLED: 'true',
    TREASURY_SIGNER_MODE: 'fireblocks',
    FIREBLOCKS_API_KEY: 'synthetic-test-api-key',
    FIREBLOCKS_SECRET_KEY_PATH: '/etc/secrets/fireblocks-test.pem',
    FIREBLOCKS_VAULT_ACCOUNT_ID: '123',
    FIREBLOCKS_USDT_ASSET_ID: 'TRON_USDT',
    FIREBLOCKS_TRX_ASSET_ID: 'TRX',
    TREASURY_REAL_VALUE_EXECUTION_ENABLED: 'true',
    TREASURY_REAL_VALUE_RELEASE_REFERENCE: 'mainnet-release-test-002',
    TREASURY_REAL_VALUE_RELEASE_EXPIRES_AT: String(now + 7 * 24 * 60 * 60 * 1000),
  }
  const expectedMessage = buildTreasuryRealValueReleaseMessage(env, { now })
  const tronWeb = { trx: { verifyMessageV2: async (message, observedSignature) => {
    assert.equal(observedSignature, signature)
    return message === expectedMessage ? sponsorSigner : 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
  } } }
  const approved = await verifyTreasuryRealValueReleaseAuthorization(tronWeb, env, signature, { now })
  assert.equal(approved.authorized, true)
  assert.equal(approved.signerAddress, sponsorSigner)
  assert.equal(approved.releaseReference, 'mainnet-release-test-002')
  assert.equal(approved.messageHash, createHash('sha256').update(expectedMessage, 'utf8').digest('hex'))
  const wrongSigner = await verifyTreasuryRealValueReleaseAuthorization({
    trx: { verifyMessageV2: async () => 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2' },
  }, env, signature, { now })
  assert.equal(wrongSigner.authorized, false)
  const switchedOff = await verifyTreasuryRealValueReleaseAuthorization(tronWeb, {
    ...env,
    TREASURY_REAL_VALUE_EXECUTION_ENABLED: 'false',
  }, signature, { now })
  assert.equal(switchedOff.authorized, false)
  assert.equal(switchedOff.reason, 'real-value-execution-switch-disabled')
  const changedScope = await verifyTreasuryRealValueReleaseAuthorization(tronWeb, {
    ...env,
    TREASURY_DAILY_LIMIT_USDT: '90',
  }, signature, { now })
  assert.equal(changedScope.authorized, false)
  const expired = await verifyTreasuryRealValueReleaseAuthorization(tronWeb, env, signature, {
    now: now + 8 * 24 * 60 * 60 * 1000,
  })
  assert.equal(expired.authorized, false)
})

test('release revocation message binds release reference and exact approved message hash', () => {
  const message = buildTreasuryRealValueReleaseRevocationMessage({
    releaseReference: 'mainnet-release-test-003',
    messageHash: 'd'.repeat(64),
    sponsorOrganizationReference: 'authorized-sponsor-org-001',
    sponsorAgreementReference: 'sponsor-agreement-2026-001',
    treasuryAddress: RECIPIENT_APPROVAL_FIXTURES.owner,
    requesterOrigin: 'https://tron-token-studio.example',
  })
  assert.ok(message.includes('Release reference: mainnet-release-test-003'))
  assert.ok(message.includes('Original release message SHA-256: ' + 'd'.repeat(64)))
  assert.ok(message.includes('does not cancel an already reserved or submitted Fireblocks transaction'))
  assert.ok(message.includes('\n'))
  assert.throws(() => buildTreasuryRealValueReleaseRevocationMessage({
    releaseReference: 'invalid',
    messageHash: 'd'.repeat(64),
    sponsorOrganizationReference: 'authorized-sponsor-org-001',
    sponsorAgreementReference: 'sponsor-agreement-2026-001',
    treasuryAddress: RECIPIENT_APPROVAL_FIXTURES.owner,
    requesterOrigin: 'https://tron-token-studio.example',
  }))
})
