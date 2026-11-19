import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowDownUp, CheckCircle2, CircleAlert, FileKey2, LockKeyhole, LogOut, RefreshCw, ShieldCheck, UnlockKeyhole, Wallet } from 'lucide-react'
import {
  createSponsorTronWeb, deriveSponsorAccount, getSavedSponsorWalletAddress, hasSavedSponsorWallet,
  removeSavedSponsorWallet, saveSponsorWalletVault, unlockSponsorWalletVault,
} from './sponsor-wallet-vault.mjs'
import './sponsor-wallet.css'

const OWNER_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const SUN = 1_000_000
const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const RESOURCE_API = (import.meta.env.VITE_RESOURCE_API_URL || 'https://tron-transfer-resource-api.onrender.com').replace(/\/+$/, '')
const ACTIVITY_KEY = 'tron-transfer.sponsor-activity.v1'
const SECURITY_KEY = 'tron-transfer.sponsor-security-events.v1'

function formatAmount(value, digits = 6) {
  const amount = Number(value || 0) / SUN
  return Number.isFinite(amount) ? amount.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—'
}

function parseTrx(value) {
  const text = String(value || '').trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(text)) throw new Error('Enter a valid TRX amount with up to 6 decimal places.')
  const [whole, fraction = ''] = text.split('.')
  const sun = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  if (sun <= 0n || sun > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The TRX amount is outside the supported range.')
  return Number(sun)
}

function estimateStakeSun(resourceType, deficit, snapshot) {
  if (!Number.isSafeInteger(deficit) || deficit <= 0 || !snapshot) return null
  const limit = BigInt(resourceType === 'ENERGY' ? snapshot.totalEnergyLimit || '0' : snapshot.totalNetLimit || '0')
  const weight = BigInt(resourceType === 'ENERGY' ? snapshot.totalEnergyWeight || '0' : snapshot.totalNetWeight || '0')
  if (limit <= 0n || weight <= 0n) return null
  const numerator = BigInt(deficit) * weight * 1_000_000n * 115n
  const denominator = limit * 100n
  const result = (numerator + denominator - 1n) / denominator
  return result > 0n && result <= BigInt(Number.MAX_SAFE_INTEGER) ? result.toString() : null
}

