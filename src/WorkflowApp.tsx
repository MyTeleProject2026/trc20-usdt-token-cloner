import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity, AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2,
  CircleDollarSign, Copy, Fuel, Layers, LockKeyhole, Network, RefreshCw,
  ShieldCheck, Wallet, Eye, EyeOff,
} from 'lucide-react'

type NetworkId = 'shasta' | 'nile'
type AssetKind = 'TRX' | 'TRC20'
type ApiResult = { ok: boolean; httpStatus: number; payload: any }
type SponsorRoleSnapshot = {
  status?: string
  addressConfigured?: boolean
  onChainBalanceRead?: boolean
  sponsorFundingVerified?: boolean
  canSubmitSponsoredTransfer?: boolean
  submissionEnabled?: boolean
  native?: { balanceTRX?: string; balanceSun?: string; status?: string; accountExists?: boolean }
  tokens?: Array<{ asset?: string; tokenContract?: string; balanceBaseUnits?: string; decimals?: number; status?: string }>
  resourceStatus?: {
    status?: string
    resourceRead?: boolean
    currentlyAvailableEnergy?: string | number
    currentlyAvailableBandwidth?: string | number
    maxDelegatableEnergyStakeSun?: string
    maxDelegatableBandwidthStakeSun?: string
  }
}
type SponsorRoles = {
  success?: boolean
  status?: string
  network?: string
  checkedAt?: string
  accountsConfigured?: boolean
  configuredAddressesDistinct?: boolean
  canSubmitSponsoredTransfer?: boolean
  submissionEnabled?: boolean
  roles?: {
    networkFeeSponsor?: SponsorRoleSnapshot
    assetPrincipalSponsor?: SponsorRoleSnapshot
  }
}
type Sponsorship = {
  enabled?: boolean
  status?: string
  mainnetEnabled?: boolean
  canSubmitSponsoredTransfer?: boolean
  fundingPolicy?: { mode?: string; unpaidFallbackToUserFunds?: boolean }
  message?: string
  requiredBeforeEnablement?: string[]
}
type FeeSponsorDelegationSnapshot = {
  success?: boolean
  status?: string
  network?: string
  fromAddress?: string
  toAddress?: string
  activeEnergyStakeSun?: string | null
  activeBandwidthStakeSun?: string | null
  activeEnergyExpiry?: number | null
  activeBandwidthExpiry?: number | null
  matchingDelegationRows?: number
  source?: string
  queriedAt?: string
  transactionAuditVerified?: boolean
  requiredEnvironment?: string[]
  note?: string
}
type FeeEstimate = {
  success?: boolean
  status?: string
  network?: string
  asset?: string
  tokenContract?: string
  receiverAddress?: string
  amountBaseUnits?: string
  estimation?: {
    feeSponsorResourceDelegation?: FeeSponsorDelegationSnapshot
    estimatedEnergyRequired?: string
    currentEnergyFeeSun?: string
    estimatedEnergyBurnSun?: string
    estimatedEnergyBurnTRX?: string
    bandwidthFeeSunPerByte?: string
    bandwidthCostEstimated?: boolean
    totalNetworkFeeEstimated?: boolean
    feeSponsorResourcesCountedTowardPrincipalTransfer?: boolean
    resourceDelegationVerified?: boolean
    principalSponsorResources?: { availableEnergy?: string; availableStakedBandwidth?: string; availableFreeBandwidth?: string }
    feeSponsorResources?: { availableEnergy?: string; availableStakedBandwidth?: string; availableFreeBandwidth?: string }
  }
  nativeEstimation?: {
    feeSponsorResourceDelegation?: FeeSponsorDelegationSnapshot
    estimatedUnsignedRawDataBytes?: number
    estimatedSignedTransactionBytes?: number
    bandwidthFeeSunPerByte?: string
    totalPrincipalSponsorBandwidth?: string
    estimatedBandwidthShortfallBytes?: string
    estimatedBandwidthFeeSun?: string
    estimatedBandwidthFeeTRX?: string
    feeSponsorResourcesCountedTowardPrincipalTransfer?: boolean
    resourceDelegationVerified?: boolean
    totalNetworkFeeEstimated?: boolean
    principalSponsorResources?: { availableEnergy?: string; availableStakedBandwidth?: string; availableFreeBandwidth?: string }
    feeSponsorResources?: { availableEnergy?: string; availableStakedBandwidth?: string; availableFreeBandwidth?: string }
  }
  blockers?: string[]
  message?: string
  error?: string
}
type BalanceSnapshot = {
  success: true
  status: string
  network: NetworkId
  address?: string
  receiverAddress?: string
  balanceTRX?: string
  balanceSun?: string
  balanceBaseUnits?: string
  decimals?: number
  source?: string
  note?: string
  accountExists?: boolean
}
type ReceiverHistoryRecord = {
  transactionId?: string | null
  network?: string
  receiverAddress?: string | null
  senderAddress?: string | null
  tokenContract?: string | null
  tokenName?: string | null
  tokenSymbol?: string | null
  tokenDecimals?: number | null
  amountBaseUnits?: string | null
  timestamp?: number | string | null
  verificationStatus?: string
  verifiedOnChain?: boolean
  eventIndex?: number | string | null
  firstSeenAt?: string | null
  lastSeenAt?: string | null
  recordSource?: 'persisted' | 'indexer'
}

function isVerifiedHistoryRecord(record: ReceiverHistoryRecord) {
  return record.verifiedOnChain === true && record.verificationStatus === 'verified-on-chain'
}

function historyTimestampMs(value: number | string | null | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? (value < 1_000_000_000_000 ? value * 1000 : value) : 0
  }
  if (typeof value !== 'string' || !value.trim()) return 0
  const input = value.trim()
  if (/^[0-9]+$/.test(input)) {
    const numeric = Number(input)
    if (!Number.isFinite(numeric)) return 0
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
  }
  const parsed = Date.parse(input)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatHistoryTimestamp(value: number | string | null | undefined) {
  const milliseconds = historyTimestampMs(value)
  if (!milliseconds) return 'Time unavailable'
  try { return new Date(milliseconds).toLocaleString() } catch { return 'Time unavailable' }
}

type StageState = 'done' | 'current' | 'locked' | 'ready'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const NETWORK_HOST: Record<NetworkId, string> = {
  shasta: 'api.shasta.trongrid.io',
  nile: 'nile.trongrid.io',
}
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

const STEPS = [
  { title: 'Network fee sponsor', short: 'Fee sponsor', caption: 'Require an external sponsor for network fees.' },
  { title: 'Asset principal sponsor', short: 'Asset sponsor', caption: 'Choose the asset that an external sponsor must supply.' },
  { title: 'Sender account', short: 'Sender account', caption: 'Connect TronLink or inspect a watch-only wallet.' },
  { title: 'Receiver & amount', short: 'Receiver', caption: 'Validate the destination and check the selected chain.' },
  { title: 'Review & availability', short: 'Review', caption: 'Recheck sponsor authorization before considering a request ready.' },
]

async function requestApi(path: string): Promise<ApiResult> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'omit',
  })
  const payload = await response.json().catch(() => null)
  return { ok: response.ok, httpStatus: response.status, payload }
}

function requireSuccess(result: ApiResult, fallback: string): any {
  if (!result.ok || result.payload?.success !== true) {
    throw new Error(result.payload?.message || result.payload?.error || `${fallback} (HTTP ${result.httpStatus}).`)
  }
  return result.payload
}

function formatUnits(raw?: string, decimals?: number): string {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 30) return 'Unavailable'
  const count = decimals as number
  const value = BigInt(raw)
  const scale = 10n ** BigInt(count)
  const whole = value / scale
  const fraction = count ? (value % scale).toString().padStart(count, '0').replace(/0+$/, '') : ''
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function amountToBaseUnits(value: string, decimals: number): string | null {
  const input = value.trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(input) || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null
  const [whole, fraction = ''] = input.split('.')
  if (fraction.length > decimals) return null
  const result = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
  return result > 0n ? result.toString() : null
}

function checkedWalletNetwork(tronWeb: any, network: NetworkId) {
  const rawHost = String(tronWeb?.fullNode?.host || tronWeb?.fullNode?.nodeUrl || '')
  let parsed: URL
  try { parsed = new URL(rawHost) } catch { throw new Error('TronLink node could not be verified. Select the expected testnet in TronLink and reconnect.') }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== NETWORK_HOST[network] ||
    parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw new Error(`Network mismatch. Select ${network === 'nile' ? 'Nile' : 'Shasta'} testnet in TronLink before connecting; no automatic network fallback is used.`)
  }
  return true
}

async function readNativeBalance(network: NetworkId, address: string): Promise<BalanceSnapshot> {
  const result = await requestApi(`/api/tron/native-balance?network=${encodeURIComponent(network)}&address=${encodeURIComponent(address)}`)
  return requireSuccess(result, 'Could not read the wallet’s solidified TRX balance') as BalanceSnapshot
}

async function readTokenBalance(network: NetworkId, contract: string, address: string): Promise<BalanceSnapshot> {
  const result = await requestApi(`/api/tron/token-balance?network=${encodeURIComponent(network)}&contract=${encodeURIComponent(contract)}&address=${encodeURIComponent(address)}`)
  return requireSuccess(result, 'Could not read the selected token contract from solidified chain state') as BalanceSnapshot
}

function hasVerifiedFundingSnapshot(role?: SponsorRoleSnapshot) {
  return role?.sponsorFundingVerified === true && role?.onChainBalanceRead === true
}

function roleLabel(role?: SponsorRoleSnapshot) {
  if (!role) return 'Not verified'
  if (hasVerifiedFundingSnapshot(role)) return 'Funding snapshot verified'
  if (role.onChainBalanceRead === true) return 'Balance readable; authorization not verified'
  if (role.addressConfigured === true) return 'Sponsor configured; funding not verified'
  return role.status ? role.status.replaceAll('-', ' ') : 'Not verified'
}

function roleDetail(role?: SponsorRoleSnapshot) {
  if (!role) return 'The backend has not returned a usable sponsor snapshot.'
  if (role.onChainBalanceRead === true) return 'The balance snapshot is read-only. It does not grant signing permission or enable transfers.'
  if (role.addressConfigured === true) return 'An address is configured, but this does not prove the sponsor is funded, authorized, or available for this request.'
  return 'No verified sponsor address and funded budget are established for this role.'
}

