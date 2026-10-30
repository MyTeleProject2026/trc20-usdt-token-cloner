const TRON_ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const MAX_UINT256 = (1n << 256n) - 1n

export const TESTNET_SANDBOX_NETWORKS = Object.freeze(['nile', 'shasta'])

function requireTestnet(network) {
  if (!TESTNET_SANDBOX_NETWORKS.includes(network)) {
    throw new Error('Only Nile or Shasta testnet is supported. Mainnet is not available in the sandbox.')
  }
}

function requireAddress(value, label) {
  if (typeof value !== 'string' || !TRON_ADDRESS_PATTERN.test(value.trim())) {
    throw new Error(`${label} must be a 34-character TRON Base58 address.`)
  }
  return value.trim()
}

export function parseSandboxUnits(value, decimals) {
  if (typeof value !== 'string' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('Enter a valid decimal amount and token precision.')
  }
  const raw = value.trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$/.test(raw)) {
    throw new Error('Amount must be a positive decimal number without commas or scientific notation.')
  }
  const [whole, fraction = ''] = raw.split('.')
  if (fraction.length > decimals) {
    throw new Error(`This asset supports at most ${decimals} decimal places.`)
  }
  const units = BigInt((whole + fraction.padEnd(decimals, '0')) || '0')
  if (units <= 0n) throw new Error('Amount must be greater than zero.')
  if (units > MAX_UINT256) throw new Error('Amount exceeds the supported token integer range.')
  return units.toString()
}

/**
 * Creates a browser-memory-only review object. It deliberately has no RPC,
 * wallet, signing, persistence, transaction ID, or broadcast capability.
 */
export function createTestnetPreview(input, now = Date.now()) {
  if (!input || typeof input !== 'object') throw new Error('Transfer preview details are required.')
  requireTestnet(input.network)

  const from = requireAddress(input.from, 'Sender')
  const to = requireAddress(input.to, 'Recipient')
  if (from === to) throw new Error('Sender and recipient must be different addresses.')

  const asset = input.asset
  if (asset !== 'TRX' && asset !== 'TRC20') throw new Error('Choose TRX or a TRC-20 test token.')

  const decimals = asset === 'TRX' ? 6 : Number(input.decimals)
  const amountBaseUnits = parseSandboxUnits(input.amount, decimals)

  let tokenContract = null
  let symbol = 'TRX'
  if (asset === 'TRC20') {
    tokenContract = requireAddress(input.tokenContract, 'Test token contract')
    if (tokenContract === OFFICIAL_MAINNET_USDT) {
      throw new Error('The official Mainnet USDT contract cannot be used as a testnet token identity.')
    }
    symbol = typeof input.symbol === 'string' ? input.symbol.trim().toUpperCase() : ''
    if (!/^[A-Z0-9._-]{1,12}$/.test(symbol)) {
      throw new Error('Test token symbol must contain 1–12 letters, numbers, dots, underscores or hyphens.')
    }
  }

  if (!Number.isFinite(now) || now < 0) throw new Error('Preview timestamp is invalid.')

  return Object.freeze({
    mode: 'local-preview',
    network: input.network,
    asset,
    from,
    to,
    tokenContract,
    symbol,
    decimals,
    amount: input.amount.trim(),
    amountBaseUnits,
    status: 'preview-only',
    createdAt: new Date(now).toISOString(),
    signatureRequested: false,
    broadcasted: false,
    transactionId: null,
    networkRequestMade: false,
  })
}
