const PRICE_ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price?ids=tron%2Ctether&vs_currencies=usd&include_last_updated_at=true'
const MAX_PRICE_AGE_MS = 5 * 60 * 1000

export async function fetchTRXReferencePrice({ fetchImpl = fetch, now = Date.now, maxAgeMs = MAX_PRICE_AGE_MS } = {}) {
  const response = await fetchImpl(PRICE_ENDPOINT, { headers: { Accept: 'application/json' }, cache: 'no-store' })
  if (!response?.ok) throw new Error('Live TRX reference-price provider is unavailable.')
  const data = await response.json()
  const tronUsd = Number(data?.tron?.usd)
  const usdtUsd = Number(data?.tether?.usd)
  const updatedAt = Number(data?.tron?.last_updated_at) * 1000
  if (!Number.isFinite(tronUsd) || tronUsd <= 0 || !Number.isFinite(usdtUsd) || usdtUsd <= 0) {
    throw new Error('Price provider returned an invalid TRX or USDT quote.')
  }
  if (!Number.isFinite(updatedAt) || updatedAt <= 0 || now() - updatedAt > maxAgeMs || updatedAt > now() + 30000) {
    throw new Error('TRX reference-price quote is missing or stale; no live valuation will be shown.')
  }
  // TRӾ has no verified exchange listing, liquidity pool, redemption peg, or
  // independent price oracle. Never manufacture a TRӾ market quote by adding
  // a tiny amount to the unrelated native TRX price.
  return {
    trxUsd: Number(tronUsd.toFixed(6)),
    traxReferenceUsd: null,
    usdtUsd,
    updatedAt,
    source: 'CoinGecko native TRX and USDT quotes; no verified TRӾ market quote',
  }
}

export function calculatePortfolioValue({ trx = '0', trax = '0', usdt = '0', prices }) {
  if (!prices || ![prices.trxUsd, prices.usdtUsd].every((value) => Number.isFinite(Number(value)) && Number(value) > 0)) {
    return null
  }
  const quantities = [trx, trax, usdt].map((value) => Number(value))
  if (!quantities.every((value) => Number.isFinite(value) && value >= 0)) return null
  // A combined USD total is incomplete whenever the wallet holds TRӾ because
  // there is no independently verified TRӾ market price.
  if (quantities[1] > 0) return null
  const trxUsd = quantities[0] * Number(prices.trxUsd)
  const usdtUsd = quantities[2] * Number(prices.usdtUsd)
  return {
    trxUsd,
    traxReferenceUsd: null,
    usdtUsd,
    totalUsd: trxUsd + usdtUsd,
    valuationType: 'partial-reference-estimate',
  }
}
