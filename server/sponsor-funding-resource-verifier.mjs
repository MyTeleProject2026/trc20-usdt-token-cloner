const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const UINT_PATTERN = /^(?:0|[1-9][0-9]{0,77})$/
const BLOCK_ID_PATTERN = /^[0-9a-f]{64}$/i
const MAX_AGE_MS = 60_000
const MAX_FUTURE_SKEW_MS = 5_000
const MIN_PLATFORM_USDT_BASE_UNITS = 1_000_000_000n

function uint(value) {
  if (typeof value !== 'string' || !UINT_PATTERN.test(value)) return null
  try { return BigInt(value) } catch { return null }
}

function fresh(observedAt, now, maxAgeMs) {
  return Number.isSafeInteger(observedAt)
    && Number.isSafeInteger(now)
    && observedAt <= now + MAX_FUTURE_SKEW_MS
    && now - observedAt <= maxAgeMs
}

function available(limit, used) {
  const l = uint(limit)
  const u = uint(used)
  return l === null || u === null ? null : (l > u ? l - u : 0n)
}

/**
 * Reconcile two independently obtained, read-only observations:
 *  - a solidified TRON Mainnet account/token/resource snapshot; and
 *  - an authenticated custody-provider vault/asset availability snapshot.
 *
 * This module does not fetch either observation. Production wiring must supply
 * observations from independently configured, authenticated read-only clients.
 * Source labels and evidence IDs are metadata, not cryptographic proof by
 * themselves. A passing result is readiness evidence only, never payout
 * authorization and never permission to sign or broadcast.
 */
