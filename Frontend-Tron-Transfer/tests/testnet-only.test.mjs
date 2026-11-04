import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const app=await readFile(new URL('../src/App.jsx',import.meta.url),'utf8')
const html=await readFile(new URL('../index.html',import.meta.url),'utf8')
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))

test('production frontend is Mainnet-only and defaults to the monitored wallet',()=>{
  assert.match(app,/MAINNET_MONITORED_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'/)
  assert.match(app,/network:'mainnet'/)
  assert.match(app,/tokenContract:MAINNET_USDT/)
  assert.doesNotMatch(app,/Nile Testnet|Shasta Testnet|tron-nile|tron-shasta|testnet-wallet/i)
  assert.match(app,/MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'/)
})

test('only official USDT is represented as the payout asset',()=>{
  assert.match(app,/USDT amount/)
  assert.match(app,/Official Tether USDT TRC20/)
  assert.doesNotMatch(app,/addToken|tokenInput|custom token contract/i)
})

test('no direct wallet send or simulator path is present in the frontend',()=>{
  assert.doesNotMatch(app,/buildSignAndBroadcastTransfer|sendRawTransaction|testnet simulator|Send testnet assets/)
  assert.match(app,/Mainnet-only sponsored withdrawals/)
  assert.match(app,/fincra-payout/)
})

test('sponsor request uses off-chain Mainnet wallet ownership verification',()=>{
  assert.match(app,/signMessageV2/)
  assert.match(app,/does not require TRX/)
  assert.match(app,/api\\/tron-transfer\\/sponsor-requests/)
  assert.match(app,/requesterSession\\.sessionToken/)
})

test('production metadata and frontend test command are configured',()=>{
  assert.match(html,/TRON Mainnet USDT TRC20/)
  assert.match(html,/Tron Transfer · Mainnet USDT Payouts/)
  assert.equal(pkg.scripts.build,'vite build')
  assert.equal(pkg.scripts.test,'node --test tests/*.test.mjs')
})
