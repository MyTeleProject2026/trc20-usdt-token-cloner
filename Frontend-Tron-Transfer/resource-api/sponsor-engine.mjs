import { TronWeb } from 'tronweb'
import { createMainnetTronWeb, postMainnetRead } from './mainnet-rpc-provider.mjs'
import { assertTransactionIntegrity, verifyTransactionSigner, assertTransactionPermission } from '../src/tron-mainnet-preflight.mjs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const MAINNET = 'https://api.trongrid.io'
const SUN = 1_000_000n
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID = /^[0-9a-f]{64}$/i
const RESOURCE_CODE = { BANDWIDTH: 0, ENERGY: 1 }

function positiveSun(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,20}$/.test(value)) return null
  const amount = BigInt(value)
  return amount <= (1n << 63n) - 1n ? amount : null
}
function decimalTrxToSun(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * SUN + BigInt((fraction + '000000').slice(0, 6))
}
function safeCode(error) {
  const message = String(error?.message || '')
  if (/timeout|abort/i.test(message)) return 'mainnet-rpc-timeout'
  if (/balance|insufficient/i.test(message)) return 'insufficient-sponsor-balance'
  if (/signer-address-mismatch/i.test(message)) return 'sponsor-signer-address-mismatch'
  if (/signed-transaction-integrity-failed/i.test(message)) return 'signed-transaction-integrity-failed'
  return 'sponsor-transaction-failed'
}
function addressFromHex(tronWeb, value) {
  try { return tronWeb.address.fromHex(String(value || '').replace(/^0x/i, '')) } catch { return '' }
}
function resourceCode(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return String(value || '').toUpperCase() === 'ENERGY' ? 1 : String(value || '').toUpperCase() === 'BANDWIDTH' ? 0 : -1
}
function assertTransaction(transaction, { tronWeb, operation, resource, amountSun, sponsorAddress, ownerAddress }) {
  const contracts = transaction?.raw_data?.contract
  const expectedType = ({
    stake: 'FreezeBalanceV2Contract', delegate: 'DelegateResourceContract',
    undelegate: 'UnDelegateResourceContract', unstake: 'UnfreezeBalanceV2Contract',
    withdraw: 'WithdrawExpireUnfreezeContract', topup: 'TransferContract',
  })[operation]
  if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== expectedType) throw new Error('unsigned-transaction-contract-mismatch')
  const value = contracts[0]?.parameter?.value || {}
  if (addressFromHex(tronWeb, value.owner_address) !== sponsorAddress) throw new Error('unsigned-transaction-sponsor-mismatch')
  if (operation === 'topup') {
    if (addressFromHex(tronWeb, value.to_address) !== ownerAddress) throw new Error('unsigned-transaction-recipient-mismatch')
    if (String(value.amount ?? '') !== amountSun) throw new Error('unsigned-transaction-amount-mismatch')
  } else if (operation === 'withdraw') {
    // WithdrawExpireUnfreezeContract withdraws all currently matured unfreeze value.
  } else {
    if (resourceCode(value.resource) !== RESOURCE_CODE[resource]) throw new Error('unsigned-transaction-resource-mismatch')
    const amount = operation === 'stake' ? value.frozen_balance
      : operation === 'unstake' ? value.unfreeze_balance : value.balance
    if (String(amount ?? '') !== amountSun) throw new Error('unsigned-transaction-amount-mismatch')
    if (operation === 'delegate' || operation === 'undelegate') {
      if (addressFromHex(tronWeb, value.receiver_address) !== ownerAddress) throw new Error('unsigned-transaction-recipient-mismatch')
      if (operation === 'delegate' && (value.lock === true || value.lock === 1 || ['true', '1'].includes(String(value.lock).toLowerCase()))) throw new Error('locked-delegation-not-allowed')
    }
  }
  const expiration = Number(transaction?.raw_data?.expiration)
  if (!Number.isSafeInteger(expiration) || expiration <= Date.now() + 2_000 || expiration > Date.now() + 10 * 60_000) throw new Error('unsigned-transaction-expiration-invalid')
  if (!TXID.test(String(transaction?.txID || '')) || !/^(?:[0-9a-f]{2})+$/i.test(String(transaction?.raw_data_hex || ''))) throw new Error('unsigned-transaction-bytes-invalid')
}


