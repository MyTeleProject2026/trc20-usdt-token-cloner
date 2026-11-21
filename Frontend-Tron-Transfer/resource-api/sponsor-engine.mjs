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
    privateKey,
    headers: env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {},
  }),
  now = () => Date.now(),
} = {}) {
  const ownerAddress = env.TRON_OWNER_ADDRESS || env.TRON_OWNER_WALLET_ADDRESS || OWNER_FALLBACK

  function readiness() {
    const privateKey = env.SPONSOR_MAINNET_PRIVATE_KEY
    const sponsorAddress = env.SPONSOR_MAINNET_ADDRESS
    const keyShapeValid = typeof privateKey === 'string' && /^[0-9a-f]{64}$/i.test(privateKey)
    const addressShapeValid = typeof sponsorAddress === 'string' && ADDRESS.test(sponsorAddress)
    let signerMatches = false
    if (keyShapeValid && addressShapeValid) {
      try { signerMatches = tronWebFactory(privateKey).address.fromPrivateKey(privateKey) === sponsorAddress } catch {}
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
      enabled,
      ownerAddress,
      sponsorAddress: addressShapeValid ? sponsorAddress : null,
      databaseRequired: true,
      broadcastAvailable: enabled && keyShapeValid && addressShapeValid && signerMatches && policyValid,
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
      const privateKey = env.SPONSOR_MAINNET_PRIVATE_KEY
      const tronWeb = tronWebFactory(privateKey)
      const sponsorAddress = tronWeb.address.fromPrivateKey(privateKey)
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
      const signedTransaction = await tronWeb.trx.sign(transaction, privateKey)
      signed = Boolean(signedTransaction?.signature?.length)
      txid = signedTransaction?.txID || transaction.txID
      if (!signed || signedTransaction.txID !== transaction.txID) throw new Error('signed-transaction-integrity-failed')
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

  return Object.freeze({ readiness, execute, reconcile })
}
