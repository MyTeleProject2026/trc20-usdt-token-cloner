import { useState } from 'react'
import { CheckCircle2, CircleAlert, ShieldCheck, Wallet } from 'lucide-react'

type Network = 'mainnet' | 'nile' | 'shasta'
type Role = 'asset-principal' | 'network-fee'
type WalletProvider = { request?: (request: { method: string }) => Promise<unknown>; tronWeb?: any; isTronLink?: boolean }
type ApiResult = { success?: boolean; error?: string; message?: string; [key: string]: any }

declare global {
  interface Window {
    tronLink?: WalletProvider
    tron?: WalletProvider
    tronWeb?: any
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const NETWORK_HOSTS: Record<Network, string> = {
  mainnet: 'api.trongrid.io',
  nile: 'nile.trongrid.io',
  shasta: 'api.shasta.trongrid.io',
}
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i

function getWalletProvider(): WalletProvider | null {
  const candidates = [window.tron, window.tronLink]
  return candidates.find((provider) => provider?.isTronLink === true
    && typeof provider.request === 'function' && provider.tronWeb) || null
}

async function requestWalletAccess(provider: WalletProvider) {
  try {
    await provider.request?.({ method: 'eth_requestAccounts' })
  } catch (caught) {
    const code = Number((caught as any)?.code)
    const reason = String((caught as any)?.message || caught || '')
    if (code === -32601 || code === 4200 || /method not found|unsupported method|method not supported/i.test(reason)) {
      await provider.request?.({ method: 'tron_requestAccounts' })
    } else {
      throw caught
    }
  }
}

function readActiveWallet(provider: WalletProvider, network: Network) {
  const tronWeb = provider.tronWeb || window.tronWeb
  const address = String(tronWeb?.defaultAddress?.base58 || '')
  if (!ADDRESS_PATTERN.test(address)) throw new Error('TronLink has no active Base58 wallet address. Unlock the wallet and select an account.')
  const hostValue = String(tronWeb?.fullNode?.host || '')
  let hostname = ''
  try { hostname = new URL(hostValue).hostname.toLowerCase() } catch { /* handled below */ }
  if (hostname !== NETWORK_HOSTS[network]) {
    throw new Error('The active TronLink RPC network does not match ' + network + '. Switch networks before approving this intent.')
  }
  return { address, hostname, tronWeb }
}

async function requestJson(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
  })
  const payload = await response.json().catch(() => ({})) as ApiResult
  return { response, payload }
}

