import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8')

test('watch-only monitor source is safe but is not exposed as a screen in the owner-wallet installer', async () => {
  const source = await read('src/WatchOnlyWallets.tsx')
  const entry = await read('src/main.tsx')
  assert.doesNotMatch(entry, /WatchOnlyWallets|#\/watch-wallets/)
  assert.match(source, /getBalance\(address\)/)
  assert.match(source, /balanceOf\(address\)\.call\(\)/)
  assert.match(source, /OFFICIAL_MAINNET_USDT/)
  assert.match(source, /A public address does not contain its private key/)
  assert.match(source, /Watch-only means read-only/)
  assert.doesNotMatch(source, /sendRawTransaction|\.trx\.sign\(|signMessageV2|decryptWalletPrivateKey|createAccount\(|getPrivateKeyFromAddress/)
})
