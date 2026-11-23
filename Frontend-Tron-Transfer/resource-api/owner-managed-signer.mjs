import { createHash } from 'node:crypto'
import { TronWeb } from 'tronweb'

const OWNER_KEY_ENV = 'TRON_OWNER_PRIVATE_KEY'
const OWNER_ADDRESS_ENV = 'TRON_OWNER_ADDRESS'
const CONTRACT_ADDRESS_ENV = 'TRAX_CONTRACT_ADDRESS'
const MAINNET_HOST = 'https://api.trongrid.io'
const TX_ID = /^[0-9a-f]{64}$/i
const PRIVATE_KEY = /^(?:0x)?[0-9a-f]{64}$/i
const ALLOWED_METHODS = [
  'mint(address,uint256)', 'credit(address,uint256,bytes32)',
  'batchCredit(address[],uint256[],bytes32[])', 'transfer(address,uint256)',
  'setPaused(bool)', 'setMintingEnabled(bool)', 'transferOwnership(address)',
]

function fail(code) { throw Object.assign(new Error(code), { code }) }
function sameAddress(a, b) { return typeof a === 'string' && typeof b === 'string' && a === b }

function transactionOwner(tronWeb, transaction) {
  const value = transaction?.raw_data?.contract?.[0]?.parameter?.value
  if (!value?.owner_address) return ''
  try { return tronWeb.address.fromHex(value.owner_address) } catch { return '' }
}

/**
 * Creates an in-process Owner signer. The private key is captured by the
 * closure and is never returned, serialized, logged, or sent to the browser.
 *
 * This adapter intentionally signs only a single TRAX TriggerSmartContract
 * transaction addressed to the configured Mainnet TRAX contract. Deployment
 * remains a separate, artifact-pinned operation and is not enabled here.
 */
export function createOwnerManagedSigner({
  env = process.env,
  tronWebFactory = options => new TronWeb(options),
  expectedOwnerAddress = env[OWNER_ADDRESS_ENV],
  expectedContractAddress = env[CONTRACT_ADDRESS_ENV],
} = {}) {
  const key = String(env[OWNER_KEY_ENV] || '').trim()
  if (!PRIVATE_KEY.test(key)) fail('OWNER_SIGNER_PRIVATE_KEY_NOT_CONFIGURED_OR_INVALID')
  if (!expectedOwnerAddress || !expectedContractAddress) fail('OWNER_SIGNER_IDENTITY_OR_CONTRACT_NOT_CONFIGURED')

  const tronWeb = tronWebFactory({ fullHost: MAINNET_HOST, privateKey: key.replace(/^0x/i, '') })
  const derivedAddress = tronWeb.address.fromPrivateKey(key.replace(/^0x/i, ''))
  if (!sameAddress(derivedAddress, expectedOwnerAddress)) fail('OWNER_SIGNER_ADDRESS_MISMATCH')
  if (!tronWeb.isAddress(expectedContractAddress)) fail('OWNER_TRAX_CONTRACT_ADDRESS_INVALID')
  if (String(tronWeb.fullNode?.host || '').replace(/\/$/, '') !== MAINNET_HOST) fail('OWNER_SIGNER_MAINNET_NODE_MISMATCH')

  const allowedSelectors = new Set(ALLOWED_METHODS.map(signature => String(tronWeb.sha3(signature)).replace(/^0x/i, '').slice(0, 8).toLowerCase()))

  async function signContractTransaction(unsigned) {
    const contracts = unsigned?.raw_data?.contract
    if (!Array.isArray(contracts) || contracts.length !== 1
      || contracts[0]?.type !== 'TriggerSmartContract'
      || !TX_ID.test(String(unsigned?.txID || ''))
      || !/^(?:[0-9a-f]{2})+$/i.test(String(unsigned?.raw_data_hex || ''))) {
      fail('OWNER_SIGNER_TRANSACTION_SHAPE_INVALID')
    }
    if (transactionOwner(tronWeb, unsigned) !== expectedOwnerAddress) fail('OWNER_SIGNER_TRANSACTION_OWNER_MISMATCH')
    const value = contracts[0]?.parameter?.value || {}
    let contractAddress = ''
    try { contractAddress = tronWeb.address.fromHex(value.contract_address || '') } catch {}
    if (!sameAddress(contractAddress, expectedContractAddress)) fail('OWNER_SIGNER_CONTRACT_NOT_ALLOWLISTED')
    if (String(value.data || '').replace(/^0x/, '').length < 8
      || !/^(?:[0-9a-f]{8})/i.test(String(value.data || '').replace(/^0x/, ''))
      || Number(value.call_value || 0) !== 0) {
      fail('OWNER_SIGNER_CALL_DATA_OR_VALUE_INVALID')
    }
    const feeLimit = Number(unsigned.raw_data?.fee_limit)
    const maxFeeLimit = Number(env.OWNER_MAX_FEE_LIMIT_SUN || 150000000)
    if (!Number.isSafeInteger(feeLimit) || feeLimit <= 0 || !Number.isSafeInteger(maxFeeLimit) || feeLimit > maxFeeLimit) {
      fail('OWNER_SIGNER_FEE_LIMIT_INVALID')
    }
    const timestamp = Number(unsigned.raw_data?.timestamp)
    const expiration = Number(unsigned.raw_data?.expiration)
    const now = Date.now()
    if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(expiration)
      || timestamp <= 0 || timestamp > now + 30_000 || expiration <= now + 5_000
      || expiration <= timestamp || expiration > now + 10 * 60_000) {
      fail('OWNER_SIGNER_TRANSACTION_EXPIRED_OR_INVALID')
    }
    if (Number(contracts[0]?.Permission_id ?? contracts[0]?.permission_id ?? 0) !== 0) fail('OWNER_SIGNER_PERMISSION_ID_NOT_ALLOWED')
    const selector = String(value.data || '').replace(/^0x/i, '').slice(0, 8).toLowerCase()
    if (!allowedSelectors.has(selector)) fail('OWNER_SIGNER_METHOD_NOT_ALLOWLISTED')
    if (typeof tronWeb.utils?.transaction?.txCheck !== 'function'
      || tronWeb.utils.transaction.txCheck(unsigned) !== true) fail('OWNER_SIGNER_UNSIGNED_TRANSACTION_INVALID')
    const calculatedId = createHash('sha256').update(Buffer.from(unsigned.raw_data_hex, 'hex')).digest('hex')
    if (calculatedId.toLowerCase() !== unsigned.txID.toLowerCase()) fail('OWNER_SIGNER_TRANSACTION_ID_MISMATCH')

    const signed = await tronWeb.trx.sign(unsigned)
    if (!Array.isArray(signed?.signature) || signed.signature.length !== 1
      || !/^[0-9a-f]{130}$/i.test(signed.signature[0])
      || String(signed.txID || '').toLowerCase() !== unsigned.txID.toLowerCase()
      || String(signed.raw_data_hex || '').toLowerCase() !== unsigned.raw_data_hex.toLowerCase()) {
      fail('OWNER_SIGNER_SIGNED_TRANSACTION_MISMATCH')
    }
    return signed
  }

  return Object.freeze({
    address: derivedAddress,
    network: 'TRON Mainnet',
    signContractTransaction,
  })
}