function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warning' | 'bad'; children: ReactNode }) {
  return <span className={`studio-pill studio-pill--${tone}`}>{children}</span>
}

function RoleSnapshotCard({ title, role, icon }: { title: string; role?: SponsorRoleSnapshot; icon: ReactNode }) {
  const tone = hasVerifiedFundingSnapshot(role) ? 'good' : 'warning'
  const nativeVerified = role?.native?.status === 'verified' && typeof role?.native?.balanceTRX === 'string'
  const verifiedTokens = (role?.tokens ?? []).filter((token) =>
    token.status === 'verified' && typeof token.balanceBaseUnits === 'string' && Number.isInteger(token.decimals),
  )
  const resources = role?.resourceStatus?.resourceRead === true ? role.resourceStatus : null
  const hasVerifiedSnapshot = nativeVerified || verifiedTokens.length > 0 || resources !== null

  return (
    <div className="studio-role-card">
      <div className="studio-role-icon">{icon}</div>
      <div className="studio-grow">
        <p className="studio-eyebrow">{title}</p>
        <p className="studio-card-title">{roleLabel(role)}</p>
        <p className="studio-muted">{roleDetail(role)}</p>

        {nativeVerified && (
          <div className="studio-role-metric">
            <span>Verified on-chain TRX balance</span>
            <strong>{role?.native?.balanceTRX} TRX</strong>
            <small>{role?.native?.balanceSun ?? 'SUN value unavailable'} SUN · read-only snapshot</small>
          </div>
        )}

        {verifiedTokens.map((token) => (
          <div key={token.tokenContract || token.asset || 'verified-token'} className="studio-role-metric">
            <span>Verified {token.asset || 'TRC-20'} balance</span>
            <strong>{formatUnits(token.balanceBaseUnits, token.decimals)} {token.asset || ''}</strong>
            {token.tokenContract && <code>{token.tokenContract}</code>}
          </div>
        ))}

        {resources && (
          <div className="studio-role-resource-grid">
            <div className="studio-role-metric"><span>Available Energy</span><strong>{resources.currentlyAvailableEnergy ?? 'Unknown'}</strong></div>
            <div className="studio-role-metric"><span>Available Bandwidth</span><strong>{resources.currentlyAvailableBandwidth ?? 'Unknown'}</strong></div>
            <div className="studio-role-metric"><span>Max delegatable Energy stake</span><strong>{resources.maxDelegatableEnergyStakeSun ?? 'Unknown'} SUN</strong></div>
            <div className="studio-role-metric"><span>Max delegatable Bandwidth stake</span><strong>{resources.maxDelegatableBandwidthStakeSun ?? 'Unknown'} SUN</strong></div>
            <p className="studio-role-snapshot-note">Provider snapshot only. Resource availability does not authorize a fee-sponsored transfer or guarantee full future fee coverage.</p>
          </div>
        )}

        {!hasVerifiedSnapshot && (
          <p className="studio-snapshot-unavailable">No current on-chain balance or fee-resource value has been verified for this sponsor role.</p>
        )}
      </div>
      <Pill tone={tone}>{hasVerifiedFundingSnapshot(role) ? 'Funding snapshot verified' : 'Not enabled'}</Pill>
    </div>
  )
}

function formatTimestamp(value: number | null) {
  if (!value) return 'Not checked yet'
  try { return new Date(value).toLocaleString() } catch { return 'Recently checked' }
}

