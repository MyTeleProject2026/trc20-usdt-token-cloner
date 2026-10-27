import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'
import { getTronScanTransactionUrl } from './tron-explorer.mjs'

type Asset = 'TRX' | 'USDT'
type MainnetWalletSession = { address: string; network: 'mainnet'; expiresAt: number; sessionToken: string }
type DepositStatus = 'broadcast-outcome-unknown' | 'awaiting-solidification' | 'verified-on-chain' | 'verification-unavailable' | 'verification-mismatch'
type MainnetBalance = { success?: boolean; network?: string; balanceTRX?: string; balanceSun?: string; balanceBaseUnits?: string; decimals?: number; tokenContract?: string }
type DepositAttempt = {
  txId: string
  asset: Asset
  amountBaseUnits: string
  decimals: number
  sender: string
  receiver: string
  exchangeName: string
  memo: string
  status: DepositStatus
  message: string
  createdAt: number
  blockNumber?: number
  receiverBalance?: MainnetBalance
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const MAINNET_HOST = 'api.trongrid.io'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TX_PATTERN = /^[0-9a-fA-F]{64}$/
const FEE_LIMIT_SUN = '30000000'
const STORAGE_KEY = 'tron-token-studio:mainnet-exchange-deposit:v1'
const AUTH_SESSION_KEY = 'tron-token-studio:mainnet-auth-session:v1'

function getProvider(): any {
  const candidates = [(window as any).tron, (window as any).tronLink]
  return candidates.find((provider) => provider && provider.isTronLink === true && typeof provider.request === 'function') || null
}

async function requestWalletAccess(provider: any): Promise<void> {
  try {
    await provider.request({ method: 'eth_requestAccounts' })
  } catch (error) {
    const code = Number((error as any)?.code)
    const message = String((error as any)?.message || error || '')
    if (code === -32601 || code === 4200 || /method not found|unsupported method|method not supported/i.test(message)) {
      await provider.request({ method: 'tron_requestAccounts' })
    } else {
      throw error
    }
  }
}

function checkMainnet(tronWeb: any): void {
  let parsed: URL
  try {
    parsed = new URL(String(tronWeb?.fullNode?.host || tronWeb?.fullNode?.nodeUrl || ''))
  } catch {
    throw new Error('Cannot verify the active wallet node. In TronLink, select TRON Mainnet with the official TronGrid endpoint before proceeding.')
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== MAINNET_HOST
    || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new Error('Network mismatch. This page accepts Mainnet only through https://api.trongrid.io. No testnet or alternate-node fallback is allowed.')
  }
}

function canonicalAddressHex(tronWeb: any, address: unknown): string | null {
  if (typeof address !== 'string' || !address.trim()) return null
  try {
    let hex = ADDRESS_PATTERN.test(address) ? String(tronWeb.address.toHex(address)) : address
    hex = hex.replace(/^0x/i, '').toLowerCase()
    if (hex.length === 42 && hex.startsWith('41')) hex = hex.slice(2)
    return /^[0-9a-f]{40}$/.test(hex) ? hex : null
  } catch {
    return null
  }
}

function amountToBaseUnits(value: string, decimals = 6): string | null {
  const input = value.trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(input)) return null
  const [whole, fraction = ''] = input.split('.')
  if (fraction.length > decimals) return null
  const base = BigInt(whole) * (10n ** BigInt(decimals))
    + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
  return base > 0n ? base.toString() : null
}

function formatUnits(raw: string | undefined, decimals = 6): string {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) return 'Unavailable'
  const value = BigInt(raw)
  const scale = 10n ** BigInt(decimals)
  const whole = value / scale
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? whole.toString() + '.' + fraction : whole.toString()
}

function utf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function apiGet(path: string, authToken?: string): Promise<{ ok: boolean; status: number; payload: any }> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (authToken) headers.Authorization = 'Bearer ' + authToken
  const response = await fetch(API_BASE + path, {
    headers,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  })
  const payload = await response.json().catch(() => null)
  return { ok: response.ok, status: response.status, payload }
}

