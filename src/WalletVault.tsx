import { useEffect, useMemo, useState } from 'react'
import { Activity, ArrowDownToLine, CheckCircle2, Coins, Copy, Download, Eye, EyeOff, FileKey2, Home, KeyRound, Landmark, LockKeyhole, LogOut, Plus, RefreshCw, Send, Settings, ShieldCheck, UserRound, Wallet, X } from 'lucide-react'
import { TronWeb } from 'tronweb'
import { buildSignAndBroadcastTransfer, estimateTRC20TransferFee, parseUnitsDecimal, verifyTransferRecordOnChain } from './wallet-transfer.mjs'
import { buildTreasuryWithdrawalAuthorizationMessage } from './treasury-withdrawal-auth.mjs'
import { readTreasuryPayoutReference, saveTreasuryPayoutReference } from './treasury-payout-reference.mjs'
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
  const [ownerSessionToken, setOwnerSessionToken] = useState('')
  const [ownerSessionAddress, setOwnerSessionAddress] = useState('')
  const [serverTreasuryReadiness, setServerTreasuryReadiness] = useState<any>(null)
  const [treasuryPayoutRecipient, setTreasuryPayoutRecipient] = useState('')
  const [treasuryPayoutAmount, setTreasuryPayoutAmount] = useState('')
  const [treasuryPayoutConfirm, setTreasuryPayoutConfirm] = useState('')
  const [treasuryPayoutBusy, setTreasuryPayoutBusy] = useState(false)
  const [treasuryPayoutStatus, setTreasuryPayoutStatus] = useState<any>(null)
  const [treasuryPayoutError, setTreasuryPayoutError] = useState('')
  const [busy, setBusy] = useState(false)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [transferInProgress, setTransferInProgress] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const selectedRecord = useMemo(() => records.find(item => item.address === selectedAddress) || null, [records, selectedAddress])
  const serverTreasuryBalanceBaseUnits = serverTreasuryReadiness?.treasuryUsdtBalanceBaseUnits
  const serverTreasuryHasFunds = typeof serverTreasuryBalanceBaseUnits === 'string'
    && /^(0|[1-9][0-9]*)$/.test(serverTreasuryBalanceBaseUnits)
    && BigInt(serverTreasuryBalanceBaseUnits) > 0n
  const serverTreasuryAddressMatchesSnapshot = typeof serverTreasuryReadiness?.treasuryAddress === 'string'
    && typeof ownerTreasurySnapshot?.treasuryAddress === 'string'
    && serverTreasuryReadiness.treasuryAddress === ownerTreasurySnapshot.treasuryAddress
  const canSubmitServerTreasuryPayout = Boolean(ownerSessionToken
    && ownerTreasurySnapshot?.ownerAccessVerified === true
    && serverTreasuryReadiness?.withdrawalsEnabled === true
    && serverTreasuryAddressMatchesSnapshot
    && serverTreasuryHasFunds)
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

  useEffect(() => {
    const contracts = readTokenWatchlist(network)
    setTokenContracts(contracts)
    setSelectedTokenContract(current => contracts.includes(current) ? current : (contracts[0] || ''))
    setPortfolio(null)
    setTransferReview(null)
    setTransferAcknowledged(false)
    setMainnetSendPhrase('')
    setOwnerSessionToken('')
    setOwnerTreasurySnapshot(null)
    setServerTreasuryReadiness(null)
    setTreasuryPayoutConfirm('')
    setOwnerTreasuryError('')
    setTreasuryPayoutError('')
  }, [network])

  // A reusable owner bearer session must not survive a lock or wallet switch.
  // The only persisted payout data is a non-secret reference, restored only for
  // the matching unlocked owner so an ambiguous request can be safely looked up.
  useEffect(() => {
    setOwnerSessionToken('')
    setOwnerTreasurySnapshot(null)
    setServerTreasuryReadiness(null)
    setTreasuryPayoutConfirm('')
    setOwnerTreasuryError('')
    setTreasuryPayoutError('')
    const savedReference = unlocked?.record.address
      ? readTreasuryPayoutReference()
      : null
    if (savedReference && savedReference.ownerAddress === unlocked?.record.address) {
      setTreasuryPayoutStatus({
        status: 'saved-reference',
        idempotencyKey: savedReference.idempotencyKey,
        ownerAddress: savedReference.ownerAddress,
        note: 'Saved request reference only. Re-authenticate the owner and verify the status from the backend and TRON chain.',
      })
    } else {
      setTreasuryPayoutStatus(null)
    }
  }, [unlocked?.record.address])

  // Load read-only Mainnet treasury status from the private owner-console login.
  // Outgoing payouts still require a separate, request-specific signature from
  // the owner wallet held inside this app; the console password does not mint assets.
  useEffect(() => {
    let token = ''
    try {
      token = window.sessionStorage.getItem(OWNER_CONSOLE_SESSION_KEY) || ''
    } catch {
      token = ''
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

        if (!cancelled) setOwnerSessionAddress(String(sessionPayload.address))
        const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token }
        const [fundingResponse, readinessResponse] = await Promise.all([
          fetch(API_BASE + '/api/treasury/owner/funding-status?network=mainnet', {
            headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
          }),
          fetch(API_BASE + '/api/treasury/withdrawals/readiness', {
            headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
          }),
        ])
        const [funding, readiness] = await Promise.all([
          fundingResponse.json().catch(() => null),
          readinessResponse.json().catch(() => null),
        ])
        if (cancelled) return
        if (fundingResponse.ok && funding?.success === true && funding?.ownerAccessVerified === true) {
          setOwnerTreasurySnapshot(funding as OwnerTreasurySnapshot)
        } else {
          setOwnerTreasurySnapshot(null)
        }
        setServerTreasuryReadiness(readiness && typeof readiness === 'object' ? readiness : null)
        if (!fundingResponse.ok || funding?.success !== true) {
          setOwnerTreasuryError('Owner login is valid, but a verified treasury funding snapshot is unavailable. Check the configured owner and treasury addresses and backend provider status.')
        }
      } catch (caught) {
        if (cancelled) return
        setOwnerSessionAddress('')
        setOwnerTreasurySnapshot(null)
        setServerTreasuryReadiness(null)
        setOwnerTreasuryError(caught instanceof Error
          ? caught.message
          : 'Could not automatically load the Mainnet treasury status from the owner session.')
      } finally {
        requestInFlight = false
        if (!cancelled) setOwnerTreasuryLoading(false)
      }
    }
    void loadOwnerTreasuryDashboard()
    // Keep the owner-only treasury monitor fresh without creating overlapping
    // provider requests. The backend still verifies every response on-chain.
    const refreshInterval = window.setInterval(() => { void loadOwnerTreasuryDashboard() }, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(refreshInterval)
    }
  }, [unlocked?.record.address, network])


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
    if (!unlocked || network !== 'mainnet') {
      setTreasuryPayoutError('Unlock the configured owner wallet and select TRON Mainnet first.')
      return
    }
    if (!ownerSessionToken || ownerTreasurySnapshot?.ownerAccessVerified !== true) {
      setTreasuryPayoutError('Verify the owner wallet signature before requesting a treasury payout.')
      return
    }
    if (treasuryPayoutConfirm !== 'SEND TREASURY USDT') {
      setTreasuryPayoutError('Type SEND TREASURY USDT exactly to confirm this real on-chain payout.')
      return
    }
    if (!ADDRESS_PATTERN.test(treasuryPayoutRecipient)) {
      setTreasuryPayoutError('Enter a valid TRON recipient address.')
      return
    }
    setTreasuryPayoutBusy(true)
    setTreasuryPayoutError('')
    setTreasuryPayoutStatus(null)
    const idempotencyKey = 'withdrawal-' + crypto.randomUUID()
    // Save the recovery reference before network I/O. If the response is lost
    // or the app reloads, the owner can authenticate again and query this same
    // request instead of accidentally creating a second payout.
    const referenceSaved = saveTreasuryPayoutReference(unlocked.record.address, idempotencyKey)
    setTreasuryPayoutStatus({
      status: 'request-started',
      idempotencyKey,
      ownerAddress: unlocked.record.address,
      ...(!referenceSaved ? { note: 'The request key is visible here but could not be saved in device storage. Copy it before closing this screen.' } : {}),
    })
    try {
      const treasuryAddress = serverTreasuryReadiness?.treasuryAddress
      if (!ADDRESS_PATTERN.test(treasuryAddress || '')
        || treasuryAddress !== ownerTreasurySnapshot?.treasuryAddress) {
        throw new Error('The verified owner snapshot and server signing treasury do not match. No payout was signed or submitted.')
      }
      // The backend verifies this signature against the authenticated owner and the exact request.
      // Only the signed message is sent; the private key remains in the local unlocked vault.
      const amountBaseUnits = parseUnitsDecimal(treasuryPayoutAmount, 6)
      const authorizationExpiresAt = Date.now() + 90_000
      const authorizationMessage = buildTreasuryWithdrawalAuthorizationMessage({
        origin: window.location.origin,
        ownerAddress: unlocked.record.address,
        treasuryAddress,
        recipientAddress: treasuryPayoutRecipient,
        amountBaseUnits,
        idempotencyKey,
        authorizationExpiresAt,
      })
      const localSigner = createTronWeb('mainnet', unlocked.privateKey)
      const ownerAuthorizationSignature = await localSigner.trx.signMessageV2(authorizationMessage)
      if (typeof ownerAuthorizationSignature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(ownerAuthorizationSignature)) {
        throw new Error('The wallet did not produce a valid owner authorization signature. No payout was submitted.')
      }
      const response = await fetch(API_BASE + '/api/treasury/withdrawals', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + ownerSessionToken,
        },
        body: JSON.stringify({
          recipientAddress: treasuryPayoutRecipient,
          amountUsdt: treasuryPayoutAmount,
          idempotencyKey,
          ownerAuthorizationSignature,
          authorizationExpiresAt,
        }),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const payload = await response.json().catch(() => null)
      setTreasuryPayoutStatus(payload && typeof payload === 'object' ? payload : { status: 'invalid-response', idempotencyKey })
      if (!response.ok || payload?.success !== true) {
        setTreasuryPayoutError(typeof payload?.error === 'string'
          ? payload.error + (typeof payload?.note === 'string' ? ': ' + payload.note : '')
          : 'Treasury payout did not complete. Check the recorded request before retrying.')
      } else {
        setTreasuryPayoutAmount('')
        setTreasuryPayoutConfirm('')
        setNotice('Treasury payout request recorded. Verify its on-chain receipt before treating it as confirmed.')
        const readinessResponse = await fetch(API_BASE + '/api/treasury/withdrawals/readiness', {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + ownerSessionToken },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        })
        const readiness = await readinessResponse.json().catch(() => null)
        if (readiness && typeof readiness === 'object') setServerTreasuryReadiness(readiness)
      }
    } catch {
      setTreasuryPayoutError('The request outcome could not be read. Do not create a replacement request until you check the original idempotency key and chain status.')
      setTreasuryPayoutStatus({ status: 'request-outcome-unknown', idempotencyKey })
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
    const review = transferReview
    if (!unlocked || !review) throw new Error('Prepare a fresh transfer review before broadcasting.')
    if (!transferAcknowledged) throw new Error('Confirm that you checked the network, recipient, amount and irreversibility before signing.')
    if (review.network !== network || review.from !== unlocked.record.address) throw new Error('Network or wallet changed after review. Prepare the transfer again.')
    // Recheck authorization at broadcast time, not only when the review was made.
    assertOwnerMainnetTransferAccess({ network, from: review.from, snapshot: ownerTreasurySnapshot })
    if (network === 'mainnet' && mainnetSendPhrase.trim() !== 'SEND MAINNET') {
      throw new Error('For Mainnet, type SEND MAINNET exactly after reviewing the recipient and amount.')
    }

    setTransferInProgress(true)
    try {
      const web = createTronWeb(network, unlocked.privateKey)
      const from = String(web.defaultAddress?.base58 || '')
      if (from !== review.from || from !== unlocked.record.address) throw new Error('The signing account changed. Broadcasting was stopped.')
      const liveNativeBalance = BigInt(String(await web.trx.getBalance(from)))
      if (review.asset === 'TRX') {
        if (liveNativeBalance < BigInt(review.amountBaseUnits) + 1_000_000n) {
          throw new Error('The live TRX balance changed and no longer covers the transfer plus a 1 TRX fee reserve. Review again.')
        }
      } else {
        if (!review.tokenContract) throw new Error('Transfer contract is missing.')
        const freshEvidence = await inspectTokenContract(review.tokenContract)
        setTokenEvidence(current => ({ ...current, [review.tokenContract as string]: freshEvidence }))
        assertTokenTransferEvidence(freshEvidence)
        const token = await web.contract(TOKEN_ABI, review.tokenContract)
        const liveTokenBalance = BigInt(String(await token.balanceOf(from).call()))
        if (liveTokenBalance < BigInt(review.amountBaseUnits)) throw new Error('The live token balance is now lower than the reviewed amount.')
        const estimate = await estimateTRC20TransferFee({
          tronWeb: web, from, to: review.to, tokenContract: review.tokenContract, amountBaseUnits: review.amountBaseUnits,
        })
        if (estimate.recommendedFeeSun > review.feeLimitSun) {
          throw new Error('The fresh fee estimate is higher than the reviewed cap. Review the transaction again; nothing was sent.')
        }
        if (liveNativeBalance < BigInt(review.feeLimitSun)) {
          throw new Error('The live TRX balance no longer covers the reviewed transaction fee cap. Nothing was sent.')
        }
      }

      const result = await buildSignAndBroadcastTransfer({
        tronWeb: web,
        from,
        to: review.to,
        asset: review.asset,
        amountBaseUnits: review.amountBaseUnits,
        tokenContract: review.tokenContract || undefined,
        feeLimitSun: review.feeLimitSun,
      })
      const record: TransferActivity = {
        txid: result.txid,
        network: review.network,
        asset: review.asset,
        symbol: review.symbol,
        tokenContract: review.tokenContract,
        amount: review.amount,
        amountBaseUnits: review.amountBaseUnits,
        decimals: review.decimals,
        from: review.from,
        to: review.to,
        status: 'broadcast-accepted',
        submittedAt: Date.now(),
        blockNumber: null,
        solidified: false,
      }
      const next = [record, ...transferHistory.filter(item => item.txid !== record.txid)].slice(0, 100)
      const historyInitiallySaved = saveTransferHistory(next)
      setTransferHistory(next)
      setTransferReview(null)
      setTransferAcknowledged(false)
      setMainnetSendPhrase('')
      setRecipientInput('')
      setAmountInput('')
      setRefreshNonce(value => value + 1)

      let status = 'broadcast-accepted' as TransferStatus
      let blockNumber: number | null = null
      let solidified = false
      let verifiedOnChain = false
      let verificationReason = 'transaction-not-indexed-yet'
      try {
        const chainRecord = await verifyTransferRecordOnChain(web, {
          txid: record.txid,
          from: record.from,
          to: record.to,
          asset: record.asset,
          amountBaseUnits: record.amountBaseUnits,
          tokenContract: record.tokenContract || undefined,
        })
        verifiedOnChain = chainRecord.identityMatches
        verificationReason = chainRecord.reason || 'transaction-not-indexed-yet'
        if (chainRecord.identityMatches) {
          status = chainRecord.status as TransferStatus
          blockNumber = chainRecord.blockNumber ?? null
          solidified = chainRecord.solidified
        } else if (chainRecord.reason !== 'transaction-not-found') {
          status = 'identity-mismatch'
        } else {
          status = 'pending-or-not-indexed'
        }
      } catch {
        // Broadcast acceptance stays recorded, but is not promoted to verified.
      }
      const refreshed = { ...record, status, verifiedOnChain, verificationReason, blockNumber, solidified }
      const finalHistory = [refreshed, ...next.filter(item => item.txid !== refreshed.txid)].slice(0, 100)
      const historyFinallySaved = saveTransferHistory(finalHistory)
      setTransferHistory(finalHistory)
      const detail = verifiedOnChain
        ? 'The selected node returned a transaction whose sender, recipient, amount and asset match the review. Chain status: ' + status + '.'
        : status === 'identity-mismatch'
          ? 'The on-chain transaction does not match the reviewed sender, recipient, amount or token contract. Check the explorer before taking any further action.'
          : 'The node accepted the broadcast, but the transaction details have not yet been independently verified from the chain.'
      setNotice('Signed transaction broadcast was accepted by the selected TRON network. ' + detail
        + ' Transaction ID: ' + record.txid
        + (historyInitiallySaved && historyFinallySaved ? ' History saved on this device.' : ' Browser storage could not save history; copy the transaction ID now.')
        + (result.broadcastTxidMismatch ? ' The node echoed a different transaction ID; this screen retains the ID derived from the signed transaction. Verify it before retrying.' : '')
        + ' A transaction ID is not an exchange deposit credit.')
      setError('')
    } finally {
      setTransferInProgress(false)
    }
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
          <button type="button" className="wallet-vault-mobile-settings" aria-label="Open Settings" onClick={() => navigatePanel('settings')}><Settings size={16} /></button>
          <button type="button" className="wallet-vault-logout" onClick={() => void logoutOwnerSession()}><LogOut size={15} /> Logout</button>
        </div>
      </header>
      <aside className="wallet-vault-sidebar" aria-label="Owner workspace sidebar">
        <div className="wallet-vault-sidebar-kicker">WORKSPACE</div>
        <nav className="wallet-vault-sidebar-nav" aria-label="Primary owner navigation">
          <button type="button" className={activePanel === 'dashboard' ? 'is-active' : ''} aria-current={activePanel === 'dashboard' ? 'page' : undefined} onClick={() => navigatePanel('dashboard')}><Home size={17} /><span>Home</span></button>
          <button type="button" className={activePanel === 'wallet' ? 'is-active' : ''} aria-current={activePanel === 'wallet' ? 'page' : undefined} onClick={() => navigatePanel('wallet')}><Coins size={17} /><span>Assets</span></button>
          <button type="button" className={activePanel === 'send' && transferAsset === 'TRC20' ? 'is-active' : ''} aria-current={activePanel === 'send' && transferAsset === 'TRC20' ? 'page' : undefined} onClick={() => navigateSendAsset('TRC20')}><ArrowDownToLine size={17} /><span>Send USDT</span></button>
          <button type="button" className={activePanel === 'send' && transferAsset === 'TRX' ? 'is-active' : ''} aria-current={activePanel === 'send' && transferAsset === 'TRX' ? 'page' : undefined} onClick={() => navigateSendAsset('TRX')}><Send size={17} /><span>Send TRX</span></button>
          <button type="button" className={activePanel === 'treasury' ? 'is-active' : ''} aria-current={activePanel === 'treasury' ? 'page' : undefined} onClick={() => navigatePanel('treasury')}><Landmark size={17} /><span>Organization payouts</span></button>
          <button type="button" className={activePanel === 'account' ? 'is-active' : ''} aria-current={activePanel === 'account' ? 'page' : undefined} onClick={() => navigatePanel('account')}><UserRound size={17} /><span>Account</span></button>
          <button type="button" className={activePanel === 'activity' ? 'is-active' : ''} aria-current={activePanel === 'activity' ? 'page' : undefined} onClick={() => navigatePanel('activity')}><Activity size={17} /><span>Activity</span></button>
        </nav>
        <div className="wallet-vault-sidebar-settings">
          <div className="wallet-vault-sidebar-kicker"><Settings size={14} /> SETTINGS</div>
          <div className="wallet-vault-sidebar-setting-label">TRON network</div>
          <div className="wallet-vault-network wallet-vault-network--sidebar" role="group" aria-label="Blockchain network">
            {(['mainnet', 'nile', 'shasta'] as NetworkId[]).map(item => (
              <button type="button" key={item} className={network === item ? 'is-selected' : ''} aria-pressed={network === item} onClick={() => {
                setNetwork(item)
                setNotice('Network changed. Balances are read separately from the selected TRON network.')
              }}>{item === 'mainnet' ? 'Mainnet' : item === 'nile' ? 'Nile' : 'Shasta'}</button>
            ))}
          </div>
          <div className="wallet-vault-sidebar-status"><div><strong>Public treasury</strong><span>{ADDRESS_PATTERN.test(String(serverTreasuryReadiness?.treasuryAddress || '')) ? 'Address configured' : 'Not configured'}</span></div><button type="button" onClick={() => navigatePanel('treasury')}>View</button></div>
          <div className="wallet-vault-sidebar-status"><div><strong>Organization payouts</strong><span className={serverTreasuryReadiness?.withdrawalsEnabled === true ? 'is-ready' : 'is-blocked'}>{serverTreasuryReadiness?.withdrawalsEnabled === true ? 'Ready' : 'Blocked'}</span></div><button type="button" onClick={() => navigatePanel('treasury')}>Status</button></div>
          <button type="button" className={'wallet-vault-sidebar-settings-link' + (activePanel === 'settings' ? ' is-active' : '')} aria-current={activePanel === 'settings' ? 'page' : undefined} onClick={() => navigatePanel('settings')}><Settings size={16} /> All settings</button>
        </div>
      </aside>

      <section id="owner-dashboard" className="wallet-vault-hero wallet-vault-hero--compact">
        <p className="wallet-vault-eyebrow"><ShieldCheck size={15} aria-hidden="true" /> OWNER-ONLY ACCESS · REAL ON-CHAIN ASSETS</p>
        <h1>{activePanel === 'dashboard' ? 'Home' : activePanel === 'wallet' ? 'Assets' : activePanel === 'send' ? (transferAsset === 'TRC20' ? 'Send USDT' : 'Send TRX') : activePanel === 'treasury' ? 'Organization payouts' : activePanel === 'account' ? 'Account' : activePanel === 'activity' ? 'Activity' : 'Settings'}</h1>
        <p>{activePanel === 'dashboard'
          ? 'Overview of your authenticated owner account, verified treasury balances, and payout readiness. No TronLink connection is required to use this standalone owner wallet.'
          : activePanel === 'wallet'
            ? 'Read genuine on-chain assets for the unlocked wallet. Wallet creation and recovery are under Account.'
            : activePanel === 'send'
              ? 'Prepare and review real transfers. The sender must hold the asset, or a funded treasury must authorize a payout.'
              : activePanel === 'treasury'
                ? 'Inspect the public treasury address and request organization-funded payouts only from real, funded on-chain assets.'
                : activePanel === 'account'
                  ? 'Create, import, unlock, or recover the local owner signing wallet. Key material is processed on this device.'
                  : activePanel === 'activity'
                    ? 'Review local transaction records against actual chain status.'
                    : 'View public treasury settings and organization payout provider readiness.'}
        </p>
      </section>

      <div className="wallet-vault-transfer-warning wallet-vault-owner-model" role="note">
        <strong>Owner-only funding model</strong>
        <p>The owner wallet authorizes payout requests; it does not create USDT. Server-funded payouts can send only genuine USDT already held by the configured treasury, and the treasury must also have sufficient network-fee funding. If either balance is insufficient, the payout stays blocked.</p>
      </div>

      <section className="wallet-vault-transfer-section" aria-labelledby="owner-dashboard-treasury-heading" hidden={activePanel !== 'dashboard'}>
        <div className="wallet-vault-panel-head">
          <span className="wallet-vault-step">LIVE</span>
          <div>
            <h2 id="owner-dashboard-treasury-heading">Mainnet treasury overview</h2>
            <p>Loads automatically from the authenticated owner-console session. No external wallet app is needed to view status.</p>
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
              <div><small>Withdrawal readiness</small><strong>{serverTreasuryReadiness.withdrawalsEnabled === true ? 'Ready' : 'Blocked'}</strong></div>
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
        <p className="wallet-vault-caption">This is read-only status. It never generates USDT or authorizes a payout. A real payout still requires genuine treasury assets, sufficient network fees, and a fresh owner approval for the exact recipient and amount.</p>
      </section>


      <section className="wallet-vault-panel wallet-vault-quick-actions" aria-labelledby="wallet-vault-quick-actions-heading" hidden={activePanel !== 'dashboard'}>
        <div className="wallet-vault-panel-head">
          <span className="wallet-vault-step"><Activity size={16} /></span>
          <div><h2 id="wallet-vault-quick-actions-heading">Workspace shortcuts</h2><p>Open a section directly. Each workflow reports real wallet or backend status before sensitive actions.</p></div>
        </div>
        <div className="wallet-vault-quick-action-grid">
          <button type="button" className="wallet-vault-quick-action" onClick={() => navigatePanel('wallet')}><Coins size={20} /><span><strong>Assets</strong><small>Read on-chain balances and manage token watchlist</small></span></button>
          <button type="button" className="wallet-vault-quick-action" onClick={() => navigateSendAsset('TRC20')}><ArrowDownToLine size={20} /><span><strong>Send USDT</strong><small>Review recipient, contract, amount and chain fee</small></span></button>
          <button type="button" className="wallet-vault-quick-action" onClick={() => navigateSendAsset('TRX')}><Send size={20} /><span><strong>Send TRX</strong><small>Prepare a real native-TRX transfer</small></span></button>
          <button type="button" className="wallet-vault-quick-action" onClick={() => navigatePanel('treasury')}><Landmark size={20} /><span><strong>Treasury</strong><small>Check funding and payout blockers</small></span></button>
          <button type="button" className="wallet-vault-quick-action" onClick={() => navigatePanel('activity')}><Activity size={20} /><span><strong>Activity</strong><small>Re-verify saved transaction records on-chain</small></span></button>
          <button type="button" className="wallet-vault-quick-action" onClick={() => navigatePanel('account')}><UserRound size={20} /><span><strong>Account</strong><small>Create, import, unlock or back up a local wallet</small></span></button>
          <button type="button" className="wallet-vault-quick-action" onClick={() => navigatePanel('settings')}><Settings size={20} /><span><strong>Settings</strong><small>Review selected network and provider readiness</small></span></button>
        </div>
      </section>

      {error && <div className="wallet-vault-message is-error" role="alert"><X size={17} aria-hidden="true" /> {error}</div>}
      {notice && <div className="wallet-vault-message is-notice" role="status"><CheckCircle2 size={17} aria-hidden="true" /> {notice}</div>}

      <section className="wallet-vault-panel wallet-vault-settings-panel" hidden={activePanel !== 'settings'}>
        <div className="wallet-vault-panel-head"><span className="wallet-vault-step"><Settings size={16} /></span><div><h2>Settings</h2><p>These values reflect server configuration and chain reads; controls here do not pretend to change Render settings.</p></div></div>
        <div className="wallet-vault-settings-grid">
          <article className="wallet-vault-setting-card">
            <div className="wallet-vault-setting-card-title"><Landmark size={18} /><div><strong>Public treasury address</strong><small>Read-only monitoring</small></div></div>
            <p>{ADDRESS_PATTERN.test(String(serverTreasuryReadiness?.treasuryAddress || '')) ? serverTreasuryReadiness.treasuryAddress : 'No public treasury address is configured.'}</p>
            <span className={'wallet-vault-state-pill ' + (ADDRESS_PATTERN.test(String(serverTreasuryReadiness?.treasuryAddress || '')) ? 'is-ready' : 'is-blocked')}>{ADDRESS_PATTERN.test(String(serverTreasuryReadiness?.treasuryAddress || '')) ? 'Address configured' : 'Not configured'}</span>
            <button type="button" className="wallet-vault-secondary" onClick={() => navigatePanel('treasury')}>Open treasury monitor</button>
          </article>
          <article className="wallet-vault-setting-card">
            <div className="wallet-vault-setting-card-title"><ShieldCheck size={18} /><div><strong>Organization payout provider</strong><small>Backend-enforced readiness</small></div></div>
            <p>Payouts require an exact owner signature, an authorized treasury signer, genuine on-chain USDT, persistent request records, and network-fee funding.</p>
            <span className={'wallet-vault-state-pill ' + (serverTreasuryReadiness?.withdrawalsEnabled === true ? 'is-ready' : 'is-blocked')}>{serverTreasuryReadiness?.withdrawalsEnabled === true ? 'Ready' : 'Blocked by backend checks'}</span>
            <button type="button" className="wallet-vault-secondary" onClick={() => navigatePanel('treasury')}>Review payout readiness</button>
          </article>
          <article className="wallet-vault-setting-card">
            <div className="wallet-vault-setting-card-title"><Wallet size={18} /><div><strong>Local wallet security</strong><small>Owner-controlled keys</small></div></div>
            <p>The owner signing wallet can authorize a payout without holding the payout USDT. The treasury still must hold real USDT and transaction-fee resources.</p>
            <button type="button" className="wallet-vault-secondary" onClick={() => navigatePanel('account')}>Open Account</button>
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
          <div><small>Payout readiness</small><strong>{serverTreasuryReadiness?.withdrawalsEnabled === true ? 'Ready' : 'Blocked'}</strong></div>
        </div>
        {Array.isArray(serverTreasuryReadiness?.payoutBlockers) && serverTreasuryReadiness.payoutBlockers.length > 0 && <p className="wallet-vault-risk-note" role="status"><strong>Current blockers:</strong> {serverTreasuryReadiness.payoutBlockers.map((item: string) => item.replaceAll('-', ' ')).join('; ')}</p>}
        {ownerTreasuryError && <p className="wallet-vault-risk-note" role="alert">{ownerTreasuryError}</p>}
        <p className="wallet-vault-caption">The owner's personal wallet need not hold the payout USDT. An organization must fund the treasury first, and the authorized owner must sign each exact payout request.</p>
        <button type="button" className="wallet-vault-primary" onClick={() => navigatePanel('account')}><UserRound size={16} /> Open Account to authorize a payout</button>
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
                          <ShieldCheck size={16} /> Use funded treasury for a real USDT payout
                        </button>
                      )}
                      {ownerTreasurySnapshot.treasuryAddress && ownerTreasurySnapshot.treasuryAddress !== unlocked.record.address && (
                        <p className="wallet-vault-risk-note" role="note">The watched treasury address is different from the currently unlocked wallet. The Send section below can sign only from the unlocked wallet address; this watch-only address cannot authorize a payout. To send treasury funds, the treasury wallet must be unlocked locally with its matching private key and must hold the real assets.</p>
                      )}
                    </>
                  )}
                  <div className="wallet-vault-transfer-warning" role="note">
                    <strong>Server treasury payout (separate funded wallet)</strong>
                    <p>The backend signs from TREASURY_ADDRESS using a server-only key. Your owner wallet only authorizes the request; it does not need to hold the USDT principal. This remains disabled until the backend is configured with a funded treasury, persistent database, explicit payout limits, and the signer key matching the treasury address.</p>
                  </div>
                  {serverTreasuryReadiness && (
                    <div className="wallet-vault-review-grid">
                      <div className="wallet-vault-review-wide"><small>Server treasury address</small><strong>{serverTreasuryReadiness.treasuryAddress || 'Not configured'}</strong></div>
                      <div><small>Server payout readiness</small><strong>{serverTreasuryReadiness.withdrawalsEnabled === true ? 'Ready' : 'Blocked'}</strong></div>
                      <div><small>Verified treasury USDT</small><strong>{typeof serverTreasuryReadiness.treasuryUsdtBalanceBaseUnits === 'string' ? formatUnits(serverTreasuryReadiness.treasuryUsdtBalanceBaseUnits, 6) + ' USDT' : 'Unavailable'}</strong></div>
                      <div><small>Verified treasury TRX</small><strong>{typeof serverTreasuryReadiness.treasuryTrxBalanceSun === 'string' ? formatUnits(serverTreasuryReadiness.treasuryTrxBalanceSun, 6) + ' TRX' : 'Unavailable'}</strong></div>
                      <div><small>Configured max fee cap</small><strong>{typeof serverTreasuryReadiness.treasuryFeeLimitSun === 'string' ? formatUnits(serverTreasuryReadiness.treasuryFeeLimitSun, 6) + ' TRX' : 'Unavailable'}</strong></div>
                      <div><small>Fee cap funding check</small><strong>{serverTreasuryReadiness.networkFeeCapCovered === true ? 'Covered' : 'Not covered'}</strong></div>
                    </div>
                  )}
                  {serverTreasuryReadiness?.withdrawalsEnabled !== true && (
                    <div className="wallet-vault-transfer-warning" role="status">
                      <strong>Real payout readiness</strong>
                      <p>Server-funded USDT withdrawals remain disabled unless the backend signer, persistent database, payout limits and actual treasury balance all pass checks. This screen never creates USDT or pays a recipient from an empty treasury.</p>
                      {Array.isArray(serverTreasuryReadiness?.configuration?.missing) && serverTreasuryReadiness.configuration.missing.length > 0 && (
                        <p><strong>Backend configuration still missing:</strong> {serverTreasuryReadiness.configuration.missing.join(', ')}</p>
                      )}
                      {Array.isArray(serverTreasuryReadiness?.payoutBlockers) && serverTreasuryReadiness.payoutBlockers.length > 0 && (
                        <p><strong>Current funding/readiness blockers:</strong> {serverTreasuryReadiness.payoutBlockers.map((item: string) => item.replaceAll('-', ' ')).join('; ')}</p>
                      )}
                      {serverTreasuryReadiness?.payoutBlockers?.includes('treasury-trx-below-fee-cap') && (
                        <p>The treasury needs a verified TRX balance at least equal to the configured fee cap before this payout path is enabled. The owner wallet does not pay the treasury's fee.</p>
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
                  <div className="wallet-vault-form-grid">
                    <label className="wallet-vault-field"><span>Recipient TRON address</span><input value={treasuryPayoutRecipient} onChange={event => setTreasuryPayoutRecipient(event.target.value.trim())} placeholder="T..." autoComplete="off" /></label>
                    <label className="wallet-vault-field"><span>USDT amount</span><input value={treasuryPayoutAmount} onChange={event => setTreasuryPayoutAmount(event.target.value)} placeholder="0.00" inputMode="decimal" autoComplete="off" /></label>
                    <label className="wallet-vault-field wallet-vault-review-wide"><span>Type SEND TREASURY USDT to confirm</span><input value={treasuryPayoutConfirm} onChange={event => setTreasuryPayoutConfirm(event.target.value)} placeholder="SEND TREASURY USDT" autoComplete="off" /></label>
                  </div>
                  <button type="button" className="wallet-vault-primary" disabled={treasuryPayoutBusy || ownerTreasuryLoading || !canSubmitServerTreasuryPayout} onClick={() => void submitServerTreasuryPayout()}>
                    <ShieldCheck size={16} /> {treasuryPayoutBusy ? 'Processing treasury request…' : 'Send genuine USDT from server treasury'}
                  </button>
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
                  <p className="wallet-vault-caption">Sponsored transfer submission remains disabled. No user-funded fallback, hidden balance, or external exchange credit is created by this panel.</p>
                </section>
              )}

              <section id="wallet-vault-transfer" className="wallet-vault-transfer-section" aria-labelledby="wallet-vault-transfer-heading" hidden={activePanel !== 'send'}>
                <div className="wallet-vault-panel-head">
                  <span className="wallet-vault-step">03</span>
                  <div><h2 id="wallet-vault-transfer-heading">{network === 'mainnet' ? 'Send from this wallet' : 'Send a testnet transfer'}</h2><p>{network === 'mainnet' ? 'This path spends assets held by the unlocked wallet. If the owner wallet does not hold USDT, use the separate Treasury payout section, which requires a funded server treasury.' : 'Review, sign locally and broadcast a real testnet transaction. Testnet tokens have no Mainnet value.'}</p></div>
                </div>
                <div className="wallet-vault-transfer-warning" role="note">
                  <strong>Irreversible network transaction</strong>
                  <p>This sends actual assets from the unlocked wallet. Check the complete recipient address and selected network. A successful chain transfer does not by itself create an exchange deposit credit; the receiving exchange must independently detect and credit a valid deposit. Do not send to an exchange without checking its deposit network and requirements.</p>
                  {network === 'mainnet' && <p><strong>Mainnet caution:</strong> this password-encrypted browser wallet has not undergone an independent wallet-security audit and is not hardware-backed. Do not keep substantial value in an unaudited browser wallet.</p>}
                  {network !== 'mainnet' && <p>Testnet assets have no monetary value and will not credit a Mainnet exchange deposit.</p>}
                </div>

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
                    <div className="wallet-vault-review-header"><ShieldCheck size={19} /><div><strong>Review before signing</strong><small>No transaction has been sent yet.</small></div></div>
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
                      <button type="button" className="wallet-vault-primary" disabled={busy || transferInProgress || !transferAcknowledged || (network === 'mainnet' && mainnetSendPhrase.trim() !== 'SEND MAINNET')} onClick={() => void performWalletAction(broadcastTransfer)}>
                        <ShieldCheck size={16} /> {transferInProgress || busy ? 'Signing/broadcasting…' : 'Sign and broadcast real transfer'}
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
        <button type="button" className={activePanel === 'send' && transferAsset === 'TRC20' ? 'is-active' : ''} aria-current={activePanel === 'send' && transferAsset === 'TRC20' ? 'page' : undefined} onClick={() => navigateSendAsset('TRC20')}><ArrowDownToLine size={18} /><span>USDT</span></button>
        <button type="button" className={activePanel === 'send' && transferAsset === 'TRX' ? 'is-active' : ''} aria-current={activePanel === 'send' && transferAsset === 'TRX' ? 'page' : undefined} onClick={() => navigateSendAsset('TRX')}><Send size={18} /><span>TRX</span></button>
        <button type="button" className={activePanel === 'treasury' ? 'is-active' : ''} aria-current={activePanel === 'treasury' ? 'page' : undefined} onClick={() => navigatePanel('treasury')}><Landmark size={18} /><span>Treasury</span></button>
        <button type="button" className={activePanel === 'activity' ? 'is-active' : ''} aria-current={activePanel === 'activity' ? 'page' : undefined} onClick={() => navigatePanel('activity')}><Activity size={18} /><span>Activity</span></button>
        <button type="button" className={activePanel === 'account' ? 'is-active' : ''} aria-current={activePanel === 'account' ? 'page' : undefined} onClick={() => navigatePanel('account')}><UserRound size={18} /><span>Account</span></button>
      </nav>

      <footer className="wallet-vault-footer"><span><ShieldCheck size={15} /> Keys stay on this device</span><span><Activity size={15} /> Real on-chain reads</span><span><LockKeyhole size={15} /> No hidden balance edits</span></footer>
    </main>
  )
}
