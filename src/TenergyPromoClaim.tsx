import { useEffect, useState } from 'react'
import { ArrowLeft, CheckCircle2, CircleAlert, RefreshCw, Wallet, Zap } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\\/+$/, '')
type Payload = { success?: boolean; status?: string; message?: string; address?: string; nonce?: string; purpose?: string; energy?: number; expiresAt?: string | null; grant?: { resource: string; amount: number; durationSeconds: number } | null; state?: string; solidifiedOwnerResources?: { verified?: boolean; currentlyAvailableEnergy?: string; currentlyAvailableBandwidth?: string; status?: string }; [key: string]: any }

declare global {
  interface Window {
    tronLink?: { request?: (request: { method: string }) => Promise<unknown>; tronWeb?: any }
    tron?: { request?: (request: { method: string }) => Promise<unknown>; tronWeb?: any }
    tronWeb?: any
  }
}

async function api(path: string, init?: RequestInit): Promise<Payload> {
  const response = await fetch(API_BASE + '/api/tron/resource-promo/' + path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    credentials: 'omit', cache: 'no-store', redirect: 'error',
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.status || body.error || 'Promo service request failed.')
  return body
}

function connectedWallet() {
  const provider = [window.tron, window.tronLink].find((item) => item && item.isTronLink === true && item.request)
  const tronWeb = provider?.tronWeb || window.tronWeb
  const address = String(tronWeb?.defaultAddress?.base58 || '').trim()
  const host = String(tronWeb?.fullNode?.host || tronWeb?.fullNode?.nodeUrl || '')
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) throw new Error('Connect the owner wallet in TronLink first.')
  let hostname = ''
  try { hostname = new URL(host).hostname.toLowerCase() } catch { /* rejected below */ }
  if (!['api.trongrid.io', 'tron-mainnet.gateway.tatum.io'].includes(hostname)) {
    throw new Error('Switch TronLink to TRON Mainnet before claiming. No network switch is performed automatically.')
  }
  if (typeof tronWeb?.trx?.signMessageV2 !== 'function') {
    throw new Error('This TronLink version does not expose signMessageV2. Update TronLink and reconnect.')
  }
  return { provider, tronWeb, address }
}

export default function TenergyPromoClaim() {
  const [terms, setTerms] = useState<Payload | null>(null)
  const [status, setStatus] = useState<Payload | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('Check whether the configured owner wallet is eligible for the one-time Energy promotion.')

  async function refresh() {
    setBusy(true); setError('')
    try {
      const nextTerms = await api('terms')
      setTerms(nextTerms)
      const { address } = connectedWallet()
      const nextStatus = await api('status?address=' + encodeURIComponent(address))
      setStatus(nextStatus)
      setMessage(nextStatus.status === 'delegated'
        ? 'TEnergy reports the promotional Energy delegation as complete.'
        : nextStatus.status === 'granting'
          ? 'The provider is processing the grant. Refresh status shortly.'
          : 'Promo terms and owner redemption status refreshed.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not refresh promo status.')
    } finally { setBusy(false) }
  }

  useEffect(() => {
    void api('terms').then(setTerms).catch((caught) => setError(caught instanceof Error ? caught.message : 'Promo terms unavailable.'))
  }, [])

  async function claim() {
    setBusy(true); setError('')
    try {
      const { provider, tronWeb, address } = connectedWallet()
      const challenge = await api('challenge', {
        method: 'POST', body: JSON.stringify({ address }),
      })
      if (challenge.success !== true || typeof challenge.message !== 'string' || typeof challenge.nonce !== 'string') {
        throw new Error(challenge.status || 'The provider did not issue a valid eligibility challenge.')
      }
      setMessage('Review the exact TEnergy promo message in TronLink. It is a message signature, not a transaction.')
      const signature = await tronWeb.trx.signMessageV2(challenge.message)
      if (typeof signature !== 'string' || !/^(?:0x)?[0-9a-f]{130}$/i.test(signature)) {
        throw new Error('TronLink did not return a valid 65-byte message signature.')
      }
      const redeemed = await api('redeem', {
        method: 'POST',
        body: JSON.stringify({ address, nonce: challenge.nonce, signature }),
      })
      setStatus(redeemed)
      setMessage(redeemed.status === 'delegated'
        ? 'Provider reports the grant delegated. Refresh to read the owner wallet resources from Tatum SolidityNode.'
        : 'Claim accepted. The provider reports the grant is processing; refresh status shortly.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Promo claim failed.')
    } finally { setBusy(false) }
  }

  return (
    <main className="wallet-vault-page">
      <header className="wallet-vault-header">
        <a href="#/wallet"><ArrowLeft size={16} aria-hidden="true" /> Wallet Vault</a>
        <span>TRON MAINNET</span>
      </header>
      <section className="wallet-vault-card" style={{ maxWidth: 760, margin: '32px auto' }}>
        <div className="wallet-vault-card-heading">
          <Zap size={22} aria-hidden="true" />
          <div><h1>One-time free Energy claim</h1><p>TEnergy promotional Mainnet delegation</p></div>
        </div>
        <p>This provider offers a one-time Energy grant only to addresses included in its promotional drop. Eligibility is checked before TronLink asks you to sign.</p>
        <dl>
          <dt>Promotion state</dt><dd>{terms?.state || 'Checking…'}</dd>
          <dt>Grant</dt><dd>{terms?.grant ? terms.grant.amount.toLocaleString() + ' Energy' : 'Unavailable / not active'}</dd>
          <dt>Duration</dt><dd>{terms?.grant ? Math.round(terms.grant.durationSeconds / 60) + ' minutes' : '—'}</dd>
          <dt>Redemption</dt><dd>{status?.status || 'Not checked'}</dd>
          <dt>Verified available Energy</dt><dd>{status?.solidifiedOwnerResources?.verified ? Number(status.solidifiedOwnerResources.currentlyAvailableEnergy).toLocaleString() : 'Not independently read yet'}</dd>
          <dt>Available Bandwidth</dt><dd>{status?.solidifiedOwnerResources?.verified ? Number(status.solidifiedOwnerResources.currentlyAvailableBandwidth).toLocaleString() : 'Not independently read yet'}</dd>
        </dl>
        <div className="wallet-vault-actions">
          <button type="button" onClick={() => void claim()} disabled={busy || terms?.state !== 'active' || status?.status === 'delegated'}>
            <Wallet size={16} aria-hidden="true" /> Sign eligibility message and claim
          </button>
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw size={16} aria-hidden="true" /> Refresh status
          </button>
        </div>
        <p role="status"><CheckCircle2 size={15} aria-hidden="true" /> {message}</p>
        {error && <p role="alert"><CircleAlert size={15} aria-hidden="true" /> {error}</p>}
        <p><strong>Important:</strong> This promotion supplies Energy only, not Bandwidth. It is one claim per eligible address. The wallet signs a human-readable message; no TRX transfer or on-chain transaction is requested from your wallet. A provider status is not treated as a verified resource grant until the owner resource snapshot is independently read from Tatum SolidityNode.</p>
      </section>
    </main>
  )
}
