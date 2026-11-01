import { createHash } from 'node:crypto'
import { tatumProviderFetch } from './tatum-provider-fetch.mjs'
import { verifyTronSolidifiedBlock } from './tron-solidified-block-proof.mjs'
import { verifyTronDposSolidification } from './tron-dpos-finality.mjs'

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


function comparableValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return 'number:' + String(value)
  if (typeof value === 'bigint') return 'number:' + value.toString()
  if (typeof value === 'string') {
    if (/^-?(0|[1-9][0-9]*)$/.test(value)) return 'number:' + BigInt(value).toString()
    if (/^(?:0x)?[0-9a-f]+$/i.test(value)) return 'hex:' + value.replace(/^0x/i, '').toLowerCase()
    return 'string:' + value
  }
  return value
}

function isDefaultProtoValue(value) {
  return value === undefined || value === null || value === false || value === 0 || value === 0n
    || value === '' || value === '0'
    || (Array.isArray(value) && value.length === 0)
    || (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
}

function decodedValueMatchesJson(decodedValue, jsonValue) {
  if (!decodedValue || typeof decodedValue !== 'object' || Array.isArray(decodedValue)
    || !jsonValue || typeof jsonValue !== 'object' || Array.isArray(jsonValue)) return false
  const keys = new Set([...Object.keys(decodedValue), ...Object.keys(jsonValue)])
  for (const key of keys) {
    if (!Object.hasOwn(decodedValue, key) && isDefaultProtoValue(jsonValue[key])) continue
    if (!Object.hasOwn(jsonValue, key) && isDefaultProtoValue(decodedValue[key])) continue
    const decoded = decodedValue[key]
    const exposed = jsonValue[key]
    if (decoded && typeof decoded === 'object' && exposed && typeof exposed === 'object') {
      if (Array.isArray(decoded) || Array.isArray(exposed)) {
        if (!Array.isArray(decoded) || !Array.isArray(exposed)
          || decoded.length !== exposed.length
          || decoded.some((item, index) => comparableValue(item) !== comparableValue(exposed[index]))) return false
      } else if (!decodedValueMatchesJson(decoded, exposed)) return false
    } else if (comparableValue(decoded) !== comparableValue(exposed)) return false
  }
  return true
}

function decodeAndVerifyBlockContracts(block, tronWeb) {
  if (!Array.isArray(block?.transactions)) throw Object.assign(new Error('block-transactions-missing'), { code: 'block-transactions-missing' })
  const deserialize = tronWeb?.utils?.deserializeTx?.deserializeTransaction
  if (typeof deserialize !== 'function') {
    throw Object.assign(new Error('tronweb-transaction-decoder-unavailable'), { code: 'tronweb-transaction-decoder-unavailable' })
  }
  return block.transactions.map((transaction) => {
    const jsonContracts = transaction?.raw_data?.contract
    if (!Array.isArray(jsonContracts) || jsonContracts.length !== 1) {
      throw Object.assign(new Error('transaction-contract-list-invalid'), { code: 'transaction-contract-list-invalid' })
    }
    const jsonContract = jsonContracts[0]
    if (typeof jsonContract?.type !== 'string' || !jsonContract.parameter
      || typeof jsonContract.parameter !== 'object') {
      throw Object.assign(new Error('transaction-contract-json-invalid'), { code: 'transaction-contract-json-invalid' })
    }
    if ((jsonContract.provider && jsonContract.provider !== '')
      || (jsonContract.ContractName && jsonContract.ContractName !== '')) {
      throw Object.assign(new Error('transaction-contract-provider-metadata-unsupported'), { code: 'transaction-contract-provider-metadata-unsupported' })
    }
    let decoded
    try {
      decoded = deserialize(jsonContract.type, transaction.raw_data_hex)
    } catch {
      throw Object.assign(new Error('transaction-raw-data-protobuf-decode-failed'), { code: 'transaction-raw-data-protobuf-decode-failed' })
    }
    if (!Array.isArray(decoded?.contract) || decoded.contract.length !== 1) {
      throw Object.assign(new Error('transaction-raw-data-contract-decode-incomplete'), { code: 'transaction-raw-data-contract-decode-incomplete' })
    }
    const decodedContract = decoded.contract[0]
    if (decodedContract?.type !== jsonContract.type
      || decodedContract?.parameter?.type_url !== jsonContract.parameter.type_url
      || !decodedValueMatchesJson(decodedContract?.parameter?.value, jsonContract.parameter.value || {})
      || String(decodedContract?.Permission_id ?? 0) !== String(jsonContract.Permission_id ?? jsonContract.permission_id ?? 0)) {
      throw Object.assign(new Error('transaction-json-does-not-match-raw-data-protobuf'), {
        code: 'transaction-json-does-not-match-raw-data-protobuf',
      })
    }
    return decodedContract
  })
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
 * both Tatum and TRONGrid SolidityNodes, checked for matching ordered transaction
 * lists and sequential height/parent linkage, and every transaction's raw_data_hex
 * is hashed to its claimed txID. Any delegation or stake mutation involving
 * either sponsor role invalidates this conservative cross-check. This is not a
 * substitute for cryptographic inclusion proof or independent node/operator review.
 */
export function createSponsorDelegationHistoryVerifier({
  env = process.env,
  fetchImpl = tatumProviderFetch,
  tronWebFactory = async (host, headers) => {
    const { TronWeb } = await import('tronweb')
    return new TronWeb({ fullHost: host, headers })
  },
  timeoutMs = 8000,
  totalTimeoutMs = 90_000,
  maxBlockSpan = MAX_BLOCK_SPAN,
  blockProofVerifier = verifyTronSolidifiedBlock,
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

    const deadlineAt = Date.now() + totalTimeoutMs
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
        const remainingMs = deadlineAt - Date.now()
        if (remainingMs <= 0) {
          throw Object.assign(new Error('historical-delegation-scan-deadline-exceeded'), {
            code: 'historical-delegation-scan-deadline-exceeded',
          })
        }
        const response = await fetchImpl(providerHost + '/walletsolidity/getblockbynum', {
          method: 'POST',
          redirect: 'error',
          headers: providerHeaders,
          body: JSON.stringify({ num: number, visible: false }),
          signal: AbortSignal.timeout(Math.min(timeoutMs, remainingMs)),
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
      const requestWitnessList = async (providerHost, providerHeaders) => {
        const remainingMs = deadlineAt - Date.now()
        if (remainingMs <= 0) {
          throw Object.assign(new Error('historical-delegation-scan-deadline-exceeded'), {
            code: 'historical-delegation-scan-deadline-exceeded',
          })
        }
        const response = await fetchImpl(providerHost + '/walletsolidity/listwitnesses?visible=false', {
          method: 'GET',
          redirect: 'error',
          headers: providerHeaders,
          signal: AbortSignal.timeout(Math.min(timeoutMs, remainingMs)),
        })
        if (!response.ok) {
          throw Object.assign(new Error('provider-http-error'), { providerStatus: response.status })
        }
        const payload = await response.json()
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.Error) {
          throw new Error('invalid-solidified-witness-list-response')
        }
        return payload
      }
      const compareProviderBlocks = (primary, secondary, height) => {
        const primaryProof = blockProofVerifier(primary, height)
        if (primaryProof?.verified !== true) {
          return { proofFailure: 'primary', proofReason: primaryProof?.reason || 'block-proof-unavailable' }
        }
        const secondaryProof = blockProofVerifier(secondary, height)
        if (secondaryProof?.verified !== true) {
          return { proofFailure: 'secondary', proofReason: secondaryProof?.reason || 'block-proof-unavailable' }
        }
        if (!Array.isArray(primary?.transactions) || !Array.isArray(secondary?.transactions)) return null
        let primaryDecodedContracts
        let secondaryDecodedContracts
        try {
          primaryDecodedContracts = decodeAndVerifyBlockContracts(primary, tronWeb)
          secondaryDecodedContracts = decodeAndVerifyBlockContracts(secondary, tronWeb)
        } catch (error) {
          return { proofFailure: 'transaction', proofReason: error?.code || 'transaction-raw-data-decode-failed' }
        }
        const primaryIdentity = blockIdentity(primary, height)
        const secondaryIdentity = blockIdentity(secondary, height)
        if (!primaryIdentity || !secondaryIdentity
          || primaryProof.blockId !== primaryIdentity.blockId
          || secondaryProof.blockId !== secondaryIdentity.blockId
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
            && JSON.stringify(canonicalJson(primaryDecodedContracts[index])) === JSON.stringify(canonicalJson(secondaryDecodedContracts[index]))
        })
        if (!transactionPayloadsMatch) return null
        return {
          identity: primaryIdentity,
          transactionIds: primaryIds,
          decodedContracts: primaryDecodedContracts,
        }
      }

      const [anchorBlock, secondaryAnchorBlock] = await Promise.all([
        requestBlock(anchor.blockNumber, host, headers),
        requestBlock(anchor.blockNumber, secondaryHost, secondaryHeaders),
      ])
      const anchorComparison = compareProviderBlocks(anchorBlock, secondaryAnchorBlock, anchor.blockNumber)
      const anchorIdentity = anchorComparison?.identity
      if (anchorComparison?.proofFailure) {
        return fail(
          anchorComparison.proofFailure === 'transaction'
            ? 'historical-delegation-transaction-data-invalid'
            : 'historical-delegation-block-cryptographic-proof-invalid',
          {
            failedProvider: anchorComparison.proofFailure,
            proofReason: anchorComparison.proofReason,
            failedBlockNumber: anchor.blockNumber,
          },
        )
      }
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
          if (comparison?.proofFailure) {
            return fail(
              comparison.proofFailure === 'transaction'
                ? 'historical-delegation-transaction-data-invalid'
                : 'historical-delegation-block-cryptographic-proof-invalid',
              {
                failedProvider: comparison.proofFailure,
                proofReason: comparison.proofReason,
                failedBlockNumber: height,
              },
            )
          }
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
        for (let transactionIndex = 0; transactionIndex < transactions.length; transactionIndex += 1) {
          const transaction = transactions[transactionIndex]
          const id = transactionIdentity(transaction)
          if (!id) return fail('historical-delegation-transaction-id-invalid', { blockNumber: height })
          scannedTransactionCount += 1
          if (id === hash) {
            targetTransactionCount += 1
            if (height !== blockNumber) return fail('historical-delegation-target-transaction-in-wrong-block')
          }
          const contracts = [comparison.decodedContracts[transactionIndex]]
          if (!contracts[0]) {
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
          // Contract owner fields are taken from raw_data_hex protobuf decoding,
          // not the provider's independently rendered JSON object.
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

      const [primaryWitnessList, secondaryWitnessList] = await Promise.all([
        requestWitnessList(host, headers),
        requestWitnessList(secondaryHost, secondaryHeaders),
      ])
      const finality = verifyTronDposSolidification({
        primaryWitnessList,
        secondaryWitnessList,
        expectedBlockNumber: blockNumber,
      })
      if (!finality.verified) {
        return fail('historical-delegation-dpos-finality-not-verified', {
          finalityReason: finality.reason,
          expectedBlockNumber: blockNumber,
          ...(finality.failedProvider ? { failedProvider: finality.failedProvider } : {}),
          ...(finality.solidifiedHeight === undefined ? {} : { solidifiedHeight: finality.solidifiedHeight }),
          ...(finality.activeWitnessCount === undefined ? {} : { activeWitnessCount: finality.activeWitnessCount }),
          ...(finality.requiredSupportingWitnessCount === undefined ? {} : { requiredSupportingWitnessCount: finality.requiredSupportingWitnessCount }),
          ...(finality.supportingWitnessCount === undefined ? {} : { supportingWitnessCount: finality.supportingWitnessCount }),
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
        finalityEvidence: finality,
        source: 'Tatum and TRONGrid SolidityNode block, transaction, and witness-state cross-check',
        historySourceTrustModel: 'two-provider SolidityNode blocks plus local block-ID, witness-signature, transaction-Merkle and conservative active-witness DPoS threshold recomputation; witness-state snapshots remain provider-reported and are not state-trie proofs',
        primaryProvider: 'Tatum SolidityNode',
        secondaryProvider: 'TRONGrid SolidityNode',
        blockIntegrityCheck: 'protobuf BlockHeader.raw_data SHA-256 recomputation matches the composite blockID; recovered witness ECDSA signer matches witness_address',
        transactionIntegrityCheck: 'full protobuf Transaction messages reconstructed from raw_data_hex, signatures and supported ret fields; java-tron transaction Merkle algorithm recomputed and matched to txTrieRoot',
        delegationSnapshot: preflightEvidence.delegationSnapshot,
      }
    } catch (error) {
      if (error?.code === 'historical-delegation-scan-deadline-exceeded' || Date.now() >= deadlineAt) {
        return fail('historical-delegation-scan-deadline-exceeded', { totalTimeoutMs })
      }
      const status = Number.isInteger(error?.providerStatus) ? 'provider-http-error'
        : 'historical-delegation-history-unavailable'
      return fail(status, Number.isInteger(error?.providerStatus) ? { providerStatus: error.providerStatus } : {})
    }
  }
}
