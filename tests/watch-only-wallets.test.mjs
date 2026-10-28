import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8')

test('watch-only component remains read-only but is not exposed by the owner-only app', async () => {
  const source = await read('src/WatchOnlyWallets.tsx')
  const entry = await read('src/main.tsx')
  assert.match(entry, /import OwnerControlApp from '\.\/OwnerControlApp'/)
  assert.doesNotMatch(entry, /WatchOnlyWallets|watch-wallets/)
  assert.match(source, /getBalance\(address\)/)
  assert.match(source, /balanceOf\(address\)\.call\(\)/)
  assert.match(source, /OFFICIAL_MAINNET_USDT/)
  assert.match(source, /A public address does not contain its private key/)
  assert.match(source, /Watch-only means read-only/)
  assert.doesNotMatch(source, /sendRawTransaction|\.trx\.sign\(|signMessageV2|decryptWalletPrivateKey|createAccount\(|getPrivateKeyFromAddress/)
})
