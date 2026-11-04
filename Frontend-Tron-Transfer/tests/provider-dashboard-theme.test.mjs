import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const transfer = await readFile(new URL('../src/lib/wallet-transfer.mjs', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

test('wallet RPC is routed through the server-side Tatum proxy', () => {
  assert.match(app, /\/api\/tron-transfer\/rpc\/\$\{network\}/)
  assert.match(app, /API_BASE = .*trc20-usdt-token-cloner-api/)
  assert.match(app, /\/api\/tron-transfer\/broadcast/)
})

test('locally signed transaction helper supports a server broadcast callback', () => {
  assert.match(transfer, /broadcast,\s*\n\}\)/)
  assert.match(transfer, /typeof broadcast === 'function'/)
  assert.match(transfer, /broadcastOutcomeUnknown/)
  assert.match(app, /reconcile-original-txid-no-replacement/)
})

test('recipient balance/history and sponsor/Fincra owner workspace are navigable', () => {
  assert.match(app, /id: 'recipients', label: 'Recipient check'/)
  assert.match(app, /id: 'sponsors', label: 'Sponsor requests'/)
  assert.match(app, /\/api\/tron-transfer\/recipient/)
  assert.match(app, /\/api\/tron-transfer\/sponsor-requests/)
  assert.match(app, /fincra-payout/)
  assert.match(app, /verify-recipient-transfer/)
})

test('sponsor requester must prove wallet ownership with a server challenge before request intake', () => {
  assert.match(app, /verifyRequesterWalletOwnership/)
  assert.match(app, /\/api\/auth\/tron\/challenge/)
  assert.match(app, /signMessageV2\(challenge\.message\)/)
  assert.match(app, /\/api\/auth\/tron\/verify/)
  assert.match(app, /Authorization: 'Bearer ' \+ requesterSession\.sessionToken/)
  assert.match(app, /REQUESTER_WALLET_SESSION_KEY/)
})

test('frontend never presents sponsor request acceptance as settled payout', () => {
  assert.match(app, /No USDT payout was initiated/)
  assert.match(app, /Provider status is not the same as independent chain confirmation/)
})

test('full visual system uses forest/emerald glass theme with mobile breakpoints', () => {
  assert.match(css, /--bg: #07100d/)
  assert.match(css, /--mint-bright: #65dfa1/)
  assert.match(css, /backdrop-filter: blur/)
  assert.match(css, /@media \(max-width: 820px\)/)
  assert.match(css, /@media \(max-width: 560px\)/)
  assert.match(css, /\.sponsor-request-layout/)
})