export function verifySponsorFundingAndTronResources({
  expected = {},
  chainObservation = {},
  custodyObservation = {},
  now = Date.now(),
  maxAgeMs = MAX_AGE_MS,
} = {}) {
  const reasons = []
  const add = (condition, reason) => { if (!condition) reasons.push(reason) }

  const organizationId = typeof expected.organizationId === 'string' ? expected.organizationId.trim() : ''
  const vaultId = typeof expected.vaultId === 'string' ? expected.vaultId.trim() : ''
  const sponsorAddress = typeof expected.sponsorAddress === 'string' ? expected.sponsorAddress.trim() : ''
  const minimumUsdt = uint(expected.minimumUsdtBaseUnits)
  const minimumTrx = uint(expected.minimumTrxSun)
  const minimumBandwidth = uint(expected.minimumBandwidthUnits)
  const minimumEnergy = uint(expected.minimumEnergyUnits)

  add(Boolean(organizationId), 'expected-organization-id-missing')
  add(Boolean(vaultId), 'expected-vault-id-missing')
  add(ADDRESS_PATTERN.test(sponsorAddress), 'expected-sponsor-address-invalid')
  add(minimumUsdt !== null && minimumUsdt >= MIN_PLATFORM_USDT_BASE_UNITS, 'minimum-usdt-threshold-invalid')
  add(minimumTrx !== null && minimumTrx > 0n, 'minimum-trx-threshold-invalid')
  add(minimumBandwidth !== null, 'minimum-bandwidth-threshold-invalid')
  add(minimumEnergy !== null, 'minimum-energy-threshold-invalid')
  add(Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= MAX_AGE_MS, 'maximum-evidence-age-invalid')
  add(Number.isSafeInteger(now), 'verification-clock-invalid')

  const chain = chainObservation && typeof chainObservation === 'object' ? chainObservation : {}
  const custody = custodyObservation && typeof custodyObservation === 'object' ? custodyObservation : {}
  add(chain.source === 'tron-mainnet-readonly-rpc', 'trusted-tron-read-source-missing')
  add(chain.network === 'TRON_MAINNET', 'chain-network-not-tron-mainnet')
  add(chain.sponsorAddress === sponsorAddress, 'chain-sponsor-address-mismatch')
  add(chain.accountExists === true, 'sponsor-mainnet-account-not-confirmed')
  add(typeof chain.blockId === 'string' && BLOCK_ID_PATTERN.test(chain.blockId), 'solidified-block-id-invalid')
  add(Number.isSafeInteger(chain.blockNumber) && chain.blockNumber > 0, 'solidified-block-number-invalid')
  add(fresh(chain.observedAt, now, maxAgeMs), 'chain-observation-stale-or-future-dated')
  add(chain.finality === 'solidified', 'chain-observation-not-solidified')

  const chainUsdt = uint(chain.usdtBalanceBaseUnits)
  const chainTrx = uint(chain.trxBalanceSun)
  add(chain.usdtContract === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'chain-usdt-contract-mismatch')
  add(chain.usdtDecimals === 6, 'chain-usdt-decimals-mismatch')
  add(chainUsdt !== null, 'chain-usdt-balance-invalid')
  add(chainTrx !== null, 'chain-trx-balance-invalid')

  const freeBandwidth = available(chain.resources?.freeNetLimit, chain.resources?.freeNetUsed)
  const paidBandwidth = available(chain.resources?.netLimit, chain.resources?.netUsed)
  const energy = available(chain.resources?.energyLimit, chain.resources?.energyUsed)
  add(freeBandwidth !== null && paidBandwidth !== null && energy !== null, 'chain-resource-observation-invalid')
  const bandwidth = freeBandwidth !== null && paidBandwidth !== null ? freeBandwidth + paidBandwidth : null

  add(custody.source === 'custody-provider-readonly-vault', 'trusted-custody-read-source-missing')
  add(custody.organizationId === organizationId, 'custody-organization-mismatch')
  add(custody.vaultId === vaultId, 'custody-vault-mismatch')
  add(custody.sponsorAddress === sponsorAddress, 'custody-sponsor-address-mismatch')
  add(custody.network === 'TRON_MAINNET', 'custody-network-mismatch')
  add(typeof custody.observationId === 'string' && custody.observationId.trim().length >= 8, 'custody-observation-id-missing')
  add(fresh(custody.observedAt, now, maxAgeMs), 'custody-observation-stale-or-future-dated')

  const custodyUsdt = uint(custody.usdtAvailableBaseUnits)
  const custodyTrx = uint(custody.trxAvailableSun)
  add(custody.usdtContract === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'custody-usdt-contract-mismatch')
  add(custody.usdtDecimals === 6, 'custody-usdt-decimals-mismatch')
  add(custodyUsdt !== null, 'custody-usdt-available-balance-invalid')
  add(custodyTrx !== null, 'custody-trx-available-balance-invalid')
  add(chainUsdt !== null && custodyUsdt !== null && custodyUsdt <= chainUsdt, 'custody-usdt-exceeds-chain-balance')
  add(chainTrx !== null && custodyTrx !== null && custodyTrx <= chainTrx, 'custody-trx-exceeds-chain-balance')

  const spendableUsdt = chainUsdt !== null && custodyUsdt !== null
    ? (chainUsdt < custodyUsdt ? chainUsdt : custodyUsdt) : null
  const spendableTrx = chainTrx !== null && custodyTrx !== null
    ? (chainTrx < custodyTrx ? chainTrx : custodyTrx) : null

  add(spendableUsdt !== null && minimumUsdt !== null && spendableUsdt >= minimumUsdt, 'verified-spendable-usdt-below-required-minimum')
  add(spendableTrx !== null && minimumTrx !== null && spendableTrx >= minimumTrx, 'verified-spendable-trx-below-required-minimum')
  add(bandwidth !== null && minimumBandwidth !== null && bandwidth >= minimumBandwidth, 'available-bandwidth-below-required-minimum')
  add(energy !== null && minimumEnergy !== null && energy >= minimumEnergy, 'available-energy-below-required-minimum')

  const passed = reasons.length === 0
  return Object.freeze({
    schema: 'tron-transfer.sponsor-funding-resource-verification.v1',
    status: passed ? 'observations-reconciled-not-cryptographically-attested' : 'blocked-unverified-or-insufficient',
    reconciled: passed,
    verified: false,
    reasons: Object.freeze(reasons),
    evidence: Object.freeze({
      chainSource: chain.source || null,
      chainBlockNumber: Number.isSafeInteger(chain.blockNumber) ? chain.blockNumber : null,
      chainBlockId: typeof chain.blockId === 'string' && BLOCK_ID_PATTERN.test(chain.blockId) ? chain.blockId.toLowerCase() : null,
      custodySource: custody.source || null,
      custodyObservationId: typeof custody.observationId === 'string' ? custody.observationId : null,
      observedAt: {
        chain: Number.isSafeInteger(chain.observedAt) ? chain.observedAt : null,
        custody: Number.isSafeInteger(custody.observedAt) ? custody.observedAt : null,
      },
    }),
    balances: Object.freeze({
      chainUsdtBaseUnits: chainUsdt?.toString() ?? null,
      custodyUsdtAvailableBaseUnits: custodyUsdt?.toString() ?? null,
      reconciledSpendableUsdtBaseUnits: spendableUsdt?.toString() ?? null,
      chainTrxSun: chainTrx?.toString() ?? null,
      custodyTrxAvailableSun: custodyTrx?.toString() ?? null,
      reconciledSpendableTrxSun: spendableTrx?.toString() ?? null,
    }),
    resources: Object.freeze({
      freeBandwidthUnits: freeBandwidth?.toString() ?? null,
      paidBandwidthUnits: paidBandwidth?.toString() ?? null,
      availableBandwidthUnits: bandwidth?.toString() ?? null,
      availableEnergyUnits: energy?.toString() ?? null,
    }),
    limitations: Object.freeze({
      providerObservationsCryptographicallyAttestedByThisModule: false,
      sandboxBalancesAccepted: false,
      payoutAuthorized: false,
      signerProviderContacted: false,
      signingRequestCreated: false,
      signatureProduced: false,
      transactionSigned: false,
      broadcastAttempted: false,
      mainnetExecutionEnabled: false,
    }),
  })
}

export default verifySponsorFundingAndTronResources
