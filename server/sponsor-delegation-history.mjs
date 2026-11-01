import { createHash } from 'node:crypto'
import { tatumProviderFetch } from './tatum-provider-fetch.mjs'

const NETWORKS = Object.freeze({
  shasta: 'https://tron-shasta.gateway.tatum.io',
  nile: 'https://tron-nile.gateway.tatum.io',
})
const SECONDARY_NETWORKS = Object.freeze({
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io',
})
const TX_ID = /^[0-9a-f]{64}$/i
const HEX_BYTES = /^(?:[0-9a-f]{2})+$/i
const HASH = /^[0-9a-f]{64}$/i
const ADDRESS = /^41[0-9a-f]{40}$/i
const MAX_BLOCK_SPAN = 256

function normalizeAddress(tronWeb, value) {
  if (typeof value !== 'string') return null
  const raw = value.trim().replace(/^0x/i, '')
  if (ADDRESS.test(raw)) return raw.toLowerCase()
  if (/^[0-9a-f]{40}$/i.test(raw)) return `41${raw.toLowerCase()}`
  try {
    if (tronWeb?.isAddress?.(value)) {
      const encoded = String(tronWeb.address.toHex(value) || '').replace(/^0x/i, '')
      return ADDRESS.test(encoded) ? encoded.toLowerCase() : null
    }
  } catch {}
  return null
}

function blockIdentity(block, expectedNumber) {
  const raw = block?.block_header?.raw_data
  const number = raw?.number
  const timestamp = raw?.timestamp
  const blockId = typeof block?.blockID === 'string' ? block.blockID.toLowerCase() : ''
  const parentHash = typeof raw?.parentHash === 'string' ? raw.parentHash.toLowerCase() : ''
  if (!Number.isSafeInteger(number) || number !== expectedNumber
    || !Number.isSafeInteger(timestamp) || timestamp <= 0
    || !HASH.test(blockId) || !HASH.test(parentHash)
    || BigInt('0x' + blockId.slice(0, 16)) !== BigInt(number)) return null
  return { number, timestamp, blockId, parentHash }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
  }
  return value
}

function transactionIdentity(transaction) {
  const txId = typeof transaction?.txID === 'string' ? transaction.txID.toLowerCase() : ''
  const rawDataHex = typeof transaction?.raw_data_hex === 'string' ? transaction.raw_data_hex : ''
  if (!TX_ID.test(txId) || !HEX_BYTES.test(rawDataHex)) return null
  const calculated = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex')
  return calculated === txId ? txId : null
}

function contractAddresses(tronWeb, value) {
  return {
    owner: normalizeAddress(tronWeb, value?.owner_address),
    receiver: normalizeAddress(tronWeb, value?.receiver_address),
  }
}

function isStakeMutationForSponsorPair(contract, tronWeb, sponsor, principal) {
  const type = contract?.type
  const value = contract?.parameter?.value || {}
  const { owner, receiver } = contractAddresses(tronWeb, value)
  const relevantAddresses = new Set([sponsor, principal])
  const related = relevantAddresses.has(owner) || relevantAddresses.has(receiver)

  if (['DelegateResourceContract', 'UnDelegateResourceContract'].includes(type)) {
    return related
      ? { changed: true, reason: 'intervening-resource-delegation-change', contractType: type }
      : null
  }
  if ([
    'FreezeBalanceContract', 'UnfreezeBalanceContract',
    'FreezeBalanceV2Contract', 'UnfreezeBalanceV2Contract',
    'WithdrawExpireUnfreezeContract', 'CancelAllUnfreezeV2Contract',
  ].includes(type)) {
    const legacyDelegationReceiverChanged = ['FreezeBalanceContract', 'UnfreezeBalanceContract'].includes(type)
      && relevantAddresses.has(receiver)
    return relevantAddresses.has(owner) || legacyDelegationReceiverChanged
      ? { changed: true, reason: 'intervening-stake-balance-change', contractType: type }
      : null
  }
  if (typeof type === 'string' && related && /(Delegate|UnDelegate|Freeze|Unfreeze|Stake|Resource)/i.test(type)) {
    return { changed: true, reason: 'unrecognized-resource-state-change', contractType: type }
  }
  return null
}

/**
 * Replays the complete solidified block interval after a preflight anchor.
 *
 * The preflight account/delegation snapshot must have been bracketed by reads of
 * the same SolidityNode head. Every later block is fetched by exact height from
 * the SolidityNode, checked for sequential height/parent linkage, and every
 * transaction's raw_data_hex is hashed to its claimed txID. Any delegation or
 * stake mutation involving either sponsor role invalidates this conservative
 * proof. This is not a substitute for independent node/operator review.
 */
