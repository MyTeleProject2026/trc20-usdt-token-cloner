import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowDownUp, CheckCircle2, CircleAlert, FileKey2, LockKeyhole, LogOut, RefreshCw, ShieldCheck, UnlockKeyhole, Wallet } from 'lucide-react'
import {
  createSponsorTronWeb, deriveSponsorAccount, getSavedSponsorWalletAddress, hasSavedSponsorWallet,
  removeSavedSponsorWallet, saveSponsorWalletVault, unlockSponsorWalletVault,
} from './sponsor-wallet-vault.mjs'
import { planSponsorResourceProvisioning } from './sponsor-resource-planner.mjs'
import './sponsor-wallet.css'

const OWNER_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const SUN = 1_000_000
const RESOURCE_API = (import.meta.env.VITE_RESOURCE_API_URL || 'https://tron-transfer-resource-api.onrender.com').replace(/\/+$/, '')
const ACTIVITY_KEY = 'tron-transfer.sponsor-activity.v1'
const SECURITY_KEY = 'tron-transfer.sponsor-security-events.v1'
const TARGETS_KEY = 'tron-transfer.sponsor-resource-targets.v1'

function formatSponsorDatabaseStatus(status, payload) {
  const labels = {
    ready: 'connected',
    'not-configured': 'not configured',
    'pool-unavailable': 'connection pool unavailable',
    'schema-missing': 'ledger schema missing',
    'control-row-missing': 'ledger control row missing',
    'query-failed': 'database query failed',
    unchecked: 'checking',
  }
  if (typeof status === 'string' && labels[status]) return labels[status]
  if (payload?.databaseReady === true) return 'connected'
  if (payload?.databaseConfigured === true) return 'configured but unavailable'
  return 'not configured'
}

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

function readSavedTarget(key, fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem(TARGETS_KEY) || '{}')
    return typeof saved[key] === 'string' ? saved[key] : fallback
  } catch { return fallback }
}

function formatTokenUnits(raw, decimals = 6) {
  try {
    const units = BigInt(String(raw || '0'))
    const scale = 10n ** BigInt(decimals)
    const whole = (units / scale).toString()
    const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
    return fraction ? whole + '.' + fraction : whole
  } catch { return '0' }
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
    return { available: true, data: payload.data, tokenTransfers: Array.isArray(payload.trc20Transfers) ? payload.trc20Transfers : [], tokenTransfersAvailable: payload.trc20Available === true }
  } catch { return { available: false, data: [], tokenTransfers: [], tokenTransfersAvailable: false } }
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

