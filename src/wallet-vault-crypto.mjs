const FORMAT = 'tron-token-studio-encrypted-wallet'
const VERSION = 1
const ITERATIONS = 310_000
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const PRIVATE_KEY_PATTERN = /^(?:0x)?[0-9a-f]{64}$/i
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function requireCrypto(provider) {
  if (!provider?.subtle || typeof provider.getRandomValues !== 'function') {
    throw new Error('Secure browser cryptography is unavailable. This wallet operation cannot continue.')
  }
  return provider
}

function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return globalThis.btoa(binary)
}

function base64ToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Encrypted wallet file is malformed.')
  }
  const binary = globalThis.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function validateRecord(record) {
  return Boolean(record
    && typeof record === 'object'
    && record.format === FORMAT
    && record.version === VERSION
    && typeof record.address === 'string'
    && ADDRESS_PATTERN.test(record.address)
    && Number.isFinite(record.createdAt)
    && record.kdf?.name === 'PBKDF2'
    && record.kdf?.hash === 'SHA-256'
    && record.kdf?.iterations === ITERATIONS
    && typeof record.kdf?.salt === 'string'
    && record.cipher?.name === 'AES-GCM'
    && record.cipher?.tagLength === 128
    && typeof record.cipher?.iv === 'string'
    && typeof record.ciphertext === 'string')
}

async function deriveEncryptionKey(password, salt, provider) {
  const material = await provider.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return provider.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Encrypts a TRON private key on-device. Only the encrypted record should be
 * persisted or exported; the private key must never be posted to an API.
 */
export async function encryptWalletPrivateKey(privateKey, address, password, cryptoProvider = globalThis.crypto) {
  const provider = requireCrypto(cryptoProvider)
  const normalizedKey = typeof privateKey === 'string' ? privateKey.replace(/^0x/i, '').toLowerCase() : ''
  if (!PRIVATE_KEY_PATTERN.test(normalizedKey)) throw new Error('The private key must contain exactly 32 bytes of hexadecimal data.')
  if (typeof address !== 'string' || !ADDRESS_PATTERN.test(address)) throw new Error('A valid TRON address is required.')
  if (typeof password !== 'string' || password.length < 12) throw new Error('Use a wallet password with at least 12 characters.')

  const salt = provider.getRandomValues(new Uint8Array(16))
  const iv = provider.getRandomValues(new Uint8Array(12))
  const key = await deriveEncryptionKey(password, salt, provider)
  const additionalData = encoder.encode(`${FORMAT}:${VERSION}:${address}`)
  const ciphertext = await provider.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    key,
    encoder.encode(normalizedKey),
  )

  return {
    format: FORMAT,
    version: VERSION,
    address,
    createdAt: Date.now(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: bytesToBase64(salt) },
    cipher: { name: 'AES-GCM', iv: bytesToBase64(iv), tagLength: 128 },
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  }
}

/** Decrypts to transient memory after password entry; callers must not persist the returned key. */
export async function decryptWalletPrivateKey(record, password, cryptoProvider = globalThis.crypto) {
  const provider = requireCrypto(cryptoProvider)
  if (!validateRecord(record)) throw new Error('This is not a supported TRON Token Studio encrypted wallet backup.')
  if (typeof password !== 'string' || password.length < 1) throw new Error('Enter the wallet password.')

  try {
    const salt = base64ToBytes(record.kdf.salt)
    const iv = base64ToBytes(record.cipher.iv)
    if (salt.length !== 16 || iv.length !== 12) throw new Error('Encrypted wallet file is malformed.')
    const key = await deriveEncryptionKey(password, salt, provider)
    const additionalData = encoder.encode(`${FORMAT}:${VERSION}:${record.address}`)
    const plaintext = await provider.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
      key,
      base64ToBytes(record.ciphertext),
    )
    const privateKey = decoder.decode(plaintext)
    if (!/^[0-9a-f]{64}$/.test(privateKey)) throw new Error('Encrypted wallet payload is malformed.')
    return privateKey
  } catch {
    throw new Error('Wallet could not be unlocked. Check the password and encrypted backup file.')
  }
}

export function isEncryptedWalletRecord(record) {
  return validateRecord(record)
}

export const WALLET_KEYSTORE_FORMAT = FORMAT
export const WALLET_KDF_ITERATIONS = ITERATIONS