function formatSunAsTrx(value) {
  const sun = BigInt(value)
  const whole = (sun / 1_000_000n).toString()
  const fraction = (sun % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? whole + '.' + fraction : whole
}
async function readRecentTransactions(address) {
  try {
    const response = await fetch(RESOURCE_API + '/v1/transactions/' + encodeURIComponent(address) + '?limit=20', { cache: 'no-store' })
    if (!response.ok) throw new Error('Transaction history API returned HTTP ' + response.status)
    const payload = await response.json()
    if (payload?.address !== address || payload?.network !== 'TRON Mainnet' || !Array.isArray(payload.data)) throw new Error('Transaction history API returned invalid data')
    return { available: true, data: payload.data }
  } catch { return { available: false, data: [] } }
}

async function readResourceSnapshot(address, tronWeb) {
  try {
    const response = await fetch(RESOURCE_API + '/v1/resources/' + encodeURIComponent(address), { cache: 'no-store' })
    if (!response.ok) throw new Error('Resource API returned HTTP ' + response.status)
    const payload = await response.json()
    if (payload?.address !== address || payload?.network !== 'TRON Mainnet' || !payload.energy || !payload.bandwidth || !payload.networkResourceWeights) throw new Error('Resource API returned an invalid account snapshot')
    return {
      balanceSun: String(payload.balanceSun || '0'),
      energy: { limit: Number(payload.energy.limit || 0), used: Number(payload.energy.used || 0), available: Number(payload.energy.available || 0) },
      bandwidth: { stakedOrDelegatedLimit: Number(payload.bandwidth.stakedOrDelegatedLimit || 0), stakedOrDelegatedUsed: Number(payload.bandwidth.stakedOrDelegatedUsed || 0), stakedOrDelegatedAvailable: Number(payload.bandwidth.stakedOrDelegatedAvailable || 0), freeLimit: Number(payload.bandwidth.freeLimit || 0), freeUsed: Number(payload.bandwidth.freeUsed || 0), freeAvailable: Number(payload.bandwidth.freeAvailable || 0), maxSingleTransactionAvailable: Number(payload.bandwidth.maxSingleTransactionAvailable || 0) },
      networkResourceWeights: payload.networkResourceWeights || {}, source: 'resource-api', rpc: payload.rpc || null,
    }
  } catch (error) {
    const [raw, balanceSun] = await Promise.all([tronWeb.trx.getAccountResources(address), tronWeb.trx.getBalance(address)])
    const energyLimit = Number(raw.EnergyLimit || 0), energyUsed = Number(raw.EnergyUsed || 0)
    const netLimit = Number(raw.NetLimit || 0), netUsed = Number(raw.NetUsed || 0)
    const freeLimit = Number(raw.freeNetLimit || 0), freeUsed = Number(raw.freeNetUsed || 0)
    return {
      balanceSun: String(balanceSun || '0'),
      energy: { limit: energyLimit, used: energyUsed, available: Math.max(0, energyLimit - energyUsed) },
      bandwidth: { stakedOrDelegatedLimit: netLimit, stakedOrDelegatedUsed: netUsed, stakedOrDelegatedAvailable: Math.max(0, netLimit - netUsed), freeLimit, freeUsed, freeAvailable: Math.max(0, freeLimit - freeUsed), maxSingleTransactionAvailable: Math.max(Math.max(0, netLimit - netUsed), Math.max(0, freeLimit - freeUsed)) },
      networkResourceWeights: { totalEnergyLimit: String(raw.TotalEnergyLimit || '0'), totalEnergyWeight: String(raw.TotalEnergyWeight || '0'), totalNetLimit: String(raw.TotalNetLimit || '0'), totalNetWeight: String(raw.TotalNetWeight || '0') },
      source: 'direct-tronweb-fallback', rpc: { fallbackReason: String(error?.message || 'resource-api-unavailable').slice(0, 120) },
    }
  }
}
function addressMatches(tronWeb, actual, expected) {
  if (actual === expected) return true
  if (typeof actual !== 'string' || !actual.trim()) return false
  try {
    const actualText = actual.trim().replace(/^0x/i, '')
    const actualBase58 = /^41[0-9a-f]{40}$/i.test(actualText) ? tronWeb.address.fromHex(actualText) : actual
    return actualBase58 === expected
  } catch { return false }
}

function validateUnsignedResourceTransaction(tronWeb, transaction, { action, sponsorAddress, receiverAddress, resourceType, amountSun }) {
  const contracts = transaction?.raw_data?.contract
  const expectedType = action === 'stake' ? 'FreezeBalanceV2Contract' : 'DelegateResourceContract'
  if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== expectedType) {
    throw new Error('The node returned an unexpected transaction contract. No signature was requested.')
  }
  const value = contracts[0]?.parameter?.value
  const owner = value?.owner_address ?? value?.ownerAddress
  if (!value || !addressMatches(tronWeb, owner, sponsorAddress)) throw new Error('The unsigned transaction owner does not match the imported Sponsor Wallet.')
  const rawResource = value.resource ?? value.resourceType
  const normalizedResource = typeof rawResource === 'number' ? (rawResource === 1 ? 'ENERGY' : rawResource === 0 ? 'BANDWIDTH' : '') : String(rawResource || '').toUpperCase()
  if (normalizedResource !== resourceType) throw new Error('The unsigned transaction resource type does not match the selected resource.')
  const rawAmount = action === 'stake' ? value.frozen_balance ?? value.frozenBalance : value.balance
  if (String(rawAmount ?? '') !== String(amountSun)) throw new Error('The unsigned transaction amount does not match the confirmed amount.')
  if (action === 'delegate') {
    if (!addressMatches(tronWeb, value.receiver_address ?? value.receiverAddress, receiverAddress)) throw new Error('The unsigned delegation receiver does not match the configured Owner Wallet.')
    if (value.lock === true || value.lock === 1 || ['true', '1'].includes(String(value.lock).toLowerCase())) throw new Error('Locked resource delegation is not permitted.')
  }
  const expiration = Number(transaction?.raw_data?.expiration)
  if (!Number.isSafeInteger(expiration) || expiration <= Date.now() + 2_000 || expiration > Date.now() + 10 * 60 * 1000) throw new Error('The unsigned transaction expiration is missing or outside the allowed 10-minute window.')
  if (!/^[0-9a-f]{64}$/i.test(String(transaction?.txID || '')) || !/^(?:[0-9a-f]{2})+$/i.test(String(transaction?.raw_data_hex || ''))) throw new Error('The unsigned transaction has no valid transaction ID or raw bytes.')
}
function CenterToast({ toast, onClose }) {
  if (!toast) return null
  return <div className="sponsor-toast-backdrop" role="presentation">
    <div className={`sponsor-toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      {toast.kind === 'error' ? <CircleAlert/> : <CheckCircle2/>}
      <div><b>{toast.title}</b><p>{toast.message}</p></div>
      <button type="button" aria-label="Dismiss notification" onClick={onClose}>×</button>
    </div>
  </div>
}

export default function SponsorWalletManager({ onNavigate = () => {} }) {
  const [wallet, setWallet] = useState(null)
  const [saved, setSaved] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [mode, setMode] = useState('private-key')
  const [credential, setCredential] = useState('')
  const [keystorePassword, setKeystorePassword] = useState('')
  const [vaultPassword, setVaultPassword] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')
  const [amount, setAmount] = useState('10')
  const [energyTarget, setEnergyTarget] = useState('1278524')
  const [bandwidthTarget, setBandwidthTarget] = useState('1000')
  const [resourceType, setResourceType] = useState('ENERGY')
  const [snapshot, setSnapshot] = useState(null)
  const [walletTransactions, setWalletTransactions] = useState([])
  const [walletTransactionsAvailable, setWalletTransactionsAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)
  const [lastTx, setLastTx] = useState('')
  const [lastDelegation, setLastDelegation] = useState(null)
  const [activity, setActivity] = useState([])
  const [securityEvents, setSecurityEvents] = useState([])
  const toastTimer = useRef(null)

  const notify = useCallback((kind, title, message) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ kind, title, message })
    toastTimer.current = window.setTimeout(() => setToast(null), 4800)
  }, [])

  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current) }, [])

  const recordSecurityEvent = useCallback((address, event, detail) => {
    if (!address) return
    setSecurityEvents((previous) => {
      const next = [{ event, detail, address, createdAt: new Date().toISOString() }, ...previous].slice(0, 30)
      try { localStorage.setItem(SECURITY_KEY + ':' + address, JSON.stringify(next)) } catch { /* audit convenience is best-effort */ }
      return next
    })
  }, [])

  useEffect(() => {
    if (!wallet?.address) return
    try {
      const stored = JSON.parse(localStorage.getItem(SECURITY_KEY + ':' + wallet.address) || '[]')
      setSecurityEvents(Array.isArray(stored) ? stored.filter((item) => item && item.address === wallet.address).slice(0, 30) : [])
    } catch { setSecurityEvents([]) }
  }, [wallet?.address])

  const recordActivity = useCallback((entry) => {
    setActivity((previous) => {
      const next = [entry, ...previous.filter((item) => item.transactionId !== entry.transactionId)].slice(0, 50)
      try { localStorage.setItem(ACTIVITY_KEY + ':' + entry.sponsorAddress, JSON.stringify(next)) } catch { /* local history is best-effort */ }
      return next
    })
  }, [])

  useEffect(() => {
    if (!wallet?.address) return
    try {
      const stored = JSON.parse(localStorage.getItem(ACTIVITY_KEY + ':' + wallet.address) || '[]')
      const rows = Array.isArray(stored) ? stored.filter((item) => item && item.sponsorAddress === wallet.address).slice(0, 50) : []
      setActivity(rows)
      setLastDelegation(rows.find((item) => item.action === 'delegate' && item.status !== 'solidified-mainnet-verified') || null)
    } catch { setActivity([]) }
  }, [wallet?.address])

  useEffect(() => {
    if (!wallet?.address || !API_BASE) return undefined
    let cancelled = false
    const loadVerifiedHistory = async () => {
      try {
        const response = await fetch(API_BASE + '/api/tron/sponsorship/resource-delegations?network=mainnet&limit=100', { cache: 'no-store' })
        if (!response.ok) return
        const payload = await response.json()
        if (cancelled || !Array.isArray(payload.delegations)) return
        for (const row of payload.delegations.filter((item) => item.sponsorAddress === wallet.address)) {
          setLastDelegation((current) => current?.transactionId === row.transactionId ? null : current)
          recordActivity({ transactionId: row.transactionId, sponsorAddress: row.sponsorAddress, receiverAddress: row.receiverAddress, resourceType: row.resourceType, stakeEquivalentSun: row.stakeEquivalentSun, action: 'delegate', status: 'solidified-mainnet-verified', blockNumber: row.blockNumber, createdAt: row.recordedAt || new Date().toISOString() })
        }
      } catch { /* The local audit history remains available if the API is offline. */ }
    }
    void loadVerifiedHistory()
    return () => { cancelled = true }
  }, [wallet?.address, recordActivity])

  useEffect(() => { setSaved(hasSavedSponsorWallet()) }, [])

  const tronWeb = useMemo(() => wallet ? createSponsorTronWeb(wallet.privateKey) : null, [wallet])

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!wallet || !tronWeb) return
    setBusy(true)
    try {
      const [resources, account, usdtContract, ownerResources, maxEnergyDelegation, maxBandwidthDelegation, txHistory] = await Promise.all([
        readResourceSnapshot(wallet.address, tronWeb),
        tronWeb.trx.getAccount(wallet.address),
        tronWeb.contract().at(USDT_CONTRACT),
        readResourceSnapshot(OWNER_ADDRESS, tronWeb),
        typeof tronWeb.trx.getCanDelegatedMaxSize === 'function' ? Promise.resolve().then(() => tronWeb.trx.getCanDelegatedMaxSize(wallet.address, 'ENERGY', { confirmed: true })).catch(() => ({ max_size: '0' })) : Promise.resolve({ max_size: '0' }),
        typeof tronWeb.trx.getCanDelegatedMaxSize === 'function' ? Promise.resolve().then(() => tronWeb.trx.getCanDelegatedMaxSize(wallet.address, 'BANDWIDTH', { confirmed: true })).catch(() => ({ max_size: '0' })) : Promise.resolve({ max_size: '0' }),
        readRecentTransactions(wallet.address),
      ])
      setWalletTransactions(Array.isArray(txHistory?.data) ? txHistory.data : [])
      setWalletTransactionsAvailable(txHistory?.available === true)
      const usdtRaw = await usdtContract.balanceOf(wallet.address).call()
      const delegated = typeof tronWeb.trx.getDelegatedResourceV2 === 'function' ? await Promise.resolve().then(() => tronWeb.trx.getDelegatedResourceV2(wallet.address, OWNER_ADDRESS, { confirmed: true })).catch(() => null) : null
      const delegationReadAvailable = Array.isArray(delegated) || Array.isArray(delegated?.delegatedResource)
      const rows = Array.isArray(delegated) ? delegated : (Array.isArray(delegated?.delegatedResource) ? delegated.delegatedResource : [])
      const delegatedEnergySun = rows.reduce((sum, row) => sum + BigInt(row.frozen_balance_for_energy || 0), 0n)
      const delegatedBandwidthSun = rows.reduce((sum, row) => sum + BigInt(row.frozen_balance_for_bandwidth || 0), 0n)
      setSnapshot({
        trxSun: String(resources.balanceSun),
        usdt: String(usdtRaw),
        energyLimit: resources.energy.limit,
        energyUsed: resources.energy.used,
        netLimit: resources.bandwidth.stakedOrDelegatedLimit,
        netUsed: resources.bandwidth.stakedOrDelegatedUsed,
        freeNetLimit: resources.bandwidth.freeLimit,
        freeNetUsed: resources.bandwidth.freeUsed,
        maxSingleTransactionBandwidth: resources.bandwidth.maxSingleTransactionAvailable,
        resourceReadSource: resources.source,
        resourceRpcProviders: resources.rpc?.providersUsed || null,
        delegationReadAvailable,
        delegatedEnergySun: delegatedEnergySun.toString(),
        delegatedBandwidthSun: delegatedBandwidthSun.toString(),
        ownerEnergyAvailable: ownerResources.energy.available,
        ownerBandwidthAvailable: ownerResources.bandwidth.maxSingleTransactionAvailable,
        maxEnergyDelegatableSun: String(maxEnergyDelegation?.max_size || '0'),
        maxBandwidthDelegatableSun: String(maxBandwidthDelegation?.max_size || '0'),
        totalEnergyLimit: String(resources.networkResourceWeights.totalEnergyLimit || '0'),
        totalEnergyWeight: String(resources.networkResourceWeights.totalEnergyWeight || '0'),
        totalNetLimit: String(resources.networkResourceWeights.totalNetLimit || '0'),
        totalNetWeight: String(resources.networkResourceWeights.totalNetWeight || '0'),
        activated: Boolean(account?.address),
        checkedAt: new Date().toISOString(),
      })
      if (!quiet) notify('success', 'Sponsor wallet refreshed', 'Balances and current Mainnet resource counters were read from the TRON node.')
    } catch (error) {
      if (!quiet) notify('error', 'Live refresh failed', error instanceof Error ? error.message : 'Could not read Sponsor Wallet data.')
    } finally {
      setBusy(false)
    }
  }, [wallet, tronWeb, notify])

  useEffect(() => { if (wallet) void refresh() }, [wallet, refresh])

  useEffect(() => {
    if (!wallet) return undefined
    const timer = window.setInterval(() => { void refresh({ quiet: true }) }, 60_000)
    return () => window.clearInterval(timer)
  }, [wallet, refresh])

  async function importWallet() {
    setBusy(true)
    try {
      const account = await deriveSponsorAccount({ mode, value: credential, secretPassword: keystorePassword })
      if (account.address === OWNER_ADDRESS) throw new Error('The Sponsor Wallet must be independent from the existing Owner Wallet.')
      await saveSponsorWalletVault(account, vaultPassword)
      setWallet(account)
      recordSecurityEvent(account.address, 'Sponsor Wallet imported', 'Existing account credentials encrypted in this browser.')
      setSaved(true)
      setReplacing(false)
      setCredential('')
      setKeystorePassword('')
      setVaultPassword('')
      setSnapshot(null)
      setWalletTransactions([])
      setWalletTransactionsAvailable(false)
      notify('success', 'Sponsor Wallet imported', `TRON Mainnet address verified: ${account.address}`)
    } catch (error) {
      notify('error', 'Wallet import failed', error instanceof Error ? error.message : 'Unable to import the Sponsor Wallet.')
    } finally {
      setBusy(false)
    }
  }


  async function unlockWallet() {
    setBusy(true)
    try {
      const account = await unlockSponsorWalletVault(unlockPassword)
      if (account.address === OWNER_ADDRESS) throw new Error('The saved Sponsor Wallet must be independent from the Owner Wallet.')
      setWallet(account)
      recordSecurityEvent(account.address, 'Sponsor Wallet unlocked', 'Encrypted local vault successfully unlocked.')
      setUnlockPassword('')
      setSnapshot(null)
      setWalletTransactions([])
      setWalletTransactionsAvailable(false)
      notify('success', 'Sponsor Wallet unlocked', account.address)
    } catch (error) {
      notify('error', 'Unlock failed', error instanceof Error ? error.message : 'Unable to unlock the Sponsor Wallet.')
    } finally {
      setBusy(false)
    }
  }

  function lockWallet() {
    recordSecurityEvent(wallet?.address, 'Sponsor Wallet locked', 'In-memory signing key released; encrypted vault retained.')
    setWallet(null)
    setSaved(true)
    setSnapshot(null)
      setWalletTransactions([])
      setWalletTransactionsAvailable(false)
    setLastTx('')
    setLastDelegation(null)
    notify('success', 'Sponsor Wallet locked', 'The in-memory signing key was released. The encrypted local backup remains available to unlock.')
  }

  function logoutWallet() {
    recordSecurityEvent(wallet?.address, 'Sponsor Wallet logged out', 'Active session cleared; encrypted vault retained for reconnect.')
    setWallet(null)
    setSaved(false)
    setSnapshot(null)
      setWalletTransactions([])
      setWalletTransactionsAvailable(false)
    setLastTx('')
    setLastDelegation(null)
    notify('success', 'Sponsor Wallet logged out', 'The active session is disconnected. Your encrypted local backup is retained.')
  }

  function beginReplace() {
    recordSecurityEvent(wallet?.address, 'Sponsor Wallet replacement started', 'Replacement import requested; existing encrypted vault retained until successful import.')
    setWallet(null)
    setSnapshot(null)
      setWalletTransactions([])
      setWalletTransactionsAvailable(false)
    setLastTx('')
    setLastDelegation(null)
    setSaved(false)
    setReplacing(true)
    setMode('private-key')
    notify('info', 'Replace Sponsor Wallet', 'Import the replacement account. The current encrypted backup remains until the new import succeeds.')
  }

  function removeVault() {
    if (!window.confirm('Remove the encrypted Sponsor Wallet backup from this browser? This does not affect the on-chain wallet. Make sure you have your own recovery backup.')) return
    recordSecurityEvent(wallet?.address || getSavedSponsorWalletAddress(), 'Sponsor Wallet backup removed', 'Encrypted local vault removed from this browser; on-chain funds were not changed.')
    try { removeSavedSponsorWallet() } catch (error) { notify('error', 'Could not remove local backup', error instanceof Error ? error.message : 'Browser storage is unavailable.'); return }
    setSaved(false)
    setWallet(null)
    setSnapshot(null)
      setWalletTransactions([])
      setWalletTransactionsAvailable(false)
    notify('success', 'Local wallet backup removed', 'No on-chain account or funds were changed.')
  }

  async function submitResourceTransaction(action) {
    if (!wallet || !tronWeb || busy) return
    let amountSun
    try { amountSun = parseTrx(amount) } catch (error) { notify('error', 'Invalid resource amount', error.message); return }
    if (amountSun < SUN) { notify('error', 'Minimum Stake 2.0 amount', 'Use at least 1 TRX for staking or resource delegation.'); return }
    const available = BigInt(snapshot?.trxSun || '0')
    if (available < BigInt(amountSun) + 1_000_000n) { notify('error', 'Insufficient TRX reserve', 'Keep at least 1 TRX available for network fees. The requested amount cannot consume the full Sponsor Wallet balance.'); return }
    if (action === 'delegate') {
      const maxDelegatable = BigInt(resourceType === 'ENERGY' ? snapshot?.maxEnergyDelegatableSun || '0' : snapshot?.maxBandwidthDelegatableSun || '0')
      if (BigInt(amountSun) > maxDelegatable) { notify('error', 'Insufficient delegatable stake', 'The requested resource amount exceeds the sponsor wallet\'s confirmed Stake 2.0 delegation ceiling. Stake TRX for this resource first or reduce the amount.'); return }
    }
    const verb = action === 'stake' ? 'stake' : 'delegate'
    const target = action === 'stake' ? wallet.address : OWNER_ADDRESS
    const prompt = action === 'stake'
      ? `Stake ${amount} TRX for ${resourceType} in Sponsor Wallet ${wallet.address}?`
      : `Delegate ${amount} TRX-equivalent of ${resourceType} from Sponsor Wallet ${wallet.address} to Owner Wallet ${OWNER_ADDRESS}?`
    if (!window.confirm(`${prompt}

This is a real TRON Mainnet transaction. Network fees may consume TRX. Continue?`)) return
    setBusy(true)
    try {
      const unsigned = action === 'stake'
        ? await tronWeb.transactionBuilder.freezeBalanceV2(amountSun, resourceType, target)
        : await tronWeb.transactionBuilder.delegateResource(amountSun, target, resourceType, wallet.address, false, 0)
      validateUnsignedResourceTransaction(tronWeb, unsigned, { action, sponsorAddress: wallet.address, receiverAddress: OWNER_ADDRESS, resourceType, amountSun })
      const signed = await tronWeb.trx.sign(unsigned, wallet.privateKey)
      if (!signed?.signature?.length || signed.txID !== unsigned.txID) throw new Error('Signed transaction identity validation failed. Nothing was broadcast.')
      const result = await tronWeb.trx.sendRawTransaction(signed)
      if (result?.result !== true) throw new Error(result?.message ? String(result.message) : 'The TRON node rejected the transaction broadcast.')
      const transactionId = String(result.txid || signed.txID)
      setLastTx(transactionId)
      recordSecurityEvent(wallet.address, 'Resource transaction broadcast', action + ' ' + resourceType + ' · ' + transactionId)
      const event = { transactionId, sponsorAddress: wallet.address, receiverAddress: target, action, resourceType, stakeEquivalentSun: String(amountSun), status: 'broadcast-pending-verification', createdAt: new Date().toISOString() }
      recordActivity(event)
      if (action === 'delegate') setLastDelegation(event)
      notify('success', `${verb[0].toUpperCase() + verb.slice(1)} transaction broadcast`, `Transaction ID: ${transactionId}. Use Verify Mainnet delegation after the transaction is solidified.`)
      await refresh({ quiet: true })
    } catch (error) {
      notify('error', 'Resource transaction failed', error instanceof Error ? error.message : 'The transaction was not completed.')
    } finally {
      setBusy(false)
    }
  }

  async function verifyLastDelegation() {
    if (!lastDelegation || busy) return
    if (!API_BASE) { notify('error', 'Verification API unavailable', 'Configure VITE_API_BASE_URL for the Tron Transfer backend before requesting independent solidified verification.'); return }
    setBusy(true)
    try {
      const response = await fetch(API_BASE + '/api/tron/sponsorship/resource-delegations/verify-wallet', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ network: 'mainnet', transactionId: lastDelegation.transactionId, sponsorAddress: lastDelegation.sponsorAddress, receiverAddress: lastDelegation.receiverAddress, resourceType: lastDelegation.resourceType, stakeEquivalentSun: lastDelegation.stakeEquivalentSun }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.verified !== true || payload.persistence?.persisted !== true) {
        const detail = payload.message || payload.verification?.reason || payload.error || ('Verification service returned HTTP ' + response.status + '.')
        recordActivity({ ...lastDelegation, status: 'verification-pending', verificationMessage: detail })
        notify('error', 'Mainnet verification not complete', detail)
        return
      }
      const verified = { ...lastDelegation, status: 'solidified-mainnet-verified', blockNumber: payload.verification.blockNumber, verifiedAt: payload.verification.checkedAt }
      recordActivity(verified)
      recordSecurityEvent(wallet.address, 'Delegation verified', 'Solidified Mainnet block ' + payload.verification.blockNumber + ' verified by backend.')
      setLastDelegation(null)
      notify('success', 'Delegation independently verified', 'Solidified Mainnet block ' + payload.verification.blockNumber + '; verified record persisted in the project audit ledger.')
      await refresh({ quiet: true })
    } catch (error) {
      notify('error', 'Mainnet verification unavailable', error instanceof Error ? error.message : 'Could not reach the verification service.')
    } finally { setBusy(false) }
  }

  const energyAvailable = Math.max(0, (snapshot?.energyLimit || 0) - (snapshot?.energyUsed || 0))
  const energyTargetValid = /^[1-9][0-9]{0,14}$/.test(energyTarget) && Number.isSafeInteger(Number(energyTarget))
  const bandwidthTargetValid = /^[1-9][0-9]{0,14}$/.test(bandwidthTarget) && Number.isSafeInteger(Number(bandwidthTarget))
  const ownerEnergyDeficit = energyTargetValid ? Math.max(0, Number(energyTarget) - (snapshot?.ownerEnergyAvailable || 0)) : 0
  const ownerBandwidthDeficit = bandwidthTargetValid ? Math.max(0, Number(bandwidthTarget) - (snapshot?.ownerBandwidthAvailable || 0)) : 0
  const energyStakeEstimate = estimateStakeSun('ENERGY', ownerEnergyDeficit, snapshot)
  const bandwidthStakeEstimate = estimateStakeSun('BANDWIDTH', ownerBandwidthDeficit, snapshot)
  const bandwidthAvailable = Math.max(0, (snapshot?.netLimit || 0) - (snapshot?.netUsed || 0))
  const freeBandwidthAvailable = Math.max(0, (snapshot?.freeNetLimit || 0) - (snapshot?.freeNetUsed || 0))

  return <section className="sponsor-manager">
    <CenterToast toast={toast} onClose={() => setToast(null)}/>
    <header className="sponsor-manager-header">
      <div><span className="sponsor-eyebrow">INTEGRATED WALLET · TRON MAINNET</span><h2>TRON TRANSFER SPONSOR</h2><p>Independent sponsor account · Energy and Bandwidth management for the existing Owner Wallet.</p></div>
      <span className="sponsor-network-pill"><i/> TRON MAINNET</span>
    </header>

    {!wallet && !saved && <section className="sponsor-card">
      <div className="sponsor-card-heading"><Wallet/><div><h3>Import existing Sponsor Wallet</h3><p>No wallet creation. Credentials are processed in this browser and encrypted before local storage.</p></div></div>
      <div className="sponsor-import-tabs">{[['private-key','Private key'],['keystore','Keystore JSON'],['mnemonic','Mnemonic phrase']].map(([id,label]) => <button key={id} className={mode === id ? 'active' : ''} onClick={() => {setMode(id);setCredential('')}}>{label}</button>)}</div>
      {mode === 'keystore'
        ? <label className="sponsor-field">Keystore JSON file<input type="file" accept=".json,application/json" onChange={async event => setCredential(await event.target.files?.[0]?.text() || '')}/><small>Standard V3 JSON keystore format.</small></label>
        : <label className="sponsor-field">{mode === 'private-key' ? 'Private key' : 'Recovery mnemonic phrase'}<textarea value={credential} onChange={event => setCredential(event.target.value)} rows={mode === 'mnemonic' ? 3 : 2} autoComplete="off" spellCheck="false" placeholder={mode === 'private-key' ? 'Paste private key locally' : 'Enter recovery words locally'}/></label>}
      {mode === 'keystore' && <label className="sponsor-field">Keystore password<input type="password" value={keystorePassword} onChange={event => setKeystorePassword(event.target.value)} autoComplete="new-password"/></label>}
      <label className="sponsor-field">New local vault password<input type="password" value={vaultPassword} onChange={event => setVaultPassword(event.target.value)} minLength={12} autoComplete="new-password"/><small>At least 12 characters. It encrypts the private key with AES-256-GCM and PBKDF2-SHA256 in this browser.</small></label>
      <div className="sponsor-actions"><button className="sponsor-primary" disabled={busy || !credential.trim() || vaultPassword.length < 12} onClick={() => void importWallet()}>{busy ? 'Importing securely…' : 'Import & encrypt Sponsor Wallet'}</button>{replacing && <button className="sponsor-secondary" onClick={() => {setSaved(hasSavedSponsorWallet());setReplacing(false)}}>Cancel replacement</button>}</div>
      {hasSavedSponsorWallet() && !replacing && <button className="sponsor-secondary" onClick={() => setSaved(true)}>Reconnect saved Sponsor Wallet</button>}
      <p className="sponsor-security-note"><ShieldCheck/> Never paste credentials into chat. The private key is not sent to the Tron Transfer API. Browser storage is device-specific; keep your original recovery backup safe.</p>
    </section>}

    {!wallet && saved && <section className="sponsor-card sponsor-unlock-card">
      <div className="sponsor-card-heading"><LockKeyhole/><div><h3>Encrypted Sponsor Wallet saved</h3><p>Unlock this browser's encrypted wallet backup, or replace it by importing another account.</p></div></div>
      <label className="sponsor-field">Vault password<input type="password" value={unlockPassword} onChange={event => setUnlockPassword(event.target.value)} autoComplete="current-password"/></label>
      <div className="sponsor-actions"><button className="sponsor-primary" disabled={busy || !unlockPassword} onClick={() => void unlockWallet()}><UnlockKeyhole size={16}/> {busy ? 'Unlocking…' : 'Unlock Sponsor Wallet'}</button><button className="sponsor-secondary" onClick={() => {setSaved(false);setMode('private-key')}}>Replace / import another</button></div>
      <button className="sponsor-danger-link" onClick={removeVault}>Remove encrypted local backup</button>
    </section>}

    {wallet && <div className="sponsor-dashboard">
      <section className="sponsor-card sponsor-wallet-summary">
        <div className="sponsor-card-heading"><Wallet/><div><h3>Sponsor Wallet Overview</h3><p>{wallet.address}</p></div></div>
        <div className="sponsor-wallet-actions"><span className="sponsor-status"><i/> Imported · Unlocked</span><button onClick={() => void refresh()} disabled={busy}><RefreshCw size={15}/> Refresh</button><button onClick={lockWallet}><LockKeyhole size={15}/> Lock</button><button onClick={logoutWallet}><LogOut size={15}/> Logout</button><button onClick={beginReplace}>Replace</button></div>
        <div className="sponsor-metric-grid">
          <article><small>TRX BALANCE</small><strong>{snapshot ? formatAmount(snapshot.trxSun) : '—'}</strong></article>
          <article><small>OFFICIAL USDT</small><strong>{snapshot ? (Number(snapshot.usdt) / 1e6).toLocaleString(undefined,{maximumFractionDigits:6}) : '—'}</strong></article>
          <article><small>ENERGY AVAILABLE</small><strong>{snapshot ? energyAvailable.toLocaleString() : '—'}</strong><small>{snapshot ? `${snapshot.energyUsed.toLocaleString()} used / ${snapshot.energyLimit.toLocaleString()} limit` : 'Refresh to read'}</small></article>
          <article><small>BANDWIDTH AVAILABLE</small><strong>{snapshot ? Number(snapshot.maxSingleTransactionBandwidth || Math.max(bandwidthAvailable, freeBandwidthAvailable)).toLocaleString() : '—'}</strong><small>{snapshot ? `${bandwidthAvailable.toLocaleString()} staked + ${freeBandwidthAvailable.toLocaleString()} free` : 'Refresh to read'}</small></article>
        </div>
        <p className="sponsor-muted">Owner recipient: <code>{OWNER_ADDRESS}</code></p>
        {snapshot?.resourceReadSource && <p className="sponsor-muted">Resource data source: {snapshot.resourceReadSource === 'resource-api' ? 'TRON Transfer Resource API' : 'Direct TronWeb fallback'}{snapshot.resourceRpcProviders ? ' · ' + Object.values(snapshot.resourceRpcProviders).join(' / ') : ''}</p>}
        {snapshot?.checkedAt && <p className="sponsor-muted">Last live check: {new Date(snapshot.checkedAt).toLocaleString()}</p>}
        {lastTx && <p className="sponsor-tx-link">Last transaction: <a href={`https://tronscan.org/#/transaction/${lastTx}`} target="_blank" rel="noreferrer">{lastTx}</a></p>}
      </section>

      <section className="sponsor-card">
        <div className="sponsor-card-heading"><ArrowDownUp/><div><h3>Resource Management</h3><p>Stake sponsor-owned TRX or delegate already-staked resources to the existing Owner Wallet.</p></div></div>
        <div className="sponsor-resource-controls">
          <label className="sponsor-field">Amount (TRX)<input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)}/></label>
          <label className="sponsor-field">Resource<select value={resourceType} onChange={event => setResourceType(event.target.value)}><option value="ENERGY">Energy</option><option value="BANDWIDTH">Bandwidth</option></select></label>
        </div>
        <div className="sponsor-actions">
          <button className="sponsor-secondary" disabled={!energyStakeEstimate || busy} onClick={() => {setResourceType('ENERGY');setAmount(formatSunAsTrx(energyStakeEstimate))}}>Prepare Energy stake · {energyStakeEstimate ? formatAmount(energyStakeEstimate) + ' TRX' : 'estimate unavailable'}</button>
          <button className="sponsor-secondary" disabled={!bandwidthStakeEstimate || busy} onClick={() => {setResourceType('BANDWIDTH');setAmount(formatSunAsTrx(bandwidthStakeEstimate))}}>Prepare Bandwidth stake · {bandwidthStakeEstimate ? formatAmount(bandwidthStakeEstimate) + ' TRX' : 'estimate unavailable'}</button>
        </div>
        <p className="sponsor-muted">Stake estimates use the current network-wide Energy/Bandwidth limit and weight returned by the node. They include a 15% planning buffer, but are not guaranteed resource quotes; recheck live sponsor balance and delegation ceilings before signing.</p><p className="sponsor-warning">USDT is shown as a capital balance only. Stake 2.0 requires TRX; this module does not swap USDT automatically. A USDT balance by itself does not create Energy or Bandwidth.</p>
        <div className="sponsor-actions"><button className="sponsor-secondary" disabled={busy || !snapshot} onClick={() => void submitResourceTransaction('stake')}>Stake TRX for {resourceType}</button><button className="sponsor-primary" disabled={busy || !snapshot} onClick={() => void submitResourceTransaction('delegate')}>Delegate {resourceType} to Owner</button><button className="sponsor-secondary" disabled={busy || !lastDelegation} onClick={() => void verifyLastDelegation()}>Verify Mainnet delegation</button><button className="sponsor-secondary" disabled title="No authorized Mainnet resource-rental provider is configured">Acquire Energy / Bandwidth · Provider unavailable</button></div>
        <p className="sponsor-muted">Confirmed delegation ceiling: {snapshot ? formatAmount(resourceType === 'ENERGY' ? snapshot.maxEnergyDelegatableSun : snapshot.maxBandwidthDelegatableSun) + ' TRX equivalent' : 'Refresh to read'}.</p><p className="sponsor-warning">These buttons create real Mainnet transactions and can consume TRX fees. Staked TRX is locked under Stake 2.0 rules; delegations are limited by the sponsor's own eligible stake. Incoming delegated resources cannot be re-delegated.</p>
      </section>

      <section className="sponsor-card">
        <div className="sponsor-card-heading"><Activity/><div><h3>Automatic Resource Engine</h3><p>Live owner-resource monitoring and sponsor capacity checks.</p></div></div>
        <div className="sponsor-resource-controls"><label className="sponsor-field">Owner Energy target (units)<input inputMode="numeric" value={energyTarget} onChange={event => setEnergyTarget(event.target.value.replace(/[^0-9]/g, '').slice(0, 15))}/><small>Default planning target only. Set this to the current deployment estimate from Owner Admin preflight.</small></label><label className="sponsor-field">Owner Bandwidth target (bytes)<input inputMode="numeric" value={bandwidthTarget} onChange={event => setBandwidthTarget(event.target.value.replace(/[^0-9]/g, '').slice(0, 15))}/></label></div><div className="sponsor-engine-grid"><div><small>OWNER TARGET</small><strong>{OWNER_ADDRESS}</strong></div><div><small>SPONSOR ENERGY STAKED</small><strong>{snapshot?.delegationReadAvailable ? formatAmount(snapshot.delegatedEnergySun) + ' TRX eq.' : 'Unavailable'}</strong></div><div><small>SPONSOR BANDWIDTH STAKED</small><strong>{snapshot?.delegationReadAvailable ? formatAmount(snapshot.delegatedBandwidthSun) + ' TRX eq.' : 'Unavailable'}</strong></div><div><small>OWNER ENERGY AVAILABLE</small><strong>{snapshot ? Number(snapshot.ownerEnergyAvailable || 0).toLocaleString() : '—'}</strong></div><div><small>OWNER BANDWIDTH AVAILABLE</small><strong>{snapshot ? Number(snapshot.ownerBandwidthAvailable || 0).toLocaleString() : '—'}</strong></div><div><small>ENERGY TARGET DEFICIT</small><strong>{snapshot ? ownerEnergyDeficit.toLocaleString() : '—'}</strong></div><div><small>BANDWIDTH TARGET DEFICIT</small><strong>{snapshot ? ownerBandwidthDeficit.toLocaleString() : '—'}</strong></div><div><small>RESOURCE PRECHECK</small><strong>{!energyTargetValid || !bandwidthTargetValid ? 'Invalid targets' : snapshot ? (ownerEnergyDeficit === 0 && ownerBandwidthDeficit === 0 ? 'Targets met' : 'Resource shortfall') : 'Awaiting live read'}</strong></div></div>
        <div className="sponsor-actions"><button className="sponsor-secondary" onClick={() => onNavigate('deploy')}>Open Owner Admin deployment preflight</button><button className="sponsor-secondary" onClick={() => onNavigate('portfolio')}>Open Owner portfolio</button></div><p className="sponsor-warning">Monitoring is live when refreshed. Automatic unattended signing is intentionally disabled: each stake/delegation requires an explicit on-screen confirmation. A provider rental or free-grant adapter is not configured by this wallet import.</p>
      </section>

      <section className="sponsor-card">
        <div className="sponsor-card-heading"><FileKey2/><div><h3>Sponsor Activity</h3><p>Current browser session and latest observed transaction.</p></div></div>
        <div className="sponsor-activity-row"><span>Wallet connection</span><b>Unlocked locally</b></div>
        <div className="sponsor-activity-row"><span>Network</span><b>TRON Mainnet</b></div><div className="sponsor-activity-row"><span>Security events</span><b>{securityEvents.length} local events</b></div>{securityEvents.slice(0, 5).map((item, index) => <div className="sponsor-activity-row" key={item.createdAt + index}><span>{item.event} · {new Date(item.createdAt).toLocaleString()}</span><b>{item.detail}</b></div>)}
        <div className="sponsor-activity-row"><span>Resource history</span><b>{activity.length} local records · {activity.filter((item) => item.status === 'solidified-mainnet-verified').length} independently verified</b></div><div className="sponsor-activity-row"><span>Recent wallet transactions</span><b>{walletTransactionsAvailable ? walletTransactions.length + ' confirmed chain records' : 'History unavailable'}</b></div>{walletTransactions.slice(0, 8).map((item) => { const txid = item.txID || item.txid; const type = item.raw_data?.contract?.[0]?.type || 'TRON transaction'; const result = item.ret?.[0]?.contractRet || 'CONFIRMED'; return <div className="sponsor-activity-row" key={txid}><span>{type} · {item.block_timestamp ? new Date(item.block_timestamp).toLocaleString() : 'Confirmed on-chain'}</span><b>{result} <a href={'https://tronscan.org/#/transaction/' + txid} target="_blank" rel="noreferrer">View</a></b></div>})}{activity.slice(0, 8).map((item) => <div className="sponsor-activity-row" key={item.transactionId}><span>{item.action === 'stake' ? 'Stake' : 'Delegation'} · {item.resourceType} · {new Date(item.createdAt).toLocaleString()}</span><b>{item.status === 'solidified-mainnet-verified' ? 'Verified · block ' + item.blockNumber : item.status === 'verification-pending' ? 'Awaiting solidification / retry' : 'Broadcast · not yet verified'} <a href={'https://tronscan.org/#/transaction/' + item.transactionId} target="_blank" rel="noreferrer">View</a></b></div>)}
      </section>
    </div>}
    
  </section>
}
