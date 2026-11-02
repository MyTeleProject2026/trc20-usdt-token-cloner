import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8')

test('owner console visibly separates the 100,000 USDT planning target from real funded capacity', async () => {
  const vault = await read('src/WalletVault.tsx')
  assert.match(vault, /Requested sponsor funding target · planning only/)
  assert.match(vault, /<strong>100,000 USDT<\/strong>/)
  assert.match(vault, /Verified TRON Mainnet USDT balance/)
  assert.match(vault, /Fireblocks available USDT/)
  assert.match(vault, /Outstanding USDT reservations/)
  assert.match(vault, /Verified funds after reservations/)
  assert.match(vault, /Remaining sponsor commitment/)
  assert.match(vault, /Remaining daily payout allowance/)
  assert.match(vault, /Funding and limit capacity estimate · not payout readiness/)
  assert.match(vault, /Fee reserve, organization\/recipient policy, Fireblocks approvals and the source release lock are separate gates/)
  assert.match(vault, /Currently withdrawable now/)
  assert.match(vault, /currentlyWithdrawableBaseUnits/)
  assert.match(vault, /import ThirdPartyFundingPanel from '\.\/ThirdPartyFundingPanel'/)
  assert.match(vault, /<ThirdPartyFundingPanel[\\s\\S]*sessionToken=\\{ownerSessionToken\\}/)
  assert.match(vault, /Verified third-party sponsor USDT principal/)
  assert.match(vault, /Remaining verified sponsor principal after withdrawals/)
  assert.match(vault, /serverTreasuryReadiness\?\.thirdPartyFunding\?\.ledgerReady === true/)
})

test('backend-managed settings refresh automatically and manually without asking for browser credentials', async () => {
  const vault = await read('src/WalletVault.tsx')
  assert.match(vault, /setInterval\(refreshWhenVisible, 30_000\)/)
  assert.match(vault, /window\.addEventListener\('focus', refreshWhenVisible\)/)
  assert.match(vault, /document\.addEventListener\('visibilitychange', refreshWhenVisible\)/)
  assert.match(vault, /refreshBackendTreasuryConfigurationNow/)
  assert.match(vault, /Refresh backend configuration now/)
  assert.match(vault, /setOwnerSessionToken\(token\)/)
  assert.doesNotMatch(vault, /copyFireblocksEnvTemplate|Copy placeholder-only environment template/)
  assert.doesNotMatch(vault, /FIREBLOCKS_API_KEY=/)
  assert.doesNotMatch(vault, /FIREBLOCKS_SECRET_KEY_PATH=/)
})

test('the UI does not label planning target or estimated capacity as permission to broadcast', async () => {
  const vault = await read('src/WalletVault.tsx')
  const server = await read('server/routes/treasury-withdrawals.mjs')
  assert.match(vault, /A requested target, not a sponsor commitment, token balance or available asset/)
  assert.match(vault, /source-build real-value execution lock remains closed/)
  assert.match(server, /const REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true/)
  assert.match(server, /payoutExecution\.executionEnabled && sponsorPayoutCapacity/)
  assert.match(server, /currentlyWithdrawableBaseUnits/)
})