export default function WorkflowApp() {
  const [network, setNetwork] = useState<NetworkId>('shasta')
  const [step, setStep] = useState(0)

  // Stage 1 — network fees are external-sponsor-only. There is intentionally no
  // option that charges the sender as a fallback.
  const [feeSponsorRequired, setFeeSponsorRequired] = useState(false)
  const [roles, setRoles] = useState<SponsorRoles | null>(null)
  const [sponsorship, setSponsorship] = useState<Sponsorship | null>(null)
  const [sponsorLoading, setSponsorLoading] = useState(true)
  const [sponsorError, setSponsorError] = useState('')
  const [sponsorCheckedAt, setSponsorCheckedAt] = useState<number | null>(null)

  // Stage 2 — the asset principal is distinct from fee sponsorship.
  const [assetKind, setAssetKind] = useState<AssetKind | null>(null)
  const [assetSponsorRequired, setAssetSponsorRequired] = useState(false)
  const [tokenContract, setTokenContract] = useState('')

  // Stage 3 — wallet inspection is watch-only; no signature or funds are needed.
  const [walletMode, setWalletMode] = useState<'tronlink' | 'watch'>('tronlink')
  const [watchAddress, setWatchAddress] = useState('')
  const [senderAddress, setSenderAddress] = useState('')
  const [walletSource, setWalletSource] = useState<'TronLink' | 'Watch-only' | null>(null)
  const [nativeSnapshot, setNativeSnapshot] = useState<BalanceSnapshot | null>(null)
  const [senderTokenSnapshot, setSenderTokenSnapshot] = useState<BalanceSnapshot | null>(null)
  const [senderLoading, setSenderLoading] = useState(false)
  const [senderError, setSenderError] = useState('')
  const [senderCheckedAt, setSenderCheckedAt] = useState<number | null>(null)

  // Stage 4 — recipient and amount are validated against read-only chain responses.
  const [receiverAddress, setReceiverAddress] = useState('')
  const [amount, setAmount] = useState('1')
  const [receiverSnapshot, setReceiverSnapshot] = useState<BalanceSnapshot | null>(null)
  const [receiverLoading, setReceiverLoading] = useState(false)
  const [receiverError, setReceiverError] = useState('')
  const [receiverCheckedAt, setReceiverCheckedAt] = useState<number | null>(null)

  // Read-only TRC-20 history: persisted chain verification and live indexer
  // candidates are kept distinct and merged without upgrading candidates to proof.
  const [receiverHistoryRecords, setReceiverHistoryRecords] = useState<ReceiverHistoryRecord[]>([])
  const [receiverHistoryLoading, setReceiverHistoryLoading] = useState(false)
  const [receiverHistoryError, setReceiverHistoryError] = useState('')
  const [receiverHistoryNotice, setReceiverHistoryNotice] = useState('')
  const [receiverHistoryCheckedAt, setReceiverHistoryCheckedAt] = useState<number | null>(null)
  const [receiverHistoryPersistedAvailable, setReceiverHistoryPersistedAvailable] = useState<boolean | null>(null)
  const [receiverHistoryVerifyingKey, setReceiverHistoryVerifyingKey] = useState<string | null>(null)
  const [receiverHistoryVerificationMessages, setReceiverHistoryVerificationMessages] = useState<Record<string, string>>({})
  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate | null>(null)
  const [feeEstimateLoading, setFeeEstimateLoading] = useState(false)
  const [feeEstimateError, setFeeEstimateError] = useState('')

  const [reviewRefreshing, setReviewRefreshing] = useState(false)
  const [reviewNotice, setReviewNotice] = useState('')
  const [copyNotice, setCopyNotice] = useState('')
  // Prevent late reads for an old network/request from overwriting current sponsor diagnostics.
  const sponsorRequestGeneration = useRef(0)
  const receiverHistoryRequestGeneration = useRef(0)
  const feeEstimateRequestGeneration = useRef(0)

  const clearReceiverHistory = () => {
    receiverHistoryRequestGeneration.current += 1
    setReceiverHistoryLoading(false)
    setReceiverHistoryRecords([])
    setReceiverHistoryError('')
    setReceiverHistoryNotice('')
    setReceiverHistoryCheckedAt(null)
    setReceiverHistoryPersistedAvailable(null)
    setReceiverHistoryVerifyingKey(null)
    setReceiverHistoryVerificationMessages({})
  }

  const clearFeeEstimate = () => {
    feeEstimateRequestGeneration.current += 1
    setFeeEstimate(null)
    setFeeEstimateLoading(false)
    setFeeEstimateError('')
  }

  const sponsorStageLoaded = sponsorCheckedAt !== null && !sponsorLoading && roles?.success === true && sponsorship !== null && !sponsorError
  const feeStageValid = feeSponsorRequired && sponsorStageLoaded
  const assetStageValid = assetSponsorRequired && assetKind !== null && (assetKind === 'TRX' || ADDRESS_PATTERN.test(tokenContract.trim())) && sponsorStageLoaded
  const senderStageValid = ADDRESS_PATTERN.test(senderAddress) && nativeSnapshot?.success === true && nativeSnapshot.network === network && (assetKind === 'TRX' || (senderTokenSnapshot?.success === true && Number.isInteger(senderTokenSnapshot.decimals))) && !senderLoading
  const amountDecimals = assetKind === 'TRX' ? 6 : senderTokenSnapshot?.decimals
  const amountBaseUnits = amountDecimals == null ? null : amountToBaseUnits(amount, amountDecimals)
  const receiverStageValid = ADDRESS_PATTERN.test(receiverAddress) && receiverAddress !== senderAddress && amountBaseUnits !== null && receiverSnapshot?.success === true && receiverSnapshot.network === network && (assetKind === 'TRX' || receiverSnapshot.decimals === senderTokenSnapshot?.decimals) && !receiverLoading
  const reviewStageValid = feeStageValid && assetStageValid && senderStageValid && receiverStageValid

  const stageCompletion = useMemo(() => [feeStageValid, assetStageValid, senderStageValid, receiverStageValid, reviewStageValid], [feeStageValid, assetStageValid, senderStageValid, receiverStageValid, reviewStageValid])

  const canEnterStep = (index: number) => index === 0 || stageCompletion[index - 1] === true
  const currentStageState = (index: number): StageState => index < step ? (stageCompletion[index] ? 'done' : 'ready') : index === step ? 'current' : canEnterStep(index) ? 'ready' : 'locked'

  const loadSponsorStatus = async (forceRefresh = false) => {
    const requestGeneration = ++sponsorRequestGeneration.current
    setSponsorLoading(true)
    setSponsorError('')
    try {
      const refresh = forceRefresh ? '&refresh=1' : ''
      const [roleResult, statusResult] = await Promise.all([
        requestApi(`/api/tron/sponsorship/roles?network=${network}${refresh}`),
        requestApi('/api/tron/sponsorship/status'),
      ])
      if (requestGeneration !== sponsorRequestGeneration.current) return
      const rolePayload = roleResult.payload
      const statusPayload = statusResult.payload
      setRoles(rolePayload?.roles ? rolePayload as SponsorRoles : null)
      setSponsorship(statusPayload?.sponsorship || null)
      if (!roleResult.ok || rolePayload?.success !== true) {
        setSponsorError(rolePayload?.message || rolePayload?.error || `Sponsor role checks are incomplete (HTTP ${roleResult.httpStatus}).`)
      } else if (!statusResult.ok || statusPayload?.success !== true) {
        setSponsorError(statusPayload?.message || 'Sponsorship status could not be verified.')
      }
      setSponsorCheckedAt(Date.now())
    } catch (error) {
      if (requestGeneration !== sponsorRequestGeneration.current) return
      setRoles(null)
      setSponsorship(null)
      setSponsorError(error instanceof Error ? error.message : 'Sponsor diagnostics are unavailable.')
      setSponsorCheckedAt(Date.now())
    } finally {
      if (requestGeneration === sponsorRequestGeneration.current) setSponsorLoading(false)
    }
  }

  useEffect(() => {
    void loadSponsorStatus(false)
    // Do not retain account or balance state when changing networks.
    setStep(0)
    setFeeSponsorRequired(false)
    setAssetSponsorRequired(false)
    setAssetKind(null)
    setTokenContract('')
    setAmount('1')
    setSenderAddress('')
    setWatchAddress('')
    setWalletSource(null)
    setNativeSnapshot(null)
    setSenderTokenSnapshot(null)
    setSenderError('')
    setSenderCheckedAt(null)
    setReceiverAddress('')
    setReceiverSnapshot(null)
    setReceiverError('')
    setReceiverCheckedAt(null)
    receiverHistoryRequestGeneration.current += 1
    setReceiverHistoryRecords([])
    setReceiverHistoryLoading(false)
    setReceiverHistoryError('')
    setReceiverHistoryNotice('')
    setReceiverHistoryCheckedAt(null)
    setReceiverHistoryPersistedAvailable(null)
    setReceiverHistoryVerifyingKey(null)
    setReceiverHistoryVerificationMessages({})
    clearFeeEstimate()
    setReviewNotice('')
    // loadSponsorStatus is intentionally invoked when the selected network changes.
  }, [network])

  useEffect(() => {
    const provider = (window as any).tron
    if (!provider || typeof provider.on !== 'function') return
    const invalidate = () => {
      setSenderAddress('')
      setWalletSource(null)
      setNativeSnapshot(null)
      setSenderTokenSnapshot(null)
      setSenderError('TronLink account or network changed. Reconnect and re-read the balances before continuing.')
      setSenderCheckedAt(null)
      setReceiverSnapshot(null)
      setReceiverCheckedAt(null)
      receiverHistoryRequestGeneration.current += 1
      setReceiverHistoryRecords([])
      setReceiverHistoryError('')
      setReceiverHistoryNotice('')
      setReceiverHistoryCheckedAt(null)
      setReceiverHistoryPersistedAvailable(null)
      setStep((current) => Math.min(current, 2))
    }
    provider.on('accountsChanged', invalidate)
    provider.on('chainChanged', invalidate)
    return () => {
      try { provider.removeListener?.('accountsChanged', invalidate) } catch {}
      try { provider.removeListener?.('chainChanged', invalidate) } catch {}
    }
  }, [])

  const readSenderSnapshots = async (address: string) => {
    if (!ADDRESS_PATTERN.test(address)) throw new Error('Enter a valid TRON Base58 address.')
    setSenderLoading(true)
    setSenderError('')
    setNativeSnapshot(null)
    setSenderTokenSnapshot(null)
    setReceiverSnapshot(null)
    setReceiverCheckedAt(null)
    try {
      const native = await readNativeBalance(network, address)
      setNativeSnapshot(native)
      if (assetKind === 'TRC20' && ADDRESS_PATTERN.test(tokenContract.trim())) {
        try {
          const token = await readTokenBalance(network, tokenContract.trim(), address)
          setSenderTokenSnapshot(token)
        } catch (error) {
          // A token read is useful, but it must never be interpreted as user
          // funding. Failure to read it is reported separately from native TRX.
          setSenderError(error instanceof Error ? `Native TRX was read, but token details are unavailable: ${error.message}` : 'Token details could not be read.')
        }
      }
      setSenderCheckedAt(Date.now())
    } catch (error) {
      setNativeSnapshot(null)
      setSenderError(error instanceof Error ? error.message : 'Wallet balance read failed.')
      setSenderCheckedAt(Date.now())
      throw error
    } finally {
      setSenderLoading(false)
    }
  }

  const connectTronLink = async () => {
    setSenderError('')
    setSenderLoading(true)
    try {
      const provider = (window as any).tron
      if (!provider || provider.isTronLink !== true || !provider.tronWeb) throw new Error('TronLink was not detected. Install/open a compatible TronLink wallet, or use the watch-only address option.')
      if (typeof provider.request === 'function') {
        try {
          await provider.request({ method: 'tron_requestAccounts' })
        } catch (error) {
          const code = Number((error as any)?.code)
          const message = error instanceof Error ? error.message : ''
          // Fall back only when the injected provider does not implement this
          // request method. A user denial must not trigger a second prompt.
          if (code === -32601 || /method not found|unsupported method/i.test(message)) {
            await provider.request({ method: 'eth_requestAccounts' })
          } else {
            throw error
          }
        }
      } else {
        throw new Error('TronLink account authorization is not available in this browser.')
      }
      const tronWeb = provider.tronWeb
      checkedWalletNetwork(tronWeb, network)
      const address = String(tronWeb?.defaultAddress?.base58 || '')
      if (!ADDRESS_PATTERN.test(address) || (typeof tronWeb.isAddress === 'function' && !tronWeb.isAddress(address))) {
        throw new Error('TronLink did not provide a valid authorized TRON address.')
      }
      setWalletMode('tronlink')
      setSenderAddress(address)
      setWatchAddress(address)
      setWalletSource('TronLink')
      // Connecting or reconnecting a wallet is a refresh boundary for the
      // sponsor snapshots too. Refresh the fee and principal roles alongside
      // the sender's chain reads so the review stage never relies on stale UI data.
      await Promise.all([
        readSenderSnapshots(address),
        loadSponsorStatus(true),
      ])
    } catch (error) {
      setSenderAddress('')
      setWalletSource(null)
      setNativeSnapshot(null)
      setSenderTokenSnapshot(null)
      setSenderError(error instanceof Error ? error.message : 'Could not connect to TronLink.')
    } finally {
      setSenderLoading(false)
    }
  }

  const inspectWatchAddress = async () => {
    const address = watchAddress.trim()
    if (!ADDRESS_PATTERN.test(address)) {
      setSenderError('Enter a valid TRON Base58 address (starts with T and is 34 characters).')
      return
    }
    setWalletSource('Watch-only')
    setSenderAddress(address)
    try {
      await readSenderSnapshots(address)
    } catch {
      // readSenderSnapshots has already supplied the specific error.
    }
  }

  const estimateSponsoredFee = async () => {
    const contract = tokenContract.trim()
    const receiver = receiverAddress.trim()
    const exactAmountBaseUnits = amountBaseUnits
    if (!['TRC20', 'TRX'].includes(String(assetKind)) || !ADDRESS_PATTERN.test(receiver) || !exactAmountBaseUnits
      || (assetKind === 'TRC20' && !ADDRESS_PATTERN.test(contract))) {
      setFeeEstimateError('Select a supported asset, valid receiver and positive amount before estimating network fees.')
      return
    }

    const requestGeneration = ++feeEstimateRequestGeneration.current
    const selectedAsset = assetKind
    const endpoint = selectedAsset === 'TRX'
      ? '/api/tron/sponsorship/native-fee-estimate'
      : '/api/tron/sponsorship/fee-estimate'
    const requestBody = selectedAsset === 'TRX'
      ? { network, receiverAddress: receiver, amountBaseUnits: exactAmountBaseUnits }
      : { network, tokenContract: contract, receiverAddress: receiver, amountBaseUnits: exactAmountBaseUnits }
    setFeeEstimateLoading(true)
    setFeeEstimateError('')
    setFeeEstimate(null)
    try {
      const response = await fetch(API_BASE + endpoint, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
        body: JSON.stringify(requestBody),
      })
      const payload = await response.json().catch(() => null)
      if (requestGeneration !== feeEstimateRequestGeneration.current) return
      if (!response.ok || payload?.success !== true) {
        setFeeEstimateError(payload?.message || payload?.status || payload?.error || ('Fee preflight unavailable (HTTP ' + response.status + ').'))
        return
      }
      if (network !== payload.network || receiver !== payload.receiverAddress || exactAmountBaseUnits !== payload.amountBaseUnits
        || (selectedAsset === 'TRC20' && contract !== payload.tokenContract)
        || (selectedAsset === 'TRX' && payload.asset !== 'TRX')) return
      setFeeEstimate(payload as FeeEstimate)
    } catch (error) {
      if (requestGeneration !== feeEstimateRequestGeneration.current) return
      setFeeEstimateError(error instanceof Error ? error.message : 'Could not read the current TRON fee estimate.')
    } finally {
      if (requestGeneration === feeEstimateRequestGeneration.current) setFeeEstimateLoading(false)
    }
  }

  const inspectReceiver = async () => {
    const address = receiverAddress.trim()
    setReceiverError('')
    setReceiverSnapshot(null)
    setReceiverCheckedAt(null)
    if (!ADDRESS_PATTERN.test(address)) {
      setReceiverError('Enter a valid TRON Base58 receiver address.')
      return
    }
    if (address === senderAddress) {
      setReceiverError('The receiver must be different from the selected sender/watch address.')
      return
    }
    setReceiverLoading(true)
    try {
      const snapshot = assetKind === 'TRX'
        ? await readNativeBalance(network, address)
        : await readTokenBalance(network, tokenContract.trim(), address)
      setReceiverSnapshot(snapshot)
      setReceiverCheckedAt(Date.now())
    } catch (error) {
      setReceiverError(error instanceof Error ? error.message : 'Could not verify the receiver on the selected network.')
    } finally {
      setReceiverLoading(false)
    }
  }

  const loadReceiverHistory = async () => {
    const address = receiverAddress.trim()
    const contract = tokenContract.trim()
    clearReceiverHistory()
    const requestGeneration = receiverHistoryRequestGeneration.current
    if (!ADDRESS_PATTERN.test(address)) {
      setReceiverHistoryError('Enter a valid receiver address before loading history.')
      return
    }
    if (!ADDRESS_PATTERN.test(contract)) {
      setReceiverHistoryError('Enter a valid TRC-20 token contract before loading history.')
      return
    }

    setReceiverHistoryLoading(true)
    try {
      const query = `network=${encodeURIComponent(network)}&address=${encodeURIComponent(address)}&contract=${encodeURIComponent(contract)}`
      const results = await Promise.allSettled([
        requestApi(`/api/tron/receiver-history?${query}&limit=20`),
        requestApi(`/api/tron/receiver-history/persisted?${query}&limit=50`),
      ])
      if (requestGeneration !== receiverHistoryRequestGeneration.current) return
      const indexedResult = results[0].status === 'fulfilled' ? results[0].value : null
      const persistedResult = results[1].status === 'fulfilled' ? results[1].value : null
      const indexedOk = indexedResult?.ok === true
        && indexedResult.payload?.success === true
        && Array.isArray(indexedResult.payload?.records)
      const persistedOk = persistedResult?.ok === true
        && persistedResult.payload?.success === true
        && Array.isArray(persistedResult.payload?.records)
      setReceiverHistoryPersistedAvailable(persistedOk)

      if (!indexedOk && !persistedOk) {
        setReceiverHistoryError('Receiver history is temporarily unavailable. No empty-history result can be inferred from a failed lookup.')
        setReceiverHistoryCheckedAt(Date.now())
        return
      }

      const indexedRows: ReceiverHistoryRecord[] = indexedOk
        ? indexedResult!.payload.records.map((record: ReceiverHistoryRecord) => ({
            ...record,
            network,
            receiverAddress: address,
            tokenContract: typeof record.tokenContract === 'string' ? record.tokenContract : contract,
            // Indexer output is always a candidate here, even if a remote payload
            // accidentally includes verification-like fields.
            verifiedOnChain: false,
            verificationStatus: 'indexed-candidate-awaiting-solidified-verification',
            recordSource: 'indexer' as const,
          }))
        : []
      const persistedRows: ReceiverHistoryRecord[] = persistedOk
        ? persistedResult!.payload.records.map((record: ReceiverHistoryRecord) => ({
            ...record,
            network,
            receiverAddress: typeof record.receiverAddress === 'string' ? record.receiverAddress : address,
            tokenContract: typeof record.tokenContract === 'string' ? record.tokenContract : contract,
            recordSource: 'persisted' as const,
          }))
        : []

      const recordKey = (record: ReceiverHistoryRecord) => [
        (record.transactionId || '').toLowerCase(),
        (record.tokenContract || '').toLowerCase(),
        record.eventIndex === null || record.eventIndex === undefined ? '' : String(record.eventIndex),
      ].join('|')
      const merged = new Map<string, ReceiverHistoryRecord>()
      for (const record of indexedRows) {
        merged.set(recordKey(record), record)
      }
      for (const record of persistedRows) {
        const key = recordKey(record)
        let current = merged.get(key)
        let targetKey = key
        // TRONGrid event_index and SolidityNode receipt-log index are not
        // guaranteed to share the same numbering. Match a verified receipt to
        // its exact transaction/contract/sender/receiver/amount before adding a
        // second row for the same transfer.
        if (!current && record.verifiedOnChain === true) {
          const matchingEntry = [...merged.entries()].find(([, candidate]) =>
            (candidate.transactionId || '').toLowerCase() === (record.transactionId || '').toLowerCase()
            && (candidate.tokenContract || '').toLowerCase() === (record.tokenContract || '').toLowerCase()
            && (candidate.senderAddress || '').toLowerCase() === (record.senderAddress || '').toLowerCase()
            && (candidate.receiverAddress || '').toLowerCase() === (record.receiverAddress || '').toLowerCase()
            && candidate.amountBaseUnits === record.amountBaseUnits
          )
          if (matchingEntry) {
            targetKey = matchingEntry[0]
            current = matchingEntry[1]
          }
        }
        merged.set(targetKey, {
          ...current,
          ...record,
          tokenName: record.tokenName || current?.tokenName,
          tokenSymbol: record.tokenSymbol || current?.tokenSymbol,
          tokenDecimals: record.tokenDecimals ?? current?.tokenDecimals,
        })
      }

      const records = [...merged.values()].sort(
        (left, right) => historyTimestampMs(right.timestamp) - historyTimestampMs(left.timestamp),
      )
      setReceiverHistoryRecords(records)
      if (!persistedOk && indexedOk) {
        setReceiverHistoryNotice('The verified-history store is unavailable. Every displayed indexer row remains an unverified candidate.')
      } else if (persistedOk && !indexedOk) {
        setReceiverHistoryNotice('Live indexer lookup is unavailable; only persisted records are shown.')
      }
      setReceiverHistoryCheckedAt(Date.now())
    } catch {
      setReceiverHistoryError('Receiver history could not be safely loaded from the selected network.')
      setReceiverHistoryCheckedAt(Date.now())
    } finally {
      if (requestGeneration === receiverHistoryRequestGeneration.current) setReceiverHistoryLoading(false)
    }
  }

  const verifyReceiverHistoryRecord = async (record: ReceiverHistoryRecord, recordKey: string) => {
    const requestGeneration = receiverHistoryRequestGeneration.current
    const transactionId = record.transactionId
    const contract = record.tokenContract || tokenContract.trim()
    const from = record.senderAddress
    const to = record.receiverAddress || receiverAddress.trim()
    const amountBaseUnits = record.amountBaseUnits
    if (typeof transactionId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(transactionId)
      || typeof from !== 'string' || !ADDRESS_PATTERN.test(from)
      || typeof to !== 'string' || !ADDRESS_PATTERN.test(to)
      || typeof contract !== 'string' || !ADDRESS_PATTERN.test(contract)
      || typeof amountBaseUnits !== 'string' || !/^(0|[1-9][0-9]*)$/.test(amountBaseUnits)
      || BigInt(amountBaseUnits) <= 0n) {
      setReceiverHistoryVerificationMessages((current) => ({
        ...current,
        [recordKey]: 'Cannot verify this row: transaction ID, addresses, contract, or exact base-unit amount is missing or invalid.',
      }))
      return
    }
    if (record.network && record.network !== network) {
      setReceiverHistoryVerificationMessages((current) => ({
        ...current,
        [recordKey]: 'Network changed since this history row was loaded. Reload history on the selected network before verifying it.',
      }))
      return
    }

    setReceiverHistoryVerifyingKey(recordKey)
    setReceiverHistoryVerificationMessages((current) => {
      const next = { ...current }
      delete next[recordKey]
      return next
    })
    try {
      const query = new URLSearchParams({ network, contract, from, to, amountBaseUnits })
      const result = await requestApi('/api/tron/verify-trc20-transfer/' + encodeURIComponent(transactionId) + '?' + query.toString())
      if (requestGeneration !== receiverHistoryRequestGeneration.current) return
      const payload = result.payload
      if (!result.ok || payload?.success !== true || payload?.verified !== true
        || payload?.status !== 'solidified-trc20-transfer-verified') {
        const detail = payload?.status || payload?.error || ('HTTP ' + result.httpStatus)
        setReceiverHistoryVerificationMessages((current) => ({
          ...current,
          [recordKey]: 'Solidified verification did not confirm this transfer (' + detail + '). The row remains unverified.',
        }))
        return
      }

      // Update the current UI after solidified verification. The API separately
      // reports whether the verified evidence was saved to server-side history.
      setReceiverHistoryRecords((current) => current.map((item) => {
        const sameTransfer = item.transactionId?.toLowerCase() === transactionId.toLowerCase()
          && (item.tokenContract || '').toLowerCase() === contract.toLowerCase()
          && item.senderAddress === from
          && (item.receiverAddress || receiverAddress.trim()) === to
          && item.amountBaseUnits === amountBaseUnits
        return sameTransfer
          ? { ...item, verifiedOnChain: true, verificationStatus: 'verified-on-chain' }
          : item
      }))
      const persisted = payload?.verificationPersistence?.persisted === true
      const persistenceReason = payload?.verificationPersistence?.reason || 'persistence-unavailable'
      setReceiverHistoryVerificationMessages((current) => ({
        ...current,
        [recordKey]: persisted
          ? 'Verified against the solidified ' + network + ' transaction body, receipt and exact Transfer event; server history saved. This does not confirm exchange credit.'
          : 'Verified against the solidified ' + network + ' transaction body, receipt and exact Transfer event, but server history was not saved (' + persistenceReason + '). It may not appear after reload. This does not confirm exchange credit.',
      }))
    } catch {
      setReceiverHistoryVerificationMessages((current) => ({
        ...current,
        [recordKey]: 'Solidified verification is temporarily unavailable. The row remains unverified; retry the same transaction ID later.',
      }))
    } finally {
      if (requestGeneration === receiverHistoryRequestGeneration.current) {
        setReceiverHistoryVerifyingKey((current) => current === recordKey ? null : current)
      }
    }
  }

  const chooseNetwork = (next: NetworkId) => {
    if (next === network) return
    // Invalidate in-flight reads synchronously before React changes networks.
    sponsorRequestGeneration.current += 1
    setSponsorLoading(false)
    setReviewRefreshing(false)
    clearFeeEstimate()
    setNetwork(next)
  }

  const goNext = () => {
    if (step < STEPS.length - 1 && stageCompletion[step]) setStep((value) => value + 1)
  }
  const goBack = () => setStep((value) => Math.max(0, value - 1))

  const refreshReview = async () => {
    const requestGeneration = ++sponsorRequestGeneration.current
    setReviewRefreshing(true)
    setReviewNotice('')
    try {
      const [roleResult, statusResult] = await Promise.all([
        requestApi(`/api/tron/sponsorship/roles?network=${network}&refresh=1`),
        requestApi('/api/tron/sponsorship/status'),
      ])
      if (requestGeneration !== sponsorRequestGeneration.current) return
      const rolePayload = roleResult.payload
      const statusPayload = statusResult.payload
      setRoles(rolePayload?.roles ? rolePayload as SponsorRoles : null)
      setSponsorship(statusPayload?.sponsorship || null)
      const checked = roleResult.ok && rolePayload?.success === true && statusResult.ok && statusPayload?.success === true
      setReviewNotice(checked
        ? 'Sponsor status refreshed successfully. The backend still reports sponsored submission disabled; no transaction was created or broadcast.'
        : 'Sponsor readiness could not be fully verified. Submission remains blocked and no transaction was created.')
      if (!checked) setSponsorError(rolePayload?.message || statusPayload?.message || 'One or more sponsorship checks are unavailable.')
      else setSponsorError('')
      setSponsorCheckedAt(Date.now())
    } catch (error) {
      if (requestGeneration !== sponsorRequestGeneration.current) return
      setReviewNotice(error instanceof Error ? error.message : 'Sponsor status refresh failed. Submission remains blocked.')
    } finally {
      if (requestGeneration === sponsorRequestGeneration.current) setReviewRefreshing(false)
    }
  }

  const copyRequestSummary = async () => {
    const summary = [
      'TRON Token Studio — non-submitting sponsor request',
      `Network: ${network === 'nile' ? 'Nile testnet' : 'Shasta testnet'}`,
      'Fee policy: external network-fee sponsor only; no sender-funded fallback',
      `Asset principal sponsor: external sponsor only; asset ${assetKind || 'not selected'}`,
      assetKind === 'TRC20' ? `Token contract: ${tokenContract.trim()}` : null,
      `Sender/watch wallet: ${senderAddress}`,
      `Receiver: ${receiverAddress}`,
      `Requested amount: ${amount} ${assetKind === 'TRX' ? 'TRX' : 'token units'}`,
      `Amount base units: ${amountBaseUnits || 'not validated'}`,
      `Sponsor submission enabled by backend: ${sponsorship?.canSubmitSponsoredTransfer === true ? 'reported true' : 'no'}`,
      'This summary is not a transaction, payment instruction, exchange deposit confirmation, or sponsor commitment.',
    ].filter(Boolean).join('\n')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this browser.')
      await navigator.clipboard.writeText(summary)
      setCopyNotice('Validated request summary copied.')
    } catch (error) {
      setCopyNotice(error instanceof Error ? error.message : 'Could not copy the request summary.')
    }
  }

  const currentStep = STEPS[step]

  return (
    <div className="studio-root">
      <header className="studio-topbar">
        <a className="studio-brand" href="#top" onClick={(event) => event.preventDefault()} aria-label="TRON Token Studio home">
          <span className="studio-logo"><Layers size={22} aria-hidden="true" /></span>
          <span className="studio-brand-copy">
            <strong>TRON Token Studio</strong>
            <small>Sponsored transfer workspace</small>
          </span>
        </a>
        <div className="studio-topbar-tools">
          <div className="studio-network-picker" role="group" aria-label="Select test network">
            <span className="studio-network-label"><Network size={14} aria-hidden="true" /> Network</span>
            <button type="button" aria-pressed={network === 'shasta'} className={network === 'shasta' ? 'is-selected' : ''} onClick={() => chooseNetwork('shasta')}>Shasta</button>
            <button type="button" aria-pressed={network === 'nile'} className={network === 'nile' ? 'is-selected' : ''} onClick={() => chooseNetwork('nile')}>Nile</button>
          </div>
          <Pill tone="warning">Testnet only</Pill>
        </div>
      </header>

      <div className="studio-shell" id="top">
        <aside className="studio-sidebar" aria-label="Transfer stages">
          <div className="studio-sidebar-heading">
            <p className="studio-eyebrow">Transfer workflow</p>
            <h2>Request setup</h2>
            <p className="studio-muted">Complete each stage in order. Live sending remains disabled until sponsor integration is verified.</p>
          </div>
          <nav className="studio-step-list" aria-label="Wizard stages">
            {STEPS.map((item, index) => {
              const state = currentStageState(index)
              return (
                <button key={item.title} type="button" disabled={!canEnterStep(index)} aria-current={step === index ? 'step' : undefined} className={`studio-step-nav studio-step-nav--${state}`} onClick={() => setStep(index)}>
                  <span className="studio-step-number">{stageCompletion[index] ? <Check size={16} aria-hidden="true" /> : index + 1}</span>
                  <span className="studio-step-copy"><strong>{item.short}</strong><small>{item.caption}</small></span>
                  {state === 'locked' && <LockKeyhole size={15} aria-hidden="true" />}
                </button>
              )
            })}
          </nav>
          <div className="studio-sidebar-foot">
            <ShieldCheck size={18} aria-hidden="true" />
            <p><strong>No sender-funded fallback</strong><br />Wallet inspection is read-only. This flow does not ask for a seed phrase, private key, or a fee payment.</p>
          </div>
        </aside>

        <main className="studio-main">
          <section className="studio-page-heading">
            <div>
              <p className="studio-eyebrow">Stage {step + 1} of {STEPS.length} · {network === 'nile' ? 'Nile testnet' : 'Shasta testnet'}</p>
              <h1>{currentStep.title}</h1>
              <p>{currentStep.caption}</p>
            </div>
            <div className="studio-progress-wrap" aria-label={`${step + 1} of ${STEPS.length} stages`}>
              <div className="studio-progress"><span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
              <span>{Math.round(((step + 1) / STEPS.length) * 100)}%</span>
            </div>
          </section>

          <div className="studio-notice studio-notice--warning" role="status">
            <AlertTriangle size={18} aria-hidden="true" />
            <div><strong>Sponsorship is not currently active</strong><p>The backend has not verified an authorized fee sponsor and asset-principal sponsor for a send. You can prepare and validate a request, but this interface cannot broadcast a sponsored transfer or charge your wallet as a fallback.</p></div>
          </div>

          {step === 0 && (
            <section className="studio-panel" aria-labelledby="fee-stage-title">
              <div className="studio-panel-heading">
                <div className="studio-panel-icon"><Fuel size={20} aria-hidden="true" /></div>
                <div><p className="studio-eyebrow">Sponsor A</p><h2 id="fee-stage-title">Who must cover network fees?</h2><p>Choose the external-sponsor-only rule for this request. No sender-funded fallback is offered.</p></div>
                <Pill tone={sponsorLoading ? 'neutral' : sponsorship?.canSubmitSponsoredTransfer ? 'good' : 'warning'}>{sponsorLoading ? 'Checking' : sponsorship?.canSubmitSponsoredTransfer ? 'Backend reports enabled' : 'Not active'}</Pill>
              </div>

              <button type="button" onClick={() => setFeeSponsorRequired(true)} aria-pressed={feeSponsorRequired} className={`studio-choice-card ${feeSponsorRequired ? 'is-picked' : ''}`}>
                <span className="studio-choice-check">{feeSponsorRequired && <Check size={16} aria-hidden="true" />}</span>
                <span className="studio-grow"><strong>External network-fee sponsor required</strong><small>The sponsor must cover eligible fees using its own verified account and authorization. If it cannot cover the fee, the request must stop rather than debit the sender.</small></span>
                <Pill tone="warning">Required</Pill>
              </button>

              <div className="studio-snapshot-heading">
                <div><h3>Live sponsor A status</h3><p>Read-only backend snapshot for the selected network.</p></div>
                <button type="button" onClick={() => void loadSponsorStatus(true)} disabled={sponsorLoading} className="studio-button studio-button--secondary"><RefreshCw size={15} className={sponsorLoading ? 'studio-spin' : ''} aria-hidden="true" /> Refresh</button>
              </div>
              <RoleSnapshotCard title="Network fee sponsor" role={roles?.roles?.networkFeeSponsor} icon={<Fuel size={19} aria-hidden="true" />} />
              {sponsorError && <p className="studio-inline-error" role="alert">{sponsorError}</p>}
              <p className="studio-footnote">Last checked: {formatTimestamp(sponsorCheckedAt)}. A configured sponsor address or visible balance is not proof of signing authorization, spendable budget, or coverage for a future transaction.</p>
            </section>
          )}

          {step === 1 && (
            <section className="studio-panel" aria-labelledby="asset-stage-title">
              <div className="studio-panel-heading">
                <div className="studio-panel-icon"><CircleDollarSign size={20} aria-hidden="true" /></div>
                <div><p className="studio-eyebrow">Sponsor B</p><h2 id="asset-stage-title">Who supplies the asset principal?</h2><p>This is separate from network fees. The principal sponsor must own and authorize the asset transfer.</p></div>
                <Pill tone={hasVerifiedFundingSnapshot(roles?.roles?.assetPrincipalSponsor) ? 'good' : 'warning'}>{hasVerifiedFundingSnapshot(roles?.roles?.assetPrincipalSponsor) ? 'Snapshot verified' : 'Not verified'}</Pill>
              </div>

              <button type="button" onClick={() => setAssetSponsorRequired(true)} aria-pressed={assetSponsorRequired} className={`studio-choice-card ${assetSponsorRequired ? 'is-picked' : ''}`}>
                <span className="studio-choice-check">{assetSponsorRequired && <Check size={16} aria-hidden="true" />}</span>
                <span className="studio-grow"><strong>External asset-principal sponsor required</strong><small>The sponsor must supply the requested asset from its own verified balance. The sender wallet is never a fallback source.</small></span>
                <Pill tone="warning">Required</Pill>
              </button>

              <div className="studio-choice-grid">
                <button type="button" onClick={() => { setAssetKind('TRX'); setTokenContract(''); setSenderTokenSnapshot(null); setReceiverSnapshot(null); clearReceiverHistory(); clearFeeEstimate() }} aria-pressed={assetKind === 'TRX'} className={`studio-asset-choice ${assetKind === 'TRX' ? 'is-picked' : ''}`}>
                  <span className="studio-asset-mark">T</span><strong>Native TRX</strong><small>Testnet TRX supplied by the asset sponsor; not Mainnet value.</small><span className="studio-asset-selected">{assetKind === 'TRX' ? 'Selected' : 'Choose TRX'}</span>
                </button>
                <button type="button" onClick={() => { setAssetKind('TRC20'); setSenderTokenSnapshot(null); setReceiverSnapshot(null); clearReceiverHistory(); clearFeeEstimate() }} aria-pressed={assetKind === 'TRC20'} className={`studio-asset-choice ${assetKind === 'TRC20' ? 'is-picked' : ''}`}>
                  <span className="studio-asset-mark">20</span><strong>TRC-20 test token</strong><small>Uses the exact token contract provided below. This is not official Mainnet USDT.</small><span className="studio-asset-selected">{assetKind === 'TRC20' ? 'Selected' : 'Choose TRC-20'}</span>
                </button>
              </div>

              {assetKind === 'TRC20' && (
                <div className="studio-field-block">
                  <label htmlFor="token-contract">Token contract address on {network === 'nile' ? 'Nile' : 'Shasta'}</label>
                  <input id="token-contract" value={tokenContract} onChange={(event) => { setTokenContract(event.target.value.trim()); setSenderTokenSnapshot(null); setReceiverSnapshot(null); clearReceiverHistory(); clearFeeEstimate() }} placeholder="Enter a deployed test token contract (T…)" autoComplete="off" spellCheck={false} />
                  <p className="studio-field-hint">The app reads balance and decimals from this exact contract on the selected testnet. A token symbol alone does not prove identity or exchange support.</p>
                  {tokenContract && !ADDRESS_PATTERN.test(tokenContract) && <p className="studio-inline-error">The contract address format is invalid.</p>}
                </div>
              )}

              <RoleSnapshotCard title="Asset principal sponsor" role={roles?.roles?.assetPrincipalSponsor} icon={<CircleDollarSign size={19} aria-hidden="true" />} />
              <div className="studio-notice studio-notice--neutral"><ShieldCheck size={18} aria-hidden="true" /><div><strong>Separate budgets, separate authorization</strong><p>A fee sponsor cannot create the requested TRX/token principal. The UI will not count a pending sponsor grant as a receiver balance.</p></div></div>
              <p className="studio-footnote">Sponsor status: {roleLabel(roles?.roles?.assetPrincipalSponsor)}. {roleDetail(roles?.roles?.assetPrincipalSponsor)}</p>
            </section>
          )}

          {step === 2 && (
            <section className="studio-panel" aria-labelledby="sender-stage-title">
              <div className="studio-panel-heading">
                <div className="studio-panel-icon"><Wallet size={20} aria-hidden="true" /></div>
                <div><p className="studio-eyebrow">Sender / watch account</p><h2 id="sender-stage-title">Inspect the wallet on the selected testnet</h2><p>Connect TronLink for the address only, or enter a public watch-only address. No signing prompt or sender funds are required for this inspection.</p></div>
              </div>

              <div className="studio-segmented" role="group" aria-label="Wallet inspection method">
                <button type="button" onClick={() => { setWalletMode('tronlink'); setSenderError('') }} aria-pressed={walletMode === 'tronlink'} className={walletMode === 'tronlink' ? 'is-selected' : ''}><Wallet size={16} aria-hidden="true" /> Connect TronLink</button>
                <button type="button" onClick={() => { setWalletMode('watch'); setSenderError('') }} aria-pressed={walletMode === 'watch'} className={walletMode === 'watch' ? 'is-selected' : ''}><Eye size={16} aria-hidden="true" /> Watch-only address</button>
              </div>

              {walletMode === 'tronlink' ? (
                <div className="studio-wallet-connect">
                  <div className="studio-wallet-symbol"><Wallet size={27} aria-hidden="true" /></div>
                  <h3>Connect without sharing secrets</h3>
                  <p>TronLink must already be set to {network === 'nile' ? 'Nile' : 'Shasta'} testnet. The app checks the injected wallet address and verifies balances through the backend.</p>
                  <button type="button" className="studio-button studio-button--primary" onClick={() => void connectTronLink()} disabled={senderLoading}><Wallet size={16} aria-hidden="true" /> {senderLoading ? 'Checking wallet…' : 'Connect / refresh TronLink'}</button>
                </div>
              ) : (
                <div className="studio-field-block">
                  <label htmlFor="watch-address">Public TRON wallet address</label>
                  <input id="watch-address" value={watchAddress} onChange={(event) => { setWatchAddress(event.target.value.trim()); setSenderError('') }} placeholder="T…" autoComplete="off" spellCheck={false} />
                  <div className="studio-inline-actions"><button type="button" className="studio-button studio-button--primary" onClick={() => void inspectWatchAddress()} disabled={senderLoading}><Eye size={16} aria-hidden="true" /> {senderLoading ? 'Reading chain state…' : 'Inspect watch-only wallet'}</button></div>
                  <p className="studio-field-hint">A watch-only address cannot sign or spend. It is suitable for inspecting public balances only.</p>
                </div>
              )}

              {senderError && <p className="studio-inline-error" role="alert">{senderError}</p>}
              {senderAddress && (
                <div className="studio-account-summary">
                  <div className="studio-account-heading"><div><p className="studio-eyebrow">Selected wallet</p><strong>{walletSource || 'Wallet'}</strong></div><Pill tone={senderStageValid ? 'good' : 'warning'}>{senderStageValid ? 'Address verified' : 'Read required'}</Pill></div>
                  <code>{senderAddress}</code>
                  <div className="studio-balance-grid">
                    <div className="studio-balance"><span>Solidified TRX balance</span><strong>{nativeSnapshot?.balanceTRX ?? (senderLoading ? 'Reading…' : 'Unavailable')} <small>TRX</small></strong><p>{nativeSnapshot?.accountExists === false ? 'Account not yet created/indexed' : nativeSnapshot?.source || 'Read from selected network'}</p></div>
                    {assetKind === 'TRC20' && <div className="studio-balance"><span>Selected token balance</span><strong>{senderTokenSnapshot ? formatUnits(senderTokenSnapshot.balanceBaseUnits, senderTokenSnapshot.decimals) : 'Unavailable'}</strong><p>{senderTokenSnapshot ? `Contract decimals: ${senderTokenSnapshot.decimals}` : 'Token read is informational only; it is not the sponsored principal.'}</p></div>}
                  </div>
                  <div className="studio-inline-actions"><button type="button" className="studio-button studio-button--secondary" onClick={() => { if (walletSource === 'Watch-only') void inspectWatchAddress(); else void connectTronLink() }} disabled={senderLoading}><RefreshCw size={15} className={senderLoading ? 'studio-spin' : ''} aria-hidden="true" /> Refresh wallet snapshot</button></div>
                  <p className="studio-footnote">Last checked: {formatTimestamp(senderCheckedAt)}. A zero or unavailable sender balance does not authorize the platform to charge this wallet. The selected sponsor must fund any sponsored principal and fees itself.</p>
                </div>
              )}
            </section>
          )}

          {step === 3 && (
            <section className="studio-panel" aria-labelledby="receiver-stage-title">
              <div className="studio-panel-heading">
                <div className="studio-panel-icon"><Layers size={20} aria-hidden="true" /></div>
                <div><p className="studio-eyebrow">Request details</p><h2 id="receiver-stage-title">Enter the receiver and amount</h2><p>These fields only define a proposed testnet request. No transfer is signed or broadcast from this stage.</p></div>
              </div>

              <div className="studio-request-summary">
                <div><span>Network</span><strong>{network === 'nile' ? 'Nile testnet' : 'Shasta testnet'}</strong></div>
                <div><span>Principal asset</span><strong>{assetKind === 'TRX' ? 'Native TRX' : 'TRC-20 test token'}</strong></div>
                <div><span>Fee policy</span><strong>External sponsor only</strong></div>
              </div>

              {assetKind === 'TRC20' && <div className="studio-field-block"><label>Selected token contract</label><div className="studio-readonly-value">{tokenContract}</div><p className="studio-field-hint">Exact contract is read from the selected testnet. Do not use a token symbol as proof of contract identity.</p></div>}
              <div className="studio-field-block">
                <label htmlFor="receiver-address">Receiver TRON address</label>
                <input id="receiver-address" value={receiverAddress} onChange={(event) => { setReceiverAddress(event.target.value.trim()); setReceiverSnapshot(null); setReceiverCheckedAt(null); setReceiverError(''); clearReceiverHistory(); clearFeeEstimate() }} placeholder="T…" autoComplete="off" spellCheck={false} />
                <p className="studio-field-hint">The receiver must be a valid address different from the sender/watch wallet.</p>
              </div>
              <div className="studio-field-block">
                <label htmlFor="transfer-amount">Requested amount {amountDecimals !== undefined && amountDecimals !== null ? `(up to ${amountDecimals} decimals)` : ''}</label>
                <div className="studio-amount-entry"><input id="transfer-amount" value={amount} onChange={(event) => { setAmount(event.target.value); setReceiverSnapshot(null); setReceiverCheckedAt(null); setReceiverError(''); clearFeeEstimate() }} inputMode="decimal" placeholder="1.00" /><span>{assetKind === 'TRX' ? 'TRX' : 'token units'}</span></div>
                {amount && amountDecimals != null && !amountBaseUnits && <p className="studio-inline-error">Amount must be positive and contain no more than {amountDecimals} decimal places.</p>}
                {assetKind === 'TRC20' && senderTokenSnapshot?.decimals == null && <p className="studio-field-hint">Token decimals are not yet verified. Go back to the sender stage and refresh the token snapshot.</p>}
              </div>

              {(assetKind === 'TRC20' || assetKind === 'TRX') && (
                <section className="studio-history-panel" aria-labelledby="sponsor-fee-estimate-title">
                  <div className="studio-snapshot-heading">
                    <div>
                      <h3 id="sponsor-fee-estimate-title">{assetKind === 'TRX' ? 'Sponsor bandwidth preflight' : 'Sponsor energy preflight'}</h3>
                      <p>{assetKind === 'TRX'
                        ? 'Read-only unsigned native TRX transaction draft to estimate bandwidth requirements.'
                        : 'Read-only current-node simulation for this token contract, receiver and exact amount.'}</p>
                    </div>
                    <button
                      type="button"
                      className="studio-button studio-button--secondary"
                      onClick={() => void estimateSponsoredFee()}
                      disabled={feeEstimateLoading || (assetKind === 'TRC20' && !ADDRESS_PATTERN.test(tokenContract.trim())) || !ADDRESS_PATTERN.test(receiverAddress.trim()) || !amountBaseUnits}
                    >
                      <Fuel size={15} className={feeEstimateLoading ? 'studio-spin' : ''} aria-hidden="true" />
                      {feeEstimateLoading ? 'Estimating network fees…' : feeEstimate ? 'Refresh estimate' : assetKind === 'TRX' ? 'Estimate sponsor bandwidth' : 'Estimate sponsor energy'}
                    </button>
                  </div>
                  <p className="studio-field-hint">{assetKind === 'TRX'
                    ? 'This estimates signed transaction size and bandwidth using one 65-byte signature allowance. The exact signed bytes and total fees may differ; no transaction is signed or broadcast.'
                    : 'This estimates contract Energy only. It does not include exact signed-transaction bandwidth or total fees, it does not move funds, and it does not authorize submission.'}</p>
                  {feeEstimateError && <p className="studio-inline-error" role="alert">{feeEstimateError}</p>}
                  {assetKind === 'TRX' && feeEstimate?.success === true && feeEstimate.nativeEstimation && (
                    <div className="studio-account-summary" role="status">
                      <div className="studio-account-heading">
                        <div>
                          <p className="studio-eyebrow">Native TRX bandwidth estimate · {feeEstimate.network}</p>
                          <strong>Estimated signed transaction: {feeEstimate.nativeEstimation.estimatedSignedTransactionBytes ?? 'Unknown'} bytes</strong>
                        </div>
                        <Pill tone="warning">Estimated, not final</Pill>
                      </div>
                      <div className="studio-balance-grid">
                        <div className="studio-balance">
                          <span>Estimated bandwidth shortfall</span>
                          <strong>{feeEstimate.nativeEstimation.estimatedBandwidthShortfallBytes ?? 'Unknown'} <small>bytes</small></strong>
                          <p>Available principal sponsor bandwidth: {feeEstimate.nativeEstimation.totalPrincipalSponsorBandwidth ?? 'Unknown'} units.</p>
                        </div>
                        <div className="studio-balance">
                          <span>Principal sponsor's estimated bandwidth burn</span>
                          <strong>{feeEstimate.nativeEstimation.estimatedBandwidthFeeTRX ?? 'Unknown'} <small>TRX</small></strong>
                          <p>{feeEstimate.nativeEstimation.estimatedBandwidthFeeSun ?? 'Unknown'} SUN at {feeEstimate.nativeEstimation.bandwidthFeeSunPerByte ?? 'unknown'} SUN per byte, based on the principal sponsor's current bandwidth snapshot.</p>
                        </div>
                        <div className="studio-balance">
                          <span>Principal sponsor resources</span>
                          <strong>{feeEstimate.nativeEstimation.principalSponsorResources?.availableStakedBandwidth ?? 'Unknown'} + {feeEstimate.nativeEstimation.principalSponsorResources?.availableFreeBandwidth ?? 'Unknown'}</strong>
                          <p>Staked bandwidth + free bandwidth, current-node snapshot.</p>
                        </div>
                        <div className="studio-balance">
                          <span>Fee sponsor's own resources</span>
                          <strong>{feeEstimate.nativeEstimation.feeSponsorResources?.availableStakedBandwidth ?? 'Unknown'} + {feeEstimate.nativeEstimation.feeSponsorResources?.availableFreeBandwidth ?? 'Unknown'}</strong>
                          <p>These are the fee sponsor's own available resources, not a delegated balance for the principal sponsor.</p>
                        </div>
                        <div className="studio-balance">
                          <span>Live delegated Bandwidth stake</span>
                          <strong>{feeEstimate.nativeEstimation.feeSponsorResourceDelegation?.success === true
                            ? (feeEstimate.nativeEstimation.feeSponsorResourceDelegation.activeBandwidthStakeSun ?? '0') + ' SUN'
                            : 'Not verified'}</strong>
                          <p>{feeEstimate.nativeEstimation.feeSponsorResourceDelegation?.status || 'Solidified delegation query has not succeeded'}; values are SUN-equivalent staked TRX, not Bandwidth units.</p>
                        </div>
                      </div>
                      <p className="studio-inline-note" role="status">
                        Fee sponsor resources counted toward principal: {feeEstimate.nativeEstimation.feeSponsorResourcesCountedTowardPrincipalTransfer === true ? 'yes' : 'no'}.
                        {' '}Transaction audit record verified: {feeEstimate.nativeEstimation.resourceDelegationVerified === true ? 'yes' : 'no'}.
                        {' '}Live solidified delegation query: {feeEstimate.nativeEstimation.feeSponsorResourceDelegation?.status || 'not available'}.
                      </p>
                      <p className="studio-footnote">The current delegation snapshot is a live resource-state read, not transaction authorization or proof that this proposed transfer will be fully covered. Energy is not expected for a native TRX TransferContract; total cost may differ after wallet signing and network execution.</p>
                    </div>
                  )}
                  {assetKind === 'TRC20' && feeEstimate?.success === true && feeEstimate.estimation && (
                    <div className="studio-account-summary" role="status">
                      <div className="studio-account-heading">
                        <div>
                          <p className="studio-eyebrow">Current-node estimate · {feeEstimate.network}</p>
                          <strong>Estimated Energy required: {feeEstimate.estimation.estimatedEnergyRequired ?? 'Unavailable'}</strong>
                        </div>
                        <Pill tone="warning">Not a total-fee quote</Pill>
                      </div>
                      <div className="studio-balance-grid">
                        <div className="studio-balance">
                          <span>Estimated Energy shortfall burn</span>
                          <strong>{feeEstimate.estimation.estimatedEnergyBurnTRX ?? 'Unavailable'} <small>TRX</small></strong>
                          <p>{feeEstimate.estimation.estimatedEnergyBurnSun ?? 'Unknown'} SUN at {feeEstimate.estimation.currentEnergyFeeSun ?? 'unknown'} SUN per Energy unit, based on the principal sponsor's current Energy snapshot.</p>
                        </div>
                        <div className="studio-balance">
                          <span>Principal sponsor available Energy</span>
                          <strong>{feeEstimate.estimation.principalSponsorResources?.availableEnergy ?? 'Unknown'}</strong>
                          <p>Current-node resource snapshot only.</p>
                        </div>
                        <div className="studio-balance">
                          <span>Fee sponsor's own available Energy</span>
                          <strong>{feeEstimate.estimation.feeSponsorResources?.availableEnergy ?? 'Unknown'}</strong>
                          <p>This is the fee sponsor's own resource snapshot; it is not automatically available to the principal sponsor.</p>
                        </div>
                        <div className="studio-balance">
                          <span>Live delegated Energy stake</span>
                          <strong>{feeEstimate.estimation.feeSponsorResourceDelegation?.success === true
                            ? (feeEstimate.estimation.feeSponsorResourceDelegation.activeEnergyStakeSun ?? '0') + ' SUN'
                            : 'Not verified'}</strong>
                          <p>{feeEstimate.estimation.feeSponsorResourceDelegation?.status || 'Solidified delegation query has not succeeded'}; SUN is stake-equivalent units, not Energy units.</p>
                        </div>
                        <div className="studio-balance">
                          <span>Live delegated Bandwidth stake</span>
                          <strong>{feeEstimate.estimation.feeSponsorResourceDelegation?.success === true
                            ? (feeEstimate.estimation.feeSponsorResourceDelegation.activeBandwidthStakeSun ?? '0') + ' SUN'
                            : 'Not verified'}</strong>
                          <p>Solidified current delegation between the configured fee sponsor and principal sponsor only.</p>
                        </div>
                        <div className="studio-balance">
                          <span>Bandwidth / total network fee</span>
                          <strong>Not yet estimated</strong>
                          <p>Actual total cost may differ after the signed transaction and chain execution.</p>
                        </div>
                      </div>
                      <p className="studio-inline-note" role="status">
                        Fee sponsor resources counted toward principal: {feeEstimate.estimation.feeSponsorResourcesCountedTowardPrincipalTransfer === true ? 'yes' : 'no'}.
                        {' '}Transaction audit record verified: {feeEstimate.estimation.resourceDelegationVerified === true ? 'yes' : 'no'}.
                        {' '}Live solidified delegation query: {feeEstimate.estimation.feeSponsorResourceDelegation?.status || 'not available'}.
                      </p>
                      {Array.isArray(feeEstimate.blockers) && feeEstimate.blockers.length > 0 && (
                        <div className="studio-field-block">
                          <strong>Remaining fee / submission blockers</strong>
                          <ul>
                            {feeEstimate.blockers.map((blocker) => <li key={blocker}>{blocker.replaceAll('-', ' ')}</li>)}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}

              <button type="button" className="studio-button studio-button--primary" onClick={() => void inspectReceiver()} disabled={receiverLoading || !ADDRESS_PATTERN.test(receiverAddress.trim()) || receiverAddress.trim() === senderAddress || !amountBaseUnits}>
                <ShieldCheck size={16} aria-hidden="true" /> {receiverLoading ? 'Verifying receiver…' : 'Verify receiver on selected network'}
              </button>
              {receiverError && <p className="studio-inline-error" role="alert">{receiverError}</p>}
              {receiverSnapshot && (
                <div className="studio-verified-snapshot" role="status">
                  <CheckCircle2 size={19} aria-hidden="true" />
                  <div>
                    <strong>Receiver on-chain balance · solidified {receiverSnapshot.network} state</strong>
                    <p className="studio-eyebrow">Current confirmed chain balance</p>
                    <p className="studio-card-title">{assetKind === 'TRX'
                      ? `${receiverSnapshot.balanceTRX ?? 'Unavailable'} TRX`
                      : `${formatUnits(receiverSnapshot.balanceBaseUnits, receiverSnapshot.decimals)} token units`}</p>
                    {assetKind === 'TRX'
                      ? <small>{receiverSnapshot.balanceSun ?? 'SUN value unavailable'} SUN · native TRX</small>
                      : <>
                          <small>Token contract: {receiverSnapshot.tokenContract || tokenContract.trim()}</small>
                          <small>Decimals: {receiverSnapshot.decimals} · raw base units: {receiverSnapshot.balanceBaseUnits}</small>
                        </>}
                    <small>Network: {receiverSnapshot.network}</small>
                    <small>Receiver: {receiverSnapshot.receiverAddress || receiverAddress.trim()}</small>
                    <small>Last verified: {receiverCheckedAt ? new Date(receiverCheckedAt).toLocaleString() : 'time unavailable'}</small>
                    <small>Live chain balance snapshot. A transfer is marked received only after its exact transaction and solidified transfer event are independently verified.</small>
                  </div>
                </div>
              )}
              {assetKind === 'TRC20' && (
                <section className="studio-history-panel" aria-labelledby="receiver-history-title">
                  <div className="studio-snapshot-heading">
                    <div>
                      <h3 id="receiver-history-title">Incoming TRC-20 history</h3>
                      <p>Read-only history for this receiver and exact contract on {network === 'nile' ? 'Nile' : 'Shasta'}.</p>
                    </div>
                    <button
                      type="button"
                      className="studio-button studio-button--secondary"
                      onClick={() => void loadReceiverHistory()}
                      disabled={receiverHistoryLoading || !ADDRESS_PATTERN.test(receiverAddress.trim()) || !ADDRESS_PATTERN.test(tokenContract.trim())}
                    >
                      <RefreshCw size={15} className={receiverHistoryLoading ? 'studio-spin' : ''} aria-hidden="true" />
                      {receiverHistoryLoading ? 'Loading history…' : receiverHistoryCheckedAt ? 'Refresh history' : 'Load history'}
                    </button>
                  </div>
                  <p className="studio-field-hint">A current token balance and an indexed history row are not proof that a particular transfer settled. Only rows with an independently verified solidified event are marked verified.</p>
                  {receiverHistoryError && <p className="studio-inline-error" role="alert">{receiverHistoryError}</p>}
                  {receiverHistoryNotice && <p className="studio-inline-note" role="status">{receiverHistoryNotice}</p>}
                  {receiverHistoryCheckedAt !== null && !receiverHistoryLoading && !receiverHistoryError && (
                    <p className="studio-history-summary">Checked {formatTimestamp(receiverHistoryCheckedAt)} · {receiverHistoryRecords.length} record{receiverHistoryRecords.length === 1 ? '' : 's'}</p>
                  )}
                  {receiverHistoryCheckedAt !== null && !receiverHistoryLoading && !receiverHistoryError && receiverHistoryRecords.length === 0 && (
                    <div className="studio-history-empty">
                      <Activity size={18} aria-hidden="true" />
                      <p>No incoming records were returned for this query. This result is limited to the history providers and records currently available.</p>
                    </div>
                  )}
                  {receiverHistoryRecords.length > 0 && (
                    <div className="studio-history-list" aria-label="Incoming transfer records">
                      {receiverHistoryRecords.map((record, index) => {
                        const verified = isVerifiedHistoryRecord(record)
                        const recordKey = `${record.transactionId || 'no-tx'}-${record.tokenContract || 'no-contract'}-${record.eventIndex ?? index}`
                        return (
                          <article className={`studio-history-item ${verified ? 'is-verified' : ''}`} key={recordKey}>
                            <div className="studio-history-item-heading">
                              <strong>{record.tokenSymbol || record.tokenName || 'TRC-20 token'} · {formatUnits(record.amountBaseUnits ?? undefined, record.tokenDecimals ?? undefined)}</strong>
                              <Pill tone={verified ? 'good' : 'warning'}>{verified ? 'Verified on-chain' : 'Awaiting solidified verification'}</Pill>
                            </div>
                            <p className="studio-history-meta">From: <code>{record.senderAddress || 'Sender unavailable'}</code></p>
                            <p className="studio-history-meta">Contract: <code>{record.tokenContract || tokenContract}</code></p>
                            <p className="studio-history-meta">Time: {formatHistoryTimestamp(record.timestamp)}</p>
                            <p className="studio-history-meta">Transaction: <code>{record.transactionId || 'Transaction ID unavailable'}</code>{record.eventIndex !== null && record.eventIndex !== undefined ? ` · event ${record.eventIndex}` : ''}</p>
                            {!verified && <p className="studio-history-warning">Indexer or unverified database record only. Do not treat this row as a settled receipt or spendable balance.</p>}
                            {!verified && (
                              <div className="studio-inline-actions">
                                <button
                                  type="button"
                                  className="studio-button studio-button--secondary"
                                  onClick={() => void verifyReceiverHistoryRecord(record, recordKey)}
                                  disabled={receiverHistoryVerifyingKey !== null || !/^[0-9a-fA-F]{64}$/.test(record.transactionId || '')}
                                >
                                  <ShieldCheck size={15} aria-hidden="true" />
                                  {receiverHistoryVerifyingKey === recordKey ? 'Verifying solidified receipt…' : 'Verify solidified receipt'}
                                </button>
                              </div>
                            )}
                            {receiverHistoryVerificationMessages[recordKey] && (
                              <p className="studio-inline-note" role="status">{receiverHistoryVerificationMessages[recordKey]}</p>
                            )}
                          </article>
                        )
                      })}
                    </div>
                  )}
                  {receiverHistoryPersistedAvailable === false && !receiverHistoryNotice && (
                    <p className="studio-inline-note" role="status">Verified-history storage is unavailable; indexer-only records remain unverified candidates.</p>
                  )}
                  <p className="studio-footnote">History is filtered by the exact receiver, network, and token contract. Token symbols are supplied by contract metadata and are not proof of official USDT identity or exchange deposit credit.</p>
                </section>
              )}
              <p className="studio-footnote">The requested amount cannot be reserved until a verified asset-principal sponsor, sponsor-specific authorization and transfer ledger are implemented. An on-chain transfer would not guarantee exchange credit.</p>
            </section>
          )}

          {step === 4 && (
            <section className="studio-panel" aria-labelledby="review-stage-title">
              <div className="studio-panel-heading">
                <div className="studio-panel-icon"><ShieldCheck size={20} aria-hidden="true" /></div>
                <div><p className="studio-eyebrow">Final review</p><h2 id="review-stage-title">Review the request and live sponsor gate</h2><p>All entered details have passed frontend validation and the receiver balance was read from the selected chain. Sponsor authorization is a separate requirement.</p></div>
              </div>

              <div className="studio-review-list">
                <div className="studio-review-row"><span>Network</span><strong>{network === 'nile' ? 'Nile testnet' : 'Shasta testnet'}</strong><Pill>{'Read-only testnet'}</Pill></div>
                <div className="studio-review-row"><span>Network fee sponsor</span><strong>{feeSponsorRequired ? roleLabel(roles?.roles?.networkFeeSponsor) : 'Not selected'}</strong><Pill tone={hasVerifiedFundingSnapshot(roles?.roles?.networkFeeSponsor) ? 'good' : 'warning'}>{hasVerifiedFundingSnapshot(roles?.roles?.networkFeeSponsor) ? 'Snapshot verified' : 'Not enabled'}</Pill></div>
                <div className="studio-review-row"><span>Asset principal sponsor</span><strong>{assetSponsorRequired ? roleLabel(roles?.roles?.assetPrincipalSponsor) : 'Not selected'}</strong><Pill tone={hasVerifiedFundingSnapshot(roles?.roles?.assetPrincipalSponsor) ? 'good' : 'warning'}>{hasVerifiedFundingSnapshot(roles?.roles?.assetPrincipalSponsor) ? 'Snapshot verified' : 'Not enabled'}</Pill></div>
                <div className="studio-review-row"><span>Asset / requested amount</span><strong>{amount} {assetKind === 'TRX' ? 'TRX' : 'token units'}</strong><Pill tone={amountBaseUnits ? 'good' : 'bad'}>{amountBaseUnits ? 'Valid format' : 'Invalid amount'}</Pill></div>
                {assetKind === 'TRC20' && <div className="studio-review-row"><span>TRC-20 contract</span><code>{tokenContract}</code></div>}
                <div className="studio-review-row"><span>Sender / watch wallet</span><code>{senderAddress}</code></div>
                <div className="studio-review-row"><span>Receiver</span><code>{receiverAddress}</code></div>
                <div className="studio-review-row"><span>Receiver chain snapshot</span><strong>{formatTimestamp(receiverCheckedAt)}</strong><Pill tone={receiverSnapshot ? 'good' : 'bad'}>{receiverSnapshot ? 'Read completed' : 'Not verified'}</Pill></div>
              </div>

              <div className="studio-notice studio-notice--warning">
                <LockKeyhole size={18} aria-hidden="true" />
                <div><strong>Sponsored transfer submission is blocked by the backend</strong><p>{sponsorship?.message || 'The backend has not confirmed a provider adapter, funded sponsor account, explicit signing authorization, and per-request controls. This frontend has no transfer-submission action.'}</p></div>
              </div>
              <div className="studio-inline-actions studio-review-actions">
                <button type="button" className="studio-button studio-button--secondary" onClick={() => void refreshReview()} disabled={reviewRefreshing || sponsorLoading}><RefreshCw size={15} className={reviewRefreshing || sponsorLoading ? 'studio-spin' : ''} aria-hidden="true" /> {reviewRefreshing || sponsorLoading ? 'Refreshing sponsor gate…' : 'Recheck sponsor readiness'}</button>
                <button type="button" className="studio-button studio-button--secondary" onClick={() => void copyRequestSummary()}><Copy size={15} aria-hidden="true" /> Copy request summary</button>
              </div>
              {reviewNotice && <p className="studio-inline-note" role="status">{reviewNotice}</p>}
              {copyNotice && <p className="studio-inline-note" role="status">{copyNotice}</p>}

              <div className="studio-submit-block">
                <div><strong>Transfer not available</strong><p>Request details are prepared, but no verified sponsored submission service is active. This control deliberately cannot move funds or fall back to the sender wallet.</p></div>
                <button type="button" className="studio-button studio-button--disabled" disabled aria-disabled="true"><LockKeyhole size={16} aria-hidden="true" /> Sponsored transfer unavailable</button>
              </div>
              <p className="studio-footnote">No transaction hash was created. No sender or sponsor balance was changed. The copied summary is not a transfer request stored on the server.</p>
            </section>
          )}

          <div className="studio-stage-footer">
            <div className="studio-footer-context">{stageCompletion[step] ? <><CheckCircle2 size={16} aria-hidden="true" /> Stage requirements satisfied</> : <><Activity size={16} aria-hidden="true" /> Complete the required fields and live reads to continue</>}</div>
            <div className="studio-footer-actions">
              <button type="button" className="studio-button studio-button--secondary" onClick={goBack} disabled={step === 0}><ArrowLeft size={16} aria-hidden="true" /> Back</button>
              {step < STEPS.length - 1 && <button type="button" className="studio-button studio-button--primary" onClick={goNext} disabled={!stageCompletion[step]}>{step === 3 ? 'Review request' : 'Continue'} <ArrowRight size={16} aria-hidden="true" /></button>}
            </div>
          </div>

          <footer className="studio-footer-note">
            <span><ShieldCheck size={15} aria-hidden="true" /> Read-only wallet inspection</span>
            <span><EyeOff size={15} aria-hidden="true" /> No private keys requested</span>
            <span>External sponsors must cover fees and asset principal</span>
          </footer>
        </main>
      </div>

      <nav className="studio-mobile-steps" aria-label="Mobile transfer stages">
        {STEPS.map((item, index) => (
          <button key={item.short} type="button" disabled={!canEnterStep(index)} aria-current={step === index ? 'step' : undefined} className={step === index ? 'is-current' : stageCompletion[index] ? 'is-done' : ''} onClick={() => setStep(index)}>
            <span>{stageCompletion[index] ? <Check size={14} aria-hidden="true" /> : index + 1}</span><small>{item.short}</small>
          </button>
        ))}
      </nav>
    </div>
  )
}
