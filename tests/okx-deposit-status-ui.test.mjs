import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const page = await readFile(new URL('../src/OkxDepositStatus.tsx', import.meta.url), 'utf8')
const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const workflow = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')

test('OKX read-only history page is intentionally excluded from the owner control navigation', () => {
  assert.match(main, /import OwnerControlApp from '\.\/OwnerControlApp'/)
  assert.doesNotMatch(main, /OkxDepositStatus|okx-deposit-status/)
  assert.doesNotMatch(workflow, /href="#\/okx-deposit-status"/)
})

test('page makes a no-cache authenticated GET and never persists the access token', () => {
  assert.match(page, /API_BASE \+ '\/api\/okx\/deposit-status\?'/)
  assert.match(page, /Authorization: 'Bearer ' \+ accessToken\.trim\(\)/)
  assert.match(page, /cache: 'no-store'/)
  assert.match(page, /credentials: 'omit'/)
  assert.doesNotMatch(page, /localStorage|sessionStorage/)
  assert.doesNotMatch(page, /VITE_OKX_API_(KEY|SECRET|PASSPHRASE)/)
})

test('page displays only returned deposit records and prominently states scope', () => {
  assert.match(page, /setRecords\(payload\.deposits\)/)
  assert.match(page, /OKX account configured on the backend/)
  assert.match(page, /does not inspect another recipient.{1,8}OKX account/)
  assert.match(page, /This does not prove a particular transfer failed/)
  assert.match(page, /No balances are fabricated/)
  assert.match(page, /Successful · OKX reports withdrawable/)
  assert.match(page, /Credited · withdrawal not yet enabled/)
  assert.match(page, /OKX deposit ID/)
  assert.match(page, /Actual blockchain-confirmed amount/)
  assert.doesNotMatch(page, /availableBalance|incrementExchangeBalance|fabricatedBalance/i)
})

test('page has no signing or transaction submission path', () => {
  // Match executable signing/submission identifiers and API URL construction,
  // not explanatory prose such as "no transfer is started".
  assert.doesNotMatch(page, /\b(?:sendRawTransaction|transactionBuilder|signMessageV2)\b/i)
  assert.doesNotMatch(page, /(?:fetch|axios\.(?:get|post|put|delete))\s*\([^)]*\/(?:withdrawal|transfer)(?:[/?'"]|\b)/i)
})
