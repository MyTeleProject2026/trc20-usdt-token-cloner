import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const custody = await readFile(new URL('../server/sponsor-document-custody-v2.mjs', import.meta.url), 'utf8')
const receiptVerifier = await readFile(new URL('../server/sponsor-vault-receipt-v2.mjs', import.meta.url), 'utf8')
const fundingLedger = await readFile(new URL('../server/routes/owner-treasury-funding-ledger.mjs', import.meta.url), 'utf8')
const withdrawals = await readFile(new URL('../server/routes/treasury-withdrawals.mjs', import.meta.url), 'utf8')
const audit = await readFile(new URL('../docs/PRIVATE_TREASURY_VAULT_STAGE7C_AUDIT.md', import.meta.url), 'utf8')

test('Stage 7C document-vault receipts cannot be treated as treasury funding or payout authority', () => {
  assert.match(custody, /\/v2\/objects\//)
  assert.match(receiptVerifier, /tron-transfer\.private-vault-receipt\.v2/)
  assert.match(receiptVerifier, /payoutAuthorized: false/)
  assert.doesNotMatch(fundingLedger, /verifyPrivateVaultReceiptV2|sponsor-vault-receipt-v2|vaultReceiptV2Verified/)
  assert.match(fundingLedger, /onChainBalanceRead === true/)
  assert.match(fundingLedger, /verifySponsorDirectMainnetTransfer/)
  assert.match(audit, /evidence-file custody/)
  assert.match(audit, /not a substitute for this contract/)
})

test('owner treasury funding ledger remains Mainnet-chain-evidence based and does not credit vault object receipts', () => {
  assert.match(fundingLedger, /network TEXT NOT NULL CHECK \(network = 'mainnet'\)/)
  assert.match(fundingLedger, /token_contract TEXT NOT NULL CHECK \(token_contract =/)
  assert.match(fundingLedger, /UNIQUE \(transaction_hash, log_index\)/)
  assert.match(fundingLedger, /payoutSubmissionEnabled: false/)
  assert.doesNotMatch(fundingLedger, /vaultReceipt|privateVaultBalance|custodyReceiptBalance/)
})

test('current reservation coupling to individual sponsor records is explicitly detected as an architecture gap', () => {
  assert.match(fundingLedger, /FROM '\s*\+\s*SCHEMA\s*\+\s*'\.sponsor_direct_payouts/)
  assert.match(fundingLedger, /sponsor_address=\$1/)
  assert.match(audit, /individual-sponsor lifecycle table/)
  assert.match(audit, /provider-independent treasury reservation ledger/)
})

test('Fireblocks treasury withdrawal execution remains hard-disabled and is not a private-vault adapter', () => {
  assert.match(withdrawals, /const REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true/)
  assert.match(withdrawals, /createFireblocksClient/)
  assert.match(withdrawals, /real-value-payout-execution-disabled-in-this-build/)
  assert.match(audit, /Fireblocks excluded/)
})

test('the 1,000 USDT minimum is retained as a required future withdrawal-intent invariant', () => {
  assert.match(audit, /1,000 USDT/)
  assert.match(audit, /1,000,000,000 six-decimal base units/)
  assert.match(audit, /must be enforced in the future provider-independent withdrawal-intent boundary/)
  assert.match(withdrawals, /REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true/)
})
