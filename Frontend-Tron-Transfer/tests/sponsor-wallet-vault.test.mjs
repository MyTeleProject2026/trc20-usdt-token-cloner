import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import { Wallet } from 'ethers'
import {
  createSponsorTronWeb, deriveSponsorAccount, getSavedSponsorWalletAddress,
  hasSavedSponsorWallet, removeSavedSponsorWallet, saveSponsorWalletVault,
  unlockSponsorWalletVault,
} from '../src/sponsor-wallet-vault.mjs'

const vault = await readFile(new URL('../src/sponsor-wallet-vault.mjs', import.meta.url), 'utf8')
const ui = await readFile(new URL('../src/SponsorWalletManager.jsx', import.meta.url), 'utf8')

test('Sponsor vault imports existing private key, V3 keystore or TRON mnemonic without creating a wallet', () => {
  for (const method of ['private-key', 'keystore', 'mnemonic']) assert.ok(vault.includes(`mode === '${method}'`))
  assert.ok(vault.includes('TronWeb.fromMnemonic'))
  assert.ok(vault.includes('Wallet.fromEncryptedJson'))
  assert.ok(vault.includes('export async function deriveSponsorAccount'))
  assert.ok(!vault.includes('Wallet.createRandom'))
  assert.ok(!vault.includes('new Wallet('))
})

test('Sponsor vault encrypts locally with AES-256-GCM and PBKDF2-SHA256 and verifies address on unlock', () => {
  assert.ok(vault.includes("name: 'PBKDF2'"))
  assert.ok(vault.includes('iterations: PBKDF2_ITERATIONS'))
  assert.ok(vault.includes("name: 'AES-GCM'"))
  assert.ok(vault.includes("cipher: 'AES-256-GCM'"))
  assert.ok(vault.includes("kdf: 'PBKDF2-SHA256'"))
  assert.ok(vault.includes('address !== vault.address || address !== account.address'))
  assert.ok(vault.includes('export async function unlockSponsorWalletVault'))
})

test('Sponsor local vault is independent from the Owner and matches the authenticated Sponsor session', () => {
  assert.ok(ui.includes('account.address === OWNER_ADDRESS'))
  assert.ok(ui.includes('account.address !== managedSponsorAddress'))
  assert.ok(ui.includes('Sponsor Wallet imported'))
  assert.ok(ui.includes('Sponsor Wallet unlocked'))
  assert.ok(ui.includes('function beginReplace()'))
  assert.ok(ui.includes('function removeVault()'))
  assert.ok(ui.includes('function logoutWallet()'))
  assert.ok(ui.includes('Local Sponsor signer cleared from memory'))
  assert.doesNotMatch(ui, /tronlink-provider|requestTronLinkConnection|discoverTronLinkProvider/)
})

test('Sponsor transaction writes stay blocked until exact local signing and backend verification are implemented', () => {
  assert.ok(ui.includes('transactionExecutionAvailable !== true'))
  assert.ok(ui.includes('Sponsor local signing is not yet accepted'))
  assert.ok(ui.includes('sponsorApiStatus?.localSignerReady'))
  assert.ok(ui.includes('Sponsor transaction writes remain disabled'))
})

test('Sponsor wallet private-key, V3 keystore and mnemonic imports derive Mainnet addresses', async () => {
  const privateKey = '1'.repeat(64)
  const fromKey = await deriveSponsorAccount({ mode: 'private-key', value: privateKey })
  assert.equal(fromKey.address, createSponsorTronWeb().address.fromPrivateKey(privateKey))
  assert.equal(fromKey.network, 'mainnet')

  const keystorePassword = 'keystore-password-for-test'
  const keystore = await new Wallet('0x' + privateKey).encrypt(keystorePassword)
  const fromKeystore = await deriveSponsorAccount({ mode: 'keystore', value: keystore, secretPassword: keystorePassword })
  assert.equal(fromKeystore.privateKey, privateKey)
  assert.equal(fromKeystore.address, fromKey.address)

  const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  const fromMnemonic = await deriveSponsorAccount({ mode: 'mnemonic', value: phrase })
  assert.match(fromMnemonic.address, /^T[1-9A-HJ-NP-Za-km-z]{33}$/)
  await assert.rejects(deriveSponsorAccount({ mode: 'private-key', value: 'invalid' }), /exactly 64 hexadecimal/)
})

test('Sponsor vault round-trips encrypted storage, rejects wrong passwords and removes the local backup', async () => {
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const priorCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  const values = new Map()
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
  })
  try {
    const account = await deriveSponsorAccount({ mode: 'private-key', value: '1'.repeat(64) })
    await assert.rejects(saveSponsorWalletVault(account, 'short'), /at least 12 characters/)
    const password = 'local-sponsor-vault-password'
    await saveSponsorWalletVault(account, password)
    assert.equal(hasSavedSponsorWallet(), true)
    assert.equal(getSavedSponsorWalletAddress(), account.address)
    const serialized = values.get('tron-transfer.sponsor-wallet.v1')
    assert.ok(serialized)
    assert.equal(serialized.includes(account.privateKey), false)
    assert.equal(serialized.includes('AES-256-GCM'), true)

    const unlocked = await unlockSponsorWalletVault(password)
    assert.equal(unlocked.address, account.address)
    assert.equal(unlocked.privateKey, account.privateKey)
    await assert.rejects(unlockSponsorWalletVault('incorrect-password'), /Unable to unlock/)

    removeSavedSponsorWallet()
    assert.equal(hasSavedSponsorWallet(), false)
    assert.equal(getSavedSponsorWalletAddress(), '')
    await assert.rejects(unlockSponsorWalletVault(password), /No encrypted Sponsor Wallet/)
  } finally {
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage)
    else delete globalThis.localStorage
    if (priorCrypto) Object.defineProperty(globalThis, 'crypto', priorCrypto)
    else delete globalThis.crypto
  }
})
