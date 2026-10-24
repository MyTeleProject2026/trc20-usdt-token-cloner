const TATUM_NETWORKS = Object.freeze({
  mainnet: 'https://tron-mainnet.gateway.tatum.io',
  shasta: 'https://tron-shasta.gateway.tatum.io',
  nile: 'https://tron-nile.gateway.tatum.io',
})
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const INTEGER_PATTERN = /^(0|[1-9][0-9]{0,77})$/

function normalizeProviderAddress(tronWeb, value) {
  if (typeof value !== 'string') return null
  try {
    if (value.startsWith('T') && tronWeb.isAddress(value)) {
      const converted = String(tronWeb.address.toHex(value) || '').replace(/^0x/i, '').toLowerCase()
      return /^41[0-9a-f]{40}$/.test(converted) ? converted : null
    }
  } catch {
    return null
  }
  const raw = value.replace(/^0x/i, '').toLowerCase()
  if (/^[0-9a-f]{40}$/.test(raw)) return '41' + raw
  if (/^41[0-9a-f]{40}$/.test(raw)) return raw
  return null
}

function uintText(value, defaultZero = false) {
  if (value === undefined || value === null) return defaultZero ? '0' : null
  if (typeof value === 'string' && INTEGER_PATTERN.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}

/**
 * Reads current solidified Stake-2.0 resource delegations from the configured
 * fee sponsor to the configured asset-principal sponsor. This reader is
 * diagnostic only: it never submits a delegation or transfer and does not
 * authorize a future transaction. A separate transaction audit can be recorded
 * through the existing /sponsorship/resource-delegations/verify endpoint.
 */
export async function readSponsorDelegationSnapshot({
  env = process.env,
  fetchImpl = globalThis.fetch,
  tronWebFactory = async (host) => {
    const { TronWeb } = await import('tronweb')
    return new TronWeb({ fullHost: host })
  },
  timeoutMs = 8000,
  network,
  tronWeb: suppliedTronWeb = null,
  feeSponsorAddress: feeAddressOverride,
  principalSponsorAddress: principalAddressOverride,
} = {}) {
  const fail = (status, extra = {}) => ({
    success: false,
    status,
    network: network ?? null,
    activeEnergyStakeSun: null,
    activeBandwidthStakeSun: null,
    transactionAuditVerified: false,
    checkedAt: new Date().toISOString(),
    ...extra,
  })
  if (typeof network !== 'string' || !Object.hasOwn(TATUM_NETWORKS, network)) {
    return fail('invalid-network')
  }
  const networkKey = network.toUpperCase()
  const feeSponsorAddress = typeof feeAddressOverride === 'string'
    ? feeAddressOverride.trim()
    : typeof env[`SPONSOR_FEE_${networkKey}_ADDRESS`] === 'string'
      ? env[`SPONSOR_FEE_${networkKey}_ADDRESS`].trim() : ''
  const principalSponsorAddress = typeof principalAddressOverride === 'string'
    ? principalAddressOverride.trim()
    : typeof env[`SPONSOR_ASSET_${networkKey}_ADDRESS`] === 'string'
      ? env[`SPONSOR_ASSET_${networkKey}_ADDRESS`].trim() : ''

  if (!feeSponsorAddress || !principalSponsorAddress) {
    return fail('sponsor-role-addresses-not-configured', {
      requiredEnvironment: [
        `SPONSOR_FEE_${networkKey}_ADDRESS`,
        `SPONSOR_ASSET_${networkKey}_ADDRESS`,
      ],
    })
  }
  if (!ADDRESS_PATTERN.test(feeSponsorAddress) || !ADDRESS_PATTERN.test(principalSponsorAddress)) {
    return fail('invalid-sponsor-address')
  }
  if (feeSponsorAddress === principalSponsorAddress) {
    return fail('sponsor-role-addresses-not-distinct')
  }
  if (typeof env.TATUM_API_KEY !== 'string' || !env.TATUM_API_KEY.trim()) {
    return fail('provider-credentials-missing', {
      fromAddress: feeSponsorAddress,
      toAddress: principalSponsorAddress,
      requiredEnvironment: ['TATUM_API_KEY'],
    })
  }
  if (typeof fetchImpl !== 'function') {
    return fail('provider-unavailable', { fromAddress: feeSponsorAddress, toAddress: principalSponsorAddress })
  }

  const base = {
    network,
    fromAddress: feeSponsorAddress,
    toAddress: principalSponsorAddress,
    checkedAt: new Date().toISOString(),
    transactionAuditVerified: false,
  }
  try {
    const host = TATUM_NETWORKS[network]
    const tronWeb = suppliedTronWeb || await tronWebFactory(host)
    if (typeof tronWeb?.isAddress !== 'function'
      || typeof tronWeb?.address?.toHex !== 'function'
      || !tronWeb.isAddress(feeSponsorAddress)
      || !tronWeb.isAddress(principalSponsorAddress)) {
      return { ...fail('invalid-sponsor-address'), ...base }
    }
    const expectedFrom = normalizeProviderAddress(tronWeb, feeSponsorAddress)
    const expectedTo = normalizeProviderAddress(tronWeb, principalSponsorAddress)
    if (!expectedFrom || !expectedTo) return { ...fail('invalid-sponsor-address'), ...base }

    const response = await fetchImpl(host + '/walletsolidity/getdelegatedresourcev2', {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-api-key': env.TATUM_API_KEY.trim() },
      body: JSON.stringify({
        fromAddress: tronWeb.address.toHex(feeSponsorAddress),
        toAddress: tronWeb.address.toHex(principalSponsorAddress),
        visible: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      return {
        ...base,
        success: false,
        status: 'solidified-delegation-read-unavailable',
        providerStatus: response.status,
        activeEnergyStakeSun: null,
        activeBandwidthStakeSun: null,
      }
    }
    const payload = await response.json()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.Error) {
      throw new Error('invalid-delegation-response')
    }
    const rows = Array.isArray(payload.delegatedResource)
      ? payload.delegatedResource
      : (payload.from && payload.to ? [payload] : [])
    let energyTotal = 0n
    let bandwidthTotal = 0n
    let latestEnergyExpiry = null
    let latestBandwidthExpiry = null
    let matchedRows = 0
    const now = Date.now()

    for (const row of rows) {
      if (!row || typeof row !== 'object') throw new Error('invalid-delegation-row')
      if (normalizeProviderAddress(tronWeb, row.from) !== expectedFrom
        || normalizeProviderAddress(tronWeb, row.to) !== expectedTo) continue
      matchedRows += 1
      const energyText = uintText(row.frozen_balance_for_energy, true)
      const bandwidthText = uintText(row.frozen_balance_for_bandwidth, true)
      if (energyText === null || bandwidthText === null) throw new Error('invalid-delegation-balance')
      const energy = BigInt(energyText)
      const bandwidth = BigInt(bandwidthText)
      // Missing expiry fields are not evidence of an active delegation. Treat
      // incomplete provider rows as unavailable rather than assuming they never expire.
      if (row.expire_time_for_energy === undefined || row.expire_time_for_energy === null
        || row.expire_time_for_bandwidth === undefined || row.expire_time_for_bandwidth === null) {
        throw new Error('missing-delegation-expiry')
      }
      const energyExpiry = Number(row.expire_time_for_energy)
      const bandwidthExpiry = Number(row.expire_time_for_bandwidth)
      if (!Number.isSafeInteger(energyExpiry) || energyExpiry < 0
        || !Number.isSafeInteger(bandwidthExpiry) || bandwidthExpiry < 0) {
        throw new Error('invalid-delegation-expiry')
      }
      const energyActive = energyExpiry === 0 || energyExpiry > now
      const bandwidthActive = bandwidthExpiry === 0 || bandwidthExpiry > now
      if (energyActive) {
        energyTotal += energy
        if (energy > 0n && energyExpiry !== null && energyExpiry > 0) {
          latestEnergyExpiry = Math.max(latestEnergyExpiry || 0, energyExpiry)
        }
      }
      if (bandwidthActive) {
        bandwidthTotal += bandwidth
        if (bandwidth > 0n && bandwidthExpiry !== null && bandwidthExpiry > 0) {
          latestBandwidthExpiry = Math.max(latestBandwidthExpiry || 0, bandwidthExpiry)
        }
      }
    }

    return {
      ...base,
      success: true,
      status: matchedRows === 0
        ? 'solidified-no-delegation-observed'
        : energyTotal > 0n || bandwidthTotal > 0n
          ? 'solidified-delegation-state-read'
          : 'solidified-no-active-delegation-observed',
      activeEnergyStakeSun: energyTotal.toString(),
      activeBandwidthStakeSun: bandwidthTotal.toString(),
      activeEnergyExpiry: latestEnergyExpiry,
      activeBandwidthExpiry: latestBandwidthExpiry,
      matchingDelegationRows: matchedRows,
      source: 'Tatum SolidityNode getdelegatedresourcev2',
      note: 'Current solidified resource allocation between the exact configured fee sponsor and asset-principal sponsor. SUN values are stake-equivalent balances, not Energy or Bandwidth units. This is not a transfer audit record or authorization to submit a transfer.',
    }
  } catch {
    return {
      ...base,
      success: false,
      status: 'solidified-delegation-read-unavailable',
      activeEnergyStakeSun: null,
      activeBandwidthStakeSun: null,
    }
  }
}