export async function verifySponsorSignedTransaction({
  tronWeb, unsignedTransaction, signedTransaction, operation, resource, amountSun,
  sponsorAddress, ownerAddress,
} = {}) {
  if (!tronWeb || !ADDRESS.test(sponsorAddress || '') || !ADDRESS.test(ownerAddress || '') || sponsorAddress === ownerAddress
    || !unsignedTransaction || !signedTransaction
    || signedTransaction.txID !== unsignedTransaction.txID
    || signedTransaction.raw_data_hex !== unsignedTransaction.raw_data_hex
    || !isDeepStrictEqual(signedTransaction.raw_data, unsignedTransaction.raw_data)
    || !Array.isArray(signedTransaction.signature) || signedTransaction.signature.length !== 1
    || !/^[0-9a-f]{130}$/i.test(signedTransaction.signature[0])) {
    throw new Error('signed-transaction-integrity-failed')
  }
  assertTransaction(unsignedTransaction, { tronWeb, operation, resource, amountSun, sponsorAddress, ownerAddress })
  assertTransactionIntegrity(tronWeb, unsignedTransaction, 'Prepared Sponsor transaction')
  assertTransactionIntegrity(tronWeb, signedTransaction, 'Signed Sponsor transaction')
  verifyTransactionSigner(tronWeb, signedTransaction, sponsorAddress)
  await assertTransactionPermission(tronWeb, signedTransaction, sponsorAddress)
  return { verified: true, sponsorAddress, ownerAddress, transactionId: unsignedTransaction.txID }
}

