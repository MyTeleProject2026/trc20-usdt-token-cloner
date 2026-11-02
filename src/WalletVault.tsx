import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Coins, Copy, Download, Eye, EyeOff, FileKey2, Home, Info, KeyRound, Landmark, LockKeyhole, LogOut, Plus, RefreshCw, Send, Settings, ShieldCheck, UserRound, Wallet, X } from 'lucide-react'
import { TronWeb } from 'tronweb'
import { estimateTRC20TransferFee, parseUnitsDecimal, verifyTransferRecordOnChain } from './wallet-transfer.mjs'
import { buildTreasuryWithdrawalAuthorizationMessage } from './treasury-withdrawal-auth.mjs'
import ThirdPartyFundingPanel from './ThirdPartyFundingPanel'
import { clearTreasuryPayoutReference, readTreasuryPayoutReference, saveTreasuryPayoutReference } from './treasury-payout-reference.mjs'
import { assertOwnerMainnetTransferAccess } from './owner-transfer-policy.mjs'
import {
  decryptWalletPrivateKey,
  encryptWalletPrivateKey,
  isEncryptedWalletRecord,
} from './wallet-vault-crypto.mjs'

type NetworkId = 'mainnet' | 'nile' | 'shasta'
type WalletRecord = {
  format: string
  version: number
  address: string
  createdAt: number
  kdf: { name: string; hash: string; iterations: number; salt: string }
  cipher: { name: string; iv: string; tagLength: number }
  ciphertext: string
}
type UnlockedWallet = { record: WalletRecord; privateKey: string }
type TokenBalance = { contract: string; symbol: string; decimals: number; balance: string; error?: string }
type Portfolio = { trx: string; tokens: TokenBalance[]; checkedAt: number }
type TokenEvidence = {
  network: NetworkId
  contractAddress: string
  onChainContractDeployed?: boolean
  onChainMetadataReadable?: boolean
  tokenName?: string
  tokenSymbol?: string
  tokenType?: string
  tokenDecimals?: number
  totalSupply?: string
  explorerStatus?: string
  sourceVerificationStatus?: string
  explorerRiskLevel?: string
  riskFeedback?: boolean
  riskTag?: string
  publicLabel?: string
  officialLabel?: string
  officialMainnetUsdtAddressMatch?: boolean
  evidenceScope?: string
  evidenceCheckedAt?: number
}
type TransferAsset = 'TRX' | 'TRC20'
type TransferStatus = 'broadcast-accepted' | 'pending-or-not-indexed' | 'included-unconfirmed' | 'confirmed' | 'failed' | 'identity-mismatch'
type TransferActivity = {
  txid: string
  network: NetworkId
  asset: TransferAsset
  symbol: string
  tokenContract: string | null
  amount: string
  amountBaseUnits: string
  decimals: number
  from: string
  to: string
  status: TransferStatus
  submittedAt: number
  verifiedOnChain?: boolean
  verificationReason?: string
  blockNumber?: number | null
  solidified?: boolean
}
type TransferReview = {
  network: NetworkId
  asset: TransferAsset
  from: string
  to: string
  amount: string
  amountBaseUnits: string
  decimals: number
  symbol: string
  tokenContract: string | null
  nativeBalance: string
  tokenBalance: string | null
  tokenEvidence: TokenEvidence | null
  feeLimitSun: number
  energyRequired: number | null
  feeEstimateSun: number | null
  createdAt: number
}

type WalletToast = { id: number; kind: 'success' | 'error' | 'info'; message: string }

type OwnerTreasurySnapshot = {
  success?: boolean
  ownerAccessVerified?: boolean
  status?: string
  network?: string
  onChainBalanceRead?: boolean
  treasuryAddress?: string
  checkedAt?: string
  native?: { status?: string; balanceTRX?: string }
  officialUsdt?: { status?: string; tokenContract?: string; balanceBaseUnits?: string; decimals?: number }
  canSubmitSponsoredTransfer?: boolean
  submissionEnabled?: boolean
}

type FireblocksInventorySnapshot = {
  id?: string | null
  workflowRunId?: string | null
  workflowRunAttempt?: number | null
  commitSha?: string | null
  verificationStatus?: 'verified' | 'blocked' | 'unknown'
  checkedAt?: string | null
  workflowRunUrl?: string | null
  configuration?: {
    apiBase?: string | null
    vaultAccountId?: string | null
    usdtAssetId?: string | null
    trxAssetId?: string | null
    treasuryAddress?: string | null
    usdtContract?: string | null
  } | null
  checks?: Record<string, boolean | null>
  balances?: {
    fireblocksUsdtAvailableBaseUnits?: string | null
    chainUsdtBalanceBaseUnits?: string | null
    fireblocksTrxAvailableBaseUnits?: string | null
    chainTrxBalanceSun?: string | null
  } | null
  reasons?: string[]
}

type FireblocksDiscoverySnapshot = {
  success?: boolean
  discoveryStatus?: 'credentials-required' | 'single-unambiguous-candidate' | 'review-required' | 'partial'
  checkedAt?: string
  configuration?: {
    apiBase?: string
    credentialsConfigured?: boolean
    credentialsMissing?: string[]
    vaultAccountIdConfigured?: boolean
    usdtAssetIdConfigured?: boolean
    trxAssetIdConfigured?: boolean
  }
  officialUsdtAssets?: Array<{ id: string; symbol: 'USDT'; contractAddress: string; decimals: 6; name?: string | null }>
  nativeTrxAssets?: Array<{ id: string; symbol: 'TRX'; decimals: 6; name?: string | null }>
  candidateVaults?: Array<{
    vaultAccountId: string
    name?: string | null
    officialUsdtAssetIds: string[]
    nativeTrxAssetIds: string[]
    candidate: boolean
    unambiguousAddressPair?: boolean
    treasuryAddressCandidate?: string
    suggestedUsdtAssetId?: string
    suggestedTrxAssetId?: string
  }>
  suggestedConfiguration?: {
    vaultAccountId: string
    usdtAssetId: string
    trxAssetId: string
    treasuryAddress: string
  } | null
  discoveryTruncated?: boolean
  note?: string
}

const TRANSFER_HISTORY_KEY = 'tron-token-studio:real-transfer-history:v1'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const VAULT_KEY = 'tron-token-studio:encrypted-wallet-vault:v1'
const OWNER_CONSOLE_SESSION_KEY = 'tron-token-studio:owner-session:v1'
const TOKEN_WATCH_KEY = 'tron-token-studio:token-watchlist:v1'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const PRIVATE_KEY_PATTERN = /^(?:0x)?[0-9a-f]{64}$/i
const RPC: Record<NetworkId, string> = {
  mainnet: 'https://api.trongrid.io',
  nile: 'https://nile.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
}
const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TOKEN_ABI = [
  { constant: true, inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'symbol', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'name', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'totalSupply', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
]

function createTronWeb(network: NetworkId, privateKey?: string): any {
  return new TronWeb({ fullHost: RPC[network], ...(privateKey ? { privateKey } : {}) } as any) as any
}

function readWalletRecords(): WalletRecord[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VAULT_KEY) || '{}')
    if (parsed?.version !== 1 || !Array.isArray(parsed.wallets)) return []
    return parsed.wallets.filter(isEncryptedWalletRecord) as WalletRecord[]
  } catch {
    return []
  }
}

function readTokenWatchlist(network: NetworkId): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TOKEN_WATCH_KEY) || '{}')
    const values = parsed?.[network]
    return Array.isArray(values)
      ? [...new Set(values.filter((item: unknown) => typeof item === 'string' && ADDRESS_PATTERN.test(item)))]
      : []
  } catch {
    return []
  }
}

function readTransferHistory(): TransferActivity[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TRANSFER_HISTORY_KEY) || '{}')
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) return []
    return parsed.items.filter((item: any): item is TransferActivity =>
      item && typeof item === 'object'
      && /^[0-9a-f]{64}$/i.test(String(item.txid || ''))
      && ['mainnet', 'nile', 'shasta'].includes(item.network)
      && ['TRX', 'TRC20'].includes(item.asset)
      && typeof item.from === 'string' && ADDRESS_PATTERN.test(item.from)
      && typeof item.to === 'string' && ADDRESS_PATTERN.test(item.to)
      && typeof item.amountBaseUnits === 'string' && /^[1-9][0-9]{0,77}$/.test(item.amountBaseUnits)
      && Number.isInteger(item.decimals) && item.decimals >= 0 && item.decimals <= 36
      && Number.isFinite(item.submittedAt)
      && (item.asset === 'TRX' || (typeof item.tokenContract === 'string' && ADDRESS_PATTERN.test(item.tokenContract)))
    ).slice(0, 100).map((item: TransferActivity) => ({
      ...item,
      // localStorage is editable and cannot prove that the saved status or display
      // metadata matches the blockchain. Reverify each record after every reload.
      status: 'pending-or-not-indexed' as TransferStatus,
      verifiedOnChain: false,
      verificationReason: 'local-storage-not-verified',
      blockNumber: null,
      solidified: false,
      amount: formatUnits(item.amountBaseUnits, item.asset === 'TRX' ? 6 : item.decimals),
      symbol: item.asset === 'TRX' ? 'TRX' : 'TRC20',
    }))
  } catch {
    return []
  }
}

function saveTransferHistory(items: TransferActivity[]): boolean {
  try {
    window.localStorage.setItem(TRANSFER_HISTORY_KEY, JSON.stringify({ version: 1, items: items.slice(0, 100) }))
    return true
  } catch {
    // A private-mode/quota failure must never make an already-broadcast transfer
    // look like it failed or encourage the user to submit it again.
    return false
  }
}

function formatUnits(value: unknown, decimals: number): string {
  try {
    const units = BigInt(String(value))
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return units.toString()
    const scale = 10n ** BigInt(decimals)
    const whole = units / scale
    const remainder = units % scale
    if (remainder === 0n || decimals === 0) return whole.toString()
    const fraction = remainder.toString().padStart(decimals, '0').replace(/0+$/, '')
    return whole.toString() + '.' + fraction
  } catch {
    return String(value ?? '0')
  }
}

function explorerUrl(network: NetworkId, address: string): string {
  const host = network === 'mainnet' ? 'https://tronscan.org' : network === 'nile' ? 'https://nile.tronscan.org' : 'https://shasta.tronscan.org'
  return host + '/#/address/' + encodeURIComponent(address)
}

function explorerTransactionUrl(network: NetworkId, txid: string): string {
  const host = network === 'mainnet' ? 'https://tronscan.org' : network === 'nile' ? 'https://nile.tronscan.org' : 'https://shasta.tronscan.org'
  return host + '/#/transaction/' + encodeURIComponent(txid)
}

function tokenEvidenceLabel(evidence?: TokenEvidence): string {
  if (!evidence) return 'Not checked'
  if (evidence.explorerRiskLevel === 'unsafe' || evidence.explorerRiskLevel === 'suspicious' || evidence.riskFeedback || Boolean(evidence.riskTag?.trim())) return 'Explorer risk warning'
  if (evidence.officialMainnetUsdtAddressMatch) return 'Official Mainnet USDT address match'
  if (evidence.sourceVerificationStatus === 'fully-verified-source') return 'TronScan source fully verified'
  if (evidence.sourceVerificationStatus === 'partially-verified-source') return 'TronScan source partially verified'
  if (evidence.sourceVerificationStatus === 'unverified-source') return 'TronScan source not verified'
  if (evidence.onChainContractDeployed && evidence.onChainMetadataReadable) return 'On-chain TRC-20 methods readable; issuer not verified'
  return 'Evidence unavailable'
}

function shortenAddress(address: string): string {
  return address.length > 16 ? address.slice(0, 8) + '…' + address.slice(-6) : address
}

function hasPositiveBaseUnits(value: unknown): boolean {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return false
  try { return BigInt(value) > 0n } catch { return false }
}