export default function SponsorPayoutAuthorization() {
  const [network, setNetwork] = useState<Network>('nile')
  const [intentId, setIntentId] = useState('')
  const [role, setRole] = useState<Role>('asset-principal')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Enter the intent ID shared by the platform operator. Connect the sponsor organization’s own wallet to review and sign its role-specific approval.')
  const [error, setError] = useState('')
  const [result, setResult] = useState<ApiResult | null>(null)

  const approveIntentRole = async () => {
    let walletSessionToken = ''
    setError('')
    setResult(null)
    setBusy(true)
    try {
      if (!/^[1-9][0-9]{0,17}$/.test(intentId.trim())) {
        throw new Error('Enter the numeric payout intent ID supplied by the platform operator.')
      }
      const provider = getWalletProvider()
      if (!provider) throw new Error('TronLink is not detected. Open this page in the TronLink browser or a supported wallet browser.')
      await requestWalletAccess(provider)
      const before = readActiveWallet(provider, network)
      if (typeof before.tronWeb?.trx?.signMessageV2 !== 'function') {
        throw new Error('This wallet does not support signMessageV2. Update TronLink and retry.')
      }

      setMessage('First, prove wallet ownership with a separate sign-in message. This message authorizes no sponsor allocation or transfer.')
      const loginChallenge = await requestJson(API_BASE + '/api/auth/tron/challenge', {
        method: 'POST',
        body: JSON.stringify({ address: before.address, network }),
      })
      if (!loginChallenge.response.ok || loginChallenge.payload.success !== true
        || typeof loginChallenge.payload.message !== 'string'
        || typeof loginChallenge.payload.nonce !== 'string') {
        throw new Error(loginChallenge.payload.message || loginChallenge.payload.error || 'Wallet identity challenge could not be created.')
      }
      const loginSignature = await before.tronWeb.trx.signMessageV2(loginChallenge.payload.message)
      if (typeof loginSignature !== 'string' || !SIGNATURE_PATTERN.test(loginSignature)) {
        throw new Error('The wallet returned an invalid identity signature.')
      }
      const afterLogin = readActiveWallet(provider, network)
      if (afterLogin.address !== before.address || afterLogin.hostname !== before.hostname) {
        throw new Error('The active wallet or network changed during wallet sign-in. Restart with the intended sponsor account.')
      }
      const loginVerification = await requestJson(API_BASE + '/api/auth/tron/verify', {
        method: 'POST',
        body: JSON.stringify({
          address: before.address,
          network,
          nonce: loginChallenge.payload.nonce,
          signature: loginSignature,
        }),
      })
      if (!loginVerification.response.ok || loginVerification.payload.success !== true
        || loginVerification.payload.authenticated !== true
        || loginVerification.payload.address !== before.address
        || loginVerification.payload.network !== network
        || typeof loginVerification.payload.sessionToken !== 'string') {
        throw new Error(loginVerification.payload.message || loginVerification.payload.error || 'Wallet identity verification failed.')
      }
      walletSessionToken = loginVerification.payload.sessionToken

      setMessage('Wallet identity verified. The backend is now checking whether this exact wallet is the approved account for the selected sponsor role.')
      const challengeResponse = await requestJson(
        API_BASE + '/api/tron/sponsorship/payout-intents/' + encodeURIComponent(intentId.trim()) + '/authorization-challenges',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + walletSessionToken },
          body: JSON.stringify({ role }),
        },
      )
      if (!challengeResponse.response.ok || challengeResponse.payload.success !== true
        || typeof challengeResponse.payload.challenge?.message !== 'string'
        || typeof challengeResponse.payload.challenge?.nonce !== 'string') {
        throw new Error(challengeResponse.payload.error || challengeResponse.payload.reason
          || 'This wallet is not currently approved for the selected sponsor role on this intent.')
      }
      const challenge = challengeResponse.payload.challenge
      setMessage('Review the complete intent details in the TronLink message prompt. Approve only if the sponsor role, recipient, amount, network, fee cap and intent digest are correct.')
      const sponsorSignature = await before.tronWeb.trx.signMessageV2(challenge.message)
      if (typeof sponsorSignature !== 'string' || !SIGNATURE_PATTERN.test(sponsorSignature)) {
        throw new Error('The wallet returned an invalid sponsor authorization signature.')
      }
      const afterApproval = readActiveWallet(provider, network)
      if (afterApproval.address !== before.address || afterApproval.hostname !== before.hostname) {
        throw new Error('The wallet account or network changed while the sponsor approval was displayed. The approval was not submitted.')
      }
      const authorization = await requestJson(
        API_BASE + '/api/tron/sponsorship/payout-intents/' + encodeURIComponent(intentId.trim()) + '/authorize',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + walletSessionToken },
          body: JSON.stringify({ role, nonce: challenge.nonce, signature: sponsorSignature }),
        },
      )
      if (!authorization.response.ok || authorization.payload.success !== true) {
        throw new Error(authorization.payload.error || authorization.payload.reason || 'The sponsor authorization was rejected.')
      }
      setResult(authorization.payload)
      setMessage(authorization.payload.bothSponsorsAuthorized === true
        ? 'Both sponsor organizations have approved this exact intent. This still does not authorize or submit a blockchain transaction.'
        : 'This sponsor role is recorded. The other independent sponsor organization must sign its own role-specific challenge before the intent is considered fully sponsor-approved.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sponsor payout authorization failed.')
      setMessage('No blockchain transaction was built, signed or submitted by this approval page.')
    } finally {
      if (walletSessionToken) {
        void fetch(API_BASE + '/api/auth/tron/logout', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + walletSessionToken },
          credentials: 'omit',
          cache: 'no-store',
        }).catch(() => undefined)
      }
      setBusy(false)
    }
  }

  return (
    <div className="sponsor-console-page">
      <div className="sponsor-console-shell">
        <header className="sponsor-console-header">
          <div className="sponsor-console-brand"><ShieldCheck size={21} aria-hidden="true" /><span>TRON TOKEN STUDIO <small>SPONSOR AUTHORIZATION</small></span></div>
          <a href="#/workspace" className="sponsor-console-back">Back to workspace</a>
        </header>
        <main className="sponsor-console-main">
          <p className="sponsor-console-eyebrow">INDEPENDENT SPONSOR WALLET • MESSAGE SIGNATURE ONLY</p>
          <h1>Approve a sponsor payout intent</h1>
          <p className="sponsor-console-lead">This page is for each independent sponsor organization. Sign in using the organization’s own TronLink wallet, inspect the exact intent shown in the wallet prompt, and approve only the contribution assigned to that address. Do not enter a private key, seed phrase or recovery phrase.</p>

          <section className="sponsor-console-state">
            <div className="sponsor-console-state-icon"><ShieldCheck size={18} aria-hidden="true" /></div>
            <div className="sponsor-console-state-copy">
              <strong>Wallet ownership and sponsor consent are separate signatures</strong>
              <span>First signature: short-lived wallet identity session. Second signature: exact sponsor allocation message. Neither signature is a blockchain transaction.</span>
            </div>
          </section>

          <section className="sponsor-console-card">
            <div className="sponsor-console-step"><span><Wallet size={15} aria-hidden="true" /></span><div><h2>Review the pending intent</h2><p>Use the intent ID supplied by the operator. The backend checks that the selected wallet matches the verified account for the chosen role, and that its organization, agreement and budget link remain active.</p></div></div>
            <label className="sponsor-console-label" htmlFor="sponsor-intent-id">Payout intent ID</label>
            <input id="sponsor-intent-id" value={intentId} onChange={(event) => setIntentId(event.target.value.replace(/[^0-9]/g, '').slice(0, 18))} inputMode="numeric" autoComplete="off" />
            <label className="sponsor-console-label" htmlFor="sponsor-intent-network">TRON network</label>
            <select id="sponsor-intent-network" value={network} onChange={(event) => { setNetwork(event.target.value as Network); setResult(null); setError('') }}>
              <option value="nile">Nile testnet</option>
              <option value="shasta">Shasta testnet</option>
              <option value="mainnet">Mainnet (approval only; no payout execution)</option>
            </select>
            <label className="sponsor-console-label" htmlFor="sponsor-intent-role">Sponsor role</label>
            <select id="sponsor-intent-role" value={role} onChange={(event) => { setRole(event.target.value as Role); setResult(null); setError('') }}>
              <option value="asset-principal">Asset-principal sponsor</option>
              <option value="network-fee">Network-fee sponsor</option>
            </select>
            <p className="sponsor-console-field-note">Each organization must use its own verified wallet. A wallet with the wrong role, network, account status or budget agreement is rejected before the sponsor approval message is shown.</p>
            <button type="button" className="sponsor-console-button sponsor-console-button--primary" onClick={() => void approveIntentRole()} disabled={busy || !intentId.trim()}>
              <Wallet size={16} aria-hidden="true" /> {busy ? 'Waiting for wallet approval…' : 'Connect wallet and sign sponsor approval'}
            </button>
          </section>

          {error && <div className="sponsor-console-result-note" role="alert"><CircleAlert size={16} aria-hidden="true" /> {error}</div>}
          {result && <section className="sponsor-console-card" aria-live="polite">
            <div className="sponsor-console-step"><span><CheckCircle2 size={15} aria-hidden="true" /></span><div><h2>Authorization result</h2><p>{result.status || 'status unavailable'}</p></div></div>
            <div className="sponsor-console-detail"><span>Approved roles</span><strong>{Array.isArray(result.authorizedRoles) ? result.authorizedRoles.join(' · ') : role}</strong></div>
            <div className="sponsor-console-detail"><span>Remaining sponsor approvals</span><strong>{Array.isArray(result.missingRoles) && result.missingRoles.length ? result.missingRoles.join(' · ') : 'None reported'}</strong></div>
            <div className="sponsor-console-result-note">The backend stores only a signature hash and the challenge/message digests. The raw message signature is not persisted by this endpoint.</div>
            <div className="sponsor-console-result-note">Both sponsor approvals still do not verify a transaction-specific Energy/Bandwidth/fee quote, authorize a transaction signature, or enable broadcasting. The payout execution gates remain separate.</div>
          </section>}
          <section className="sponsor-console-state">
            <div className="sponsor-console-state-copy">
              <strong>{error ? 'Approval not completed' : result?.bothSponsorsAuthorized === true ? 'Both sponsor roles approved' : 'Approval remains pending'}</strong>
              <span>{message}</span>
              <span>Network: {network} · Execution: disabled · Private keys collected: no · Transaction broadcast: no</span>
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}