async function sponsorApiRequest(path, { method = 'GET', token, adminToken, body } = {}) {
  const response = await fetch(RESOURCE_API + path, {
    method, cache: 'no-store',
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(adminToken ? { 'x-sponsor-admin-token': adminToken } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.message || payload.error || ('Sponsor Resource API returned HTTP ' + response.status))
  return payload
}
async function authenticateSponsorWallet(wallet, tronWeb) {
  const challenge = await sponsorApiRequest('/api/sponsor/session/challenge', { method: 'POST', body: { address: wallet.address } })
  if (challenge.address !== wallet.address || challenge.network !== 'TRON Mainnet' || typeof challenge.message !== 'string') throw new Error('Sponsor API returned an invalid wallet-authentication challenge.')
  if (typeof tronWeb.trx.signMessageV2 !== 'function') throw new Error('This TronWeb build does not support version-2 message signing.')
  const signature = await tronWeb.trx.signMessageV2(challenge.message, wallet.privateKey)
  const verified = await sponsorApiRequest('/api/sponsor/session/verify', { method: 'POST', body: { address: wallet.address, nonce: challenge.nonce, signature } })
  if (verified.address !== wallet.address || typeof verified.token !== 'string') throw new Error('Sponsor session verification returned an invalid session.')
  return verified.token
}
function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random idempotency keys are unavailable in this browser.')
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('')
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

export default function SponsorWalletManager({ activePage = 'sponsor', onNavigate = () => {}, workspaceActive = true }) {
  const [wallet, setWallet] = useState(null)
  const [saved, setSaved] = useState(() => hasSavedSponsorWallet())
  const [replacing, setReplacing] = useState(false)
  const [mode, setMode] = useState('private-key')
  const [credential, setCredential] = useState('')
  const [keystorePassword, setKeystorePassword] = useState('')
  const [vaultPassword, setVaultPassword] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')
  const [adminToken, setAdminToken] = useState('')
  const [amount, setAmount] = useState('10')
  const [energyTarget, setEnergyTarget] = useState(() => readSavedTarget('energy', '1278524'))
  const [bandwidthTarget, setBandwidthTarget] = useState(() => readSavedTarget('bandwidth', '1000'))
  const [resourceType, setResourceType] = useState('ENERGY')
  const [snapshot, setSnapshot] = useState(null)
  const [walletTransactions, setWalletTransactions] = useState([])
  const [walletTransactionsAvailable, setWalletTransactionsAvailable] = useState(false)
  const [walletTokenTransfers, setWalletTokenTransfers] = useState([])
  const [walletTokenTransfersAvailable, setWalletTokenTransfersAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)
  const [lastTx, setLastTx] = useState('')
  const [lastOperationReference, setLastOperationReference] = useState('')
  const [lastDelegation, setLastDelegation] = useState(null)
  const [activity, setActivity] = useState([])
  const [securityEvents, setSecurityEvents] = useState([])
  const [sponsorApiStatus, setSponsorApiStatus] = useState(null)
  const toastTimer = useRef(null)
  const resourceAlertState = useRef('unknown')

  const notify = useCallback((kind, title, message) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ kind, title, message })
    toastTimer.current = window.setTimeout(() => setToast(null), 4800)
  }, [])

  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current) }, [])

  useEffect(() => {
    const reloadTargets = () => {
      setEnergyTarget(readSavedTarget('energy', '1278524'))
      setBandwidthTarget(readSavedTarget('bandwidth', '1000'))
    }
    window.addEventListener('tron-transfer:sponsor-targets-updated', reloadTargets)
    return () => window.removeEventListener('tron-transfer:sponsor-targets-updated', reloadTargets)
  }, [])

  useEffect(() => { try { localStorage.setItem(TARGETS_KEY, JSON.stringify({ energy: energyTarget, bandwidth: bandwidthTarget })) } catch { /* targets are a local preference */ } }, [energyTarget, bandwidthTarget])

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
      setLastOperationReference(rows.find((item) => item.operationReference && item.status === 'broadcast-pending-verification')?.operationReference || '')
    } catch { setActivity([]) }
  }, [wallet?.address])

  useEffect(() => {
    if (!workspaceActive || !wallet?.address || !tronWeb) return undefined
    let cancelled = false
    const loadVerifiedHistory = async () => {
      try {
        const payload = await sponsorApiRequest('/api/tron/sponsorship/resource-delegations?network=mainnet&address=' + encodeURIComponent(wallet.address) + '&limit=100')
        if (cancelled || !Array.isArray(payload.delegations)) return
        for (const row of payload.delegations.filter((item) => item.sponsorAddress === wallet.address)) {
          setLastDelegation((current) => current?.transactionId === row.transactionId ? null : current)
          recordActivity({ transactionId: row.transactionId, sponsorAddress: row.sponsorAddress, receiverAddress: row.receiverAddress, resourceType: row.resourceType, stakeEquivalentSun: row.stakeEquivalentSun, action: 'delegate', status: 'solidified-mainnet-verified', blockNumber: row.blockNumber, createdAt: row.recordedAt || new Date().toISOString() })
        }
      } catch { /* Local audit history remains available when the Sponsor Resource API is not configured. */ }
    }
    void loadVerifiedHistory()
    return () => { cancelled = true }
  }, [wallet?.address, tronWeb, recordActivity, workspaceActive])

  useEffect(() => { if (!wallet) setAdminToken('') }, [wallet])

  useEffect(() => {
    if (!workspaceActive) return undefined
    let active = true
    const loadStatus = async () => {
      try {
        const status = await sponsorApiRequest('/api/sponsor/status')
        if (active) setSponsorApiStatus(status)
      } catch (error) {
        if (active) setSponsorApiStatus({ success: false, error: String(error?.message || 'Sponsor Resource API unavailable') })
      }
    }
    void loadStatus()
    const timer = window.setInterval(() => { void loadStatus() }, 30_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [workspaceActive])

  const tronWeb = useMemo(() => wallet ? createSponsorTronWeb(wallet.privateKey) : null, [wallet])

  const bootstrapSponsorLedger = useCallback(async () => {
    if (!wallet?.address) return
    if (adminToken.length < 32) {
      notify('error', 'Owner Admin authorization required', 'Enter the configured Sponsor Admin token. It is held in memory only and is never stored in browser storage.')
      return
    }
    setBusy(true)
    try {
      const result = await sponsorApiRequest('/api/sponsor/ledger/bootstrap', {
        method: 'POST', adminToken, body: { confirm: 'INITIALIZE_SPONSOR_LEDGER_SCHEMA' },
      })
      const status = await sponsorApiRequest('/api/sponsor/status')
      setSponsorApiStatus(status)
      notify(result.success ? 'success' : 'error', result.success ? 'Sponsor ledger schema initialized' : 'Sponsor ledger bootstrap not ready', result.message || 'The ledger remains write-paused. Migration, backup/restore verification and explicit cutover are still required.')
    } catch (error) {
      notify('error', 'Sponsor ledger bootstrap failed', String(error?.message || 'The Resource API could not initialize the schema.'))
    } finally { setBusy(false) }
  }, [wallet?.address, adminToken, notify])

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!wallet || !tronWeb) return
    setBusy(true)
    try {
      const resourceReader = tronWeb.trx.raw || tronWeb.trx
      const [resources, account, usdtContract, ownerResources, maxEnergyDelegation, maxBandwidthDelegation, txHistory, withdrawable, unfreezeSlots] = await Promise.all([
        readResourceSnapshot(wallet.address, tronWeb),
        resourceReader.getAccount(wallet.address, { confirmed: true }),
        tronWeb.contract().at(USDT_CONTRACT),
        readResourceSnapshot(OWNER_ADDRESS, tronWeb),
        typeof resourceReader.getCanDelegatedMaxSize === 'function' ? Promise.resolve().then(() => resourceReader.getCanDelegatedMaxSize(wallet.address, 'ENERGY', { confirmed: true })).catch(() => ({ max_size: '0' })) : Promise.resolve({ max_size: '0' }),
        typeof resourceReader.getCanDelegatedMaxSize === 'function' ? Promise.resolve().then(() => resourceReader.getCanDelegatedMaxSize(wallet.address, 'BANDWIDTH', { confirmed: true })).catch(() => ({ max_size: '0' })) : Promise.resolve({ max_size: '0' }),
        readRecentTransactions(wallet.address),
        typeof resourceReader.getCanWithdrawUnfreezeAmount === 'function' ? Promise.resolve().then(() => resourceReader.getCanWithdrawUnfreezeAmount(wallet.address, Date.now(), { confirmed: true })).catch(() => ({ amount: '0' })) : Promise.resolve({ amount: '0' }),
        typeof resourceReader.getAvailableUnfreezeCount === 'function' ? Promise.resolve().then(() => resourceReader.getAvailableUnfreezeCount(wallet.address, { confirmed: true })).catch(() => ({ count: 0 })) : Promise.resolve({ count: 0 }),
      ])
      setWalletTransactions(Array.isArray(txHistory?.data) ? txHistory.data : [])
      setWalletTransactionsAvailable(txHistory?.available === true)
      setWalletTokenTransfers(Array.isArray(txHistory?.tokenTransfers) ? txHistory.tokenTransfers : [])
      setWalletTokenTransfersAvailable(txHistory?.tokenTransfersAvailable === true)
      const usdtRaw = await usdtContract.balanceOf(wallet.address).call()
      const delegated = typeof resourceReader.getDelegatedResourceV2 === 'function' ? await Promise.resolve().then(() => resourceReader.getDelegatedResourceV2(wallet.address, OWNER_ADDRESS, { confirmed: true })).catch(() => null) : null
      const delegationReadAvailable = Array.isArray(delegated) || Array.isArray(delegated?.delegatedResource)
      const rows = Array.isArray(delegated) ? delegated : (Array.isArray(delegated?.delegatedResource) ? delegated.delegatedResource : [])
      const delegatedEnergySun = rows.reduce((sum, row) => sum + BigInt(row.frozen_balance_for_energy || 0), 0n)
      const delegatedBandwidthSun = rows.reduce((sum, row) => sum + BigInt(row.frozen_balance_for_bandwidth || 0), 0n)
      const frozenRows = Array.isArray(account?.frozenV2) ? account.frozenV2 : []
      const frozenEnergySun = frozenRows.filter(row => row.type === 'ENERGY').reduce((sum, row) => sum + BigInt(String(row.amount || '0')), 0n)
      const frozenBandwidthSun = frozenRows.filter(row => (row.type || 'BANDWIDTH') === 'BANDWIDTH').reduce((sum, row) => sum + BigInt(String(row.amount || '0')), 0n)
      const pendingUnfreezes = (Array.isArray(account?.unfrozenV2) ? account.unfrozenV2 : []).map(row => ({ resourceType: row.type || 'BANDWIDTH', amountSun: String(row.unfreeze_amount || '0'), expiresAt: Number(row.unfreeze_expire_time || 0) })).filter(row => BigInt(row.amountSun) > 0n)
      const pendingUnfreezeSun = pendingUnfreezes.reduce((sum, row) => sum + BigInt(row.amountSun), 0n)
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
        frozenEnergySun: frozenEnergySun.toString(),
        frozenBandwidthSun: frozenBandwidthSun.toString(),
        pendingUnfreezeSun: pendingUnfreezeSun.toString(),
        pendingUnfreezes,
        withdrawableSun: String(withdrawable?.amount || '0'),
        availableUnfreezeCount: Number(unfreezeSlots?.count || 0),
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

  useEffect(() => { if (wallet && workspaceActive) void refresh() }, [wallet, workspaceActive, refresh])

  useEffect(() => {
    if (!wallet || !workspaceActive) return undefined
    const timer = window.setInterval(() => { void refresh({ quiet: true }) }, 60_000)
    return () => window.clearInterval(timer)
  }, [wallet, workspaceActive, refresh])

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
      setWalletTokenTransfers([])
      setWalletTokenTransfersAvailable(false)
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

  const lockWallet = useCallback((reason = 'manual') => {
    if (!wallet?.address) return
    const automatic = reason === 'inactivity' || reason === 'background'
    recordSecurityEvent(
      wallet.address,
      automatic ? 'Sponsor Wallet automatically locked' : 'Sponsor Wallet locked',
      automatic
        ? (reason === 'background' ? 'Session locked after the page remained hidden for 60 seconds.' : 'Session locked after 5 minutes without user activity.')
        : 'In-memory signing key released; encrypted vault retained.',
    )
    setWallet(null)
    setSaved(true)
    setSnapshot(null)
    setWalletTransactions([])
    setWalletTransactionsAvailable(false)
    setWalletTokenTransfers([])
    setWalletTokenTransfersAvailable(false)
    setLastTx('')
    setLastOperationReference('')
    setLastDelegation(null)
    setUnlockPassword('')
    setCredential('')
    setKeystorePassword('')
    setVaultPassword('')
    notify(
      automatic ? 'info' : 'success',
      automatic ? 'Sponsor Wallet session auto-locked' : 'Sponsor Wallet locked',
      automatic
        ? 'The signing session was cleared. Unlock the encrypted local backup to continue.'
        : 'The in-memory signing key was released. The encrypted local backup remains available to unlock.',
    )
  }, [wallet?.address, recordSecurityEvent, notify])

  useEffect(() => {
    if (!wallet?.address) return undefined
    let idleTimer
    let hiddenTimer
    let locked = false
    const clearIdle = () => { if (idleTimer) window.clearTimeout(idleTimer); idleTimer = undefined }
    const clearHidden = () => { if (hiddenTimer) window.clearTimeout(hiddenTimer); hiddenTimer = undefined }
    const expire = reason => {
      if (locked) return
      locked = true
      lockWallet(reason)
    }
    const armIdle = () => {
      clearIdle()
      idleTimer = window.setTimeout(() => expire('inactivity'), 5 * 60 * 1000)
    }
    const onActivity = () => {
      if (document.hidden) return
      clearHidden()
      armIdle()
    }
    const onVisibilityChange = () => {
      if (document.hidden) {
        clearIdle()
        clearHidden()
        hiddenTimer = window.setTimeout(() => expire('background'), 60 * 1000)
      } else {
        clearHidden()
        armIdle()
      }
    }
    for (const event of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
      window.addEventListener(event, onActivity, { passive: true })
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    armIdle()
    if (document.hidden) onVisibilityChange()
    return () => {
      clearIdle()
      clearHidden()
      for (const event of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
        window.removeEventListener(event, onActivity)
      }
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [wallet?.address, lockWallet])

  function logoutWallet() {
    recordSecurityEvent(wallet?.address, 'Sponsor Wallet logged out', 'Active session cleared; encrypted vault retained for reconnect.')
    setWallet(null)
    setSaved(hasSavedSponsorWallet())
    setSnapshot(null)
      setWalletTransactions([])
    setWalletTransactionsAvailable(false)
    setWalletTokenTransfers([])
    setWalletTokenTransfersAvailable(false)
    setLastTx('')
    setLastOperationReference('')
    setLastDelegation(null)
    setUnlockPassword('')
    setCredential('')
    setKeystorePassword('')
    setVaultPassword('')
    notify('success', 'Sponsor Wallet logged out', 'The active session is disconnected. Your encrypted local backup is retained.')
  }

  function beginReplace() {
    recordSecurityEvent(wallet?.address, 'Sponsor Wallet replacement started', 'Replacement import requested; existing encrypted vault retained until successful import.')
    setWallet(null)
    setSnapshot(null)
      setWalletTransactions([])
    setWalletTransactionsAvailable(false)
    setWalletTokenTransfers([])
    setWalletTokenTransfersAvailable(false)
    setLastTx('')
    setLastOperationReference('')
    setLastDelegation(null)
    setUnlockPassword('')
    setCredential('')
    setKeystorePassword('')
    setVaultPassword('')
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
    setWalletTokenTransfers([])
    setWalletTokenTransfersAvailable(false)
    setUnlockPassword('')
    setCredential('')
    setKeystorePassword('')
    setVaultPassword('')
    notify('success', 'Local wallet backup removed', 'No on-chain account or funds were changed.')
  }

  async function submitResourceTransaction(action, options = {}) {
    if (!wallet || !tronWeb || busy) return
    if (sponsorApiStatus?.transactionExecutionAvailable !== true) { notify('error', 'Sponsor execution is not ready', 'The Resource API requires a verified server signer, durable PostgreSQL ledger, session secret and both explicit Mainnet execution flags. No transaction was sent.'); return }
    if (sponsorApiStatus?.adminTokenRequired === true && adminToken.length < 32) { notify('error', 'Owner Admin authorization required', 'Enter the configured Sponsor Admin token. It is held in memory only and is not saved to browser storage.'); return }
    const selectedAmount = options.amount || (action === 'withdraw' ? formatSunAsTrx(snapshot?.withdrawableSun || '0') : amount)
    const selectedResource = options.resource || resourceType
    let amountSun
    try { amountSun = parseTrx(selectedAmount) } catch (error) { notify('error', 'Invalid resource amount', error.message); return false }
    if (['stake', 'delegate', 'undelegate', 'unstake'].includes(action) && amountSun < SUN) { notify('error', 'Minimum resource amount', 'Use at least 1 TRX for staking or resource delegation.'); return }
    const available = BigInt(snapshot?.trxSun || '0')
    let protectedReserveSun
    try { protectedReserveSun = BigInt(parseTrx(String(sponsorApiStatus?.feePolicy?.protectedReserveTrx || '2'))) }
    catch { notify('error', 'Invalid Sponsor reserve policy', 'The Resource API returned an invalid protected TRX reserve. No transaction was sent.'); return }
    const requiredLiquidSun = (action === 'stake' || action === 'topup' ? BigInt(amountSun) : 0n) + protectedReserveSun
    if (available < requiredLiquidSun) {
      notify('error', 'Insufficient protected TRX reserve', 'The Sponsor Wallet must retain the configured liquid reserve in addition to the requested stake or delegation fee.'); return
    }
    if (action === 'delegate') {
      const maxDelegatable = BigInt(selectedResource === 'ENERGY' ? snapshot?.maxEnergyDelegatableSun || '0' : snapshot?.maxBandwidthDelegatableSun || '0')
      if (BigInt(amountSun) > maxDelegatable) { notify('error', 'Insufficient delegatable stake', 'The requested resource amount exceeds the Sponsor Wallet\'s confirmed Stake 2.0 delegation ceiling.'); return }
    }
    const verb = ({ stake: 'stake', topup: 'top up', delegate: 'delegate', undelegate: 'reclaim delegation', unstake: 'initiate unstaking', withdraw: 'withdraw matured TRX' })[action] || action
    const target = ['stake', 'unstake', 'withdraw'].includes(action) ? wallet.address : OWNER_ADDRESS
    const prompt = action === 'stake'
      ? `Stake ${selectedAmount} TRX for ${selectedResource} in Sponsor Wallet ${wallet.address}?`
      : action === 'topup'
        ? `Send ${selectedAmount} TRX from Sponsor Wallet ${wallet.address} to the existing Owner Wallet ${OWNER_ADDRESS}? This is a real Mainnet TRX transfer.`
        : action === 'delegate'
          ? `Delegate ${selectedAmount} TRX-equivalent of ${selectedResource} from Sponsor Wallet ${wallet.address} to Owner Wallet ${OWNER_ADDRESS}?`
          : action === 'undelegate'
            ? `Reclaim ${selectedAmount} TRX-equivalent of ${selectedResource} delegation from Owner Wallet ${OWNER_ADDRESS} to Sponsor Wallet ${wallet.address}?`
            : action === 'unstake'
              ? `Initiate Stake 2.0 unfreezing of ${selectedAmount} TRX for ${selectedResource} in Sponsor Wallet ${wallet.address}? The TRX will remain locked for the current Mainnet unfreeze delay (normally 14 days) before it can be withdrawn.`
              : `Withdraw all currently matured Stake 2.0 TRX (${selectedAmount}) to Sponsor Wallet ${wallet.address}?`
    if (!window.confirm(`${prompt}

This request is sent to the authenticated TRON Transfer Resource API. The backend enforces the configured fee cap and reserve, signs only the exact intent authorized by this Sponsor Wallet, and records the transaction ID before broadcast. Continue?`)) return
    setBusy(true)
    try {
      const token = await authenticateSponsorWallet(wallet, tronWeb)
      const idempotencyKey = createIdempotencyKey()
      const intent = await sponsorApiRequest('/api/sponsor/intent', {
        method: 'POST', token, adminToken,
        body: { operation: action, resource: ['topup', 'withdraw'].includes(action) ? 'TRX' : selectedResource, amountSun: String(amountSun), idempotencyKey },
      })
      if (typeof intent.message !== 'string' || typeof intent.intentId !== 'string') throw new Error('Sponsor API returned an invalid transaction intent.')
      if (!window.confirm('Authorize this exact Sponsor operation with a signed message?\n\n' + intent.message + '\n\nThis is an off-chain authorization message, not a TRON transaction.')) return
      const signature = await tronWeb.trx.signMessageV2(intent.message, wallet.privateKey)
      const result = await sponsorApiRequest('/api/sponsor/operations', {
        method: 'POST', token, adminToken,
        body: { intentId: intent.intentId, signature, confirmPhrase: intent.confirmationPhrase },
      })
      const transactionId = typeof result.transactionId === 'string' ? result.transactionId : ''
      if (transactionId) {
        setLastTx(transactionId)
        recordSecurityEvent(wallet.address, 'Sponsor transaction submitted by Resource API', action + ' ' + (['topup', 'withdraw'].includes(action) ? 'TRX' : selectedResource) + ' · ' + transactionId)
        const operationReference = result.operationReference || idempotencyKey
        setLastOperationReference(result.solidified || !result.broadcast ? '' : operationReference)
        const event = {
          transactionId, operationReference, sponsorAddress: wallet.address, receiverAddress: target, action,
          resourceType: ['topup', 'withdraw'].includes(action) ? 'TRX' : selectedResource, stakeEquivalentSun: String(amountSun),
          status: result.solidified ? (action === 'delegate' ? 'solidified-mainnet-verified' : 'solidified-mainnet-confirmed') : result.broadcast ? 'broadcast-pending-verification' : 'signed-not-broadcast',
          blockNumber: result.confirmationBlock || null, createdAt: new Date().toISOString(),
        }
        recordActivity(event)
        if (action === 'delegate') setLastDelegation(result.solidified || !result.broadcast ? null : event)
      }
      if (result.success && result.solidified) {
        notify('success', `${verb[0].toUpperCase() + verb.slice(1)} confirmed on Mainnet`, `Solidified transaction: ${transactionId}`)
      } else if (result.broadcast || result.operationStatus === 'broadcast-unknown') {
        if (action === 'delegate') setLastDelegation({
          transactionId, operationReference: result.operationReference || idempotencyKey, sponsorAddress: wallet.address, receiverAddress: OWNER_ADDRESS,
          action, resourceType: selectedResource, stakeEquivalentSun: String(amountSun),
          status: 'broadcast-pending-verification', createdAt: new Date().toISOString(),
        })
        notify('info', 'Sponsor transaction awaiting solidification', `Transaction ID: ${transactionId || 'pending reconciliation'}. Do not submit it again; reconcile the existing operation.`)
      } else {
        throw new Error(result.resultCode || result.error || 'Sponsor transaction was not broadcast.')
      }
      await refresh({ quiet: true })
      return result.success === true && result.solidified === true
    } catch (error) {
      notify('error', 'Sponsor Resource API operation failed', error instanceof Error ? error.message : 'The Sponsor transaction was not completed.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function runResourceAutomation(resource) {
    if (!wallet || !tronWeb || busy) return
    if (!snapshot?.checkedAt) { notify('info', 'Live resource snapshot required', 'Refresh Sponsor and Owner Mainnet resources before provisioning.'); return }
    const checkedAt = Date.parse(snapshot.checkedAt)
    if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > 90_000) {
      await refresh({ quiet: true })
      notify('info', 'Resource snapshot refreshed', 'Review the new live snapshot, then run the provisioning check again. No transaction was sent.')
      return
    }
    if (sponsorApiStatus?.transactionExecutionAvailable !== true) {
      notify('error', 'Sponsor execution is not ready', 'The server signer, database ledger, session authentication and Mainnet execution gates must all be ready. No transaction was sent.')
      return
    }
    if (sponsorApiStatus?.adminTokenRequired === true && adminToken.length < 32) {
      notify('error', 'Owner Admin authorization required', 'Enter the configured Sponsor Admin token before provisioning. No transaction was sent.')
      return
    }
    try {
      const protectedReserveSun = parseTrx(String(sponsorApiStatus?.feePolicy?.protectedReserveTrx || '2'))
      const maxStakeSun = sponsorApiStatus?.stakingPolicy?.enabled === true ? parseTrx(String(sponsorApiStatus.stakingPolicy.maxStakeTrx)) : 0
      const target = resource === 'ENERGY' ? energyTarget : bandwidthTarget
      const ownerAvailable = resource === 'ENERGY' ? snapshot.ownerEnergyAvailable : snapshot.ownerBandwidthAvailable
      const maxDelegatableSun = resource === 'ENERGY' ? snapshot.maxEnergyDelegatableSun : snapshot.maxBandwidthDelegatableSun
      const plan = planSponsorResourceProvisioning({
        resource,
        target,
        ownerAvailable: String(Math.max(0, Math.floor(Number(ownerAvailable || 0)))),
        maxDelegatableSun: String(maxDelegatableSun || '0'),
        sponsorBalanceSun: String(snapshot.trxSun || '0'),
        protectedReserveSun: String(protectedReserveSun),
        network: {
          totalEnergyLimit: snapshot.totalEnergyLimit,
          totalEnergyWeight: snapshot.totalEnergyWeight,
          totalNetLimit: snapshot.totalNetLimit,
          totalNetWeight: snapshot.totalNetWeight,
        },
        stakingEnabled: sponsorApiStatus?.stakingPolicy?.enabled === true,
        maxStakeSun: String(maxStakeSun),
      })
      if (plan.reason === 'target-met') {
        notify('success', resource + ' target already met', 'The latest live Owner resource snapshot meets the configured target. No transaction is needed.')
        return
      }
      if (!plan.ready || !plan.action || !plan.amountSun) {
        notify('error', 'Resource provisioning blocked', plan.message || ('No safe ' + resource + ' action is available: ' + plan.reason + '. No transaction was sent.'))
        return
      }
      const amountTrx = formatSunAsTrx(plan.amountSun)
      const explanation = plan.action === 'stake'
        ? 'This is the incremental Stake 2.0 amount after accounting for current Sponsor delegation capacity. After solidification, refresh live resources and run the check again before delegating.'
        : 'Existing confirmed Sponsor stake can cover the estimated resource deficit. This will delegate the calculated amount to the Owner Wallet.'
      if (!window.confirm('Provision Owner ' + resource + ' target?\n\nNext action: ' + plan.action.toUpperCase() + ' ' + amountTrx + ' TRX-equivalent.\nEstimated resource deficit: ' + Number(plan.deficit).toLocaleString() + '.\n\n' + explanation + '\n\nThis still requires the separate exact-intent Sponsor signature and confirmation.')) return
      const confirmed = await submitResourceTransaction(plan.action, { amount: amountTrx, resource })
      if (confirmed && plan.action === 'stake') {
        notify('info', 'Stake confirmed — delegation is next', 'The stake transaction is solidified. Run the provisioning check again after the refreshed Mainnet resource snapshot; the app will not assume the new capacity before verifying it.')
      } else if (confirmed && plan.action === 'delegate') {
        notify('success', 'Owner resource delegation confirmed', 'The Sponsor delegation is solidified. Refresh Owner resource state before starting deployment or another contract write.')
      }
    } catch (error) {
      notify('error', 'Resource planning failed closed', error instanceof Error ? error.message : 'Could not prepare a safe Mainnet resource action.')
    }
  }

  async function reconcileLastSponsorOperation() {
    if (!wallet || !tronWeb || !lastOperationReference || busy) return
    const local = activity.find((item) => item.operationReference === lastOperationReference)
    setBusy(true)
    try {
      const token = await authenticateSponsorWallet(wallet, tronWeb)
      const result = await sponsorApiRequest('/api/sponsor/operations/' + encodeURIComponent(lastOperationReference), { token })
      const operation = result.operation || {}
      if (operation.status === 'confirmed') {
        const confirmed = {
          ...(local || {}),
          transactionId: operation.transaction_id || local?.transactionId || '',
          operationReference: lastOperationReference,
          sponsorAddress: operation.sponsor_address || wallet.address,
          receiverAddress: ['stake', 'unstake', 'withdraw'].includes(operation.operation) ? (operation.sponsor_address || wallet.address) : (operation.owner_address || OWNER_ADDRESS),
          action: operation.operation || local?.action,
          resourceType: operation.resource || local?.resourceType,
          stakeEquivalentSun: operation.amount_sun || local?.stakeEquivalentSun,
          status: operation.operation === 'delegate' ? 'solidified-mainnet-verified' : 'solidified-mainnet-confirmed',
          blockNumber: operation.confirmation_block || null,
          verifiedAt: new Date().toISOString(),
        }
        recordActivity(confirmed)
        setLastDelegation(null)
        setLastOperationReference('')
        notify('success', 'Sponsor operation reconciled', 'The existing transaction is confirmed in solidified TRON Mainnet state.')
        await refresh({ quiet: true })
      } else {
        notify('info', 'Sponsor operation still pending', 'Ledger status: ' + String(operation.status || 'unknown') + '. Do not create a replacement operation.')
      }
    } catch (error) {
      notify('error', 'Sponsor reconciliation unavailable', error instanceof Error ? error.message : 'Could not reconcile the saved Sponsor operation.')
    } finally { setBusy(false) }
  }

  async function verifyLastDelegation() {
    if (!lastDelegation || !wallet || !tronWeb || busy) return
    setBusy(true)
    try {
      const token = await authenticateSponsorWallet(wallet, tronWeb)
      const payload = await sponsorApiRequest('/api/tron/sponsorship/resource-delegations/verify-wallet', {
        method: 'POST', token,
        body: {
          network: 'mainnet', transactionId: lastDelegation.transactionId,
          sponsorAddress: lastDelegation.sponsorAddress, receiverAddress: lastDelegation.receiverAddress,
          resourceType: lastDelegation.resourceType, stakeEquivalentSun: lastDelegation.stakeEquivalentSun,
        },
      })
      if (payload.verified !== true || payload.persistence?.persisted !== true) {
        const detail = payload.message || payload.resultCode || payload.error || 'The delegation is not yet confirmed in solidified Mainnet state.'
        recordActivity({ ...lastDelegation, status: 'verification-pending', verificationMessage: detail })
        notify('info', 'Mainnet verification pending', detail)
        return
      }
      const verified = { ...lastDelegation, status: 'solidified-mainnet-verified', blockNumber: payload.blockNumber, verifiedAt: new Date().toISOString() }
      recordActivity(verified)
      recordSecurityEvent(wallet.address, 'Delegation verified', 'Solidified Mainnet block ' + payload.blockNumber + ' verified by the Tron Transfer Resource API.')
      setLastDelegation(null)
      notify('success', 'Delegation independently verified', 'Solidified Mainnet block ' + payload.blockNumber + '; verified record persisted in the Sponsor ledger.')
      await refresh({ quiet: true })
    } catch (error) {
      notify('error', 'Mainnet verification unavailable', error instanceof Error ? error.message : 'Could not reach the Sponsor Resource API.')
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

  useEffect(() => {
    if (!wallet || !snapshot || !energyTargetValid || !bandwidthTargetValid) return
    const shortfall = ownerEnergyDeficit > 0 || ownerBandwidthDeficit > 0
    const nextState = shortfall ? 'shortfall' : 'ready'
    if (resourceAlertState.current !== nextState) {
      if (shortfall) notify('info', 'Owner resources below target', 'Energy shortfall: ' + ownerEnergyDeficit.toLocaleString() + ' units; Bandwidth shortfall: ' + ownerBandwidthDeficit.toLocaleString() + ' bytes. Review the prepared stake estimates before signing.')
      else if (resourceAlertState.current === 'shortfall') notify('success', 'Owner resource targets met', 'The latest confirmed resource snapshot meets both configured targets.')
      resourceAlertState.current = nextState
    }
  }, [wallet?.address, snapshot, energyTargetValid, bandwidthTargetValid, ownerEnergyDeficit, ownerBandwidthDeficit, notify])

  useEffect(() => { resourceAlertState.current = 'unknown' }, [wallet?.address])



  return <section className="sponsor-manager">
    <CenterToast toast={toast} onClose={() => setToast(null)}/>
    <header className="sponsor-manager-header">
      <div><span className="sponsor-eyebrow">PRIVATE SPONSOR CONSOLE · TRON MAINNET</span><h2>TRON TRANSFER SPONSOR</h2><p>Independent treasury workspace for resource capacity, owner funding, delegation and transaction audit.</p></div>
      <span className="sponsor-network-pill"><i/> TRON MAINNET · LIVE DATA CHECK</span>
    </header>
    <nav className="sponsor-product-tabs" aria-label="Sponsor platform sections">
      {[['sponsor','Overview'],['sponsor-resources','Resources'],['sponsor-automation','Automation'],['sponsor-activity','Activity']].map(([id,label]) => <button key={id} type="button" className={activePage === id ? 'active' : ''} aria-current={activePage === id ? 'page' : undefined} onClick={() => onNavigate(id)}>{label}</button>)}
    </nav>

    {wallet && activePage === 'sponsor' && <section className="sponsor-card">
      <div className="sponsor-card-heading"><ShieldCheck/><div><h3>Sponsor Resource API execution readiness</h3><p>Server-side signing, exact-intent authorization and durable operation ledger.</p></div></div>
      <p className="sponsor-muted">API: {sponsorApiStatus?.success ? 'reachable' : 'checking / unavailable'} · PostgreSQL: {formatSponsorDatabaseStatus(sponsorApiStatus?.databaseStatus, sponsorApiStatus)} · Ledger durability: {sponsorApiStatus?.ledgerDurabilityVerified ? 'backup & restore verified' : 'not verified'} · Ledger writes: {sponsorApiStatus?.sponsorWritesPaused ? 'paused for maintenance' : 'available subject to execution gates'} · Session auth: {sponsorApiStatus?.sessionAuthenticationConfigured ? 'configured' : 'missing'} · Server signer: {sponsorApiStatus?.engineConfigured ? 'address verified' : 'not verified'} · Broadcast gate: {sponsorApiStatus?.engineEnabled ? 'enabled' : 'disabled'} · Stake policy: {sponsorApiStatus?.stakingPolicy?.enabled ? 'enabled · max ' + sponsorApiStatus.stakingPolicy.maxStakeTrx + ' TRX' : 'disabled'} · Owner top-up: {sponsorApiStatus?.ownerTopupPolicy?.enabled ? 'enabled · max ' + sponsorApiStatus.ownerTopupPolicy.maxTopupTrx + ' TRX' : 'disabled'} · Admin authorization: {sponsorApiStatus?.adminTokenRequired ? (sponsorApiStatus?.adminTokenConfigured ? 'required · valid policy' : 'required · token must be at least 32 characters') : 'not required'} · Reserve: {sponsorApiStatus?.feePolicy?.protectedReserveTrx || '2'} TRX · Fee cap: {sponsorApiStatus?.feePolicy?.maxBandwidthFeeSun || '0'} SUN</p>
      {!sponsorApiStatus?.transactionExecutionAvailable && <p className="sponsor-warning">{sponsorApiStatus?.sponsorWritesPaused ? 'Sponsor ledger writes are paused for a database migration or maintenance window. Signing and broadcasting are blocked until the destination ledger is verified and explicitly re-enabled.' : sponsorApiStatus?.ledgerDurabilityVerified !== true ? 'Sponsor writes are blocked until a non-expiring production database, verified backup and tested restore are explicitly attested by the operator.' : sponsorApiStatus?.error || 'Server-side Sponsor execution is unavailable. Stake and delegation actions will fail closed; no browser-side transaction fallback is used.'}</p>}
      {sponsorApiStatus?.transactionExecutionAvailable && <p className="sponsor-security-note"><ShieldCheck/> Exact Sponsor message signature, protected reserve and configured Bandwidth fee cap are required for each operation.</p>}
      {wallet && ['schema-missing', 'control-row-missing'].includes(sponsorApiStatus?.databaseStatus) && <div className="sponsor-ledger-bootstrap">
        <label className="sponsor-field">Sponsor Admin authorization token<input type="password" value={adminToken} onChange={event => setAdminToken(event.target.value)} autoComplete="off" spellCheck="false"/><small>Used only for this authenticated schema-bootstrap request. Held in memory and cleared when the Sponsor wallet locks.</small></label>
        <button type="button" className="sponsor-secondary" disabled={busy || adminToken.length < 32} onClick={() => void bootstrapSponsorLedger()}>{busy ? 'Checking database…' : 'Initialize paused Sponsor ledger schema'}</button>
        <p className="sponsor-warning">This creates the missing ledger tables only. It does not migrate historical records, enable writes, sign transactions or broadcast to Mainnet.</p>
      </div>}
    </section>}

    {activePage === 'sponsor' && !wallet && !saved && <section className="sponsor-card">
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

    {activePage === 'sponsor' && !wallet && saved && <section className="sponsor-card sponsor-unlock-card">
      <div className="sponsor-card-heading"><LockKeyhole/><div><h3>Encrypted Sponsor Wallet saved</h3><p>Unlock this browser's encrypted wallet backup, or replace it by importing another account.</p></div></div>
      <label className="sponsor-field">Vault password<input type="password" value={unlockPassword} onChange={event => setUnlockPassword(event.target.value)} autoComplete="current-password"/></label>
      <div className="sponsor-actions"><button className="sponsor-primary" disabled={busy || !unlockPassword} onClick={() => void unlockWallet()}><UnlockKeyhole size={16}/> {busy ? 'Unlocking…' : 'Unlock Sponsor Wallet'}</button><button className="sponsor-secondary" onClick={() => {setSaved(false);setMode('private-key')}}>Replace / import another</button></div>
      <button className="sponsor-danger-link" onClick={removeVault}>Remove encrypted local backup</button>
    </section>}

    {!wallet && activePage !== 'sponsor' && <section className="sponsor-card sponsor-page-locked"><div className="sponsor-card-heading"><LockKeyhole/><div><h3>Sponsor Wallet is locked</h3><p>Unlock the Sponsor Wallet from Overview to access its live data and existing operations.</p></div></div><button type="button" className="sponsor-primary" onClick={() => onNavigate('sponsor')}>Open Sponsor Overview</button></section>}
    {wallet && <div className="sponsor-dashboard">
      {activePage === "sponsor" && <section id="sponsor-overview" className="sponsor-card sponsor-wallet-summary">
        <div className="sponsor-card-heading"><Wallet/><div><h3>Sponsor Wallet Overview</h3><p>{wallet.address}</p></div></div>
        <div className="sponsor-wallet-actions"><span className="sponsor-status"><i/> Imported · Unlocked</span><button onClick={() => void refresh()} disabled={busy}><RefreshCw size={15}/> Refresh</button><button onClick={() => lockWallet()}><LockKeyhole size={15}/> Lock</button><button onClick={logoutWallet}><LogOut size={15}/> Logout</button><button onClick={beginReplace}>Replace</button></div>
        <div className="sponsor-metric-grid">
          <article><small>TRX BALANCE</small><strong>{snapshot ? formatAmount(snapshot.trxSun) : '—'}</strong></article>
          <article><small>OFFICIAL USDT</small><strong>{snapshot ? (Number(snapshot.usdt) / 1e6).toLocaleString(undefined,{maximumFractionDigits:6}) : '—'}</strong></article>
          <article><small>ENERGY AVAILABLE</small><strong>{snapshot ? energyAvailable.toLocaleString() : '—'}</strong><small>{snapshot ? `${snapshot.energyUsed.toLocaleString()} used / ${snapshot.energyLimit.toLocaleString()} limit` : 'Refresh to read'}</small></article>
          <article><small>BANDWIDTH AVAILABLE</small><strong>{snapshot ? Number(snapshot.maxSingleTransactionBandwidth || Math.max(bandwidthAvailable, freeBandwidthAvailable)).toLocaleString() : '—'}</strong><small>{snapshot ? `${bandwidthAvailable.toLocaleString()} staked + ${freeBandwidthAvailable.toLocaleString()} free` : 'Refresh to read'}</small></article>
        </div>
        <p className="sponsor-muted">Owner recipient: <code>{OWNER_ADDRESS}</code></p>
        <p className="sponsor-muted">Session protection: automatically locks after 5 minutes without activity or 60 seconds with this page in the background. Locking clears the in-memory signing session; the encrypted local backup remains.</p>
        {snapshot?.resourceReadSource && <p className="sponsor-muted">Resource data source: {snapshot.resourceReadSource === 'resource-api' ? 'TRON Transfer Resource API' : 'Direct TronWeb fallback'}{snapshot.resourceRpcProviders ? ' · ' + Object.values(snapshot.resourceRpcProviders).join(' / ') : ''}</p>}
        {snapshot?.checkedAt && <p className="sponsor-muted">Last live check: {new Date(snapshot.checkedAt).toLocaleString()}</p>}
        {lastTx && <p className="sponsor-tx-link">Last transaction: <a href={`https://tronscan.org/#/transaction/${lastTx}`} target="_blank" rel="noreferrer">{lastTx}</a></p>}
      </section>}

      {activePage === "sponsor-resources" && <section id="sponsor-resources" className="sponsor-card">
        <div className="sponsor-card-heading"><ArrowDownUp/><div><h3>Resource &amp; Stake 2.0 Management</h3><p>Stake, delegate, reclaim, initiate unstaking, and withdraw matured Sponsor TRX.</p></div></div>
        {sponsorApiStatus?.adminTokenRequired === true && <label className="sponsor-field">Sponsor Admin authorization token<input type="password" value={adminToken} onChange={event => setAdminToken(event.target.value)} autoComplete="off" spellCheck="false"/><small>Required by the Resource API for Sponsor writes. Sent only over HTTPS, held in memory, and cleared when the Sponsor wallet locks or disconnects.</small></label>}
        <div className="sponsor-resource-controls">
          <label className="sponsor-field">Amount (TRX)<input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)}/></label>
          <label className="sponsor-field">Resource<select value={resourceType} onChange={event => setResourceType(event.target.value)}><option value="ENERGY">Energy</option><option value="BANDWIDTH">Bandwidth</option></select></label>
        </div>
        <div className="sponsor-actions">
          <button className="sponsor-secondary" disabled={!energyStakeEstimate || busy} onClick={() => {setResourceType('ENERGY');setAmount(formatSunAsTrx(energyStakeEstimate))}}>Prepare Energy stake · {energyStakeEstimate ? formatAmount(energyStakeEstimate) + ' TRX' : 'estimate unavailable'}</button>
          <button className="sponsor-secondary" disabled={!bandwidthStakeEstimate || busy} onClick={() => {setResourceType('BANDWIDTH');setAmount(formatSunAsTrx(bandwidthStakeEstimate))}}>Prepare Bandwidth stake · {bandwidthStakeEstimate ? formatAmount(bandwidthStakeEstimate) + ' TRX' : 'estimate unavailable'}</button>
        </div>
        <p className="sponsor-muted">Stake estimates use the current network-wide Energy/Bandwidth limit and weight returned by the node. They include a 15% planning buffer, but are not guaranteed resource quotes; recheck live sponsor balance and delegation ceilings before signing.</p><p className="sponsor-warning">USDT is shown as a capital balance only. Stake 2.0 requires TRX; this module does not swap USDT automatically. A USDT balance by itself does not create Energy or Bandwidth.</p>
        <div className="sponsor-actions"><button className="sponsor-secondary" disabled={busy || !snapshot || sponsorApiStatus?.transactionExecutionAvailable !== true || sponsorApiStatus?.stakingPolicy?.enabled !== true} onClick={() => void submitResourceTransaction('stake')}>Stake TRX for {resourceType} · max {sponsorApiStatus?.stakingPolicy?.maxStakeTrx || '0'} TRX</button><button className="sponsor-primary" disabled={busy || !snapshot || sponsorApiStatus?.transactionExecutionAvailable !== true} onClick={() => void submitResourceTransaction('delegate')}>Delegate {resourceType} to Owner</button><button className="sponsor-secondary" disabled={busy || !snapshot || sponsorApiStatus?.transactionExecutionAvailable !== true} onClick={() => void submitResourceTransaction('undelegate')}>Reclaim {resourceType} delegation from Owner</button><button className="sponsor-secondary" disabled={busy || !snapshot || sponsorApiStatus?.transactionExecutionAvailable !== true} onClick={() => void submitResourceTransaction('unstake')}>Initiate {resourceType} unstake · delay applies</button><button className="sponsor-secondary" disabled={busy || !snapshot || !/^[1-9][0-9]*$/.test(String(snapshot?.withdrawableSun || '0')) || sponsorApiStatus?.transactionExecutionAvailable !== true} onClick={() => void submitResourceTransaction('withdraw')}>Withdraw matured TRX · {snapshot ? formatAmount(snapshot.withdrawableSun) : '—'} TRX</button><button className="sponsor-secondary" disabled={busy || !snapshot || sponsorApiStatus?.transactionExecutionAvailable !== true || sponsorApiStatus?.ownerTopupPolicy?.enabled !== true} onClick={() => void submitResourceTransaction('topup')}>Send TRX to Owner · max {sponsorApiStatus?.ownerTopupPolicy?.maxTopupTrx || 'disabled'} TRX</button><button className="sponsor-secondary" disabled={busy || !lastOperationReference} onClick={() => void reconcileLastSponsorOperation()}>Reconcile last Sponsor operation</button><button className="sponsor-secondary" disabled={busy || !lastDelegation} onClick={() => void verifyLastDelegation()}>Verify Mainnet delegation</button><button className="sponsor-secondary" disabled title="No authorized Mainnet resource-rental provider is configured">Acquire Energy / Bandwidth · Provider unavailable</button></div>
        <p className="sponsor-muted">Pending unfreeze schedule: {snapshot?.pendingUnfreezes?.length ? snapshot.pendingUnfreezes.map((item, index) => <span key={item.resourceType + '-' + item.expiresAt + '-' + index}>{item.resourceType} · {formatSunAsTrx(item.amountSun)} TRX · withdrawable after {item.expiresAt ? new Date(item.expiresAt).toLocaleString() : 'date unavailable'}{index < snapshot.pendingUnfreezes.length - 1 ? ' · ' : ''}</span>) : 'No pending unfreeze requests.'}</p>
        <p className="sponsor-muted">Confirmed delegation ceiling: {snapshot ? formatAmount(resourceType === 'ENERGY' ? snapshot.maxEnergyDelegatableSun : snapshot.maxBandwidthDelegatableSun) + ' TRX equivalent' : 'Refresh to read'} · Self-staked Energy: {snapshot ? formatAmount(snapshot.frozenEnergySun) : '—'} TRX · Self-staked Bandwidth: {snapshot ? formatAmount(snapshot.frozenBandwidthSun) : '—'} TRX · Pending unfreeze: {snapshot ? formatAmount(snapshot.pendingUnfreezeSun) : '—'} TRX · Matured and withdrawable: {snapshot ? formatAmount(snapshot.withdrawableSun) : '—'} TRX · Available unfreeze slots: {snapshot?.availableUnfreezeCount ?? '—'}.</p><p className="sponsor-warning">Unstaking first starts the Stake 2.0 unfreeze delay (currently 14 days on Mainnet); it does not return liquid TRX immediately. Undelegate resources from the Owner before unstaking the corresponding stake. Withdraw is enabled only for the exact currently matured amount. Every operation is checked again by the server against confirmed Mainnet state before signing.</p>
      </section>}

      {activePage === "sponsor-automation" && <section id="sponsor-automation" className="sponsor-card">
        <div className="sponsor-card-heading"><Activity/><div><h3>Guided Resource Provisioning</h3><p>Live Owner resource targets with guarded Sponsor stake-or-delegate planning.</p></div></div>
        <div className="sponsor-resource-controls"><label className="sponsor-field">Owner Energy target (units)<input inputMode="numeric" value={energyTarget} onChange={event => setEnergyTarget(event.target.value.replace(/[^0-9]/g, '').slice(0, 15))}/><small>Default planning target only. Set this to the current deployment estimate from Owner Admin preflight.</small></label><label className="sponsor-field">Owner Bandwidth target (bytes)<input inputMode="numeric" value={bandwidthTarget} onChange={event => setBandwidthTarget(event.target.value.replace(/[^0-9]/g, '').slice(0, 15))}/></label></div><div className="sponsor-engine-grid"><div><small>OWNER TARGET</small><strong>{OWNER_ADDRESS}</strong></div><div><small>SPONSOR ENERGY STAKED</small><strong>{snapshot?.delegationReadAvailable ? formatAmount(snapshot.delegatedEnergySun) + ' TRX eq.' : 'Unavailable'}</strong></div><div><small>SPONSOR BANDWIDTH STAKED</small><strong>{snapshot?.delegationReadAvailable ? formatAmount(snapshot.delegatedBandwidthSun) + ' TRX eq.' : 'Unavailable'}</strong></div><div><small>OWNER ENERGY AVAILABLE</small><strong>{snapshot ? Number(snapshot.ownerEnergyAvailable || 0).toLocaleString() : '—'}</strong></div><div><small>OWNER BANDWIDTH AVAILABLE</small><strong>{snapshot ? Number(snapshot.ownerBandwidthAvailable || 0).toLocaleString() : '—'}</strong></div><div><small>ENERGY TARGET DEFICIT</small><strong>{snapshot ? ownerEnergyDeficit.toLocaleString() : '—'}</strong></div><div><small>BANDWIDTH TARGET DEFICIT</small><strong>{snapshot ? ownerBandwidthDeficit.toLocaleString() : '—'}</strong></div><div><small>RESOURCE PRECHECK</small><strong>{!energyTargetValid || !bandwidthTargetValid ? 'Invalid targets' : snapshot ? (ownerEnergyDeficit === 0 && ownerBandwidthDeficit === 0 ? 'Targets met' : 'Resource shortfall') : 'Awaiting live read'}</strong></div></div>
        <div className="sponsor-actions"><button className="sponsor-primary" disabled={busy || !wallet || !snapshot || !energyTargetValid || !sponsorApiStatus?.transactionExecutionAvailable} onClick={() => void runResourceAutomation('ENERGY')}>Provision Owner Energy target</button><button className="sponsor-primary" disabled={busy || !wallet || !snapshot || !bandwidthTargetValid || !sponsorApiStatus?.transactionExecutionAvailable} onClick={() => void runResourceAutomation('BANDWIDTH')}>Provision Owner Bandwidth target</button><button className="sponsor-secondary" disabled={busy || !wallet} onClick={() => void refresh()}>Run Resource Preflight</button><button className="sponsor-secondary" onClick={() => onNavigate('deploy')}>Open Owner Admin deployment preflight</button><button className="sponsor-secondary" onClick={() => onNavigate('portfolio')}>Open Owner portfolio</button></div><p className="sponsor-warning">Sponsor and Owner resource snapshots refresh automatically every 60 seconds while the Sponsor wallet is unlocked. The planner chooses only the next safe stake or delegation action from a fresh Mainnet snapshot. Every action still requires an exact Sponsor message signature and explicit on-screen confirmation; after staking, it requires a new live resource read before delegation. A provider rental or free-grant adapter is not configured by this wallet import.</p>
      </section>}

      {activePage === "sponsor-activity" && <section id="sponsor-activity" className="sponsor-card">
        <div className="sponsor-card-heading"><FileKey2/><div><h3>Sponsor Activity</h3><p>Current browser session and latest observed transaction.</p></div></div>
        <div className="sponsor-activity-row"><span>Wallet connection</span><b>Unlocked locally</b></div>
        <div className="sponsor-activity-row"><span>Network</span><b>TRON Mainnet</b></div><div className="sponsor-activity-row"><span>Security events</span><b>{securityEvents.length} local events</b></div>{securityEvents.slice(0, 5).map((item, index) => <div className="sponsor-activity-row" key={item.createdAt + index}><span>{item.event} · {new Date(item.createdAt).toLocaleString()}</span><b>{item.detail}</b></div>)}
        <div className="sponsor-activity-row"><span>Resource history</span><b>{activity.length} local records · {activity.filter((item) => String(item.status || '').startsWith('solidified-mainnet-')).length} independently verified</b></div><div className="sponsor-activity-row"><span>Recent wallet transactions</span><b>{walletTransactionsAvailable ? walletTransactions.length + ' confirmed chain records' : 'History unavailable'}</b></div>{walletTransactions.slice(0, 8).map((item) => { const txid = item.txID || item.txid; const type = item.raw_data?.contract?.[0]?.type || 'TRON transaction'; const result = item.ret?.[0]?.contractRet || 'CONFIRMED'; return <div className="sponsor-activity-row" key={txid}><span>{type} · {item.block_timestamp ? new Date(item.block_timestamp).toLocaleString() : 'Confirmed on-chain'}</span><b>{result} <a href={'https://tronscan.org/#/transaction/' + txid} target="_blank" rel="noreferrer">View</a></b></div>})}<div className="sponsor-activity-row"><span>Official USDT transfers</span><b>{walletTokenTransfersAvailable ? walletTokenTransfers.length + ' confirmed transfers' : 'History unavailable'}</b></div>{walletTokenTransfers.slice(0, 8).map((item) => { const txid = item.transaction_id; const sent = item.from === wallet.address; const amount = formatTokenUnits(item.value, 6); return <div className="sponsor-activity-row" key={txid}><span>{sent ? 'Sent' : 'Received'} {amount} USDT · {new Date(item.block_timestamp || 0).toLocaleString()}</span><b>{sent ? 'To ' + item.to : 'From ' + item.from} <a href={'https://tronscan.org/#/transaction/' + txid} target="_blank" rel="noreferrer">View</a></b></div>})}{activity.slice(0, 8).map((item) => <div className="sponsor-activity-row" key={item.transactionId}><span>{item.action === 'stake' ? 'Stake' : item.action === 'topup' ? 'TRX top-up' : item.action === 'undelegate' ? 'Reclaim delegation' : item.action === 'unstake' ? 'Unstake request' : item.action === 'withdraw' ? 'Matured withdrawal' : 'Delegation'} · {item.resourceType} · {new Date(item.createdAt).toLocaleString()}</span><b>{item.status === 'solidified-mainnet-verified' ? 'Verified · block ' + item.blockNumber : item.status === 'solidified-mainnet-confirmed' ? 'Confirmed · block ' + (item.blockNumber || '—') : item.status === 'verification-pending' ? 'Awaiting solidification / retry' : 'Broadcast · not yet verified'} <a href={'https://tronscan.org/#/transaction/' + item.transactionId} target="_blank" rel="noreferrer">View</a></b></div>)}
      </section>}
    </div>}
    
  </section>
}
