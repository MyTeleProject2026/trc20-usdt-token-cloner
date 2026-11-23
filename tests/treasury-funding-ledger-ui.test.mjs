import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('active Owner Admin app uses the integrated local Sponsor workspace instead of legacy TronLink payout pages', async () => {
  const app = await readFile(new URL('../Frontend-Tron-Transfer/src/App.jsx', import.meta.url), 'utf8')
  const sponsor = await readFile(new URL('../Frontend-Tron-Transfer/src/SponsorWalletManager.jsx', import.meta.url), 'utf8')
  assert.ok(app.includes("import SponsorWalletManager from './SponsorWalletManager.jsx'"))
  assert.ok(app.includes('<SponsorWalletManager'))
  assert.doesNotMatch(app, /SponsorDirectPayouts|SponsorOrganizationOnboarding|SponsorPortal/)
  assert.ok(sponsor.includes('signSponsorTransaction(wallet, unsignedTransaction)'))
  assert.ok(sponsor.includes('/api/sponsor/operations/prepare'))
  assert.ok(sponsor.includes('/api/sponsor/operations/submit'))
  assert.ok(sponsor.includes('Local Sponsor-vault signing is implemented.'))
})
