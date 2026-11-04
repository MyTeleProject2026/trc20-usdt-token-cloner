import { useEffect, useMemo, useState } from 'react'
import { TronWeb } from 'tronweb'
import {
  Activity, AlertTriangle, ArrowDownLeft, ArrowUpRight, CheckCircle2, ChevronDown,
  CircleHelp, Copy, ExternalLink, Eye, EyeOff, FileKey2, KeyRound, LockKeyhole,
  LogOut, Plus, RefreshCw, Send, ShieldCheck, Wallet, X,
} from 'lucide-react'
import {
  parseUnitsDecimal,
  estimateTRC20TransferFee,
  buildSignAndBroadcastTransfer,
  verifyTransferRecordOnChain,
  readConfirmedTransferStatus,
} from './lib/wallet-transfer.mjs'
import {
  encryptWalletPrivateKey,
  decryptWalletPrivateKey,
  isEncryptedWalletRecord,
} from './lib/wallet-vault-crypto.mjs'

const NETWORKS = Object.freeze({
  nile: { label: 'Nile Testnet', rpc: 'https://nile.trongrid.io', explorer: 'https://nile.tronscan.org' },
  shasta: { label: 'Shasta Testnet', rpc: 'https://api.shasta.trongrid.io', explorer: 'https://shasta.tronscan.org' },
})
const WALLET_KEY = 'tron-transfer:testnet-wallet:v1'
const TOKEN_KEY = 'tron-transfer:testnet-tokens:v1'
const HISTORY_KEY = 'tron-transfer:testnet-history:v1'
const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\/+$/, '')
const OWNER_SESSION_KEY = 'tron-transfer:owner-session:v1'
const REQUESTER_WALLET_SESSION_KEY = 'tron-transfer:requester-wallet-session:v1'
const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TX_RE = /^[0-9a-f]{64}$/i
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const TOKEN_ABI = [
  { constant: true, inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'symbol', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'name', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
]

function clientFor(network, privateKey) {
  const selected = NETWORKS[network]
  if (!selected) throw new Error('Only Nile and Shasta testnets are available in this application.')
  return new TronWeb({ fullHost: `${API_BASE}/api/tron-transfer/rpc/${network}`, ...(privateKey ? { privateKey } : {}) })
}
function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback } catch { return fallback }
}
function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}
function formatUnits(value, decimals = 6) {
  try {
    const amount = BigInt(String(value || '0'))
    const base = 10n ** BigInt(decimals)
    const whole = amount / base
    const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '')
    return fraction ? whole.toString() + '.' + fraction : whole.toString()
  } catch { return '0' }
}
function shorten(value) {
  return value && value.length > 18 ? value.slice(0, 9) + '…' + value.slice(-7) : value || '—'
}
function txUrl(network, txid) {
  return NETWORKS[network] && TX_RE.test(String(txid || ''))
    ? NETWORKS[network].explorer + '/#/transaction/' + txid.toLowerCase() : null
}
function addressUrl(network, address) {
  return NETWORKS[network] && ADDRESS_RE.test(String(address || ''))
    ? NETWORKS[network].explorer + '/#/address/' + encodeURIComponent(address) : null
}
function cleanHistory(value) {
  if (!Array.isArray(value)) return []
  return value.filter(item => item && NETWORKS[item.network] && TX_RE.test(String(item.txid || ''))
    && ADDRESS_RE.test(String(item.from || '')) && ADDRESS_RE.test(String(item.to || ''))
    && ['TRX', 'TRC20'].includes(item.asset) && /^[1-9][0-9]{0,77}$/.test(String(item.amountBaseUnits || ''))
    && Number.isInteger(item.decimals) && item.decimals >= 0 && item.decimals <= 18
    && (item.asset === 'TRX' || ADDRESS_RE.test(String(item.tokenContract || ''))))
    .slice(0, 40)
}
function normalizeHex(value) {
  return String(value || '').replace(/^0x/i, '').replace(/^41/i, '').toLowerCase()
}
async function verifyTokenReceipt(web, item) {
  const info = await web.trx.getTransactionInfo(item.txid)
  if (String(info?.receipt?.result || info?.result || '').toUpperCase() !== 'SUCCESS') {
    return { status: info?.receipt?.result ? 'failed' : 'awaiting-solidification', reason: 'token-receipt-not-successful' }
  }
  const expectedContract = normalizeHex(web.address.toHex(item.tokenContract))
  const expectedFrom = normalizeHex(web.address.toHex(item.from))
  const expectedTo = normalizeHex(web.address.toHex(item.to))
  const logs = Array.isArray(info?.log) ? info.log : Array.isArray(info?.logs) ? info.logs : []
  const match = logs.some(log => {
    const topics = Array.isArray(log?.topics) ? log.topics.map(value => String(value).toLowerCase()) : []
    if (normalizeHex(log?.address) !== expectedContract || topics[0] !== TRANSFER_TOPIC || topics.length < 3) return false
    const from = topics[1].slice(-40)
    const to = topics[2].slice(-40)
    let amount
    try { amount = BigInt('0x' + String(log?.data || '').replace(/^0x/i, '')) } catch { return false }
    return from === expectedFrom && to === expectedTo && amount === BigInt(item.amountBaseUnits)
  })
  return match
    ? { status: 'verified-on-chain', reason: 'successful-transfer-event-matched' }
    : { status: 'verification-mismatch', reason: 'matching-transfer-event-not-found' }
}

