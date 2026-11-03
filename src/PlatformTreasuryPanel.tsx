import { useEffect, useMemo, useState } from 'react'

type TronProvider = {
  isTronLink?: boolean
  tronWeb?: any
  request: (args: { method: string; params?: unknown }) => Promise<any>
  on?: (event: string, listener: (...args: any[]) => void) => unknown
  removeListener?: (event: string, listener: (...args: any[]) => void) => unknown
}

type TreasuryReadiness = {
  executionEnabled?: boolean
  featureFlagEnabled?: boolean
  configurationComplete?: boolean
  missing?: string[]
  blockers?: string[]
  treasuryAddress?: string
  ownerIdentityAddress?: string
  usdtBalance?: string
  availableUsdt?: string
  trxBalance?: string
  availableTrxSun?: string
  checkedAt?: string
}

type WithdrawalIntent = {
  intent: {
    intentId: string
    treasuryAddress: string
    recipientAddress: string
    amountUsdt: string
    status: string
    transactionHash?: string | null
    expiresAt: string
    feeLimitSun: string
  }
  unsignedTransaction: any
  chainSnapshot?: {
    treasuryUsdtBalance: string
    treasuryTrxBalance: string
    estimatedFeeSun: string
    estimatedFeeTrx: string
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const MAINNET_CHAIN_ID = '0x2b6653dc'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

function isMainnetChainId(value: unknown) {
  return typeof value === 'string' && value.toLowerCase() === MAINNET_CHAIN_ID
}

function isMainnetNode(tronWeb: any) {
  const host = typeof tronWeb?.fullNode?.host === 'string' ? tronWeb.fullNode.host : ''
  try {
    return new URL(host).hostname.toLowerCase() === 'api.trongrid.io'
  } catch {
    return false
  }
}

async function discoverTronLink(): Promise<TronProvider> {
  const injected = (window as any).tron as TronProvider | undefined
  if (injected?.isTronLink === true && typeof injected.request === 'function') return injected

  const provider = await new Promise<TronProvider | null>((resolve) => {
    let settled = false
    let timeoutId: number | undefined
    const finish = (value: TronProvider | null) => {
      if (settled) return
      settled = true
      window.removeEventListener('TIP6963:announceProvider', onAnnounce as EventListener)
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      resolve(value)
    }
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (detail?.info?.name === 'TronLink'
        && detail.provider?.isTronLink === true
        && typeof detail.provider?.request === 'function') finish(detail.provider)
    }
    window.addEventListener('TIP6963:announceProvider', onAnnounce as EventListener)
    timeoutId = window.setTimeout(() => finish(null), 1200)
    window.dispatchEvent(new Event('TIP6963:requestProvider'))
  })
  if (!provider) throw new Error('TronLink was not detected. Open this dashboard in the TronLink browser or install the TronLink browser extension.')
  return provider
}

async function requestTreasuryWallet(): Promise<{ provider: TronProvider; address: string }> {
  const provider = await discoverTronLink()
  const accounts = await provider.request({ method: 'eth_requestAccounts' })
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || !ADDRESS_PATTERN.test(accounts[0])) {
    throw new Error('TronLink did not return an authorized TRON account.')
  }
  const tronWeb = provider.tronWeb
  const address = String(tronWeb?.defaultAddress?.base58 || accounts[0])
  if (address !== accounts[0] || !tronWeb?.ready || !tronWeb?.isAddress?.(address)) {
    throw new Error('TronLink account details are not ready or do not match. Reconnect the intended treasury wallet.')
  }

  const chainId = await provider.request({ method: 'eth_chainId' }).catch(() => null)
  if (typeof chainId === 'string') {
    if (!isMainnetChainId(chainId)) throw new Error('Switch TronLink to TRON Mainnet before connecting the treasury wallet.')
  } else if (!isMainnetNode(tronWeb)) {
    throw new Error('The connected TronLink node could not be verified as TRON Mainnet.')
  }
  return { provider, address }
}

