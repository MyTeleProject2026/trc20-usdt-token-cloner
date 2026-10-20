import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const sponsorship = await readFile(new URL('../server/sponsorship-status.mjs', import.meta.url), 'utf8')

test('UI explicitly separates Shasta test assets from mainnet funds', () => {
  assert.match(app, /Shasta Testnet — test assets only/)
  assert.match(app, /cannot become mainnet USDT/)
  assert.match(app, /TRON Mainnet — real assets and network costs/)
  assert.match(app, /Fee sponsorship is currently not integrated/)
})

test('sponsorship cannot be represented as enabled without a verified integration', () => {
  assert.match(sponsorship, /enabled: false/)
  assert.match(sponsorship, /mainnetEnabled: false/)
  assert.match(sponsorship, /canSubmitSponsoredTransfer: false/)
  assert.match(sponsorship, /not-integrated/)
})