export default function WalletVault() {
  const [records, setRecords] = useState<WalletRecord[]>(readWalletRecords)
  const [selectedAddress, setSelectedAddress] = useState(() => readWalletRecords()[0]?.address || '')
  const [unlocked, setUnlocked] = useState<UnlockedWallet | null>(null)
  const [network, setNetwork] = useState<NetworkId>('nile')
  const [activePanel, setActivePanel] = useState<'dashboard' | 'wallet' | 'treasury' | 'send' | 'activity' | 'account' | 'settings'>('dashboard')
  const [mode, setMode] = useState<'create' | 'import-key' | 'restore-backup'>('create')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [privateKeyInput, setPrivateKeyInput] = useState('')
  const [backupText, setBackupText] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [tokenContracts, setTokenContracts] = useState<string[]>(() => readTokenWatchlist('nile'))
  const [selectedTokenContract, setSelectedTokenContract] = useState('')
  const [tokenEvidence, setTokenEvidence] = useState<Record<string, TokenEvidence>>({})
  const [evidenceLoading, setEvidenceLoading] = useState('')
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [transferAsset, setTransferAsset] = useState<TransferAsset>('TRX')
  const [recipientInput, setRecipientInput] = useState('')
  const [amountInput, setAmountInput] = useState('')
  const [feeLimitTRX, setFeeLimitTRX] = useState('50')
  const [transferReview, setTransferReview] = useState<TransferReview | null>(null)
  const [transferAcknowledged, setTransferAcknowledged] = useState(false)
  const [mainnetSendPhrase, setMainnetSendPhrase] = useState('')
  const [transferHistory, setTransferHistory] = useState<TransferActivity[]>(readTransferHistory)
  const [historyLoading, setHistoryLoading] = useState('')
  const [ownerTreasurySnapshot, setOwnerTreasurySnapshot] = useState<OwnerTreasurySnapshot | null>(null)
  const [ownerTreasuryLoading, setOwnerTreasuryLoading] = useState(false)
  const [ownerTreasuryError, setOwnerTreasuryError] = useState('')
  const [ownerSessionToken, setOwnerSessionToken] = useState<string>(() => {
    // Restore the tab-scoped owner session into React state on page reload.
    // The backend still validates the token and expiry before serving any data.
    try {
      const token = window.sessionStorage.getItem(OWNER_CONSOLE_SESSION_KEY) || ''
      return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : ''
    } catch {
      return ''
    }
  })
  const [ownerTreasuryRefreshNonce, setOwnerTreasuryRefreshNonce] = useState(0)
  const [ownerSessionAddress, setOwnerSessionAddress] = useState('')
  const [serverTreasuryReadiness, setServerTreasuryReadiness] = useState<any>(null)
  const [fireblocksInventorySnapshot, setFireblocksInventorySnapshot] = useState<FireblocksInventorySnapshot | null>(null)
  const [fireblocksInventoryError, setFireblocksInventoryError] = useState('')
  const [fireblocksDiscoverySnapshot, setFireblocksDiscoverySnapshot] = useState<FireblocksDiscoverySnapshot | null>(null)
  const [fireblocksDiscoveryError, setFireblocksDiscoveryError] = useState('')
  const [fireblocksOutboundHistorySnapshot, setFireblocksOutboundHistorySnapshot] = useState<any>(null)
  const [fireblocksOutboundHistoryBusy, setFireblocksOutboundHistoryBusy] = useState(false)
  const [fireblocksOutboundHistoryError, setFireblocksOutboundHistoryError] = useState('')
  const [treasuryPayoutRecipient, setTreasuryPayoutRecipient] = useState('')
  const [treasuryPayoutAmount, setTreasuryPayoutAmount] = useState('')
  const [treasuryPayoutConfirm, setTreasuryPayoutConfirm] = useState('')
  const [treasuryPayoutBusy, setTreasuryPayoutBusy] = useState(false)
  const [treasuryPayoutStatus, setTreasuryPayoutStatus] = useState<any>(null)
  const [treasuryPayoutError, setTreasuryPayoutError] = useState('')
  const [sponsorRecipientAddress, setSponsorRecipientAddress] = useState('')
  const [sponsorRecipientReason, setSponsorRecipientReason] = useState('')
  const [sponsorRecipientRequestId, setSponsorRecipientRequestId] = useState('')
  const [sponsorRecipientRequest, setSponsorRecipientRequest] = useState<any>(null)
  const [sponsorRecipientSignature, setSponsorRecipientSignature] = useState('')
  const [sponsorRecipientBusy, setSponsorRecipientBusy] = useState(false)
  const [sponsorRecipientError, setSponsorRecipientError] = useState('')
  const [treasuryReleaseMessage, setTreasuryReleaseMessage] = useState('')
  const [treasuryReleaseSignature, setTreasuryReleaseSignature] = useState('')
  const [treasuryReleaseAction, setTreasuryReleaseAction] = useState<'approve' | 'revoke'>('approve')
  const [treasuryReleaseBusy, setTreasuryReleaseBusy] = useState(false)
  const [treasuryReleaseError, setTreasuryReleaseError] = useState('')
  const [busy, setBusy] = useState(false)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [transferInProgress, setTransferInProgress] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [toast, setToast] = useState<WalletToast | null>(null)
  const toastSequence = useRef(0)
  const [showPassword, setShowPassword] = useState(false)
  const [apiHealthStatus, setApiHealthStatus] = useState<'checking' | 'online' | 'offline'>('checking')
  const [apiHealthCheckedAt, setApiHealthCheckedAt] = useState<number | null>(null)
  const [apiHealthLoading, setApiHealthLoading] = useState(false)
  const [apiHealthError, setApiHealthError] = useState('')
  const selectedRecord = useMemo(() => records.find(item => item.address === selectedAddress) || null, [records, selectedAddress])
  const serverTreasuryBalanceBaseUnits = serverTreasuryReadiness?.treasuryUsdtBalanceBaseUnits
  const serverTreasuryHasFunds = typeof serverTreasuryBalanceBaseUnits === 'string'
    && /^(0|[1-9][0-9]*)$/.test(serverTreasuryBalanceBaseUnits)
    && BigInt(serverTreasuryBalanceBaseUnits) > 0n
  const sponsorPlanningTargetBaseUnits = 100_000_000_000n
  const verifiedSponsorFundingBaseUnits = serverTreasuryReadiness?.spendableUsdtBaseUnits
  const sponsorPlanningFundingGapBaseUnits = typeof verifiedSponsorFundingBaseUnits === 'string'
    && /^(0|[1-9][0-9]*)$/.test(verifiedSponsorFundingBaseUnits)
    ? (sponsorPlanningTargetBaseUnits > BigInt(verifiedSponsorFundingBaseUnits)
      ? sponsorPlanningTargetBaseUnits - BigInt(verifiedSponsorFundingBaseUnits) : 0n).toString()
    : null
  const serverTreasuryAddressMatchesSnapshot = typeof serverTreasuryReadiness?.treasuryAddress === 'string'
    && typeof ownerTreasurySnapshot?.treasuryAddress === 'string'
    && serverTreasuryReadiness.treasuryAddress === ownerTreasurySnapshot.treasuryAddress
  const sponsorPrincipalBudgetRemaining = serverTreasuryReadiness?.sponsorPrincipalBudget?.remainingBaseUnits
  const canSubmitServerTreasuryPayout = Boolean(ownerSessionToken
    && ownerSessionAddress
    && unlocked?.record.address === ownerSessionAddress
    && network === 'mainnet'
    && ownerTreasurySnapshot?.ownerAccessVerified === true
    && serverTreasuryReadiness?.network === 'mainnet'
    && serverTreasuryReadiness?.tokenContract === OFFICIAL_MAINNET_USDT
    && serverTreasuryReadiness?.payoutsPreflightReady === true
    && serverTreasuryReadiness?.releaseAuthorization?.authorized === true
    && serverTreasuryReadiness?.withdrawalsEnabled === true
    && serverTreasuryReadiness?.executionEnabled === true
    && serverTreasuryReadiness?.sponsorPrincipalBudget?.withinBudget === true
    && serverTreasuryReadiness?.sponsorPrincipalBudget?.commitmentCapConsistent === true
    && typeof sponsorPrincipalBudgetRemaining === 'string'
    && /^(0|[1-9][0-9]*)$/.test(sponsorPrincipalBudgetRemaining)
    && BigInt(sponsorPrincipalBudgetRemaining) > 0n
    && serverTreasuryAddressMatchesSnapshot
    && serverTreasuryHasFunds)
  const sponsorConfig = serverTreasuryReadiness?.configuration
  const sponsorBudget = serverTreasuryReadiness?.sponsorPrincipalBudget
  const sponsorOrganizationReferencePresent = typeof sponsorBudget?.organizationReference === 'string' && sponsorBudget.organizationReference.trim().length > 0
  const sponsorAgreementReferencePresent = typeof sponsorBudget?.agreementReference === 'string' && sponsorBudget.agreementReference.trim().length > 0
  const fireblocksReadOnlyIdentityReady = fireblocksDiscoverySnapshot?.configuration?.credentialsConfigured === true
  const fireblocksAssetIdentityReady = serverTreasuryReadiness?.providerAssetIdentityVerified === true
    && serverTreasuryReadiness?.nativeTrxAssetIdentityVerified === true
  const fireblocksVaultAddressReady = serverTreasuryReadiness?.providerVaultAddressVerified === true
    && serverTreasuryReadiness?.nativeTrxVaultAddressVerified === true
  const sponsorRecipientPolicyReady = sponsorConfig?.recipientAllowlistValid === true
    || (sponsorConfig?.recipientApprovalMode === 'sponsor-signed'
      && Number(sponsorConfig?.sponsorApproverCount || 0) > 0)
    || (sponsorConfig?.recipientApprovalMode === 'mixed'
      && Number(sponsorConfig?.sponsorApproverCount || 0) > 0)
  const sponsorBudgetReady = sponsorBudget?.withinBudget === true
    && sponsorBudget?.commitmentCapConsistent === true
    && hasPositiveBaseUnits(sponsorBudgetRemaining)
  const sponsorPrincipalReady = serverTreasuryHasFunds
    && hasPositiveBaseUnits(serverTreasuryReadiness?.providerAvailableUsdtBaseUnits)
  const sponsorFeeReady = serverTreasuryReadiness?.networkFeeCapCovered === true
    && serverTreasuryReadiness?.feeReserveCovered === true
    && hasPositiveBaseUnits(serverTreasuryReadiness?.providerAvailableTrxBaseUnits)
  const sponsorHistoryReady = fireblocksOutboundHistorySnapshot?.verified === true
  const sponsorReleaseReady = serverTreasuryReadiness?.releaseAuthorization?.authorized === true
  const treasuryDatabaseReady = serverTreasuryReadiness?.databaseReady === true
  const treasuryPayoutCurrentStatus = treasuryPayoutStatus?.withdrawal?.status || treasuryPayoutStatus?.status || ''
  const treasuryPayoutInFlight = ['broadcasting', 'provider-pending', 'broadcast-accepted', 'broadcast-unknown', 'submission-outcome-unknown'].includes(treasuryPayoutCurrentStatus)
  const ownerAddressForHeader = ownerSessionAddress || unlocked?.record.address || selectedAddress || ''
  const monitoredTreasuryAddress = ownerTreasurySnapshot?.treasuryAddress || serverTreasuryReadiness?.treasuryAddress || ''
  const headerTreasuryUsdt = ownerTreasurySnapshot?.officialUsdt?.status === 'verified'
    && typeof ownerTreasurySnapshot.officialUsdt.balanceBaseUnits === 'string'
    && /^(0|[1-9][0-9]*)$/.test(ownerTreasurySnapshot.officialUsdt.balanceBaseUnits)
    ? formatUnits(ownerTreasurySnapshot.officialUsdt.balanceBaseUnits, 6)
    : typeof serverTreasuryReadiness?.treasuryUsdtBalanceBaseUnits === 'string'
      && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.treasuryUsdtBalanceBaseUnits)
      ? formatUnits(serverTreasuryReadiness.treasuryUsdtBalanceBaseUnits, 6) : 'Not verified'
  const headerTreasuryTrx = ownerTreasurySnapshot?.native?.status === 'verified'
    && typeof ownerTreasurySnapshot.native.balanceTRX === 'string'
    && /^(0|[1-9][0-9]*(?:\.[0-9]+)?)$/.test(ownerTreasurySnapshot.native.balanceTRX)
    ? ownerTreasurySnapshot.native.balanceTRX
    : typeof serverTreasuryReadiness?.treasuryTrxBalanceSun === 'string'
      && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.treasuryTrxBalanceSun)
      ? formatUnits(serverTreasuryReadiness.treasuryTrxBalanceSun, 6) : 'Not verified'
  const ownerHeaderBalance = !unlocked ? 'Locked' : network !== 'mainnet' ? 'Select Mainnet' : 'Refresh in Assets'
  const ownerHeaderTrx = unlocked && network === 'mainnet' && portfolio ? portfolio.trx + ' TRX' : ownerHeaderBalance
  const officialOwnerUsdt = network === 'mainnet' ? portfolio?.tokens.find(token => token.contract === OFFICIAL_MAINNET_USDT && !token.error)?.balance : undefined
  const ownerHeaderUsdt = unlocked && network === 'mainnet' ? (officialOwnerUsdt !== undefined ? officialOwnerUsdt + ' USDT' : portfolio ? 'Not in Assets' : ownerHeaderBalance) : ownerHeaderBalance

  function pushToast(kind: WalletToast['kind'], message: string) {
    const clean = String(message || '').trim()
    if (!clean) return
    setToast({ id: ++toastSequence.current, kind, message: clean })
  }

  function noticeKind(message: string): WalletToast['kind'] {
    // Pending/ambiguous chain states are never presented as completed actions.
    if (/(pending|not indexed|not yet solidified|unresolved|not confirmed|receipt.{0,40}(unavailable|pending)|broadcast|submitted|accepted|reserved|nothing (?:has been sent|was signed)|no transaction has been sent|cancelled|network changed|checking|reading chain|open account|selected|review the|requires?|needs? real|does not guarantee|watch-only)/i.test(message)) return 'info'
    if (/(could not|failed|failure|invalid|blocked|insufficient|does not match|mismatch|not authorized|not configured|unavailable|expired|not verified|error)/i.test(message)) return 'error'
    if (/(wallet encrypted and saved|encrypted backup restored|wallet unlocked|wallet locked|encrypted wallet backup exported|contract checks completed|verified on TRON|live chain checks passed|public wallet address copied|backup loaded locally|verified from the selected network)/i.test(message)) return 'success'
    return 'info'
  }

  useEffect(() => {
    if (error) pushToast('error', error)
  }, [error])

  useEffect(() => {
    if (notice) pushToast(noticeKind(notice), notice)
  }, [notice])

  useEffect(() => {
    if (ownerTreasuryError) pushToast('error', ownerTreasuryError)
  }, [ownerTreasuryError])

  useEffect(() => {
    if (treasuryPayoutError) pushToast('error', treasuryPayoutError)
  }, [treasuryPayoutError])

  useEffect(() => {
    if (apiHealthError) pushToast('error', apiHealthError)
  }, [apiHealthError])

  useEffect(() => {
    if (!toast) return
    const timeoutId = window.setTimeout(() => {
      setToast(current => current?.id === toast.id ? null : current)
    }, toast.kind === 'error' ? 6500 : 4200)
    return () => window.clearTimeout(timeoutId)
  }, [toast])

  async function checkApiHealth() {
    setApiHealthLoading(true)
    setApiHealthStatus('checking')
    setApiHealthError('')
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(API_BASE + '/health', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.status !== 'ok' || payload?.service !== 'tron-token-studio-api') {
        throw new Error('The API did not return its expected health contract.')
      }
      setApiHealthStatus('online')
    } catch {
      setApiHealthStatus('offline')
      setApiHealthError('The API health check failed. Check connectivity and the frontend origin configuration.')
    } finally {
      window.clearTimeout(timeoutId)
      setApiHealthCheckedAt(Date.now())
      setApiHealthLoading(false)
    }
  }

  useEffect(() => {
    void checkApiHealth()
  }, [])

  useEffect(() => {
    const contracts = readTokenWatchlist(network)
    setTokenContracts(contracts)
    setSelectedTokenContract(current => contracts.includes(current) ? current : (contracts[0] || ''))
    setPortfolio(null)
    setTransferReview(null)
    setTransferAcknowledged(false)
    setMainnetSendPhrase('')
    setOwnerSessionToken('')
    try { window.sessionStorage.removeItem(OWNER_CONSOLE_SESSION_KEY) } catch {}
    setOwnerTreasurySnapshot(null)
    setServerTreasuryReadiness(null)
    setTreasuryPayoutConfirm('')
    setOwnerTreasuryError('')
    setTreasuryPayoutError('')
    setSponsorRecipientRequest(null)
    setSponsorRecipientRequestId('')
    setSponsorRecipientSignature('')
    setSponsorRecipientError('')
    setTreasuryReleaseMessage('')
    setTreasuryReleaseSignature('')
    setTreasuryReleaseAction('approve')
    setTreasuryReleaseError('')
  }, [network])

  // A reusable owner bearer session must not survive a lock or wallet switch.
  // The only persisted payout data is a non-secret reference, restored only for
  // the matching unlocked owner so an ambiguous request can be safely looked up.
  useEffect(() => {
    setOwnerSessionToken('')
    try { window.sessionStorage.removeItem(OWNER_CONSOLE_SESSION_KEY) } catch {}
    setOwnerTreasurySnapshot(null)
    setServerTreasuryReadiness(null)
    setTreasuryPayoutConfirm('')
    setOwnerTreasuryError('')
    setTreasuryPayoutError('')
    setSponsorRecipientRequest(null)
    setSponsorRecipientRequestId('')
    setSponsorRecipientSignature('')
    setSponsorRecipientError('')
    setTreasuryReleaseMessage('')
    setTreasuryReleaseSignature('')
    setTreasuryReleaseAction('approve')
    setTreasuryReleaseError('')
    const savedReference = unlocked?.record.address
      ? readTreasuryPayoutReference()
      : null
    if (savedReference && savedReference.ownerAddress === unlocked?.record.address) {
      setTreasuryPayoutStatus({
        status: 'submission-outcome-unknown',
        idempotencyKey: savedReference.idempotencyKey,
        ownerAddress: savedReference.ownerAddress,
        note: 'Saved request reference only. Re-authenticate the owner and verify this same request key from the backend and TRON chain before starting another payout.',
      })
    } else {
      setTreasuryPayoutStatus(null)
    }
  }, [unlocked?.record.address])

  // Load read-only Mainnet treasury status from the private owner-console login.
  // Outgoing payouts still require a separate, request-specific signature from
  // the owner wallet held inside this app; the console password does not mint assets.
  useEffect(() => {
    // Prefer the in-memory authenticated token; sessionStorage is only a
    // convenience for page refreshes and may be unavailable in restricted contexts.
    let token = ownerSessionToken
    try {
      token = token || window.sessionStorage.getItem(OWNER_CONSOLE_SESSION_KEY) || ''
    } catch {
      // Keep the in-memory session token when browser storage is unavailable.
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return

    let cancelled = false
    let requestInFlight = false
    async function loadOwnerTreasuryDashboard() {
      if (requestInFlight || cancelled) return
      requestInFlight = true
      setOwnerTreasuryLoading(true)
      setOwnerTreasuryError('')
      try {
        const sessionResponse = await fetch(API_BASE + '/api/auth/owner/session', {
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        })
        const sessionPayload = await sessionResponse.json().catch(() => null)
        if (!sessionResponse.ok || sessionPayload?.success !== true
          || sessionPayload?.authenticated !== true || sessionPayload.network !== 'mainnet'
          || !ADDRESS_PATTERN.test(String(sessionPayload.address || ''))
          || !Number.isFinite(sessionPayload.expiresAt) || sessionPayload.expiresAt <= Date.now()) {
          throw new Error('The owner-console session is no longer valid. Sign in again to load treasury status.')
        }

        if (!cancelled) {
          setOwnerSessionAddress(String(sessionPayload.address))
          setOwnerSessionToken(token)
        }
        const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token }
        const [fundingResponse, readinessResponse, inventoryResponse, discoveryResponse, outboundHistoryResponse] = await Promise.all([
          fetch(API_BASE + '/api/treasury/owner/funding-status?network=mainnet', {
            headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
          }),
          fetch(API_BASE + '/api/treasury/withdrawals/readiness', {
            headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
          }),
          fetch(API_BASE + '/api/treasury/fireblocks/inventory/latest', {
            headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
          }),
          fetch(API_BASE + '/api/treasury/fireblocks/discovery', {
            headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
          }),
          fetch(API_BASE + '/api/treasury/fireblocks/outbound-history/status', {
            headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
          }),
        ])
        const [funding, readiness, inventory, discovery, outboundHistory] = await Promise.all([
          fundingResponse.json().catch(() => null),
          readinessResponse.json().catch(() => null),
          inventoryResponse.json().catch(() => null),
          discoveryResponse.json().catch(() => null),
          outboundHistoryResponse.json().catch(() => null),
        ])
        if (cancelled) return
        if (fundingResponse.ok && funding?.success === true && funding?.ownerAccessVerified === true) {
          setOwnerTreasurySnapshot(funding as OwnerTreasurySnapshot)
        } else {
          setOwnerTreasurySnapshot(null)
        }
        setServerTreasuryReadiness(readiness && typeof readiness === 'object' ? readiness : null)
        if (inventoryResponse.ok && inventory?.success === true) {
          setFireblocksInventorySnapshot(inventory.snapshot && typeof inventory.snapshot === 'object'
            ? inventory.snapshot as FireblocksInventorySnapshot : null)
          setFireblocksInventoryError('')
        } else {
          setFireblocksInventorySnapshot(null)
          setFireblocksInventoryError('The latest saved Fireblocks inventory evidence could not be loaded.')
        }
        if (discoveryResponse.ok && discovery?.success === true) {
          setFireblocksDiscoverySnapshot(discovery as FireblocksDiscoverySnapshot)
          setFireblocksDiscoveryError('')
        } else {
          setFireblocksDiscoverySnapshot(null)
          setFireblocksDiscoveryError('Live Fireblocks auto-discovery is unavailable. Check the owner session and backend API credentials status.')
        }
        if (outboundHistoryResponse.ok && outboundHistory?.success === true) {
          setFireblocksOutboundHistorySnapshot(outboundHistory)
          setFireblocksOutboundHistoryError('')
        } else {
          setFireblocksOutboundHistorySnapshot(outboundHistory && typeof outboundHistory === 'object' ? outboundHistory : null)
          setFireblocksOutboundHistoryError('Fireblocks outbound history status is unavailable. Payout readiness remains blocked.')
        }
        if (!fundingResponse.ok || funding?.success !== true) {
          setOwnerTreasuryError('Owner login is valid, but a verified treasury funding snapshot is unavailable. Check the configured owner and treasury addresses and backend provider status.')
        }
      } catch (caught) {
        if (cancelled) return
        setOwnerSessionAddress('')
        setOwnerTreasurySnapshot(null)
        setServerTreasuryReadiness(null)
        setFireblocksInventorySnapshot(null)
        setFireblocksInventoryError('The owner-only Fireblocks inventory status is unavailable.')
        setFireblocksDiscoverySnapshot(null)
        setFireblocksDiscoveryError('The owner-only Fireblocks discovery status is unavailable.')
        setFireblocksOutboundHistorySnapshot(null)
        setFireblocksOutboundHistoryError('The owner-only Fireblocks outbound history status is unavailable.')
        setOwnerTreasuryError(caught instanceof Error
          ? caught.message
          : 'Could not automatically load the Mainnet treasury status from the owner session.')
      } finally {
        requestInFlight = false
        if (!cancelled) setOwnerTreasuryLoading(false)
      }
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadOwnerTreasuryDashboard()
    }
    void loadOwnerTreasuryDashboard()
    // Refresh the backend-managed configuration/readiness snapshot on a timer,
    // immediately when the user returns to the tab, and when the app regains
    // focus. Never overlap requests or run background polls in a hidden tab.
    const refreshInterval = window.setInterval(refreshWhenVisible, 30_000)
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      cancelled = true
      window.clearInterval(refreshInterval)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [unlocked?.record.address, network, ownerSessionToken, ownerTreasuryRefreshNonce])


  useEffect(() => {
    if (!unlocked) return
    let timeout = 0
    const autoLock = () => {
      setActivePanel('dashboard')
      setUnlocked(null)
      setPortfolio(null)
      setTransferReview(null)
      setTransferAcknowledged(false)
      setMainnetSendPhrase('')
      setPassword('')
      setConfirmPassword('')
      setNotice('Wallet auto-locked after inactivity or when the app moved to the background. Unlock it again to continue.')
    }
    const resetTimer = () => {
      if (timeout) window.clearTimeout(timeout)
      timeout = window.setTimeout(autoLock, 5 * 60 * 1000)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') autoLock()
    }
    const activityEvents = ['pointerdown', 'keydown', 'touchstart']
    activityEvents.forEach(name => window.addEventListener(name, resetTimer, { passive: true }))
    document.addEventListener('visibilitychange', onVisibilityChange)
    resetTimer()
    return () => {
      if (timeout) window.clearTimeout(timeout)
      activityEvents.forEach(name => window.removeEventListener(name, resetTimer))
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [unlocked])

  useEffect(() => {
    if (!unlocked) {
      setPortfolio(null)
      setBalanceLoading(false)
      return
    }
    let cancelled = false
    const load = async () => {
      setBalanceLoading(true)
      setError('')
      const web = createTronWeb(network)
      try {
        const sun = await web.trx.getBalance(unlocked.record.address)
        const trx = formatUnits(String(sun), 6)
        const tokens = await Promise.all(tokenContracts.map(async contractAddress => {
          try {
            if (!web.isAddress(contractAddress)) throw new Error('Invalid TRON contract address')
            const contract = await web.contract(TOKEN_ABI, contractAddress)
            const [rawBalance, rawDecimals, rawSymbol] = await Promise.all([
              contract.balanceOf(unlocked.record.address).call(),
              contract.decimals().call(),
              contract.symbol().call().catch(() => 'TRC20'),
            ])
            const decimals = Number(String(rawDecimals))
            const symbol = String(rawSymbol || 'TRC20').slice(0, 32)
            return {
              contract: contractAddress,
              symbol,
              decimals,
              balance: formatUnits(rawBalance, decimals),
            } satisfies TokenBalance
          } catch {
            return { contract: contractAddress, symbol: 'Token', decimals: 0, balance: 'Unavailable', error: 'Balance or token metadata could not be read from this network.' } satisfies TokenBalance
          }
        }))
        if (!cancelled) setPortfolio({ trx, tokens, checkedAt: Date.now() })
      } catch {
        if (!cancelled) {
          setPortfolio(null)
          setError('Could not read this wallet from the selected TRON network. Check the connection or try again.')
        }
      } finally {
        if (!cancelled) setBalanceLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [unlocked, network, tokenContracts, refreshNonce])

  function saveRecord(record: WalletRecord) {
    const next = [...records.filter(item => item.address !== record.address), record]
    window.localStorage.setItem(VAULT_KEY, JSON.stringify({ version: 1, wallets: next }))
    setRecords(next)
    setSelectedAddress(record.address)
    return next
  }

  async function protectAndSave(privateKey: string, address: string, chosenPassword: string) {
    const record = await encryptWalletPrivateKey(privateKey, address, chosenPassword) as WalletRecord
    saveRecord(record)
    setUnlocked({ record, privateKey: privateKey.replace(/^0x/i, '').toLowerCase() })
    setPassword('')
    setConfirmPassword('')
    setPrivateKeyInput('')
    setBackupText('')
    setNotice('Wallet encrypted and saved on this device. Download an encrypted backup before relying on this installation.')
    setError('')
  }

  async function createWallet() {
    if (password.length < 12 || password.length > 128) throw new Error('Use a wallet password between 12 and 128 characters.')
    if (password !== confirmPassword) throw new Error('The password confirmation does not match.')
    const web = createTronWeb(network)
    const account = await web.createAccount()
    if (!account || !PRIVATE_KEY_PATTERN.test(String(account.privateKey || '')) || !ADDRESS_PATTERN.test(String(account.address?.base58 || ''))) {
      throw new Error('The wallet SDK did not return a valid local account. Nothing was saved.')
    }
    await protectAndSave(String(account.privateKey), String(account.address.base58), password)
  }

  async function importPrivateKey() {
    if (password.length < 12) throw new Error('Use a wallet password with at least 12 characters.')
    if (password !== confirmPassword) throw new Error('The password confirmation does not match.')
    const key = privateKeyInput.trim().replace(/^0x/i, '')
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('Enter a 64-character hexadecimal private key. It stays in this device and is never sent to the backend.')
    const web = createTronWeb(network, key)
    const address = String(web.defaultAddress?.base58 || '')
    if (!ADDRESS_PATTERN.test(address) || !web.isAddress(address)) throw new Error('The private key could not be converted to a valid TRON wallet address.')
    await protectAndSave(key, address, password)
  }

  async function restoreEncryptedBackup() {
    if (!backupText.trim()) throw new Error('Choose an encrypted TRON Token Studio wallet backup JSON file first.')
    const parsed = JSON.parse(backupText)
    const record = parsed?.wallet || parsed
    if (!isEncryptedWalletRecord(record)) throw new Error('This backup file is not a supported encrypted TRON Token Studio wallet.')
    const key = await decryptWalletPrivateKey(record, password)
    const web = createTronWeb(network, key)
    const derivedAddress = String(web.defaultAddress?.base58 || '')
    if (derivedAddress !== record.address) throw new Error('The decrypted key does not match the address recorded in this backup.')
    saveRecord(record as WalletRecord)
    setUnlocked({ record: record as WalletRecord, privateKey: key })
    setPassword('')
    setBackupText('')
    setNotice('Encrypted backup restored and the wallet is unlocked on this device.')
    setError('')
  }

  async function unlockExistingWallet() {
    if (!selectedRecord) throw new Error('Select a wallet before unlocking it.')
    const key = await decryptWalletPrivateKey(selectedRecord, password)
    const web = createTronWeb(network, key)
    if (String(web.defaultAddress?.base58 || '') !== selectedRecord.address) {
      throw new Error('This encrypted file did not unlock to the expected TRON address.')
    }
    setUnlocked({ record: selectedRecord, privateKey: key })
    setPassword('')
    setError('')
    setNotice('Wallet unlocked. Signing keys remain in application memory until you lock or leave this screen.')
  }

  async function performWalletAction(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Wallet operation failed. No network transaction was submitted.')
    } finally {
      setBusy(false)
    }
  }

  function lockWallet() {
    setActivePanel('wallet')
    setUnlocked(null)
    setPassword('')
    setConfirmPassword('')
    setPrivateKeyInput('')
    setPortfolio(null)
    setTransferReview(null)
    setTransferAcknowledged(false)
    setMainnetSendPhrase('')
    setOwnerTreasurySnapshot(null)
    setOwnerTreasuryError('')
    setNotice('Wallet locked. The unencrypted private key was removed from this screen’s React state.')
    setError('')
  }

  function downloadEncryptedBackup() {
    if (!unlocked) return
    const blob = new Blob([JSON.stringify({ wallet: unlocked.record }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'tron-token-studio-wallet-' + unlocked.record.address.slice(0, 8) + '.json'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    setNotice('Encrypted wallet backup exported. It still requires your wallet password to restore.')
  }

  async function inspectTokenContract(contractAddress: string): Promise<TokenEvidence> {
    if (!unlocked) throw new Error('Unlock the owner wallet to verify a token contract and query its on-chain balance.')
    const web = createTronWeb(network)
    if (!web.isAddress(contractAddress)) throw new Error('Enter a valid TRON contract address for the selected network.')

    // Use the backend's credentialed, cached, rate-limit-aware read-only RPC.
    // The APK/browser sends only public addresses; provider credentials remain server-side.
    const inspectionUrl = API_BASE + '/api/tron/inspect-token?network='
      + encodeURIComponent(network) + '&contract=' + encodeURIComponent(contractAddress)
      + '&owner=' + encodeURIComponent(unlocked.record.address)
    const inspectionResponse = await fetch(inspectionUrl, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    })
    const inspection = await inspectionResponse.json().catch(() => null)
    if (!inspectionResponse.ok || inspection?.success !== true
      || inspection.contractAddress !== contractAddress
      || inspection.ownerAddress !== unlocked.record.address
      || inspection.network !== network) {
      if (inspection?.error === 'chain-provider-rate-limited') {
        throw new Error('The chain provider is rate limiting requests. Wait 15–30 seconds and retry; no verification or transfer was performed.')
      }
      if (inspection?.error === 'contract-not-deployed') {
        throw new Error('This address has no deployed contract bytecode on the selected TRON network.')
      }
      throw new Error(typeof inspection?.message === 'string'
        ? inspection.message
        : 'The backend could not verify this token on-chain. No verification or transfer was performed.')
    }

    const decimals = Number(inspection.tokenDecimals)
    const symbol = String(inspection.tokenSymbol || '').trim().slice(0, 32)
    const name = String(inspection.tokenName || '').trim().slice(0, 80)
    const totalSupply = BigInt(String(inspection.totalSupplyBaseUnits))
    // Validate the returned balance too; it is an actual read-only balance result,
    // not a local balance edit or a credit that can be sent to an exchange.
    BigInt(String(inspection.balanceBaseUnits))
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !symbol || !name) {
      throw new Error('The contract did not return usable TRC-20 name, symbol, and decimal metadata.')
    }

    let explorer: Partial<TokenEvidence> = {
      network,
      contractAddress,
      explorerStatus: network === 'mainnet' ? 'unavailable' : 'not-available-for-testnet',
      sourceVerificationStatus: 'unknown',
      explorerRiskLevel: 'unknown',
      officialMainnetUsdtAddressMatch: false,
      evidenceScope: 'on-chain metadata and explorer annotations are evidence, not a safety guarantee',
    }
    try {
      const url = API_BASE + '/api/tron/token-authenticity?network='
        + encodeURIComponent(network) + '&contract=' + encodeURIComponent(contractAddress)
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const payload = await response.json().catch(() => null)
      if (response.ok && payload?.success === true && payload.contractAddress === contractAddress && payload.network === network) {
        explorer = {
          network,
          contractAddress,
          explorerStatus: String(payload.explorerStatus || 'unknown'),
          sourceVerificationStatus: String(payload.sourceVerificationStatus || 'unknown'),
          explorerRiskLevel: String(payload.explorerRiskLevel || 'unknown'),
          riskFeedback: payload.riskFeedback === true,
          riskTag: String(payload.riskTag || ''),
          publicLabel: String(payload.publicLabel || ''),
          officialLabel: String(payload.officialLabel || ''),
          officialMainnetUsdtAddressMatch: payload.officialMainnetUsdtAddressMatch === true
            && network === 'mainnet'
            && contractAddress === OFFICIAL_MAINNET_USDT
            && symbol.toUpperCase() === 'USDT'
            && decimals === 6
            && /tether/i.test(name),
          evidenceScope: String(payload.evidenceScope || 'on-chain metadata and explorer annotations are evidence, not a safety guarantee'),
        }
      }
    } catch {
      // Source-indexer outages are represented as unknown, never "verified".
    }
    const officialMainnetUsdtAddressMatch = network === 'mainnet'
      && contractAddress === OFFICIAL_MAINNET_USDT
      && symbol.toUpperCase() === 'USDT'
      && decimals === 6
      && /tether/i.test(name)
    return {
      ...explorer,
      network,
      contractAddress,
      officialMainnetUsdtAddressMatch,
      onChainContractDeployed: inspection.onChainContractDeployed === true,
      onChainMetadataReadable: inspection.onChainMetadataReadable === true,
      tokenName: name,
      tokenSymbol: symbol,
      tokenType: 'trc20',
      tokenDecimals: decimals,
      totalSupply: formatUnits(totalSupply.toString(), decimals),
      evidenceCheckedAt: Date.now(),
    } as TokenEvidence
  }

  function assertTokenTransferEvidence(evidence: TokenEvidence) {
    if (!evidence.onChainContractDeployed || !evidence.onChainMetadataReadable
      || evidence.tokenType !== 'trc20' || !Number.isInteger(evidence.tokenDecimals)) {
      throw new Error('The contract has not passed the on-chain TRC-20 metadata checks.')
    }
    if (evidence.riskFeedback === true
      || evidence.explorerRiskLevel === 'suspicious'
      || evidence.explorerRiskLevel === 'unsafe'
      || Boolean(evidence.riskTag?.trim())) {
      throw new Error('The explorer reports a token risk warning. This wallet blocks transfers to avoid treating the contract as trustworthy.')
    }
    if (evidence.network === 'mainnet'
      && evidence.officialMainnetUsdtAddressMatch !== true
      && evidence.sourceVerificationStatus !== 'fully-verified-source') {
      throw new Error('Mainnet token transfer blocked: the contract is neither the official Tether TRON USDT address nor fully source-verified on TronScan. Source verification alone is not a safety guarantee.')
    }
  }

  async function checkTokenEvidence(contractAddress: string) {
    setEvidenceLoading(contractAddress)
    try {
      const evidence = await inspectTokenContract(contractAddress)
      setTokenEvidence(current => ({ ...current, [contractAddress]: evidence }))
      setNotice('Contract checks completed: deployed bytecode and live TRC-20 metadata were read from the selected network. ' + tokenEvidenceLabel(evidence) + '. This is evidence, not a guarantee of safety.')
      setError('')
    } finally {
      setEvidenceLoading('')
    }
  }

  function refreshBackendTreasuryConfigurationNow() {
    let token = ownerSessionToken
    try {
      token = token || window.sessionStorage.getItem(OWNER_CONSOLE_SESSION_KEY) || ''
    } catch {
      // The in-memory session token remains usable when browser storage is blocked.
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setOwnerTreasuryError('Sign in to the owner console before refreshing backend treasury configuration.')
      return
    }
    setOwnerSessionToken(token)
    setOwnerTreasuryRefreshNonce((current) => current + 1)
  }

  async function refreshOwnerTreasury() {
    if (!unlocked) {
      setOwnerTreasuryError('Unlock the configured owner wallet before checking treasury funding.')
      return
    }
    if (network !== 'mainnet') {
      setOwnerTreasuryError('Switch to TRON Mainnet to check the owner treasury.')
      return
    }

    setOwnerTreasuryLoading(true)
    setOwnerTreasuryError('')
    setOwnerTreasurySnapshot(null)
    try {
      const address = unlocked.record.address
      const signer = createTronWeb('mainnet', unlocked.privateKey)
      if (String(signer.defaultAddress?.base58 || '') !== address) {
        throw new Error('The unlocked signing address does not match the owner wallet record.')
      }

      const challengeResponse = await fetch(API_BASE + '/api/auth/tron/challenge', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, network: 'mainnet' }),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const challenge = await challengeResponse.json().catch(() => null)
      if (!challengeResponse.ok || challenge?.success !== true
        || typeof challenge.message !== 'string' || typeof challenge.nonce !== 'string') {
        throw new Error('Could not issue an owner-signature challenge. Check the backend, database and allowed app origin.')
      }

      const signature = await signer.trx.signMessageV2(challenge.message)
      if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) {
        throw new Error('The wallet SDK did not return a valid owner identity signature.')
      }
      const verifyResponse = await fetch(API_BASE + '/api/auth/tron/verify', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, network: 'mainnet', nonce: challenge.nonce, signature }),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const verified = await verifyResponse.json().catch(() => null)
      if (!verifyResponse.ok || verified?.success !== true || verified?.authenticated !== true
        || verified.address !== address || verified.network !== 'mainnet'
        || typeof verified.sessionToken !== 'string') {
        throw new Error('The backend did not verify the Mainnet owner wallet signature.')
      }

      const statusResponse = await fetch(API_BASE + '/api/treasury/owner/funding-status?network=mainnet', {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + verified.sessionToken },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const status = await statusResponse.json().catch(() => null)
      if (!statusResponse.ok || status?.success !== true || status?.ownerAccessVerified !== true) {
        if (status?.error === 'owner-wallet-not-authorized') {
          throw new Error('This wallet is not the configured treasury owner. Set TREASURY_OWNER_ADDRESS to the owner wallet address in the backend environment.')
        }
        if (status?.error === 'treasury-owner-not-configured') {
          throw new Error('The backend needs TREASURY_OWNER_ADDRESS configured with the owner’s verified Mainnet wallet address.')
        }
        throw new Error('Owner-only treasury verification failed. No payout was signed or submitted.')
      }
      try { window.sessionStorage.setItem(OWNER_CONSOLE_SESSION_KEY, verified.sessionToken) } catch {}
      setOwnerSessionToken(verified.sessionToken)
      setOwnerTreasurySnapshot(status as OwnerTreasurySnapshot)
      const payoutReadinessResponse = await fetch(API_BASE + '/api/treasury/withdrawals/readiness', {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + verified.sessionToken },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const payoutReadiness = await payoutReadinessResponse.json().catch(() => null)
      setServerTreasuryReadiness(payoutReadiness && typeof payoutReadiness === 'object' ? payoutReadiness : null)
    } catch (caught) {
      setOwnerTreasuryError(caught instanceof Error ? caught.message : 'Owner treasury verification failed. No payout was signed or submitted.')
    } finally {
      setOwnerTreasuryLoading(false)
    }
  }

  async function submitServerTreasuryPayout() {
    if (treasuryPayoutBusy) return
    setTreasuryPayoutBusy(true)
    setTreasuryPayoutError('')
    let idempotencyKey = ''
    try {
      if (treasuryPayoutStatus?.status === 'submission-outcome-unknown') {
        throw new Error('This request may already have reached the backend. Look up the existing idempotency key first; do not resubmit or create a replacement until the backend confirms that no reservation exists.')
      }
      if (!canSubmitServerTreasuryPayout) {
        throw new Error('Mainnet USDT payout is blocked until the authenticated owner, exact sponsor release, live preflight, treasury balance and sponsor principal budget all pass.')
      }
      if (!unlocked?.privateKey || unlocked.record.address !== ownerSessionAddress) {
        throw new Error('Unlock the exact owner wallet used for this authenticated treasury session. The owner wallet signs authorization only; it does not fund the payout.')
      }
      if (treasuryPayoutConfirm.trim() !== 'SEND USDT') {
        throw new Error('Type SEND USDT to confirm this exact sponsor-funded payout request.')
      }
      const recipientAddress = treasuryPayoutRecipient.trim()
      const tronWeb = createTronWeb('mainnet', unlocked.privateKey)
      if (!tronWeb.isAddress(recipientAddress) || !ADDRESS_PATTERN.test(recipientAddress)) {
        throw new Error('Enter a valid TRON Mainnet recipient address.')
      }
      if (recipientAddress === serverTreasuryReadiness.treasuryAddress) {
        throw new Error('The recipient must be different from the sponsor treasury address.')
      }
      const amountBaseUnits = parseUnitsDecimal(treasuryPayoutAmount, 6)
      // A new idempotency key is generated only for a new intent. An ambiguous
      // prior request must be reconciled by lookup, never re-submitted from
      // possibly edited or reloaded recipient/amount fields.
      idempotencyKey = window.crypto.randomUUID()
      if (!/^[A-Za-z0-9._:-]{24,128}$/.test(idempotencyKey)) {
        throw new Error('A secure one-use withdrawal request key could not be generated.')
      }
      const authorizationExpiresAt = Date.now() + 90_000
      const authorizationMessage = buildTreasuryWithdrawalAuthorizationMessage({
        origin: window.location.origin,
        ownerAddress: ownerSessionAddress,
        treasuryAddress: serverTreasuryReadiness.treasuryAddress,
        recipientAddress,
        amountBaseUnits,
        idempotencyKey,
        authorizationExpiresAt,
      })
      if (String(tronWeb.defaultAddress?.base58 || '') !== ownerSessionAddress) {
        throw new Error('The unlocked wallet signer does not match the authenticated treasury owner.')
      }
      const ownerAuthorizationSignature = await tronWeb.trx.signMessageV2(authorizationMessage)
      if (typeof ownerAuthorizationSignature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(ownerAuthorizationSignature)) {
        throw new Error('The wallet did not return a valid one-request owner authorization signature.')
      }
      saveTreasuryPayoutReference(ownerSessionAddress, idempotencyKey)
      let response
      try {
        response = await fetch(API_BASE + '/api/treasury/withdrawals', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + ownerSessionToken,
          },
          body: JSON.stringify({
            recipientAddress,
            amountUsdt: treasuryPayoutAmount.trim(),
            idempotencyKey,
            ownerAuthorizationSignature,
            authorizationExpiresAt,
          }),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        })
      } catch {
        setTreasuryPayoutStatus({ status: 'submission-outcome-unknown', idempotencyKey })
        throw new Error('The request connection failed after authorization. Its outcome is unknown. Do not resubmit. Look up the saved idempotency key and wait for the backend to confirm whether a reservation exists.')
      }
      const payload = await response.json().catch(() => null)
      if (!response.ok || (payload?.success !== true && payload?.status !== 'broadcast-unknown')) {
        if (payload && typeof payload === 'object' && payload.status === 'rejected') {
          setTreasuryPayoutStatus({ ...payload, idempotencyKey })
        }
        throw new Error(typeof payload?.message === 'string'
          ? payload.message
          : typeof payload?.error === 'string' ? payload.error : 'The treasury payout request was not accepted.')
      }
      setTreasuryPayoutStatus({
        ...payload,
        idempotencyKey: payload?.withdrawal?.idempotencyKey || payload?.idempotencyKey || idempotencyKey,
      })
      setTreasuryPayoutConfirm('')
      pushToast('info', payload?.status === 'broadcast-unknown'
        ? 'Provider outcome is unknown. The sponsor principal remains reserved; reconcile this same request key and do not submit a replacement.'
        : 'Treasury payout request handed to Fireblocks. Provider acceptance is not on-chain confirmation; verify the solidified TRON receipt.')
    } catch (caught) {
      setTreasuryPayoutError(caught instanceof Error ? caught.message : 'Treasury payout request failed.')
    } finally {
      setTreasuryPayoutBusy(false)
    }
  }

  async function lookupServerTreasuryPayout() {
    const key = treasuryPayoutStatus?.withdrawal?.idempotencyKey || treasuryPayoutStatus?.idempotencyKey
    if (!ownerSessionToken || typeof key !== 'string') {
      setTreasuryPayoutError('There is no stored withdrawal key to look up.')
      return
    }
    setTreasuryPayoutBusy(true)
    setTreasuryPayoutError('')
    try {
      const verifyResponse = await fetch(API_BASE + '/api/treasury/withdrawals/' + encodeURIComponent(key) + '/verify', {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + ownerSessionToken },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const verification = await verifyResponse.json().catch(() => null)
      if (verifyResponse.status >= 500) {
        throw new Error(typeof verification?.error === 'string' ? verification.error : 'On-chain receipt verification is temporarily unavailable.')
      }
      const response = await fetch(API_BASE + '/api/treasury/withdrawals/' + encodeURIComponent(key), {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + ownerSessionToken },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const payload = await response.json().catch(() => null)
      if (response.status === 404 && payload?.error === 'withdrawal-not-found') {
        clearTreasuryPayoutReference()
        setTreasuryPayoutStatus({ status: 'not-found', idempotencyKey: key })
        setTreasuryPayoutRecipient('')
        setTreasuryPayoutAmount('')
        setTreasuryPayoutConfirm('')
        setNotice('The backend confirms that no withdrawal reservation exists for this saved key. You may now prepare a new payout request.')
        return
      }
      if (!response.ok || payload?.success !== true) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Withdrawal status lookup failed.')
      const combined = { ...payload, verification: verification?.verification || null }
      setTreasuryPayoutStatus(combined)
      if (verification?.verification?.status === 'confirmed') {
        setNotice('The exact treasury sender, official USDT contract, recipient, amount, successful solidified receipt, and matching official Transfer event were verified on TRON.')
      } else if (verification?.verification?.status === 'failed') {
        setTreasuryPayoutError('The transaction is confirmed on-chain but its contract execution failed. No successful USDT transfer was verified.')
      } else if (verification?.verification?.status === 'verification-mismatch') {
        setTreasuryPayoutError('On-chain transaction details did not match this withdrawal. Treat it as unverified and investigate before any retry.')
      } else {
        setNotice('Withdrawal record loaded. The confirmed receipt is still pending or unavailable; do not treat a broadcast-accepted status as confirmed.')
      }
    } catch (caught) {
      setTreasuryPayoutError(caught instanceof Error ? caught.message : 'Withdrawal status lookup failed.')
    } finally {
      setTreasuryPayoutBusy(false)
    }
  }

  async function loadTreasuryReleaseMessage(action: 'approve' | 'revoke') {
    if (!ownerSessionToken) {
      setTreasuryReleaseError('Sign the owner treasury check first to establish the authenticated owner-console session.')
      return
    }
    setTreasuryReleaseBusy(true)
    setTreasuryReleaseError('')
    setTreasuryReleaseMessage('')
    setTreasuryReleaseSignature('')
    try {
      const path = action === 'approve'
        ? '/api/treasury/withdrawals/release-authorization/message'
        : '/api/treasury/withdrawals/release-authorization/revocation-message'
      const response = await fetch(API_BASE + path, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + ownerSessionToken },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true || typeof payload?.message !== 'string') {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Sponsor release message could not be prepared.')
      }
      setTreasuryReleaseAction(action)
      setTreasuryReleaseMessage(payload.message)
      pushToast('info', action === 'approve'
        ? 'Release message prepared. This does not enable transfers until a configured sponsor signature is verified and stored.'
        : 'Release revocation message prepared. Existing reserved or submitted transfers are not automatically cancelled.')
    } catch (caught) {
      setTreasuryReleaseError(caught instanceof Error ? caught.message : 'Sponsor release message could not be loaded.')
    } finally {
      setTreasuryReleaseBusy(false)
    }
  }

  async function submitTreasuryReleaseSignature() {
    if (!ownerSessionToken || !treasuryReleaseMessage) {
      setTreasuryReleaseError('Prepare the exact sponsor release or revocation message before submitting its signature.')
      return
    }
    const signature = treasuryReleaseSignature.trim()
    if (!/^0x[0-9a-f]{130}$/i.test(signature)) {
      setTreasuryReleaseError('Paste only the 65-byte 0x-prefixed message signature from the configured sponsor wallet. Never paste a private key.')
      return
    }
    setTreasuryReleaseBusy(true)
    setTreasuryReleaseError('')
    try {
      const path = treasuryReleaseAction === 'approve'
        ? '/api/treasury/withdrawals/release-authorization/signature'
        : '/api/treasury/withdrawals/release-authorization/revoke'
      const response = await fetch(API_BASE + path, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + ownerSessionToken,
        },
        body: JSON.stringify({ signature }),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Sponsor release signature was not accepted.')
      }
      setTreasuryReleaseSignature('')
      setTreasuryReleaseMessage('')
      const readinessResponse = await fetch(API_BASE + '/api/treasury/withdrawals/readiness', {
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + ownerSessionToken },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const readiness = await readinessResponse.json().catch(() => null)
      if (readinessResponse.ok && readiness?.success === true) setServerTreasuryReadiness(readiness)
      pushToast('info', treasuryReleaseAction === 'approve'
        ? 'Sponsor release signature verified and stored. New USDT execution is possible only if every live funding and payout preflight check also passes.'
        : 'Sponsor release authorization revoked. New USDT submission is blocked; reconcile any existing in-flight transfer.')
    } catch (caught) {
      setTreasuryReleaseError(caught instanceof Error ? caught.message : 'Sponsor release signature submission failed.')
    } finally {
      setTreasuryReleaseBusy(false)
    }
  }

  async function copyTreasuryReleaseMessage() {
    if (!treasuryReleaseMessage) return
    try {
      await navigator.clipboard.writeText(treasuryReleaseMessage)
      pushToast('success', 'Canonical release message copied. It contains no private key or transaction signing material.')
    } catch {
      setTreasuryReleaseError('Clipboard access is unavailable. Select and copy the canonical release message manually.')
    }
  }

  async function createSponsorRecipientApprovalRequest() {
    if (!ownerSessionToken) {
      setSponsorRecipientError('Sign the owner treasury check first. A valid owner-console session is required to request a sponsor destination review.')
      return
    }
    const recipientAddress = sponsorRecipientAddress.trim()
    const reason = sponsorRecipientReason.trim()
    if (!ADDRESS_PATTERN.test(recipientAddress) || recipientAddress === serverTreasuryReadiness?.treasuryAddress) {
      setSponsorRecipientError('Enter a valid, different TRON recipient address. The treasury cannot approve itself as a destination.')
      return
    }
    if (!/^[\x20-\x7e]{10,500}$/.test(reason)) {
      setSponsorRecipientError('Enter a single-line reason using 10–500 printable ASCII characters.')
      return
    }
    setSponsorRecipientBusy(true)
    setSponsorRecipientError('')
    try {
      const response = await fetch(API_BASE + '/api/treasury/recipient-approval-requests', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + ownerSessionToken,
        },
        body: JSON.stringify({ recipientAddress, reason }),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true || typeof payload?.request?.requestId !== 'string') {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Sponsor recipient request could not be created.')
      }
      setSponsorRecipientRequestId(payload.request.requestId)
      setSponsorRecipientRequest(payload)
      setSponsorRecipientSignature('')
      pushToast('info', 'Recipient review request created. It is not a payout and no funds were reserved or sent.')
    } catch (caught) {
      setSponsorRecipientError(caught instanceof Error ? caught.message : 'Sponsor recipient request failed.')
    } finally {
      setSponsorRecipientBusy(false)
    }
  }

  async function loadSponsorRecipientApprovalRequest() {
    const requestId = sponsorRecipientRequestId.trim()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      setSponsorRecipientError('Enter a valid recipient approval request ID.')
      return
    }
    setSponsorRecipientBusy(true)
    setSponsorRecipientError('')
    try {
      const response = await fetch(API_BASE + '/api/treasury/recipient-approval-requests/' + encodeURIComponent(requestId), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true || payload?.request?.requestId !== requestId) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Recipient approval request could not be loaded.')
      }
      setSponsorRecipientRequest(payload)
      setSponsorRecipientSignature('')
    } catch (caught) {
      setSponsorRecipientError(caught instanceof Error ? caught.message : 'Recipient approval request lookup failed.')
    } finally {
      setSponsorRecipientBusy(false)
    }
  }

  async function submitSponsorRecipientSignature() {
    const requestId = sponsorRecipientRequest?.request?.requestId || sponsorRecipientRequestId.trim()
    const status = sponsorRecipientRequest?.request?.status
    const action = status === 'pending' ? 'approve' : status === 'approved' ? 'revoke' : ''
    const signature = sponsorRecipientSignature.trim()
    if (!action) {
      setSponsorRecipientError('Load a pending or approved recipient request before submitting a sponsor signature.')
      return
    }
    if (!/^0x[0-9a-f]{130}$/i.test(signature)) {
      setSponsorRecipientError('Paste the 65-byte 0x-prefixed signature from the configured sponsor wallet. Never paste a private key.')
      return
    }
    setSponsorRecipientBusy(true)
    setSponsorRecipientError('')
    try {
      const response = await fetch(API_BASE + '/api/treasury/recipient-approval-requests/' + encodeURIComponent(requestId) + '/' + action, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature }),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Sponsor signature was not accepted.')
      }
      setSponsorRecipientSignature('')
      await loadSponsorRecipientApprovalRequest()
      pushToast('info', action === 'approve'
        ? 'Sponsor destination approval recorded. This does not authorize a USDT transfer.'
        : 'Sponsor destination approval revoked. New withdrawals to this address are blocked.')
    } catch (caught) {
      setSponsorRecipientError(caught instanceof Error ? caught.message : 'Sponsor signature submission failed.')
    } finally {
      setSponsorRecipientBusy(false)
    }
  }

  async function copySponsorRecipientMessage() {
    const message = sponsorRecipientRequest?.approvalMessage || sponsorRecipientRequest?.revocationMessage
    if (typeof message !== 'string' || !message) return
    try {
      await navigator.clipboard.writeText(message)
      pushToast('success', 'Canonical sponsor message copied. It contains no private key or transfer authorization.')
    } catch {
      setSponsorRecipientError('Clipboard access is unavailable. Select and copy the canonical message manually.')
    }
  }

  async function selectTreasuryUsdtSender() {
    if (!unlocked) throw new Error('Unlock the treasury wallet locally before preparing a payout.')
    if (network !== 'mainnet') throw new Error('Treasury payouts are available only on TRON Mainnet.')
    const snapshot = ownerTreasurySnapshot
    if (snapshot?.ownerAccessVerified !== true || !snapshot.treasuryAddress) {
      throw new Error('Verify the owner session and read the treasury balance before selecting a treasury payout.')
    }
    if (snapshot.treasuryAddress !== unlocked.record.address) {
      throw new Error('The unlocked wallet is not the configured treasury funding address. Unlock the treasury wallet with its matching private key first.')
    }
    const balanceBaseUnits = snapshot.officialUsdt?.balanceBaseUnits
    if (snapshot.officialUsdt?.status !== 'verified'
      || snapshot.officialUsdt.tokenContract !== OFFICIAL_MAINNET_USDT
      || snapshot.officialUsdt.decimals !== 6
      || typeof balanceBaseUnits !== 'string'
      || !/^(0|[1-9][0-9]*)$/.test(balanceBaseUnits)) {
      throw new Error('A verified official USDT treasury balance is unavailable. No payout was prepared.')
    }
    if (BigInt(balanceBaseUnits) <= 0n) {
      throw new Error('The treasury holds zero genuine USDT. Fund it through a legitimate on-chain transfer before preparing an external payout.')
    }

    // This is a convenience for choosing the configured treasury as the local
    // sender. The normal transfer path still re-reads the balance, estimates
    // fees, requires owner-local signing, and validates the final receipt.
    await addTokenContract(OFFICIAL_MAINNET_USDT)
    setTransferAsset('TRC20')
    setSelectedTokenContract(OFFICIAL_MAINNET_USDT)
    setTransferReview(null)
    setTransferAcknowledged(false)
    setMainnetSendPhrase('')
    setNotice('Official Mainnet USDT selected from the verified treasury wallet. Enter the recipient and amount below. The balance and fee cap will be checked again before signing; this app does not generate USDT or pay TRX fees for the treasury.')
    setError('')
  }

  async function prepareTransfer() {
    if (!unlocked) throw new Error('Unlock the wallet before preparing a transfer.')
    const web = createTronWeb(network, unlocked.privateKey)
    const from = String(web.defaultAddress?.base58 || '')
    if (from !== unlocked.record.address || !web.isAddress(from)) throw new Error('Unlocked signing address does not match the selected wallet record.')
    // Mainnet sends are owner-only. Require a recent server-verified owner
    // session and the exact configured treasury as the locally signed sender.
    assertOwnerMainnetTransferAccess({ network, from, snapshot: ownerTreasurySnapshot })
    const to = recipientInput.trim()
    if (!web.isAddress(to) || !ADDRESS_PATTERN.test(to)) throw new Error('Enter a valid TRON Base58Check recipient address.')
    if (to === from) throw new Error('Sender and recipient must be different addresses.')
    const nativeBalance = BigInt(String(await web.trx.getBalance(from)))
    const amount = amountInput.trim()
    if (transferAsset === 'TRX') {
      const amountBaseUnits = parseUnitsDecimal(amount, 6)
      if (nativeBalance < BigInt(amountBaseUnits) + 1_000_000n) {
        throw new Error('Insufficient confirmed TRX balance. Keep at least 1 TRX available for network fees.')
      }
      setTransferReview({
        network, asset: 'TRX', from, to, amount, amountBaseUnits, decimals: 6,
        symbol: 'TRX', tokenContract: null,
        nativeBalance: formatUnits(nativeBalance.toString(), 6), tokenBalance: null,
        tokenEvidence: null, feeLimitSun: 1_000_000, energyRequired: null,
        feeEstimateSun: null, createdAt: Date.now(),
      })
      setTransferAcknowledged(false)
      setMainnetSendPhrase('')
      setNotice('Review the live balance and recipient below. No transaction has been signed or broadcast.')
      return
    }

    const contractAddress = selectedTokenContract
    if (!contractAddress || !tokenContracts.includes(contractAddress)) throw new Error('Add and select a TRC-20 contract before preparing a token transfer.')
    const evidence = await inspectTokenContract(contractAddress)
    setTokenEvidence(current => ({ ...current, [contractAddress]: evidence }))
    assertTokenTransferEvidence(evidence)
    const decimals = evidence.tokenDecimals as number
    const amountBaseUnits = parseUnitsDecimal(amount, decimals)
    const contract = await web.contract(TOKEN_ABI, contractAddress)
    const rawBalance = BigInt(String(await contract.balanceOf(from).call()))
    if (rawBalance < BigInt(amountBaseUnits)) throw new Error('Insufficient on-chain token balance for this transfer.')
    const estimated = await estimateTRC20TransferFee({
      tronWeb: web, from, to, tokenContract: contractAddress, amountBaseUnits,
    })
    const feeLimitSun = estimated.recommendedFeeSun
    if (!Number.isSafeInteger(feeLimitSun) || feeLimitSun <= 0 || feeLimitSun > 100_000_000) {
      throw new Error('The calculated transaction fee cap is outside the 1–100 TRX safety range.')
    }
    if (nativeBalance < BigInt(feeLimitSun)) {
      throw new Error('Insufficient TRX to cover the estimated TRC-20 fee cap. Add enough real TRX or resources before retrying; no transaction was sent.')
    }
    setTransferReview({
      network, asset: 'TRC20', from, to, amount, amountBaseUnits, decimals,
      symbol: evidence.tokenSymbol || 'TRC20', tokenContract: contractAddress,
      nativeBalance: formatUnits(nativeBalance.toString(), 6),
      tokenBalance: formatUnits(rawBalance.toString(), decimals),
      tokenEvidence: evidence, feeLimitSun,
      energyRequired: estimated.energyRequired,
      feeEstimateSun: estimated.recommendedFeeSun,
      createdAt: Date.now(),
    })
    setTransferAcknowledged(false)
    setMainnetSendPhrase('')
    setNotice('On-chain simulation and fee estimation passed. Review the exact token contract and details below; nothing has been sent.')
  }

  async function broadcastTransfer() {
    // Fail closed in this supervised development build. The isolated testnet
    // sandbox creates local previews only and has no signing/broadcast path.
    throw new Error('Transaction signing and broadcast are disabled in this build. Use the local-only Testnet Sandbox preview; no funds have been sent.')
  }

  async function refreshTransferStatus(record: TransferActivity) {
    setHistoryLoading(record.txid)
    try {
      const web = createTronWeb(record.network)
      let decimals = 6
      let symbol = 'TRX'
      if (record.asset === 'TRC20') {
        if (!record.tokenContract || !web.isAddress(record.tokenContract)) {
          throw new Error('The saved TRC-20 record does not contain a valid token contract address.')
        }
        const token = await web.contract(TOKEN_ABI, record.tokenContract)
        const [rawDecimals, rawSymbol] = await Promise.all([
          token.decimals().call(),
          token.symbol().call(),
        ])
        decimals = Number(String(rawDecimals))
        symbol = String(rawSymbol || '').trim().slice(0, 32)
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !symbol) {
          throw new Error('The token contract did not return usable decimals and symbol metadata.')
        }
      }
      const chainRecord = await verifyTransferRecordOnChain(web, {
        txid: record.txid,
        from: record.from,
        to: record.to,
        asset: record.asset,
        amountBaseUnits: record.amountBaseUnits,
        tokenContract: record.tokenContract || undefined,
      })
      const status = chainRecord.identityMatches
        ? chainRecord.status as TransferStatus
        : chainRecord.reason === 'transaction-not-found'
          ? 'pending-or-not-indexed' as TransferStatus
          : 'identity-mismatch' as TransferStatus
      const updated: TransferActivity = {
        ...record,
        amount: formatUnits(record.amountBaseUnits, decimals),
        decimals,
        symbol,
        status,
        verifiedOnChain: chainRecord.identityMatches,
        verificationReason: chainRecord.reason || 'transaction-not-indexed-yet',
        solidified: chainRecord.identityMatches && chainRecord.solidified,
        blockNumber: chainRecord.identityMatches ? chainRecord.blockNumber ?? null : null,
      }
      const next = [updated, ...transferHistory.filter(item => item.txid !== record.txid)]
        .sort((a, b) => b.submittedAt - a.submittedAt).slice(0, 100)
      saveTransferHistory(next)
      setTransferHistory(next)
      if (chainRecord.identityMatches) {
        setNotice('On-chain transaction identity verified. Status: ' + updated.status
          + (updated.solidified ? ' (solidified successful receipt)' : ' (not yet solidified or execution unresolved)') + '.')
      } else if (chainRecord.reason === 'transaction-not-found') {
        setNotice('This transaction ID is not indexed on the selected network yet. The saved details remain unverified; try again later.')
      } else {
        setNotice('The saved history details do not match the transaction returned by the selected network. This local record is not marked verified.')
      }
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not verify this history record from the public TRON node.')
    } finally {
      setHistoryLoading('')
    }
  }

  async function addTokenContract(contractOverride?: string) {
    const contract = (contractOverride || tokenInput).trim()
    const evidence = await inspectTokenContract(contract)
    setTokenEvidence(current => ({ ...current, [contract]: evidence }))
    if (!tokenContracts.includes(contract)) {
      const next = [...tokenContracts, contract]
      const watchlist = JSON.parse(window.localStorage.getItem(TOKEN_WATCH_KEY) || '{}')
      window.localStorage.setItem(TOKEN_WATCH_KEY, JSON.stringify({ ...watchlist, [network]: next }))
      setTokenContracts(next)
    }
    setSelectedTokenContract(contract)
    setTokenInput('')
    setRefreshNonce(value => value + 1)
    setNotice('Live chain checks passed for ' + (evidence.tokenSymbol || 'TRC-20') + '. Evidence: ' + tokenEvidenceLabel(evidence) + '. Symbols and source verification do not guarantee safety or value.')
  }

  function removeTokenContract(contract: string) {
    const next = tokenContracts.filter(item => item !== contract)
    const watchlist = JSON.parse(window.localStorage.getItem(TOKEN_WATCH_KEY) || '{}')
    window.localStorage.setItem(TOKEN_WATCH_KEY, JSON.stringify({ ...watchlist, [network]: next }))
    setTokenContracts(next)
    if (selectedTokenContract === contract) setSelectedTokenContract(next[0] || '')
    setTokenEvidence(current => {
      const updated = { ...current }
      delete updated[contract]
      return updated
    })
    setTransferReview(current => current?.tokenContract === contract ? null : current)
    setTransferAcknowledged(false)
  }

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address)
      setNotice('Public wallet address copied.')
      setError('')
    } catch {
      setError('Clipboard permission was denied. You can select the public address and copy it manually.')
    }
  }

  async function readBackupFile(file: File | undefined) {
    if (!file) return
    if (file.size > 64 * 1024) {
      setError('The encrypted wallet backup file is unexpectedly large.')
      return
    }
    try {
      setBackupText(await file.text())
      setNotice('Encrypted wallet backup loaded locally. It has not been uploaded.')
      setError('')
    } catch {
      setError('Could not read that wallet backup file.')
    }
  }

  function scrollWorkspaceToTop() {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })
  }

  function navigatePanel(panel: 'dashboard' | 'wallet' | 'treasury' | 'send' | 'activity' | 'account' | 'settings') {
    setActivePanel(panel)
    scrollWorkspaceToTop()
    if (panel === 'treasury' && network !== 'mainnet') {
      setNetwork('mainnet')
      setNotice('Treasury monitoring and organization payouts use TRON Mainnet. An exact owner approval is required for each payout.')
    }
    if (panel !== 'send') {
      setTransferReview(null)
      setTransferAcknowledged(false)
      setMainnetSendPhrase('')
    }
  }

  function navigateSendAsset(asset: TransferAsset) {
    setActivePanel('send')
    scrollWorkspaceToTop()
    setNetwork('mainnet')
    setTransferAsset(asset)
    setTransferReview(null)
    setTransferAcknowledged(false)
    setMainnetSendPhrase('')
    if (asset === 'TRC20') {
      const existingContracts = readTokenWatchlist('mainnet')
      const mainnetContracts = existingContracts.includes(OFFICIAL_MAINNET_USDT) ? existingContracts : [OFFICIAL_MAINNET_USDT, ...existingContracts]
      if (!existingContracts.includes(OFFICIAL_MAINNET_USDT)) {
        try {
          const savedWatchlist = JSON.parse(window.localStorage.getItem(TOKEN_WATCH_KEY) || '{}')
          window.localStorage.setItem(TOKEN_WATCH_KEY, JSON.stringify({ ...savedWatchlist, mainnet: mainnetContracts }))
        } catch {
          setError('The official USDT contract could not be added to the device watchlist. Verify it under Assets before sending.')
        }
      }
      setTokenContracts(mainnetContracts)
      setSelectedTokenContract(OFFICIAL_MAINNET_USDT)
    }
    setNotice(unlocked
      ? (asset === 'TRC20'
        ? 'Official TRON Mainnet USDT selected. A genuine transfer needs real USDT at the sender and sufficient network-fee resources.'
        : 'TRON Mainnet TRX selected. A genuine transfer needs enough TRX for the amount and network fee.')
      : 'Open Account to unlock the authorized signer. If the local wallet has no USDT, organization payouts require a genuinely funded treasury.')
  }

  async function logoutOwnerSession() {
    let sessionToken = ''
    try {
      sessionToken = window.sessionStorage.getItem(OWNER_CONSOLE_SESSION_KEY) || ''
      window.sessionStorage.removeItem(OWNER_CONSOLE_SESSION_KEY)
    } catch {
      sessionToken = ''
    }
    setUnlocked(null)
    setPortfolio(null)
    setPassword('')
    setConfirmPassword('')
    setPrivateKeyInput('')
    setOwnerSessionToken('')
    setOwnerSessionAddress('')
    setOwnerTreasurySnapshot(null)
    setServerTreasuryReadiness(null)
    setActivePanel('dashboard')
    if (sessionToken) {
      try {
        await fetch(API_BASE + '/api/auth/owner/logout', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + sessionToken },
          credentials: 'omit',
          cache: 'no-store',
        })
      } catch {
        // Local session is cleared even if the API is unreachable.
      }
    }
    window.location.reload()
  }

  return (
    <main className="wallet-vault-page wallet-vault-owner-app">
      <header className="wallet-vault-topbar wallet-vault-topbar--owner">
        <a className="wallet-vault-brand" href="#/wallet" aria-label="TRON Token Studio owner wallet home">
          <span className="wallet-vault-logo"><Wallet size={22} aria-hidden="true" /></span>
          <span><strong>TRON Token Studio</strong><small>PRIVATE OWNER WORKSPACE</small></span>
        </a>
        <div className="wallet-vault-topbar-owner">
          <div className="wallet-vault-owner-identity"><small>{ownerSessionToken && ownerSessionAddress ? 'VERIFIED OWNER SESSION' : unlocked?.record.address ? 'UNLOCKED LOCAL WALLET' : 'OWNER ACCOUNT'}</small><strong title={ownerAddressForHeader || 'Owner address has not been verified'}>{ownerAddressForHeader ? shortenAddress(ownerAddressForHeader) : 'Session not verified'}</strong></div>
          <div className="wallet-vault-header-balance">
            <div><small>OWNER WALLET USDT</small><strong>{ownerHeaderUsdt}</strong></div>
            <div><small>OWNER WALLET TRX</small><strong>{ownerHeaderTrx}</strong></div>
          </div>
          <button type="button" className={"wallet-vault-mobile-settings" + (activePanel === 'settings' ? ' is-active' : '')} aria-label="Open Settings" title="Settings" aria-pressed={activePanel === 'settings'} onClick={() => navigatePanel('settings')}><Settings size={16} /></button>
          <button type="button" className="wallet-vault-logout" onClick={() => void logoutOwnerSession()}><LogOut size={15} /> Logout</button>
        </div>
      </header>
      <aside className="wallet-vault-sidebar" aria-label="Owner workspace sidebar">
        <div className="wallet-vault-sidebar-kicker">WORKSPACE</div>
        <nav className="wallet-vault-sidebar-nav" aria-label="Primary owner navigation">
          <button type="button" className={activePanel === 'dashboard' ? 'is-active' : ''} aria-current={activePanel === 'dashboard' ? 'page' : undefined} onClick={() => navigatePanel('dashboard')}><Home size={17} /><span>Home</span></button>
          <button type="button" className={activePanel === 'wallet' ? 'is-active' : ''} aria-current={activePanel === 'wallet' ? 'page' : undefined} onClick={() => navigatePanel('wallet')}><Coins size={17} /><span>Assets</span></button>
          <button type="button" className={activePanel === 'send' ? 'is-active' : ''} aria-current={activePanel === 'send' ? 'page' : undefined} onClick={() => navigatePanel('send')}><Send size={17} /><span>Personal wallet</span></button>
          <button type="button" className={activePanel === 'treasury' ? 'is-active' : ''} aria-current={activePanel === 'treasury' ? 'page' : undefined} onClick={() => navigatePanel('treasury')}><Landmark size={17} /><span>Sponsor payouts</span></button>
          <button type="button" className={activePanel === 'account' ? 'is-active' : ''} aria-current={activePanel === 'account' ? 'page' : undefined} onClick={() => navigatePanel('account')}><UserRound size={17} /><span>Account</span></button>
          <button type="button" className={activePanel === 'activity' ? 'is-active' : ''} aria-current={activePanel === 'activity' ? 'page' : undefined} onClick={() => navigatePanel('activity')}><Activity size={17} /><span>Activity</span></button>
          <button type="button" className={activePanel === 'settings' ? 'is-active' : ''} aria-current={activePanel === 'settings' ? 'page' : undefined} onClick={() => navigatePanel('settings')}><Settings size={17} /><span>Settings</span></button>
        </nav>

      </aside>

      <section id="owner-dashboard" className="wallet-vault-hero wallet-vault-hero--compact">
        <p className="wallet-vault-eyebrow"><ShieldCheck size={15} aria-hidden="true" /> OWNER-ONLY ACCESS · REAL ON-CHAIN ASSETS</p>
        <h1>{activePanel === 'dashboard' ? 'Home' : activePanel === 'wallet' ? 'Personal wallet assets' : activePanel === 'send' ? (transferAsset === 'TRC20' ? 'Personal wallet · Send USDT' : 'Personal wallet · Send TRX') : activePanel === 'treasury' ? 'Sponsor-funded payouts' : activePanel === 'account' ? 'Owner account' : activePanel === 'activity' ? 'Activity' : 'Settings'}</h1>
        <p>{activePanel === 'dashboard'
          ? 'Overview of your authenticated owner account, verified treasury balances, and payout readiness. No TronLink connection is required to use this standalone owner wallet.'
          : activePanel === 'wallet'
            ? 'Read genuine on-chain assets for the unlocked wallet. Wallet creation and recovery are under Account.'
            : activePanel === 'send'
              ? 'Personal-wallet route only: any future transfer is sourced from the exact unlocked wallet shown in Assets. It never spends the sponsor treasury. This build provides review only; signing and broadcast remain disabled.'
              : activePanel === 'treasury'
                ? 'Separate sponsor-funded route: the organization vault supplies genuine USDT principal and authorized network fees. Your personal wallet only signs a one-request authorization; it does not fund the payout.'
                : activePanel === 'account'
                  ? 'Create, import, unlock, or recover the local owner signing wallet. Key material is processed on this device.'
                  : activePanel === 'activity'
                    ? 'Review local transaction records against actual chain status.'
                    : 'View public treasury settings and read-only provider checks. Payout execution is unavailable in this build.'}
        </p>
        <a className="wallet-vault-secondary" href="#/testnet-sandbox">Open read-only Testnet Sandbox</a>
      </section>

      <div className="wallet-vault-transfer-warning wallet-vault-owner-model" role="note" hidden={activePanel !== 'dashboard'}>
        <strong>Important: sponsor-funded Mainnet payouts are locked</strong>
        <p>This application cannot create USDT or spend an observed balance. A payout requires an authorized sponsor organization’s Fireblocks vault to hold genuine official TRON USDT and enough TRX for network fees. The owner wallet signs a one-request authorization only; it does not fund the payout. Real-value execution remains hard-disabled until the sponsor, provider, custody, chain and security controls are independently approved.</p>
      </div>

      <section className="wallet-vault-panel wallet-vault-route-chooser" aria-labelledby="wallet-vault-route-chooser-heading" hidden={activePanel !== 'dashboard'}>
        <div className="wallet-vault-panel-head">
          <span className="wallet-vault-step"><Send size={16} /></span>
          <div>
            <h2 id="wallet-vault-route-chooser-heading">Choose the correct transfer route</h2>
            <p>These are two different sources of funds. Choose the route that matches who owns the assets.</p>
          </div>
        </div>
        <div className="wallet-vault-route-grid">
          <button type="button" className="wallet-vault-route-card wallet-vault-route-card--personal" onClick={() => navigatePanel('send')}>
            <span className="wallet-vault-route-kicker">ROUTE A · YOUR WALLET</span>
            <Wallet size={22} aria-hidden="true" />
            <strong>Personal wallet transfer</strong>
            <small>Uses only real TRX or verified tokens already held by the unlocked personal wallet. The wallet must also cover any required network fee.</small>
            <span className="wallet-vault-route-foot">Open Personal wallet →</span>
          </button>
          <button type="button" className="wallet-vault-route-card wallet-vault-route-card--sponsor" onClick={() => navigatePanel('treasury')}>
            <span className="wallet-vault-route-kicker">ROUTE B · ORGANIZATION FUNDS</span>
            <Landmark size={22} aria-hidden="true" />
            <strong>Sponsor-funded payout</strong>
            <small>Uses only an authorized, independently verified and funded organization vault. It never draws USDT principal from your personal wallet. This route is currently locked.</small>
            <span className="wallet-vault-route-foot">Open Sponsor payouts →</span>
          </button>
        </div>
        <p className="wallet-vault-caption">A balance observation, wallet login or sponsor budget record is not permission to spend. The selected route always checks its own source address, funds and authorization.</p>
      </section>

      <section className="wallet-vault-panel wallet-vault-payout-guide" aria-labelledby="wallet-vault-payout-guide-heading" hidden={activePanel !== 'dashboard'}>
        <div className="wallet-vault-panel-head">
          <span className="wallet-vault-step"><Landmark size={16} /></span>
          <div>
            <h2 id="wallet-vault-payout-guide-heading">Sponsor route · Mainnet USDT payout journey</h2>
            <p>Use this journey only when an organization has authorized and funded the separate Fireblocks treasury. It is independent of the Personal wallet route.</p>
          </div>
        </div>
        <div className="wallet-vault-payout-guide-status" role="status" aria-live="polite">
          <div>
            <small>Current network</small>
            <strong>{network === 'mainnet' ? 'TRON Mainnet selected' : (network === 'nile' ? 'Nile testnet selected' : 'Shasta testnet selected') + ' · payout page switches to Mainnet'}</strong>
          </div>
          <div>
            <small>Current payout gate</small>
            <strong>{canSubmitServerTreasuryPayout
              ? 'UI owner and readiness checks currently pass · backend revalidation still required'
              : serverTreasuryReadiness
                ? 'Blocked: ' + String(serverTreasuryReadiness.executionBlocker || serverTreasuryReadiness.releaseAuthorization?.reason || 'readiness evidence incomplete').replaceAll('-', ' ') + ' · open Organization payouts for details'
                : 'Waiting for live sponsor and treasury readiness evidence'}</strong>
          </div>
        </div>
        <div className="wallet-vault-payout-guide-grid">
          <button type="button" className="wallet-vault-payout-guide-step" onClick={() => navigatePanel('settings')}>
            <span className="wallet-vault-payout-guide-number">01</span>
            <Settings size={19} aria-hidden="true" />
            <strong>Select Mainnet</strong>
            <small>Open Settings and select TRON Mainnet. The payout page will also switch to Mainnet automatically.</small>
            <span className="wallet-vault-payout-guide-action">Open Settings →</span>
          </button>
          <button type="button" className="wallet-vault-payout-guide-step" onClick={() => navigatePanel('treasury')}>
            <span className="wallet-vault-payout-guide-number">02</span>
            <Landmark size={19} aria-hidden="true" />
            <strong>Check sponsor funding</strong>
            <small>Review Fireblocks discovery, official USDT and TRX balances, sponsor approval, budgets and complete outbound-history reconciliation.</small>
            <span className="wallet-vault-payout-guide-action">Open Organization payouts →</span>
          </button>
          <button type="button" className="wallet-vault-payout-guide-step" onClick={() => navigatePanel('account')}>
            <span className="wallet-vault-payout-guide-number">03</span>
            <Wallet size={19} aria-hidden="true" />
            <strong>Unlock owner authorization</strong>
            <small>Unlock the exact owner wallet used for the authenticated owner session. It signs the request; it does not provide USDT principal or pay sponsor fees.</small>
            <span className="wallet-vault-payout-guide-action">Open Account →</span>
          </button>
          <button type="button" className="wallet-vault-payout-guide-step" onClick={() => navigatePanel('treasury')}>
            <span className="wallet-vault-payout-guide-number">04</span>
            <Send size={19} aria-hidden="true" />
            <strong>Prepare one payout request</strong>
            <small>Only after all gates pass, enter the exact external Mainnet TRON address and amount, review them, type SEND USDT and sign the one-use authorization.</small>
            <span className="wallet-vault-payout-guide-action">Open payout form →</span>
          </button>
          <button type="button" className="wallet-vault-payout-guide-step" onClick={() => navigatePanel('treasury')}>
            <span className="wallet-vault-payout-guide-number">05</span>
            <ShieldCheck size={19} aria-hidden="true" />
            <strong>Verify settlement and credit</strong>
            <small>Look up the same request key, verify its solidified TRON transaction and official USDT Transfer event, then check the receiving exchange’s own deposit status.</small>
            <span className="wallet-vault-payout-guide-action">Open payout status →</span>
          </button>
        </div>
        <p className="wallet-vault-caption">A TRON transaction ID and a successful USDT Transfer event prove an on-chain transfer only. They do not prove an exchange credited the deposit or made it withdrawable. Never send a fake, simulated or restricted token while representing it as genuine Tether USDT.</p>
      </section>



      <section className="wallet-vault-transfer-section" aria-labelledby="owner-dashboard-treasury-heading" hidden={activePanel !== 'dashboard'}>
        <div className="wallet-vault-panel-head">
          <span className="wallet-vault-step">READ-ONLY</span>
          <div>
            <h2 id="owner-dashboard-treasury-heading">Read-only Mainnet treasury status</h2>
            <p>Loads public treasury observations for review. A live chain read does not mean this build can submit payouts.</p>
          </div>
        </div>
        {ownerTreasuryLoading && <p className="wallet-vault-caption" role="status"><RefreshCw size={14} /> Reading the configured treasury from TRON Mainnet…</p>}
        {serverTreasuryReadiness && (
          <>
            <div className="wallet-vault-review-grid">
              <div className="wallet-vault-review-wide">
                <small>Server treasury address</small>
                {ADDRESS_PATTERN.test(String(serverTreasuryReadiness.treasuryAddress || ''))
                  ? <a href={explorerUrl('mainnet', String(serverTreasuryReadiness.treasuryAddress))} target="_blank" rel="noopener noreferrer">{serverTreasuryReadiness.treasuryAddress} ↗</a>
                  : <strong>Not verified</strong>}
              </div>
              <div><small>Backend preflight flag (informational)</small><strong>{serverTreasuryReadiness.withdrawalsEnabled === true ? 'Passed — execution still disabled' : 'Not passed — execution disabled'}</strong></div>
              <div><small>Verified official USDT</small><strong>{typeof serverTreasuryReadiness.treasuryUsdtBalanceBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.treasuryUsdtBalanceBaseUnits) ? formatUnits(serverTreasuryReadiness.treasuryUsdtBalanceBaseUnits, 6) + ' USDT' : 'Unavailable'}</strong></div>
              <div><small>Verified treasury TRX</small><strong>{typeof serverTreasuryReadiness.treasuryTrxBalanceSun === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.treasuryTrxBalanceSun) ? formatUnits(serverTreasuryReadiness.treasuryTrxBalanceSun, 6) + ' TRX' : 'Unavailable'}</strong></div>
            </div>
            {Array.isArray(serverTreasuryReadiness.payoutBlockers) && serverTreasuryReadiness.payoutBlockers.length > 0 && (
              <p className="wallet-vault-risk-note" role="status"><strong>Withdrawal blockers:</strong> {serverTreasuryReadiness.payoutBlockers.map((item: string) => item.replaceAll('-', ' ')).join('; ')}</p>
            )}
            {Array.isArray(serverTreasuryReadiness.configuration?.missing) && serverTreasuryReadiness.configuration.missing.length > 0 && (
              <p className="wallet-vault-risk-note" role="status"><strong>Backend settings missing:</strong> {serverTreasuryReadiness.configuration.missing.join(', ')}</p>
            )}
          </>
        )}
        {!serverTreasuryReadiness && !ownerTreasuryLoading && (
          <p className="wallet-vault-caption">Live treasury status is not available yet. Check owner-console configuration, the backend database, allowed app origin, and TRON provider access.</p>
        )}
        {ownerTreasuryError && <p className="wallet-vault-risk-note" role="alert">{ownerTreasuryError}</p>}
        <p className="wallet-vault-caption">Backend-managed configuration and readiness refresh automatically every 30 seconds and when this tab regains focus. Execution is enabled only when live preflight, sponsor release authorization, owner authorization, recipient policy, balances and budgets all pass; missing sponsor credentials or approvals remain explicit blockers.</p>
      </section>


      <section className="wallet-vault-panel wallet-vault-quick-actions" aria-labelledby="wallet-vault-quick-actions-heading" hidden={activePanel !== 'dashboard'}>
        <div className="wallet-vault-panel-head">
          <span className="wallet-vault-step"><Activity size={16} /></span>
          <div><h2 id="wallet-vault-quick-actions-heading">Workspace shortcuts</h2><p>Open a section directly. Each workflow reports real wallet or backend status before sensitive actions.</p></div>
        </div>
        <div className={'wallet-vault-api-health is-' + apiHealthStatus} role="status" aria-live="polite">
          <span className="wallet-vault-api-health-dot" aria-hidden="true" />
          <div className="wallet-vault-api-health-copy">
            <strong>{apiHealthStatus === 'online' ? 'Backend API online' : apiHealthStatus === 'offline' ? 'Backend API unavailable' : 'Checking backend API…'}</strong>
            <small>{apiHealthCheckedAt ? 'Last checked ' + new Date(apiHealthCheckedAt).toLocaleTimeString() : 'Waiting for first health response'}</small>
            {apiHealthError && <small className="wallet-vault-api-health-error">{apiHealthError}</small>}
          </div>
          <button type="button" className="wallet-vault-secondary wallet-vault-api-health-refresh" disabled={apiHealthLoading} onClick={() => void checkApiHealth()}>{apiHealthLoading ? 'Checking…' : 'Refresh connection'}</button>
        </div>
        <div className="wallet-vault-quick-action-grid">
          <button type="button" className="wallet-vault-quick-action" onClick={() => navigatePanel('wallet')}><Coins size={20} /><span><strong>Assets</strong><small>Check verified balances and token details</small></span></button>
          <button type="button" className="wallet-vault-quick-action" onClick={() => navigatePanel('send')}><Send size={20} /><span><strong>Send</strong><small>Choose TRX or a verified TRC-20 token</small></span></button>
          <button type="button" className="wallet-vault-quick-action" onClick={() => navigatePanel('treasury')}><Landmark size={20} /><span><strong>Organization payouts</strong><small>Review real funding and payout blockers</small></span></button>
        </div>
      </section>

      <section className="wallet-vault-panel wallet-vault-settings-panel" hidden={activePanel !== 'settings'}>
        <div className="wallet-vault-panel-head"><span className="wallet-vault-step"><Settings size={16} /></span><div><h2>Settings</h2><p>These values reflect server configuration and chain reads; controls here do not pretend to change Render settings.</p></div></div>
        <div className="wallet-vault-settings-grid">
          <article className="wallet-vault-setting-card">
            <div className="wallet-vault-setting-card-title"><Landmark size={18} /><div><strong>Public treasury address</strong><small>Read-only monitoring</small></div></div>
            <p>{ADDRESS_PATTERN.test(String(serverTreasuryReadiness?.treasuryAddress || '')) ? serverTreasuryReadiness.treasuryAddress : 'No public treasury address is configured.'}</p>
            <span className={'wallet-vault-state-pill ' + (ADDRESS_PATTERN.test(String(serverTreasuryReadiness?.treasuryAddress || '')) ? 'is-ready' : 'is-blocked')}>{ADDRESS_PATTERN.test(String(serverTreasuryReadiness?.treasuryAddress || '')) ? 'Address configured' : 'Not configured'}</span>
          </article>
          <article className="wallet-vault-setting-card">
            <div className="wallet-vault-setting-card-title"><ShieldCheck size={18} /><div><strong>Organization payout provider</strong><small>Backend-enforced readiness</small></div></div>
            <p>Mainnet USDT execution is gated by a time-limited sponsor signature, the owner release switch, live Fireblocks funding checks, and a separate per-transfer owner signature.</p>
            <span className={'wallet-vault-state-pill ' + (serverTreasuryReadiness?.executionEnabled === true ? 'is-ready' : 'is-blocked')}>{serverTreasuryReadiness?.executionEnabled === true ? 'Release and preflight passed' : 'Sponsor release or preflight missing'}</span>
          </article>
          <article className="wallet-vault-setting-card">
            <div className="wallet-vault-setting-card-title"><Wallet size={18} /><div><strong>Local wallet security</strong><small>Owner-controlled keys</small></div></div>
            <p>This build does not use a local wallet key to authorize or submit third-party treasury payments. Treasury custody and any future payout operation must remain with the organization's authorized operators.</p>
          </article>
          <article className="wallet-vault-setting-card">
            <div className="wallet-vault-setting-card-title"><Settings size={18} /><div><strong>Network</strong><small>Current read target</small></div></div>
            <p>{network === 'mainnet' ? 'TRON Mainnet' : network === 'nile' ? 'Nile Testnet' : 'Shasta Testnet'} · balances are separate per network.</p>
            <div className="wallet-vault-network wallet-vault-network--settings" role="group" aria-label="Blockchain network settings">
              {(['mainnet', 'nile', 'shasta'] as NetworkId[]).map(item => (
                <button type="button" key={item} className={network === item ? 'is-selected' : ''} aria-pressed={network === item} onClick={() => {
                  setNetwork(item)
                  setNotice('Network changed. Balances are read separately from the selected TRON network.')
                }}>{item === 'mainnet' ? 'Mainnet' : item === 'nile' ? 'Nile' : 'Shasta'}</button>
              ))}
            </div>
            <button type="button" className="wallet-vault-secondary" onClick={() => navigatePanel('treasury')}>Open payout status</button>
          </article>
        </div>
        <div className="wallet-vault-transfer-warning" role="note"><strong>Verified balances only</strong><p>Displayed balances come from chain reads. No local generator or hidden setting creates official USDT or alters external exchange balances.</p></div>
      </section>

      <section className="wallet-vault-panel wallet-vault-locked-treasury" hidden={activePanel !== 'treasury' || Boolean(unlocked)}>
        <div className="wallet-vault-panel-head"><span className="wallet-vault-step"><Landmark size={16} /></span><div><h2>Public treasury monitoring</h2><p>Balances load from the configured backend watch address. Monitoring is read-only and does not authorize spending.</p></div></div>
        <div className="wallet-vault-review-grid">
          <div className="wallet-vault-review-wide"><small>Configured watch address</small>{ADDRESS_PATTERN.test(String(monitoredTreasuryAddress)) ? <a href={explorerUrl('mainnet', String(monitoredTreasuryAddress))} target="_blank" rel="noopener noreferrer">{monitoredTreasuryAddress} ↗</a> : <strong>Not configured</strong>}</div>
          <div><small>Read-only official USDT balance</small><strong>{headerTreasuryUsdt} USDT</strong></div>
          <div><small>Read-only TRX balance</small><strong>{headerTreasuryTrx} TRX</strong></div>
          <div><small>Application payout execution</small><strong>{serverTreasuryReadiness?.executionEnabled === true ? 'Enabled after sponsor release and all preflight checks' : serverTreasuryReadiness?.releaseAuthorization?.reason || serverTreasuryReadiness?.executionBlocker || 'Not authorized'}</strong></div>
        </div>
        {Array.isArray(serverTreasuryReadiness?.payoutBlockers) && serverTreasuryReadiness.payoutBlockers.length > 0 && <p className="wallet-vault-risk-note" role="status"><strong>Current blockers:</strong> {serverTreasuryReadiness.payoutBlockers.map((item: string) => item.replaceAll('-', ' ')).join('; ')}</p>}
        {ownerTreasuryError && <p className="wallet-vault-risk-note" role="alert">{ownerTreasuryError}</p>}
        <p className="wallet-vault-caption">A treasury organization may control its own funds independently of this app. This build does not accept or execute treasury payout requests; the read-only balance display is not a withdrawal authorization.</p>
        <button type="button" className="wallet-vault-primary" onClick={() => navigatePanel('account')}><UserRound size={16} /> Review read-only owner status</button>
      </section>

      <section className="wallet-vault-panel wallet-vault-sponsor-route-intro" aria-labelledby="wallet-vault-sponsor-route-heading" hidden={activePanel !== 'treasury'}>
        <div className="wallet-vault-panel-head">
          <span className="wallet-vault-step"><Landmark size={16} /></span>
          <div>
            <h2 id="wallet-vault-sponsor-route-heading">Organization-funded payouts · separate funding source</h2>
            <p>This page never spends the personal wallet's USDT. A sponsor-owned Fireblocks vault supplies the actual on-chain USDT and fee assets under the organization's approval policy.</p>
          </div>
        </div>
        <div className="wallet-vault-transfer-warning" role="note">
          <strong>Production execution is blocked in this source build</strong>
          <p>Provider configuration, database records, positive balances and sponsor signatures cannot override the immutable server execution lock. No Mainnet transfer can be submitted from this build. This page provides status, reconciliation and a controlled organization handoff only.</p>
        </div>
        <div className="wallet-vault-review-grid">
          <div><small>Current server execution state</small><strong>{serverTreasuryReadiness?.executionBlocker || 'Readiness not yet loaded'}</strong></div>
          <div><small>Organization reference</small><strong>{sponsorOrganizationReferencePresent ? 'Reference present · approval not independently proven' : 'Not configured'}</strong></div>
          <div><small>Sponsor agreement reference</small><strong>{sponsorAgreementReferencePresent ? 'Reference present · authenticity not independently proven' : 'Not configured'}</strong></div>
          <div><small>Database ledger</small><strong>{treasuryDatabaseReady ? 'Backend reports ready' : 'Not verified / unavailable'}</strong></div>
          <div><small>Read-only Fireblocks identity</small><strong>{fireblocksReadOnlyIdentityReady ? 'Backend credentials configured' : 'Not configured / not verified'}</strong></div>
          <div><small>Provider asset identity</small><strong>{fireblocksAssetIdentityReady ? 'Official USDT and native TRX metadata checks passed' : 'Not verified'}</strong></div>
          <div><small>Complete provider history</small><strong>{sponsorHistoryReady ? 'Reconciliation verified' : 'Not verified / incomplete'}</strong></div>
          <div><small>Sponsor release signature</small><strong>{sponsorReleaseReady ? 'Signature verified by backend' : 'Not authorized'}</strong></div>
        </div>
      </section>

      <section className="wallet-vault-panel wallet-vault-fireblocks-setup" aria-labelledby="fireblocks-setup-heading" hidden={activePanel !== 'treasury'}>
        <div className="wallet-vault-panel-head">
          <span className="wallet-vault-step"><Landmark size={16} /></span>
          <div>
            <h2 id="fireblocks-setup-heading">Fireblocks treasury setup</h2>
            <p>Organization-admin controlled setup and read-only configuration status. This page does not create or authorize a custody account.</p>
          </div>
        </div>
        <section className="wallet-vault-transfer-section" aria-labelledby="sponsor-organization-handoff-heading">
          <div className="wallet-vault-panel-head">
            <span className="wallet-vault-step">01–08</span>
            <div>
              <h3 id="sponsor-organization-handoff-heading">Organization approval and configuration handoff</h3>
              <p>Track each prerequisite using backend/provider evidence. A reference entered into the application is not proof that the sponsor organization approved it.</p>
            </div>
          </div>
          <ol className="wallet-vault-handoff-list">
            <li><strong>Organization authority and mandate</strong><span>{sponsorOrganizationReferencePresent && sponsorAgreementReferencePresent ? 'Sponsor references are present; the organization must still confirm the signed mandate and scope independently.' : 'Waiting for the sponsor organization’s authorized representative to provide the real organization and signed agreement references.'}</span></li>
            <li><strong>Fireblocks read-only API identity</strong><span>{fireblocksReadOnlyIdentityReady ? 'The backend reports read-only credentials configured.' : 'The sponsor must issue a dedicated read-only API identity and backend-mounted RSA authentication file.'}</span></li>
            <li><strong>Production vault and asset mapping</strong><span>{fireblocksAssetIdentityReady && fireblocksVaultAddressReady ? 'USDT/TRX metadata and the provider vault address checks passed.' : 'The organization must create the production TRON vault, enable official USDT and native TRX, then verify both asset IDs and matching addresses.'}</span></li>
            <li><strong>Persistent withdrawal ledger</strong><span>{treasuryDatabaseReady ? 'The withdrawal readiness endpoint reports the ledger database ready.' : 'The backend database/ledger is not verified. No reservation or payout is allowed while this check is missing.'}</span></li>
            <li><strong>Exact agreement and recipient policy</strong><span>{sponsorConfig?.sponsorAgreementScopeApproved === true && sponsorRecipientPolicyReady ? 'Exact Mainnet USDT agreement scope and recipient policy checks passed.' : 'The exact Mainnet USDT sponsor scope and independent recipient allowlist/signer policy remain incomplete.'}</span></li>
            <li><strong>Principal budget and genuine funding</strong><span>{sponsorBudgetReady && sponsorPrincipalReady ? 'The remaining sponsor commitment and provider/on-chain USDT balances passed their current checks.' : 'The sponsor must approve a real principal commitment and fund the vault with genuine USDT; provider and chain balances must both be positive and reconcile.'}</span></li>
            <li><strong>Network-fee reserve and complete outflow history</strong><span>{sponsorFeeReady && sponsorHistoryReady ? 'Provider TRX fee coverage and complete outbound-history reconciliation passed.' : 'The organization must fund sufficient native TRX and complete a fresh Fireblocks outbound-history reconciliation.'}</span></li>
            <li><strong>Sponsor release and independent security review</strong><span>{sponsorReleaseReady ? 'The backend reports an unexpired sponsor release signature; the source-build execution lock still blocks broadcast.' : 'An authorized sponsor signer must approve the exact release message after independent custody, policy and security review.'}</span></li>
          </ol>
          <div className="wallet-vault-transfer-warning" role="note">
            <strong>What can load automatically, and what cannot</strong>
            <p>Read-only Fireblocks vault/asset discovery, backend readiness, chain balances, withdrawal-ledger reservations and reconciliation snapshots can be refreshed by the application. Sponsor-issued API credentials/private RSA files, the legal agreement, organization approval, vault creation and actual funding cannot be generated by this app. The current treasury configuration still reads sensitive provider credentials and several policy/limit values from backend environment settings; the database is used for the durable ledger and reconciliation, not as a magic source for missing sponsor facts.</p>
          </div>
          <p className="wallet-vault-caption">Never paste private keys, API secrets, RSA keys or recovery phrases into this page. The configuration template below contains placeholders only; use the organization’s secured backend administration process for actual provider credentials. <a href="https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/blob/feat/owner-mainnet-withdrawal-guided-ui-20261102/docs/SPONSOR_ORGANIZATION_HANDOFF.md" target="_blank" rel="noopener noreferrer">Open the sponsor organization handoff guide ↗</a></p>
        </section>

        <div className="wallet-vault-transfer-warning" role="note">
          <strong>External organization approval is required</strong>
          <p>The actual treasury-owning organization’s authorized adult representative, treasurer, and security administrator must complete Fireblocks onboarding, approve the application in writing, create the production workspace and vault, set transaction policies, and fund the vault. A Tron Token Studio login, wallet signature, or value entered in a form is not proof of that authority.</p>
          <p>This interface deliberately has no Fireblocks API-key, RSA-private-key, recovery-phrase, or identity-document fields. It cannot create an organization, API user, vault, approval quorum, or funding transaction.</p>
        </div>
        <div className="wallet-vault-transfer-section">
          <h3>Backend configuration refresh</h3>
          <p>The owner console automatically reloads backend funding, payout readiness, saved inventory, Fireblocks discovery and outbound-history status every 30 seconds while visible, and when the app regains focus. Use this control to request an immediate read-only refresh.</p>
          <button type="button" className="wallet-vault-secondary"
            disabled={ownerTreasuryLoading}
            onClick={refreshBackendTreasuryConfigurationNow}>
            <RefreshCw size={15} />
            {ownerTreasuryLoading ? 'Refreshing backend configuration…' : 'Refresh backend configuration now'}
          </button>
        </div>
        <div className="wallet-vault-transfer-section" aria-labelledby="fireblocks-discovery-heading">
          <h3 id="fireblocks-discovery-heading">Automatic Fireblocks configuration discovery</h3>
          <p>The backend queries the authorized workspace for vaults and asset metadata. This read-only check refreshes with the owner dashboard; it does not create a vault, change backend settings, approve a sponsor, or enable withdrawals.</p>
          {fireblocksDiscoveryError && <p className="wallet-vault-risk-note" role="alert">{fireblocksDiscoveryError}</p>}
          {!fireblocksDiscoverySnapshot && !fireblocksDiscoveryError && <p className="wallet-vault-caption">Waiting for the backend discovery response…</p>}
          {fireblocksDiscoverySnapshot && <>
            <div className="wallet-vault-review-grid">
              <div><small>Discovery status</small><strong>{fireblocksDiscoverySnapshot.discoveryStatus || 'Not available'}</strong></div>
              <div><small>Last checked</small><strong>{fireblocksDiscoverySnapshot.checkedAt ? new Date(fireblocksDiscoverySnapshot.checkedAt).toLocaleString() : 'Not recorded'}</strong></div>
              <div><small>Fireblocks API origin</small><strong>{fireblocksDiscoverySnapshot.configuration?.apiBase || 'Not resolved'}</strong></div>
              <div><small>Workspace credentials</small><strong>{fireblocksDiscoverySnapshot.configuration?.credentialsConfigured ? 'Available to backend' : 'Not configured'}</strong></div>
              <div><small>Vaults discovered</small><strong>{fireblocksDiscoverySnapshot.candidateVaults?.length ?? 0} qualifying candidate(s)</strong></div>
              <div><small>Official USDT assets</small><strong>{fireblocksDiscoverySnapshot.officialUsdtAssets?.length ?? 0} verified metadata match(es)</strong></div>
              <div><small>Native TRX assets</small><strong>{fireblocksDiscoverySnapshot.nativeTrxAssets?.length ?? 0} verified metadata match(es)</strong></div>
              <div><small>Automatic suggestion</small><strong>{fireblocksDiscoverySnapshot.suggestedConfiguration ? 'One unambiguous provider address pair found' : 'Manual sponsor review required'}</strong></div>
            </div>
            {(fireblocksDiscoverySnapshot.configuration?.credentialsMissing || []).length > 0 && (
              <p className="wallet-vault-risk-note" role="status"><strong>Backend-only prerequisites:</strong> {fireblocksDiscoverySnapshot.configuration?.credentialsMissing?.join(', ')}. Do not put these credentials in this browser page.</p>
            )}
            {fireblocksDiscoverySnapshot.suggestedConfiguration && (
              <div className="wallet-vault-review-grid">
                <div><small>Discovered vault account ID</small><strong>{fireblocksDiscoverySnapshot.suggestedConfiguration.vaultAccountId}</strong></div>
                <div><small>Discovered official USDT asset ID</small><strong>{fireblocksDiscoverySnapshot.suggestedConfiguration.usdtAssetId}</strong></div>
                <div><small>Discovered native TRX asset ID</small><strong>{fireblocksDiscoverySnapshot.suggestedConfiguration.trxAssetId}</strong></div>
                <div className="wallet-vault-review-wide"><small>Matching Fireblocks TRON address</small><strong>{fireblocksDiscoverySnapshot.suggestedConfiguration.treasuryAddress}</strong></div>
              </div>
            )}
            {(fireblocksDiscoverySnapshot.candidateVaults || []).map((candidate) => (
              <div className="wallet-vault-review-grid" key={candidate.vaultAccountId}>
                <div><small>Candidate vault</small><strong>{candidate.name || 'Unnamed vault'} · ID {candidate.vaultAccountId}</strong></div>
                <div><small>Active official USDT assets</small><strong>{candidate.officialUsdtAssetIds.join(', ') || 'None'}</strong></div>
                <div><small>Active native TRX assets</small><strong>{candidate.nativeTrxAssetIds.join(', ') || 'None'}</strong></div>
                <div><small>Shared provider address</small><strong>{candidate.unambiguousAddressPair ? candidate.treasuryAddressCandidate : 'Not uniquely verified'}</strong></div>
              </div>
            ))}
            {fireblocksDiscoverySnapshot.discoveryTruncated === true && <p className="wallet-vault-risk-note" role="status">Discovery reached its safety page/probe limit. Results are partial; no automatic suggestion is authorized.</p>}
            <p className="wallet-vault-caption">{fireblocksDiscoverySnapshot.note || 'Provider discovery is informational. A suggested configuration is not an approved source of funds.'}</p>
          </>}
        </div>
        <div className="wallet-vault-transfer-section" aria-labelledby="fireblocks-outbound-history-heading">
          <h3 id="fireblocks-outbound-history-heading">External vault outflow reconciliation</h3>
          <p>The backend reads the complete Fireblocks vault transaction history using the separate read-only Viewer identity. Unmatched USDT/TRX transfers and verified vault-paid fees are reconciled against this app’s withdrawal ledger. This operation never submits or signs a transaction.</p>
          {fireblocksOutboundHistoryError && <p className="wallet-vault-risk-note" role="alert">{fireblocksOutboundHistoryError}</p>}
          <div className="wallet-vault-review-grid">
            <div><small>Reconciliation status</small><strong>{fireblocksOutboundHistorySnapshot?.verified === true ? 'Complete and fresh' : fireblocksOutboundHistorySnapshot?.status === 'scanning' ? 'Scanning — more pages required' : fireblocksOutboundHistorySnapshot?.status === 'blocked' ? 'Blocked — manual review required' : 'Not verified'}</strong></div>
            <div><small>Last complete scan</small><strong>{fireblocksOutboundHistorySnapshot?.checkedAt ? new Date(fireblocksOutboundHistorySnapshot.checkedAt).toLocaleString() : 'Not recorded'}</strong></div>
            <div><small>Provider transactions</small><strong>{fireblocksOutboundHistorySnapshot?.transactionCount ?? '—'}</strong></div>
            <div><small>Unmatched external USDT outflows</small><strong>{fireblocksOutboundHistorySnapshot?.verified === true && typeof fireblocksOutboundHistorySnapshot.externalUsdtBaseUnits === 'string' ? formatUnits(fireblocksOutboundHistorySnapshot.externalUsdtBaseUnits, 6) + ' USDT' : 'Not verified'}</strong></div>
            <div><small>Unmatched external TRX outflows</small><strong>{fireblocksOutboundHistorySnapshot?.verified === true && typeof fireblocksOutboundHistorySnapshot.externalTrxBaseUnits === 'string' ? formatUnits(fireblocksOutboundHistorySnapshot.externalTrxBaseUnits, 6) + ' TRX' : 'Not verified'}</strong></div>
            <div><small>Vault-paid network fees</small><strong>{fireblocksOutboundHistorySnapshot?.verified === true && typeof fireblocksOutboundHistorySnapshot.networkFeeTrxBaseUnits === 'string' ? formatUnits(fireblocksOutboundHistorySnapshot.networkFeeTrxBaseUnits, 6) + ' TRX' : 'Not verified'}</strong></div>
          </div>
          {fireblocksOutboundHistorySnapshot?.reason && <p className="wallet-vault-risk-note" role="status"><strong>History blocker:</strong> {String(fireblocksOutboundHistorySnapshot.reason).replaceAll('-', ' ')}</p>}
          {fireblocksOutboundHistorySnapshot?.nextAction && <p className="wallet-vault-caption">{fireblocksOutboundHistorySnapshot.nextAction}</p>}
          <button
            type="button"
            className="wallet-vault-secondary"
            disabled={fireblocksOutboundHistoryBusy}
            onClick={async () => {
              if (fireblocksOutboundHistoryBusy) return
              setFireblocksOutboundHistoryBusy(true)
              setFireblocksOutboundHistoryError('')
              try {
                let token = ownerSessionToken
                try {
                  token = token || window.sessionStorage.getItem(OWNER_CONSOLE_SESSION_KEY) || ''
                } catch {
                  // Use the in-memory owner token when browser storage is unavailable.
                }
                if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
                  throw new Error('An authenticated Mainnet owner session is required to synchronize Fireblocks history.')
                }
                const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token }
                const syncResponse = await fetch(API_BASE + '/api/treasury/fireblocks/outbound-history/sync', {
                  method: 'POST', headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
                })
                const syncPayload = await syncResponse.json().catch(() => null)
                if (syncPayload && typeof syncPayload === 'object') {
                  setFireblocksOutboundHistorySnapshot(syncPayload)
                }
                if ((!syncResponse.ok && syncResponse.status !== 202) || syncPayload?.success !== true) {
                  const blockers = Array.isArray(syncPayload?.blockers) ? ': ' + syncPayload.blockers.join(', ') : ''
                  throw new Error((syncPayload?.error || 'Fireblocks outbound-history synchronization failed.') + blockers)
                }
                const statusResponse = await fetch(API_BASE + '/api/treasury/fireblocks/outbound-history/status', {
                  headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
                })
                const statusPayload = await statusResponse.json().catch(() => null)
                if (!statusResponse.ok || statusPayload?.success !== true) {
                  throw new Error(statusPayload?.error || 'The latest outbound-history status could not be read.')
                }
                setFireblocksOutboundHistorySnapshot(statusPayload)
                const readinessResponse = await fetch(API_BASE + '/api/treasury/withdrawals/readiness', {
                  headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
                })
                const readinessPayload = await readinessResponse.json().catch(() => null)
                if (readinessResponse.ok && readinessPayload?.success === true) {
                  setServerTreasuryReadiness(readinessPayload)
                }
                if (syncPayload.status === 'scanning' || statusPayload.status === 'scanning') {
                  setFireblocksOutboundHistoryError('The scan is incomplete. Use Continue history scan until the backend reports a fresh complete reconciliation.')
                } else if (statusPayload.verified !== true) {
                  setFireblocksOutboundHistoryError('The provider history scan did not pass reconciliation. Payout readiness remains blocked.')
                }
              } catch (caught) {
                setFireblocksOutboundHistoryError(caught instanceof Error ? caught.message : 'Fireblocks history synchronization is unavailable.')
              } finally {
                setFireblocksOutboundHistoryBusy(false)
              }
            }}
          >
            <RefreshCw size={15} />
            {fireblocksOutboundHistoryBusy ? 'Synchronizing history…' : fireblocksOutboundHistorySnapshot?.status === 'scanning' ? 'Continue history scan' : 'Synchronize complete vault history'}
          </button>
          <p className="wallet-vault-caption">Each request processes at most 20 pages. Large workspaces require repeated syncs until status is complete. A completed scan is a point-in-time reconciliation, not a lock preventing later transfers from the Fireblocks Console.</p>
          <p className="wallet-vault-caption">A complete history scan is mandatory for payout readiness. Manual Fireblocks transfers reduce sponsor principal; unresolved or ambiguous history blocks new payouts. Fireblocks transaction policy and independent approval remain separate controls.</p>
        </div>
        <div className="wallet-vault-transfer-section" aria-labelledby="fireblocks-inventory-heading">
          <h3 id="fireblocks-inventory-heading">Automatically refreshed Fireblocks inventory evidence</h3>
          <p>This panel shows the latest backend-saved read-only inventory result. The owner console refreshes status automatically; the optional GitHub workflow is an audit/export tool, not a requirement for reading current readiness. It never sends funds or changes Fireblocks permissions.</p>
          <p className="wallet-vault-caption">
            <a href="https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/workflows/fireblocks-inventory-sync.yml" target="_blank" rel="noopener noreferrer">Open optional read-only inventory audit workflow ↗</a>
          </p>
          {fireblocksInventoryError && <p className="wallet-vault-risk-note" role="alert">{fireblocksInventoryError}</p>}
          {!fireblocksInventorySnapshot && <p className="wallet-vault-caption">No saved inventory snapshot has been returned yet. Live readiness is displayed separately; a missing snapshot is not proof that the vault is funded or configured.</p>}
          {fireblocksInventorySnapshot && <>
            <div className="wallet-vault-review-grid">
              <div>
                <small>Latest inventory result</small>
                <strong>{fireblocksInventorySnapshot.verificationStatus === 'verified' ? 'All read-only inventory checks passed' : fireblocksInventorySnapshot.verificationStatus === 'blocked' ? 'Blocked — review diagnostics' : 'Status unavailable'}</strong>
              </div>
              <div>
                <small>Checked at</small>
                <strong>{fireblocksInventorySnapshot.checkedAt ? new Date(fireblocksInventorySnapshot.checkedAt).toLocaleString() : 'Not recorded'}</strong>
              </div>
              <div>
                <small>GitHub workflow run</small>
                <strong>{fireblocksInventorySnapshot.workflowRunId || 'Not recorded'}{fireblocksInventorySnapshot.workflowRunAttempt ? ' · attempt ' + fireblocksInventorySnapshot.workflowRunAttempt : ''}</strong>
                {fireblocksInventorySnapshot.workflowRunUrl && <a href={fireblocksInventorySnapshot.workflowRunUrl} target="_blank" rel="noopener noreferrer">Open run details ↗</a>}
              </div>
              <div>
                <small>Vault account ID</small>
                <strong>{fireblocksInventorySnapshot.configuration?.vaultAccountId || 'Not configured'}</strong>
              </div>
              <div>
                <small>Fireblocks USDT asset ID</small>
                <strong>{fireblocksInventorySnapshot.configuration?.usdtAssetId || 'Not configured'}</strong>
              </div>
              <div>
                <small>Fireblocks TRX asset ID</small>
                <strong>{fireblocksInventorySnapshot.configuration?.trxAssetId || 'Not configured'}</strong>
              </div>
              <div className="wallet-vault-review-wide">
                <small>Verified treasury address</small>
                <strong>{fireblocksInventorySnapshot.configuration?.treasuryAddress || 'Not verified'}</strong>
              </div>
              <div>
                <small>Fireblocks available USDT</small>
                <strong>{fireblocksInventorySnapshot.balances?.fireblocksUsdtAvailableBaseUnits !== null && fireblocksInventorySnapshot.balances?.fireblocksUsdtAvailableBaseUnits !== undefined ? formatUnits(fireblocksInventorySnapshot.balances.fireblocksUsdtAvailableBaseUnits, 6) + ' USDT' : 'Unavailable'}</strong>
              </div>
              <div>
                <small>TRON-chain USDT</small>
                <strong>{fireblocksInventorySnapshot.balances?.chainUsdtBalanceBaseUnits !== null && fireblocksInventorySnapshot.balances?.chainUsdtBalanceBaseUnits !== undefined ? formatUnits(fireblocksInventorySnapshot.balances.chainUsdtBalanceBaseUnits, 6) + ' USDT' : 'Unavailable'}</strong>
              </div>
              <div>
                <small>Fireblocks available TRX</small>
                <strong>{fireblocksInventorySnapshot.balances?.fireblocksTrxAvailableBaseUnits !== null && fireblocksInventorySnapshot.balances?.fireblocksTrxAvailableBaseUnits !== undefined ? formatUnits(fireblocksInventorySnapshot.balances.fireblocksTrxAvailableBaseUnits, 6) + ' TRX' : 'Unavailable'}</strong>
              </div>
              <div>
                <small>TRON-chain TRX</small>
                <strong>{fireblocksInventorySnapshot.balances?.chainTrxBalanceSun !== null && fireblocksInventorySnapshot.balances?.chainTrxBalanceSun !== undefined ? formatUnits(fireblocksInventorySnapshot.balances.chainTrxBalanceSun, 6) + ' TRX' : 'Unavailable'}</strong>
              </div>
            </div>
            <h4>Inventory check results</h4>
            <div className="wallet-vault-review-grid">
              {Object.entries(fireblocksInventorySnapshot.checks || {}).map(([name, passed]) => (
                <div key={name}>
                  <small>{name.replaceAll(/([A-Z])/g, ' $1').replaceAll('-', ' ')}</small>
                  <strong>{passed === true ? 'Passed' : passed === false ? 'Failed' : 'Not checked'}</strong>
                </div>
              ))}
            </div>
            {(fireblocksInventorySnapshot.reasons || []).length > 0 && <p className="wallet-vault-risk-note" role="status"><strong>Blockers:</strong> {fireblocksInventorySnapshot.reasons?.map((item) => item.replaceAll('-', ' ')).join('; ')}</p>}
            <p className="wallet-vault-caption">A verified inventory run confirms read-only asset and balance checks only. It is not organization approval, payout authorization, transaction signing, or proof that an exchange credited a deposit. Live Render deployment remains separately hard-locked until the reviewed PR stack and external release prerequisites are completed.</p>
          </>}
        </div>
        <div className="wallet-vault-transfer-section" aria-label="Third-party sponsor source consent and deposit verification">
          <ThirdPartyFundingPanel
            apiBase={API_BASE}
            sessionToken={ownerSessionToken}
            inventoryVerified={fireblocksInventorySnapshot?.verificationStatus === 'verified'}
            inventoryCheckedAt={fireblocksInventorySnapshot?.checkedAt || null}
            expectedSponsorOrganizationReference={serverTreasuryReadiness?.sponsorPrincipalBudget?.organizationReference || ''}
            expectedAgreementReference={serverTreasuryReadiness?.sponsorPrincipalBudget?.agreementReference || ''}
          />
        </div>
        <div className="wallet-vault-review-grid" aria-label="Sponsor funding target and verified payout capacity">
          <div>
            <small>Requested sponsor funding target · planning only</small>
            <strong>100,000 USDT</strong>
            <p className="wallet-vault-caption">A requested target, not a sponsor commitment, token balance or available asset.</p>
          </div>
          <div>
            <small>Verified TRON Mainnet USDT balance</small>
            <strong>{typeof serverTreasuryReadiness?.treasuryUsdtBalanceBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.treasuryUsdtBalanceBaseUnits) ? formatUnits(serverTreasuryReadiness.treasuryUsdtBalanceBaseUnits, 6) + ' USDT' : 'Not verified'}</strong>
          </div>
          <div>
            <small>Fireblocks available USDT</small>
            <strong>{typeof serverTreasuryReadiness?.providerAvailableUsdtBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.providerAvailableUsdtBaseUnits) ? formatUnits(serverTreasuryReadiness.providerAvailableUsdtBaseUnits, 6) + ' USDT' : 'Not verified'}</strong>
          </div>
          <div>
            <small>Remaining gap to 100,000 USDT planning target</small>
            <strong>{sponsorPlanningFundingGapBaseUnits !== null ? formatUnits(sponsorPlanningFundingGapBaseUnits, 6) + ' USDT' : 'Not verified'}</strong>
            <p className="wallet-vault-caption">Calculated from the lower provider/chain balance before reservations; this is not a debt or a token balance.</p>
          </div>
          <div>
            <small>Outstanding USDT reservations</small>
            <strong>{typeof serverTreasuryReadiness?.outstandingUsdtReservationBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.outstandingUsdtReservationBaseUnits) ? formatUnits(serverTreasuryReadiness.outstandingUsdtReservationBaseUnits, 6) + ' USDT' : 'Not verified'}</strong>
          </div>
          <div>
            <small>Verified funds after reservations</small>
            <strong>{typeof serverTreasuryReadiness?.availableUsdtAfterReservationsBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.availableUsdtAfterReservationsBaseUnits) ? formatUnits(serverTreasuryReadiness.availableUsdtAfterReservationsBaseUnits, 6) + ' USDT' : 'Not verified'}</strong>
          </div>
          <div>
            <small>Remaining sponsor commitment</small>
            <strong>{serverTreasuryReadiness?.sponsorPrincipalBudget?.commitmentCapConsistent === true && typeof serverTreasuryReadiness?.sponsorPrincipalBudget?.remainingBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.sponsorPrincipalBudget.remainingBaseUnits) ? formatUnits(serverTreasuryReadiness.sponsorPrincipalBudget.remainingBaseUnits, 6) + ' USDT' : 'Not verified'}</strong>
          </div>
          <div>
            <small>Verified third-party sponsor USDT principal</small>
            <strong>{typeof serverTreasuryReadiness?.thirdPartyFunding?.verifiedUsdtPrincipalBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.thirdPartyFunding.verifiedUsdtPrincipalBaseUnits) ? formatUnits(serverTreasuryReadiness.thirdPartyFunding.verifiedUsdtPrincipalBaseUnits, 6) + ' USDT' : 'Not verified'}</strong>
            <p className="wallet-vault-caption">{serverTreasuryReadiness?.thirdPartyFunding?.reviewedAuthorizationCount ?? '—'} reviewed sponsor mandate(s) · {serverTreasuryReadiness?.thirdPartyFunding?.verifiedDepositCount ?? '—'} Fireblocks-reconciled deposit(s)</p>
          </div>
          <div>
            <small>Remaining verified sponsor principal after withdrawals</small>
            <strong>{serverTreasuryReadiness?.thirdPartyFunding?.ledgerReady === true && typeof serverTreasuryReadiness.thirdPartyFunding.availablePrincipalBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.thirdPartyFunding.availablePrincipalBaseUnits) ? formatUnits(serverTreasuryReadiness.thirdPartyFunding.availablePrincipalBaseUnits, 6) + ' USDT' : 'Not verified'}</strong>
          </div>
          <div>
            <small>Remaining daily payout allowance</small>
            <strong>{typeof serverTreasuryReadiness?.dailyUsdtRemainingBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.dailyUsdtRemainingBaseUnits) ? formatUnits(serverTreasuryReadiness.dailyUsdtRemainingBaseUnits, 6) + ' USDT' : 'Not verified'}</strong>
          </div>
          <div>
            <small>Funding and limit capacity estimate · not payout readiness</small>
            <strong>{typeof serverTreasuryReadiness?.estimatedEligiblePayoutCapacityBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.estimatedEligiblePayoutCapacityBaseUnits) ? formatUnits(serverTreasuryReadiness.estimatedEligiblePayoutCapacityBaseUnits, 6) + ' USDT' : 'Not verified'}</strong>
            <p className="wallet-vault-caption">This estimate applies balance, reservation, sponsor-commitment, daily and per-payout limits. Fee reserve, organization/recipient policy, Fireblocks approvals and the source release lock are separate gates.</p>
          </div>
          <div>
            <small>Currently withdrawable now</small>
            <strong>{typeof serverTreasuryReadiness?.currentlyWithdrawableBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.currentlyWithdrawableBaseUnits) ? formatUnits(serverTreasuryReadiness.currentlyWithdrawableBaseUnits, 6) + ' USDT' : 'Not verified'}</strong>
            <p className="wallet-vault-caption">The source-build real-value execution lock remains closed; a funding figure is not permission to broadcast.</p>
          </div>
        </div>
        <div className="wallet-vault-review-grid">
          <div>
            <small>Backend configuration fields</small>
            <strong>{serverTreasuryReadiness?.configuration?.configurationComplete === true ? 'Reported complete — not an authorization proof' : 'Not confirmed / incomplete'}</strong>
          </div>
          <div>
            <small>Fireblocks USDT asset identity</small>
            <strong>{serverTreasuryReadiness?.providerAssetIdentityVerified === true ? 'Provider metadata check passed' : 'Not verified'}</strong>
          </div>
          <div>
            <small>Fireblocks native TRX identity</small>
            <strong>{serverTreasuryReadiness?.nativeTrxAssetIdentityVerified === true ? 'Provider metadata check passed' : 'Not verified'}</strong>
          </div>
          <div>
            <small>USDT and TRX vault address match</small>
            <strong>{serverTreasuryReadiness?.providerVaultAddressVerified === true && serverTreasuryReadiness?.nativeTrxVaultAddressVerified === true ? 'Both checks passed' : 'Not verified / mismatch'}</strong>
          </div>
          <div>
            <small>Sponsor organization reference</small>
            <strong>{serverTreasuryReadiness?.sponsorPrincipalBudget?.organizationReference || 'Not configured'}</strong>
          </div>
          <div>
            <small>Sponsor agreement reference</small>
            <strong>{serverTreasuryReadiness?.sponsorPrincipalBudget?.agreementReference || 'Not configured'}</strong>
          </div>
          <div>
            <small>Exact Mainnet USDT sponsor agreement scope</small>
            <strong>{serverTreasuryReadiness?.configuration?.sponsorAgreementScopeApproved === true ? 'Exact allowlist match passed' : 'Missing or mismatched — payouts blocked'}</strong>
          </div>
          <div>
            <small>Principal sponsor destination allowlist</small>
            <strong>{
              serverTreasuryReadiness?.configuration?.recipientApprovalMode === 'sponsor-signed'
                ? `Sponsor-signed destinations · ${serverTreasuryReadiness?.configuration?.sponsorApproverCount || 0} independent signer(s)`
                : serverTreasuryReadiness?.configuration?.recipientApprovalMode === 'mixed'
                  ? `${serverTreasuryReadiness?.configuration?.recipientAllowlistCount || 0} static destinations + ${serverTreasuryReadiness?.configuration?.sponsorApproverCount || 0} sponsor signer(s)`
                  : serverTreasuryReadiness?.configuration?.recipientAllowlistValid === true
                    ? `${serverTreasuryReadiness?.configuration?.recipientAllowlistCount || 0} approved static destinations`
                    : 'Missing or invalid — payouts blocked'
            }</strong>
          </div>
          <div>
            <small>Stored principal commitment cap</small>
            <strong>{serverTreasuryReadiness?.sponsorPrincipalBudget?.commitmentCapConsistent === true ? 'Matches the original agreement cap' : 'Missing or changed — payouts blocked'}</strong>
          </div>
          <div>
            <small>Remaining USDT principal commitment</small>
            <strong>{typeof serverTreasuryReadiness?.sponsorPrincipalBudget?.remainingBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.sponsorPrincipalBudget.remainingBaseUnits) && typeof serverTreasuryReadiness?.sponsorPrincipalBudget?.totalBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.sponsorPrincipalBudget.totalBaseUnits) ? formatUnits(serverTreasuryReadiness.sponsorPrincipalBudget.remainingBaseUnits, 6) + ' / ' + formatUnits(serverTreasuryReadiness.sponsorPrincipalBudget.totalBaseUnits, 6) + ' USDT remaining' : 'Not verified'}</strong>
          </div>
          <div>
            <small>Confirmed and reserved USDT principal</small>
            <strong>{typeof serverTreasuryReadiness?.sponsorPrincipalBudget?.usedAndReservedBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.sponsorPrincipalBudget.usedAndReservedBaseUnits) ? formatUnits(serverTreasuryReadiness.sponsorPrincipalBudget.usedAndReservedBaseUnits, 6) + ' USDT' : 'Not verified'}</strong>
          </div>
          <div>
            <small>Organization approval</small>
            <strong>Not independently verified by this application</strong>
          </div>
          <div>
            <small>Real-value payout execution</small>
            <strong>{canSubmitServerTreasuryPayout ? 'Backend reports enabled and all owner/funding/budget gates passed' : 'Hard-disabled or readiness evidence incomplete'}</strong>
          </div>
        </div>
        <div className="wallet-vault-transfer-section">
          <h3>Required steps for the organization’s administrator</h3>
          <ol>
            <li>Obtain written treasury-owner approval and complete Fireblocks’ organization onboarding for a production Mainnet workspace.</li>
            <li>In Fireblocks Console, create the dedicated TRON treasury vault; enable the official TRON USDT asset and native TRX, then verify their asset IDs, network metadata, and matching TRON vault address.</li>
            <li>Create a dedicated API user through Fireblocks Developer Center with only the permissions approved for the required integration. Complete the organization’s API-user approval quorum.</li>
            <li>Generate the RSA-4096 API-authentication key and CSR in the organization-controlled environment. Keep the private key there; upload it to Render only as a backend Secret File.</li>
            <li>Have the organization’s treasury staff fund the vault with genuine USDT and sufficient native TRX, then independently verify provider balances and on-chain balances.</li>
          </ol>
          <p className="wallet-vault-caption">Useful provider references:
            {' '}<a href="https://fireblocks.readme.io/docs/manage-api-keys" target="_blank" rel="noopener noreferrer">API user and key setup ↗</a>
            {' '}· <a href="https://fireblocks.readme.io/reference/createvaultaccount" target="_blank" rel="noopener noreferrer">Vault-account API reference ↗</a>
            {' '}· <a href="https://fireblocks.readme.io/docs/object-model" target="_blank" rel="noopener noreferrer">Fireblocks object model ↗</a>
          </p>
        </div>
        <div className="wallet-vault-transfer-section">
          <h3>Backend-managed configuration and external prerequisites</h3>
          <p>Non-secret settings already present on the backend load automatically into this owner console. Missing settings are reported by the backend; this frontend does not ask you to type or copy environment values and does not modify Render.</p>
          <p className="wallet-vault-caption">Only the authorized sponsor organization can provision its Fireblocks API identity, RSA secret file, production vault, signed agreement, approved limits, independent sponsor signer addresses and real funding. Those credentials, approvals and funds cannot be generated by this application. Keep private RSA material in the backend Secret File store, never in this browser.</p>
          <p className="wallet-vault-caption">Backend service: <a href="https://dashboard.render.com/web/srv-dbanbem1egvs73bcsdkg" target="_blank" rel="noopener noreferrer">TRON Token Studio API ↗</a>. This owner page only reads backend-provided status.</p>
          {Array.isArray(serverTreasuryReadiness?.configuration?.missing) && serverTreasuryReadiness.configuration.missing.length > 0 && (
            <p className="wallet-vault-risk-note" role="status"><strong>Backend-reported missing prerequisites:</strong> {serverTreasuryReadiness.configuration.missing.join(', ')}</p>
          )}
          {serverTreasuryReadiness?.configuration?.configurationComplete === true
            ? <p className="wallet-vault-caption">The backend reports its syntactic configuration complete. This does not prove sponsor authority, funding or permission to withdraw.</p>
            : <p className="wallet-vault-caption">Backend configuration is incomplete. Missing organization-owned values keep payout readiness blocked.</p>}
        </div>
      </section>

      <section className="wallet-vault-panel wallet-vault-locked-action" hidden={Boolean(unlocked) || (activePanel !== 'wallet' && activePanel !== 'send' && activePanel !== 'activity')}>
        <div className="wallet-vault-panel-head"><span className="wallet-vault-step"><LockKeyhole size={16} /></span><div><h2>{activePanel === 'wallet' ? 'Unlock to view assets' : activePanel === 'send' ? 'Unlock to authorize a transfer' : 'Unlock to verify activity'}</h2><p>This is a private owner console. A public address can be monitored without its private key, but it cannot authorize spending.</p></div></div>
        <p className="wallet-vault-caption">{activePanel === 'send' && transferAsset === 'TRC20' ? 'A genuine USDT transfer requires real USDT at the sender or a separately funded treasury payout.' : 'Open Account to unlock the local signing wallet and continue.'}</p>
        <button type="button" className="wallet-vault-primary" onClick={() => navigatePanel('account')}><UserRound size={16} /> Go to Account</button>
        {activePanel === 'send' && <button type="button" className="wallet-vault-secondary" onClick={() => navigatePanel('treasury')}>Check organization payout funding</button>}
      </section>

      <div className={'wallet-vault-layout' + (activePanel === 'account' ? '' : ' wallet-vault-layout--single')} hidden={activePanel === 'dashboard' || activePanel === 'settings' || (activePanel === 'treasury' && !unlocked) || (!unlocked && activePanel !== 'account')}>
        <section className="wallet-vault-panel wallet-vault-setup" hidden={activePanel !== 'account'}>
          <details className="wallet-vault-setup-details" open={false}>
            <summary className="wallet-vault-panel-head wallet-vault-setup-summary">
              <span className="wallet-vault-step">01</span>
              <div><h2>{records.length === 0 ? 'Create or import' : 'Wallet setup & recovery'}</h2><p>{records.length === 0 ? 'Create or restore the owner wallet on this device.' : 'Collapsed to keep balances and transfer controls in focus.'}</p></div>
            </summary>
          <div className="wallet-vault-mode" role="tablist" aria-label="Wallet setup method">
            <button type="button" role="tab" aria-selected={mode === 'create'} className={mode === 'create' ? 'is-selected' : ''} onClick={() => { setMode('create'); setError(''); setNotice('') }}><Plus size={15} /> Create wallet</button>
            <button type="button" role="tab" aria-selected={mode === 'import-key'} className={mode === 'import-key' ? 'is-selected' : ''} onClick={() => { setMode('import-key'); setError(''); setNotice('') }}><KeyRound size={15} /> Import key</button>
            <button type="button" role="tab" aria-selected={mode === 'restore-backup'} className={mode === 'restore-backup' ? 'is-selected' : ''} onClick={() => { setMode('restore-backup'); setError(''); setNotice('') }}><FileKey2 size={15} /> Restore backup</button>
          </div>

          {mode === 'create' && (
            <div className="wallet-vault-form">
              <p className="wallet-vault-callout">A new random private key is generated on this device using TronWeb. The address is not automatically activated on-chain and has no funds until it receives real assets.</p>
              <label htmlFor="wallet-create-password">Wallet password</label>
              <div className="wallet-vault-password"><input id="wallet-create-password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 12 characters" /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
              <label htmlFor="wallet-create-confirm">Confirm password</label>
              <input id="wallet-create-confirm" type={showPassword ? 'text' : 'password'} autoComplete="new-password" maxLength={128} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="Re-enter wallet password" />
              <button className="wallet-vault-primary" type="button" disabled={busy} onClick={() => void performWalletAction(createWallet)}><Plus size={17} /> {busy ? 'Creating locally…' : 'Generate encrypted wallet'}</button>
            </div>
          )}

          {mode === 'import-key' && (
            <div className="wallet-vault-form">
              <p className="wallet-vault-callout">The private key is processed locally and encrypted before saving. Never paste a wallet key into chat, a support ticket, or a website you do not trust.</p>
              <label htmlFor="wallet-import-key">Private key (hex)</label>
              <textarea id="wallet-import-key" rows={3} autoComplete="off" spellCheck={false} value={privateKeyInput} onChange={event => setPrivateKeyInput(event.target.value)} placeholder="Paste the 64-character key on this device only" />
              <label htmlFor="wallet-import-password">New local encryption password</label>
              <input id="wallet-import-password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" maxLength={128} value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 12 characters" />
              <label htmlFor="wallet-import-confirm">Confirm password</label>
              <input id="wallet-import-confirm" type={showPassword ? 'text' : 'password'} autoComplete="new-password" maxLength={128} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="Re-enter wallet password" />
              <button className="wallet-vault-primary" type="button" disabled={busy} onClick={() => void performWalletAction(importPrivateKey)}><KeyRound size={17} /> {busy ? 'Encrypting locally…' : 'Encrypt and import wallet'}</button>
            </div>
          )}

          {mode === 'restore-backup' && (
            <div className="wallet-vault-form">
              <p className="wallet-vault-callout">Select a TRON Token Studio encrypted wallet JSON backup. The app reads it locally; the password cannot be reset by the server.</p>
              <label htmlFor="wallet-backup-file">Encrypted backup file</label>
              <input id="wallet-backup-file" type="file" accept=".json,application/json" onChange={event => void readBackupFile(event.target.files?.[0])} />
              <label htmlFor="wallet-backup-password">Wallet password</label>
              <input id="wallet-backup-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" maxLength={128} value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter backup password" />
              <button className="wallet-vault-primary" type="button" disabled={busy} onClick={() => void performWalletAction(restoreEncryptedBackup)}><FileKey2 size={17} /> {busy ? 'Restoring locally…' : 'Restore and unlock'}</button>
            </div>
          )}

          <div className="wallet-vault-security-note"><LockKeyhole size={17} /><div><strong>Encrypted locally, not custodial</strong><p>AES-256-GCM with a PBKDF2-SHA-256 password key. The web app does not receive or store your private key. This is password-encrypted web storage, not a hardware-backed mobile keystore.</p></div></div>
          </details>
        </section>

        <section id="wallet-owner-vault" className="wallet-vault-panel wallet-vault-account" hidden={activePanel === 'dashboard' || activePanel === 'settings' || (!unlocked && activePanel !== 'account')}>
          <div className="wallet-vault-panel-head" hidden={activePanel !== 'account'}><span className="wallet-vault-step">02</span><div><h2>Wallet vault</h2><p>{records.length} encrypted wallet{records.length === 1 ? '' : 's'} on this device.</p></div></div>

          {records.length > 0 ? (
            <div className="wallet-vault-wallet-list" hidden={activePanel !== 'account'}>
              {records.map(record => (
                <button type="button" key={record.address} className={'wallet-vault-wallet-choice' + (selectedAddress === record.address ? ' is-selected' : '')} onClick={() => { setActivePanel('account'); setSelectedAddress(record.address); if (unlocked?.record.address !== record.address) setUnlocked(null); setPassword(''); setPortfolio(null); setTransferReview(null); setTransferAcknowledged(false); setMainnetSendPhrase(''); setError(''); setNotice('') }}>
                  <span className="wallet-vault-avatar"><Wallet size={18} /></span>
                  <span className="wallet-vault-wallet-details"><strong>{shortenAddress(record.address)}</strong><small>Saved {new Date(record.createdAt).toLocaleDateString()}</small></span>
                  <span className="wallet-vault-choice-status">{unlocked?.record.address === record.address ? 'Unlocked' : 'Encrypted'}</span>
                </button>
              ))}
              {!unlocked && selectedRecord && (
                <div className="wallet-vault-form wallet-vault-unlock-form">
                  <label htmlFor="wallet-unlock-password">Unlock selected wallet</label>
                  <div className="wallet-vault-password"><input id="wallet-unlock-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" maxLength={128} value={password} onChange={event => setPassword(event.target.value)} placeholder="Wallet password" onKeyDown={event => { if (event.key === 'Enter') void performWalletAction(unlockExistingWallet) }} /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
                  <button className="wallet-vault-primary" type="button" disabled={busy} onClick={() => void performWalletAction(unlockExistingWallet)}><LockKeyhole size={17} /> {busy ? 'Unlocking…' : 'Unlock wallet'}</button>
                </div>
              )}
            </div>
          ) : (
            <div className="wallet-vault-empty" hidden={activePanel !== 'account'}><span className="wallet-vault-empty-icon"><Wallet size={25} /></span><h3>No wallet saved yet</h3><p>Create a new wallet or import an existing key in the first panel. The address does not need USDT to be created.</p></div>
          )}

          {unlocked && (
            <div className="wallet-vault-portfolio" hidden={activePanel === 'account'}>
              <div className="wallet-vault-address-row" hidden={activePanel !== 'wallet'}><div><small>Public address</small><a href={explorerUrl(network, unlocked.record.address)} target="_blank" rel="noopener noreferrer">{shortenAddress(unlocked.record.address)} ↗</a></div><button type="button" className="wallet-vault-icon-button" aria-label="Copy public address" onClick={() => void copyAddress(unlocked.record.address)}><Copy size={17} /></button></div>
              <div className="wallet-vault-balance" hidden={activePanel !== 'wallet'}>
                <div className="wallet-vault-balance-icon">T</div>
                <div><small>Native TRX balance · {network === 'mainnet' ? 'Mainnet' : network === 'nile' ? 'Nile testnet' : 'Shasta testnet'}</small><strong>{balanceLoading ? 'Reading chain…' : portfolio?.trx ?? '—'} <span>TRX</span></strong><small>Read directly from the selected network; this is not an exchange balance.</small></div>
                <button type="button" className="wallet-vault-icon-button" aria-label="Refresh chain balance" disabled={balanceLoading} onClick={() => setRefreshNonce(value => value + 1)}><RefreshCw size={17} className={balanceLoading ? 'wallet-vault-spinning' : ''} /></button>
              </div>

              <div className="wallet-vault-token-section" hidden={activePanel !== 'wallet'}>
                <div className="wallet-vault-section-title">
                  <div><h3>TRC-20 contract watchlist</h3><p>Network code, token methods, supply, balances and explorer evidence.</p></div>
                </div>
                <div className="wallet-vault-add-token">
                  <input aria-label="TRC20 token contract address" value={tokenInput} onChange={event => setTokenInput(event.target.value)} placeholder="TRON contract address" />
                  <button type="button" disabled={!tokenInput.trim() || busy} onClick={() => void performWalletAction(addTokenContract)}>Verify & add</button>
                </div>
                {network === 'mainnet' && !tokenContracts.includes(OFFICIAL_MAINNET_USDT) && (
                  <button type="button" className="wallet-vault-secondary wallet-vault-official-token" disabled={busy} onClick={() => void performWalletAction(() => addTokenContract(OFFICIAL_MAINNET_USDT))}>
                    <ShieldCheck size={15} /> Verify official TRON USDT address
                  </button>
                )}
                {tokenContracts.length > 0 && (
                  <div className="wallet-vault-token-list">
                    {(portfolio?.tokens || tokenContracts.map(contract => ({ contract, symbol: 'TRC20', decimals: 0, balance: balanceLoading ? 'Reading…' : 'Unavailable', error: balanceLoading ? undefined : 'Chain read unavailable. Refresh to retry.' }))).map(token => {
                      const evidence = tokenEvidence[token.contract]
                      const warning = evidence?.riskFeedback === true || evidence?.explorerRiskLevel === 'suspicious'
                        || evidence?.explorerRiskLevel === 'unsafe' || Boolean(evidence?.riskTag?.trim())
                      return (
                        <div className="wallet-vault-token-row" key={token.contract}>
                          <div className="wallet-vault-token-info">
                            <strong>{evidence?.tokenName || token.symbol} <span>{token.error ? '· unavailable' : ''}</span></strong>
                            <small>{shortenAddress(token.contract)} · {evidence?.tokenSymbol || token.symbol} · {token.error || tokenEvidenceLabel(evidence)}</small>
                            {evidence && <small>Supply: {evidence.totalSupply ?? 'unknown'} · Decimals: {evidence.tokenDecimals ?? 'unknown'} · Source check: {evidence.explorerStatus || 'unknown'}</small>}
                            {warning && <small className="wallet-vault-risk-note">Explorer risk marker detected. Avoid sending to this contract.</small>}
                            {network === 'mainnet' && token.contract !== OFFICIAL_MAINNET_USDT && evidence?.sourceVerificationStatus !== 'fully-verified-source'
                              && <small className="wallet-vault-risk-note">Mainnet transfers are blocked until source is fully verified on TronScan.</small>}
                          </div>
                          <strong className="wallet-vault-token-amount">{token.balance}</strong>
                          <button type="button" className="wallet-vault-secondary wallet-vault-verify-button" disabled={busy || evidenceLoading === token.contract} onClick={() => void performWalletAction(() => checkTokenEvidence(token.contract))}>
                            {evidenceLoading === token.contract ? 'Checking…' : 'Verify'}
                          </button>
                          <button type="button" className="wallet-vault-icon-button" aria-label={'Remove token ' + token.contract} onClick={() => removeTokenContract(token.contract)}><X size={15} /></button>
                        </div>
                      )
                    })}
                  </div>
                )}
                <p className="wallet-vault-caption">Balances are queried from the selected chain. A symbol or a fully verified source does not guarantee an issuer, a peg, liquidity, or value. Mainnet token transfers are limited to the official Tether TRON USDT contract or source-verified contracts without explorer risk markers.</p>
              </div>

              <div className="wallet-vault-wallet-actions" hidden={activePanel !== 'wallet'}>
                <button type="button" className="wallet-vault-secondary" onClick={downloadEncryptedBackup}><Download size={16} /> Download encrypted backup</button>
                <button type="button" className="wallet-vault-lock" onClick={lockWallet}><LockKeyhole size={16} /> Lock wallet</button>
              </div>
              <p className="wallet-vault-caption" hidden={activePanel !== 'wallet'}><Activity size={14} /> This is a standalone local wallet. The encrypted vault is stored on this device; the backend never receives the private key. Keep an offline backup.</p>

              {network === 'mainnet' && (
                <section id="owner-treasury-funding" className="wallet-vault-transfer-section" aria-labelledby="owner-treasury-funding-heading" hidden={activePanel !== 'treasury'}>
                  <div className="wallet-vault-panel-head">
                    <span className="wallet-vault-step">OWNER</span>
                    <div><h2 id="owner-treasury-funding-heading">Owner treasury funding check</h2><p>Verify actual funds held by the server-configured treasury.</p></div>
                  </div>
                  <div className="wallet-vault-transfer-warning" role="note">
                    <strong>Read-only treasury funding check</strong>
                    <p>The overview above loads read-only treasury status from your private owner-console session. This optional verification signs a short identity message locally with the owner wallet; the backend checks it against TREASURY_OWNER_ADDRESS. The balance query reads real Mainnet TRX and official Tether USDT from TREASURY_MAINNET_ADDRESS (falling back to SPONSOR_MAINNET_ADDRESS, then TREASURY_OWNER_ADDRESS). It does not mint USDT or broadcast a transfer; no USDT is generated by this read-only check.</p>
                  </div>
                  <button type="button" className="wallet-vault-primary" disabled={ownerTreasuryLoading} onClick={() => void refreshOwnerTreasury()}>
                    <RefreshCw size={16} /> {ownerTreasuryLoading ? 'Verifying owner and reading chain…' : 'Sign owner check & read treasury'}
                  </button>
                  {ownerTreasuryError && <p className="wallet-vault-risk-note" role="alert">{ownerTreasuryError}</p>}
                  {ownerTreasurySnapshot?.ownerAccessVerified === true && (
                    <>
                      <div className="wallet-vault-review-grid">
                        <div className="wallet-vault-review-wide"><small>Configured treasury address</small><a href={explorerUrl('mainnet', ownerTreasurySnapshot.treasuryAddress || '')} target="_blank" rel="noopener noreferrer">{ownerTreasurySnapshot.treasuryAddress || 'Unavailable'} ↗</a></div>
                        <div><small>Verified on-chain TRX</small><strong>{ownerTreasurySnapshot.native?.status === 'verified' ? (ownerTreasurySnapshot.native.balanceTRX || '0') + ' TRX' : 'Unavailable'}</strong></div>
                        <div><small>Official Mainnet USDT</small><strong>{ownerTreasurySnapshot.officialUsdt?.status === 'verified' && typeof ownerTreasurySnapshot.officialUsdt.balanceBaseUnits === 'string' ? formatUnits(ownerTreasurySnapshot.officialUsdt.balanceBaseUnits, 6) + ' USDT' : 'Unavailable — not verified'}</strong></div>
                        <div className="wallet-vault-review-wide"><small>Snapshot checked</small><strong>{ownerTreasurySnapshot.checkedAt || 'Time unavailable'}</strong></div>
                      </div>
                      <p className="wallet-vault-caption">This is an observed chain balance, not an accounting balance or a payout authorization. The balance is not increased by this app. An actual outgoing transfer still requires genuine treasury assets and a separately reviewed signer/approval process.</p>
                      {ownerTreasurySnapshot.officialUsdt?.status === 'verified'
                        && ownerTreasurySnapshot.officialUsdt.balanceBaseUnits === '0' && (
                        <p className="wallet-vault-risk-note" role="note">The treasury currently holds zero genuine USDT. No USDT payout can be made until real USDT arrives at this treasury address.</p>
                      )}
                      {ownerTreasurySnapshot.treasuryAddress === unlocked.record.address
                        && ownerTreasurySnapshot.officialUsdt?.status === 'verified'
                        && ownerTreasurySnapshot.officialUsdt.tokenContract === OFFICIAL_MAINNET_USDT
                        && ownerTreasurySnapshot.officialUsdt.decimals === 6
                        && typeof ownerTreasurySnapshot.officialUsdt.balanceBaseUnits === 'string'
                        && /^(0|[1-9][0-9]*)$/.test(ownerTreasurySnapshot.officialUsdt.balanceBaseUnits)
                        && BigInt(ownerTreasurySnapshot.officialUsdt.balanceBaseUnits) > 0n && (
                        <button type="button" className="wallet-vault-primary" disabled={busy || transferInProgress} onClick={() => void performWalletAction(selectTreasuryUsdtSender)}>
                          <ShieldCheck size={16} /> View treasury status (read-only)
                        </button>
                      )}
                      {ownerTreasurySnapshot.treasuryAddress && ownerTreasurySnapshot.treasuryAddress !== unlocked.record.address && (
                        <p className="wallet-vault-risk-note" role="note">The watched treasury address is different from the currently unlocked wallet. The Send section below can sign only from the unlocked wallet address; this watch-only address cannot authorize a payout. To send treasury funds, the treasury wallet must be unlocked locally with its matching private key and must hold the real assets.</p>
                      )}
                    </>
                  )}
                  <div className="wallet-vault-transfer-warning" role="note">
                    <strong>Sponsor-funded Mainnet payout — never debits the personal wallet</strong>
                    <p>The organization’s Fireblocks vault supplies the genuine USDT principal and approved fee assets. The unlocked owner wallet signs only the exact one-request authorization. The backend still rejects submission while any sponsor, custody, funding, database, policy or source-build release gate is closed.</p>
                  </div>
                  {serverTreasuryReadiness && (
                    <div className="wallet-vault-review-grid">
                      <div className="wallet-vault-review-wide"><small>Server treasury address</small><strong>{serverTreasuryReadiness.treasuryAddress || 'Not configured'}</strong></div>
                      <div><small>Payout preflight readiness</small><strong>{serverTreasuryReadiness.payoutsPreflightReady === true ? 'Passed (checks only)' : 'Not passed'}</strong></div>
                      <div><small>Application payout execution</small><strong>{serverTreasuryReadiness?.executionEnabled === true ? 'Enabled after sponsor release and all preflight checks' : serverTreasuryReadiness?.releaseAuthorization?.reason || serverTreasuryReadiness?.executionBlocker || 'Not authorized'}</strong></div>
                      <div><small>Configuration completeness</small><strong>{serverTreasuryReadiness.configuration?.configurationComplete === true ? 'Complete' : 'Incomplete'}</strong></div>
                      <div><small>USDT payout switch</small><strong>{serverTreasuryReadiness.configuration?.featureFlagEnabled === true ? 'Enabled' : 'Disabled (safe default)'}</strong></div>
                      <div><small>USDT asset identity</small><strong>{serverTreasuryReadiness.providerAssetIdentityVerified === true ? 'Verified' : 'Unverified'}</strong></div>
                      <div><small>USDT vault address match</small><strong>{serverTreasuryReadiness.providerVaultAddressVerified === true ? 'Verified' : 'Unverified / mismatch'}</strong></div>
                      <div><small>Native TRX asset identity</small><strong>{serverTreasuryReadiness.nativeTrxAssetIdentityVerified === true ? 'Verified' : 'Unverified'}</strong></div>
                      <div><small>Native TRX vault address match</small><strong>{serverTreasuryReadiness.nativeTrxVaultAddressVerified === true ? 'Verified' : 'Unverified / mismatch'}</strong></div>
                      <div><small>Verified treasury USDT</small><strong>{typeof serverTreasuryReadiness.treasuryUsdtBalanceBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.treasuryUsdtBalanceBaseUnits) ? formatUnits(serverTreasuryReadiness.treasuryUsdtBalanceBaseUnits, 6) + ' USDT' : 'Unavailable'}</strong></div>
                      <div><small>Provider-available USDT</small><strong>{typeof serverTreasuryReadiness.providerAvailableUsdtBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.providerAvailableUsdtBaseUnits) ? formatUnits(serverTreasuryReadiness.providerAvailableUsdtBaseUnits, 6) + ' USDT' : 'Unavailable'}</strong></div>
                      <div><small>Verified treasury TRX</small><strong>{typeof serverTreasuryReadiness.treasuryTrxBalanceSun === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.treasuryTrxBalanceSun) ? formatUnits(serverTreasuryReadiness.treasuryTrxBalanceSun, 6) + ' TRX' : 'Unavailable'}</strong></div>
                      <div><small>Provider-available TRX</small><strong>{typeof serverTreasuryReadiness.providerAvailableTrxBaseUnits === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.providerAvailableTrxBaseUnits) ? formatUnits(serverTreasuryReadiness.providerAvailableTrxBaseUnits, 6) + ' TRX' : 'Unavailable'}</strong></div>
                      <div><small>Configured fee reserve / estimate threshold</small><strong>{typeof serverTreasuryReadiness.treasuryFeeLimitSun === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.treasuryFeeLimitSun) ? formatUnits(serverTreasuryReadiness.treasuryFeeLimitSun, 6) + ' TRX' : 'Unavailable'}</strong></div>
                      <div><small>Current reserved fee requirement</small><strong>{typeof serverTreasuryReadiness.requiredFeeReserveSun === 'string' && /^(0|[1-9][0-9]*)$/.test(serverTreasuryReadiness.requiredFeeReserveSun) ? formatUnits(serverTreasuryReadiness.requiredFeeReserveSun, 6) + ' TRX' : 'Unavailable'}</strong></div>
                      <div><small>Fee reserve funding check</small><strong>{serverTreasuryReadiness.networkFeeCapCovered === true ? 'Covered' : 'Not covered'}</strong></div>
                      <div><small>All pending fee reservations</small><strong>{serverTreasuryReadiness.feeReserveCovered === true ? 'Covered' : 'Not covered'}</strong></div>
                    </div>
                  )}
                  {serverTreasuryReadiness?.withdrawalsEnabled !== true && (
                    <div className="wallet-vault-transfer-warning" role="status">
                      <strong>Withdrawal execution status</strong>
                      <p>Server-funded USDT withdrawals remain disabled unless the backend signer, persistent database, payout limits and actual treasury balance all pass checks. This screen never creates USDT or pays a recipient from an empty treasury.</p>
                      {Array.isArray(serverTreasuryReadiness?.configuration?.missing) && serverTreasuryReadiness.configuration.missing.length > 0 && (
                        <p><strong>Backend configuration still missing:</strong> {serverTreasuryReadiness.configuration.missing.join(', ')}</p>
                      )}
                      {Array.isArray(serverTreasuryReadiness?.payoutBlockers) && serverTreasuryReadiness.payoutBlockers.length > 0 && (
                        <p><strong>Current funding/readiness blockers:</strong> {serverTreasuryReadiness.payoutBlockers.map((item: string) => item.replaceAll('-', ' ')).join('; ')}</p>
                      )}
                      {serverTreasuryReadiness?.payoutBlockers?.includes('treasury-trx-below-fee-cap') && (
                        <p>The treasury needs verified TRX for the configured reserve. The backend checks Fireblocks low/medium/high estimates before submission, but that estimate threshold is not a provider-enforced hard fee cap. Actual costs must be reconciled after the transaction; the owner wallet does not pay the treasury's fee.</p>
                      )}
                    </div>
                  )}
                  {serverTreasuryReadiness?.withdrawalsEnabled === true
                    && typeof serverTreasuryReadiness.treasuryAddress === 'string'
                    && typeof ownerTreasurySnapshot?.treasuryAddress === 'string'
                    && !serverTreasuryAddressMatchesSnapshot && (
                    <p className="wallet-vault-risk-note" role="alert">Payout is blocked: the server signing address does not match the treasury address whose on-chain balance was checked. Fix the backend address configuration and repeat the owner check.</p>
                  )}
                  {serverTreasuryReadiness?.withdrawalsEnabled === true && !serverTreasuryHasFunds && (
                    <p className="wallet-vault-risk-note" role="note">The server treasury has no verified positive USDT balance. Fund it with genuine USDT and verify the balance before requesting a payout.</p>
                  )}
                  <div className="wallet-vault-transfer-warning" role="note">
                    <strong>Sponsor-funded Mainnet USDT withdrawal request</strong>
                    <p>The source is the authorized organization’s Fireblocks vault, not the personal wallet. This form remains unavailable unless the backend verifies the exact sponsor release, authenticated owner, live provider/chain preflight, database reservations, recipient policy, fee reserve and principal budget. The owner signature authorizes one request only and does not provide the USDT funds.</p>
                  </div>
                  <div className="wallet-vault-form">
                    <label htmlFor="treasury-payout-recipient">External TRON Mainnet recipient</label>
                    <input id="treasury-payout-recipient" autoComplete="off" spellCheck={false}
                      value={treasuryPayoutRecipient}
                      disabled={treasuryPayoutBusy || treasuryPayoutInFlight}
                      onChange={event => setTreasuryPayoutRecipient(event.target.value)}
                      placeholder="T... exchange deposit or external wallet address" />
                    <label htmlFor="treasury-payout-amount">USDT amount (6 decimals)</label>
                    <input id="treasury-payout-amount" inputMode="decimal" autoComplete="off"
                      value={treasuryPayoutAmount}
                      disabled={treasuryPayoutBusy || treasuryPayoutInFlight}
                      onChange={event => setTreasuryPayoutAmount(event.target.value)}
                      placeholder="0.00" />
                    <label htmlFor="treasury-payout-confirm">Type SEND USDT to confirm this exact request</label>
                    <input id="treasury-payout-confirm" autoComplete="off"
                      value={treasuryPayoutConfirm}
                      disabled={treasuryPayoutBusy || treasuryPayoutInFlight}
                      onChange={event => setTreasuryPayoutConfirm(event.target.value)}
                      placeholder="SEND USDT" />
                    <button type="button" className="wallet-vault-primary"
                      disabled={treasuryPayoutBusy || !canSubmitServerTreasuryPayout
                        || !treasuryPayoutRecipient.trim() || !treasuryPayoutAmount.trim()
                        || treasuryPayoutConfirm.trim() !== 'SEND USDT'
                        || treasuryPayoutInFlight}
                      onClick={() => void submitServerTreasuryPayout()}>
                      {treasuryPayoutBusy ? 'Authorizing & submitting…'
                        : treasuryPayoutCurrentStatus === 'submission-outcome-unknown' ? 'Lookup existing request before retry'
                          : 'Sign & submit sponsor-funded USDT payout'}
                    </button>
                    {!canSubmitServerTreasuryPayout && (
                      <p className="wallet-vault-caption">Submission is locked. Complete the owner check, sponsor release authorization, current readiness checks, funding verification and sponsor budget checks first.</p>
                    )}
                    {treasuryPayoutInFlight && treasuryPayoutCurrentStatus !== 'submission-outcome-unknown' && (
                      <p className="wallet-vault-caption">This request is already in flight. Do not create another payout. Verify and look up the existing request below.</p>
                    )}
                  </div>
                  <div className="wallet-vault-transfer-warning" role="note">
                    <strong>Mainnet USDT execution release authorization</strong>
                    <p>Live USDT execution requires the owner-controlled <code>TREASURY_REAL_VALUE_EXECUTION_ENABLED=true</code> switch plus a sponsor message signature stored by the backend. The sponsor signature binds the exact Fireblocks vault, agreement, treasury address, USDT contract, TRX fee asset, limits, and recipient-policy hash. This is a release authorization, not a transfer instruction; live preflight and a separate owner signature are still required for each payout.</p>
                  </div>
                  <div className="wallet-vault-review-grid">
                    <div><small>Owner release switch / sponsor authorization</small><strong>{serverTreasuryReadiness?.releaseAuthorization?.authorized === true ? 'Sponsor release authorized' : serverTreasuryReadiness?.releaseAuthorization?.reason || 'Not authorized'}</strong></div>
                    <div><small>Release reference</small><strong>{serverTreasuryReadiness?.releaseAuthorization?.releaseReference || 'Not configured'}</strong></div>
                    <div><small>Sponsor release signer</small><strong>{serverTreasuryReadiness?.releaseAuthorization?.signerAddress || 'Not verified'}</strong></div>
                    <div><small>Release expiry</small><strong>{serverTreasuryReadiness?.releaseAuthorization?.expiresAt ? new Date(serverTreasuryReadiness.releaseAuthorization.expiresAt).toLocaleString() : 'Not authorized'}</strong></div>
                    <div className="wallet-vault-review-wide"><small>Release message hash</small><strong>{serverTreasuryReadiness?.releaseAuthorization?.messageHash || 'Not recorded'}</strong></div>
                  </div>
                  <div className="wallet-vault-form">
                    <button type="button" className="wallet-vault-primary" disabled={treasuryReleaseBusy || !ownerSessionToken} onClick={() => void loadTreasuryReleaseMessage('approve')}>
                      {treasuryReleaseBusy && treasuryReleaseAction === 'approve' ? 'Preparing message…' : 'Prepare sponsor release message'}
                    </button>
                    {serverTreasuryReadiness?.releaseAuthorization?.authorized === true && (
                      <button type="button" className="wallet-vault-secondary" disabled={treasuryReleaseBusy || !ownerSessionToken} onClick={() => void loadTreasuryReleaseMessage('revoke')}>
                        Prepare sponsor release revocation message
                      </button>
                    )}
                    {treasuryReleaseError && <p className="wallet-vault-risk-note" role="alert">{treasuryReleaseError}</p>}
                    {treasuryReleaseMessage && (
                      <>
                        <label htmlFor="treasury-release-canonical-message">{treasuryReleaseAction === 'approve' ? 'Exact sponsor release message' : 'Exact sponsor revocation message'}</label>
                        <textarea id="treasury-release-canonical-message" rows={10} readOnly value={treasuryReleaseMessage} />
                        <button type="button" className="wallet-vault-secondary" disabled={treasuryReleaseBusy} onClick={() => void copyTreasuryReleaseMessage()}>Copy canonical sponsor message</button>
                        <label htmlFor="treasury-release-signature">Sponsor wallet message signature only</label>
                        <textarea id="treasury-release-signature" rows={2} autoComplete="off" spellCheck={false} value={treasuryReleaseSignature} onChange={event => setTreasuryReleaseSignature(event.target.value)} placeholder="0x followed by 130 hexadecimal characters" />
                        <button type="button" className="wallet-vault-primary" disabled={treasuryReleaseBusy || !treasuryReleaseSignature.trim()} onClick={() => void submitTreasuryReleaseSignature()}>
                          {treasuryReleaseBusy ? 'Verifying signature…' : treasuryReleaseAction === 'approve' ? 'Verify & store sponsor release' : 'Verify & revoke sponsor release'}
                        </button>
                        <p className="wallet-vault-caption">Only a public message signature is submitted. Never paste a sponsor seed phrase, private key, Fireblocks RSA key, or API secret. The release setting alone cannot activate execution without the independently verified sponsor signature record.</p>
                      </>
                    )}
                  </div>
                  <div className="wallet-vault-transfer-warning" role="note">
                    <strong>Sponsor-approved external destination</strong>
                    <p>This workflow requests a sponsor's policy approval for one exact recipient. It does not initiate, reserve, sign, or submit a withdrawal. The sponsor must inspect the canonical message and sign it with a wallet whose address is already configured in <code>TREASURY_SPONSOR_APPROVER_ADDRESSES</code>.</p>
                  </div>
                  <div className="wallet-vault-form">
                    <label htmlFor="sponsor-recipient-address">External TRON recipient address</label>
                    <input id="sponsor-recipient-address" autoComplete="off" spellCheck={false} value={sponsorRecipientAddress} onChange={event => setSponsorRecipientAddress(event.target.value)} placeholder="T... recipient wallet or exchange deposit address" />
                    <label htmlFor="sponsor-recipient-reason">Reason for sponsor review</label>
                    <textarea id="sponsor-recipient-reason" rows={2} maxLength={500} value={sponsorRecipientReason} onChange={event => setSponsorRecipientReason(event.target.value)} placeholder="Exchange deposit address for an approved beneficiary" />
                    <button type="button" className="wallet-vault-primary" disabled={sponsorRecipientBusy || !ownerSessionToken || !sponsorRecipientAddress.trim() || !sponsorRecipientReason.trim()} onClick={() => void createSponsorRecipientApprovalRequest()}>
                      {sponsorRecipientBusy ? 'Creating request…' : 'Create sponsor destination request'}
                    </button>
                    {!ownerSessionToken && <p className="wallet-vault-caption">Sign the owner treasury check above to establish the owner-console session first.</p>}
                  </div>
                  <div className="wallet-vault-form">
                    <label htmlFor="sponsor-recipient-request-id">Recipient approval request ID</label>
                    <input id="sponsor-recipient-request-id" autoComplete="off" spellCheck={false} value={sponsorRecipientRequestId} onChange={event => { setSponsorRecipientRequestId(event.target.value); setSponsorRecipientRequest(null); setSponsorRecipientSignature('') }} placeholder="Paste an existing request UUID to reload it" />
                    <button type="button" className="wallet-vault-secondary" disabled={sponsorRecipientBusy || !sponsorRecipientRequestId.trim()} onClick={() => void loadSponsorRecipientApprovalRequest()}>
                      Load approval request
                    </button>
                  </div>
                  {sponsorRecipientError && <p className="wallet-vault-risk-note" role="alert">{sponsorRecipientError}</p>}
                  {sponsorRecipientRequest?.request && (
                    <div className="wallet-vault-review-grid">
                      {Array.isArray(sponsorRecipientRequest.requiredSponsorSignerAddresses) && sponsorRecipientRequest.requiredSponsorSignerAddresses.length > 0 && (
                        <div className="wallet-vault-review-wide"><small>Configured sponsor signer addresses (public)</small><strong>{sponsorRecipientRequest.requiredSponsorSignerAddresses.join(', ')}</strong></div>
                      )}
                      <div><small>Sponsor recipient request status</small><strong>{sponsorRecipientRequest.request.status}</strong></div>
                      <div className="wallet-vault-review-wide"><small>Request ID</small><strong>{sponsorRecipientRequest.request.requestId}</strong></div>
                      <div className="wallet-vault-review-wide"><small>Exact recipient</small><strong>{sponsorRecipientRequest.request.recipientAddress}</strong></div>
                      <div><small>Sponsor organization</small><strong>{sponsorRecipientRequest.request.sponsorOrganizationReference}</strong></div>
                      <div><small>Sponsor agreement</small><strong>{sponsorRecipientRequest.request.sponsorAgreementReference}</strong></div>
                      <div><small>Approver address</small><strong>{sponsorRecipientRequest.request.approverAddress || 'Waiting for sponsor signature'}</strong></div>
                      <div><small>Request expiry</small><strong>{sponsorRecipientRequest.request.expiresAt ? new Date(sponsorRecipientRequest.request.expiresAt).toLocaleString() : 'Unavailable'}</strong></div>
                      {(sponsorRecipientRequest.approvalMessage || sponsorRecipientRequest.revocationMessage) && (
                        <div className="wallet-vault-review-wide">
                          <small>{sponsorRecipientRequest.request.status === 'approved' ? 'Sponsor revocation message' : 'Sponsor approval message'}</small>
                          <pre>{sponsorRecipientRequest.revocationMessage || sponsorRecipientRequest.approvalMessage}</pre>
                          <button type="button" className="wallet-vault-secondary" disabled={sponsorRecipientBusy} onClick={() => void copySponsorRecipientMessage()}>Copy canonical sponsor message</button>
                        </div>
                      )}
                    </div>
                  )}
                  {sponsorRecipientRequest?.request?.status === 'pending' || sponsorRecipientRequest?.request?.status === 'approved' ? (
                    <div className="wallet-vault-form">
                      <label htmlFor="sponsor-recipient-signature">Sponsor wallet signature (public signature only)</label>
                      <textarea id="sponsor-recipient-signature" rows={2} autoComplete="off" spellCheck={false} value={sponsorRecipientSignature} onChange={event => setSponsorRecipientSignature(event.target.value)} placeholder="0x followed by 130 hexadecimal characters" />
                      <button type="button" className="wallet-vault-primary" disabled={sponsorRecipientBusy || !sponsorRecipientSignature.trim()} onClick={() => void submitSponsorRecipientSignature()}>
                        {sponsorRecipientBusy ? 'Verifying sponsor signature…' : sponsorRecipientRequest.request.status === 'approved' ? 'Submit sponsor revocation signature' : 'Submit sponsor approval signature'}
                      </button>
                      <p className="wallet-vault-caption">The backend recovers the signer and compares it with the independent sponsor allowlist. The signature authorizes only this exact recipient-policy change. Do not enter a seed phrase, private key, Fireblocks RSA key, or API secret.</p>
                    </div>
                  ) : sponsorRecipientRequest?.request?.status === 'revoked' || sponsorRecipientRequest?.request?.status === 'expired' ? (
                    <p className="wallet-vault-risk-note" role="status">This recipient approval request is {sponsorRecipientRequest.request.status}. It cannot authorize a payout.</p>
                  ) : null}
                  {treasuryPayoutError && <p className="wallet-vault-risk-note" role="alert">{treasuryPayoutError}</p>}
                  {treasuryPayoutStatus && (
                    <div className="wallet-vault-review-grid">
                      <div><small>Request status</small><strong>{treasuryPayoutStatus.withdrawal?.status || treasuryPayoutStatus.status || 'unknown'}</strong></div>
                      <div className="wallet-vault-review-wide"><small>Idempotency key</small><strong>{treasuryPayoutStatus.withdrawal?.idempotencyKey || treasuryPayoutStatus.idempotencyKey || 'Unavailable'}</strong></div>
                      {treasuryPayoutStatus.withdrawal?.transactionHash && <div className="wallet-vault-review-wide"><small>Transaction</small><a href={explorerTransactionUrl('mainnet', treasuryPayoutStatus.withdrawal.transactionHash)} target="_blank" rel="noopener noreferrer">{treasuryPayoutStatus.withdrawal.transactionHash} ↗</a></div>}
                      {treasuryPayoutStatus.transactionHash && <div className="wallet-vault-review-wide"><small>Transaction</small><a href={explorerTransactionUrl('mainnet', treasuryPayoutStatus.transactionHash)} target="_blank" rel="noopener noreferrer">{treasuryPayoutStatus.transactionHash} ↗</a></div>}
                      <div className="wallet-vault-review-wide"><small>Verification reminder</small><strong>Broadcast acceptance is not confirmation. Check the successful solidified receipt and exchange deposit status.</strong></div>
                    </div>
                  )}
                  <button type="button" className="wallet-vault-secondary" disabled={treasuryPayoutBusy || !treasuryPayoutStatus} onClick={() => void lookupServerTreasuryPayout()}>Verify receipt & look up saved status</button>
                  <p className="wallet-vault-caption">A Fireblocks request or TRON broadcast is not proof of final delivery. Only a verified successful solidified USDT Transfer receipt confirms the on-chain transfer; an exchange deposit credit is controlled separately by the receiving exchange.</p>
                </section>
              )}

              <section id="wallet-vault-transfer" className="wallet-vault-transfer-section" aria-labelledby="wallet-vault-transfer-heading" hidden={activePanel !== 'send'}>
                <div className="wallet-vault-panel-head">
                  <span className="wallet-vault-step">03</span>
                  <div><h2 id="wallet-vault-transfer-heading">Personal wallet transfer preview</h2><p>This route uses only the exact address and assets held by the currently unlocked personal wallet. It never uses sponsor funds. A sponsored withdrawal belongs exclusively in Sponsor payouts. This build provides review only; signing and broadcast are disabled.</p></div>
                </div>
                <div className="wallet-vault-transfer-warning" role="note">
                  <strong>Personal wallet only — no organization funds</strong>
                  <p>The source is the unlocked personal wallet shown in Assets. The wallet must hold the real selected token and enough native TRX for any required network fee. This panel validates details and performs read-only checks only; this build cannot sign or broadcast. No sponsor balance is used here.</p>
                  {network === 'mainnet' && <p><strong>Mainnet caution:</strong> this password-encrypted browser wallet has not undergone an independent wallet-security audit and is not hardware-backed. Do not keep substantial value in an unaudited browser wallet.</p>}
                  {network !== 'mainnet' && <p>Testnet assets have no monetary value and will not credit a Mainnet exchange deposit.</p>}
                </div>

                <p className="wallet-vault-caption">Need an organization to provide the withdrawal principal instead of using your personal wallet? Switch to <button type="button" className="wallet-vault-inline-action" onClick={() => navigatePanel('treasury')}>Sponsor payouts</button>. That separate route requires a genuine, authorized and funded sponsor vault.</p>
                <div className="wallet-vault-transfer-form">
                  <label htmlFor="wallet-transfer-asset">Asset</label>
                  <select id="wallet-transfer-asset" value={transferAsset} onChange={event => { setTransferAsset(event.target.value as TransferAsset); setTransferReview(null); setTransferAcknowledged(false); setMainnetSendPhrase('') }}>
                    <option value="TRX">TRX — native asset</option>
                    <option value="TRC20">TRC-20 token</option>
                  </select>
                  {transferAsset === 'TRC20' && (
                    <>
                      <label htmlFor="wallet-transfer-token">Token contract</label>
                      <select id="wallet-transfer-token" value={selectedTokenContract || (tokenContracts[0] || '')} onChange={event => { setSelectedTokenContract(event.target.value); setTransferReview(null); setTransferAcknowledged(false) }} disabled={tokenContracts.length === 0}>
                        {tokenContracts.length === 0 ? <option value="">Add and verify a token first</option> : tokenContracts.map(contract => {
                          const evidence = tokenEvidence[contract]
                          return <option key={contract} value={contract}>{evidence?.tokenSymbol || shortenAddress(contract)} — {shortenAddress(contract)}</option>
                        })}
                      </select>
                      {tokenContracts.length === 0 && <p className="wallet-vault-caption">Add and verify a deployed TRC-20 contract above before preparing a token transfer.</p>}
                    </>
                  )}
                  <label htmlFor="wallet-transfer-recipient">Recipient address</label>
                  <input id="wallet-transfer-recipient" autoComplete="off" spellCheck={false} value={recipientInput} onChange={event => { setRecipientInput(event.target.value); setTransferReview(null); setTransferAcknowledged(false); setMainnetSendPhrase('') }} placeholder="T… (full Base58Check address)" />
                  <label htmlFor="wallet-transfer-amount">Amount</label>
                  <input id="wallet-transfer-amount" inputMode="decimal" autoComplete="off" value={amountInput} onChange={event => { setAmountInput(event.target.value); setTransferReview(null); setTransferAcknowledged(false); setMainnetSendPhrase('') }} placeholder={transferAsset === 'TRX' ? 'e.g. 1.25 TRX' : 'e.g. 12.5 tokens'} />
                  <button type="button" className="wallet-vault-primary" disabled={busy || transferInProgress || !recipientInput.trim() || !amountInput.trim() || (transferAsset === 'TRC20' && !selectedTokenContract)} onClick={() => void performWalletAction(prepareTransfer)}>
                    <ShieldCheck size={16} /> {busy ? 'Checking on-chain state…' : 'Review transfer'}
                  </button>
                </div>

                {transferReview && (
                  <div className="wallet-vault-transfer-review">
                    <div className="wallet-vault-review-header"><ShieldCheck size={19} /><div><strong>Review preview — signing disabled</strong><small>No transaction has been created or sent.</small></div></div>
                    <div className="wallet-vault-review-grid">
                      <div><small>Network</small><strong>{transferReview.network === 'mainnet' ? 'TRON Mainnet' : transferReview.network === 'nile' ? 'Nile testnet' : 'Shasta testnet'}</strong></div>
                      <div><small>Asset and amount</small><strong>{transferReview.amount} {transferReview.symbol}</strong></div>
                      <div><small>From</small><a href={explorerUrl(transferReview.network, transferReview.from)} target="_blank" rel="noopener noreferrer">{shortenAddress(transferReview.from)} ↗</a></div>
                      <div><small>To</small><a href={explorerUrl(transferReview.network, transferReview.to)} target="_blank" rel="noopener noreferrer">{shortenAddress(transferReview.to)} ↗</a></div>
                      {transferReview.tokenContract && <div className="wallet-vault-review-wide"><small>Exact token contract</small><a href={explorerContractUrl(transferReview.network, transferReview.tokenContract)} target="_blank" rel="noopener noreferrer">{transferReview.tokenContract} ↗</a></div>}
                      <div><small>Live TRX balance at review</small><strong>{transferReview.nativeBalance} TRX</strong></div>
                      {transferReview.tokenBalance !== null && <div><small>Live token balance at review</small><strong>{transferReview.tokenBalance} {transferReview.symbol}</strong></div>}
                      {transferReview.feeEstimateSun !== null && <div><small>TRC-20 estimated fee cap</small><strong>{formatUnits(String(transferReview.feeLimitSun), 6)} TRX</strong></div>}
                      {transferReview.tokenEvidence && <div className="wallet-vault-review-wide"><small>Token evidence</small><strong>{tokenEvidenceLabel(transferReview.tokenEvidence)}</strong><small>{transferReview.tokenEvidence.evidenceScope}</small></div>}
                    </div>
                    <label className="wallet-vault-confirm-check">
                      <input type="checkbox" checked={transferAcknowledged} onChange={event => setTransferAcknowledged(event.target.checked)} />
                      <span>I have checked the full recipient, exact token contract (if any), network and amount. I understand this real blockchain transaction cannot be reversed by TRON Token Studio.</span>
                    </label>
                    {network === 'mainnet' && (
                      <div className="wallet-vault-form">
                        <label htmlFor="wallet-mainnet-send-confirm">Type SEND MAINNET to confirm a real Mainnet transaction</label>
                        <input id="wallet-mainnet-send-confirm" autoComplete="off" value={mainnetSendPhrase} onChange={event => setMainnetSendPhrase(event.target.value)} placeholder="SEND MAINNET" />
                      </div>
                    )}
                    <div className="wallet-vault-review-actions">
                      <button type="button" className="wallet-vault-primary" disabled={true} title="Signing and broadcast are disabled in this build">
                        <ShieldCheck size={16} /> Signing and broadcast disabled
                      </button>
                      <button type="button" className="wallet-vault-secondary" disabled={busy || transferInProgress} onClick={() => { setTransferReview(null); setTransferAcknowledged(false); setMainnetSendPhrase(''); setNotice('Transfer review cancelled. Nothing was signed or sent.') }}>Cancel review</button>
                    </div>
                  </div>
                )}
              </section>

              <section id="wallet-vault-history" className="wallet-vault-history-section" aria-labelledby="wallet-vault-history-heading" hidden={activePanel !== 'activity'}>
                <div className="wallet-vault-history-header"><div><h3 id="wallet-vault-history-heading">Real transfer history</h3><p>Locally saved transaction IDs; status is re-read from the selected chain.</p></div><span>{transferHistory.length} record{transferHistory.length === 1 ? '' : 's'}</span></div>
                {transferHistory.length === 0 ? (
                  <div className="wallet-vault-history-empty">No transfers have been submitted from this device yet. History entries are added only after the network accepts a signed transaction.</div>
                ) : (
                  <div className="wallet-vault-history-list">
                    {transferHistory.map(item => (
                      <article className="wallet-vault-history-item" key={item.txid}>
                        <div className="wallet-vault-history-main">
                          <div>
                            <strong>{item.amount} {item.symbol}</strong>
                            <span className={'wallet-vault-status-tag ' + (item.verifiedOnChain ? 'status-' + item.status : item.status === 'identity-mismatch' ? 'status-identity-mismatch' : 'status-local-not-verified')}>
                              {item.verifiedOnChain ? item.status.replaceAll('-', ' ') : item.status === 'identity-mismatch' ? 'identity mismatch' : 'local · not verified'}
                            </span>
                          </div>
                          <a href={explorerTransactionUrl(item.network, item.txid)} target="_blank" rel="noopener noreferrer">{item.txid.slice(0, 12)}…{item.txid.slice(-8)} ↗</a>
                          <small>{item.network.toUpperCase()} · to {shortenAddress(item.to)} · {new Date(item.submittedAt).toLocaleString()}</small>
                          {!item.verifiedOnChain && item.status !== 'identity-mismatch' && <small>Saved locally. Refresh to compare the exact sender, recipient, amount and token contract with the chain.</small>}
                          {item.status === 'identity-mismatch' && <small className="wallet-vault-risk-note">Saved metadata did not match the transaction returned by the selected node. Do not treat this entry as verified.</small>}
                          {item.verifiedOnChain && item.solidified && <small>Solidified block {item.blockNumber ?? 'available'} · status from the selected network</small>}
                        </div>
                        <button type="button" className="wallet-vault-secondary wallet-vault-history-refresh" disabled={historyLoading === item.txid} onClick={() => void refreshTransferStatus(item)}>
                          {historyLoading === item.txid ? 'Checking…' : 'Refresh chain status'}
                        </button>
                      </article>
                    ))}
                  </div>
                )}
                <p className="wallet-vault-caption">History stored on this device is not an exchange credit ledger. A deposit is credited only when the recipient service reports it in its authenticated deposit records.</p>
              </section>
            </div>
          )}
        </section>
      </div>

      <nav className="wallet-vault-bottom-nav" aria-label="Owner wallet sections">
        <button type="button" className={activePanel === 'dashboard' ? 'is-active' : ''} aria-current={activePanel === 'dashboard' ? 'page' : undefined} onClick={() => navigatePanel('dashboard')}><Home size={18} /><span>Home</span></button>
        <button type="button" className={activePanel === 'wallet' ? 'is-active' : ''} aria-current={activePanel === 'wallet' ? 'page' : undefined} onClick={() => navigatePanel('wallet')}><Coins size={18} /><span>Assets</span></button>
        <button type="button" className={activePanel === 'send' ? 'is-active' : ''} aria-current={activePanel === 'send' ? 'page' : undefined} onClick={() => navigatePanel('send')}><Send size={18} /><span>Personal</span></button>
        <button type="button" className={activePanel === 'treasury' ? 'is-active' : ''} aria-current={activePanel === 'treasury' ? 'page' : undefined} onClick={() => navigatePanel('treasury')}><Landmark size={18} /><span>Sponsor</span></button>
        <button type="button" className={activePanel === 'activity' ? 'is-active' : ''} aria-current={activePanel === 'activity' ? 'page' : undefined} onClick={() => navigatePanel('activity')}><Activity size={18} /><span>Activity</span></button>
        <button type="button" className={activePanel === 'account' ? 'is-active' : ''} aria-current={activePanel === 'account' ? 'page' : undefined} onClick={() => navigatePanel('account')}><UserRound size={18} /><span>Account</span></button>
        <button type="button" className={activePanel === 'settings' ? 'is-active' : ''} aria-current={activePanel === 'settings' ? 'page' : undefined} onClick={() => navigatePanel('settings')}><Settings size={18} /><span>Settings</span></button>
      </nav>

      {toast && (
        <div className={'wallet-vault-toast wallet-vault-toast--' + toast.kind} role={toast.kind === 'error' ? 'alert' : 'status'} aria-live={toast.kind === 'error' ? 'assertive' : 'polite'} aria-atomic="true">
          <span className="wallet-vault-toast-icon" aria-hidden="true">
            {toast.kind === 'error' ? <AlertTriangle size={20} /> : toast.kind === 'success' ? <CheckCircle2 size={20} /> : <Info size={20} />}
          </span>
          <div className="wallet-vault-toast-content">
            <strong>{toast.kind === 'error' ? 'Action needs attention' : toast.kind === 'success' ? 'Action completed' : 'Status update'}</strong>
            <p>{toast.message}</p>
          </div>
          <button type="button" className="wallet-vault-toast-dismiss" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={17} /></button>
        </div>
      )}

      <footer className="wallet-vault-footer"><span><ShieldCheck size={15} /> Keys stay on this device</span><span><Activity size={15} /> Real on-chain reads</span><span><LockKeyhole size={15} /> No hidden balance edits</span></footer>
    </main>
  )
}
