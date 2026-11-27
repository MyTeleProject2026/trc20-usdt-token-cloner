import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
export const WALLET_PASSWORD_PARAMS = Object.freeze({ N: 32_768, r: 8, p: 1, keyLength: 64 })
const SALT_BYTES = 16
const TOKEN_BYTES = 32
const MAXMEM = 64 * 1024 * 1024

export function validateWalletPassword(password) {
  if (typeof password !== 'string') return false
  const bytes = Buffer.byteLength(password, 'utf8')
  return bytes >= 8 && bytes <= 1024 && !/[\u0000-\u001f\u007f]/u.test(password)
}

export async function hashWalletPassword(password) {
  if (!validateWalletPassword(password)) throw new TypeError('wallet-password-policy-failed')
  const salt = randomBytes(SALT_BYTES)
  const derived = await scrypt(password, salt, WALLET_PASSWORD_PARAMS.keyLength, {
    N: WALLET_PASSWORD_PARAMS.N,
    r: WALLET_PASSWORD_PARAMS.r,
    p: WALLET_PASSWORD_PARAMS.p,
    maxmem: MAXMEM,
  })
  return {
    passwordHash: Buffer.from(derived).toString('hex'),
    passwordSalt: salt.toString('hex'),
    passwordAlgorithm: 'scrypt',
    passwordParams: {
      N: WALLET_PASSWORD_PARAMS.N,
      r: WALLET_PASSWORD_PARAMS.r,
      p: WALLET_PASSWORD_PARAMS.p,
      keyLength: WALLET_PASSWORD_PARAMS.keyLength,
    },
  }
}

export async function verifyWalletPassword(password, record) {
  if (!validateWalletPassword(password) || !record || record.passwordAlgorithm !== 'scrypt') return false
  if (record.passwordParams?.N !== WALLET_PASSWORD_PARAMS.N
    || record.passwordParams?.r !== WALLET_PASSWORD_PARAMS.r
    || record.passwordParams?.p !== WALLET_PASSWORD_PARAMS.p
    || (record.passwordParams?.keyLength !== undefined && record.passwordParams.keyLength !== WALLET_PASSWORD_PARAMS.keyLength)) return false
  if (typeof record.passwordSalt !== 'string' || !/^[a-f0-9]{32}$/u.test(record.passwordSalt)) return false
  if (typeof record.passwordHash !== 'string' || !/^[a-f0-9]{128}$/u.test(record.passwordHash)) return false
  const actual = Buffer.from(await scrypt(password, Buffer.from(record.passwordSalt, 'hex'), WALLET_PASSWORD_PARAMS.keyLength, {
    N: WALLET_PASSWORD_PARAMS.N,
    r: WALLET_PASSWORD_PARAMS.r,
    p: WALLET_PASSWORD_PARAMS.p,
    maxmem: MAXMEM,
  }))
  const expected = Buffer.from(record.passwordHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function createWalletSessionSecrets() {
  const sessionToken = randomBytes(TOKEN_BYTES).toString('base64url')
  const csrfToken = randomBytes(TOKEN_BYTES).toString('base64url')
  return {
    sessionToken,
    csrfToken,
    tokenHash: createHash('sha256').update(sessionToken).digest('hex'),
    csrfHash: createHash('sha256').update(csrfToken).digest('hex'),
  }
}

export function hashWalletSessionToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/u.test(token)) return null
  return createHash('sha256').update(token).digest('hex')
}