export function createSponsorTransactionEngine({
  env = process.env,
  fetchImpl = globalThis.fetch,
  // This engine is a read/preparation/broadcast adapter only. It deliberately
  // cannot construct a TronWeb instance with private-key signing material.
  tronWebFactory = null,
  now = () => Date.now(),
} = {}) {
  const makeTronWeb = typeof tronWebFactory === 'function'
    ? tronWebFactory
    : () => createMainnetTronWeb({ env, fetchImpl })
  const ownerAddress = env.TRON_OWNER_ADDRESS || env.TRON_OWNER_WALLET_ADDRESS || ''
  function readiness() {
    const sponsorAddress = env.SPONSOR_MAINNET_ADDRESS
    const ownerAddressValid = ADDRESS.test(ownerAddress)
    const sponsorAddressValid = ADDRESS.test(sponsorAddress || '')
    const addressesIndependent = ownerAddressValid && sponsorAddressValid && ownerAddress !== sponsorAddress
    const enabled = env.SPONSOR_TRANSACTION_ENGINE_ENABLED === 'true'
      && env.SPONSOR_MAINNET_BROADCAST_ENABLED === 'true'
    const maxFeeRaw = env.SPONSOR_MAX_TX_FEE_SUN ?? '0'
    const feeCapValid = maxFeeRaw === '0' || positiveSun(String(maxFeeRaw)) !== null
    const reserveTrx = String(env.SPONSOR_LIQUID_RESERVE_TRX || '2')
    const reserveAmountSun = decimalTrxToSun(reserveTrx)
    const reserveValid = reserveAmountSun !== null && reserveAmountSun > 0n
    // Manual Sponsor principal amounts have no application-level business cap.
    // Every operation is still bounded by fresh on-chain balance, protected
    // reserve, resource/delegation state, transaction fees and protocol rules.
    const stakingEnabled = enabled
    const ownerTopupEnabled = enabled
    const policyValid = feeCapValid && reserveValid
    return {
      configured: addressesIndependent && policyValid,
      signerMode: 'client-local-vault',
      signerConfigured: false,
      serverSignerConfigured: false,
      ownerAddressValid,
      sponsorAddressValid,
      addressesIndependent,
      enabled,
      ownerAddress: ownerAddressValid ? ownerAddress : null,
      sponsorAddress: sponsorAddressValid ? sponsorAddress : null,
      databaseRequired: true,
      broadcastAvailable: enabled && addressesIndependent && policyValid,
      clientSigningAvailable: enabled && addressesIndependent && policyValid,
      stakingPolicy: { enabled: stakingEnabled, amountLimitMode: 'live-balance-minus-reserve' },
      ownerTopupPolicy: { enabled: ownerTopupEnabled, amountLimitMode: 'live-balance-minus-reserve' },
      feePolicy: {
        valid: policyValid,
        maxBandwidthFeeSun: String(maxFeeRaw),
        protectedReserveTrx: reserveTrx,
      },
    }
  }

  async function verifySolidified({ transactionId, operation, resource, amountSun, sponsorAddress, ownerAddress: recipient }) {
    if (!TXID.test(transactionId || '')) return { confirmed: false, status: 'invalid-transaction-id' }
    const post = (path, body) => postMainnetRead(path, body, { env, fetchImpl })
    const info = await post('/walletsolidity/gettransactioninfobyid', { value: transactionId })
    if (String(info?.id || '').toLowerCase() !== transactionId.toLowerCase()
      || !Number.isSafeInteger(info.blockNumber) || info.blockNumber <= 0) return { confirmed: false, status: 'not-solidified' }
    if (info.receipt?.result !== 'SUCCESS') return { confirmed: false, status: 'solidified-execution-failed', blockNumber: info.blockNumber }
    const tx = await post('/walletsolidity/gettransactionbyid', { value: transactionId })
    if (String(tx?.txID || '').toLowerCase() !== transactionId.toLowerCase()) return { confirmed: false, status: 'solidified-transaction-id-mismatch' }
    const contracts = tx.raw_data?.contract
    const expectedType = ({
      stake: 'FreezeBalanceV2Contract', delegate: 'DelegateResourceContract',
      undelegate: 'UnDelegateResourceContract', unstake: 'UnfreezeBalanceV2Contract',
      withdraw: 'WithdrawExpireUnfreezeContract', topup: 'TransferContract',
    })[operation]
    if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== expectedType) return { confirmed: false, status: 'solidified-operation-type-mismatch' }
    const value = contracts[0]?.parameter?.value || {}
    const verifier = new TronWeb({ fullHost: MAINNET })
    if (addressFromHex(verifier, value.owner_address) !== sponsorAddress) return { confirmed: false, status: 'solidified-sponsor-mismatch' }
    if (operation === 'topup') {
      if (addressFromHex(verifier, value.to_address) !== recipient) return { confirmed: false, status: 'solidified-recipient-mismatch' }
      if (String(value.amount ?? '') !== String(amountSun)) return { confirmed: false, status: 'solidified-amount-mismatch' }
      return { confirmed: true, status: 'solidified-success', blockNumber: info.blockNumber }
    }
    if (operation === 'withdraw') {
      // The solidified receipt must report the actual Stake 2.0 withdrawal.
      // An absent field is not proof of a successful amount transfer.
      const withdrawn = info.withdraw_expire_amount
      if (withdrawn === undefined || withdrawn === null) {
        return { confirmed: false, status: 'solidified-withdraw-amount-unavailable', blockNumber: info.blockNumber }
      }
      if (typeof withdrawn === 'number' && !Number.isSafeInteger(withdrawn)) {
        return { confirmed: false, status: 'solidified-withdraw-amount-unsafe-precision', blockNumber: info.blockNumber }
      }
      if (!/^(?:0|[1-9][0-9]*)$/.test(String(withdrawn)) || String(withdrawn) !== String(amountSun)) {
        return { confirmed: false, status: 'solidified-withdraw-amount-mismatch', blockNumber: info.blockNumber }
      }
      return { confirmed: true, status: 'solidified-success', blockNumber: info.blockNumber }
    }
    if (resourceCode(value.resource) !== RESOURCE_CODE[resource]) return { confirmed: false, status: 'solidified-resource-mismatch' }
    const recordedAmount = operation === 'stake' ? value.frozen_balance
      : operation === 'unstake' ? value.unfreeze_balance : value.balance
    if (String(recordedAmount ?? '') !== String(amountSun)) return { confirmed: false, status: 'solidified-amount-mismatch' }
    if (operation === 'delegate' || operation === 'undelegate') {
      if (addressFromHex(verifier, value.receiver_address) !== recipient) return { confirmed: false, status: 'solidified-recipient-mismatch' }
      if (operation === 'delegate' && (value.lock === true || value.lock === 1 || ['true', '1'].includes(String(value.lock).toLowerCase()))) return { confirmed: false, status: 'solidified-locked-delegation' }
      if (operation === 'delegate') {
        const delegated = await post('/walletsolidity/getdelegatedresourcev2', { fromAddress: sponsorAddress, toAddress: recipient, visible: true })
        const rows = Array.isArray(delegated?.delegatedResource) ? delegated.delegatedResource : []
        const field = resource === 'ENERGY' ? 'frozen_balance_for_energy' : 'frozen_balance_for_bandwidth'
        const actual = rows.reduce((sum, row) => sum + BigInt(String(row?.[field] || '0')), 0n)
        if (actual < BigInt(amountSun)) return { confirmed: false, status: 'delegation-state-not-yet-visible', blockNumber: info.blockNumber }
      }
    }
    return { confirmed: true, status: 'solidified-success', blockNumber: info.blockNumber }
  }

  async function reconcile({ transactionId, operation, amountSun, resource, sponsorAddress, ownerAddress: recipient } = {}) {
    const validOperation = ['stake', 'delegate', 'undelegate', 'unstake', 'withdraw', 'topup'].includes(operation)
    const validResource = ['topup', 'withdraw'].includes(operation) ? resource === 'TRX' : ['ENERGY', 'BANDWIDTH'].includes(resource)
    if (!TXID.test(transactionId || '') || !validOperation || !validResource || !positiveSun(amountSun)
      || sponsorAddress !== env.SPONSOR_MAINNET_ADDRESS || recipient !== ownerAddress || !ADDRESS.test(recipient || '')) {
      return { confirmed: false, status: 'invalid-reconciliation-request' }
    }
    try { return await verifySolidified({ transactionId, operation, resource, amountSun, sponsorAddress, ownerAddress: recipient }) }
    catch { return { confirmed: false, status: 'solidified-mainnet-read-unavailable' } }
  }


  // Build and preflight the exact unsigned Mainnet transaction. The returned
  // transaction is persisted by the API before it is shown to the local vault.
  async function prepare({ operation, resource, amountSun, ownerAddress: recipient } = {}) {
    const state = readiness()
    if (!state.clientSigningAvailable) return { success: false, status: 'client-local-signer-not-enabled' }
    const validOperation = ['stake', 'delegate', 'undelegate', 'unstake', 'withdraw', 'topup'].includes(operation)
    const validResource = ['topup', 'withdraw'].includes(operation) ? resource === 'TRX' : ['ENERGY', 'BANDWIDTH'].includes(resource)
    if (!validOperation || !validResource || recipient !== ownerAddress || !ADDRESS.test(recipient || '')) return { success: false, status: 'invalid-mainnet-operation' }
    const amount = positiveSun(amountSun)
    if (!amount || (['stake', 'delegate', 'undelegate', 'unstake'].includes(operation) && amount < SUN)) return { success: false, status: 'invalid-amount-sun' }

    try {
      const tronWeb = makeTronWeb()
      const sponsorAddress = env.SPONSOR_MAINNET_ADDRESS
      if (!ADDRESS.test(sponsorAddress || '') || sponsorAddress === recipient) throw new Error('sponsor-signer-address-mismatch')
      const reserve = decimalTrxToSun(String(env.SPONSOR_LIQUID_RESERVE_TRX || '2'))
      const maxFeeRaw = env.SPONSOR_MAX_TX_FEE_SUN ?? '0'
      const maxFee = maxFeeRaw === '0' ? 0n : positiveSun(String(maxFeeRaw))
      if (reserve === null || maxFee === null) throw new Error('invalid-sponsor-fee-policy')
      const balance = BigInt(await tronWeb.trx.getBalance(sponsorAddress))
      if ((operation === 'stake' || operation === 'topup') && balance < amount + reserve) return { success: false, status: 'insufficient-balance-after-reserve' }
      if (!['stake', 'topup'].includes(operation) && balance < reserve) return { success: false, status: 'insufficient-fee-reserve' }
      if (operation === 'delegate') {
        const maximumResult = await tronWeb.trx.getCanDelegatedMaxSize(sponsorAddress, resource, { confirmed: true })
        const maximum = BigInt(String(maximumResult?.max_size ?? maximumResult ?? '0'))
        if (maximum < amount) return { success: false, status: 'insufficient-frozen-resource-capacity' }
      }
      if (operation === 'undelegate') {
        const reader = tronWeb.trx.raw || tronWeb.trx
        const delegated = await reader.getDelegatedResourceV2(sponsorAddress, recipient, { confirmed: true })
        const rows = Array.isArray(delegated) ? delegated : (Array.isArray(delegated?.delegatedResource) ? delegated.delegatedResource : [])
        const field = resource === 'ENERGY' ? 'frozen_balance_for_energy' : 'frozen_balance_for_bandwidth'
        if (rows.reduce((sum, row) => sum + BigInt(String(row?.[field] || '0')), 0n) < amount) return { success: false, status: 'undelegation-exceeds-current-owner-delegation' }
      }
      if (operation === 'unstake') {
        const reader = tronWeb.trx.raw || tronWeb.trx
        const [account, delegated, slots] = await Promise.all([
          reader.getAccount(sponsorAddress, { confirmed: true }),
          reader.getDelegatedResourceV2(sponsorAddress, recipient, { confirmed: true }),
          reader.getAvailableUnfreezeCount(sponsorAddress, { confirmed: true }),
        ])
        const frozen = Array.isArray(account?.frozenV2) ? account.frozenV2 : []
        const type = resource === 'ENERGY' ? 'ENERGY' : 'BANDWIDTH'
        const selfStaked = frozen.filter(row => (row.type || 'BANDWIDTH') === type).reduce((sum, row) => sum + BigInt(String(row.amount || '0')), 0n)
        const rows = Array.isArray(delegated) ? delegated : (Array.isArray(delegated?.delegatedResource) ? delegated.delegatedResource : [])
        const field = resource === 'ENERGY' ? 'frozen_balance_for_energy' : 'frozen_balance_for_bandwidth'
        const delegatedAmount = rows.reduce((sum, row) => sum + BigInt(String(row?.[field] || '0')), 0n)
        if (Number(slots?.count ?? 0) <= 0 || (selfStaked > delegatedAmount ? selfStaked - delegatedAmount : 0n) < amount) return { success: false, status: 'unstake-exceeds-unlocked-self-stake-or-no-slots' }
      }
      if (operation === 'withdraw') {
        const reader = tronWeb.trx.raw || tronWeb.trx
        const withdrawable = await reader.getCanWithdrawUnfreezeAmount(sponsorAddress, now(), { confirmed: true })
        const actual = BigInt(String(withdrawable?.amount ?? withdrawable ?? '0'))
        if (actual <= 0n || actual !== amount) return { success: false, status: 'withdraw-amount-changed-refresh-and-retry' }
      }
      const transaction = operation === 'stake'
        ? await tronWeb.transactionBuilder.freezeBalanceV2(amount.toString(), resource, sponsorAddress)
        : operation === 'delegate'
          ? await tronWeb.transactionBuilder.delegateResource(amount.toString(), recipient, resource, false, 0, sponsorAddress)
          : operation === 'undelegate'
            ? await tronWeb.transactionBuilder.undelegateResource(amount.toString(), recipient, resource, sponsorAddress)
            : operation === 'unstake'
              ? await tronWeb.transactionBuilder.unfreezeBalanceV2(amount.toString(), resource, sponsorAddress)
              : operation === 'withdraw'
                ? await tronWeb.transactionBuilder.withdrawExpireUnfreeze(sponsorAddress)
                : await tronWeb.transactionBuilder.sendTrx(recipient, amount.toString(), sponsorAddress)
      assertTransaction(transaction, { tronWeb, operation, resource, amountSun: amount.toString(), sponsorAddress, ownerAddress: recipient })
      assertTransactionIntegrity(tronWeb, transaction, 'Prepared Sponsor transaction')
      const accountResources = await tronWeb.trx.getAccountResources(sponsorAddress)
      const freeBandwidth = Math.max(0, Number(accountResources.freeNetLimit || 0) - Number(accountResources.freeNetUsed || 0))
      const stakedBandwidth = Math.max(0, Number(accountResources.NetLimit || 0) - Number(accountResources.NetUsed || 0))
      // Match the deployment preflight: a transaction must fit within one available Bandwidth quota.
      const availableBandwidth = Math.max(freeBandwidth, stakedBandwidth)
      const transactionBytes = Buffer.from(transaction.raw_data_hex, 'hex').length + 100
      const chainParameters = await tronWeb.trx.getChainParameters()
      const bandwidthFee = Number((chainParameters || []).find(item => item.key === 'getTransactionFee')?.value || 0)
      if (!Number.isSafeInteger(transactionBytes) || transactionBytes <= 0 || !Number.isSafeInteger(bandwidthFee) || bandwidthFee <= 0) throw new Error('mainnet-bandwidth-preflight-unavailable')
      const requiredFeeSun = BigInt(Math.max(0, transactionBytes - availableBandwidth)) * BigInt(bandwidthFee)
      if (requiredFeeSun > maxFee) return { success: false, status: 'bandwidth-shortfall-exceeds-authorized-fee-cap' }
      const requiredBalance = (operation === 'stake' || operation === 'topup' ? amount : 0n) + reserve + requiredFeeSun
      if (balance < requiredBalance) return { success: false, status: 'insufficient-balance-for-authorized-fee-cap' }
      return {
        success: true, status: 'prepared', transaction: structuredClone(transaction),
        sponsorAddress, ownerAddress: recipient, operation, resource, amountSun: amount.toString(),
        feePolicy: { reserveSun: reserve.toString(), maxBandwidthFeeSun: maxFee.toString(), requiredBandwidthFeeSun: requiredFeeSun.toString() },
      }
    } catch (error) {
      return { success: false, status: safeCode(error) }
    }
  }

  // Verify a client-signed payload against the exact transaction retained by
  // the API, ask the Mainnet node to validate the recovered signer/permission,
  // persist txID before broadcast, and reconcile only that original txID.
  async function submitSigned({ signedTransaction, preparedTransaction, operation, resource, amountSun, ownerAddress: recipient, onSigned } = {}) {
    const state = readiness()
    if (!state.clientSigningAvailable) return { success: false, status: 'client-local-signer-not-enabled', signed: false, broadcast: false }
    const sponsorAddress = env.SPONSOR_MAINNET_ADDRESS
    let signed = false
    let broadcastAttempted = false
    try {
      const tronWeb = makeTronWeb()
      await verifySponsorSignedTransaction({
        tronWeb, unsignedTransaction: preparedTransaction, signedTransaction,
        operation, resource, amountSun, sponsorAddress, ownerAddress: recipient,
      })
      const amount = positiveSun(String(amountSun))
      if (!amount) throw new Error('invalid-amount-sun')

      if (operation === 'delegate') {
        const maximumResult = await tronWeb.trx.getCanDelegatedMaxSize(sponsorAddress, resource, { confirmed: true })
        const maximum = BigInt(String(maximumResult?.max_size ?? maximumResult ?? '0'))
        if (maximum < amount) throw new Error('insufficient-frozen-resource-capacity')
      }
      if (operation === 'undelegate') {
        const reader = tronWeb.trx.raw || tronWeb.trx
        const delegated = await reader.getDelegatedResourceV2(sponsorAddress, recipient, { confirmed: true })
        const rows = Array.isArray(delegated) ? delegated : (Array.isArray(delegated?.delegatedResource) ? delegated.delegatedResource : [])
        const field = resource === 'ENERGY' ? 'frozen_balance_for_energy' : 'frozen_balance_for_bandwidth'
        const current = rows.reduce((sum, row) => sum + BigInt(String(row?.[field] || '0')), 0n)
        if (current < amount) throw new Error('undelegation-exceeds-current-owner-delegation')
      }
      if (operation === 'unstake') {
        const reader = tronWeb.trx.raw || tronWeb.trx
        const [account, delegated, slots] = await Promise.all([
          reader.getAccount(sponsorAddress, { confirmed: true }),
          reader.getDelegatedResourceV2(sponsorAddress, recipient, { confirmed: true }),
          reader.getAvailableUnfreezeCount(sponsorAddress, { confirmed: true }),
        ])
        const type = resource === 'ENERGY' ? 'ENERGY' : 'BANDWIDTH'
        const frozen = Array.isArray(account?.frozenV2) ? account.frozenV2 : []
        const selfStaked = frozen.filter(row => (row.type || 'BANDWIDTH') === type).reduce((sum, row) => sum + BigInt(String(row.amount || '0')), 0n)
        const rows = Array.isArray(delegated) ? delegated : (Array.isArray(delegated?.delegatedResource) ? delegated.delegatedResource : [])
        const field = resource === 'ENERGY' ? 'frozen_balance_for_energy' : 'frozen_balance_for_bandwidth'
        const delegatedAmount = rows.reduce((sum, row) => sum + BigInt(String(row?.[field] || '0')), 0n)
        if (Number(slots?.count ?? 0) <= 0 || (selfStaked > delegatedAmount ? selfStaked - delegatedAmount : 0n) < amount) throw new Error('unstake-exceeds-unlocked-self-stake-or-no-slots')
      }
      if (operation === 'withdraw') {
        const reader = tronWeb.trx.raw || tronWeb.trx
        const withdrawable = await reader.getCanWithdrawUnfreezeAmount(sponsorAddress, now(), { confirmed: true })
        const actual = BigInt(String(withdrawable?.amount ?? withdrawable ?? '0'))
        if (actual <= 0n || actual !== amount) throw new Error('withdraw-amount-changed-refresh-and-retry')
      }
      const balance = BigInt(await tronWeb.trx.getBalance(sponsorAddress))
      const reserve = decimalTrxToSun(String(env.SPONSOR_LIQUID_RESERVE_TRX || '2'))
      const maxFeeRaw = env.SPONSOR_MAX_TX_FEE_SUN ?? '0'
      const maxFee = maxFeeRaw === '0' ? 0n : positiveSun(String(maxFeeRaw))
      if (reserve === null || maxFee === null) throw new Error('invalid-sponsor-fee-policy')
      const resources = await tronWeb.trx.getAccountResources(sponsorAddress)
      const freeBandwidth = Math.max(0, Number(resources.freeNetLimit || 0) - Number(resources.freeNetUsed || 0))
      const stakedBandwidth = Math.max(0, Number(resources.NetLimit || 0) - Number(resources.NetUsed || 0))
      const bytes = Buffer.from(preparedTransaction.raw_data_hex, 'hex').length + 100
      const parameters = await tronWeb.trx.getChainParameters()
      const bandwidthFee = Number((parameters || []).find(item => item.key === 'getTransactionFee')?.value || 0)
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isSafeInteger(bandwidthFee) || bandwidthFee <= 0) throw new Error('mainnet-bandwidth-preflight-unavailable')
      const bandwidthFeeSun = BigInt(Math.max(0, bytes - Math.max(freeBandwidth, stakedBandwidth))) * BigInt(bandwidthFee)
      if (bandwidthFeeSun > maxFee) throw new Error('bandwidth-shortfall-exceeds-authorized-fee-cap')
      const principal = ['stake', 'topup'].includes(operation) ? BigInt(String(amountSun)) : 0n
      if (balance < principal + reserve + bandwidthFeeSun) throw new Error('insufficient-balance-for-authorized-fee-cap')

      const reader = tronWeb.trx.raw || tronWeb.trx
      if (operation === 'delegate') {
        const maximumResult = await tronWeb.trx.getCanDelegatedMaxSize(sponsorAddress, resource, { confirmed: true })
        if (BigInt(String(maximumResult?.max_size ?? maximumResult ?? '0')) < BigInt(amountSun)) throw new Error('insufficient-frozen-resource-capacity')
      }
      if (operation === 'undelegate') {
        const delegated = await reader.getDelegatedResourceV2(sponsorAddress, recipient, { confirmed: true })
        const rows = Array.isArray(delegated) ? delegated : (Array.isArray(delegated?.delegatedResource) ? delegated.delegatedResource : [])
        const field = resource === 'ENERGY' ? 'frozen_balance_for_energy' : 'frozen_balance_for_bandwidth'
        if (rows.reduce((sum, row) => sum + BigInt(String(row?.[field] || '0')), 0n) < BigInt(amountSun)) throw new Error('undelegation-exceeds-current-owner-delegation')
      }
      if (operation === 'unstake') {
        const [account, delegated, slots] = await Promise.all([
          reader.getAccount(sponsorAddress, { confirmed: true }),
          reader.getDelegatedResourceV2(sponsorAddress, recipient, { confirmed: true }),
          reader.getAvailableUnfreezeCount(sponsorAddress, { confirmed: true }),
        ])
        const type = resource === 'ENERGY' ? 'ENERGY' : 'BANDWIDTH'
        const selfStaked = (Array.isArray(account?.frozenV2) ? account.frozenV2 : [])
          .filter(row => (row.type || 'BANDWIDTH') === type)
          .reduce((sum, row) => sum + BigInt(String(row.amount || '0')), 0n)
        const rows = Array.isArray(delegated) ? delegated : (Array.isArray(delegated?.delegatedResource) ? delegated.delegatedResource : [])
        const field = resource === 'ENERGY' ? 'frozen_balance_for_energy' : 'frozen_balance_for_bandwidth'
        const delegatedAmount = rows.reduce((sum, row) => sum + BigInt(String(row?.[field] || '0')), 0n)
        if (Number(slots?.count ?? 0) <= 0 || (selfStaked > delegatedAmount ? selfStaked - delegatedAmount : 0n) < BigInt(amountSun)) throw new Error('unstake-exceeds-unlocked-self-stake-or-no-slots')
      }
      if (operation === 'withdraw') {
        const withdrawable = await reader.getCanWithdrawUnfreezeAmount(sponsorAddress, now(), { confirmed: true })
        if (BigInt(String(withdrawable?.amount ?? withdrawable ?? '0')) !== BigInt(amountSun)) throw new Error('withdraw-amount-changed-refresh-and-retry')
      }
      if (typeof onSigned !== 'function') throw new Error('durable-transaction-id-persistence-required')
      // "signed" means the exact signed payload and transaction ID are durable,
      // not merely that a signature was received in memory.
      await onSigned(preparedTransaction.txID)
      signed = true
      broadcastAttempted = true
      const broadcast = await tronWeb.trx.sendRawTransaction(signedTransaction)
      if (broadcast?.result !== true) return { success: false, status: 'broadcast-rejected-or-unknown', txid: preparedTransaction.txID, signed: true, broadcast: true }
      const verification = await verifySolidified({ transactionId: preparedTransaction.txID, operation, resource, amountSun: String(amountSun), sponsorAddress, ownerAddress: recipient })
      return {
        success: verification.confirmed, status: verification.status, txid: preparedTransaction.txID,
        blockNumber: verification.blockNumber || null, sponsorAddress, ownerAddress: recipient,
        operation, resource, amountSun: String(amountSun), signed: true, broadcast: true,
        solidified: verification.confirmed, checkedAt: new Date(now()).toISOString(),
      }
    } catch (error) {
      return { success: false, status: broadcastAttempted ? 'broadcast-outcome-unknown' : signed ? 'signed-not-broadcast' : safeCode(error), txid: preparedTransaction?.txID || null, signed, broadcast: broadcastAttempted, solidified: false }
    }
  }

  return Object.freeze({ readiness, prepare, submitSigned, reconcile })
}

