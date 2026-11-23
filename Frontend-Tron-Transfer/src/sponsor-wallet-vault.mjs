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
  const privateKey = normalizePrivateKey(account.privateKey)
  const derivedAddress = createSponsorTronWeb().address.fromPrivateKey(privateKey)
  if (derivedAddress !== account.address) throw new Error('Sponsor Wallet address does not match the imported private key.')
  const salt = crypto.getRandomValues(new Uint8Array(16))
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


// Sign only the exact unsigned transaction returned by the Resource API.
// This function never broadcasts and never returns the private key.
export async function signSponsorTransaction(account, unsignedTransaction, { tronWebFactory = createSponsorTronWeb, now = () => Date.now() } = {}) {
  const privateKey = normalizePrivateKey(account?.privateKey)
  const tronWeb = tronWebFactory(privateKey)
  const derivedAddress = tronWeb.address.fromPrivateKey(privateKey)
  if (!derivedAddress || derivedAddress !== account?.address || !tronWeb.isAddress(derivedAddress)) {
    throw new Error('Sponsor signer does not match the unlocked local vault.')
  }

  const contracts = unsignedTransaction?.raw_data?.contract
  const ownerHex = contracts?.[0]?.parameter?.value?.owner_address
  const expiration = Number(unsignedTransaction?.raw_data?.expiration)
  if (!Array.isArray(contracts) || contracts.length !== 1
    || !['FreezeBalanceV2Contract', 'DelegateResourceContract', 'UnDelegateResourceContract', 'UnfreezeBalanceV2Contract', 'WithdrawExpireUnfreezeContract', 'TransferContract'].includes(contracts[0]?.type)
    || typeof ownerHex !== 'string' || !/^(?:41)?[0-9a-f]{40,42}$/i.test(ownerHex)
    || !tronWeb.isAddress(tronWeb.address.fromHex(ownerHex.length === 40 ? '41' + ownerHex : ownerHex))
    || tronWeb.address.fromHex(ownerHex.length === 40 ? '41' + ownerHex : ownerHex) !== derivedAddress) {
    throw new Error('Unsigned Sponsor transaction is not bound to the unlocked Sponsor address.')
  }
  if (!Number.isSafeInteger(expiration) || expiration <= now() + 5_000 || expiration > now() + 10 * 60_000
    || !/^[0-9a-f]{64}$/i.test(String(unsignedTransaction?.txID || ''))
    || !/^(?:[0-9a-f]{2})+$/i.test(String(unsignedTransaction?.raw_data_hex || ''))
    || !Array.isArray(unsignedTransaction?.signature) || unsignedTransaction.signature.length !== 0) {
    throw new Error('Unsigned Sponsor transaction is malformed, expired, or already signed.')
  }
  if (typeof tronWeb.utils?.transaction?.txCheck !== 'function'
    || tronWeb.utils.transaction.txCheck(unsignedTransaction) !== true) {
    throw new Error('Unsigned Sponsor transaction failed protobuf integrity validation.')
  }
  if (typeof tronWeb.trx?.sign !== 'function' || typeof tronWeb.utils?.crypto?.ecRecover !== 'function') {
    throw new Error('Local Sponsor transaction signing or signature recovery is unavailable.')
  }

  const signed = await tronWeb.trx.sign(structuredClone(unsignedTransaction), privateKey)
  if (!signed || signed.txID !== unsignedTransaction.txID
    || signed.raw_data_hex !== unsignedTransaction.raw_data_hex
    || JSON.stringify(signed.raw_data) !== JSON.stringify(unsignedTransaction.raw_data)
    || !Array.isArray(signed.signature) || signed.signature.length !== 1
    || !/^[0-9a-f]{130}$/i.test(String(signed.signature[0] || ''))
    || tronWeb.utils.transaction.txCheck(signed) !== true) {
    throw new Error('Local Sponsor signature changed the prepared transaction or failed integrity validation.')
  }

  let recovered
  try {
    const value = tronWeb.utils.crypto.ecRecover(signed.txID, signed.signature[0])
    recovered = typeof value === 'string' && /^41[0-9a-f]{40}$/i.test(value)
      ? tronWeb.address.fromHex(value)
      : value
  } catch {
    throw new Error('Unable to recover the Sponsor signer from the local transaction signature.')
  }
  if (recovered !== derivedAddress) throw new Error('Local Sponsor transaction signature does not match the unlocked Sponsor address.')
  return signed
}
