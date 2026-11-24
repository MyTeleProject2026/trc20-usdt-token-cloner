import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import { Wallet } from 'ethers'
import {
  createSponsorTronWeb, deriveSponsorAccount, getSavedSponsorWalletAddress,
  hasSavedSponsorWallet, removeSavedSponsorWallet, saveSponsorWalletVault,
  unlockSponsorWalletVault, signSponsorTransaction,
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
  assert.ok(ui.includes('account.address === ownerAddress'))
  assert.ok(ui.includes('account.address !== managedSponsorAddress'))
  assert.ok(ui.includes("const configuredOwnerAddress = typeof session?.address === 'string'"))
  assert.ok(!ui.includes('const OWNER_ADDRESS ='))
  assert.ok(ui.includes('account.address !== managedSponsorAddress'))
  assert.ok(ui.includes('Sponsor Wallet imported'))
  assert.ok(ui.includes('Sponsor Wallet unlocked'))
  assert.ok(ui.includes('function beginReplace()'))
  assert.ok(ui.includes('function removeVault()'))
  assert.ok(ui.includes('function logoutWallet()'))
  assert.ok(ui.includes('Local Sponsor signer cleared from memory'))
  assert.doesNotMatch(ui, /tronlink-provider|requestTronLinkConnection|discoverTronLinkProvider/)
})

test('Sponsor transaction writes stay gated until release acceptance even though local signing is implemented', () => {
  assert.ok(ui.includes('transactionExecutionAvailable !== true'))
  assert.ok(ui.includes('Local Sponsor-vault signing is implemented.'))
  assert.ok(ui.includes('/api/sponsor/operations/prepare'))
  assert.ok(ui.includes('/api/sponsor/operations/submit'))
  assert.ok(ui.includes('signSponsorTransaction(wallet, unsignedTransaction)'))
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

function signedTransactionFixture({ ownerAddress = '41' + '11'.repeat(20), expiration = Date.now() + 60_000 } = {}) {
  return {
    txID: 'a'.repeat(64),
    raw_data_hex: '01'.repeat(20),
    raw_data: {
      expiration,
      contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: ownerAddress, resource: 1, frozen_balance: '1000000' } } }],
    },
    signature: [],
  }
}

test('Sponsor vault signs only an exact, unexpired Mainnet transaction bound to the unlocked Sponsor address', async () => {
  const privateKey = '1'.repeat(64)
  const address = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
  const ownerHex = '41' + '11'.repeat(20)
  let signCalls = 0
  const fakeTronWeb = {
    address: {
      fromPrivateKey: key => { assert.equal(key, privateKey); return address },
      fromHex: value => value === ownerHex ? address : '',
    },
    isAddress: value => value === address,
    utils: {
      transaction: { txCheck: () => true },
      crypto: { ecRecover: () => ownerHex },
    },
    trx: {
      sign: async (transaction, key) => {
        signCalls += 1
        assert.equal(key, privateKey)
        return { ...transaction, signature: ['b'.repeat(130)] }
      },
    },
  }
  const unsigned = signedTransactionFixture({ ownerAddress: ownerHex })
  const signed = await signSponsorTransaction(
    { address, privateKey },
    unsigned,
    { tronWebFactory: () => fakeTronWeb },
  )
  assert.equal(signed.signature.length, 1)
  assert.equal(signed.txID, unsigned.txID)
  assert.equal(signed.raw_data_hex, unsigned.raw_data_hex)
  assert.equal(signCalls, 1)
  assert.deepEqual(unsigned.signature, [])
})

test('Sponsor vault refuses transactions for another wallet, expired transactions, or invalid protobuf bodies', async () => {
  const privateKey = '1'.repeat(64)
  const address = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
  const ownerHex = '41' + '11'.repeat(20)
  const fakeTronWeb = {
    address: { fromPrivateKey: () => address, fromHex: value => value === ownerHex ? address : '' },
    isAddress: value => value === address,
    utils: { transaction: { txCheck: transaction => transaction?.raw_data_hex === '01'.repeat(20) }, crypto: { ecRecover: () => ownerHex } },
    trx: { sign: async transaction => ({ ...transaction, signature: ['b'.repeat(130)] }) },
  }
  const account = { address, privateKey }
  await assert.rejects(signSponsorTransaction(account, signedTransactionFixture({ ownerAddress: '41' + '22'.repeat(20) }), { tronWebFactory: () => fakeTronWeb }), /not bound/)
  await assert.rejects(signSponsorTransaction(account, signedTransactionFixture({ ownerAddress: ownerHex, expiration: Date.now() - 1 }), { tronWebFactory: () => fakeTronWeb }), /malformed, expired/)
  const malformed = signedTransactionFixture({ ownerAddress: ownerHex })
  malformed.raw_data_hex = 'ff'
  await assert.rejects(signSponsorTransaction(account, malformed, { tronWebFactory: () => fakeTronWeb }), /protobuf integrity/)
})

test('Sponsor vault rejects a returned signature if recovery identifies a different signer', async () => {
  const privateKey = '1'.repeat(64)
  const address = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
  const ownerHex = '41' + '11'.repeat(20)
  const otherHex = '41' + '22'.repeat(20)
  const fakeTronWeb = {
    address: { fromPrivateKey: () => address, fromHex: value => value === ownerHex ? address : '' },
    isAddress: value => value === address,
    utils: { transaction: { txCheck: () => true }, crypto: { ecRecover: () => otherHex } },
    trx: { sign: async transaction => ({ ...transaction, signature: ['b'.repeat(130)] }) },
  }
  await assert.rejects(signSponsorTransaction(
    { address, privateKey },
    signedTransactionFixture({ ownerAddress: ownerHex }),
    { tronWebFactory: () => fakeTronWeb },
  ), /does not match/)
})
