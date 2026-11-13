export const TRON_MAINNET_CHAIN_ID = 728126428
export const META_TX_DOMAIN_NAME = 'TRON Transfer Meta Transaction'
export const META_TX_DOMAIN_VERSION = '1'
export const MAX_META_REQUEST_TTL_SECONDS = 15 * 60

const FORWARD_REQUEST_FIELDS = Object.freeze([
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'gasLimit', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
  { name: 'data', type: 'bytes' },
])

function assertMainnetEndpoint(tronWeb) {
  let hostname = ''
  try { hostname = new URL(String(tronWeb?.fullNode?.host || '')).hostname.toLowerCase() } catch {}
  if (hostname !== 'api.trongrid.io') {
    throw new Error('TronLink must be connected to the configured TRON Mainnet endpoint before preparing or signing a sponsored request.')
  }
}

function uintString(value, label) {
  let parsed
  try { parsed = BigInt(value) } catch { throw new Error(label + ' must be an integer.') }
  if (parsed < 0n) throw new Error(label + ' cannot be negative.')
  return parsed.toString()
}

/**
 * Builds a TIP-712/EIP-712 request for TronLink to sign.
 * This function is local-only: it never broadcasts or signs on its own.
 */
export function createTronMetaTypedData({
  tronWeb,
  from,
  forwarder,
  to,
  data,
  nonce,
  deadline,
  gasLimit = 250000,
  nowSeconds = Math.floor(Date.now() / 1000),
  chainId = TRON_MAINNET_CHAIN_ID,
}) {
  if (chainId !== TRON_MAINNET_CHAIN_ID) throw new Error('Meta-transactions are restricted to TRON Mainnet.')
  assertMainnetEndpoint(tronWeb)
  for (const [label, address] of [['owner', from], ['trusted forwarder', forwarder], ['target', to]]) {
    if (!tronWeb?.isAddress?.(address)) throw new Error('Invalid TRON Mainnet ' + label + ' address.')
  }
  if (typeof data !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(data)) {
    throw new Error('Calldata must be a non-empty 0x-prefixed hex string.')
  }
  const gas = BigInt(uintString(gasLimit, 'Gas limit'))
  if (gas < 25000n || gas > 5_000_000n) throw new Error('Gas limit must be between 25,000 and 5,000,000.')
  const requestNonce = uintString(nonce, 'Nonce')
  const requestDeadline = BigInt(uintString(deadline, 'Deadline'))
  const now = BigInt(uintString(nowSeconds, 'Current time'))
  if (requestDeadline <= now || requestDeadline > now + BigInt(MAX_META_REQUEST_TTL_SECONDS)) {
    throw new Error('Request deadline must be within the next 15 minutes.')
  }

  const message = {
    from,
    to,
    value: '0',
    gasLimit: gas.toString(),
    nonce: requestNonce,
    deadline: requestDeadline.toString(),
    data,
  }
  const typedData = {
    domain: {
      name: META_TX_DOMAIN_NAME,
      version: META_TX_DOMAIN_VERSION,
      chainId: TRON_MAINNET_CHAIN_ID,
      verifyingContract: forwarder,
    },
    types: { ForwardRequest: FORWARD_REQUEST_FIELDS.map((field) => ({ ...field })) },
    primaryType: 'ForwardRequest',
    message,
  }
  return { request: message, typedData }
}

/**
 * Requests a signature from TronLink's documented TIP-712 signer.
 * Signing only: no transaction is submitted and no private key is accessed.
 */
export async function signTronMetaTypedData({ tronWeb, expectedOwner, typedData }) {
  assertMainnetEndpoint(tronWeb)
  if (typedData?.domain?.chainId !== TRON_MAINNET_CHAIN_ID) throw new Error('Refusing to sign typed data for a non-Mainnet chain.')
  const active = tronWeb?.defaultAddress?.base58 || (tronWeb?.defaultAddress?.hex && tronWeb?.address?.fromHex ? tronWeb.address.fromHex(tronWeb.defaultAddress.hex) : '')
  if (!active || active !== expectedOwner) throw new Error('TronLink account changed; reconnect the configured owner wallet.')
  if (typeof tronWeb?.trx?._signTypedData !== 'function') {
    throw new Error('This TronLink version does not expose TIP-712 signing. No fallback signature will be used.')
  }
  const signature = await tronWeb.trx._signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  )
  if (typeof signature !== 'string' || !/^(0x)?[0-9a-f]{130}$/i.test(signature)) {
    throw new Error('TronLink returned an invalid 65-byte typed-data signature.')
  }
  return signature.startsWith('0x') ? signature : '0x' + signature
}
