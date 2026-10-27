import { useCallback, useEffect, useState } from 'react'
import { Activity, ArrowLeft, CheckCircle2, CircleAlert, Copy, ExternalLink, LockKeyhole, RefreshCw, ShieldCheck, Wallet, Zap } from 'lucide-react'
import { getTronScanNetworkLabel, getTronScanTransactionUrl } from './tron-explorer.mjs'

type Network = 'shasta' | 'nile'
type WalletSnapshot = { address: string; host: string; network: Network; checkedAt: string }
type ResourceKind = 'ENERGY' | 'BANDWIDTH'
type DelegationIntent = {
  network: Network
  transactionId: string
  sponsorAddress: string
  receiverAddress: string
  resourceType: ResourceKind
  stakeEquivalentSun: string
  status: string
  createdAt: string
}
type ApiPayload = { success?: boolean; status?: string; error?: string; message?: string; [key: string]: any }
type SponsorRolesSnapshot = ApiPayload & {
  network?: Network
  checkedAt?: string
  accountsConfigured?: boolean
  configuredAddressesDistinct?: boolean
  roles?: {
    networkFeeSponsor?: ApiPayload
    assetPrincipalSponsor?: ApiPayload
  }
  feeSponsorDelegationToPrincipal?: ApiPayload
}

declare global {
  interface Window {
    tronLink?: { request?: (request: { method: string }) => Promise<unknown>; tronWeb?: any; on?: (event: string, listener: (...args: any[]) => void) => unknown; removeListener?: (event: string, listener: (...args: any[]) => void) => unknown }
    tron?: { request?: (request: { method: string; params?: unknown }) => Promise<unknown>; tronWeb?: any; on?: (event: string, listener: (...args: any[]) => void) => unknown; removeListener?: (event: string, listener: (...args: any[]) => void) => unknown }
    tronWeb?: any
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const HOSTS: Record<Network, string> = {
  shasta: 'api.shasta.trongrid.io',
  nile: 'nile.trongrid.io',
}
const DELEGATION_STORAGE_KEY = 'trc20-usdt-token-cloner:sponsor-delegation:v1'
const SPONSOR_ROLE_WALLETS_STORAGE_KEY = 'tron-token-studio:sponsor-role-wallets:v1'

type SponsorRoleSlot = 'assetPrincipal' | 'networkFee'

// Persist only public role addresses and public node metadata so account switching
// or reopening this console does not erase the operator's two configured roles.
// A restored snapshot is always stale until the injected wallet is re-read live.
function loadSavedSponsorWallet(network: Network, role: SponsorRoleSlot): WalletSnapshot | null {
  if (typeof window === 'undefined') return null
  try {
    const saved = JSON.parse(window.localStorage.getItem(SPONSOR_ROLE_WALLETS_STORAGE_KEY) || '{}')
    const value = saved?.[network]?.[role]
    if (!value || typeof value !== 'object' || value.network !== network
      || typeof value.address !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value.address)
      || value.host !== 'https://' + HOSTS[network]
      || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) return null
    return { address: value.address, host: value.host, network, checkedAt: value.checkedAt }
  } catch {
    return null
  }
}

function persistSponsorWallet(network: Network, role: SponsorRoleSlot, snapshot: WalletSnapshot | null) {
  if (typeof window === 'undefined' || !snapshot || snapshot.network !== network
    || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(snapshot.address)
    || snapshot.host !== 'https://' + HOSTS[network]) return
  try {
    const existing = JSON.parse(window.localStorage.getItem(SPONSOR_ROLE_WALLETS_STORAGE_KEY) || '{}')
    const all = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
    const forNetwork = all[network] && typeof all[network] === 'object' && !Array.isArray(all[network])
      ? all[network] : {}
    window.localStorage.setItem(SPONSOR_ROLE_WALLETS_STORAGE_KEY, JSON.stringify({
      ...all,
      [network]: { ...forNetwork, [role]: snapshot },
    }))
  } catch {
    // Storage is only a convenience; live wallet checks remain authoritative.
  }
}

function getInjectedTronProvider(): any {
  const candidates = [window.tron, window.tronLink]
  return candidates.find(provider => provider && provider.isTronLink === true
    && typeof provider.request === 'function') || null
}

async function requestTronWalletAccess(provider: any): Promise<unknown> {
  try {
    return await provider.request({ method: 'eth_requestAccounts' })
  } catch (caught) {
    const code = Number((caught as any)?.code)
    const rawMessage = typeof caught === 'string' ? caught : String((caught as any)?.message || '')
    if (code === -32601 || code === 4200 || /method not found|unsupported method|method not supported/i.test(rawMessage)) {
      return provider.request({ method: 'tron_requestAccounts' })
    }
    throw caught
  }
}

function walletConnectionError(caught: unknown): string {
  const code = Number((caught as any)?.code)
  const raw = (typeof caught === 'string' ? caught : String((caught as any)?.message || '')).trim()
  if (code === 4001 || /confirmation declined by user|user rejected the request|request rejected/i.test(raw)) {
    return 'The wallet request was declined. Retry and approve the requested connection/signature in TronLink.'
  }
  if (code === -32002 || /already pending|request is already pending|already processing a request/i.test(raw)) {
    return 'A TronLink request is already open. Finish or close that wallet prompt before trying again.'
  }
  if (/user has not unlocked wallet|wallet is locked|wallet not unlocked/i.test(raw)) {
    return 'Unlock TronLink, select the required sponsor account, then reconnect.'
  }
  return raw.slice(0, 240) || 'The wallet action failed. Confirm TronLink is connected and try again.'
}

const SPONSOR_BLOCKER_GUIDANCE: Record<string, string> = {
  'fee-sponsor-resource-capacity-not-verified': 'Refresh live diagnostics and inspect the resource failure stage below. The backend must read the fee sponsor’s fresh resource counters and delegation ceilings before the operator can delegate or prepare a transfer.',
  'active-fee-to-principal-resource-delegation-not-verified': 'After resource reads are healthy, switch TronLink to the configured fee-sponsor account, reconnect it, and have that wallet owner explicitly approve a suitable Energy or Bandwidth delegation to the distinct asset-principal address. Refresh this preflight after solidified verification.',
  'sponsor-ownership-and-spending-mandate-require-independent-review': 'Use only a real sponsor-approved testnet agreement and the corresponding exact scope in SPONSOR_APPROVED_AGREEMENT_REFERENCES. An address or balance does not establish authorization.',
  'post-transfer-fee-settlement-and-receiver-reconciliation-not-end-to-end-verified': 'This requires a real signed testnet transfer, a solidified receipt, verified receiver balance, and separately recorded sponsor-cost evidence. Do not mark a reservation confirmed from node acceptance alone.',
  'fee-sponsor-on-chain-balance-not-verified': 'Check the live fee-sponsor balance read and provider status. A zero balance is a real zero, not an amount the UI can increase; resource capacity must be independently verified as well.',
  'asset-principal-on-chain-balance-not-verified': 'Recheck the configured asset-principal address on the selected testnet. Only actual chain balances can fund the principal transfer.',
}

function loadSavedDelegationIntent(): DelegationIntent | null {
  if (typeof window === 'undefined') return null
  try {
    const saved = window.localStorage.getItem(DELEGATION_STORAGE_KEY)
    if (!saved) return null
    const value = JSON.parse(saved)
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['shasta', 'nile'].includes(value.network)
      || typeof value.transactionId !== 'string' || !/^[0-9a-f]{64}$/i.test(value.transactionId)
      || typeof value.sponsorAddress !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value.sponsorAddress)
      || typeof value.receiverAddress !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value.receiverAddress)
      || value.sponsorAddress === value.receiverAddress
      || !['ENERGY', 'BANDWIDTH'].includes(value.resourceType)
      || typeof value.stakeEquivalentSun !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value.stakeEquivalentSun)
      || typeof value.status !== 'string' || value.status.length > 64
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
      window.localStorage.removeItem(DELEGATION_STORAGE_KEY)
      return null
    }
    return value as DelegationIntent
  } catch {
    return null
  }
}

function trxAmountToSun(value: string): string | null {
  const input = value.trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(input)) return null
  const [whole, fraction = ''] = input.split('.')
  const sun = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
  if (sun < 1_000_000n || sun > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return sun.toString()
}

function formatBaseUnitsForDisplay(value: unknown, decimalsValue: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)
    || typeof decimalsValue !== 'number' || !Number.isInteger(decimalsValue)
    || decimalsValue < 0 || decimalsValue > 30) return 'unavailable'
  if (decimalsValue === 0) return value
  const padded = value.padStart(decimalsValue + 1, '0')
  const whole = padded.slice(0, -decimalsValue)
  const fraction = padded.slice(-decimalsValue).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

function tronAddressMatches(tronWeb: any, actual: unknown, expected: string): boolean {
  if (actual === expected) return true
  if (typeof actual !== 'string' || !actual.trim()) return false
  try {
    const expectedHex = String(tronWeb.address.toHex(expected) || '').replace(/^0x/i, '').toLowerCase()
    let actualHex = actual.trim().replace(/^0x/i, '').toLowerCase()
    if (/^[0-9a-f]{40}$/i.test(actualHex)) actualHex = '41' + actualHex
    if (actualHex === expectedHex) return true
    if (typeof tronWeb.address.fromHex === 'function' && /^41[0-9a-f]{40}$/i.test(actualHex)) {
      return tronWeb.address.fromHex(actualHex) === expected
    }
  } catch {
    return false
  }
  return false
}