export function createSponsorDelegationHistoryVerifier({
  env = process.env,
  fetchImpl = tatumProviderFetch,
  tronWebFactory = async (host, headers) => {
    const { TronWeb } = await import('tronweb')
    return new TronWeb({ fullHost: host, headers })
  },
  timeoutMs = 8000,
  maxBlockSpan = MAX_BLOCK_SPAN,
} = {}) {
  return async function verifySponsorDelegationHistory({
    transfer, preflightEvidence, transactionHash, blockNumber, blockTimestampMs,
  } = {}) {
    const fail = (status, extra = {}) => ({
      success: false, verified: false, status, reason: status, ...extra,
    })
    const host = NETWORKS[transfer?.network]
    const hash = typeof transactionHash === 'string' ? transactionHash.toLowerCase() : ''
    const anchor = preflightEvidence?.solidifiedAnchor
    if (!host || !TX_ID.test(hash)
      || typeof transfer?.sponsorAddress !== 'string'
      || typeof transfer?.receiverAddress !== 'string'
      || !Number.isSafeInteger(blockNumber) || blockNumber < 1
      || !Number.isSafeInteger(blockTimestampMs) || blockTimestampMs < 1
      || preflightEvidence?.network !== transfer.network
      || preflightEvidence?.sponsorAddress !== transfer.sponsorAddress
      || !anchor || !Number.isSafeInteger(anchor.blockNumber) || anchor.blockNumber < 1
      || !HASH.test(String(anchor.blockId || ''))
      || !Number.isSafeInteger(anchor.blockTimestampMs) || anchor.blockTimestampMs < 1
      || BigInt('0x' + anchor.blockId.slice(0, 16)) !== BigInt(anchor.blockNumber)
      || blockNumber <= anchor.blockNumber) {
      return fail('historical-delegation-proof-input-invalid')
    }
    const span = blockNumber - anchor.blockNumber
    if (!Number.isInteger(maxBlockSpan) || maxBlockSpan < 1 || maxBlockSpan > 2048 || span > maxBlockSpan) {
      return fail('historical-delegation-block-span-exceeds-limit', { blockSpan: span, maxBlockSpan })
    }
    if (typeof env.TATUM_API_KEY !== 'string' || !env.TATUM_API_KEY.trim()) {
      return fail('provider-credentials-missing')
    }
    if (typeof fetchImpl !== 'function') return fail('provider-unavailable')

    try {
      const headers = { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': env.TATUM_API_KEY.trim() }
      const tronWeb = await tronWebFactory(host, headers)
      if (!tronWeb?.isAddress?.(transfer.sponsorAddress) || !tronWeb?.isAddress?.(transfer.receiverAddress)) {
        return fail('historical-delegation-address-invalid')
      }
      const principal = normalizeAddress(tronWeb, transfer.sponsorAddress)
      const feeSponsor = normalizeAddress(tronWeb, preflightEvidence.feeSponsorAddress)
      if (!principal || !feeSponsor || feeSponsor === principal
        || preflightEvidence.delegationSnapshot?.feeSponsorAddress !== preflightEvidence.feeSponsorAddress
        || preflightEvidence.delegationSnapshot?.assetPrincipalAddress !== transfer.sponsorAddress) {
        return fail('historical-delegation-sponsor-pair-invalid')
      }
      const secondaryHost = SECONDARY_NETWORKS[transfer.network]
      const requestBlock = async (number, providerHost, providerHeaders) => {
        const response = await fetchImpl(providerHost + '/walletsolidity/getblockbynum', {
          method: 'POST',
          redirect: 'error',
          headers: providerHeaders,
          body: JSON.stringify({ num: number, visible: false }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) throw Object.assign(new Error('provider-http-error'), { providerStatus: response.status })
        const payload = await response.json()
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.Error) {
          throw new Error('invalid-block-response')
        }
        return payload
      }
      const secondaryHeaders = {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim()
          ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY.trim() } : {}),
      }
      const compareProviderBlocks = (primary, secondary, height) => {
        const primaryIdentity = blockIdentity(primary, height)
        const secondaryIdentity = blockIdentity(secondary, height)
        if (!primaryIdentity || !secondaryIdentity
          || primaryIdentity.blockId !== secondaryIdentity.blockId
          || primaryIdentity.parentHash !== secondaryIdentity.parentHash
          || primaryIdentity.timestamp !== secondaryIdentity.timestamp) return null
        if (!Array.isArray(primary.transactions) || !Array.isArray(secondary.transactions)) return null
        const primaryIds = primary.transactions.map(transactionIdentity)
        const secondaryIds = secondary.transactions.map(transactionIdentity)
        if (primaryIds.some((id) => !id) || secondaryIds.some((id) => !id)
          || primaryIds.length !== secondaryIds.length
          || primaryIds.some((id, index) => id !== secondaryIds[index])) return null
        const transactionPayloadsMatch = primary.transactions.every((transaction, index) => {
          const secondaryTransaction = secondary.transactions[index]
          return typeof transaction.raw_data_hex === 'string'
            && typeof secondaryTransaction.raw_data_hex === 'string'
            && transaction.raw_data_hex.toLowerCase() === secondaryTransaction.raw_data_hex.toLowerCase()
            && JSON.stringify(canonicalJson(transaction.raw_data)) === JSON.stringify(canonicalJson(secondaryTransaction.raw_data))
        })
        if (!transactionPayloadsMatch) return null
        return { identity: primaryIdentity, transactionIds: primaryIds }
      }

      const [anchorBlock, secondaryAnchorBlock] = await Promise.all([
        requestBlock(anchor.blockNumber, host, headers),
        requestBlock(anchor.blockNumber, secondaryHost, secondaryHeaders),
      ])
      const anchorComparison = compareProviderBlocks(anchorBlock, secondaryAnchorBlock, anchor.blockNumber)
      const anchorIdentity = anchorComparison?.identity
      if (!anchorIdentity || anchorIdentity.blockId !== anchor.blockId.toLowerCase()
        || anchorIdentity.timestamp !== anchor.blockTimestampMs) {
        return fail('historical-delegation-anchor-block-mismatch')
      }

      let previous = anchorIdentity
      let targetTransactionCount = 0
      let scannedTransactionCount = 0
      for (let height = anchor.blockNumber + 1; height <= blockNumber; height += 1) {
        const [block, secondaryBlock] = await Promise.all([
          requestBlock(height, host, headers),
          requestBlock(height, secondaryHost, secondaryHeaders),
        ])
        const comparison = compareProviderBlocks(block, secondaryBlock, height)
        const identity = comparison?.identity
        if (!identity) {
          if (Array.isArray(block?.transactions)
            && block.transactions.some((transaction) => !transactionIdentity(transaction))) {
            return fail('historical-delegation-transaction-id-invalid', { blockNumber: height })
          }
          return fail('historical-delegation-secondary-provider-disagreement', { failedBlockNumber: height })
        }
        if (identity.parentHash !== previous.blockId || identity.timestamp <= previous.timestamp) {
          return fail('historical-delegation-block-chain-incomplete', { failedBlockNumber: height })
        }
        const transactions = block.transactions
        for (const transaction of transactions) {
          const id = transactionIdentity(transaction)
          if (!id) return fail('historical-delegation-transaction-id-invalid', { blockNumber: height })
          scannedTransactionCount += 1
          if (id === hash) {
            targetTransactionCount += 1
            if (height !== blockNumber) return fail('historical-delegation-target-transaction-in-wrong-block')
          }
          const contracts = transaction.raw_data?.contract
          if (!Array.isArray(contracts) || contracts.length === 0) {
            return fail('historical-delegation-transaction-contracts-incomplete', { blockNumber: height })
          }
          for (const contract of contracts) {
            const change = isStakeMutationForSponsorPair(contract, tronWeb, feeSponsor, principal)
            if (change) {
              return fail('historical-delegation-state-changed-during-interval', {
                blockNumber: height,
                transactionId: id,
                contractType: change.contractType,
                changeReason: change.reason,
              })
            }
          }
          // Any other transaction initiated by the principal can consume its
          // delegated/free resource pool after the pinned preflight snapshot.
          // Without a transaction-specific resource-source receipt, it makes
          // the target transaction's exact Bandwidth/Energy attribution unclear.
          const principalInitiated = contracts.some((contract) =>
            normalizeAddress(tronWeb, contract?.parameter?.value?.owner_address) === principal)
          if (principalInitiated && id !== hash) {
            return fail('historical-principal-resource-usage-intervened', {
              blockNumber: height,
              transactionId: id,
            })
          }
        }
        previous = identity
      }

      if (targetTransactionCount !== 1 || previous.number !== blockNumber || previous.timestamp !== blockTimestampMs) {
        return fail('historical-delegation-target-block-or-transaction-mismatch', {
          targetTransactionCount,
          targetBlockTimestampMs: previous.timestamp,
        })
      }
      return {
        success: true,
        verified: true,
        status: 'verified',
        network: transfer.network,
        transactionHash: hash,
        blockNumber,
        blockTimestampMs,
        feeSponsorAddress: preflightEvidence.feeSponsorAddress,
        assetPrincipalAddress: transfer.sponsorAddress,
        historyComplete: true,
        anchorStateVerified: true,
        noInterveningDelegationChanges: true,
        verificationMethod: 'solidified-delegation-history-replay',
        anchor: anchorIdentity,
        checkedAt: new Date().toISOString(),
        scannedBlockCount: span,
        scannedTransactionCount,
        source: 'Tatum and TRONGrid SolidityNode walletsolidity/getblockbynum cross-check',
        historySourceTrustModel: 'two-provider-solidified-block-and-transaction-list-match',
        primaryProvider: 'Tatum SolidityNode',
        secondaryProvider: 'TRONGrid SolidityNode',
        blockIntegrityCheck: 'two-provider height/blockID/parentHash/timestamp match; witness signature and protobuf header hash remain provider-trusted',
        transactionIntegrityCheck: 'two-provider ordered txID list match and sha256(raw_data_hex) matches txID; txTrieRoot Merkle inclusion remains provider-trusted',
        delegationSnapshot: preflightEvidence.delegationSnapshot,
      }
    } catch (error) {
      const status = Number.isInteger(error?.providerStatus) ? 'provider-http-error'
        : 'historical-delegation-history-unavailable'
      return fail(status, Number.isInteger(error?.providerStatus) ? { providerStatus: error.providerStatus } : {})
    }
  }
}
