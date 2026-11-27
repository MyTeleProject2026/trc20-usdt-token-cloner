import { TronWeb } from 'tronweb'
import { Wallet } from 'ethers'

const STORAGE_KEY = 'tron-transfer.owner-wallet.v1'
const PBKDF2_ITERATIONS = 310000
const MAINNET_HOST = 'https://api.trongrid.io'

function toBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
function fromBase64(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0))
}
function normalizePrivateKey(value) {
  const key = String(value || '').trim().replace(/^0x/i, '')
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('The private key must contain exactly 64 hexadecimal characters.')
  return key.toLowerCase()
}
export function createOwnerTronWeb(privateKey = '') {
  return new TronWeb({ fullHost: MAINNET_HOST, ...(privateKey ? { privateKey } : {}) })
}
export async function deriveOwnerAccount({ mode, value, secretPassword = '' }) {
  let privateKey
  if (mode === 'private-key') privateKey = normalizePrivateKey(value)
  else if (mode === 'mnemonic') {
    const phrase = String(value || '').trim().replace(/\s+/g, ' ')
    if (![12,15,18,21,24].includes(phrase.split(' ').length)) throw new Error('Enter a complete 12, 15, 18, 21 or 24-word recovery phrase.')
    privateKey = normalizePrivateKey(TronWeb.fromMnemonic(phrase).privateKey)
  } else if (mode === 'keystore') {
    let json
    try { json = JSON.parse(String(value || '')) } catch { throw new Error('The selected keystore is not valid JSON.') }
    if (!json || typeof json !== 'object' || !(json.crypto || json.Crypto)) throw new Error('Import a standard V3-compatible keystore JSON file.')
    if (!secretPassword) throw new Error('Enter the keystore password.')
    try { privateKey = normalizePrivateKey((await Wallet.fromEncryptedJson(JSON.stringify(json), secretPassword)).privateKey) }
    catch { throw new Error('Keystore decryption failed. Check the file and password.') }
  } else throw new Error('Choose a supported Owner Wallet import method.')
  const tronWeb = createOwnerTronWeb()
  const address = tronWeb.address.fromPrivateKey(privateKey)
  if (!address || !tronWeb.isAddress(address) || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) throw new Error('The imported credentials did not derive a valid TRON Mainnet address.')
  return { address, privateKey, network: 'mainnet' }
}
async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt'])
}
export async function saveOwnerWalletVault(account, password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('Use an Owner Wallet vault password with at least 8 characters.')
  const privateKey = normalizePrivateKey(account.privateKey)
  const address = createOwnerTronWeb().address.fromPrivateKey(privateKey)
  if (address !== account.address) throw new Error('Owner Wallet address does not match the imported private key.')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt)
  const plaintext = new TextEncoder().encode(JSON.stringify({ privateKey, address, network: 'mainnet' }))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, cipher: 'AES-256-GCM', salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)), address, network: 'mainnet' }))
}
export async function unlockOwnerWalletVault(password) {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) throw new Error('No encrypted Owner Wallet is saved in this browser. Import your existing Owner Wallet first.')
  let vault
  try { vault = JSON.parse(raw) } catch { throw new Error('The saved Owner Wallet vault is corrupted.') }
  if (vault?.version !== 1 || vault?.kdf !== 'PBKDF2-SHA256' || vault?.iterations !== PBKDF2_ITERATIONS || vault?.cipher !== 'AES-256-GCM' || vault?.network !== 'mainnet') throw new Error('The saved Owner Wallet vault version or network is unsupported.')
  try {
    const key = await deriveKey(password, fromBase64(vault.salt))
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(vault.iv) }, key, fromBase64(vault.ciphertext))
    const account = JSON.parse(new TextDecoder().decode(plain))
    const privateKey = normalizePrivateKey(account.privateKey)
    const address = createOwnerTronWeb().address.fromPrivateKey(privateKey)
    if (address !== vault.address || address !== account.address) throw new Error('Owner Wallet address integrity check failed.')
    return { address, privateKey, network: 'mainnet' }
  } catch (error) {
    if (error instanceof Error && error.message === 'Owner Wallet address integrity check failed.') throw error
    throw new Error('Unable to unlock the Owner Wallet. Check the vault password.')
  }
}

export async function migrateOwnerWalletVault(previousPassword, ownerAdminPassword) {
  if (typeof ownerAdminPassword !== 'string' || ownerAdminPassword.length < 8) throw new Error('Use the Owner Admin password with at least 8 characters.')
  const account = await unlockOwnerWalletVault(previousPassword)
  const original = localStorage.getItem(STORAGE_KEY)
  try {
    await saveOwnerWalletVault(account, ownerAdminPassword)
    const verified = await unlockOwnerWalletVault(ownerAdminPassword)
    if (verified.address !== account.address || verified.privateKey !== account.privateKey) throw new Error('Owner vault migration verification failed.')
    return verified
  } catch (error) {
    if (original !== null) localStorage.setItem(STORAGE_KEY, original)
    throw error
  }
}

export function getSavedOwnerWalletAddress() {
  try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); return typeof value.address === 'string' ? value.address : '' } catch { return '' }
}
export function hasSavedOwnerWallet() { try { return Boolean(localStorage.getItem(STORAGE_KEY)) } catch { return false } }
export function removeSavedOwnerWallet() { try { localStorage.removeItem(STORAGE_KEY) } catch { throw new Error('The browser could not remove the local Owner Wallet backup.') } }