export default function App() {
  const [network, setNetwork] = useState('nile')
  const [walletRecord, setWalletRecord] = useState(() => readJson(WALLET_KEY, null))
  const [unlocked, setUnlocked] = useState(null)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [privateKeyInput, setPrivateKeyInput] = useState('')
  const [backupText, setBackupText] = useState('')
  const [walletMode, setWalletMode] = useState('import')
  const [showKey, setShowKey] = useState(false)
  const [tokens, setTokens] = useState(() => readJson(TOKEN_KEY, { nile: [], shasta: [] }))
  const [tokenInput, setTokenInput] = useState('')
  const [portfolio, setPortfolio] = useState(null)
  const [balanceBusy, setBalanceBusy] = useState(false)
  const [history, setHistory] = useState(() => cleanHistory(readJson(HISTORY_KEY, [])))
  const [recipient, setRecipient] = useState('')
  const [asset, setAsset] = useState('TRX')
  const [tokenAddress, setTokenAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [review, setReview] = useState(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('overview')
  const [recipientNetwork, setRecipientNetwork] = useState('mainnet')
  const [recipientAddress, setRecipientAddress] = useState('')
  const [recipientTokenContract, setRecipientTokenContract] = useState('')
  const [recipientInspection, setRecipientInspection] = useState(null)
  const [recipientBusy, setRecipientBusy] = useState(false)
  const [sponsorRecipientAddress, setSponsorRecipientAddress] = useState('')
  const [sponsorAmount, setSponsorAmount] = useState('')
  const [beneficiaryName, setBeneficiaryName] = useState('')
  const [beneficiaryEmail, setBeneficiaryEmail] = useState('')
  const [sponsorRequests, setSponsorRequests] = useState([])
  const [sponsorRequestBusy, setSponsorRequestBusy] = useState(false)
  const [ownerAddressInput, setOwnerAddressInput] = useState('')
  const [ownerPasswordInput, setOwnerPasswordInput] = useState('')
  const [ownerSession, setOwnerSession] = useState(null)
  const [requesterSession, setRequesterSession] = useState(null)
  const [fincraReadiness, setFincraReadiness] = useState(null)

  const networkTokens = tokens[network] || []
  const selectedToken = networkTokens.find(token => token.contract === tokenAddress) || networkTokens[0]
  const unlockedAddress = unlocked?.address || ''

  useEffect(() => { writeJson(HISTORY_KEY, history) }, [history])
  useEffect(() => { writeJson(TOKEN_KEY, tokens) }, [tokens])
  useEffect(() => {
    void refreshProviderReadiness()
    try {
      const token = sessionStorage.getItem(OWNER_SESSION_KEY)
      if (token) void restoreOwnerSession(token)
      const requesterToken = sessionStorage.getItem(REQUESTER_WALLET_SESSION_KEY)
      if (requesterToken) void restoreRequesterWalletSession(requesterToken)
    } catch {
      // Owner/requester sign-in can be repeated if session storage is blocked.
    }
  }, [])
  useEffect(() => {
    setPortfolio(null)
    setReview(null)
    setAcknowledged(false)
    setNotice('')
    setError('')
    setTokenAddress('')
  }, [network])

  const canReview = Boolean(unlocked && recipient.trim() && amount.trim() && (asset === 'TRX' || selectedToken))
  const explorer = useMemo(() => addressUrl(network, unlockedAddress), [network, unlockedAddress])

  async function saveAndUnlock(key, address, chosenPassword) {
    const record = await encryptWalletPrivateKey(key, address, chosenPassword)
    writeJson(WALLET_KEY, record)
    setWalletRecord(record)
    setUnlocked({ address, privateKey: key.replace(/^0x/i, '').toLowerCase() })
    setPassword('')
    setConfirmPassword('')
    setPrivateKeyInput('')
    setBackupText('')
    setNotice('Wallet encrypted and saved in this browser. The private key is not sent to a server.')
    setError('')
  }
  async function createWallet() {
    if (password.length < 12 || password !== confirmPassword) throw new Error('Use a matching wallet password of at least 12 characters.')
    const web = clientFor(network)
    const account = await web.createAccount()
    if (!account?.privateKey || !ADDRESS_RE.test(account?.address?.base58 || '')) throw new Error('Local wallet generation failed.')
    await saveAndUnlock(account.privateKey, account.address.base58, password)
  }
  async function importWallet() {
    if (password.length < 12 || password !== confirmPassword) throw new Error('Use a matching wallet password of at least 12 characters.')
    const key = privateKeyInput.trim().replace(/^0x/i, '')
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('Enter a 64-character hexadecimal private key.')
    const web = clientFor(network, key)
    const address = String(web.defaultAddress?.base58 || '')
    if (!ADDRESS_RE.test(address) || !web.isAddress(address)) throw new Error('The private key did not produce a valid TRON address.')
    await saveAndUnlock(key, address, password)
  }
  async function restoreWallet() {
    if (!backupText.trim() || !password) throw new Error('Choose an encrypted wallet backup and enter its password.')
    const parsed = JSON.parse(backupText)
    const record = parsed?.wallet || parsed
    if (!isEncryptedWalletRecord(record)) throw new Error('This is not a supported encrypted Tron Token Studio wallet backup.')
    const key = await decryptWalletPrivateKey(record, password)
    const web = clientFor(network, key)
    if (String(web.defaultAddress?.base58 || '') !== record.address) throw new Error('The backup key does not match its recorded address.')
    writeJson(WALLET_KEY, record)
    setWalletRecord(record)
    setUnlocked({ address: record.address, privateKey: key })
    setPassword('')
    setBackupText('')
    setNotice('Encrypted wallet backup restored locally.')
  }
  async function unlockWallet() {
    if (!walletRecord || !password) throw new Error('Choose the saved wallet and enter its password.')
    const key = await decryptWalletPrivateKey(walletRecord, password)
    const web = clientFor(network, key)
    if (String(web.defaultAddress?.base58 || '') !== walletRecord.address) throw new Error('Wallet address verification failed.')
    setUnlocked({ address: walletRecord.address, privateKey: key })
    setPassword('')
    setNotice('Wallet unlocked. The signing key is held in memory only until you lock or leave this page.')
  }
  function lockWallet() {
    setUnlocked(null)
    setPortfolio(null)
    setReview(null)
    setAcknowledged(false)
    setPassword('')
    setNotice('Wallet locked. The decrypted signing key has been cleared from application state.')
  }
  async function refreshBalances() {
    if (!unlocked) throw new Error('Unlock your wallet first.')
    setBalanceBusy(true)
    try {
      const web = clientFor(network)
      const sun = await web.trx.getBalance(unlocked.address)
      const tokenBalances = await Promise.all(networkTokens.map(async token => {
        try {
          const contract = await web.contract(TOKEN_ABI, token.contract)
          const value = await contract.balanceOf(unlocked.address).call()
          return { ...token, balanceBaseUnits: String(value), balance: formatUnits(value, token.decimals), error: null }
        } catch (cause) {
          return { ...token, balanceBaseUnits: '0', balance: 'Unavailable', error: cause instanceof Error ? cause.message : 'Token balance read failed.' }
        }
      }))
      setPortfolio({ trxSun: String(sun), trx: formatUnits(sun, 6), tokens: tokenBalances, checkedAt: new Date().toISOString() })
      setNotice('Balances refreshed directly from the selected TRON testnet.')
      setError('')
    } finally { setBalanceBusy(false) }
  }
  async function addToken() {
    if (!unlocked) throw new Error('Unlock your wallet before adding a token.')
    const address = tokenInput.trim()
    const web = clientFor(network)
    if (!web.isAddress(address) || !ADDRESS_RE.test(address)) throw new Error('Enter a valid TRON contract address.')
    const contract = await web.contract(TOKEN_ABI, address)
    const [symbol, decimals, name] = await Promise.all([
      contract.symbol().call(), contract.decimals().call(), contract.name().call().catch(() => 'Unknown token'),
    ])
    const precision = Number(decimals)
    if (!Number.isInteger(precision) || precision < 0 || precision > 18) throw new Error('The contract returned unsupported token decimals.')
    const token = { contract: address, symbol: String(symbol).slice(0, 16), name: String(name).slice(0, 48), decimals: precision }
    const next = { ...tokens, [network]: [...networkTokens.filter(item => item.contract !== address), token].slice(0, 20) }
    setTokens(next)
    setTokenAddress(address)
    setTokenInput('')
    setNotice('Token contract metadata verified from the selected testnet and added to this browser watchlist.')
  }
  async function prepareTransfer() {
    if (!unlocked) throw new Error('Unlock the wallet before preparing a transfer.')
    const web = clientFor(network, unlocked.privateKey)
    const to = recipient.trim()
    if (!web.isAddress(to) || !ADDRESS_RE.test(to)) throw new Error('Enter a valid TRON Base58 recipient address.')
    if (to === unlocked.address) throw new Error('Sender and recipient must be different.')
    const decimals = asset === 'TRX' ? 6 : selectedToken?.decimals
    if (!Number.isInteger(decimals)) throw new Error('Select a verified testnet TRC-20 token.')
    const amountBaseUnits = parseUnitsDecimal(amount, decimals)
    let symbol = 'TRX'
    let feeLimitSun = 1_000_000
    let energyRequired = null
    if (asset === 'TRX') {
      const balance = BigInt(String(await web.trx.getBalance(unlocked.address)))
      if (balance < BigInt(amountBaseUnits) + 1_000_000n) throw new Error('Insufficient testnet TRX. Keep at least 1 TRX available for network fees.')
    } else {
      symbol = selectedToken.symbol
      const contract = await web.contract(TOKEN_ABI, selectedToken.contract)
      const balance = BigInt(String(await contract.balanceOf(unlocked.address).call()))
      if (balance < BigInt(amountBaseUnits)) throw new Error('Insufficient token balance on the selected testnet.')
      const estimate = await estimateTRC20TransferFee({
        tronWeb: web, from: unlocked.address, to, tokenContract: selectedToken.contract, amountBaseUnits,
      })
      feeLimitSun = estimate.recommendedFeeSun
      energyRequired = estimate.energyRequired
      const nativeBalance = BigInt(String(await web.trx.getBalance(unlocked.address)))
      if (nativeBalance < BigInt(feeLimitSun)) throw new Error('Insufficient testnet TRX for the estimated token-transfer fee. Obtain testnet TRX or arrange genuine testnet resource delegation.')
    }
    setReview({
      network, from: unlocked.address, to, asset, symbol, tokenContract: asset === 'TRC20' ? selectedToken.contract : null,
      amount, amountBaseUnits, decimals, feeLimitSun, energyRequired,
    })
    setAcknowledged(false)
    setNotice('Transfer review prepared from live testnet balances. Nothing has been signed or broadcast yet.')
  }
  async function sendTransfer() {
    if (!unlocked || !review || !acknowledged) throw new Error('Unlock the wallet, review the transfer and acknowledge the exact details.')
    if (review.network !== network || review.from !== unlocked.address) throw new Error('Network or sender changed after review. Prepare the transfer again.')
    const web = clientFor(network, unlocked.privateKey)
    const result = await buildSignAndBroadcastTransfer({
      tronWeb: web, from: review.from, to: review.to, asset: review.asset,
      amountBaseUnits: review.amountBaseUnits, tokenContract: review.tokenContract || undefined,
      feeLimitSun: review.feeLimitSun,
      broadcast: async (signedTransaction) => {
        try {
          const response = await fetch(API_BASE + '/api/tron-transfer/broadcast', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            credentials: 'omit', cache: 'no-store',
            body: JSON.stringify({ network, transaction: signedTransaction }),
          })
          const payload = await response.json().catch(() => null)
          if (payload?.status === 'broadcast-outcome-unknown') {
            return { result: true, txid: payload.txid || signedTransaction.txID, broadcastOutcomeUnknown: true }
          }
          if (!response.ok || payload?.success !== true) {
            return { result: false, code: payload?.error || 'tatum-broadcast-rejected' }
          }
          return { result: true, txid: payload.txid || signedTransaction.txID }
        } catch {
          // Retain the locally computed txID as an unknown outcome, not as a failure.
          return { result: true, txid: signedTransaction.txID, broadcastOutcomeUnknown: true }
        }
      },
    })
    const item = {
      txid: result.txid, network, from: result.source, to: result.destination, asset: review.asset,
      tokenContract: result.tokenContract, symbol: review.symbol, amountBaseUnits: review.amountBaseUnits,
      amount: review.amount, decimals: review.decimals,
      status: result.broadcastOutcomeUnknown ? 'broadcast-outcome-unknown' : 'broadcast-accepted',
      verification: result.broadcastOutcomeUnknown ? 'reconcile-original-txid-no-replacement' : 'awaiting-solidification',
      submittedAt: Date.now(),
    }
    setHistory(current => [item, ...current.filter(entry => entry.txid !== item.txid)].slice(0, 40))
    setReview(null)
    setAcknowledged(false)
    setRecipient('')
    setAmount('')
    setNotice('The selected testnet node accepted the signed transaction. This is not yet proof of successful execution; refresh its on-chain status.')
    setActiveTab('activity')
  }
  async function refreshProviderReadiness(token = ownerSession?.sessionToken) {
    if (!token) {
      setFincraReadiness(null)
      return
    }
    try {
      const response = await fetch(API_BASE + '/api/tron-transfer/readiness', {
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
        credentials: 'omit', cache: 'no-store',
      })
      const payload = await response.json().catch(() => null)
      if (response.ok && payload?.success === true) setFincraReadiness(payload)
      else setFincraReadiness(null)
    } catch {
      setFincraReadiness(null)
    }
  }
  async function inspectRecipient() {
    if (!ADDRESS_RE.test(recipientAddress.trim())) throw new Error('Enter a valid TRON recipient address.')
    setRecipientBusy(true)
    try {
      const query = new URLSearchParams({ network: recipientNetwork, address: recipientAddress.trim() })
      if (recipientTokenContract.trim()) query.set('tokenContract', recipientTokenContract.trim())
      const response = await fetch(API_BASE + '/api/tron-transfer/recipient?' + query.toString(), {
        headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store',
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true) throw new Error(payload?.error || 'TRON providers could not inspect this recipient.')
      setRecipientInspection(payload)
      setNotice('Recipient balances were read through Tatum; incoming transaction history was read from the selected TRON network history service.')
    } finally {
      setRecipientBusy(false)
    }
  }
  async function restoreRequesterWalletSession(token) {
    try {
      const response = await fetch(API_BASE + '/api/auth/tron/session', {
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
        credentials: 'omit', cache: 'no-store',
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true || payload?.authenticated !== true
        || payload.network !== 'mainnet' || !ADDRESS_RE.test(String(payload.address || ''))
        || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) {
        sessionStorage.removeItem(REQUESTER_WALLET_SESSION_KEY)
        setRequesterSession(null)
        return
      }
      setRequesterSession({ address: payload.address, network: 'mainnet', expiresAt: payload.expiresAt, sessionToken: token })
    } catch {
      setRequesterSession(null)
    }
  }
  async function verifyRequesterWalletOwnership() {
    if (!unlocked) throw new Error('Unlock your local wallet before proving requester ownership.')
    const signer = new TronWeb({ privateKey: unlocked.privateKey })
    if (String(signer.defaultAddress?.base58 || '') !== unlocked.address
      || typeof signer.trx?.signMessageV2 !== 'function') {
      throw new Error('The unlocked local wallet cannot sign the Mainnet identity challenge.')
    }
    const challengeResponse = await fetch(API_BASE + '/api/auth/tron/challenge', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: unlocked.address, network: 'mainnet' }),
      credentials: 'omit', cache: 'no-store', redirect: 'error',
    })
    const challenge = await challengeResponse.json().catch(() => null)
    if (!challengeResponse.ok || challenge?.success !== true || challenge.network !== 'mainnet'
      || typeof challenge.message !== 'string' || typeof challenge.nonce !== 'string'
      || !Number.isFinite(challenge.expiresAt) || challenge.expiresAt <= Date.now()) {
      throw new Error(challenge?.message || challenge?.error || 'Could not create a Mainnet wallet ownership challenge.')
    }
    // A message signature proves control of this address only; it is not a TRON transaction.
    const signature = await signer.trx.signMessageV2(challenge.message)
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)
      || String(signer.defaultAddress?.base58 || '') !== unlocked.address) {
      throw new Error('The local wallet returned an invalid signature or changed address during signing.')
    }
    const verifyResponse = await fetch(API_BASE + '/api/auth/tron/verify', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: unlocked.address, network: 'mainnet', nonce: challenge.nonce, signature }),
      credentials: 'omit', cache: 'no-store', redirect: 'error',
    })
    const verified = await verifyResponse.json().catch(() => null)
    if (!verifyResponse.ok || verified?.success !== true || verified?.authenticated !== true
      || verified.address !== unlocked.address || verified.network !== 'mainnet'
      || typeof verified.sessionToken !== 'string' || !Number.isFinite(verified.expiresAt)) {
      throw new Error(verified?.message || verified?.error || 'The backend did not verify the requester wallet signature.')
    }
    sessionStorage.setItem(REQUESTER_WALLET_SESSION_KEY, verified.sessionToken)
    const session = { address: verified.address, network: 'mainnet', expiresAt: verified.expiresAt, sessionToken: verified.sessionToken }
    setRequesterSession(session)
    setNotice('Mainnet requester wallet ownership verified. This identity session authorizes no payout or transaction.')
  }
  async function signOutRequesterWallet() {
    const token = requesterSession?.sessionToken
    try { sessionStorage.removeItem(REQUESTER_WALLET_SESSION_KEY) } catch {}
    setRequesterSession(null)
    if (token) {
      void fetch(API_BASE + '/api/auth/tron/logout', {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
        credentials: 'omit', cache: 'no-store',
      }).catch(() => undefined)
    }
    setNotice('Requester wallet identity session signed out.')
  }
  async function submitSponsorRequest() {
    if (!requesterSession?.sessionToken || requesterSession.network !== 'mainnet'
      || !ADDRESS_RE.test(requesterSession.address)) {
      throw new Error('Verify a Mainnet requester wallet before submitting this sponsor request.')
    }
    if (!ADDRESS_RE.test(sponsorRecipientAddress.trim())) throw new Error('Enter a valid Mainnet TRON recipient address.')
    if (!sponsorAmount.trim() || !beneficiaryName.trim()) throw new Error('Enter the requested USDT amount and beneficiary name.')
    const response = await fetch(API_BASE + '/api/tron-transfer/sponsor-requests', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + requesterSession.sessionToken,
      },
      credentials: 'omit', cache: 'no-store',
      body: JSON.stringify({
        requesterAddress: requesterSession.address,
        recipientAddress: sponsorRecipientAddress.trim(),
        beneficiaryName: beneficiaryName.trim(),
        beneficiaryEmail: beneficiaryEmail.trim(),
        amount: sponsorAmount.trim(),
        customerReference: 'tt-' + crypto.randomUUID(),
      }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.success !== true) throw new Error(payload?.message || payload?.error || 'Sponsor request could not be recorded.')
    setSponsorRecipientAddress('')
    setSponsorAmount('')
    setBeneficiaryName('')
    setBeneficiaryEmail('')
    setNotice('Sponsor request recorded for organization review. No USDT payout was initiated.')
    if (ownerSession?.sessionToken) await loadSponsorRequests(ownerSession.sessionToken)
  }
  async function restoreOwnerSession(token) {
    try {
      const response = await fetch(API_BASE + '/api/auth/owner/session', {
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
        credentials: 'omit', cache: 'no-store',
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true || payload?.authenticated !== true
        || !ADDRESS_RE.test(String(payload.address || '')) || payload.network !== 'mainnet'
        || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) {
        sessionStorage.removeItem(OWNER_SESSION_KEY)
        setOwnerSession(null)
        return
      }
      const session = { address: payload.address, expiresAt: payload.expiresAt, sessionToken: token }
      setOwnerSession(session)
      await loadSponsorRequests(token)
      await refreshProviderReadiness(token)
    } catch {
      setOwnerSession(null)
    }
  }
  async function signInSponsorOwner() {
    if (!ADDRESS_RE.test(ownerAddressInput.trim()) || !ownerPasswordInput) throw new Error('Enter the configured owner address and password.')
    const response = await fetch(API_BASE + '/api/auth/owner/login', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: ownerAddressInput.trim(), password: ownerPasswordInput }),
      credentials: 'omit', cache: 'no-store',
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.success !== true || payload?.authenticated !== true
      || payload.network !== 'mainnet' || typeof payload.sessionToken !== 'string'
      || !Number.isFinite(payload.expiresAt)) {
      throw new Error(payload?.message || payload?.error || 'Owner sign-in failed.')
    }
    sessionStorage.setItem(OWNER_SESSION_KEY, payload.sessionToken)
    setOwnerPasswordInput('')
    setOwnerSession({ address: payload.address, expiresAt: payload.expiresAt, sessionToken: payload.sessionToken })
    await loadSponsorRequests(payload.sessionToken)
    await refreshProviderReadiness(payload.sessionToken)
    setNotice('Owner identity verified. Fincra payout actions are available only under this owner session and configured provider gates.')
  }
  async function loadSponsorRequests(token) {
    const response = await fetch(API_BASE + '/api/tron-transfer/sponsor-requests', {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
      credentials: 'omit', cache: 'no-store',
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.success !== true) throw new Error(payload?.error || 'Sponsor request list is unavailable.')
    setSponsorRequests(Array.isArray(payload.requests) ? payload.requests : [])
  }
  function signOutSponsorOwner() {
    try { sessionStorage.removeItem(OWNER_SESSION_KEY) } catch {}
    setOwnerSession(null)
    setSponsorRequests([])
    setFincraReadiness(null)
    setNotice('Owner session signed out.')
  }
  async function runOwnerSponsorAction(requestId, action) {
    if (!ownerSession?.sessionToken) throw new Error('Sign in as the configured owner before handling sponsor payouts.')
    const response = await fetch(API_BASE + '/api/tron-transfer/sponsor-requests/' + encodeURIComponent(requestId) + '/' + action, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + ownerSession.sessionToken },
      credentials: 'omit', cache: 'no-store',
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok && response.status !== 202) throw new Error(payload?.message || payload?.error || 'Sponsor action failed.')
    await loadSponsorRequests(ownerSession.sessionToken)
    if (payload?.verification?.status === 'unique-confirmed-recipient-history-match') {
      setNotice('A unique confirmed incoming USDT transfer matched the requested recipient and exact amount. Review its transaction evidence against the Fincra receipt.')
    } else if (payload?.request?.fincraStatus) {
      setNotice('Fincra status: ' + payload.request.fincraStatus + '. Provider status is not the same as independent chain confirmation.')
    } else {
      setNotice(payload?.note || payload?.error || 'Sponsor action returned an updated status.')
    }
  }
  async function verifyHistoryItem(item) {
    const web = clientFor(item.network)
    const chainStatus = await readConfirmedTransferStatus(web, item.txid)
    if (chainStatus.status === 'failed') return { ...item, status: 'failed', verification: 'solidified-failed-receipt', blockNumber: chainStatus.blockNumber }
    if (chainStatus.status !== 'confirmed') return { ...item, status: chainStatus.status, verification: 'awaiting-solidification', blockNumber: chainStatus.blockNumber }
    const intent = await verifyTransferRecordOnChain(web, {
      txid: item.txid, from: item.from, to: item.to, asset: item.asset,
      amountBaseUnits: item.amountBaseUnits, tokenContract: item.tokenContract || undefined,
    })
    if (intent.identityMatches !== true) return { ...item, status: 'verification-mismatch', verification: intent.reason || 'transaction-intent-mismatch' }
    if (item.asset === 'TRC20') {
      const event = await verifyTokenReceipt(web, item)
      return { ...item, status: event.status, verification: event.reason, blockNumber: chainStatus.blockNumber }
    }
    return { ...item, status: 'verified-on-chain', verification: 'solidified-transfer-intent-matched', blockNumber: chainStatus.blockNumber }
  }
  async function refreshOne(item) {
    setBusy(true)
    try {
      const updated = await verifyHistoryItem(item)
      setHistory(current => current.map(entry => entry.txid === item.txid ? updated : entry))
      setNotice(updated.status === 'verified-on-chain'
        ? 'The successful solidified transaction and transfer details were verified on the selected testnet.'
        : 'Transaction status refreshed: ' + updated.status + '.')
    } finally { setBusy(false) }
  }
  async function perform(action) {
    setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Operation failed. Check the selected testnet and retry.'); }
    finally { setBusy(false) }
  }
  async function exportBackup() {
    if (!walletRecord) throw new Error('No encrypted wallet is saved.')
    const blob = new Blob([JSON.stringify({ wallet: walletRecord }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = 'tron-transfer-encrypted-wallet-backup.json'; anchor.click()
    URL.revokeObjectURL(url)
  }
  async function removeWallet() {
    if (unlocked) lockWallet()
    localStorage.removeItem(WALLET_KEY)
    setWalletRecord(null)
    setPortfolio(null)
    setNotice('Encrypted wallet record removed from this browser. This does not affect the on-chain wallet.')
  }

  const nav = [
    { id: 'overview', label: 'Overview', icon: Wallet },
    { id: 'send', label: 'Send / Withdraw', icon: Send },
    { id: 'recipients', label: 'Recipient check', icon: ArrowDownLeft },
    { id: 'activity', label: 'Activity', icon: Activity },
    { id: 'sponsors', label: 'Sponsor requests', icon: ShieldCheck },
  ]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#"><span className="brand-mark">T</span><span>TRON <b>TRANSFER</b><small>TESTNET WALLET</small></span></a>
        <div className="network-card">
          <span className="eyebrow">ACTIVE NETWORK</span>
          <select value={network} onChange={event => { setNetwork(event.target.value); setPortfolio(null); setReview(null) }}>
            <option value="nile">Nile Testnet</option><option value="shasta">Shasta Testnet</option>
          </select>
          <span className="network-dot"><i /> TESTNET ONLY</span>
        </div>
        <nav>{nav.map(item => <button key={item.id} className={activeTab === item.id ? 'active' : ''} onClick={() => setActiveTab(item.id)}><item.icon size={17} />{item.label}</button>)}</nav>
        <div className="sidebar-bottom">
          <div className="security-note"><ShieldCheck size={17}/><span>Local signing<br/><b>No server-held keys</b></span></div>
          {unlocked ? <button className="outline-button" onClick={lockWallet}><LockKeyhole size={16}/> Lock wallet</button> : <span className="muted small">Wallet locked</span>}
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><span className="eyebrow">TRON TRANSFER · TESTNET WALLET / SPONSOR SETTLEMENT</span><h1>{activeTab === 'overview' ? 'Wallet overview' : activeTab === 'send' ? 'Send testnet assets' : activeTab === 'recipients' ? 'Recipient balance & incoming history' : activeTab === 'sponsors' ? 'Sponsor payout workspace' : 'Transaction activity'}</h1></div>
          <div className="topbar-actions"><span className="network-chip"><i/> {NETWORKS[network].label}</span>{unlocked && <button className="outline-button" onClick={lockWallet}><LogOut size={15}/> Lock</button>}</div>
        </header>

        <div className="content">
          <section className="notice notice-warning"><AlertTriangle size={18}/><div><b>Network and payout boundaries</b><p>Direct wallet sends use Nile or Shasta testnets. They do not create official Mainnet Tether deposits or credits in third-party exchange ledgers. Separate Fincra sponsor requests are Mainnet USDT TRC20 payouts and require an authorized, funded Fincra business account.</p></div></section>
          {notice && <div className="notice notice-success" role="status"><CheckCircle2 size={17}/><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss notice"><X size={15}/></button></div>}
          {error && <div className="notice notice-error" role="alert"><AlertTriangle size={17}/><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}

          {(!walletRecord || !unlocked) && !['recipients', 'sponsors'].includes(activeTab) ? (
            <section className="panel wallet-access">
              <div className="panel-heading"><div><span className="eyebrow">DEVICE-LOCAL WALLET</span><h2>{walletRecord ? 'Unlock your wallet' : 'Create or import a wallet'}</h2><p>Private keys are encrypted in this browser. They are never sent to Tron Token Studio or a backend server.</p></div><div className="panel-icon"><LockKeyhole/></div></div>
              {walletRecord ? (
                <div className="form-stack">
                  <div className="address-box"><span>Saved wallet address</span><b>{walletRecord.address}</b></div>
                  <label>Wallet password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password"/></label>
                  <button className="primary-button" disabled={busy || !password} onClick={() => perform(unlockWallet)}><LockKeyhole size={17}/> Unlock wallet</button>
                  <div className="button-row"><button className="text-button" onClick={() => setWalletMode('restore')}>Restore another encrypted backup</button><button className="text-button danger-text" onClick={() => perform(removeWallet)}>Remove local wallet</button></div>
                  {walletMode === 'restore' && <><label>Encrypted backup JSON<textarea value={backupText} onChange={e => setBackupText(e.target.value)} rows={4}/></label><button className="secondary-button" onClick={() => perform(restoreWallet)}>Restore backup</button></>}
                </div>
              ) : (
                <div className="form-stack">
                  <div className="segmented"><button className={walletMode === 'import' ? 'selected' : ''} onClick={() => setWalletMode('import')}>Import private key</button><button className={walletMode === 'create' ? 'selected' : ''} onClick={() => setWalletMode('create')}>Generate wallet</button><button className={walletMode === 'restore' ? 'selected' : ''} onClick={() => setWalletMode('restore')}>Restore backup</button></div>
                  {walletMode === 'import' && <label>Private key <div className="input-with-action"><input type={showKey ? 'text' : 'password'} value={privateKeyInput} onChange={e => setPrivateKeyInput(e.target.value)} autoComplete="off" spellCheck="false" placeholder="64-character hexadecimal private key"/><button type="button" onClick={() => setShowKey(!showKey)} aria-label="Toggle private key visibility">{showKey ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div></label>}
                  {walletMode === 'restore' && <label>Encrypted backup JSON<textarea value={backupText} onChange={e => setBackupText(e.target.value)} rows={4} placeholder="Paste encrypted wallet backup JSON"/></label>}
                  <label>Wallet password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" placeholder="At least 12 characters"/></label>
                  <label>Confirm password<input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password"/></label>
                  {walletMode === 'import' && <button className="primary-button" disabled={busy || !privateKeyInput || password.length < 12 || password !== confirmPassword} onClick={() => perform(importWallet)}><KeyRound size={17}/> Encrypt and import locally</button>}
                  {walletMode === 'create' && <button className="primary-button" disabled={busy || password.length < 12 || password !== confirmPassword} onClick={() => perform(createWallet)}><Plus size={17}/> Generate encrypted wallet</button>}
                  {walletMode === 'restore' && <button className="primary-button" disabled={busy || !backupText.trim() || password.length < 12} onClick={() => perform(restoreWallet)}><FileKey2 size={17}/> Restore encrypted backup</button>}
                </div>
              )}
              <p className="fine-print">Use a dedicated testnet wallet. Never import a wallet holding valuable Mainnet assets into an unaudited browser application. Keep an offline backup of your encrypted keystore.</p>
            </section>
          ) : (
            <>
              <section className="wallet-summary">
                <div className="panel balance-card"><div className="panel-heading"><div><span className="eyebrow">UNLOCKED TESTNET ACCOUNT</span><h2>{shorten(unlocked.address)}</h2><a href={explorer} target="_blank" rel="noreferrer">Open address explorer <ExternalLink size={13}/></a></div><div className="panel-icon"><Wallet/></div></div><div className="balance-number">{portfolio ? portfolio.trx : '—'} <small>TRX</small></div><div className="balance-footer"><span>Live balance · {NETWORKS[network].label}</span><button className="icon-button" disabled={balanceBusy} onClick={() => perform(refreshBalances)}><RefreshCw size={16}/>{balanceBusy ? 'Reading…' : 'Refresh'}</button></div></div>
                <div className="panel quick-card"><span className="eyebrow">ACCOUNT STATUS</span><strong className="status-live"><i/> Local wallet unlocked</strong><p>Network: {network.toUpperCase()}<br/>Signing: browser-local<br/>Server key storage: none</p><button className="secondary-button" onClick={() => perform(exportBackup)}><FileKey2 size={16}/> Export encrypted backup</button></div>
              </section>

              {activeTab === 'overview' && (
                <section className="panel">
                  <div className="section-heading"><div><span className="eyebrow">ASSET INSPECTION</span><h2>Testnet assets</h2><p>Balances are read from the selected chain and exact token contracts.</p></div><button className="secondary-button" disabled={balanceBusy} onClick={() => perform(refreshBalances)}><RefreshCw size={16}/> Refresh balances</button></div>
                  <div className="asset-row"><div className="asset-symbol trx-symbol">T</div><div className="asset-name"><b>TRON</b><small>Native testnet TRX</small></div><strong>{portfolio?.trx ?? 'Not loaded'} <small>TRX</small></strong></div>
                  {networkTokens.map(token => { const live = portfolio?.tokens?.find(item => item.contract === token.contract); return <div className="asset-row" key={token.contract}><div className="asset-symbol token-symbol">{token.symbol.slice(0,2)}</div><div className="asset-name"><b>{token.name || token.symbol}</b><small>{token.symbol} · {shorten(token.contract)}</small></div><strong>{live?.balance ?? 'Not loaded'} <small>{token.symbol}</small></strong></div> })}
                  <div className="add-token"><label>Testnet TRC20 contract<input value={tokenInput} onChange={e => setTokenInput(e.target.value)} placeholder="Contract address deployed on this testnet"/></label><button className="secondary-button" disabled={busy || !tokenInput.trim()} onClick={() => perform(addToken)}><Plus size={16}/> Verify and add token</button></div>
                  <p className="fine-print">A token symbol such as USDT does not prove Tether issuance. This screen identifies contracts by their selected testnet address and on-chain metadata.</p>
                </section>
              )}

              {activeTab === 'send' && (
                <section className="panel">
                  <div className="section-heading"><div><span className="eyebrow">ON-CHAIN TESTNET TRANSFER</span><h2>Send / Withdraw</h2><p>Review, sign locally, broadcast to the selected testnet, then verify the solidified receipt.</p></div><div className="panel-icon"><Send/></div></div>
                  <div className="transfer-form">
                    <label>Asset<select value={asset} onChange={e => { setAsset(e.target.value); setReview(null); setAcknowledged(false) }}><option value="TRX">Native testnet TRX</option><option value="TRC20">TRC20 test token</option></select></label>
                    {asset === 'TRC20' && <label>Token contract<select value={tokenAddress || selectedToken?.contract || ''} onChange={e => { setTokenAddress(e.target.value); setReview(null) }}>{networkTokens.map(token => <option key={token.contract} value={token.contract}>{token.symbol} · {shorten(token.contract)}</option>)}</select></label>}
                    <label>Recipient address<input value={recipient} onChange={e => { setRecipient(e.target.value); setReview(null); setAcknowledged(false) }} placeholder="External TRON address (T…)" autoComplete="off" spellCheck="false"/></label>
                    <label>Amount<input value={amount} onChange={e => { setAmount(e.target.value); setReview(null); setAcknowledged(false) }} placeholder="e.g. 10.5" inputMode="decimal"/></label>
                    <div className="button-row"><button className="primary-button" disabled={busy || !canReview} onClick={() => perform(prepareTransfer)}><ShieldCheck size={17}/> Review transfer</button><button className="secondary-button" onClick={() => { setRecipient(''); setAmount(''); setReview(null); setAcknowledged(false) }}>Clear</button></div>
                  </div>
                  {review && <div className="review-card"><div className="review-heading"><ShieldCheck/><div><b>Review exact transaction</b><small>No transaction has been signed or broadcast yet.</small></div></div><dl><div><dt>Network</dt><dd>{NETWORKS[review.network].label}</dd></div><div><dt>From</dt><dd>{review.from}</dd></div><div><dt>To</dt><dd>{review.to}</dd></div><div><dt>Asset / amount</dt><dd>{review.amount} {review.symbol}</dd></div><div><dt>Contract</dt><dd>{review.tokenContract || 'Native TRX'}</dd></div><div><dt>Fee cap</dt><dd>{formatUnits(review.feeLimitSun, 6)} TRX</dd></div>{review.energyRequired && <div><dt>Estimated energy</dt><dd>{review.energyRequired.toLocaleString()}</dd></div>}</dl><label className="acknowledge"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)}/> I verified the network, recipient, token contract and amount.</label><button className="primary-button send-button" disabled={busy || !acknowledged} onClick={() => perform(sendTransfer)}><Send size={17}/> Sign and broadcast testnet transaction</button></div>}
                  <p className="fine-print">This sends only from the unlocked wallet's own testnet balance. The recipient must support the same testnet and token contract. An exchange's Mainnet deposit account is not credited by a testnet transaction.</p>
                </section>
              )}

              {activeTab === 'recipients' && (
                <section className="panel recipient-panel">
                  <div className="section-heading"><div><span className="eyebrow">PUBLIC-CHAIN INSPECTION</span><h2>Recipient balance & incoming activity</h2><p>Read-only Tatum lookups. No recipient wallet access or private key is required.</p></div><div className="panel-icon"><ArrowDownLeft/></div></div>
                  <div className="transfer-form">
                    <label>Network<select value={recipientNetwork} onChange={event => { setRecipientNetwork(event.target.value); setRecipientInspection(null) }}><option value="mainnet">TRON Mainnet</option><option value="nile">Nile Testnet</option><option value="shasta">Shasta Testnet</option></select></label>
                    <label>Recipient TRON address<input value={recipientAddress} onChange={event => { setRecipientAddress(event.target.value); setRecipientInspection(null) }} placeholder="T..." autoComplete="off" spellCheck="false"/></label>
                    <label className="wide-field">TRC20 contract (optional)<input value={recipientTokenContract} onChange={event => { setRecipientTokenContract(event.target.value); setRecipientInspection(null) }} placeholder={recipientNetwork === 'mainnet' ? MAINNET_USDT : 'Optional testnet token contract'}/></label>
                    <div className="button-row wide-field"><button className="primary-button" disabled={recipientBusy || !recipientAddress.trim()} onClick={() => perform(inspectRecipient)}><RefreshCw size={16}/>{recipientBusy ? 'Checking…' : 'Inspect recipient'}</button></div>
                  </div>
                  {recipientInspection && (
                    <div className="recipient-results">
                      <div className="recipient-balance-grid">
                        <article className="metric-card"><span>Native TRX balance</span><strong>{recipientInspection.nativeBalanceTRX ?? 'Unavailable'} <small>TRX</small></strong></article>
                        <article className="metric-card"><span>Token balance</span><strong>{recipientInspection.tokenBalance ? formatUnits(recipientInspection.tokenBalance.balanceBaseUnits, recipientInspection.tokenBalance.decimals) : 'Not queried' } <small>{recipientInspection.tokenBalance?.symbol || ''}</small></strong></article>
                        <article className="metric-card"><span>Account state</span><strong>{recipientInspection.accountExists ? 'Account found' : 'Not activated / not found'}</strong></article>
                        <article className="metric-card"><span>Network</span><strong>{String(recipientInspection.network).toUpperCase()}</strong></article>
                      </div>
                      <div className="section-heading"><div><span className="eyebrow">TRON CONFIRMED ACCOUNT HISTORY</span><h3>Incoming transaction history</h3><p>{recipientInspection.historyStatus === 'complete' ? 'Both confirmed incoming TRX and TRC-20 history feeds were read from the selected TRON network history service.' : recipientInspection.historyStatus === 'partial' ? 'Only one incoming history feed was available; results are partial.' : 'The selected TRON network history service could not load incoming history for this lookup.'}</p></div></div>
                      {!recipientInspection.incomingHistory?.length ? <div className="empty-state"><ArrowDownLeft size={25}/><b>No incoming transfers found</b><p>This is a live indexer response, not proof that an address has never received funds.</p></div> : recipientInspection.incomingHistory.map((item, index) => (
                        <article className="history-item" key={item.txid || index}>
                          <div className="history-icon incoming"><ArrowDownLeft size={17}/></div>
                          <div className="history-main">
                            <b>{item.amountBaseUnits && item.decimals !== null ? formatUnits(item.amountBaseUnits, item.decimals) : 'Amount unavailable'} {item.symbol || item.asset}</b>
                            <small>From {shorten(item.from)} · {item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Timestamp unavailable'}</small>
                            <span className="status-text good">{item.confirmed ? 'Confirmed' : 'Returned by confirmed-history query'}</span>
                            {item.txid && <a href={(recipientNetwork === 'mainnet' ? 'https://tronscan.org' : recipientNetwork === 'nile' ? 'https://nile.tronscan.org' : 'https://shasta.tronscan.org') + '/#/transaction/' + item.txid} target="_blank" rel="noreferrer">View transaction <ExternalLink size={12}/></a>}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                  <p className="fine-print">The recipient history endpoint is an indexed data feed. For payout confirmation, the sponsor dashboard performs a separate exact-token, recipient, amount and timestamp comparison against the confirmed Mainnet USDT history.</p>
                </section>
              )}

              {activeTab === 'sponsors' && (
                <section className="panel sponsor-panel">
                  <div className="section-heading"><div><span className="eyebrow">AUTHORIZED THIRD-PARTY PRINCIPAL</span><h2>USDT TRC20 sponsor requests</h2><p>Requests are stored for organization review. Only the configured owner session can initiate a Fincra payout.</p></div><div className="panel-icon"><ShieldCheck/></div></div>
                  <div className="sponsor-readiness">
                    <div><span className="eyebrow">FINCRA PROVIDER READINESS</span><strong>{fincraReadiness?.fincra?.canSubmitLivePayout ? 'Live payout prerequisites pass' : fincraReadiness?.fincra?.canSubmitSandboxPayout ? 'Sandbox payout prerequisites pass' : 'Payouts currently gated'}</strong><small>Environment: {fincraReadiness?.fincra?.environment || 'Not checked'} · Scheme: usdt_trc20</small></div>
                    <button className="secondary-button" onClick={() => perform(() => refreshProviderReadiness(ownerSession?.sessionToken))}><RefreshCw size={15}/> Refresh readiness</button>
                  </div>
                  {fincraReadiness?.fincra && (
                    <div className="readiness-checks">
                      <span>Tatum Mainnet {fincraReadiness.tatum?.mainnetNode?.checked ? 'solidified node reachable' : fincraReadiness.tatum?.mainnetNode?.reason || 'not verified'}</span>
                      <span>Tatum Testnet {fincraReadiness.tatum?.testnetConfigured ? 'configured' : 'missing'}</span>
                      <span>Fincra API key {fincraReadiness.fincra.apiKeyConfigured ? 'configured' : 'missing'}</span>
                      <span>Business ID {fincraReadiness.fincra.businessIdConfigured ? 'configured' : 'missing'}</span>
                      <span>Webhook secret {fincraReadiness.fincra.webhookSecretConfigured ? 'configured' : 'missing'}</span>
                      <span>USDT source funds {fincraReadiness.fincra.sourceBalance?.checked ? fincraReadiness.fincra.sourceBalance.availableBalance + ' ' + fincraReadiness.fincra.sourceBalance.currency : 'not verified'}</span>
                      <span>Live payout gate {fincraReadiness.fincra.canSubmitLivePayout ? 'all configured prerequisites pass' : 'closed'}</span>
                    </div>
                  )}
                  <div className="sponsor-request-layout">
                    <div className="sponsor-form-card">
                      <span className="eyebrow">01 / REQUEST A SPONSORED PAYOUT</span>
                      <h3>Recipient details</h3>
                      <p>USDT principal is paid by an authorized Fincra business wallet, not by this frontend or your local wallet.</p>
                      {!requesterSession ? (
                        <div className="owner-session-card">
                          <strong><LockKeyhole size={15}/> Requester ownership not verified</strong>
                          <small>{unlocked ? 'Prove control of the currently unlocked wallet using a Mainnet identity message.' : 'Unlock the wallet on this device first. The signature proves address control only; it does not authorize a payout.'}</small>
                          <button className="secondary-button" disabled={busy || !unlocked} onClick={() => perform(verifyRequesterWalletOwnership)}><ShieldCheck size={15}/> Verify requester wallet ownership</button>
                        </div>
                      ) : (
                        <div className="owner-session-card">
                          <strong><ShieldCheck size={15}/> Mainnet requester identity verified</strong>
                          <small>{shorten(requesterSession.address)} · expires {new Date(requesterSession.expiresAt).toLocaleTimeString()}</small>
                          <button className="outline-button" onClick={() => void signOutRequesterWallet()}>Sign out requester identity</button>
                        </div>
                      )}
                      <div className="form-stack">
                        <label>Recipient Mainnet address<input value={sponsorRecipientAddress} onChange={event => setSponsorRecipientAddress(event.target.value)} placeholder="T..." autoComplete="off" spellCheck="false"/></label>
                        <label>USDT amount<input value={sponsorAmount} onChange={event => setSponsorAmount(event.target.value)} placeholder="e.g. 25.00" inputMode="decimal"/></label>
                        <label>Beneficiary full name<input value={beneficiaryName} onChange={event => setBeneficiaryName(event.target.value)} placeholder="Wallet beneficiary name"/></label>
                        <label>Beneficiary email (optional)<input value={beneficiaryEmail} onChange={event => setBeneficiaryEmail(event.target.value)} placeholder="name@example.com"/></label>
                        <button className="primary-button" disabled={busy || !requesterSession?.sessionToken || !sponsorRecipientAddress.trim() || !sponsorAmount.trim() || !beneficiaryName.trim()} onClick={() => perform(submitSponsorRequest)}><Plus size={16}/> Submit sponsor request</button>
                      </div>
                      <p className="fine-print">Requests require a server-verified Mainnet wallet identity session. This identity signature is not a transaction signature and does not authorize Fincra spending. Submitting a request does not transfer, reserve or credit USDT.</p>
                    </div>
                    <div className="sponsor-admin-card">
                      <span className="eyebrow">02 / ORGANIZATION REVIEW</span>
                      <h3>Owner authorization</h3>
                      {!ownerSession ? (
                        <div className="form-stack">
                          <label>Configured owner address<input value={ownerAddressInput} onChange={event => setOwnerAddressInput(event.target.value)} placeholder="T..." autoComplete="off"/></label>
                          <label>Owner password<input value={ownerPasswordInput} onChange={event => setOwnerPasswordInput(event.target.value)} type="password" autoComplete="current-password"/></label>
                          <button className="secondary-button" disabled={busy || !ownerAddressInput.trim() || !ownerPasswordInput} onClick={() => perform(signInSponsorOwner)}><LockKeyhole size={16}/> Sign in as owner</button>
                        </div>
                      ) : (
                        <div className="owner-session-card">
                          <strong><ShieldCheck size={15}/> Owner session active</strong>
                          <small>{shorten(ownerSession.address)} · expires {new Date(ownerSession.expiresAt).toLocaleTimeString()}</small>
                          <div className="button-row"><button className="secondary-button" onClick={() => perform(() => loadSponsorRequests(ownerSession.sessionToken))}><RefreshCw size={15}/> Refresh queue</button><button className="outline-button" onClick={signOutSponsorOwner}>Sign out</button></div>
                        </div>
                      )}
                    </div>
                  </div>
                  {ownerSession && (
                    <div className="sponsor-queue">
                      <div className="section-heading"><div><span className="eyebrow">03 / PAYOUT OPERATIONS</span><h3>Organization request queue</h3><p>Fincra status and on-chain recipient evidence remain separate states.</p></div></div>
                      {!sponsorRequests.length ? <div className="empty-state"><ShieldCheck size={25}/><b>No sponsor requests in the queue</b><p>Requests submitted from this app will appear here for owner review.</p></div> : sponsorRequests.map(request => (
                        <article className="sponsor-request-row" key={request.id}>
                          <div className="sponsor-request-details">
                            <strong>{request.amount} USDT</strong>
                            <small>To {shorten(request.recipientAddress)} · {new Date(request.createdAt).toLocaleString()}</small>
                            <small>Requester {shorten(request.requesterAddress)} · {request.beneficiaryName}</small>
                            <span className="status-text">{request.status} · Fincra: {request.fincraStatus || 'not submitted'} · Chain: {request.chainVerificationStatus}</span>
                            {request.transactionHash && <a href={'https://tronscan.org/#/transaction/' + request.transactionHash} target="_blank" rel="noreferrer">View matched recipient transfer <ExternalLink size={12}/></a>}
                          </div>
                          <div className="sponsor-request-actions">
                            <button className="secondary-button" disabled={busy || request.status === 'fincra-successful'} onClick={() => perform(() => runOwnerSponsorAction(request.id, 'fincra-status'))}>Requery Fincra</button>
                            <button className="primary-button" disabled={busy || !fincraReadiness?.fincra?.canSubmitSandboxPayout && !fincraReadiness?.fincra?.canSubmitLivePayout || !['pending-organization-review','fincra-outcome-unknown','fincra-submitting'].includes(request.status)} onClick={() => perform(() => runOwnerSponsorAction(request.id, 'fincra-payout'))}>Submit / reconcile payout</button>
                            <button className="secondary-button" disabled={busy || request.fincraStatus !== 'successful'} onClick={() => perform(() => runOwnerSponsorAction(request.id, 'verify-recipient-transfer'))}>Verify recipient on-chain</button>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {activeTab === 'activity' && (
                <section className="panel">
                  <div className="section-heading"><div><span className="eyebrow">CHAIN-VERIFIED HISTORY</span><h2>Transaction activity</h2><p>Each record is checked against the selected network. Local history alone is not proof.</p></div></div>
                  {history.filter(item => item.network === network).length === 0 ? <div className="empty-state"><Activity size={28}/><b>No testnet transactions saved</b><p>Broadcast a testnet transfer to see its transaction ID and verification state here.</p></div> : history.filter(item => item.network === network).map(item => <article className="history-item" key={item.txid}><div className="history-icon"><ArrowUpRight size={17}/></div><div className="history-main"><b>{item.amount} {item.symbol || item.asset}</b><small>To {shorten(item.to)} · {new Date(item.submittedAt).toLocaleString()}</small><span className={'status-text ' + (item.status === 'verified-on-chain' ? 'good' : item.status === 'failed' ? 'bad' : '')}>{item.status} · {item.verification || 'not yet verified'}</span><a href={txUrl(item.network,item.txid)} target="_blank" rel="noreferrer">View on {item.network} TronScan <ExternalLink size={12}/></a></div><div className="history-actions"><button className="icon-button" disabled={busy} onClick={() => perform(() => refreshOne(item))}><RefreshCw size={15}/> Verify</button><button className="icon-button" onClick={() => navigator.clipboard?.writeText(item.txid)}><Copy size={15}/> Copy ID</button></div></article>)}
                </section>
              )}
            </>
          )}
          <footer className="app-footer">TRON TRANSFER · TESTNET-ONLY WALLET · NILE / SHASTA</footer>
        </div>
      </main>
    </div>
  )
}
