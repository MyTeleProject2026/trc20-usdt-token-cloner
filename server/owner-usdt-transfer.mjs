import { createHash } from 'node:crypto'
import { TronWeb } from 'tronweb'
import { isValidTronAddress } from './tron-address.mjs'

const MAINNET_GATEWAY = 'https://tron-mainnet.gateway.tatum.io'
export const MAINNET_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_RE = /^[0-9a-f]{64}$/i
const TRANSFER_SELECTOR = 'a9059cbb'
const MAX_PREPARED_LIFETIME_MS = 10 * 60 * 1000

function clean(value, max = 256) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function tronWebForMainnet() {
  return new TronWeb({ fullHost: MAINNET_GATEWAY })
}

function canonicalAddress(value, tronWeb) {
  const candidate = clean(value, 96)
  if (ADDRESS_RE.test(candidate) && isValidTronAddress(candidate)) return candidate
  const hex = candidate.replace(/^0x/i, '').toLowerCase()
  if (!/^(?:41)?[0-9a-f]{40}$/.test(hex)) return null
  try {
    const decoded = tronWeb.address.fromHex(hex.length === 40 ? '41' + hex : hex)
    return ADDRESS_RE.test(decoded) && isValidTronAddress(decoded) ? decoded : null
  } catch {
    return null
  }
}

export function parseOwnerUsdtAmount(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(raw)) {
    throw new Error('Enter a positive USDT amount with no more than six decimal places.')
  }
  const [whole, fraction = ''] = raw.split('.')
  const baseUnits = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0')
  if (baseUnits <= 0n || baseUnits > 10n ** 30n) {
    throw new Error('Enter a positive USDT amount within the permitted transfer range.')
  }
  return baseUnits.toString()
}

export function buildOwnerUsdtTransferParameter(recipientAddress, amountBaseUnits, tronWeb = tronWebForMainnet()) {
  if (!isValidTronAddress(recipientAddress) || !/^[1-9][0-9]{0,77}$/.test(String(amountBaseUnits))) {
    throw new Error('Invalid TRON transfer parameter.')
  }
  const recipientHex = tronWeb.address.toHex(recipientAddress).replace(/^41/i, '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(recipientHex)) throw new Error('Recipient address could not be encoded.')
  return recipientHex.padStart(64, '0') + BigInt(amountBaseUnits).toString(16).padStart(64, '0')
}

function transactionMatchesIntent(transaction, { ownerAddress, recipientAddress, amountBaseUnits, tronWeb }) {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) return false
  if (typeof transaction.txID !== 'string' || !TXID_RE.test(transaction.txID)
    || typeof transaction.raw_data_hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(transaction.raw_data_hex)) return false
  const calculated = createHash('sha256').update(Buffer.from(transaction.raw_data_hex, 'hex')).digest('hex')
  if (calculated.toLowerCase() !== transaction.txID.toLowerCase()) return false
  const contracts = transaction.raw_data?.contract
  if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== 'TriggerSmartContract') return false
  const value = contracts[0]?.parameter?.value
  if (!value || canonicalAddress(value.owner_address, tronWeb) !== ownerAddress
    || canonicalAddress(value.contract_address, tronWeb) !== MAINNET_USDT_CONTRACT
    || Number(value.call_value || 0) !== 0) return false
  const expectedParameter = buildOwnerUsdtTransferParameter(recipientAddress, amountBaseUnits, tronWeb)
  const expectedData = TRANSFER_SELECTOR + expectedParameter
  if (typeof value.data !== 'string' || value.data.replace(/^0x/i, '').toLowerCase() !== expectedData) return false
  const expiration = Number(transaction.raw_data?.expiration)
  const now = Date.now()
  return Number.isSafeInteger(expiration)
    && expiration > now
    && expiration <= now + MAX_PREPARED_LIFETIME_MS + 30_000
}

function sameUnsignedTransaction(signed, unsigned) {
  if (!signed || typeof signed !== 'object' || Array.isArray(signed) || !unsigned) return false
  if (String(signed.txID || '').toLowerCase() !== String(unsigned.txID || '').toLowerCase()
    || String(signed.raw_data_hex || '').toLowerCase() !== String(unsigned.raw_data_hex || '').toLowerCase()) return false
  const canonical = (value) => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value
  try {
    return JSON.stringify(canonical(signed.raw_data)) === JSON.stringify(canonical(unsigned.raw_data))
  } catch {
    return false
  }
}

export function validateOwnerSignedTransaction(signed, unsigned, intent) {
  if (!sameUnsignedTransaction(signed, unsigned)) return { ok: false, reason: 'signed-transaction-does-not-match-prepared-intent' }
  if (!Array.isArray(signed.signature) || signed.signature.length !== 1
    || typeof signed.signature[0] !== 'string' || !/^[0-9a-f]{130}$/i.test(signed.signature[0])) {
    return { ok: false, reason: 'owner-signature-required' }
  }
  const tronWeb = intent.tronWeb || tronWebForMainnet()
  if (!transactionMatchesIntent(signed, { ...intent, tronWeb })) {
    return { ok: false, reason: 'signed-transaction-intent-mismatch' }
  }
  return { ok: true }
}
