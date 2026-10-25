import { createHash, timingSafeEqual } from 'node:crypto'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]))
const TRON_ADDRESS_TEXT = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TRON_VERSION_BYTE = 0x41
const CHECKSUM_LENGTH = 4

/**
 * Validate a user-facing TRON address using Base58Check, not just its alphabet
 * and length. This is appropriate for transfer-intent inputs and public
 * sponsor addresses; it does not establish ownership or spending authority.
 */
export function isValidTronAddress(value) {
  if (typeof value !== 'string' || !TRON_ADDRESS_TEXT.test(value)) return false

  let decoded = 0n
  for (const character of value) {
    const digit = BASE58_INDEX.get(character)
    if (digit === undefined) return false
    decoded = decoded * 58n + BigInt(digit)
  }

  const bytes = []
  while (decoded > 0n) {
    bytes.push(Number(decoded & 0xffn))
    decoded >>= 8n
  }
  bytes.reverse()

  // A TRON Base58Check address encodes 0x41 + 20 address bytes + 4 checksum bytes.
  const leadingZeroes = value.match(/^1*/)?.[0].length ?? 0
  const raw = Buffer.from([...Array(leadingZeroes).fill(0), ...bytes])
  if (raw.length !== 25 || raw[0] !== TRON_VERSION_BYTE) return false

  const payload = raw.subarray(0, 21)
  const suppliedChecksum = raw.subarray(21)
  const expectedChecksum = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, CHECKSUM_LENGTH)

  return timingSafeEqual(suppliedChecksum, expectedChecksum)
}
