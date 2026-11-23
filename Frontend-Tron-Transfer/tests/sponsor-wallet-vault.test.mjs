import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createSponsorTronWeb } from '../src/sponsor-wallet-vault.mjs'

test('Sponsor browser RPC client is read-only and has no imported signing identity', async () => {
  const client = createSponsorTronWeb()
  assert.equal(client.fullNode.host, 'https://api.trongrid.io')
  assert.equal(client.defaultAddress?.base58 || '', '')
  assert.equal(client.defaultAddress?.hex || '', '')
  const source = await readFile(new URL('../src/sponsor-wallet-vault.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /privateKey|mnemonic|keystore|localStorage|subtle\.encrypt|subtle\.decrypt/)
})
