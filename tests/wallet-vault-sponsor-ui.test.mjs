import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8')

test('Mainnet owner assets include official USDT by default and use backend chain-read endpoints', async () => {
  const vault = await read('src/WalletVault.tsx')
  assert.match(vault, /const \[network, setNetwork\] = useState<NetworkId>\('mainnet'\)/)
  assert.match(vault, /const defaults = network === 'mainnet' \? \[OFFICIAL_MAINNET_USDT\] : \[\]/)
  assert.ok(vault.includes("API_BASE + '/api/tron/native-balance?network='"))
  assert.ok(vault.includes("API_BASE + '/api/tron/inspect-token?network='"))
  assert.ok(vault.includes('portfolio?.trxError'))
  assert.ok(vault.includes('token.error'))
})

test('Treasury navigation mounts direct sponsor requests inside the unlocked owner wallet', async () => {
  const vault = await read('src/WalletVault.tsx')
  const sponsor = await read('src/DirectSponsorPayouts.tsx')
  assert.ok(vault.includes("setActivePanel('treasury')"))
  assert.ok(vault.includes('<DirectSponsorPayouts'))
  assert.ok(vault.includes('walletAddress={unlocked.record.address}'))
  assert.ok(vault.includes('privateKey={unlocked.privateKey}'))
  assert.ok(!vault.includes('Fireblocks treasury setup'))
  assert.ok(sponsor.includes('/api/tron/sponsorship/mainnet-direct/requests'))
  assert.ok(sponsor.includes('/api/tron/sponsorship/mainnet-direct/readiness?refresh=1'))
  assert.ok(sponsor.includes('signer.trx.signMessageV2'))
  assert.ok(sponsor.includes('No USDT was reserved, signed or broadcast.'))
})

test('saved sponsor request is checked before the component creates another idempotency key', async () => {
  const sponsor = await read('src/DirectSponsorPayouts.tsx')
  assert.ok(sponsor.includes('A saved idempotency key may outlive the current component state.'))
  assert.ok(sponsor.includes("if (requestKey && !requestRecord)"))
  assert.ok(sponsor.includes('existing.response.status !== 404'))
  assert.ok(sponsor.includes('No new request was submitted.'))
})

test('saved Mainnet sponsor request reference can be copied for later status lookup', async () => {
  const sponsor = await read('src/DirectSponsorPayouts.tsx')
  assert.ok(sponsor.includes('Copy reference'))
  assert.ok(sponsor.includes('navigator.clipboard.writeText(requestKey)'))
  assert.ok(sponsor.includes('Check saved request status'))
  assert.ok(sponsor.includes('Saved request reference copied.'))
})

test('local send preview uses server-read balances and has no Mainnet broadcast path', async () => {
  const vault = await read('src/WalletVault.tsx')
  assert.ok(vault.includes("API_BASE + '/api/tron/native-balance?network='"))
  assert.ok(vault.includes('evidence.balanceBaseUnits'))
  assert.ok(vault.includes('Transaction signing and broadcast are disabled in this build.'))
  assert.ok(!vault.includes('assertOwnerMainnetTransferAccess'))
})
