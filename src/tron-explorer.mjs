const EXPLORER_ORIGINS = Object.freeze({
  mainnet: 'https://tronscan.org',
  nile: 'https://nile.tronscan.org',
  shasta: 'https://shasta.tronscan.org',
})

const TRANSACTION_ID = /^[0-9a-f]{64}$/i
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

/**
 * Returns an official TronScan transaction URL only for a known network and
 * a structurally valid TRON transaction ID. This is a read-only explorer link,
 * not a bridge, token converter, transfer submission, or proof of exchange credit.
 * @param {unknown} network
 * @param {unknown} transactionId
 * @returns {string | null}
 */
export function getTronScanTransactionUrl(network, transactionId) {
  const origin = typeof network === 'string' ? EXPLORER_ORIGINS[network] : undefined
  if (!origin || typeof transactionId !== 'string' || !TRANSACTION_ID.test(transactionId)) return null
  return `${origin}/#/transaction/${transactionId.toLowerCase()}`
}

/**
 * Returns an official TronScan address page URL for a known network and a
 * structurally valid Base58Check-shaped TRON address.
 * @param {unknown} network
 * @param {unknown} address
 * @returns {string | null}
 */
export function getTronScanAddressUrl(network, address) {
  const origin = typeof network === 'string' ? EXPLORER_ORIGINS[network] : undefined
  if (!origin || typeof address !== 'string' || !TRON_ADDRESS.test(address)) return null
  return `${origin}/#/address/${encodeURIComponent(address)}`
}

/**
 * Network-specific explorer label. Unknown networks deliberately have no label.
 * @param {unknown} network
 * @returns {string | null}
 */
export function getTronScanNetworkLabel(network) {
  if (network === 'mainnet') return 'Mainnet TronScan'
  if (network === 'nile') return 'Nile TronScan'
  if (network === 'shasta') return 'Shasta TronScan'
  return null
}
