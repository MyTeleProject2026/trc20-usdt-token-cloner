import { TronWeb } from 'tronweb'
import { Wallet } from 'ethers'

const STORAGE_KEY = 'tron-transfer.sponsor-wallet.v1'
const PBKDF2_ITERATIONS = 310000
const MAINNET_HOST = 'https://api.trongrid.io'

function bytesToBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0))
}

function normalizePrivateKey(value) {
  const key = String(value || '').trim().replace(/^0x/i, '')
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('The private key must contain exactly 64 hexadecimal characters.')
  return key.toLowerCase()
}

export function createSponsorTronWeb(privateKey = '') {
  return new TronWeb({ fullHost: MAINNET_HOST, ...(privateKey ? { privateKey } : {}) })
}

export async function deriveSponsorAccount({ mode, value, secretPassword = '' }) {
  const tronWeb = createSponsorTronWeb()
  let privateKey
  if (mode === 'private-key') {
    privateKey = normalizePrivateKey(value)
  } else if (mode === 'mnemonic') {
    const phrase = String(value || '').trim().replace(/\s+/g, ' ')
    if (phrase.split(' ').length < 12) throw new Error('Enter the complete recovery phrase. A valid TRON mnemonic normally contains 12, 15, 18, 21 or 24 words.')
    const account = TronWeb.fromMnemonic(phrase)
    privateKey = normalizePrivateKey(account.privateKey)
  } else if (mode === 'keystore') {
    let json
    try { json = JSON.parse(String(value || '')) } catch { throw new Error('The selected Keystore file is not valid JSON.') }
    if (!json || typeof json !== 'object' || !json.crypto && !json.Crypto) throw new Error('Unsupported keystore format. Import a standard Ethereum-compatible V3 keystore JSON.')
    if (!secretPassword) throw new Error('Enter the keystore password to decrypt this wallet.')
    let decrypted
    try { decrypted = await Wallet.fromEncryptedJson(JSON.stringify(json), secretPassword) }
    catch { throw new Error('Keystore decryption failed. Check the password and selected file.') }
    privateKey = normalizePrivateKey(decrypted.privateKey)
  } else {
    throw new Error('Choose a supported sponsor wallet import method.')
  }

  const address = tronWeb.address.fromPrivateKey(privateKey)
  if (!address || !tronWeb.isAddress(address) || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    throw new Error('The imported credentials did not derive a valid TRON address.')
  }
  return { address, privateKey, network: 'mainnet' }
}

async function deriveVaultKey(password, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function saveSponsorWalletVault(account, password) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Use a wallet-vault password with at least 12 characters.')
  const privateKey = normalizePrivateKey(account.privateKey)\n  const derivedAddress = createSponsorTronWeb().address.fromPrivateKey(privateKey)\n  if (derivedAddress !== account.address) throw new Error('Sponsor Wallet address does not match the imported private key.')\n  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveVaultKey(password, salt)
  const payload = new TextEncoder().encode(JSON.stringify({
    privateKey,
    address: account.address,
    network: 'mainnet',
  }))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload)
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    cipher: 'AES-256-GCM',
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    address: account.address,
    network: 'mainnet',
  }))
}

export async function unlockSponsorWalletVault(password) {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) throw new Error('No encrypted Sponsor Wallet is saved in this browser. Import your existing wallet first.')
  let vault
  try { vault = JSON.parse(raw) } catch { throw new Error('The saved Sponsor Wallet vault is corrupted.') }
  if (vault?.version !== 1 || vault?.kdf !== 'PBKDF2-SHA256' || vault?.iterations !== PBKDF2_ITERATIONS || vault?.cipher !== 'AES-256-GCM' || vault?.network !== 'mainnet') {
    throw new Error('The saved wallet vault version or network is unsupported.')
  }
  try {
    const key = await deriveVaultKey(password, base64ToBytes(vault.salt))
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(vault.iv) },
      key,
      base64ToBytes(vault.ciphertext),
    )
    const account = JSON.parse(new TextDecoder().decode(plaintext))
    const privateKey = normalizePrivateKey(account.privateKey)
    const address = createSponsorTronWeb().address.fromPrivateKey(privateKey)
    if (address !== vault.address || address !== account.address) throw new Error('Wallet address integrity check failed.')
    return { address, privateKey, network: 'mainnet' }
  } catch (error) {
    if (error instanceof Error && error.message === 'Wallet address integrity check failed.') throw error
    throw new Error('Unable to unlock the Sponsor Wallet. Check the vault password.')
  }
}

export function getSavedSponsorWalletAddress() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return typeof saved.address === 'string' ? saved.address : ''
  } catch { return '' }
}

export function hasSavedSponsorWallet() {
  try { return Boolean(localStorage.getItem(STORAGE_KEY)) } catch { return false }
}

export function removeSavedSponsorWallet() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { throw new Error('The browser could not remove the local Sponsor Wallet backup.') }
}

export function clearSponsorSecretFields() {
  // Callers should also clear controlled input state; JavaScript strings cannot be zeroized reliably.
}