async function authenticateMainnetWallet(address: string, tronWeb: any): Promise<MainnetWalletSession> {
  // Reuse only a live server-issued session for this exact address/network.
  // A browser-stored address by itself never counts as authentication.
  let storedToken = ''
  try { storedToken = window.sessionStorage.getItem(AUTH_SESSION_KEY) || '' } catch {}
  if (storedToken) {
    try {
      const existing = await apiGet('/api/auth/tron/session', storedToken)
      if (existing.ok && existing.payload?.success === true && existing.payload?.authenticated === true
        && existing.payload.address === address && existing.payload.network === 'mainnet'
        && Number.isFinite(existing.payload.expiresAt) && existing.payload.expiresAt > Date.now()) {
        return { address, network: 'mainnet', expiresAt: existing.payload.expiresAt, sessionToken: storedToken }
      }
    } catch {
      // A failed restore is not proof of login; a fresh challenge remains required.
    }
    try { window.sessionStorage.removeItem(AUTH_SESSION_KEY) } catch {}
  }

  if (typeof tronWeb?.trx?.signMessageV2 !== 'function') {
    throw new Error('This TronLink version cannot sign the wallet login message. Update TronLink and retry.')
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
  if (!challengeResponse.ok || challenge?.success !== true || challenge?.network !== 'mainnet'
    || typeof challenge.message !== 'string' || typeof challenge.nonce !== 'string'
    || !Number.isFinite(challenge.expiresAt) || challenge.expiresAt <= Date.now()) {
    throw new Error(challenge?.message || challenge?.error || 'Mainnet wallet login challenge failed (HTTP ' + challengeResponse.status + ').')
  }

  // This signs a clearly scoped identity message only. It is not a transaction.
  const signature = await tronWeb.trx.signMessageV2(challenge.message)
  if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) {
    throw new Error('TronLink returned an invalid Mainnet login signature.')
  }
  checkMainnet(tronWeb)
  if (String(tronWeb?.defaultAddress?.base58 || '') !== address) {
    throw new Error('The active Mainnet wallet changed while signing the login message. Reconnect and retry.')
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
    || typeof verified.sessionToken !== 'string' || !Number.isFinite(verified.expiresAt)
    || verified.expiresAt <= Date.now()) {
    throw new Error(verified?.message || verified?.error || 'Mainnet wallet signature verification failed (HTTP ' + verifyResponse.status + ').')
  }

  const currentProvider = getProvider()
  const currentTronWeb = currentProvider?.tronWeb || (window as any).tronWeb
  checkMainnet(currentTronWeb)
  if (String(currentTronWeb?.defaultAddress?.base58 || '') !== address) {
    void fetch(API_BASE + '/api/auth/tron/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + verified.sessionToken },
      credentials: 'omit',
      cache: 'no-store',
    }).catch(() => undefined)
    throw new Error('The active Mainnet wallet changed after the login signature. No transfer was authorized.')
  }
  try { window.sessionStorage.setItem(AUTH_SESSION_KEY, verified.sessionToken) } catch {}
  return { address, network: 'mainnet', expiresAt: verified.expiresAt, sessionToken: verified.sessionToken }
}

function loadAttempt(): DepositAttempt | null {
  try {
    const item = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || 'null')
    if (!item || typeof item !== 'object'
      || !TX_PATTERN.test(String(item.txId || ''))
      || !['TRX', 'USDT'].includes(item.asset)
      || !/^[1-9][0-9]*$/.test(String(item.amountBaseUnits || ''))
      || !ADDRESS_PATTERN.test(String(item.sender || ''))
      || !ADDRESS_PATTERN.test(String(item.receiver || ''))
      || !Number.isFinite(item.createdAt)
      || (item.asset === 'USDT' && item.contract !== MAINNET_USDT)) return null
    return {
      txId: String(item.txId),
      asset: item.asset,
      amountBaseUnits: String(item.amountBaseUnits),
      decimals: 6,
      sender: item.sender,
      receiver: item.receiver,
      exchangeName: typeof item.exchangeName === 'string' ? item.exchangeName : '',
      memo: typeof item.memo === 'string' ? item.memo : '',
      status: 'verification-unavailable',
      message: 'Restored from this browser session. Verify this same transaction against solidified Mainnet state before assuming it settled.',
      createdAt: item.createdAt,
    }
  } catch {
    return null
  }
}