async function apiRequest(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(API_BASE + path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: 'Bearer ' + token,
      ...(init.headers || {}),
    },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.success !== true) {
    const reason = typeof payload?.error === 'string' ? payload.error : 'treasury-request-failed'
    throw new Error(reason.replaceAll('-', ' '))
  }
  return payload
}

export default function PlatformTreasuryPanel({
  ownerSessionToken,
  active,
}: {
  ownerSessionToken: string
  active: boolean
}) {
  const [provider, setProvider] = useState<TronProvider | null>(null)
  const [treasuryAddress, setTreasuryAddress] = useState('')
  const [readiness, setReadiness] = useState<TreasuryReadiness | null>(null)
  const [recipientAddress, setRecipientAddress] = useState('')
  const [amountUsdt, setAmountUsdt] = useState('')
  const [prepared, setPrepared] = useState<WithdrawalIntent | null>(null)
  const [lastStatus, setLastStatus] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const walletConnected = Boolean(provider && treasuryAddress)
  const matchingTreasuryWallet = Boolean(readiness?.treasuryAddress && treasuryAddress === readiness.treasuryAddress)
  const canPrepare = Boolean(ownerSessionToken && walletConnected && matchingTreasuryWallet
    && readiness?.executionEnabled === true && recipientAddress.trim() && amountUsdt.trim() && !prepared)

  const statusLabel = useMemo(() => {
    const status = lastStatus?.intent?.status || prepared?.intent?.status
    if (status === 'confirmed') return 'Confirmed on TRON'
    if (status === 'failed') return 'Failed on-chain'
    if (status === 'rejected') return 'Intent expired or rejected'
    if (status === 'broadcast-accepted') return 'Broadcast accepted · awaiting confirmation'
    if (status === 'broadcast-unknown' || status === 'broadcasting') return 'Broadcast outcome unknown · reconcile before retry'
    if (status === 'prepared') return 'Prepared · awaiting treasury-wallet signature'
    return 'No withdrawal submitted'
  }, [lastStatus, prepared])

  async function refreshReadiness(activeProvider = provider, activeAddress = treasuryAddress) {
    if (!ownerSessionToken) throw new Error('Sign in with the owner identity wallet first. This wallet can have zero funds.')
    if (!activeProvider || !activeAddress) throw new Error('Connect the separate platform treasury wallet first.')
    const chainId = await activeProvider.request({ method: 'eth_chainId' }).catch(() => null)
    if (typeof chainId === 'string' ? !isMainnetChainId(chainId) : !isMainnetNode(activeProvider.tronWeb)) {
      throw new Error('The treasury wallet is no longer connected to verified TRON Mainnet.')
    }
    const data = await apiRequest('/api/treasury/self-custody/readiness', ownerSessionToken)
    if (data.treasuryAddress !== activeAddress) {
      throw new Error('Connected wallet does not match PLATFORM_TREASURY_ADDRESS. No transaction can be prepared.')
    }
    setReadiness(data)
    return data
  }

  async function connectTreasuryWallet() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const connected = await requestTreasuryWallet()
      setProvider(connected.provider)
      setTreasuryAddress(connected.address)
      const data = await refreshReadiness(connected.provider, connected.address)
      setNotice(data.executionEnabled
        ? 'Platform treasury wallet connected. Mainnet balances and available reserves were read from chain.'
        : 'Wallet connected and chain balances checked. Review the configuration and funding blockers below.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not connect the treasury wallet.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (ownerSessionToken) return
    setProvider(null)
    setTreasuryAddress('')
    setReadiness(null)
    setPrepared(null)
    setLastStatus(null)
  }, [ownerSessionToken])

  useEffect(() => {
    if (!provider) return
    const resetForWalletChange = () => {
      setProvider(null)
      setTreasuryAddress('')
      setReadiness(null)
      setNotice('TronLink account or network changed. Reconnect the configured Mainnet treasury wallet before signing. Any prepared server-side intent remains reserved until it expires; do not create a duplicate.')
    }
    const accountsChanged = (accounts: unknown) => {
      const next = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : ''
      if (next !== treasuryAddress) resetForWalletChange()
    }
    const chainChanged = (chainId: unknown) => {
      if (!isMainnetChainId(chainId)) resetForWalletChange()
    }
    provider.on?.('accountsChanged', accountsChanged)
    provider.on?.('chainChanged', chainChanged)
    provider.on?.('disconnect', resetForWalletChange)
    return () => {
      provider.removeListener?.('accountsChanged', accountsChanged)
      provider.removeListener?.('chainChanged', chainChanged)
      provider.removeListener?.('disconnect', resetForWalletChange)
    }
  }, [provider, treasuryAddress])

  async function prepareWithdrawal() {
    if (!provider || !treasuryAddress || !readiness) throw new Error('Connect and verify the platform treasury wallet first.')
    if (!ADDRESS_PATTERN.test(recipientAddress.trim()) || recipientAddress.trim() === treasuryAddress) {
      throw new Error('Enter a valid TRON recipient address different from the treasury.')
    }
    const data = await refreshReadiness()
    if (data.executionEnabled !== true) throw new Error('Treasury execution is not enabled or current readiness checks did not pass.')
    const payload = await apiRequest('/api/treasury/self-custody/prepare', ownerSessionToken, {
      method: 'POST',
      body: JSON.stringify({ recipientAddress: recipientAddress.trim(), amountUsdt: amountUsdt.trim() }),
    })
    if (payload.intent?.treasuryAddress !== treasuryAddress || !payload.unsignedTransaction) {
      throw new Error('Prepared transfer does not match the connected treasury wallet.')
    }
    setPrepared(payload as WithdrawalIntent)
    setLastStatus(null)
    setNotice('Withdrawal intent prepared and funds reserved. No transaction has been signed or sent.')
  }

  async function signAndSubmit() {
    if (!provider || !prepared) throw new Error('Prepare a withdrawal and connect the treasury wallet first.')
    const currentAddress = String(provider.tronWeb?.defaultAddress?.base58 || '')
    if (currentAddress !== treasuryAddress || currentAddress !== prepared.intent.treasuryAddress) {
      throw new Error('TronLink account changed after preparation. The intent cannot be signed by another wallet.')
    }
    const signed = await provider.tronWeb.trx.sign(prepared.unsignedTransaction)
    if (!signed || !Array.isArray(signed.signature) || signed.signature.length < 1
      || signed.raw_data_hex !== prepared.unsignedTransaction.raw_data_hex
      || signed.txID !== prepared.unsignedTransaction.txID) {
      throw new Error('TronLink returned a signature for different transaction data. Submission was stopped.')
    }
    const signedTransaction = {
      txID: signed.txID,
      raw_data: signed.raw_data,
      raw_data_hex: signed.raw_data_hex,
      signature: signed.signature,
      ...(typeof signed.visible === 'boolean' ? { visible: signed.visible } : {}),
    }
    const result = await apiRequest('/api/treasury/self-custody/submit', ownerSessionToken, {
      method: 'POST',
      body: JSON.stringify({ intentId: prepared.intent.intentId, signedTransaction }),
    })
    setLastStatus(result)
    if (result.intent) setPrepared((current) => current ? { ...current, intent: result.intent } : current)
    setNotice(result.note || 'Signed transaction submitted. Check solidified chain status before treating it as paid.')
  }

  async function refreshStatus() {
    if (!prepared?.intent?.intentId) throw new Error('There is no prepared withdrawal to reconcile.')
    const result = await apiRequest(
      '/api/treasury/self-custody/withdrawals/' + encodeURIComponent(prepared.intent.intentId),
      ownerSessionToken,
    )
    setLastStatus(result)
    if (result.intent) setPrepared((current) => current ? { ...current, intent: result.intent } : current)
    setNotice(result.note || 'Withdrawal status refreshed from the TRON chain.')
    if (result.intent?.status === 'confirmed' || result.intent?.status === 'failed' || result.intent?.status === 'rejected') {
      setPrepared(null)
      const next = await refreshReadiness().catch(() => null)
      if (next) setReadiness(next)
    }
  }

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Treasury operation failed.')
    } finally {
      setBusy(false)
    }
  }

  function clearPreparedIntent() {
    setPrepared(null)
    setLastStatus(null)
    setNotice('Local view cleared. A prepared server-side intent remains reserved until it expires; it has not been signed or broadcast.')
  }

  return (
    <section className="wallet-vault-transfer-section" hidden={!active} aria-labelledby="platform-owned-treasury-heading">
      <div className="wallet-vault-panel-head">
        <span className="wallet-vault-step">SELF-CUSTODY</span>
        <div>
          <h2 id="platform-owned-treasury-heading">Platform-owned TRON treasury</h2>
          <p>Separate owner identity from the treasury signing wallet. The treasury wallet must hold genuine USDT and TRX.</p>
        </div>
      </div>

      <div className="wallet-vault-transfer-warning" role="note">
        <strong>No private-key import or third-party vault required</strong>
        <p>Sign in with the owner identity wallet first. Then connect the separately configured treasury wallet through TronLink. The backend never receives either wallet's private key. Every payout requires a visible TronLink transaction approval.</p>
      </div>

      {!ownerSessionToken && (
        <p className="wallet-vault-risk-note" role="status">Owner identity session is missing. Use the owner treasury sign-in above; the identity wallet does not need USDT or TRX.</p>
      )}

      <div className="wallet-vault-review-grid">
        <div className="wallet-vault-review-wide">
          <small>Connected treasury wallet</small>
          <strong>{treasuryAddress || 'Not connected'}</strong>
        </div>
        <div>
          <small>Configured treasury match</small>
          <strong>{readiness ? (matchingTreasuryWallet ? 'Verified' : 'Mismatch') : 'Not checked'}</strong>
        </div>
        <div>
          <small>Withdrawal state</small>
          <strong>{statusLabel}</strong>
        </div>
        {readiness && (
          <>
            <div><small>On-chain USDT</small><strong>{readiness.usdtBalance || 'Unavailable'} USDT</strong></div>
            <div><small>Unreserved USDT</small><strong>{readiness.availableUsdt || 'Unavailable'} USDT</strong></div>
            <div><small>On-chain TRX</small><strong>{readiness.trxBalance || 'Unavailable'} TRX</strong></div>
            <div><small>Execution configuration</small><strong>{readiness.executionEnabled ? 'Ready for per-request review' : 'Not ready'}</strong></div>
          </>
        )}
      </div>

      <div className="wallet-vault-review-actions">
        <button type="button" className="wallet-vault-primary" disabled={busy || !ownerSessionToken} onClick={() => void run(connectTreasuryWallet)}>
          {busy ? 'Connecting…' : walletConnected ? 'Reconnect treasury wallet' : 'Connect treasury wallet'}
        </button>
        <button type="button" className="wallet-vault-secondary" disabled={busy || !walletConnected} onClick={() => void run(async () => {
          const data = await refreshReadiness()
          setNotice(data.executionEnabled ? 'Treasury readiness passed.' : 'Readiness refreshed; review the blockers below.')
        })}>Refresh treasury balances</button>
      </div>

      {readiness?.missing && readiness.missing.length > 0 && (
        <p className="wallet-vault-risk-note" role="alert">Backend configuration missing: {readiness.missing.join(', ')}</p>
      )}
      {readiness?.blockers && readiness.blockers.length > 0 && (
        <p className="wallet-vault-risk-note" role="status">Current blockers: {readiness.blockers.join('; ')}</p>
      )}
      {readiness?.featureFlagEnabled === false && (
        <p className="wallet-vault-risk-note" role="status">Execution flag is currently off. Configure PLATFORM_TREASURY_SELF_CUSTODY_ENABLED=true only after reviewing the signer, limits, database, and controlled test results.</p>
      )}

      <div className="wallet-vault-transfer-form">
        <label htmlFor="platform-treasury-recipient">External TRON wallet / exchange deposit address</label>
        <input id="platform-treasury-recipient" value={recipientAddress} onChange={(event) => setRecipientAddress(event.target.value)} autoComplete="off" spellCheck={false} placeholder="T… (TRON Mainnet address)" />
        <label htmlFor="platform-treasury-amount">USDT amount</label>
        <input id="platform-treasury-amount" value={amountUsdt} onChange={(event) => { setAmountUsdt(event.target.value); setPrepared(null); setLastStatus(null) }} inputMode="decimal" autoComplete="off" placeholder="e.g. 10.00" />
        <button type="button" className="wallet-vault-primary" disabled={busy || !canPrepare} onClick={() => void run(prepareWithdrawal)}>
          {busy ? 'Checking funds and preparing…' : 'Prepare USDT withdrawal'}
        </button>
      </div>

      {prepared && (
        <div className="wallet-vault-transfer-review">
          <div className="wallet-vault-review-header">
            <strong>Prepared withdrawal · no transaction sent yet</strong>
            <small>Intent expires {new Date(prepared.intent.expiresAt).toLocaleString()}</small>
          </div>
          <div className="wallet-vault-review-grid">
            <div><small>From treasury</small><strong>{prepared.intent.treasuryAddress}</strong></div>
            <div><small>Recipient</small><strong>{prepared.intent.recipientAddress}</strong></div>
            <div><small>Amount</small><strong>{prepared.intent.amountUsdt} USDT</strong></div>
            <div><small>Fee reserve</small><strong>{prepared.chainSnapshot?.estimatedFeeTrx || '—'} TRX</strong></div>
            <div className="wallet-vault-review-wide"><small>Intent ID</small><strong>{prepared.intent.intentId}</strong></div>
          </div>
          <div className="wallet-vault-review-actions">
            <button type="button" className="wallet-vault-primary" disabled={busy || prepared.intent.status !== 'prepared'} onClick={() => void run(signAndSubmit)}>
              {busy ? 'Waiting for wallet…' : 'Sign in TronLink & submit'}
            </button>
            <button type="button" className="wallet-vault-secondary" disabled={busy} onClick={() => void run(refreshStatus)}>Refresh status</button>
            <button type="button" className="wallet-vault-secondary" disabled={busy} onClick={clearPreparedIntent}>Clear local view</button>
          </div>
        </div>
      )}

      {lastStatus?.verification && (
        <div className="wallet-vault-review-grid">
          <div><small>Chain verification</small><strong>{lastStatus.verification.status}</strong></div>
          <div><small>Evidence</small><strong>{lastStatus.verification.reason}</strong></div>
          {lastStatus.intent?.transactionHash && (
            <div className="wallet-vault-review-wide">
              <small>TRON transaction</small>
              <a href={'https://tronscan.org/#/transaction/' + encodeURIComponent(lastStatus.intent.transactionHash)} target="_blank" rel="noopener noreferrer">{lastStatus.intent.transactionHash} ↗</a>
            </div>
          )}
          <div><small>Exchange credit</small><strong>Not verified by this app</strong></div>
        </div>
      )}

      {error && <p className="wallet-vault-risk-note" role="alert">{error}</p>}
      {notice && <p className="wallet-vault-caption" role="status">{notice}</p>}
      <p className="wallet-vault-caption">The login wallet is identity only. Real payouts spend only the USDT actually held by the configured platform treasury. A broadcast response is not final confirmation; exchange deposit credit must be checked with the exchange.</p>
    </section>
  )
}
