import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID = /^[0-9a-f]{64}$/i

function mac(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex')
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right) || left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export function createRemoteSponsorSigner({
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
  requestId = randomUUID,
} = {}) {
  const endpoint = String(env.SPONSOR_SIGNER_URL || '').trim()
  const address = String(env.SPONSOR_MAINNET_ADDRESS || '').trim()
  const secret = env.SPONSOR_SIGNER_HMAC_SECRET
  const timeoutMs = Math.min(15_000, Math.max(1_000, Number(env.SPONSOR_SIGNER_TIMEOUT_MS) || 8_000))
  const configured = Boolean(endpoint && address && ADDRESS.test(address) && typeof secret === 'string' && secret.length >= 32)
  let parsedEndpoint
  try {
    parsedEndpoint = new URL(endpoint)
    if (parsedEndpoint.protocol !== 'https:') throw new Error('https-required')
  } catch { parsedEndpoint = null }

  return Object.freeze({
    address,
    readiness: () => ({
      configured: configured && Boolean(parsedEndpoint),
      mode: 'remote-hmac',
      address,
    }),
    async signTransaction(unsignedTransaction) {
      if (!configured || !parsedEndpoint) throw new Error('remote-sponsor-signer-not-configured')
      if (!unsignedTransaction || !TXID.test(unsignedTransaction.txID || '')
        || typeof unsignedTransaction.raw_data_hex !== 'string'
        || !/^(?:[0-9a-f]{2})+$/i.test(unsignedTransaction.raw_data_hex)
        || !unsignedTransaction.raw_data || !Array.isArray(unsignedTransaction.raw_data.contract)) {
        throw new Error('remote-sponsor-signer-invalid-transaction')
      }
      // TRON transaction IDs are SHA-256(raw_data bytes). Verify locally so
      // the remote service cannot be asked to sign a mismatched txID/body pair.
      const computedTxId = createHash('sha256').update(Buffer.from(unsignedTransaction.raw_data_hex, 'hex')).digest('hex')
      if (computedTxId !== unsignedTransaction.txID.toLowerCase()) {
        throw new Error('remote-sponsor-signer-transaction-id-mismatch')
      }
      const id = requestId()
      const timestamp = String(now())
      const payload = JSON.stringify({
        requestId: id,
        txID: unsignedTransaction.txID,
        raw_data_hex: unsignedTransaction.raw_data_hex,
        raw_data: unsignedTransaction.raw_data,
      })
      const signature = mac(secret, [timestamp, id, payload].join('.'))
      const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-sponsor-signer-timestamp': timestamp,
            'x-sponsor-signer-request-id': id,
            'x-sponsor-signer-signature': signature,
          },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) throw new Error('remote-sponsor-signer-http-' + response.status)
        const result = await response.json()
        const signed = result?.signedTransaction
        if (result?.requestId !== id || !signed || signed.txID !== unsignedTransaction.txID
          || signed.raw_data_hex !== unsignedTransaction.raw_data_hex
          || JSON.stringify(signed.raw_data) !== JSON.stringify(unsignedTransaction.raw_data)
          || !Array.isArray(signed.signature) || signed.signature.length === 0
          || signed.signature.some(item => typeof item !== 'string' || !/^[0-9a-f]{130}$/i.test(item))) {
          throw new Error('remote-sponsor-signer-response-integrity-failed')
        }
        const responseMac = mac(secret, [id, signed.txID, signed.raw_data_hex, signed.signature.join(',')].join('.'))
        if (!safeEqual(responseMac, result.responseMac)) throw new Error('remote-sponsor-signer-response-authentication-failed')
      return signed
    },
  })
}
