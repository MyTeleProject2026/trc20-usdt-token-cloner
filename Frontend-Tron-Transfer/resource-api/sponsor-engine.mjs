import { TronWeb } from 'tronweb'

const MAINNET = 'https://api.trongrid.io'
const OWNER_FALLBACK = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
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
  if (/timeout|abort/i.test(message)) return 'provider-timeout'
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

export function createSponsorTransactionEngine({
  env = process.env,
  fetchImpl = globalThis.fetch,
  tronWebFactory = (privateKey) => new TronWeb({
    fullHost: MAINNET,
    ...(privateKey ? { privateKey } : {}),
    headers: env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {},
  }),
  signerAdapter = null,
  now = () => Date.now(),
} = {}) {
  const ownerAddress = env.TRON_OWNER_ADDRESS || env.TRON_OWNER_WALLET_ADDRESS || OWNER_FALLBACK
  // An explicit signer adapter may be used by isolated tests or a separately reviewed custody service.
  // The production Sponsor API route remains blocked until the imported browser vault signs locally.
  const signerMode = signerAdapter ? 'external-adapter' : 'client-local-required'
  const signerAddress = signerAdapter ? signerAdapter.address : null
  const signerAdapterValid = !signerAdapter || (
    typeof signerAddress === 'string' && ADDRESS.test(signerAddress)
    && typeof signerAdapter.signTransaction === 'function'
  )

  function readiness() {
    const sponsorAddress = env.SPONSOR_MAINNET_ADDRESS
    // Never load or derive a Sponsor key from the Resource API environment.
    // Browser-local Sponsor signing is the required custody boundary.
    const keyShapeValid = Boolean(signerAdapter && signerAdapterValid)
    const addressShapeValid = typeof sponsorAddress === 'string' && ADDRESS.test(sponsorAddress)
    let signerMatches = false
    if (keyShapeValid && addressShapeValid) {
      try {
        const derivedAddress = signerAdapter.address
        signerMatches = derivedAddress === sponsorAddress
      } catch {}
    }
    const enabled = env.SPONSOR_TRANSACTION_ENGINE_ENABLED === 'true'
      && env.SPONSOR_MAINNET_BROADCAST_ENABLED === 'true'
    const maxFeeRaw = env.SPONSOR_MAX_TX_FEE_SUN ?? '0'
    const feeCapValid = maxFeeRaw === '0' || positiveSun(String(maxFeeRaw)) !== null
    const reserveTrx = String(env.SPONSOR_LIQUID_RESERVE_TRX || '2')
    const reserveAmountSun = decimalTrxToSun(reserveTrx)
    const reserveValid = reserveAmountSun !== null && reserveAmountSun > 0n
    const maxStakeTrx = String(env.SPONSOR_MAX_AUTOMATIC_STAKE_TRX || '0')
    const maxStakeSun = decimalTrxToSun(maxStakeTrx)
    const stakingEnabled = env.SPONSOR_STAKING_ENABLED === 'true' && maxStakeSun !== null && maxStakeSun > 0n
    const maxOwnerTopupTrx = String(env.SPONSOR_MAX_OWNER_TOPUP_TRX || maxStakeTrx)
    const maxOwnerTopupSun = decimalTrxToSun(maxOwnerTopupTrx)
    const ownerTopupEnabled = maxOwnerTopupSun !== null && maxOwnerTopupSun > 0n
    const policyValid = feeCapValid && reserveValid
    return {
      configured: keyShapeValid && addressShapeValid && signerMatches && policyValid,
      signerConfigured: keyShapeValid,
      sponsorAddressValid: addressShapeValid,
      signerAddressMatches: signerMatches,
      signerMode,
      signerAdapterValid,
      enabled,
      ownerAddress,
      sponsorAddress: addressShapeValid ? sponsorAddress : null,
      databaseRequired: true,
      broadcastAvailable: enabled && keyShapeValid && addressShapeValid && signerMatches && policyValid,
      clientSigningAvailable: enabled && addressShapeValid && policyValid && sponsorAddress !== ownerAddress,
      stakingPolicy: { enabled: stakingEnabled, maxStakeTrx },
      ownerTopupPolicy: { enabled: ownerTopupEnabled, maxTopupTrx: maxOwnerTopupTrx },
      feePolicy: {
        valid: policyValid,
        maxBandwidthFeeSun: String(maxFeeRaw),
        protectedReserveTrx: reserveTrx,
      },
    }
  }

  async function verifySolidified({ transactionId, operation, resource, amountSun, sponsorAddress, ownerAddress: recipient }) {
    if (!TXID.test(transactionId || '')) return { confirmed: false, status: 'invalid-transaction-id' }
    const post = async (path, body) => {
      const response = await fetchImpl(MAINNET + path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...(env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {}) },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) throw new Error('solidified-mainnet-read-unavailable')
      return response.json()
    }
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
    catch { return { confirmed: false, status: 'solidified-provider-unavailable' } }
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
    if (operation === 'stake') {
      const cap = decimalTrxToSun(String(env.SPONSOR_MAX_AUTOMATIC_STAKE_TRX || '0'))
      if (env.SPONSOR_STAKING_ENABLED !== 'true' || cap === null || cap <= 0n || amount > cap) return { success: false, status: 'staking-disabled-or-amount-exceeds-configured-cap' }
    }
    if (operation === 'topup') {
      const cap = decimalTrxToSun(String(env.SPONSOR_MAX_OWNER_TOPUP_TRX || env.SPONSOR_MAX_AUTOMATIC_STAKE_TRX || '0'))
      if (cap === null || cap <= 0n || amount > cap) return { success: false, status: 'owner-topup-disabled-or-amount-exceeds-configured-cap' }
    }
    try {
      const tronWeb = tronWebFactory(null)
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
      const accountResources = await tronWeb.trx.getAccountResources(sponsorAddress)
      const freeBandwidth = Math.max(0, Number(accountResources.freeNetLimit || 0) - Number(accountResources.freeNetUsed || 0))
      const stakedBandwidth = Math.max(0, Number(accountResources.NetLimit || 0) - Number(accountResources.NetUsed || 0))
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
    try {
      if (!signedTransaction || !preparedTransaction
        || signedTransaction.txID !== preparedTransaction.txID
        || signedTransaction.raw_data_hex !== preparedTransaction.raw_data_hex
        || JSON.stringify(signedTransaction.raw_data) !== JSON.stringify(preparedTransaction.raw_data)
        || !Array.isArray(signedTransaction.signature) || signedTransaction.signature.length !== 1
        || !/^[0-9a-f]{130}$/i.test(signedTransaction.signature[0])) {
        throw new Error('signed-transaction-integrity-failed')
      }
      assertTransaction(preparedTransaction, { tronWeb: tronWebFactory(null), operation, resource, amountSun, sponsorAddress, ownerAddress: recipient })
      const tronWeb = tronWebFactory(null)
      const txidHash = sha256Hex(Buffer.from(preparedTransaction.raw_data_hex, 'hex'))
      if (txidHash.toLowerCase() !== String(preparedTransaction.txID).toLowerCase()) throw new Error('signed-transaction-integrity-failed')
      const signWeight = await tronWeb.trx.getSignWeight({ ...signedTransaction, visible: true })
      const approved = Array.isArray(signWeight?.approved_list) ? signWeight.approved_list : []
      const threshold = Number(signWeight?.permission?.threshold || 0)
      const currentWeight = Number(signWeight?.current_weight || 0)
      if (signWeight?.result?.code || !approved.includes(sponsorAddress) || !Number.isSafeInteger(threshold)
        || threshold <= 0 || !Number.isSafeInteger(currentWeight) || currentWeight < threshold) {
        throw new Error('sponsor-signature-or-permission-invalid')
      }
      if (typeof onSigned !== 'function') throw new Error('durable-transaction-id-persistence-required')
      await onSigned(preparedTransaction.txID)
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
      return { success: false, status: safeCode(error), txid: preparedTransaction?.txID || null, signed: false, broadcast: false, solidified: false }
    }
  }

  function sha256Hex(bytes) {
    const { createHash } = require('node:crypto')
    return createHash('sha256').update(bytes).digest('hex')
  }

  async function execute({ operation, resource, amountSun, ownerAddress: recipient, onSigned } = {}) {
    const state = readiness()
    if (!state.broadcastAvailable) return { success: false, status: 'sponsor-engine-disabled-or-unconfigured', signed: false, broadcast: false }
    const validOperation = ['stake', 'delegate', 'undelegate', 'unstake', 'withdraw', 'topup'].includes(operation)
    const validResource = ['topup', 'withdraw'].includes(operation) ? resource === 'TRX' : ['ENERGY', 'BANDWIDTH'].includes(resource)
    if (!validOperation || !validResource || recipient !== ownerAddress || !ADDRESS.test(recipient || '')) return { success: false, status: 'invalid-mainnet-operation', signed: false, broadcast: false }
    const amount = positiveSun(amountSun)
    if (!amount || (['stake', 'delegate', 'undelegate', 'unstake'].includes(operation) && amount < SUN)) return { success: false, status: 'invalid-amount-sun', signed: false, broadcast: false }
    if (operation === 'stake') {
      const cap = decimalTrxToSun(String(env.SPONSOR_MAX_AUTOMATIC_STAKE_TRX || '0'))
      if (env.SPONSOR_STAKING_ENABLED !== 'true' || cap === null || cap <= 0n || amount > cap) {
        return { success: false, status: 'staking-disabled-or-amount-exceeds-configured-cap', signed: false, broadcast: false }
      }
    }
    if (operation === 'topup') {
      const cap = decimalTrxToSun(String(env.SPONSOR_MAX_OWNER_TOPUP_TRX || env.SPONSOR_MAX_AUTOMATIC_STAKE_TRX || '0'))
      if (cap === null || cap <= 0n || amount > cap) return { success: false, status: 'owner-topup-disabled-or-amount-exceeds-configured-cap', signed: false, broadcast: false }
    }

    let signed = false
    let broadcastAttempted = false
    let txid = null
    try {
      if (!signerAdapter) return { success: false, status: 'client-local-signer-required', signed: false, broadcast: false }
      const tronWeb = tronWebFactory(null)
      const sponsorAddress = signerAdapter.address
      if (sponsorAddress !== env.SPONSOR_MAINNET_ADDRESS || sponsorAddress === recipient) throw new Error('sponsor-signer-address-mismatch')
      const reserve = decimalTrxToSun(String(env.SPONSOR_LIQUID_RESERVE_TRX || '2'))
      const maxFeeRaw = env.SPONSOR_MAX_TX_FEE_SUN ?? '0'
      const maxFee = maxFeeRaw === '0' ? 0n : positiveSun(String(maxFeeRaw))
      if (reserve === null || maxFee === null) throw new Error('invalid-sponsor-fee-policy')
      const balance = BigInt(await tronWeb.trx.getBalance(sponsorAddress))
      if ((operation === 'stake' || operation === 'topup') && balance < amount + reserve) return { success: false, status: 'insufficient-balance-after-reserve', signed: false, broadcast: false }
      if (!['stake', 'topup'].includes(operation) && balance < reserve) return { success: false, status: 'insufficient-fee-reserve', signed: false, broadcast: false }
      if (operation === 'delegate') {
        const maximumResult = await tronWeb.trx.getCanDelegatedMaxSize(sponsorAddress, resource, { confirmed: true })
        const maximum = BigInt(String(maximumResult?.max_size ?? maximumResult ?? '0'))
        if (maximum < amount) return { success: false, status: 'insufficient-frozen-resource-capacity', signed: false, broadcast: false }
      }
      if (operation === 'undelegate') {
        const resourceReader = tronWeb.trx.raw || tronWeb.trx
        const delegated = await resourceReader.getDelegatedResourceV2(sponsorAddress, recipient, { confirmed: true })
        const rows = Array.isArray(delegated) ? delegated : (Array.isArray(delegated?.delegatedResource) ? delegated.delegatedResource : [])
        const field = resource === 'ENERGY' ? 'frozen_balance_for_energy' : 'frozen_balance_for_bandwidth'
        const current = rows.reduce((sum, row) => sum + BigInt(String(row?.[field] || '0')), 0n)
        if (current < amount) return { success: false, status: 'undelegation-exceeds-current-owner-delegation', signed: false, broadcast: false }
      }
      if (operation === 'unstake') {
        const resourceReader = tronWeb.trx.raw || tronWeb.trx
        const [account, delegated, slots] = await Promise.all([
          resourceReader.getAccount(sponsorAddress, { confirmed: true }),
          resourceReader.getDelegatedResourceV2(sponsorAddress, recipient, { confirmed: true }),
          resourceReader.getAvailableUnfreezeCount(sponsorAddress, { confirmed: true }),
        ])
        const frozen = Array.isArray(account?.frozenV2) ? account.frozenV2 : []
        const type = resource === 'ENERGY' ? 'ENERGY' : 'BANDWIDTH'
        const selfStaked = frozen.filter(row => (row.type || 'BANDWIDTH') === type).reduce((sum, row) => sum + BigInt(String(row.amount || '0')), 0n)
        const rows = Array.isArray(delegated) ? delegated : (Array.isArray(delegated?.delegatedResource) ? delegated.delegatedResource : [])
        const field = resource === 'ENERGY' ? 'frozen_balance_for_energy' : 'frozen_balance_for_bandwidth'
        const delegatedAmount = rows.reduce((sum, row) => sum + BigInt(String(row?.[field] || '0')), 0n)
        const availableToUnstake = selfStaked > delegatedAmount ? selfStaked - delegatedAmount : 0n
        if (Number(slots?.count ?? 0) <= 0) return { success: false, status: 'no-available-unstake-slots', signed: false, broadcast: false }
        if (availableToUnstake < amount) return { success: false, status: 'unstake-exceeds-unlocked-self-stake', signed: false, broadcast: false }
      }
      if (operation === 'withdraw') {
        const resourceReader = tronWeb.trx.raw || tronWeb.trx
        const withdrawable = await resourceReader.getCanWithdrawUnfreezeAmount(sponsorAddress, now(), { confirmed: true })
        const actual = BigInt(String(withdrawable?.amount ?? withdrawable ?? '0'))
        if (actual <= 0n || actual !== amount) return { success: false, status: 'withdraw-amount-changed-refresh-and-retry', signed: false, broadcast: false }
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
      const accountResources = await tronWeb.trx.getAccountResources(sponsorAddress)
      const freeBandwidth = Math.max(0, Number(accountResources.freeNetLimit || 0) - Number(accountResources.freeNetUsed || 0))
      const stakedBandwidth = Math.max(0, Number(accountResources.NetLimit || 0) - Number(accountResources.NetUsed || 0))
      const availableBandwidth = Math.max(freeBandwidth, stakedBandwidth)
      const transactionBytes = Buffer.from(transaction.raw_data_hex, 'hex').length + 100
      const chainParameters = await tronWeb.trx.getChainParameters()
      const bandwidthFee = Number((chainParameters || []).find(item => item.key === 'getTransactionFee')?.value || 0)
      if (!Number.isSafeInteger(transactionBytes) || transactionBytes <= 0 || !Number.isSafeInteger(bandwidthFee) || bandwidthFee <= 0) throw new Error('mainnet-bandwidth-preflight-unavailable')
      const shortfallBytes = Math.max(0, transactionBytes - availableBandwidth)
      const requiredFeeSun = BigInt(shortfallBytes) * BigInt(bandwidthFee)
      if (requiredFeeSun > maxFee) return { success: false, status: 'bandwidth-shortfall-exceeds-authorized-fee-cap', signed: false, broadcast: false }
      const requiredBalance = (operation === 'stake' || operation === 'topup' ? amount : 0n) + reserve + requiredFeeSun
      if (balance < requiredBalance) return { success: false, status: 'insufficient-balance-for-authorized-fee-cap', signed: false, broadcast: false }
      const signedTransaction = await signerAdapter.signTransaction(structuredClone(transaction))
      // An external signer may add signatures, but must not mutate the
      // transaction body, txID, expiration, contract parameters or raw bytes.
      const signaturePresent = Array.isArray(signedTransaction?.signature) && signedTransaction.signature.length > 0
      txid = signedTransaction?.txID || transaction.txID
      if (!signaturePresent || signedTransaction.txID !== transaction.txID
        || signedTransaction.raw_data_hex !== transaction.raw_data_hex
        || JSON.stringify(signedTransaction.raw_data) !== JSON.stringify(transaction.raw_data)) {
        throw new Error('signed-transaction-integrity-failed')
      }
      // Mark signed only after the adapter's returned transaction body passes
      // integrity checks; rejected/tampered responses are not valid signatures.
      signed = true
      if (typeof onSigned !== 'function') throw new Error('durable-transaction-id-persistence-required')
      await onSigned(txid)
      broadcastAttempted = true
      const broadcast = await tronWeb.trx.sendRawTransaction(signedTransaction)
      if (broadcast?.result !== true) return { success: false, status: 'broadcast-rejected-or-unknown', txid, signed: true, broadcast: true }
      const verification = await verifySolidified({ transactionId: txid, operation, resource, amountSun: amount.toString(), sponsorAddress, ownerAddress: recipient })
      return {
        success: verification.confirmed, status: verification.status, txid,
        blockNumber: verification.blockNumber || null, sponsorAddress, ownerAddress: recipient,
        operation, resource, amountSun: amount.toString(), signed: true, broadcast: true,
        solidified: verification.confirmed, checkedAt: new Date(now()).toISOString(),
      }
    } catch (error) {
      return { success: false, status: broadcastAttempted ? 'broadcast-outcome-unknown' : safeCode(error), txid, signed, broadcast: broadcastAttempted, solidified: false }
    }
  }

  return Object.freeze({ readiness, prepare, submitSigned, execute, reconcile })
}
