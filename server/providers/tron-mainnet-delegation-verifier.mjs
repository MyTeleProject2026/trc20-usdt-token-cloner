import { createHash } from 'node:crypto'

const MAINNET = 'https://api.trongrid.io'
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID = /^[0-9a-f]{64}$/i
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Decode(value) {
  let n = 0n
  for (const char of value) {
    const digit = ALPHABET.indexOf(char)
    if (digit < 0) throw new Error('invalid-base58-address')
    n = n * 58n + BigInt(digit)
  }
  let hex = n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  let bytes = Buffer.from(hex, 'hex')
  let zeroes = 0
  while (zeroes < value.length && value[zeroes] === '1') zeroes++
  if (zeroes) bytes = Buffer.concat([Buffer.alloc(zeroes), bytes])
  if (bytes.length !== 25) throw new Error('invalid-address-length')
  const body = bytes.subarray(0, 21)
  const checksum = createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4)
  if (!checksum.equals(bytes.subarray(21))) throw new Error('invalid-address-checksum')
  return body.toString('hex')
}

function base58Encode(hex) {
  const bytes = Buffer.from(hex, 'hex')
  if (bytes.length !== 21 || bytes[0] !== 0x41) throw new Error('invalid-tron-hex-address')
  const checksum = createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest().subarray(0, 4)
  const payload = Buffer.concat([bytes, checksum])
  let n = BigInt('0x' + payload.toString('hex'))
  let encoded = ''
  while (n > 0n) {
    const rem = Number(n % 58n)
    encoded = ALPHABET[rem] + encoded
    n /= 58n
  }
  let zeroes = 0
  while (zeroes < payload.length && payload[zeroes] === 0) zeroes++
  return '1'.repeat(zeroes) + encoded
}

function uint(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)) return value
  return null
}

/**
 * Verifies a provider-reported Stake 2.0 delegation using solidified TRON
 * state only. It does not submit transactions or require a wallet private key.
 *
 * A successful result means:
 * - the exact transaction body exists in SolidityNode state;
 * - the solidified execution receipt reports SUCCESS and the same txID;
 * - the transaction is a DelegateResourceContract to the requested owner;
 * - the solidified delegation record exists for that delegator/recipient pair;
 * - aggregate currently available Mainnet Energy and Bandwidth meet the request.
 */
