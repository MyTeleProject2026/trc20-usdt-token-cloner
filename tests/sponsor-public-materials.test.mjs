import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const portal = await readFile(new URL('../Frontend-Tron-Transfer/src/SponsorPortal.jsx', import.meta.url), 'utf8')
const brief = await readFile(new URL('../docs/SPONSOR_BRIEF.md', import.meta.url), 'utf8')
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')

test('public sponsor portal explains sponsor custody, target capacity and non-production status', () => {
  assert.match(portal, /NO DEPOSIT TO THE PROJECT/)
  assert.match(portal, /\$5,000–\$10,000 equivalent/)
  assert.match(portal, /not a request to deposit or transfer funds to the project operator/i)
  assert.match(portal, /signs every exact payout in TronLink/i)
  assert.match(portal, /not merged or verified as deployed to production/i)
  assert.match(portal, /no individual sponsor is currently confirmed approved and funded/i)
  assert.match(portal, /never share private keys, seed phrases, passwords, OTPs/i)
  assert.match(portal, /SPONSOR_BRIEF\.md/)
})

test('sponsor brief distinguishes development support from payout capacity and never promises returns', () => {
  assert.match(brief, /sponsor-controlled capacity/i)
  assert.match(brief, /not a request to send \$5,000–\$10,000 to the project owner/i)
  assert.match(brief, /every exact payout separately/i)
  assert.match(brief, /No return, interest, reimbursement, profit share or repayment is promised/i)
  assert.match(brief, /No individual sponsor is confirmed approved and funded/i)
  assert.match(brief, /exchange credits its internal deposit balance/i)
  assert.match(brief, /actual legal contracting party and applicant's country of legal residence/i)
})

test('repository landing page links the sponsor brief and accurately labels the draft release', () => {
  assert.match(readme, /\[Read the individual sponsor brief\]\(docs\/SPONSOR_BRIEF\.md\)/)
  assert.match(readme, /not merged or verified as deployed to production/i)
  assert.match(readme, /No individual sponsor is currently verified as approved and funded/i)
  assert.match(readme, /$5,000–$10,000 equivalent in sponsor-controlled/i)
})
