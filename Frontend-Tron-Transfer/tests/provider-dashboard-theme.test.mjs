import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const app=await readFile(new URL('../src/App.jsx',import.meta.url),'utf8')
const css=await readFile(new URL('../src/styles.css',import.meta.url),'utf8')

test('recipient inspection and payout request use Mainnet API paths',()=>{
  assert.match(app,/api\\/tron-transfer\\/recipient/)
  assert.match(app,/network:'mainnet'/)
  assert.match(app,/api\\/tron-transfer\\/sponsor-requests/)
  assert.doesNotMatch(app,/api\\/tron-transfer\\/broadcast|wallet\\/broadcasttransaction/)
})

test('recipient monitor defaults to the public monitored address and official Tether contract',()=>{
  assert.match(app,/TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp/)
  assert.match(app,/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t/)
  assert.match(app,/TRON Mainnet/)
})

test('sponsor dashboard exposes live Fincra and independent chain verification only',()=>{
  assert.match(app,/canSubmitLivePayout/)
  assert.match(app,/fincra-payout/)
  assert.match(app,/fincra-status/)
  assert.match(app,/verify-recipient-transfer/)
  assert.doesNotMatch(app,/canSubmitSandboxPayout|Sandbox payout/)
})

test('requester identity and payout owner sessions are separate',()=>{
  assert.match(app,/signMessageV2/)
  assert.match(app,/api\\/auth\\/tron\\/challenge/)
  assert.match(app,/api\\/auth\\/tron\\/verify/)
  assert.match(app,/REQUESTER_SESSION_KEY/)
  assert.match(app,/OWNER_SESSION_KEY/)
})

test('forest emerald glass theme and responsive breakpoints remain',()=>{
  assert.match(css,/--bg: #07100d/)
  assert.match(css,/--mint-bright: #65dfa1/)
  assert.match(css,/backdrop-filter: blur/)
  assert.match(css,/@media \\(max-width: 820px\\)/)
  assert.match(css,/@media \\(max-width: 560px\\)/)
  assert.match(css,/\\.sponsor-request-layout/)
})
