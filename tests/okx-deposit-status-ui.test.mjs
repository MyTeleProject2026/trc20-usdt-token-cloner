import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const page = await readFile(new URL('../src/OkxDepositStatus.tsx', import.meta.url), 'utf8')
const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const workflow = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')

test('OKX history page is routable and linked from the workspace', () => {
  assert.match(main, /import OkxDepositStatus from '\.\/OkxDepositStatus\.tsx'/)
  assert.match(main, /route === '#\/okx-deposit-status'/)
  assert.match(main, /isOkxDepositStatus\s*\?\s*<OkxDepositStatus\s*\/>/)
  assert.match(main, /isOkxDepositStatus\s*\?\s*<OkxDepositStatus\s*\/>\s*:\s*<AuthGate>/)
  assert.match(workflow, /href="#\/okx-deposit-status">OKX deposit records/)
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
  assert.match(page, /does not inspect another recipient.{1,2}OKX account/)
  assert.match(page, /This does not prove a particular transfer failed/)
  assert.match(page, /No balances are fabricated/)
  assert.match(page, /Successful · OKX reports withdrawable/)
  assert.match(page, /Credited · withdrawal not yet enabled/)
  assert.match(page, /OKX deposit ID/)
  assert.match(page, /Actual blockchain-confirmed amount/)
  assert.doesNotMatch(page, /availableBalance|incrementExchangeBalance|fabricatedBalance/i)
})

test('page has no signing or transaction submission path', () => {
  assert.doesNotMatch(page, /sendRawTransaction|transactionBuilder|signMessageV2|\/withdrawal|\/transfer\b/i)
})