export default function MainnetExchangeDeposit() {
  const [exchangeName, setExchangeName] = useState('')
  const [asset, setAsset] = useState<Asset>('USDT')
  const [destination, setDestination] = useState('')
  const [memo, setMemo] = useState('')
  const [amount, setAmount] = useState('')
  const [sender, setSender] = useState('')
  const [walletSession, setWalletSession] = useState<MainnetWalletSession | null>(null)
  const [trxBalanceSun, setTrxBalanceSun] = useState<string | null>(null)
  const [usdtBalanceRaw, setUsdtBalanceRaw] = useState<string | null>(null)
  const [walletBusy, setWalletBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [walletError, setWalletError] = useState('')
  const [sendError, setSendError] = useState('')
  const [attempt, setAttempt] = useState<DepositAttempt | null>(() => loadAttempt())
  const [destinationConfirmed, setDestinationConfirmed] = useState(false)
  const [irreversibleConfirmed, setIrreversibleConfirmed] = useState(false)

  useEffect(() => {
    try {
      if (attempt) {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
          ...attempt,
          contract: attempt.asset === 'USDT' ? MAINNET_USDT : null,
        }))
      } else {
        window.sessionStorage.removeItem(STORAGE_KEY)
      }
    } catch {
      // The in-memory duplicate-send lock remains active if storage is unavailable.
    }
  }, [attempt])

  useEffect(() => {
    if (!walletSession) return
    const token = walletSession.sessionToken
    const timer = window.setTimeout(() => {
      try { window.sessionStorage.removeItem(AUTH_SESSION_KEY) } catch {}
      setWalletSession(null)
      setSender('')
      setTrxBalanceSun(null)
      setUsdtBalanceRaw(null)
      setDestinationConfirmed(false)
      setIrreversibleConfirmed(false)
      setWalletError('Mainnet wallet identity expired. Reconnect and sign in again before preparing a transfer.')
      void fetch(API_BASE + '/api/auth/tron/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        credentials: 'omit',
        cache: 'no-store',
      }).catch(() => undefined)
    }, Math.max(0, walletSession.expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [walletSession])

  const amountBaseUnits = amountToBaseUnits(amount, 6)
  const destinationValid = ADDRESS_PATTERN.test(destination.trim()) && destination.trim() !== sender
  const formReady = Boolean(sender && walletSession?.address === sender && walletSession?.network === 'mainnet' && walletSession?.expiresAt && walletSession.expiresAt > Date.now() && destinationValid && amountBaseUnits && destinationConfirmed && irreversibleConfirmed && !sending && !verifying && !attempt)

  const connectWallet = async () => {
    setWalletBusy(true)
    setWalletError('')
    try {
      const provider = getProvider()
      if (!provider) throw new Error('TronLink was not detected. Open this page in a browser with TronLink enabled.')
      await requestWalletAccess(provider)
      const tronWeb = provider.tronWeb || (window as any).tronWeb
      if (!tronWeb || typeof tronWeb !== 'object') throw new Error('TronLink did not provide TronWeb. Unlock your wallet and reconnect.')
      checkMainnet(tronWeb)
      const address = String(tronWeb?.defaultAddress?.base58 || '')
      if (!ADDRESS_PATTERN.test(address) || !tronWeb.isAddress(address)) throw new Error('No valid active TronLink account was found.')
      const identity = await authenticateMainnetWallet(address, tronWeb)
      const activeTronWeb = provider.tronWeb || (window as any).tronWeb
      checkMainnet(activeTronWeb)
      if (String(activeTronWeb?.defaultAddress?.base58 || '') !== address) {
        throw new Error('The active Mainnet wallet changed after authentication. Reconnect and retry.')
      }
      setWalletSession(identity)
      const trx = await activeTronWeb.trx.getBalance(address)
      const nextTrx = String(trx)
      if (!/^(0|[1-9][0-9]*)$/.test(nextTrx)) throw new Error('The active wallet TRX balance did not return a valid base-unit value.')
      const contract = await activeTronWeb.contract().at(MAINNET_USDT)
      const symbol = String(await contract.symbol().call())
      const decimals = Number(await contract.decimals().call())
      const nextUsdt = String(await contract.balanceOf(address).call())
      if (!['USDT', 'USD₮'].includes(symbol) || decimals !== 6 || !/^(0|[1-9][0-9]*)$/.test(nextUsdt)) {
        throw new Error('The official Mainnet USDT contract identity or balance could not be verified from this Mainnet node.')
      }
      setDestinationConfirmed(false)
      setIrreversibleConfirmed(false)
      setSender(address)
      setTrxBalanceSun(nextTrx)
      setUsdtBalanceRaw(nextUsdt)
      setSendError('')
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Wallet connection failed.')
      setWalletSession(null)
      try { window.sessionStorage.removeItem(AUTH_SESSION_KEY) } catch {}
      setSender('')
      setTrxBalanceSun(null)
      setUsdtBalanceRaw(null)
    } finally {
      setWalletBusy(false)
    }
  }

  const verifyAttempt = async (current: DepositAttempt) => {
    setVerifying(true)
    setSendError('')
    try {
      const query = new URLSearchParams({ network: 'mainnet', from: current.sender, to: current.receiver })
      const path = current.asset === 'TRX'
        ? '/api/tron/verify-native-transfer/' + encodeURIComponent(current.txId)
        : '/api/tron/verify-trc20-transfer/' + encodeURIComponent(current.txId)
      if (current.asset === 'TRX') query.set('amountSun', current.amountBaseUnits)
      else {
        query.set('contract', MAINNET_USDT)
        query.set('amountBaseUnits', current.amountBaseUnits)
      }
      const result = await apiGet(path + '?' + query.toString())
      const payload = result.payload
      const expectedStatus = current.asset === 'TRX' ? 'solidified-transfer-verified' : 'solidified-trc20-transfer-verified'
      if (result.ok && payload?.success === true && payload?.verified === true && payload?.status === expectedStatus) {
        let receiverBalance: MainnetBalance | undefined
        let refreshed = false
        try {
          const balancePath = current.asset === 'TRX'
            ? '/api/tron/native-balance?network=mainnet&address=' + encodeURIComponent(current.receiver)
            : '/api/tron/token-balance?network=mainnet&contract=' + encodeURIComponent(MAINNET_USDT) + '&address=' + encodeURIComponent(current.receiver)
          const balanceResult = await apiGet(balancePath)
          if (balanceResult.ok && balanceResult.payload?.success === true && balanceResult.payload?.network === 'mainnet') {
            receiverBalance = balanceResult.payload as MainnetBalance
            refreshed = true
          }
        } catch {
          // Receipt verification remains authoritative for chain status; balance refresh is additional evidence.
        }
        setAttempt((prior) => prior?.txId === current.txId ? {
          ...prior,
          status: 'verified-on-chain',
          blockNumber: Number.isInteger(payload.blockNumber) ? payload.blockNumber : undefined,
          receiverBalance,
          message: 'The exact asset transfer is verified in solidified TRON Mainnet state. ' + (refreshed ? 'The receiver balance was also refreshed from Mainnet. ' : 'Receiver balance refresh is currently unavailable. ') + 'Exchange-account credit is not verified by this app.',
        } : prior)
        return
      }
      if (result.ok && payload?.success === true && payload?.verified === false) {
        const pending = payload.status === 'awaiting-solidification'
        setAttempt((prior) => prior?.txId === current.txId ? {
          ...prior,
          status: pending ? 'awaiting-solidification' : 'verification-mismatch',
          message: pending
            ? (payload.message || 'The transaction is not yet in solidified Mainnet state. Retry this same transaction ID; do not send a duplicate.')
            : 'Solidified verification did not match a successful transaction with the exact expected sender, receiver, asset and amount. Do not treat this as a completed deposit.',
        } : prior)
        return
      }
      setAttempt((prior) => prior?.txId === current.txId ? {
        ...prior,
        status: 'verification-unavailable',
        message: payload?.message || payload?.error || 'Verification is unavailable. Retry verification with this same transaction ID and do not send again yet.',
      } : prior)
    } catch (error) {
      setAttempt((prior) => prior?.txId === current.txId ? {
        ...prior,
        status: 'verification-unavailable',
        message: (error instanceof Error ? error.message : 'Verification is unavailable.') + ' Retry using this same transaction ID before considering another send.',
      } : prior)
    } finally {
      setVerifying(false)
    }
  }

  const sendDeposit = async () => {
    setSendError('')
    if (attempt) {
      setSendError('A transaction already exists for this request. Verify that same transaction first; a duplicate send is blocked.')
      return
    }
    if (!formReady || !amountBaseUnits || !walletSession) {
      setSendError('Connect and authenticate a Mainnet wallet, enter a valid amount/address, and confirm the official exchange deposit instructions first.')
      return
    }

    setSending(true)
    let txId = ''
    let pendingAttempt: DepositAttempt | null = null
    try {
      const sessionResult = await apiGet('/api/auth/tron/session', walletSession.sessionToken)
      if (!sessionResult.ok || sessionResult.payload?.success !== true || sessionResult.payload?.authenticated !== true
        || sessionResult.payload?.address !== sender || sessionResult.payload?.network !== 'mainnet'
        || !Number.isFinite(sessionResult.payload?.expiresAt) || sessionResult.payload.expiresAt <= Date.now()) {
        throw new Error('The Mainnet wallet login expired or is invalid. Reconnect and sign in before preparing a transfer.')
      }
      const provider = getProvider()
      const tronWeb = provider?.tronWeb || (window as any).tronWeb
      if (!provider || !tronWeb) throw new Error('TronLink is unavailable. Reconnect the intended Mainnet wallet.')
      checkMainnet(tronWeb)
      if (String(tronWeb?.defaultAddress?.base58 || '') !== sender || !tronWeb.isAddress(destination.trim())) {
        throw new Error('The active wallet changed or the destination is invalid. Reconnect and review all fields.')
      }
      const receiver = destination.trim()
      const senderHex = canonicalAddressHex(tronWeb, sender)
      const receiverHex = canonicalAddressHex(tronWeb, receiver)
      if (!senderHex || !receiverHex || senderHex === receiverHex) throw new Error('The sender and destination must be valid, different TRON addresses.')

      const amountDecimals = 6
      const baseUnits = amountBaseUnits
      let unsigned: any
      if (asset === 'TRX') {
        const freshTrx = String(await tronWeb.trx.getBalance(sender))
        if (!/^(0|[1-9][0-9]*)$/.test(freshTrx) || BigInt(freshTrx) < BigInt(baseUnits)) {
          throw new Error('The latest Mainnet TRX balance is below the requested transfer amount. Fees are additional.')
        }
        unsigned = await tronWeb.transactionBuilder.sendTrx(receiver, baseUnits, sender)
      } else {
        const contract = await tronWeb.contract().at(MAINNET_USDT)
        const symbol = String(await contract.symbol().call())
        const decimals = Number(await contract.decimals().call())
        const freshUsdt = String(await contract.balanceOf(sender).call())
        const freshTrx = String(await tronWeb.trx.getBalance(sender))
        if (!['USDT', 'USD₮'].includes(symbol) || decimals !== 6) throw new Error('The exact official Mainnet USDT contract could not be verified immediately before signing.')
        if (!/^(0|[1-9][0-9]*)$/.test(freshUsdt) || BigInt(freshUsdt) < BigInt(baseUnits)) throw new Error('The latest official USDT balance is below the requested amount.')
        if (!/^(0|[1-9][0-9]*)$/.test(freshTrx) || BigInt(freshTrx) <= 0n) throw new Error('The wallet has no verified Mainnet TRX available for token-transfer network fees.')
        const built = await tronWeb.transactionBuilder.triggerSmartContract(
          MAINNET_USDT,
          'transfer(address,uint256)',
          { feeLimit: Number(FEE_LIMIT_SUN), callValue: 0 },
          [{ type: 'address', value: receiver }, { type: 'uint256', value: baseUnits }],
          sender,
        )
        if (built?.result?.result !== true || !built?.transaction) throw new Error('The official USDT contract did not produce a valid transaction. Nothing was signed.')
        unsigned = built.transaction
      }

      if (memo.trim()) {
        if (memo.trim().length > 200 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(memo)) {
          throw new Error('Memo must be at most 200 characters and cannot contain control characters.')
        }
        if (typeof tronWeb?.transactionBuilder?.addUpdateData !== 'function') throw new Error('This TronLink build cannot safely encode the exchange memo. Do not send without a required memo.')
        unsigned = await tronWeb.transactionBuilder.addUpdateData(unsigned, memo, 'utf8')
        if (String(unsigned?.raw_data?.data || '').replace(/^0x/i, '').toLowerCase() !== utf8Hex(memo)) {
          throw new Error('The built transaction memo did not match the exact text entered. Nothing was signed.')
        }
      }

      txId = String(unsigned?.txID || '')
      if (!TX_PATTERN.test(txId)) throw new Error('The unsigned transaction has no valid transaction ID.')
      const operations = unsigned?.raw_data?.contract
      if (!Array.isArray(operations) || operations.length !== 1) throw new Error('The transaction contains unexpected operations. Nothing was signed.')
      const operation = operations[0]
      const value = operation?.parameter?.value || {}
      if (canonicalAddressHex(tronWeb, value.owner_address) !== senderHex) throw new Error('The transaction sender does not match the connected wallet.')
      if (asset === 'TRX') {
        if (operation.type !== 'TransferContract' || canonicalAddressHex(tronWeb, value.to_address) !== receiverHex || String(value.amount) !== baseUnits) {
          throw new Error('The transaction did not match the exact TRX receiver and amount. Nothing was signed.')
        }
      } else {
        const data = String(value.data || '').replace(/^0x/i, '').toLowerCase()
        const expectedData = 'a9059cbb' + receiverHex.padStart(64, '0') + BigInt(baseUnits).toString(16).padStart(64, '0')
        if (operation.type !== 'TriggerSmartContract' || canonicalAddressHex(tronWeb, value.contract_address) !== canonicalAddressHex(tronWeb, MAINNET_USDT) || data !== expectedData) {
          throw new Error('The transaction did not match the official USDT contract, exact receiver and amount. Nothing was signed.')
        }
      }

      const signed = await tronWeb.trx.sign(unsigned)
      if (!signed || String(signed.txID || '').toLowerCase() !== txId.toLowerCase() || !Array.isArray(signed.signature) || signed.signature.length === 0) {
        throw new Error('TronLink did not return a valid signature for this exact transaction. Nothing was broadcast.')
      }
      const activeTronWeb = provider.tronWeb || (window as any).tronWeb
      checkMainnet(activeTronWeb)
      if (String(activeTronWeb?.defaultAddress?.base58 || '') !== sender) throw new Error('The wallet account changed after signing. The transaction was not broadcast.')

      pendingAttempt = {
        txId,
        asset,
        amountBaseUnits: baseUnits,
        decimals: amountDecimals,
        sender,
        receiver,
        exchangeName: exchangeName.trim(),
        memo: memo.trim(),
        status: 'broadcast-outcome-unknown',
        message: 'A signature was returned. Broadcast and solidified confirmation are being checked. Keep this transaction ID and do not send another until reconciled.',
        createdAt: Date.now(),
      }
      setAttempt(pendingAttempt)
      const broadcast = await tronWeb.trx.sendRawTransaction(signed)
      const returnedId = String(broadcast?.txid || broadcast?.transaction?.txID || '')
      if (broadcast?.result !== true || (returnedId && returnedId.toLowerCase() !== txId.toLowerCase())) {
        setAttempt({ ...pendingAttempt, status: 'broadcast-outcome-unknown', message: 'The node did not unambiguously acknowledge the broadcast. Verify this same transaction ID; do not duplicate the transfer.' })
        return
      }
      const queued = { ...pendingAttempt, status: 'awaiting-solidification' as const, message: 'The node acknowledged broadcast. Waiting for exact solidified Mainnet transaction and receipt verification.' }
      setAttempt(queued)
      await verifyAttempt(queued)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The transfer could not be prepared.'
      if (txId && pendingAttempt) {
        setAttempt((current) => current?.txId === txId ? { ...current, status: 'broadcast-outcome-unknown', message: message + ' Keep this transaction ID and verify it before another send.' } : current)
      } else {
        setSendError(message)
      }
    } finally {
      setSending(false)
    }
  }

  const statusTitle = attempt?.status === 'verified-on-chain'
    ? 'Mainnet transfer verified'
    : attempt?.status === 'awaiting-solidification'
      ? 'Waiting for solidified confirmation'
      : attempt?.status === 'verification-mismatch'
        ? 'Verification did not match'
        : attempt?.status === 'verification-unavailable'
          ? 'Verification unavailable'
          : 'Broadcast outcome uncertain'

  return (
    <div className="studio-app mainnet-deposit-page">
      <header>
        <div>
          <div>
            <div className="studio-brand-mark"><Wallet size={23} aria-hidden="true" /></div>
            <div>
              <h1>TRON Token Studio</h1>
              <p>Real Mainnet exchange deposit</p>
            </div>
          </div>
          <div>
            <a className="studio-button studio-button--secondary" href="#/">Back to testnet studio <ArrowLeft size={15} aria-hidden="true" /></a>
            <span className="studio-pill studio-pill--good">TRON Mainnet</span>
          </div>
        </div>
      </header>
      <div className="studio-shell">
        <main className="studio-main">
          <section className="studio-page-heading">
            <div>
              <p className="studio-eyebrow">Genuine on-chain transfer</p>
              <h1>Exchange deposit</h1>
              <p>Send actual Mainnet TRX or official TRON USDT to an address copied from the exchange’s official deposit page.</p>
            </div>
            <span className="studio-pill studio-pill--warning">Irreversible transfer</span>
          </section>

          <div className="studio-notice studio-notice--warning" role="note">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <strong>Real funds only — no testnet or simulated credits</strong>
              <p>This page can only send from your connected Mainnet wallet. Nile/Shasta assets, custom tokens, displayed balances and sponsor budgets are not accepted as real deposits. A transaction confirmed on-chain does not prove an exchange credited your account.</p>
            </div>
          </div>

          <section className="studio-panel" aria-labelledby="no-real-usdt-heading">
            <div className="studio-panel-heading">
              <div className="studio-panel-icon"><ShieldCheck size={19} aria-hidden="true" /></div>
              <div>
                <p className="studio-eyebrow">Practice without real funds</p>
                <h2 id="no-real-usdt-heading">No real USDT needed for testnet practice</h2>
                <p>Use the testnet workspace to learn the flow with faucet-provided test tokens. Those tokens have no monetary value and cannot be credited to a Mainnet exchange. This Mainnet page still requires genuine USDT or TRX in the connected sender wallet.</p>
              </div>
            </div>
            <div className="studio-inline-actions">
              <a className="studio-button studio-button--secondary" href="#/">Open testnet workspace <ArrowLeft size={15} aria-hidden="true" /></a>
              <a href="https://developers.tron.network/docs/getting-testnet-tokens-on-tron" target="_blank" rel="noopener noreferrer">Official TRON test-token guide <ExternalLink size={14} aria-hidden="true" /></a>
            </div>
          </section>

          <section className="studio-panel">
            <div className="studio-panel-heading">
              <div className="studio-panel-icon"><Wallet size={19} aria-hidden="true" /></div>
              <div><p className="studio-eyebrow">Step 1</p><h2>Connect and authenticate the sender wallet</h2><p>Sign a short-lived wallet-ownership message in TronLink. The backend stores your public address and a hashed session token; it never receives a private key. This message does not authorize a transfer.</p></div>
            </div>
            <div className="studio-inline-actions">
              <button type="button" className="studio-button studio-button--primary" onClick={() => void connectWallet()} disabled={walletBusy || sending}>
                <Wallet size={16} aria-hidden="true" /> {walletBusy ? 'Connecting and authenticating…' : sender ? 'Refresh authenticated wallet and balances' : 'Connect & sign in to Mainnet wallet'}
              </button>
            </div>
            {sender && walletSession?.address === sender && <div className="studio-verified-snapshot" role="status"><CheckCircle2 size={19} aria-hidden="true" /><div><strong>Mainnet wallet identity verified</strong><code>{sender}</code><p>Identity session expires: {new Date(walletSession.expiresAt).toLocaleString()}</p><p>TRX balance: {formatUnits(trxBalanceSun || undefined, 6)} TRX</p><p>Official USDT balance: {formatUnits(usdtBalanceRaw || undefined, 6)} USDT</p></div></div>}
            {walletSession && <button type="button" className="studio-button studio-button--secondary" onClick={() => {
              const token = walletSession.sessionToken
              try { window.sessionStorage.removeItem(AUTH_SESSION_KEY) } catch {}
              setWalletSession(null)
              setSender('')
              setTrxBalanceSun(null)
              setUsdtBalanceRaw(null)
              setDestinationConfirmed(false)
              setIrreversibleConfirmed(false)
              void fetch(API_BASE + '/api/auth/tron/logout', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token },
                credentials: 'omit',
                cache: 'no-store',
              }).catch(() => undefined)
            }}>Sign out wallet identity</button>}
            {walletError && <p className="studio-inline-error" role="alert">{walletError}</p>}
          </section>

          <section className="studio-panel">
            <div className="studio-panel-heading">
              <div className="studio-panel-icon"><ShieldCheck size={19} aria-hidden="true" /></div>
              <div><p className="studio-eyebrow">Step 2</p><h2>Copy the exchange's deposit instructions</h2><p>Open the exchange itself and choose its TRON network deposit page. These details are supplied by you; this page does not connect to an exchange API or authenticate an exchange credit.</p></div>
            </div>
            <div className="studio-field-block">
              <label htmlFor="exchange-name">Exchange or receiving platform name (for your records)</label>
              <input id="exchange-name" value={exchangeName} onChange={(event) => setExchangeName(event.target.value)} placeholder="Exchange name" autoComplete="off" maxLength={80} />
              <p className="studio-field-hint">Label only. There is no exchange API connection on this generic deposit page.</p>
            </div>
            <div className="studio-field-block">
              <label htmlFor="deposit-asset">Asset and network</label>
              <select id="deposit-asset" value={asset} onChange={(event) => { setAsset(event.target.value as Asset); setDestinationConfirmed(false); setIrreversibleConfirmed(false); setSendError('') }}>
                <option value="USDT">Official USDT · TRC-20 · TRON Mainnet</option>
                <option value="TRX">Native TRX · TRON Mainnet</option>
              </select>
              {asset === 'USDT'
                ? <p className="studio-field-hint">Fixed official Mainnet Tether contract: <code>{MAINNET_USDT}</code>. No user-selected or custom token contracts are accepted. <a href="https://tether.to/en/supported-protocols/" target="_blank" rel="noopener noreferrer">Check Tether’s official supported-protocol page</a> or <a href="https://tronscan.org/#/token20/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" target="_blank" rel="noopener noreferrer">inspect this contract on TronScan</a>.</p>
                : <p className="studio-field-hint">Native TRX uses a native TRON transfer, not a TRC-20 token contract.</p>}
            </div>
            <div className="studio-field-block">
              <label htmlFor="exchange-deposit-address">Destination deposit address</label>
              <input id="exchange-deposit-address" value={destination} onChange={(event) => { setDestination(event.target.value.trim()); setDestinationConfirmed(false); setIrreversibleConfirmed(false); setSendError('') }} placeholder="Paste the TRON address from the official exchange deposit page" autoComplete="off" spellCheck={false} />
              {destination && !destinationValid && <p className="studio-inline-error">Enter a valid TRON address different from your sender wallet.</p>}
            </div>
            <div className="studio-field-block">
              <label htmlFor="exchange-deposit-memo">Memo / tag (only if the exchange explicitly requires it)</label>
              <input id="exchange-deposit-memo" value={memo} onChange={(event) => { setMemo(event.target.value); setDestinationConfirmed(false); setIrreversibleConfirmed(false); setSendError('') }} placeholder="Leave blank if the official deposit page does not require one" autoComplete="off" maxLength={200} />
              <p className="studio-field-hint">The memo is placed in the transaction data field and is not separately validated by the exchange. If the exchange specifies a different network-specific destination-tag mechanism, stop and follow the exchange's official instructions instead.</p>
            </div>
            <div className="studio-field-block">
              <label htmlFor="exchange-deposit-amount">Amount</label>
              <div className="studio-amount-entry"><input id="exchange-deposit-amount" value={amount} onChange={(event) => { setAmount(event.target.value); setIrreversibleConfirmed(false); setSendError('') }} inputMode="decimal" placeholder="0.00" /><span>{asset}</span></div>
              {amount && !amountBaseUnits && <p className="studio-inline-error">Enter a positive amount with no more than 6 decimal places.</p>}
            </div>
            {asset === 'USDT' && <div className="studio-notice studio-notice--warning"><AlertTriangle size={18} aria-hidden="true" /><div><strong>Network fee cap</strong><p>The USDT transaction is built with a maximum feeLimit of 30 TRX. Actual fees depend on available Energy/Bandwidth and can vary. Make sure the wallet has enough Mainnet TRX; carefully review any fee shown by TronLink before approving.</p></div></div>}
            <label className="studio-inline-note" style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <input style={{ width: 18, flex: "0 0 auto", marginTop: 3 }} type="checkbox" checked={destinationConfirmed} onChange={(event) => setDestinationConfirmed(event.target.checked)} />
              <span>I copied this address and any required memo from the exchange’s official deposit page, selected the TRON/TRC-20 network for this exact asset, checked minimum deposits and deposit availability, and confirmed these details are correct.</span>
            </label>
            <label className="studio-inline-note" style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <input style={{ width: 18, flex: "0 0 auto", marginTop: 3 }} type="checkbox" checked={irreversibleConfirmed} onChange={(event) => setIrreversibleConfirmed(event.target.checked)} />
              <span>I understand this sends real funds irreversibly from my connected Mainnet wallet. I will review the exact recipient, asset, amount and fees in TronLink before signing.</span>
            </label>
          </section>

          <section className="studio-panel">
            <div className="studio-panel-heading">
              <div className="studio-panel-icon"><ShieldCheck size={19} aria-hidden="true" /></div>
              <div><p className="studio-eyebrow">Step 3</p><h2>Review and send</h2><p>The wallet must sign this exact transaction. The exchange name is a note only; no exchange deposit is pre-credited or simulated by this app.</p></div>
            </div>
            <div className="studio-review-list">
              <div className="studio-review-row"><span>Network</span><strong>TRON Mainnet</strong><span className="studio-pill studio-pill--good">Mainnet only</span></div>
              <div className="studio-review-row"><span>Exchange label</span><strong>{exchangeName.trim() || 'Not entered'}</strong></div>
              <div className="studio-review-row"><span>Asset</span><strong>{asset === 'USDT' ? 'Official Tether USDT (TRC-20)' : 'Native TRX'}</strong></div>
              {asset === 'USDT' && <div className="studio-review-row"><span>Token contract</span><code>{MAINNET_USDT}</code></div>}
              <div className="studio-review-row"><span>Sender</span><code>{sender || 'Connect wallet first'}</code></div>
              <div className="studio-review-row"><span>Destination</span><code>{destination.trim() || 'Enter address'}</code></div>
              {memo.trim() && <div className="studio-review-row"><span>Memo data</span><code>{memo}</code></div>}
              <div className="studio-review-row"><span>Amount</span><strong>{amount || '—'} {asset}</strong></div>
            </div>
            {sendError && <p className="studio-inline-error" role="alert">{sendError}</p>}
            <div className="studio-inline-actions">
              <button type="button" className="studio-button studio-button--primary" onClick={() => void sendDeposit()} disabled={!formReady}>
                <Wallet size={16} aria-hidden="true" /> {sending ? 'Waiting for wallet / network…' : 'Review and sign real Mainnet transfer'}
              </button>
            </div>
            <p className="studio-footnote">Signing stays inside TronLink. Private keys and recovery phrases are never sent to this app’s backend. A successful broadcast is not a final receipt.</p>
          </section>

          {attempt && (
            <section className="studio-panel" aria-live="polite">
              <div className="studio-panel-heading">
                <div className="studio-panel-icon"><CheckCircle2 size={19} aria-hidden="true" /></div>
                <div><p className="studio-eyebrow">Transaction evidence</p><h2>{statusTitle}</h2><p>{attempt.message}</p></div>
                <span className={`studio-pill studio-pill--${attempt.status === 'verified-on-chain' ? 'good' : attempt.status === 'verification-mismatch' ? 'bad' : 'warning'}`}>{attempt.status.replaceAll('-', ' ')}</span>
              </div>
              <div className="studio-review-list">
                <div className="studio-review-row"><span>Network</span><strong>TRON Mainnet</strong></div>
                <div className="studio-review-row"><span>Asset / amount</span><strong>{formatUnits(attempt.amountBaseUnits, attempt.decimals)} {attempt.asset}</strong></div>
                <div className="studio-review-row"><span>Sender</span><code>{attempt.sender}</code></div>
                <div className="studio-review-row"><span>Destination</span><code>{attempt.receiver}</code></div>
                <div className="studio-review-row"><span>Transaction ID</span><code>{attempt.txId}</code></div>
                <div className="studio-review-row"><span>Created</span><strong>{new Date(attempt.createdAt).toLocaleString()}</strong></div>
                {typeof attempt.blockNumber === 'number' && <div className="studio-review-row"><span>Solidified block</span><strong>{attempt.blockNumber}</strong></div>}
              </div>
              <div className="studio-inline-actions">
                {attempt.status !== 'verified-on-chain' && <button type="button" className="studio-button studio-button--secondary" onClick={() => void verifyAttempt(attempt)} disabled={verifying || sending}><RefreshCw size={15} aria-hidden="true" /> {verifying ? 'Checking solidified receipt…' : 'Verify this same transaction'}</button>}
                <a className="studio-button studio-button--secondary" href={getTronScanTransactionUrl('mainnet', attempt.txId) || undefined} target="_blank" rel="noopener noreferrer">Open on TronScan <ExternalLink size={15} aria-hidden="true" /></a>
                {attempt.status === 'verified-on-chain' && <button type="button" className="studio-button studio-button--secondary" onClick={() => { setAttempt(null); setSendError(''); setDestinationConfirmed(false); setIrreversibleConfirmed(false) }} disabled={sending || verifying}>Prepare another deposit</button>}
              </div>
              {attempt.receiverBalance && (
                <div className="studio-balance-grid">
                  <div className="studio-balance"><span>Receiver Mainnet balance after verification</span><strong>{attempt.asset === 'TRX' ? formatUnits(attempt.receiverBalance.balanceSun, 6) + ' TRX' : formatUnits(attempt.receiverBalance.balanceBaseUnits, 6) + ' USDT'}</strong><p>Read from solidified Mainnet state. A balance read is not an exchange ledger credit.</p></div>
                </div>
              )}
              <div className="studio-notice studio-notice--warning">
                <AlertTriangle size={18} aria-hidden="true" />
                <div><strong>Exchange credit: not verified</strong><p>This generic page does not connect to an exchange's private deposit-status API. Check your exchange account directly. Until its own deposit history confirms credit, treat this as an on-chain transfer only.</p></div>
              </div>
              {attempt.status !== 'verified-on-chain' && <p className="studio-footnote">Another transfer is blocked while the current transaction is pending or uncertain. Verify the exact same transaction ID—never resend just because a status check is delayed.</p>}
            </section>
          )}

          <footer className="studio-footer-note">
            <span><ShieldCheck size={15} aria-hidden="true" /> User-signed transaction</span>
            <span>Official USDT contract fixed</span>
            <span>Exchange credit requires its own confirmation</span>
          </footer>
        </main>
      </div>
    </div>
  )
}