export function createTronMainnetDelegationVerifier({
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  async function post(path, body) {
    const response = await fetchImpl(MAINNET + path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response?.ok) throw new Error('tron-mainnet-solidity-api-unavailable')
    const payload = await response.json()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.Error || payload.error) {
      throw new Error('tron-mainnet-invalid-solidified-response')
    }
    return payload
  }

  async function verifyDelegation({ ownerAddress, transactionId, required, network = 'mainnet' }) {
    if (network !== 'mainnet' || !ADDRESS.test(ownerAddress ?? '') || !TXID.test(transactionId ?? '')
      || !required || !uint(required.ENERGY) || !uint(required.BANDWIDTH)) {
      return { verified: false, solidified: false, network: 'mainnet', status: 'invalid-verification-request' }
    }
    try {
      const [transaction, receipt] = await Promise.all([
        post('/walletsolidity/gettransactionbyid', { value: transactionId }),
        post('/walletsolidity/gettransactioninfobyid', { value: transactionId }),
      ])
      if (transaction.txID?.toLowerCase() !== transactionId.toLowerCase()
        || receipt.id?.toLowerCase() !== transactionId.toLowerCase()
        || receipt.receipt?.result !== 'SUCCESS'
        || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber <= 0) {
        return { verified: false, solidified: false, network: 'mainnet', transactionId, status: 'solidified-transaction-or-receipt-not-successful' }
      }
      const contracts = transaction.raw_data?.contract
      if (!Array.isArray(contracts) || contracts.length === 0
        || contracts.some((contract) => contract?.type !== 'DelegateResourceContract')) {
        return { verified: false, solidified: true, network: 'mainnet', transactionId, status: 'not-resource-delegation-transaction' }
      }

      // A provider may delegate Energy and Bandwidth in separate operations
      // within one transaction. Verify every operation's recipient, owner and
      // resource type; never infer the requested grant from aggregate balances.
      const expected = {
        ENERGY: BigInt(required.ENERGY),
        BANDWIDTH: BigInt(required.BANDWIDTH),
      }
      const transactionAmounts = { ENERGY: 0n, BANDWIDTH: 0n }
      const delegators = new Set()
      for (const contract of contracts) {
        const value = contract?.parameter?.value
        const receiverHex = typeof value?.receiver_address === 'string' ? value.receiver_address.toLowerCase() : ''
        const ownerHex = typeof value?.owner_address === 'string' ? value.owner_address.toLowerCase() : ''
        const resourceType = value?.resource
        const amountSun = uint(value?.balance)
        if (receiverHex !== base58Decode(ownerAddress).toLowerCase()
          || !/^41[0-9a-f]{40}$/.test(ownerHex)
          || !['ENERGY', 'BANDWIDTH'].includes(resourceType)
          || amountSun === null || amountSun === '0') {
          return { verified: false, solidified: true, network: 'mainnet', ownerAddress, transactionId, status: 'delegation-recipient-owner-or-resource-mismatch' }
        }
        transactionAmounts[resourceType] += BigInt(amountSun)
        delegators.add(base58Encode(ownerHex))
      }
      if (transactionAmounts.ENERGY < expected.ENERGY
        || transactionAmounts.BANDWIDTH < expected.BANDWIDTH) {
        return {
          verified: false, solidified: true, network: 'mainnet', ownerAddress, transactionId,
          status: 'transaction-does-not-delegate-each-required-resource',
          transactionDelegated: {
            ENERGY: transactionAmounts.ENERGY.toString(),
            BANDWIDTH: transactionAmounts.BANDWIDTH.toString(),
          },
        }
      }

      // Confirm each delegator/recipient pair in solidified state and require
      // its currently recorded stake to cover the exact amounts in this tx.
      const delegationSnapshots = await Promise.all([...delegators].map(async (delegatorAddress) => {
        const snapshot = await post('/walletsolidity/getdelegatedresourcev2', {
          fromAddress: delegatorAddress, toAddress: ownerAddress, visible: true,
        })
        const records = Array.isArray(snapshot.delegatedResource) ? snapshot.delegatedResource : []
        const matching = records.filter((entry) => entry.from === delegatorAddress && entry.to === ownerAddress)
        const totals = { ENERGY: 0n, BANDWIDTH: 0n }
        for (const entry of matching) {
          for (const resourceType of ['ENERGY', 'BANDWIDTH']) {
            const field = resourceType === 'ENERGY' ? entry.frozen_balance_for_energy : entry.frozen_balance_for_bandwidth
            const amount = uint(field ?? 0)
            if (amount === null) throw new Error('invalid-solidified-delegation-record')
            totals[resourceType] += BigInt(amount)
          }
        }
        return { delegatorAddress, totals }
      }))
      const recordedTotals = { ENERGY: 0n, BANDWIDTH: 0n }
      for (const snapshot of delegationSnapshots) {
        recordedTotals.ENERGY += snapshot.totals.ENERGY
        recordedTotals.BANDWIDTH += snapshot.totals.BANDWIDTH
      }
      if (recordedTotals.ENERGY < transactionAmounts.ENERGY
        || recordedTotals.BANDWIDTH < transactionAmounts.BANDWIDTH) {
        return { verified: false, solidified: true, network: 'mainnet', ownerAddress, transactionId, status: 'solidified-delegation-record-does-not-cover-transaction' }
      }
      const [resourceState] = await Promise.all([
        post('/walletsolidity/getaccountresource', { address: ownerAddress, visible: true }),
      ])
      const energyLimit = uint(resourceState.EnergyLimit ?? 0)
      const energyUsed = uint(resourceState.EnergyUsed ?? 0)
      const bandwidthLimit = uint(resourceState.NetLimit ?? 0)
      const bandwidthUsed = uint(resourceState.NetUsed ?? 0)
      const freeBandwidthLimit = uint(resourceState.freeNetLimit ?? 0)
      const freeBandwidthUsed = uint(resourceState.freeNetUsed ?? 0)
      if ([energyLimit, energyUsed, bandwidthLimit, bandwidthUsed, freeBandwidthLimit, freeBandwidthUsed].some((v) => v === null)
        || BigInt(energyUsed) > BigInt(energyLimit)
        || BigInt(bandwidthUsed) > BigInt(bandwidthLimit)
        || BigInt(freeBandwidthUsed) > BigInt(freeBandwidthLimit)) {
        return { verified: false, solidified: true, network: 'mainnet', ownerAddress, transactionId, status: 'invalid-solidified-resource-state' }
      }
      const ENERGY = (BigInt(energyLimit) - BigInt(energyUsed)).toString()
      const BANDWIDTH = (BigInt(bandwidthLimit) - BigInt(bandwidthUsed)
        + BigInt(freeBandwidthLimit) - BigInt(freeBandwidthUsed)).toString()
      const sufficient = BigInt(ENERGY) >= BigInt(required.ENERGY)
        && BigInt(BANDWIDTH) >= BigInt(required.BANDWIDTH)
      return {
        verified: sufficient,
        solidified: true,
        network: 'mainnet',
        ownerAddress,
        transactionId,
        delegatorAddress,
        blockNumber: receipt.blockNumber,
        ENERGY,
        BANDWIDTH,
        required: { ENERGY: required.ENERGY, BANDWIDTH: required.BANDWIDTH },
        status: sufficient ? 'solidified-delegation-and-resource-coverage-verified' : 'solidified-delegation-found-resources-insufficient',
      }
    } catch {
      return { verified: false, solidified: false, network: 'mainnet', ownerAddress, transactionId, status: 'mainnet-solidified-verification-unavailable' }
    }
  }

  return Object.freeze({ verifyDelegation })
}
