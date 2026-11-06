import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\/+$/, '')

async function loadReadiness(sessionToken) {
  const response = await fetch(API_BASE + '/api/tron-transfer/provider-readiness', {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + sessionToken },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
  })
  const body = await response.json().catch(() => null)
  if (!body || typeof body !== 'object') throw new Error('Provider readiness returned an unreadable response.')
  if (!response.ok || body.success !== true) {
    throw new Error(body.message || body.error || 'Provider readiness could not be verified.')
  }
  return body
}

const blockerLabels = {
  'no-provider-selected': 'No payout provider has been approved for this private owner account.',
  'provider-authorization-not-verified': 'No provider has verified authorization to pay on your behalf.',
  'provider-api-authentication-not-verified': 'No approved provider API connection has been authenticated.',
  'provider-usdt-tron-mainnet-support-not-verified': 'USDT TRON Mainnet payout support has not been verified for an approved provider.',
  'provider-live-payouts-not-enabled': 'No provider has enabled live USDT TRON Mainnet payouts for this account.',
  'provider-owned-liquidity-or-approved-credit-not-verified': 'No provider-owned USDT liquidity or approved credit facility has been verified.',
  'network-fee-coverage-not-verified': 'TRON network-fee coverage has not been verified.',
  'approved-provider-broadcast-adapter-not-installed': 'A provider-specific, security-reviewed payout adapter is not installed.',
}

export default function ProviderPayoutReadiness({ ownerSession, mode = 'withdraw' }) {
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function refresh() {
    if (!ownerSession?.sessionToken) {
      setResult(null)
      setError('Sign in with the configured platform-owner account to inspect provider readiness.')
      return
    }
    setBusy(true)
    setError('')
    try {
      setResult(await loadReadiness(ownerSession.sessionToken))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Provider readiness could not be checked.')
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    let active = true
    if (!ownerSession?.sessionToken) {
      setResult(null)
      setError('Sign in with the configured platform-owner account to inspect provider readiness.')
      return () => { active = false }
    }
    setBusy(true)
    setError('')
    loadReadiness(ownerSession.sessionToken)
      .then((value) => { if (active) setResult(value) })
      .catch((cause) => { if (active) { setResult(null); setError(cause instanceof Error ? cause.message : 'Provider readiness could not be checked.') } })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [ownerSession?.sessionToken])

  const readiness = result?.readiness
  const blockers = Array.isArray(readiness?.blockers) ? readiness.blockers : []

  return (
    <section className="panel owner-withdrawals-page provider-payout-page">
      <div className="section-heading">
        <div>
          <span className="eyebrow">PRIVATE OWNER ACCOUNT · EXTERNAL FUNDING</span>
          <h2>{mode === 'history' ? 'Provider payout status' : 'External USDT TRC20 payout availability'}</h2>
          <p>Only the configured platform owner can inspect or operate this payout workspace. Your TronLink wallet is not treated as the source of payout funds.</p>
        </div>
        <div className="panel-icon"><ShieldCheck /></div>
      </div>

      <div className="notice notice-warning">
        <AlertTriangle size={17} />
        <div>
          <b>External funding is not connected</b>
          <p>The platform will not ask you to deposit USDT or TRX. A provider must expressly agree to supply provider-owned USDT liquidity or an approved credit facility, authorize your account, and support genuine USDT TRON Mainnet payouts. No provider has been verified for those conditions yet.</p>
        </div>
      </div>

      {error && <div className="notice notice-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}

      <div className="recipient-balance-grid">
        <article className="metric-card"><span>Platform access</span><strong>Private owner-only</strong></article>
        <article className="metric-card"><span>Asset / network</span><strong>USDT · TRON Mainnet</strong></article>
        <article className="metric-card"><span>Your deposit required</span><strong>No</strong></article>
        <article className="metric-card"><span>Real payout execution</span><strong>{readiness?.executionEnabled ? 'Provider approved' : 'Disabled'}</strong></article>
      </div>

      <div className="sponsor-funding-destination">
        <div className="section-heading">
          <div><span className="eyebrow">FUNDING AND AUTHORIZATION CHECKS</span><h3>{busy ? 'Checking readiness…' : readiness?.status === 'provider-payout-ready' ? 'Provider readiness passed' : 'Requirements not yet satisfied'}</h3></div>
          <button className="secondary-button" disabled={busy || !ownerSession?.sessionToken} onClick={() => void refresh()}><RefreshCw size={15} /> Refresh</button>
        </div>
        {readiness?.executionEnabled
          ? <div className="notice notice-success"><CheckCircle2 size={16} /><span>All provider funding and execution checks passed. This page still does not initiate a transfer.</span></div>
          : <div className="empty-state"><Wallet size={24} /><b>No approved payout funding source</b><p>The API directory and a provider API description are not proof of an account, available liquidity, or a credit agreement.</p></div>}
        {blockers.length > 0 && <ul className="fine-print provider-blocker-list">
          {blockers.map((blocker) => <li key={blocker}>{blockerLabels[blocker] || blocker}</li>)}
        </ul>}
      </div>

      <div className="sponsor-funding-destination">
        <h3>Funding arrangements this platform can recognize</h3>
        <div className="history-item"><div className="history-icon incoming"><ShieldCheck size={17} /></div><div className="history-main"><b>Provider-owned liquidity</b><small>The provider contractually authorizes this owner account to use its own available USDT pool for approved withdrawals.</small></div></div>
        <div className="history-item"><div className="history-icon incoming"><ShieldCheck size={17} /></div><div className="history-main"><b>Provider-approved credit facility</b><small>The provider grants a documented credit limit and authorizes settlement under its own risk and compliance checks.</small></div></div>
      </div>

      <p className="fine-print">A wallet connection, API catalogue entry, gas sponsorship feature, or displayed balance is not sufficient authorization. No request is submitted and no status is marked submitted or confirmed until a real provider adapter is approved and actual settlement evidence is verified on TRON Mainnet.</p>
    </section>
  )
}
