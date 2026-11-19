import test from 'node:test'
import assert from 'node:assert/strict'
import { TronWeb } from 'tronweb'
import { Wallet } from 'ethers'
import {
  deriveSponsorAccount,
  getSavedSponsorWalletAddress,
  saveSponsorWalletVault,
  unlockSponsorWalletVault,
  removeSavedSponsorWallet,
} from '../src/sponsor-wallet-vault.mjs'

const PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000001'
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

test('imports an existing TRON account from a private key', async () => {
  const account = await deriveSponsorAccount({ mode: 'private-key', value: PRIVATE_KEY })
  assert.equal(account.network, 'mainnet')
  assert.equal(TronWeb.isAddress(account.address), true)
  assert.equal(account.privateKey, PRIVATE_KEY)
})

test('imports a TRON account from its BIP39 mnemonic', async () => {
  const account = await deriveSponsorAccount({ mode: 'mnemonic', value: MNEMONIC })
  assert.equal(account.network, 'mainnet')
  assert.equal(TronWeb.isAddress(account.address), true)
  assert.equal(account.privateKey.length, 64)
})

test('decrypts a standard V3 keystore JSON without changing the derived TRON address', async () => {
  const wallet = new Wallet(`0x${PRIVATE_KEY}`)
  const keystore = await wallet.encrypt('keystore-password')
  const account = await deriveSponsorAccount({ mode: 'keystore', value: keystore, secretPassword: 'keystore-password' })
  const expected = new TronWeb({ fullHost: 'https://api.trongrid.io' }).address.fromPrivateKey(PRIVATE_KEY)
  assert.equal(account.address, expected)
})

test('stores the Sponsor Wallet only as an encrypted local vault and unlocks it with the vault password', async () => {
  const entries = new Map()
  const previousStorage = globalThis.localStorage
  globalThis.localStorage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  }
  try {
    const account = await deriveSponsorAccount({ mode: 'private-key', value: PRIVATE_KEY })
    await saveSponsorWalletVault(account, 'a-strong-local-vault-password')
    const stored = entries.values().next().value
    assert.ok(stored)
    assert.equal(stored.includes(PRIVATE_KEY), false)
    assert.equal(getSavedSponsorWalletAddress(), account.address)
    const unlocked = await unlockSponsorWalletVault('a-strong-local-vault-password')
    assert.equal(unlocked.address, account.address)
    await assert.rejects(
      unlockSponsorWalletVault('incorrect-vault-password'),
      /Unable to unlock the Sponsor Wallet/,
    )
    removeSavedSponsorWallet()
    assert.equal(entries.size, 0)
    assert.equal(getSavedSponsorWalletAddress(), '')
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousStorage
  }
})