function validateUnsignedDelegation(
  tronWeb: any,
  transaction: any,
  sponsorAddress: string,
  receiverAddress: string,
  resourceType: ResourceKind,
  stakeEquivalentSun: string,
) {
  const contracts = transaction?.raw_data?.contract
  if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== 'DelegateResourceContract') {
    throw new Error('The local wallet provider returned an unexpected transaction type; no signature was requested.')
  }
  const value = contracts[0]?.parameter?.value
  if (!value
    || !tronAddressMatches(tronWeb, value.owner_address ?? value.ownerAddress, sponsorAddress)
    || !tronAddressMatches(tronWeb, value.receiver_address ?? value.receiverAddress, receiverAddress)
    || String(value.balance ?? '') !== stakeEquivalentSun) {
    throw new Error('The unsigned delegation does not match the selected fee sponsor, principal sponsor, and exact stake amount.')
  }
  const rawResource = value.resource ?? value.resourceType
  const normalizedResource = typeof rawResource === 'number'
    ? (rawResource === 1 ? 'ENERGY' : rawResource === 0 ? 'BANDWIDTH' : '')
    : String(rawResource ?? '').toUpperCase()
  if (normalizedResource !== resourceType) {
    throw new Error('The unsigned delegation resource type does not match the selected resource.')
  }
  if (value.lock === true || value.lock === 1 || ['true', '1'].includes(String(value.lock).toLowerCase())) {
    throw new Error('Locked resource delegation is not permitted by this console. No signature was requested.')
  }
  const expiration = Number(transaction?.raw_data?.expiration)
  if (!Number.isSafeInteger(expiration) || expiration <= Date.now() + 2_000 || expiration > Date.now() + 10 * 60 * 1000) {
    throw new Error('The unsigned delegation expiration is missing or outside the allowed 10-minute window.')
  }
  if (!/^[0-9a-f]{64}$/i.test(String(transaction?.txID || ''))
    || !/^(?:[0-9a-f]{2})+$/i.test(String(transaction?.raw_data_hex || ''))) {
    throw new Error('The unsigned delegation has no valid transaction ID or raw bytes.')
  }
}

function readInjectedWallet(network: Network): WalletSnapshot {
  const tronWeb = getInjectedTronProvider()?.tronWeb || window.tronWeb
  const address = String(tronWeb?.defaultAddress?.base58 || '').trim()
  const rawHost = String(tronWeb?.fullNode?.host || tronWeb?.fullNode?.nodeUrl || '').trim()
  let host: URL
  try { host = new URL(rawHost) } catch { throw new Error('TronLink did not expose a verifiable node URL. Reconnect the sponsor wallet.') }
  if (!address) throw new Error('TronLink is connected, but no active sponsor address was returned.')
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) throw new Error('TronLink returned an invalid sponsor address.')
  if (host.protocol !== 'https:' || host.hostname.toLowerCase() !== HOSTS[network]
    || host.username || host.password || host.port || host.search || host.hash
    || (host.pathname !== '' && host.pathname !== '/')) {
    throw new Error('Wrong network. Select ' + (network === 'nile' ? 'Nile' : 'Shasta') + ' in TronLink before continuing. No automatic network switch is used.')
  }
  return { address, host: host.origin, network, checkedAt: new Date().toISOString() }
}

async function requestJson(url: string, init?: RequestInit): Promise<{ response: Response; payload: ApiPayload }> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
  })
  const payload = await response.json().catch(() => ({})) as ApiPayload
  return { response, payload }
}

