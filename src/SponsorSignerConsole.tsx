import { useCallback, useEffect, useState } from 'react'
import { Activity, ArrowLeft, CheckCircle2, CircleAlert, ExternalLink, LockKeyhole, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'

type Network = 'shasta' | 'nile'
type WalletSnapshot = { address: string; host: string; network: Network; checkedAt: string }
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
    tronLink?: { request?: (request: { method: string }) => Promise<unknown>; tronWeb?: any }
    tronWeb?: any
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const HOSTS: Record<Network, string> = {
  shasta: 'api.shasta.trongrid.io',
  nile: 'nile.trongrid.io',
}

function readInjectedWallet(network: Network): WalletSnapshot {
  const tronWeb = window.tronLink?.tronWeb || window.tronWeb
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
  const [wallet, setWallet] = useState<WalletSnapshot | null>(null)
  const [serverStatus, setServerStatus] = useState<ApiPayload | null>(null)
  const [roleStatus, setRoleStatus] = useState<SponsorRolesSnapshot | null>(null)
  const [busy, setBusy] = useState<'connecting' | 'checking' | 'signing' | null>(null)
  const [message, setMessage] = useState('Connect the asset-principal sponsor wallet on the selected testnet.')
  const [error, setError] = useState('')
  const [lastIntent, setLastIntent] = useState<ApiPayload | null>(null)
  const [lastResult, setLastResult] = useState<ApiPayload | null>(null)

  const refreshSponsorRoles = useCallback(async (selectedNetwork: Network): Promise<{ ok: boolean; message?: string }> => {
    try {
      const result = await requestJson(API_BASE + '/api/tron/sponsorship/roles?network=' + encodeURIComponent(selectedNetwork) + '&refresh=1')
      if (!result.response.ok || result.payload.success !== true || result.payload.network !== selectedNetwork) {
        setRoleStatus(null)
        return { ok: false, message: result.payload.message || result.payload.error || 'Sponsor role diagnostics could not be verified.' }
      }
      setRoleStatus(result.payload as SponsorRolesSnapshot)
      return { ok: true }
    } catch (caught) {
      setRoleStatus(null)
      return { ok: false, message: caught instanceof Error ? caught.message : 'Sponsor role diagnostics could not be loaded.' }
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

  const connectWallet = async () => {
    setError('')
    setMessage('Requesting wallet connection…')
    setBusy('connecting')
    try {
      if (typeof window.tronLink?.request !== 'function') {
        throw new Error('TronLink is not detected. Open this console in a browser with the sponsor wallet extension/app available.')
      }
      await window.tronLink.request({ method: 'tron_requestAccounts' })
      const next = readInjectedWallet(network)
      setWallet(next)
      const rolesResult = await refreshSponsorRoles(network)
      setMessage(rolesResult.ok
        ? 'Sponsor wallet connected; network and live read-only sponsor-role diagnostics refreshed. No transaction has been signed.'
        : 'Wallet and network verified, but live sponsor-role diagnostics could not be verified. Signing remains blocked until those checks are healthy.')
      if (!rolesResult.ok) setError(rolesResult.message || 'Sponsor role diagnostics unavailable.')
    } catch (caught) {
      setWallet(null)
      setMessage('Wallet connection not verified.')
      setError(caught instanceof Error ? caught.message : 'Could not connect to the sponsor wallet.')
    } finally {
      setBusy(null)
    }
  }

  const changeNetwork = (value: Network) => {
    setNetwork(value)
    setWallet(null)
    setRoleStatus(null)
    setLastIntent(null)
    setLastResult(null)
    setError('')
    setMessage('Network changed. Reconnect the sponsor wallet and verify the new network.')
  }

  const signAndSubmit = async () => {
    setError('')
    setLastIntent(null)
    setLastResult(null)
    setBusy('signing')
    try {
      const key = idempotencyKey.trim()
      if (key.length < 24 || key.length > 160) {
        throw new Error('Enter the reservation idempotency key (24–160 characters) from the approved operator-created request.')
      }
      if (!wallet) throw new Error('Connect and verify the sponsor wallet first.')
      const beforeSign = readInjectedWallet(network)
      if (beforeSign.address !== wallet.address) throw new Error('The connected wallet account changed. Reconnect and review the reservation.')
      const path = '/api/tron/sponsorship/transfers/' + encodeURIComponent(key)
      const prepared = await requestJson(API_BASE + path + '/signing-intent')
      if (!prepared.response.ok || prepared.payload.success !== true) {
        throw new Error(prepared.payload.message || prepared.payload.error || prepared.payload.status || ('Signing intent unavailable (HTTP ' + prepared.response.status + ').'))
      }
      const reservation = prepared.payload.reservation
      if (reservation?.network !== network) throw new Error('The reservation network does not match the selected wallet network.')
      if (reservation?.sponsorAddress !== beforeSign.address) {
        throw new Error('Connected wallet does not match the approved asset-principal sponsor. No signing request was sent to the wallet.')
      }
      setLastIntent(prepared.payload)
      setMessage('Review recipient, asset, amount and network in the wallet confirmation. Approve only if every field is correct.')
      const tronWeb = window.tronWeb || window.tronLink?.tronWeb
      if (typeof tronWeb?.trx?.sign !== 'function') throw new Error('The connected wallet does not expose TronWeb transaction signing.')
      const signedTransaction = await tronWeb.trx.sign(prepared.payload.transaction)
      if (!signedTransaction || !Array.isArray(signedTransaction.signature) || signedTransaction.signature.length === 0) {
        throw new Error('The wallet returned no transaction signature. Nothing will be broadcast.')
      }
      const afterSign = readInjectedWallet(network)
      if (afterSign.address !== beforeSign.address || afterSign.host !== beforeSign.host) {
        throw new Error('The connected wallet or network changed after signing. The backend will not broadcast this transaction.')
      }
      if (String(signedTransaction.raw_data_hex || '').toLowerCase()
        !== String(prepared.payload.transaction?.raw_data_hex || '').toLowerCase()
        || String(signedTransaction.txID || '').toLowerCase()
        !== String(prepared.payload.transaction?.txID || '').toLowerCase()) {
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
        : 'The testnet node accepted the signed transaction. It is not yet verified as solidified or credited to the receiver.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The sponsor signing/submission request failed.')
      setMessage('No successful submission was confirmed. Check the exact reservation/txid status before retrying.')
    } finally {
      setBusy(null)
    }
  }

  const globalProductionEnabled = serverStatus?.enabled === true
    && serverStatus?.canSubmitSponsoredTransfer === true
    && serverStatus?.mainnetEnabled === true
  const feeRole = roleStatus?.roles?.networkFeeSponsor
  const assetRole = roleStatus?.roles?.assetPrincipalSponsor
  const delegation = roleStatus?.feeSponsorDelegationToPrincipal
  const assetTokens: ApiPayload[] = Array.isArray(assetRole?.tokens) ? assetRole.tokens : []

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
            </div>
            <button type="button" className="sponsor-console-button sponsor-console-button--quiet" onClick={() => { void refreshServerStatus(); void refreshSponsorRoles(network) }} disabled={busy !== null}><RefreshCw size={15} aria-hidden="true" /> Recheck</button>
          </section>

          {roleStatus && <section className="sponsor-console-card">
            <div className="sponsor-console-step"><span>LIVE</span><div><h2>Live sponsor-role diagnostics</h2><p>Automatically reloaded after wallet connection. These are read-only chain observations, not authorization or final fee settlement.</p></div></div>
            <div className="sponsor-console-detail"><span>Network / checked at</span><strong>{roleStatus.network} · {roleStatus.checkedAt ? new Date(roleStatus.checkedAt).toLocaleTimeString() : 'timestamp unavailable'}</strong></div>
            <div className="sponsor-console-detail"><span>Fee sponsor</span><strong>{feeRole?.status || 'not verified'} · {feeRole?.native?.status === 'verified' ? String(feeRole.native.balanceTRX) + ' TRX' : 'native balance not verified'}</strong></div>
            <div className="sponsor-console-detail"><span>Fee sponsor resources</span><strong>{feeRole?.resourceStatus?.resourceRead === true ? String(feeRole.resourceStatus.currentlyAvailableEnergy ?? 'unknown') + ' energy / ' + String(feeRole.resourceStatus.currentlyAvailableBandwidth ?? 'unknown') + ' bandwidth' : 'resources not verified'}</strong></div>
            <div className="sponsor-console-detail"><span>Asset-principal sponsor</span><strong>{assetRole?.status || 'not verified'} · {assetRole?.native?.status === 'verified' ? String(assetRole.native.balanceTRX) + ' TRX' : 'native balance not verified'}</strong></div>
            <div className="sponsor-console-detail"><span>Token balances</span><strong>{assetTokens.length > 0 ? assetTokens.map((token: ApiPayload) => token.asset + ': ' + (token.status === 'verified' ? String(token.balanceBaseUnits) + ' base units' : 'not verified')).join(' · ') : 'not verified'}</strong></div>
            <div className="sponsor-console-detail"><span>Fee-to-principal delegation</span><strong>{delegation?.status || 'not verified'} · {delegation?.success === true ? 'observed' : 'not confirmed'}</strong></div>
            <div className="sponsor-console-result-note">Configured accounts: {roleStatus.accountsConfigured === true ? 'both present' : 'incomplete'}; distinct roles: {roleStatus.configuredAddressesDistinct === true ? 'verified' : 'not verified'}. A positive balance or delegation is not proof of a funded agreement, transaction authorization, final fee consumption, or recipient credit.</div>
          </section>}

          <section className="sponsor-console-card">
            <div className="sponsor-console-step"><span>01</span><div><h2>Connect sponsor wallet</h2><p>Use the wallet that owns the asset-principal sponsor address on the same testnet.</p></div></div>
            <label className="sponsor-console-label" htmlFor="sponsor-network">TRON testnet</label>
            <select id="sponsor-network" value={network} onChange={event => changeNetwork(event.target.value as Network)} disabled={busy !== null}>
              <option value="nile">Nile testnet</option>
              <option value="shasta">Shasta testnet</option>
            </select>
            <div className="sponsor-console-actions">
              <button type="button" className="sponsor-console-button" onClick={() => void connectWallet()} disabled={busy !== null}><Wallet size={16} aria-hidden="true" /> {busy === 'connecting' ? 'Connecting…' : 'Connect TronLink'}</button>
              <span className={wallet && wallet.network === network ? 'sponsor-console-pill sponsor-console-pill--ok' : 'sponsor-console-pill'}>{wallet && wallet.network === network ? 'Network verified' : 'Not connected'}</span>
            </div>
            {wallet && <div className="sponsor-console-wallet"><span>Connected address</span><code>{wallet.address}</code><span>Node: {wallet.host} · checked {new Date(wallet.checkedAt).toLocaleTimeString()}</span></div>}
          </section>

          <section className="sponsor-console-card">
            <div className="sponsor-console-step"><span>02</span><div><h2>Load approved reservation</h2><p>This must be an operator-created reservation for an active, funded testnet budget. A display-only balance or UI draft is not enough.</p></div></div>
            <label className="sponsor-console-label" htmlFor="sponsor-intent-key">Reservation idempotency key</label>
            <input id="sponsor-intent-key" value={idempotencyKey} onChange={event => setIdempotencyKey(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste the approved 24+ character reservation key" maxLength={160} />
            <p className="sponsor-console-field-note">Treat this as a request reference. Never paste a seed phrase, private key, API key or signing secret.</p>
            <button type="button" className="sponsor-console-button sponsor-console-button--primary" onClick={() => void signAndSubmit()} disabled={busy !== null || !wallet || idempotencyKey.trim().length < 24}><LockKeyhole size={16} aria-hidden="true" /> {busy === 'signing' ? 'Checking, signing and submitting…' : 'Review, sign and submit testnet transfer'}</button>
          </section>

          {lastIntent?.reservation && <section className="sponsor-console-card">
            <div className="sponsor-console-step"><span>03</span><div><h2>Prepared intent</h2><p>The transaction is prepared by the backend and checked against the reservation before it is signed.</p></div></div>
            <div className="sponsor-console-detail"><span>Network</span><strong>{lastIntent.reservation.network}</strong></div>
            <div className="sponsor-console-detail"><span>Sponsor signer</span><code>{lastIntent.reservation.sponsorAddress}</code></div>
            <div className="sponsor-console-detail"><span>Receiver</span><code>{lastIntent.reservation.receiverAddress}</code></div>
            <div className="sponsor-console-detail"><span>Asset / base units</span><strong>{lastIntent.reservation.asset} · {lastIntent.reservation.amountBaseUnits}</strong></div>
            {lastIntent.reservation.tokenContract && <div className="sponsor-console-detail"><span>Token contract</span><code>{lastIntent.reservation.tokenContract}</code></div>}
            <div className="sponsor-console-detail"><span>Fee capacity check</span><strong>{lastIntent.feeResourceDelegation?.resourceCapacityPreflightPassed ? 'Live capacity preflight passed; final fees not reconciled' : 'Not verified'}</strong></div>
          </section>}

          {lastResult && <section className="sponsor-console-card">
            <div className="sponsor-console-step"><span>04</span><div><h2>Submission result</h2><p>Provider acceptance and chain finality are different states.</p></div></div>
            <div className="sponsor-console-detail"><span>Status</span><strong>{lastResult.status || lastResult.error || 'No status returned'}</strong></div>
            {lastResult.transactionHash && <div className="sponsor-console-detail"><span>Transaction ID</span><code>{lastResult.transactionHash}</code></div>}
            <div className="sponsor-console-result-note">{lastResult.transactionBroadcast === true ? 'The node accepted this transaction. Independently check exact-network solidification, contract execution, receiver amount and fee/resource usage.' : 'No accepted broadcast was confirmed. If the outcome is unknown, check the bound transaction ID before trying another request.'}</div>
          </section>}

          <div className="sponsor-console-notice">
            <CircleAlert size={17} aria-hidden="true" />
            <div><strong>Testnet actions still move testnet assets.</strong><p>Review every field in the wallet confirmation. The backend accepts only Shasta/Nile, but node acceptance is not finality. Mainnet remains disabled until security review, settlement reconciliation, audited funding, and end-to-end evidence are complete.</p></div>
          </div>
          {error && <div className="sponsor-console-error" role="alert">{error}</div>}
          <p className="sponsor-console-status" role="status"><CheckCircle2 size={15} aria-hidden="true" /> {message}</p>
          <footer className="sponsor-console-footer"><span>No private keys leave the sponsor wallet.</span><a href="https://developers.tron.network/docs/api-signature-and-broadcast-flow" target="_blank" rel="noreferrer">TRON signing and broadcast model <ExternalLink size={13} aria-hidden="true" /></a></footer>
        </main>
      </div>
    </div>
  )
}