export default function SponsorSignerConsole() {
  const [network, setNetwork] = useState<Network>('nile')
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [wallet, setWallet] = useState<WalletSnapshot | null>(() => loadSavedSponsorWallet('nile', 'assetPrincipal'))
  const [walletNeedsReconnect, setWalletNeedsReconnect] = useState(true)
  const [feeWallet, setFeeWallet] = useState<WalletSnapshot | null>(() => loadSavedSponsorWallet('nile', 'networkFee'))
  const [feeWalletNeedsReconnect, setFeeWalletNeedsReconnect] = useState(true)
  const [resourceType, setResourceType] = useState<ResourceKind>('BANDWIDTH')
  const [resourceAmountTRX, setResourceAmountTRX] = useState('1')
  const [delegationIntent, setDelegationIntent] = useState<DelegationIntent | null>(() => loadSavedDelegationIntent())
  const [delegationResult, setDelegationResult] = useState<ApiPayload | null>(null)
  const [serverStatus, setServerStatus] = useState<ApiPayload | null>(null)
  const [roleStatus, setRoleStatus] = useState<SponsorRolesSnapshot | null>(null)
  const [pilotPreflight, setPilotPreflight] = useState<ApiPayload | null>(null)
  const [busy, setBusy] = useState<'connecting' | 'checking' | 'signing' | 'delegating' | 'verifying' | null>(null)
  const [message, setMessage] = useState('Connect the asset-principal sponsor wallet on the selected testnet.')
  const [error, setError] = useState('')
  const [lastIntent, setLastIntent] = useState<ApiPayload | null>(null)
  const [lastResult, setLastResult] = useState<ApiPayload | null>(null)
  const [settlementCheck, setSettlementCheck] = useState<ApiPayload | null>(null)
  const [reconciliationCommandStatus, setReconciliationCommandStatus] = useState('')

  const refreshSponsorRoles = useCallback(async (selectedNetwork: Network): Promise<{ ok: boolean; message?: string; payload?: SponsorRolesSnapshot }> => {
    try {
      const result = await requestJson(API_BASE + '/api/tron/sponsorship/roles?network=' + encodeURIComponent(selectedNetwork) + '&refresh=1')
      if (!result.response.ok || result.payload.success !== true || result.payload.network !== selectedNetwork) {
        setRoleStatus(null)
        return { ok: false, message: result.payload.message || result.payload.error || 'Sponsor role diagnostics could not be verified.' }
      }
      setRoleStatus(result.payload as SponsorRolesSnapshot)
      return { ok: true, payload: result.payload as SponsorRolesSnapshot }
    } catch (caught) {
      setRoleStatus(null)
      return { ok: false, message: caught instanceof Error ? caught.message : 'Sponsor role diagnostics could not be loaded.' }
    }
  }, [])

  const refreshPilotPreflight = useCallback(async () => {
    try {
      const result = await requestJson(API_BASE + '/api/tron/sponsorship/testnet-pilot-readiness?network=both&refresh=1')
      if (!result.response.ok || result.payload.success !== true || !result.payload.networks) {
        throw new Error(result.payload.message || result.payload.error || 'Dual-testnet pilot preflight could not be verified.')
      }
      setPilotPreflight(result.payload)
    } catch (caught) {
      setPilotPreflight({
        success: false,
        status: 'testnet-pilot-preflight-unavailable',
        error: caught instanceof Error ? caught.message : 'Could not load Nile and Shasta pilot diagnostics.',
      })
    }
  }, [])

  const refreshServerStatus = useCallback(async () => {
    setBusy('checking')
    try {
      const result = await requestJson(API_BASE + '/api/tron/sponsorship/status')
      if (!result.response.ok || result.payload.success !== true) throw new Error(result.payload.message || result.payload.error || 'Backend status unavailable.')
      setServerStatus(result.payload.sponsorship || result.payload)
    } catch (caught) {
      setServerStatus(null)
      setError(caught instanceof Error ? caught.message : 'Could not check backend sponsorship status.')
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => { void refreshServerStatus(); void refreshSponsorRoles(network) }, [refreshServerStatus, refreshSponsorRoles, network])

  useEffect(() => { persistSponsorWallet(network, 'assetPrincipal', wallet) }, [network, wallet])
  useEffect(() => { persistSponsorWallet(network, 'networkFee', feeWallet) }, [network, feeWallet])

  useEffect(() => { void refreshPilotPreflight() }, [refreshPilotPreflight])

  // Keep both public sponsor-role snapshots while TronLink has a single active
  // signer account. On account switches, activate only the role whose previously
  // verified address matches the currently injected account. All signing/broadcast
  // handlers still re-read and compare the live wallet and network immediately
  // before requesting a signature, so retaining a role snapshot grants no authority.
  useEffect(() => {
    const provider = getInjectedTronProvider()
    if (!provider?.on) return
    const onAccountsChanged = () => {
      let active: WalletSnapshot | null = null
      try {
        // Re-read the injected provider after the event; never trust an event payload
        // or a saved localStorage value as proof of the active signer.
        active = readInjectedWallet(network)
      } catch {
        active = null
      }
      const assetRoleActive = Boolean(wallet && wallet.network === network && active?.address === wallet.address)
      const feeRoleActive = Boolean(feeWallet && feeWallet.network === network && active?.address === feeWallet.address)
      if (assetRoleActive && active) setWallet(active)
      if (feeRoleActive && active) setFeeWallet(active)
      setWalletNeedsReconnect(!assetRoleActive)
      setFeeWalletNeedsReconnect(!feeRoleActive)
      setLastIntent(null)
      setLastResult(null)
      setSettlementCheck(null)
      setError('')
      if (assetRoleActive) {
        setMessage('TronLink now actively selects the saved asset-principal sponsor on the verified testnet. The fee-sponsor address remains saved, but only the currently selected wallet can sign.')
      } else if (feeRoleActive) {
        setMessage('TronLink now actively selects the saved fee sponsor on the verified testnet. The asset-principal address remains saved, but only the currently selected wallet can sign.')
      } else {
        setError('TronLink account changed to an address that matches neither saved sponsor role. The saved public addresses are retained, but signing is paused until the intended role is selected and verified.')
        setMessage('No signer is active for these saved roles. Select the correct sponsor account in TronLink and reconnect it; no signing or broadcast was triggered.')
      }
    }
    const onChainChanged = () => {
      setWalletNeedsReconnect(true)
      setFeeWalletNeedsReconnect(true)
      setLastIntent(null)
      setLastResult(null)
      setSettlementCheck(null)
      setError('TronLink network changed. Select the intended testnet and reconnect the required sponsor role.')
      setMessage('Network change detected. Signing is paused until the network and active account are re-verified.')
    }
    provider.on('accountsChanged', onAccountsChanged)
    provider.on('chainChanged', onChainChanged)
    return () => {
      provider.removeListener?.('accountsChanged', onAccountsChanged)
      provider.removeListener?.('chainChanged', onChainChanged)
    }
  }, [network, wallet, feeWallet])

  // Persist only public transaction metadata (never a signature, raw transaction or key)
  // so a pending/ambiguous broadcast can be rechecked after the page is reopened.
  useEffect(() => {
    try {
      if (delegationIntent) window.localStorage.setItem(DELEGATION_STORAGE_KEY, JSON.stringify(delegationIntent))
      else window.localStorage.removeItem(DELEGATION_STORAGE_KEY)
    } catch {
      // Private browsing or storage policy may disable persistence; in-memory verification still works.
    }
  }, [delegationIntent])

  const connectWallet = async () => {
    setError('')
    setMessage('Requesting asset-principal sponsor wallet connection…')
    setBusy('connecting')
    try {
      const provider = getInjectedTronProvider()
      if (!provider) {
        throw new Error('TronLink is not detected. Open this console in a browser where the wallet extension or wallet browser is enabled.')
      }
      await requestTronWalletAccess(provider)
      const next = readInjectedWallet(network)
      const rolesResult = await refreshSponsorRoles(network)
      const assetAddress = rolesResult.payload?.roles?.assetPrincipalSponsor?.address
      const feeAddress = rolesResult.payload?.roles?.networkFeeSponsor?.address
      if (!rolesResult.ok || !assetAddress || !feeAddress) {
        throw new Error(rolesResult.message || 'Both configured sponsor-role addresses must be available before connecting the asset-principal signer.')
      }
      if (assetAddress === feeAddress) throw new Error('Fee sponsor and asset-principal sponsor must be different accounts.')
      if (next.address !== assetAddress) {
        throw new Error('The active TronLink account does not match the configured asset-principal sponsor. Switch to that account and reconnect; the fee-sponsor role is retained separately.')
      }
      setWallet(next)
      setWalletNeedsReconnect(false)
      setMessage('Asset-principal sponsor wallet connected and matched to backend configuration. The fee-sponsor address remains a separate role; no transfer has been signed.')
    } catch (caught) {
      setWalletNeedsReconnect(true)
      setMessage('Asset-principal wallet was not verified for this role. The saved public address is retained for reference; no transaction was signed or broadcast.')
      setError(walletConnectionError(caught))
    } finally {
      setBusy(null)
    }
  }

  const changeNetwork = (value: Network) => {
    setNetwork(value)
    setWallet(loadSavedSponsorWallet(value, 'assetPrincipal'))
    setWalletNeedsReconnect(true)
    setFeeWallet(loadSavedSponsorWallet(value, 'networkFee'))
    setFeeWalletNeedsReconnect(true)
    setRoleStatus(null)
    setLastIntent(null)
    setLastResult(null)
    setSettlementCheck(null)
    setError('')
    setMessage('Network changed. Reconnect the sponsor wallet and verify the new network.')
  }

  const prepareSigningIntent = async () => {
    setError('')
    setLastIntent(null)
    setLastResult(null)
    setSettlementCheck(null)
    setBusy('checking')
    try {
      const key = idempotencyKey.trim()
      if (key.length < 24 || key.length > 160) {
        throw new Error('Enter the reservation idempotency key (24–160 characters) from the approved operator-created request.')
      }
      if (!wallet || walletNeedsReconnect) throw new Error('Reconnect and verify the asset-principal sponsor account in TronLink before continuing. The previous address remains visible for reference only.')
      const beforeReview = readInjectedWallet(network)
      if (beforeReview.address !== wallet.address) {
        throw new Error('The connected wallet account changed. Reconnect and review the reservation.')
      }
      const path = '/api/tron/sponsorship/transfers/' + encodeURIComponent(key)
      const prepared = await requestJson(API_BASE + path + '/signing-intent')
      if (!prepared.response.ok || prepared.payload.success !== true) {
        throw new Error(prepared.payload.message || prepared.payload.error || prepared.payload.status || ('Signing intent unavailable (HTTP ' + prepared.response.status + ').'))
      }
      const reservation = prepared.payload.reservation
      const transaction = prepared.payload.transaction
      if (reservation?.idempotencyKey !== key) throw new Error('The backend returned a different reservation key. No signing request was sent.')
      if (reservation?.network !== network) throw new Error('The reservation network does not match the selected wallet network.')
      if (reservation?.sponsorAddress !== beforeReview.address) {
        throw new Error('Connected wallet does not match the approved asset-principal sponsor. No signing request was sent to the wallet.')
      }
      if (prepared.payload.signingIntentPersisted !== true
        || typeof transaction?.raw_data_hex !== 'string'
        || typeof transaction?.txID !== 'string') {
        throw new Error('The backend did not return a persisted, identifiable signing intent. Do not sign or broadcast.')
      }
      const expiration = transaction?.raw_data?.expiration
      if (!Number.isSafeInteger(expiration) || expiration <= Date.now() + 15000) {
        throw new Error('This transaction is expired or too close to expiry. Prepare a fresh signing intent before reviewing it.')
      }
      setLastIntent(prepared.payload)
      setMessage('The exact unsigned transaction is prepared and persisted. Review the network, sponsor, receiver, asset, amount, token contract and expiry shown below. No wallet prompt, signature or broadcast has occurred.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not prepare the sponsor signing intent.')
      setMessage('Preparation failed. No transaction was signed or broadcast.')
    } finally {
      setBusy(null)
    }
  }

  const signAndSubmit = async () => {
    setError('')
    setBusy('signing')
    try {
      const key = idempotencyKey.trim()
      if (key.length < 24 || key.length > 160) {
        throw new Error('Enter the reservation idempotency key (24–160 characters) from the approved operator-created request.')
      }
      if (!wallet) throw new Error('Connect and verify the sponsor wallet first.')
      const prepared = lastIntent
      if (prepared?.signingIntentPersisted !== true
        || prepared?.reservation?.idempotencyKey !== key
        || prepared?.reservation?.network !== network
        || typeof prepared?.transaction?.raw_data_hex !== 'string'
        || typeof prepared?.transaction?.txID !== 'string') {
        throw new Error('Prepare and review the exact transaction for this reservation before signing.')
      }
      const beforeSign = readInjectedWallet(network)
      if (beforeSign.address !== wallet.address) {
        throw new Error('The connected wallet account changed. Reconnect and prepare the reservation again.')
      }
      if (prepared.reservation.sponsorAddress !== beforeSign.address) {
        throw new Error('Connected wallet does not match the approved asset-principal sponsor. No signing request was sent.')
      }
      const expiration = prepared.transaction?.raw_data?.expiration
      if (!Number.isSafeInteger(expiration) || expiration <= Date.now() + 15000) {
        setLastIntent(null)
        throw new Error('The reviewed transaction has expired or is too close to expiry. Prepare a fresh intent and review it before signing.')
      }
      const path = '/api/tron/sponsorship/transfers/' + encodeURIComponent(key)
      const tronWeb = getInjectedTronProvider()?.tronWeb || window.tronWeb
      if (typeof tronWeb?.trx?.sign !== 'function') throw new Error('The connected wallet does not expose TronWeb transaction signing.')
      setMessage('TronLink will request a signature for the exact reviewed transaction. Approve only if the details above match the approved reservation.')
      const signedTransaction = await tronWeb.trx.sign(prepared.transaction)
      if (!signedTransaction || !Array.isArray(signedTransaction.signature) || signedTransaction.signature.length === 0) {
        throw new Error('The wallet returned no transaction signature. Nothing will be broadcast.')
      }
      const afterSign = readInjectedWallet(network)
      if (afterSign.address !== beforeSign.address || afterSign.host !== beforeSign.host) {
        throw new Error('The connected wallet or network changed after signing. The backend will not broadcast this transaction.')
      }
      if (String(signedTransaction.raw_data_hex || '').toLowerCase()
        !== String(prepared.transaction?.raw_data_hex || '').toLowerCase()
        || String(signedTransaction.txID || '').toLowerCase()
        !== String(prepared.transaction?.txID || '').toLowerCase()) {
        throw new Error('The wallet changed the prepared transaction bytes. The backend will not receive it.')
      }
      const submitted = await requestJson(API_BASE + path + '/submit-signed', {
        method: 'POST',
        body: JSON.stringify({ signedTransaction }),
      })
      setLastResult(submitted.payload)
      if (!submitted.response.ok || submitted.payload.success !== true) {
        throw new Error(submitted.payload.message || submitted.payload.error || submitted.payload.status || ('Submission rejected (HTTP ' + submitted.response.status + ').'))
      }
      setMessage(submitted.payload.chainFinalityVerified
        ? 'A subsequent chain-verification endpoint reports finality.'
        : 'The testnet node accepted the signed transaction. Starting an independent solidified receipt and receiver-balance check.')
      if (submitted.payload.transactionBroadcast === true && typeof submitted.payload.transactionHash === 'string') {
        // First verification attempt is automatic; if the receipt is not solidified yet,
        // keep the same transaction ID for the operator's manual retry.
        await verifyReceiverSettlement(prepared.payload, submitted.payload)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The sponsor signing/submission request failed.')
      setMessage('No successful submission was confirmed. Check the exact reservation/txid status before retrying.')
    } finally {
      setBusy(null)
    }
  }

  const verifyReceiverSettlement = async (
    intent: ApiPayload | null = lastIntent,
    result: ApiPayload | null = lastResult,
  ) => {
    setError('')
    setSettlementCheck(null)
    setBusy('verifying')
    try {
      const reservation = intent?.reservation
      const transactionHash = typeof result?.transactionHash === 'string' ? result.transactionHash : ''
      if (!reservation || !/^[0-9a-f]{64}$/i.test(transactionHash)) {
        throw new Error('No persisted sponsor transfer intent and transaction ID are available to verify.')
      }
      if (!['nile', 'shasta'].includes(reservation.network) || reservation.network !== network) {
        throw new Error('The saved transaction network does not match the selected testnet.')
      }
      if (typeof reservation.sponsorAddress !== 'string' || typeof reservation.receiverAddress !== 'string'
        || typeof reservation.amountBaseUnits !== 'string' || !/^[1-9][0-9]{0,77}$/.test(reservation.amountBaseUnits)) {
        throw new Error('The stored transfer identity is incomplete; no receiver balance will be inferred.')
      }

      const verificationParams = new URLSearchParams({
        network: reservation.network,
        from: reservation.sponsorAddress,
        to: reservation.receiverAddress,
      })
      let verificationPath: string
      if (reservation.asset === 'TRX') {
        verificationParams.set('amountSun', reservation.amountBaseUnits)
        verificationPath = '/api/tron/verify-native-transfer/' + encodeURIComponent(transactionHash)
      } else {
        if (!['USDT', 'VTRC'].includes(reservation.asset)
          || typeof reservation.tokenContract !== 'string' || !reservation.tokenContract) {
          throw new Error('The saved token identity is incomplete; no receiver token balance will be inferred.')
        }
        verificationParams.set('contract', reservation.tokenContract)
        verificationParams.set('amountBaseUnits', reservation.amountBaseUnits)
        verificationPath = '/api/tron/verify-trc20-transfer/' + encodeURIComponent(transactionHash)
      }

      const chainResult = await requestJson(API_BASE + verificationPath + '?' + verificationParams.toString())
      const baseCheck: ApiPayload = {
        checkedAt: new Date().toISOString(),
        transactionHash,
        network: reservation.network,
        asset: reservation.asset,
        receiverAddress: reservation.receiverAddress,
        verification: chainResult.payload,
        receiverBalance: null,
      }
      if (!chainResult.response.ok || chainResult.payload.verified !== true) {
        setSettlementCheck(baseCheck)
        setMessage(chainResult.payload.status === 'awaiting-solidified-receipt'
          ? 'The node has not exposed a matching solidified receipt yet. Recheck this same transaction; do not create a replacement.'
          : 'The transfer is not verified as settled on the selected chain. No receiver balance or exchange credit is inferred.')
        return
      }
      if (chainResult.payload.network !== reservation.network
        || String(chainResult.payload.transactionId || '').toLowerCase() !== transactionHash.toLowerCase()) {
        throw new Error('The verification response did not match the stored network and transaction ID.')
      }

      const balanceParams = new URLSearchParams({
        network: reservation.network,
        address: reservation.receiverAddress,
      })
      const balancePath = reservation.asset === 'TRX'
        ? '/api/tron/native-balance'
        : '/api/tron/token-balance'
      if (reservation.asset !== 'TRX') {
        balanceParams.set('contract', reservation.tokenContract)
      }
      let receiverBalance: ApiPayload
      try {
        const balanceResult = await requestJson(API_BASE + balancePath + '?' + balanceParams.toString())
        receiverBalance = balanceResult.payload
        if (!balanceResult.response.ok || balanceResult.payload.success !== true
          || balanceResult.payload.network !== reservation.network) {
          receiverBalance = {
            success: false,
            error: balanceResult.payload.error || 'receiver-balance-unavailable',
            message: balanceResult.payload.message || 'The receiver balance could not be verified independently.',
          }
        }
      } catch {
        receiverBalance = { success: false, error: 'receiver-balance-unavailable' }
      }

      setSettlementCheck({ ...baseCheck, receiverBalance })
      setMessage(receiverBalance.success === true
        ? 'Solidified transaction verified. The receiver balance below is a separate live chain read; exchange deposit credit is not verified.'
        : 'Solidified transaction verified, but the separate receiver balance read is unavailable. Recheck the same transaction and balance.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not verify the saved transfer.')
      setMessage('No new transaction was sent. Recheck the original transaction ID and selected network.')
    } finally {
      setBusy(null)
    }
  }

  const connectFeeSponsorWallet = async () => {
    setError('')
    setMessage('Requesting connection to the fee-sponsor wallet…')
    setBusy('connecting')
    // Keep the last verified role address visible if the user switches accounts.
    // It is marked stale until the configured fee account is reconnected, and the
    // signer re-reads the active wallet immediately before every signature.
    setFeeWalletNeedsReconnect(true)
    try {
      const provider = getInjectedTronProvider()
      if (!provider) {
        throw new Error('TronLink is not detected. Connect from a browser where the sponsor wallet is available.')
      }
      await requestTronWalletAccess(provider)
      const next = readInjectedWallet(network)
      const rolesResult = await refreshSponsorRoles(network)
      const feeAddress = rolesResult.payload?.roles?.networkFeeSponsor?.address
      const assetAddress = rolesResult.payload?.roles?.assetPrincipalSponsor?.address
      if (!rolesResult.ok || !feeAddress || !assetAddress) {
        throw new Error(rolesResult.message || 'Both configured sponsor addresses must be valid before resource delegation.')
      }
      if (feeAddress === assetAddress) throw new Error('Fee sponsor and asset-principal sponsor must be different accounts.')
      if (next.address !== feeAddress) {
        throw new Error('The active wallet is not the configured fee sponsor. Switch the selected account in TronLink, then reconnect; no automatic account change is performed.')
      }
      setFeeWallet(next)
      setFeeWalletNeedsReconnect(false)
      setMessage('Fee-sponsor wallet and testnet verified. Resource delegation will still require explicit wallet approval.')
    } catch (caught) {
      setFeeWalletNeedsReconnect(true)
      setError(walletConnectionError(caught))
      setMessage('Fee-sponsor wallet was not verified; no delegation was signed.')
    } finally {
      setBusy(null)
    }
  }

  const verifyResourceDelegation = async (record: DelegationIntent | null = delegationIntent): Promise<boolean> => {
    if (!record) {
      setError('No resource-delegation transaction is available to verify.')
      return false
    }
    setBusy('verifying')
    setError('')
    try {
      const verification = await requestJson(API_BASE + '/api/tron/sponsorship/resource-delegations/verify', {
        method: 'POST',
        body: JSON.stringify({
          network: record.network,
          transactionId: record.transactionId,
          sponsorAddress: record.sponsorAddress,
          receiverAddress: record.receiverAddress,
          resourceType: record.resourceType,
          stakeEquivalentSun: record.stakeEquivalentSun,
        }),
      })
      const payload = {
        ...verification.payload,
        transactionHash: record.transactionId,
        verificationHttpStatus: verification.response.status,
      }
      setDelegationResult(payload)
      if (verification.response.ok
        && payload.success === true
        && payload.verified === true
        && payload.persistence?.persisted === true) {
        setDelegationIntent({ ...record, status: 'verified-solidified-audit-persisted' })
        setMessage('Resource delegation is independently verified in solidified chain state and its audit record was persisted. This does not prove any later token transfer is fee-free.')
        await refreshSponsorRoles(record.network)
        return true
      }
      setMessage('The exact delegation transaction has been rechecked, but solidified verification and/or audit persistence is not complete. Recheck this same transaction later; do not broadcast it again.')
      return false
    } catch (caught) {
      setDelegationResult({
        success: false,
        status: 'delegation-verification-unavailable',
        transactionHash: record.transactionId,
      })
      setError(caught instanceof Error ? caught.message : 'Could not verify this delegation.')
      setMessage('The transaction ID is retained. Retry verification for the same ID later; do not create a duplicate delegation.')
      return false
    } finally {
      setBusy(null)
    }
  }

  const delegateTestnetResource = async () => {
    setError('')
    setDelegationResult(null)
    setBusy('delegating')
    try {
      if (!feeWallet || feeWalletNeedsReconnect) throw new Error('Reconnect the configured fee-sponsor account in TronLink and verify it before delegating. The previously verified role address is retained for reference, but cannot sign while another account is active.')
      const before = readInjectedWallet(network)
      if (before.address !== feeWallet.address || before.host !== feeWallet.host) {
        throw new Error('The active wallet account or network changed. Reconnect the fee sponsor before continuing.')
      }
      const rolesResult = await refreshSponsorRoles(network)
      const feeRole = rolesResult.payload?.roles?.networkFeeSponsor
      const assetRole = rolesResult.payload?.roles?.assetPrincipalSponsor
      const feeAddress = feeRole?.address
      const principalAddress = assetRole?.address
      if (!rolesResult.ok || !feeRole || !assetRole || !feeAddress || !principalAddress) {
        throw new Error(rolesResult.message || 'Both validated sponsor role addresses are required.')
      }
      if (feeAddress === principalAddress || before.address !== feeAddress) {
        throw new Error('The active wallet must equal the configured fee sponsor, and the principal sponsor must be a distinct address.')
      }
      if (feeRole?.resourceStatus?.resourceRead !== true) {
        throw new Error('Fresh solidified resource metadata is unavailable. No delegation transaction was prepared.')
      }
      const maxStake = resourceType === 'ENERGY'
        ? feeRole.resourceStatus.maxDelegatableEnergyStakeSun
        : feeRole.resourceStatus.maxDelegatableBandwidthStakeSun
      if (typeof maxStake !== 'string' || !/^(0|[1-9][0-9]*)$/.test(maxStake)) {
        throw new Error('The selected resource delegation limit could not be verified. No transaction was prepared.')
      }
      const stakeEquivalentSun = trxAmountToSun(resourceAmountTRX)
      if (!stakeEquivalentSun) {
        throw new Error('Enter an amount of at least 1 TRX with no more than 6 decimal places and within the safe transaction range.')
      }
      if (BigInt(stakeEquivalentSun) > BigInt(maxStake)) {
        throw new Error('The requested stake-equivalent amount exceeds the current solidified delegation limit for this resource.')
      }
      const tronWeb = getInjectedTronProvider()?.tronWeb || window.tronWeb
      if (typeof tronWeb?.transactionBuilder?.delegateResource !== 'function'
        || typeof tronWeb?.trx?.sign !== 'function'
        || typeof tronWeb?.trx?.sendRawTransaction !== 'function') {
        throw new Error('The connected wallet does not expose the required TronWeb transaction builder, signer, and broadcaster.')
      }
      const unsigned = await tronWeb.transactionBuilder.delegateResource(
        Number(stakeEquivalentSun),
        principalAddress,
        resourceType,
        feeAddress,
        false,
      )
      validateUnsignedDelegation(tronWeb, unsigned, feeAddress, principalAddress, resourceType, stakeEquivalentSun)
      setMessage('Review the fee sponsor, recipient, resource type, and stake-equivalent amount in TronLink. Approve only if every field is correct.')
      const signed = await tronWeb.trx.sign(unsigned)
      if (!signed || !Array.isArray(signed.signature) || signed.signature.length === 0) {
        throw new Error('The wallet returned no signature. No broadcast was attempted.')
      }
      if (String(signed.raw_data_hex || '').toLowerCase() !== String(unsigned.raw_data_hex).toLowerCase()
        || String(signed.txID || '').toLowerCase() !== String(unsigned.txID).toLowerCase()) {
        throw new Error('The wallet changed the prepared delegation bytes or transaction ID. No broadcast was attempted.')
      }
      const after = readInjectedWallet(network)
      if (after.address !== before.address || after.host !== before.host) {
        throw new Error('The active wallet or network changed after signing. No broadcast was attempted.')
      }
      const record: DelegationIntent = {
        network,
        transactionId: String(unsigned.txID),
        sponsorAddress: feeAddress,
        receiverAddress: principalAddress,
        resourceType,
        stakeEquivalentSun,
        status: 'broadcast-pending',
        createdAt: new Date().toISOString(),
      }
      setDelegationIntent(record)
      setDelegationResult({
        success: false,
        status: 'broadcast-pending',
        transactionHash: record.transactionId,
        message: 'The signed transaction is prepared locally. Confirm the result before considering it broadcast.',
      })
      let broadcast: any
      try {
        broadcast = await tronWeb.trx.sendRawTransaction(signed)
      } catch {
        setDelegationIntent({ ...record, status: 'broadcast-outcome-unknown' })
        setDelegationResult({
          success: false,
          status: 'broadcast-outcome-unknown',
          transactionHash: record.transactionId,
          message: 'The network response was ambiguous. Do not sign or broadcast a second transaction; verify this same transaction ID after chain propagation.',
        })
        setError('Broadcast outcome is unknown. The exact transaction ID was retained for read-only verification.')
        setMessage('Do not resubmit or create a replacement delegation until the existing transaction is reconciled.')
        return
      }
      if (broadcast?.result !== true) {
        setDelegationIntent({ ...record, status: 'broadcast-rejected' })
        setDelegationResult({
          success: false,
          status: 'broadcast-rejected',
          transactionHash: record.transactionId,
          providerResponse: typeof broadcast?.code === 'string' ? broadcast.code : undefined,
          message: 'The selected testnet node did not confirm acceptance. Verify this exact transaction ID before any retry.',
        })
        setError('The node did not confirm this transaction. Do not immediately create a replacement; first verify the same transaction ID.')
        setMessage('No accepted broadcast was confirmed. Use the same transaction ID for reconciliation.')
        return
      }
      if (typeof broadcast.txid === 'string' && broadcast.txid.toLowerCase() !== record.transactionId.toLowerCase()) {
        setDelegationIntent({ ...record, status: 'broadcast-id-mismatch' })
        setDelegationResult({
          success: false,
          status: 'broadcast-id-mismatch',
          transactionHash: record.transactionId,
          message: 'The node returned a transaction ID that differs from the signed intent. Do not retry; reconcile both identifiers with the node.',
        })
        setError('Node transaction ID mismatch. No second broadcast was attempted.')
        return
      }
      const accepted = { ...record, status: 'broadcast-accepted' }
      setDelegationIntent(accepted)
      setDelegationResult({
        success: true,
        status: 'broadcast-accepted',
        transactionHash: record.transactionId,
        message: 'The selected testnet node accepted the signed delegation. Solidification and audit persistence are still unverified.',
      })
      setMessage('The node accepted the delegation. Checking solidified chain state now; an accepted broadcast is not yet a verified delegation.')
      await verifyResourceDelegation(accepted)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not prepare or submit the resource delegation.')
      setMessage('No successful delegation was confirmed. Review the exact transaction and wallet/network state before trying again.')
    } finally {
      setBusy(null)
    }
  }

  const copyReconciliationCommand = async () => {
    const key = idempotencyKey.trim()
    if (!/^[A-Za-z0-9._:-]{24,160}$/.test(key)) {
      setReconciliationCommandStatus('Enter a valid reservation idempotency key before generating the reconciliation command.')
      return
    }
    // The privileged admin token stays in a trusted terminal environment; it is never
    // read by or embedded in browser code. Only the opaque stored-intent key is copied.
    const command = "SPONSOR_API_BASE_URL='https://trc20-usdt-token-cloner-api.onrender.com' npm run sponsor:reconcile -- '" + key + "'"
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this browser.')
      await navigator.clipboard.writeText(command)
      setReconciliationCommandStatus('Command copied. Run it in a trusted checkout terminal where SPONSOR_ADMIN_API_TOKEN is already set; do not put the token in this page or source control.')
    } catch (caught) {
      setReconciliationCommandStatus(caught instanceof Error ? caught.message : 'Could not copy the reconciliation command.')
    }
  }

  const globalProductionEnabled = serverStatus?.enabled === true
    && serverStatus?.canSubmitSponsoredTransfer === true
    && serverStatus?.mainnetEnabled === true
  const feeRole = roleStatus?.roles?.networkFeeSponsor
  const assetRole = roleStatus?.roles?.assetPrincipalSponsor
  const delegation = roleStatus?.feeSponsorDelegationToPrincipal
  const assetTokens: ApiPayload[] = Array.isArray(assetRole?.tokens) ? assetRole.tokens : []
  const transferExplorerUrl = getTronScanTransactionUrl(lastIntent?.reservation?.network, lastResult?.transactionHash)
  const transferExplorerLabel = getTronScanNetworkLabel(lastIntent?.reservation?.network)
  const hasPreparedCurrentIntent = !walletNeedsReconnect && lastIntent?.signingIntentPersisted === true
    && lastIntent?.reservation?.idempotencyKey === idempotencyKey.trim()
    && lastIntent?.reservation?.network === network
    && lastIntent?.reservation?.sponsorAddress === wallet?.address
    && typeof lastIntent?.transaction?.raw_data_hex === 'string'
    && typeof lastIntent?.transaction?.txID === 'string'
  const preparedIntentAlreadyBroadcast = lastResult?.transactionBroadcast === true
    && typeof lastResult?.transactionHash === 'string'
    && String(lastResult.transactionHash).toLowerCase() === String(lastIntent?.transaction?.txID || '').toLowerCase()

  return (
    <div className="sponsor-console-page">
      <div className="sponsor-console-shell">
        <header className="sponsor-console-header">
          <div className="sponsor-console-brand"><ShieldCheck size={21} aria-hidden="true" /><span>TRON TOKEN STUDIO <small>SPONSOR OPERATOR</small></span></div>
          <a href="#" className="sponsor-console-back"><ArrowLeft size={15} aria-hidden="true" /> Back to transfer workflow</a>
        </header>
        <main className="sponsor-console-main">
          <p className="sponsor-console-eyebrow">EXTERNAL SPONSOR • TESTNET ONLY</p>
          <h1>Sponsor signing console</h1>
          <p className="sponsor-console-lead">Connect the sponsor’s own wallet, retrieve an approved reservation, review its exact transfer intent, then explicitly approve signing in TronLink. This console never asks for a private key or recovery phrase.</p>

          <section className="sponsor-console-state">
            <div className="sponsor-console-state-icon"><Activity size={18} aria-hidden="true" /></div>
            <div className="sponsor-console-state-copy">
              <strong>{globalProductionEnabled ? 'Production capability reports enabled' : 'Global production sponsorship remains gated'}</strong>
              <span>{serverStatus?.status || 'Backend status not yet verified'} · Mainnet is not available in this console.</span>
              <span>Shasta/Nile signing-broadcast gate: {pilotPreflight?.networks?.[network]?.approvalConfiguration?.testnetSignedBroadcastGateEnabled === true ? 'enabled' : pilotPreflight ? 'disabled or not confirmed' : 'checking'}. This gate does not approve a reservation or confirm a transfer was sent.</span>
            </div>
            <button type="button" className="sponsor-console-button sponsor-console-button--quiet" onClick={() => { void refreshServerStatus(); void refreshSponsorRoles(network) }} disabled={busy !== null}><RefreshCw size={15} aria-hidden="true" /> Recheck</button>
          </section>

          <section className="sponsor-console-card" aria-live="polite">
            <div className="sponsor-console-step"><span>DUAL</span><div><h2>Nile + Shasta pilot preflight</h2><p>Automatically checks both testnets against the latest solidified node state, configured sponsor-role balances, fee resources, and any observed fee-to-principal delegation. This diagnostic never authorizes or broadcasts a transfer.</p></div></div>
            <div className="sponsor-console-detail"><span>Preflight status</span><strong>{pilotPreflight?.status || 'Loading live testnet diagnostics…'}</strong></div>
            {(['nile', 'shasta'] as const).map((pilotNetwork) => {
              const item = pilotPreflight?.networks?.[pilotNetwork]
              const blockers: string[] = Array.isArray(item?.blockers) ? item.blockers : []
              const feeNative = item?.sponsors?.networkFeeSponsor?.native
              const principalNative = item?.sponsors?.assetPrincipalSponsor?.native
              const principalTokens: ApiPayload[] = Array.isArray(item?.sponsors?.assetPrincipalSponsor?.tokens)
                ? item.sponsors.assetPrincipalSponsor.tokens : []
              return (
                <div key={pilotNetwork} className="sponsor-console-pilot-network">
                  <div className="sponsor-console-detail"><span>{pilotNetwork === 'nile' ? 'Nile testnet' : 'Shasta testnet'}</span><strong>{item?.preflightStatus || 'not checked'}</strong></div>
                  <div className="sponsor-console-detail"><span>Solidified node</span><strong>{item?.networkNode?.reachable === true ? 'Reachable · block ' + String(item.networkNode.latestSolidifiedBlockNumber ?? 'unknown') : String(item?.networkNode?.status || 'not verified')}</strong></div>
                  <div className="sponsor-console-detail"><span>Sponsor roles / chain reads</span><strong>{item?.roleConfiguration?.feeSponsorAddressConfigured === true ? 'Fee address configured' : 'Fee address missing'} · {item?.roleConfiguration?.assetPrincipalSponsorAddressConfigured === true ? 'Principal address configured' : 'Principal address missing'} · {item?.roleConfiguration?.rolesDistinct === true ? 'distinct' : 'not verified distinct'}</strong></div>
                  <div className="sponsor-console-detail"><span>Live funding/resources</span><strong>Fee balance {item?.roleConfiguration?.feeSponsorOnChainBalanceRead === true ? 'read' : 'not verified'} · Principal balance {item?.roleConfiguration?.assetPrincipalSponsorOnChainBalanceRead === true ? 'read' : 'not verified'} · Resources {item?.feeSponsorResources?.read === true ? 'read' : [item?.feeSponsorResources?.status, item?.feeSponsorResources?.failureStage, item?.feeSponsorResources?.providerResponseCategory].filter(Boolean).join(' · ') || 'not verified'} · Delegation {item?.feeSponsorResources?.delegation?.activeDelegationObserved === true ? 'observed' : 'not observed'}</strong></div>
                  <div className="sponsor-console-detail"><span>Observed native balances</span><strong>Fee sponsor {feeNative?.status === 'verified' ? String(feeNative.balanceTRX) + ' TRX' : 'not verified'} · Asset-principal sponsor {principalNative?.status === 'verified' ? String(principalNative.balanceTRX) + ' TRX' : 'not verified'}</strong></div>
                  <div className="sponsor-console-detail"><span>Principal token balances</span><strong>{principalTokens.length > 0 ? principalTokens.map((token: ApiPayload) => token.asset + ': ' + (token.status === 'verified' ? String(token.balanceBaseUnits) + ' base units' + (Number.isSafeInteger(token.decimals) ? ' (decimals ' + String(token.decimals) + ')' : '') : 'not verified')).join(' · ') : 'No configured token balances reported'}</strong></div>
                  <div className="sponsor-console-detail"><span>Token allowlists</span><strong>Testnet USDT contract {item?.tokenContractAllowlistConfigured?.USDT === true ? 'configured' : 'not configured'} · VTRC contract {item?.tokenContractAllowlistConfigured?.VTRC === true ? 'configured' : 'not configured'}</strong></div>
                  {(item?.tokenContractAllowlistConfigured?.USDT !== true || item?.tokenContractAllowlistConfigured?.VTRC !== true) && <p className="sponsor-console-field-note">Configure verified network-specific test-token contracts server-side: SPONSOR_USDT_{pilotNetwork.toUpperCase()}_CONTRACTS and SPONSOR_VTRC_{pilotNetwork.toUpperCase()}_CONTRACTS. Use only the exact contract you independently checked on this testnet. A testnet token is not official Mainnet USDT, and an allowlist does not create token balances.</p>}
                  {blockers.length > 0 && <div className="sponsor-console-result-note"><strong>Blockers ({blockers.length})</strong><ul>{blockers.map((blocker) => <li key={blocker}><code>{blocker}</code>{SPONSOR_BLOCKER_GUIDANCE[blocker] && <p>Next step: {SPONSOR_BLOCKER_GUIDANCE[blocker]}</p>}</li>)}</ul></div>}
                </div>
              )
            })}
            <div className="sponsor-console-actions">
              <button type="button" className="sponsor-console-button sponsor-console-button--quiet" onClick={() => void refreshPilotPreflight()} disabled={busy !== null}><RefreshCw size={15} aria-hidden="true" /> Refresh both testnets</button>
              <span className="sponsor-console-pill">Preflight is read-only; sponsor signature and resource gates still apply</span>
            </div>
            <div className="sponsor-console-result-note">A funded-looking balance is not proof of sponsor ownership, consent, or a spending mandate. A node-accepted transaction is not final fee settlement or proof of receiver/exchange credit. No private key or sponsor address is sent to this diagnostic endpoint.</div>
          </section>

          {roleStatus && <section className="sponsor-console-card">
            <div className="sponsor-console-step"><span>LIVE</span><div><h2>Live sponsor-role diagnostics</h2><p>Automatically reloaded after wallet connection. These are read-only chain observations, not authorization or final fee settlement.</p></div></div>
            <div className="sponsor-console-detail"><span>Network / checked at</span><strong>{roleStatus.network} · {roleStatus.checkedAt ? new Date(roleStatus.checkedAt).toLocaleTimeString() : 'timestamp unavailable'}</strong></div>
            <div className="sponsor-console-detail"><span>Fee sponsor</span><strong>{feeRole?.status || 'not verified'} · {feeRole?.native?.status === 'verified' ? String(feeRole.native.balanceTRX) + ' TRX' : 'native balance not verified'}</strong></div>
            <div className="sponsor-console-detail"><span>Fee sponsor resources</span><strong>{feeRole?.resourceStatus?.resourceRead === true ? String(feeRole.resourceStatus.currentlyAvailableEnergy ?? 'unknown') + ' energy / ' + String(feeRole.resourceStatus.currentlyAvailableBandwidth ?? 'unknown') + ' bandwidth' : [feeRole?.resourceStatus?.status, feeRole?.resourceStatus?.failureStage, feeRole?.resourceStatus?.providerResponseCategory].filter(Boolean).join(' · ') || 'resources not verified'}</strong></div>
            <div className="sponsor-console-detail"><span>Asset-principal sponsor</span><strong>{assetRole?.status || 'not verified'} · {assetRole?.native?.status === 'verified' ? String(assetRole.native.balanceTRX) + ' TRX' : 'native balance not verified'}</strong></div>
            <div className="sponsor-console-detail"><span>Token balances</span><strong>{assetTokens.length > 0 ? assetTokens.map((token: ApiPayload) => token.asset + ': ' + (token.status === 'verified' ? String(token.balanceBaseUnits) + ' base units' : 'not verified')).join(' · ') : 'not verified'}</strong></div>
            <div className="sponsor-console-detail"><span>Fee-to-principal delegation</span><strong>{delegation?.status || 'not verified'} · {delegation?.success === true ? 'observed' : 'not confirmed'}</strong></div>
            <div className="sponsor-console-result-note">Configured accounts: {roleStatus.accountsConfigured === true ? 'both present' : 'incomplete'}; distinct roles: {roleStatus.configuredAddressesDistinct === true ? 'verified' : 'not verified'}. A positive balance or delegation is not proof of a funded agreement, transaction authorization, final fee consumption, or recipient credit.</div>
          </section>}

          <section className="sponsor-console-card">
            <div className="sponsor-console-step"><span><Zap size={15} aria-hidden="true" /></span><div><h2>Delegate testnet resources to the asset sponsor</h2><p>Connect the distinct fee-sponsor account, choose Energy or Bandwidth, and delegate an exact stake-equivalent amount. The delegation is signed in the fee sponsor’s wallet and remains revocable because this console never creates a locked delegation.</p></div></div>
            <div className="sponsor-console-detail"><span>Configured fee sponsor</span><strong>{feeRole?.address || 'Valid fee-sponsor address not configured'}</strong></div>
            <div className="sponsor-console-detail"><span>Configured asset principal</span><strong>{assetRole?.address || 'Valid asset-principal address not configured'}</strong></div>
            <div className="sponsor-console-actions">
              <button type="button" className="sponsor-console-button" onClick={() => void connectFeeSponsorWallet()} disabled={busy !== null}><Wallet size={16} aria-hidden="true" /> {busy === 'connecting' && !feeWallet ? 'Connecting…' : 'Connect fee sponsor wallet'}</button>
              <span className={feeWallet && feeWallet.network === network && !feeWalletNeedsReconnect ? 'sponsor-console-pill sponsor-console-pill--ok' : 'sponsor-console-pill'}>{feeWallet && feeWallet.network === network ? (feeWalletNeedsReconnect ? 'Reconnect fee account to sign' : 'Testnet verified') : 'Fee wallet not connected'}</span>
            </div>
            {feeWallet && <div className="sponsor-console-wallet"><span>{feeWalletNeedsReconnect ? 'Last verified fee-sponsor address (not active for signing)' : 'Fee-sponsor signer'}</span><code>{feeWallet.address}</code><span>{feeWallet.host} · checked {new Date(feeWallet.checkedAt).toLocaleTimeString()}</span></div>}
            <label className="sponsor-console-label" htmlFor="delegation-resource-type">Resource type</label>
            <select id="delegation-resource-type" value={resourceType} onChange={event => setResourceType(event.target.value as ResourceKind)} disabled={busy !== null}>
              <option value="BANDWIDTH">Bandwidth</option>
              <option value="ENERGY">Energy</option>
            </select>
            <label className="sponsor-console-label" htmlFor="delegation-amount-trx">Stake-equivalent amount (TRX)</label>
            <input id="delegation-amount-trx" inputMode="decimal" value={resourceAmountTRX} onChange={event => setResourceAmountTRX(event.target.value)} disabled={busy !== null} autoComplete="off" spellCheck={false} maxLength={24} />
            <p className="sponsor-console-field-note">The backend must report a fresh solidified delegation ceiling. Minimum: 1 TRX; up to 6 decimals. The signed transaction delegates resource capacity, not token principal, and does not promise zero transfer fees.</p>
            <button type="button" className="sponsor-console-button sponsor-console-button--primary" onClick={() => void delegateTestnetResource()} disabled={busy !== null || !feeWallet || feeWalletNeedsReconnect || feeWallet.network !== network || feeRole?.resourceStatus?.resourceRead !== true || !feeRole?.address || !assetRole?.address || feeRole.address === assetRole.address}><Zap size={16} aria-hidden="true" /> {busy === 'delegating' ? 'Preparing / submitting…' : 'Review and delegate testnet resources'}</button>
            {delegationIntent && <div className="sponsor-console-result-note">
              <strong>Delegation transaction: {delegationIntent.status}</strong>
              <div>Network: {delegationIntent.network} · Resource: {delegationIntent.resourceType} · Stake equivalent: {delegationIntent.stakeEquivalentSun} SUN</div>
              <div>Fee sponsor: <code>{delegationIntent.sponsorAddress}</code></div>
              <div>Recipient principal: <code>{delegationIntent.receiverAddress}</code></div>
              <div>Transaction ID: <code>{delegationIntent.transactionId}</code></div>
              <a href={(delegationIntent.network === 'nile' ? 'https://nile.tronscan.org' : 'https://shasta.tronscan.org') + '/#/transaction/' + encodeURIComponent(delegationIntent.transactionId)} target="_blank" rel="noreferrer">Open testnet transaction explorer <ExternalLink size={13} aria-hidden="true" /></a>
              <div className="sponsor-console-actions">
                <button type="button" className="sponsor-console-button" onClick={() => void verifyResourceDelegation()} disabled={busy !== null}>{busy === 'verifying' ? 'Verifying…' : 'Recheck same delegation'}</button>
              </div>
            </div>}
            {delegationResult && <div className={delegationResult.success === true && delegationResult.verified === true && delegationResult.persistence?.persisted === true ? 'sponsor-console-result-note sponsor-console-result-note--ok' : 'sponsor-console-result-note'}>
              <strong>{delegationResult.status || 'delegation-status-unavailable'}</strong>
              <p>{delegationResult.message || (delegationResult.success === true ? 'The selected node accepted the transaction.' : 'The delegation is not yet verified. Recheck the same transaction ID; do not broadcast it again.')}</p>
              {delegationResult.verificationHttpStatus && <small>Verification HTTP status: {delegationResult.verificationHttpStatus}</small>}
            </div>}
            <div className="sponsor-console-notice"><CircleAlert size={16} aria-hidden="true" /><div><strong>Testnet-only, wallet-signed action.</strong><p>No Mainnet option is present. A successful node response is not finality; the delegation becomes verified only after independent solidified-chain verification and a persisted audit record.</p></div></div>
          </section>

          <section className="sponsor-console-card">
            <div className="sponsor-console-step"><span>01</span><div><h2>Connect sponsor wallet</h2><p>Use the wallet that owns the asset-principal sponsor address on the same testnet.</p></div></div>
            <label className="sponsor-console-label" htmlFor="sponsor-network">TRON testnet</label>
            <select id="sponsor-network" value={network} onChange={event => changeNetwork(event.target.value as Network)} disabled={busy !== null}>
              <option value="nile">Nile testnet</option>
              <option value="shasta">Shasta testnet</option>
            </select>
            <div className="sponsor-console-actions">
              <button type="button" className="sponsor-console-button" onClick={() => void connectWallet()} disabled={busy !== null}><Wallet size={16} aria-hidden="true" /> {busy === 'connecting' ? 'Connecting…' : 'Connect TronLink'}</button>
              <span className={wallet && wallet.network === network && !walletNeedsReconnect ? 'sponsor-console-pill sponsor-console-pill--ok' : 'sponsor-console-pill'}>{wallet && wallet.network === network ? (walletNeedsReconnect ? 'Reconnect account to sign' : 'Network verified') : 'Not connected'}</span>
            </div>
            {wallet && <div className="sponsor-console-wallet"><span>{walletNeedsReconnect ? 'Last verified asset-principal address (not active for signing)' : 'Connected address'}</span><code>{wallet.address}</code><span>Node: {wallet.host} · checked {new Date(wallet.checkedAt).toLocaleTimeString()}</span></div>}
          </section>

          <section className="sponsor-console-card">
            <div className="sponsor-console-step"><span>02</span><div><h2>Load approved reservation</h2><p>This must be an operator-created reservation for an active, funded testnet budget. A display-only balance or UI draft is not enough.</p></div></div>
            <label className="sponsor-console-label" htmlFor="sponsor-intent-key">Reservation idempotency key</label>
            <input id="sponsor-intent-key" value={idempotencyKey} onChange={event => setIdempotencyKey(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste the approved 24+ character reservation key" maxLength={160} />
            <p className="sponsor-console-field-note">This key identifies an existing approved reservation; it does not create one. Find it in the successful `sponsor:reserve` CLI output or the protected transfer ledger. Never paste a seed phrase, private key, API key or signing secret. <a href="https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/blob/main/docs/SPONSOR_RESERVATION_IDEMPOTENCY.md" target="_blank" rel="noreferrer">How to create/find a reservation key <ExternalLink size={12} aria-hidden="true" /></a></p>
            <button type="button" className="sponsor-console-button sponsor-console-button--primary" onClick={() => void (hasPreparedCurrentIntent ? signAndSubmit() : prepareSigningIntent())} disabled={busy !== null || !wallet || idempotencyKey.trim().length < 24 || preparedIntentAlreadyBroadcast}><LockKeyhole size={16} aria-hidden="true" /> {busy === 'signing' ? 'Signing and submitting…' : busy === 'checking' ? 'Preparing exact transaction…' : preparedIntentAlreadyBroadcast ? 'Already broadcast — verify receipt below' : hasPreparedCurrentIntent ? 'Sign exact reviewed transaction in TronLink' : 'Prepare exact transaction for review'}</button>
          </section>

          {lastIntent?.reservation && <section className="sponsor-console-card">
            <div className="sponsor-console-step"><span>03</span><div><h2>Prepared intent</h2><p>The transaction is prepared by the backend and checked against the reservation before it is signed.</p></div></div>
            <div className="sponsor-console-detail"><span>Network</span><strong>{lastIntent.reservation.network}</strong></div>
            <div className="sponsor-console-detail"><span>Sponsor signer</span><code>{lastIntent.reservation.sponsorAddress}</code></div>
            <div className="sponsor-console-detail"><span>Receiver</span><code>{lastIntent.reservation.receiverAddress}</code></div>
            <div className="sponsor-console-detail"><span>Asset / base units</span><strong>{lastIntent.reservation.asset} · {lastIntent.reservation.amountBaseUnits}</strong></div>
            {lastIntent.reservation.tokenContract && <div className="sponsor-console-detail"><span>Token contract</span><code>{lastIntent.reservation.tokenContract}</code></div>}
            <div className="sponsor-console-detail"><span>Persisted transaction ID</span><code>{String(lastIntent.transaction?.txID || 'unavailable')}</code></div>
            <div className="sponsor-console-detail"><span>Signing expiry</span><strong>{typeof lastIntent.transaction?.raw_data?.expiration === 'number' ? new Date(lastIntent.transaction.raw_data.expiration).toLocaleString() : 'unavailable'}</strong></div>
            <div className="sponsor-console-detail"><span>Fee capacity check</span><strong>{lastIntent.feeResourceDelegation?.resourceCapacityPreflightPassed ? 'Live capacity preflight passed; final fees not reconciled' : 'Not verified'}</strong></div>
          </section>}

          {lastResult && <section className="sponsor-console-card">
            <div className="sponsor-console-step"><span>04</span><div><h2>Submission result</h2><p>Provider acceptance, solidified-chain verification and receiver balances are separate states.</p></div></div>
            <div className="sponsor-console-detail"><span>Status</span><strong>{lastResult.status || lastResult.error || 'No status returned'}</strong></div>
            {lastResult.transactionHash && <div className="sponsor-console-detail"><span>Transaction ID</span><code>{lastResult.transactionHash}</code></div>}
            {transferExplorerUrl && <div className="sponsor-console-result-note"><a href={transferExplorerUrl} target="_blank" rel="noreferrer">Open {transferExplorerLabel || 'transaction'} in TronScan <ExternalLink size={13} aria-hidden="true" /></a></div>}
            <div className="sponsor-console-result-note">{lastResult.transactionBroadcast === true ? 'The node accepted this transaction. It is not settled until the selected chain exposes the exact successful transaction and receipt.' : 'No accepted broadcast was confirmed. If the outcome is unknown, check the bound transaction ID before trying another request.'}</div>
            {lastResult.transactionHash && <div className="sponsor-console-result-note">
              <button type="button" className="sponsor-console-button sponsor-console-button--primary" onClick={() => void verifyReceiverSettlement()} disabled={busy !== null || !lastIntent?.reservation}>
                <RefreshCw size={15} aria-hidden="true" /> {busy === 'verifying' ? 'Verifying solidified receipt…' : 'Verify receipt and read receiver balance'}
              </button>
              <p className="sponsor-console-field-note">This checks the exact saved sender, receiver, amount, token contract and selected testnet against solidified chain data. A balance is read only after the transfer verifier succeeds.</p>
              {settlementCheck && <div className="sponsor-console-result-note">
                <div className="sponsor-console-detail"><span>Solidified transaction</span><strong>{settlementCheck.verification?.verified === true ? settlementCheck.verification.status || 'verified' : settlementCheck.verification?.status || settlementCheck.verification?.error || 'not verified'}</strong></div>
                <div className="sponsor-console-detail"><span>Network / asset</span><strong>{settlementCheck.network} · {settlementCheck.asset}</strong></div>
                {settlementCheck.verification?.verified === true && <div className="sponsor-console-detail"><span>Chain verification record</span><strong>{settlementCheck.verification?.verificationPersistence?.persisted === true ? 'Verified and persisted' : settlementCheck.verification?.verificationPersistence?.persisted === false ? 'Chain verified; persistence not confirmed' : 'Chain verified'}</strong></div>}
                {settlementCheck.verification?.verified === true && <div className="sponsor-console-detail"><span>Receiver on-chain balance</span><strong>{settlementCheck.receiverBalance?.success === true
                  ? settlementCheck.asset === 'TRX'
                    ? String(settlementCheck.receiverBalance.balanceTRX) + ' TRX'
                    : formatBaseUnitsForDisplay(settlementCheck.receiverBalance.balanceBaseUnits, settlementCheck.receiverBalance.decimals) + ' ' + String(settlementCheck.asset)
                  : 'Separate balance read unavailable'}</strong></div>}
                {settlementCheck.verification?.verified === true && settlementCheck.asset !== 'TRX' && settlementCheck.receiverBalance?.success === true && <div className="sponsor-console-detail"><span>Token contract</span><code>{settlementCheck.receiverBalance.tokenContract || lastIntent?.reservation?.tokenContract}</code></div>}
                {settlementCheck.verification?.verified === true && <div className="sponsor-console-detail"><span>Receiver balance source</span><strong>{settlementCheck.receiverBalance?.success === true ? settlementCheck.receiverBalance.source || 'solidified chain state' : settlementCheck.receiverBalance?.message || 'Not available'}</strong></div>}
                <div className="sponsor-console-detail"><span>Fee sponsor settlement</span><strong>Not settled by this receiver verification</strong></div>
                <div className="sponsor-console-field-note">This verifies actual chain state only. It does not create a balance inside an exchange account. Exchange deposit credit must be confirmed by that exchange’s own status or supported API. Check time: {settlementCheck.checkedAt}</div>
              </div>}
              <strong>Principal-ledger reconciliation</strong>
              <p>After the solidified verifier has persisted the exact receipt, a trusted operator must run the protected reconciliation command to update the principal ledger. The verifier never marks the separate fee budget settled by itself; the fee/resource budget remains a separate settlement gate.</p>
              <button type="button" className="sponsor-console-button sponsor-console-button--quiet" onClick={() => void copyReconciliationCommand()} disabled={!/^[A-Za-z0-9._:-]{24,160}$/.test(idempotencyKey.trim())}><Copy size={15} aria-hidden="true" /> Copy secure operator reconciliation command</button>
              {reconciliationCommandStatus && <p className="sponsor-console-field-note" role="status">{reconciliationCommandStatus}</p>}
              <div className="sponsor-console-field-note">The copied command contains no admin token. Run it only in a trusted terminal with SPONSOR_ADMIN_API_TOKEN already configured.</div>
            </div>}
          </section>}

          <div className="sponsor-console-notice">
            <CircleAlert size={17} aria-hidden="true" />
            <div><strong>Testnet actions still move testnet assets.</strong><p>Review every field in the wallet confirmation. The backend accepts only Shasta/Nile, but node acceptance is not finality. Mainnet remains disabled until security review, settlement reconciliation, audited funding, and end-to-end evidence are complete.</p></div>
          </div>
          {error && <div className="sponsor-console-error" role="alert">{error}</div>}
          {/transfer-not-found|reservation-not-found/i.test(error) && <div className="sponsor-console-result-note" role="note"><strong>No approved reservation was found for that key.</strong><p>The key field cannot create a reservation by itself. From a trusted terminal, create the approved testnet reservation with <code>npm run sponsor:reserve -- ...</code>, then paste the exact key printed by the successful command. Keep the same key and request fields for retries. The CLI requires the backend admin token in your local shell; never put it in this browser or a `VITE_*` variable. <a href="https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/blob/main/docs/SPONSOR_RESERVATION_IDEMPOTENCY.md" target="_blank" rel="noreferrer">Open the step-by-step guide <ExternalLink size={12} aria-hidden="true" /></a></p></div>}
          <p className="sponsor-console-status" role="status"><CheckCircle2 size={15} aria-hidden="true" /> {message}</p>
          <footer className="sponsor-console-footer"><span>No private keys leave the sponsor wallet.</span><a href="https://developers.tron.network/docs/api-signature-and-broadcast-flow" target="_blank" rel="noreferrer">TRON signing and broadcast model <ExternalLink size={13} aria-hidden="true" /></a></footer>
        </main>
      </div>
    </div>
  )
}
