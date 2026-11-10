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
  'fincra-api-authentication-not-verified': 'Fincra API credentials have not been authenticated against the business profile.',
  'fincra-business-id-not-matched-to-api-profile': 'The configured Fincra business ID does not match the authenticated API profile.',
  'sponsor-fincra-usdt-account-funding-not-verified': 'No positive, readable USDT balance has been verified in the exact sponsor Fincra business account.',
  'sponsor-standing-fincra-mandate-not-independently-authorized': 'The sponsor standing mandate has not been independently reviewed and authorized.',
  'fincra-live-stablecoin-payout-approval-not-verified': 'Fincra has not independently confirmed live USDT TRC20 payout access for this business account.',
  'fincra-fee-and-exact-beneficiary-amount-policy-not-verified': 'Payout fees and the exact amount received by the beneficiary have not been validated.',
  'production-payout-and-chain-reconciliation-not-enabled': 'Production submission and independent TRON settlement reconciliation remain disabled.',
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
  const fincra = result?.fincra
  const blockers = Array.isArray(readiness?.blockers) ? readiness.blockers : []
  const ownerDepositNotRequired = result?.funding?.ownerDepositRequired === false
  const ownerWalletPrincipalNotRequired = result?.funding?.ownerWalletPrincipalRequired === false

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
          <b>Fincra account diagnostics are separate from payout authorization</b>
          <p>The platform will not ask you to deposit USDT or TRX. A sponsor organization must authorize the exact Fincra business account and hold spendable USDT in that account. A displayed account balance is sponsor business funds; it is not Fincra-donated liquidity or a credit facility. Live payouts remain disabled until Fincra and the sponsor have independently approved the arrangement.</p>
        </div>
      </div>

      {error && <div className="notice notice-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}

      <div className="recipient-balance-grid">
        <article className="metric-card"><span>Platform access</span><strong>Private owner-only</strong></article>
        <article className="metric-card"><span>Asset / network</span><strong>USDT · TRON Mainnet</strong></article>
        <article className="metric-card"><span>Your deposit required</span><strong>{ownerDepositNotRequired ? 'No' : 'Not verified'}</strong></article>
        <article className="metric-card"><span>Your wallet principal required</span><strong>{ownerWalletPrincipalNotRequired ? 'No' : 'Not verified'}</strong></article>
        <article className="metric-card"><span>Fincra API profile</span><strong>{fincra?.apiAuthenticated ? 'Authenticated' : 'Not verified'}</strong></article>
        <article className="metric-card"><span>Fincra business ID</span><strong>{fincra?.businessIdMatches ? 'Matched' : 'Not verified'}</strong></article>
        <article className="metric-card"><span>Sponsor account USDT</span><strong>{fincra?.availableUsdtBalance != null ? `${fincra.availableUsdtBalance} USDT` : 'Not verified'}</strong></article>
        <article className="metric-card"><span>Real payout execution</span><strong>{readiness?.executionEnabled ? 'Provider approved' : 'Disabled'}</strong></article>
      </div>

      <div className="sponsor-funding-destination">
        <div className="section-heading">
          <div><span className="eyebrow">FYSTACK · READ-ONLY PROVIDER OBSERVATION</span><h3>{result?.fystack?.status === 'wallet-identity-observed' ? 'FYStack wallet identity observed' : 'FYStack funding evidence not verified'}</h3></div>
          <span className="fine-print">{result?.fystack?.configured ? 'API configuration detected' : 'API configuration missing'}</span>
        </div>
        <div className="recipient-balance-grid">
          <article className="metric-card"><span>Configured MPC wallet</span><strong>{result?.fystack?.wallet?.name || 'Not matched'}</strong></article>
          <article className="metric-card"><span>Wallet type</span><strong>{result?.fystack?.wallet?.walletType || 'Unknown'}</strong></article>
          <article className="metric-card"><span>Displayed wallet value</span><strong>{result?.fystack?.wallet?.displayedValueUsd != null ? '<h3>{busy ? 'Checking readiness…' : readiness?.status === 'provider-payout-ready' ? 'Provider readiness passed' : 'Requirements not yet satisfied'}</h3></div>
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
        <h3>Fincra account and sponsor funding checks</h3>
        <div className="history-item"><div className="history-icon incoming"><ShieldCheck size={17} /></div><div className="history-main"><b>Authenticated business account</b><small>{fincra?.apiAuthenticated ? 'The server authenticated with Fincra.' : 'Fincra API credentials are not verified.'} {fincra?.businessIdMatches ? 'The business ID matches the authenticated profile.' : 'The business ID/profile match is not verified.'}</small></div></div>
        <div className="history-item"><div className="history-icon incoming"><Wallet size={17} /></div><div className="history-main"><b>Sponsor-owned Fincra USDT balance</b><small>{fincra?.usdtWalletFound && fincra?.availableUsdtBalance != null ? `${fincra.availableUsdtBalance} USDT available in the configured sponsor business account (${fincra.mode || 'unknown'} environment).` : 'No available USDT balance has been verified in the configured Fincra business account.'} This is money already held by that sponsor account, not free provider funding.</small></div></div>
        <div className="history-item"><div className="history-icon incoming"><ShieldCheck size={17} /></div><div className="history-main"><b>Provider-approved credit facility</b><small>A credit line is recognized only when Fincra has explicitly approved a documented facility for this sponsor account. No credit is assumed by this integration.</small></div></div>
      </div>

      <p className="fine-print">This release performs read-only account diagnostics and contains a gated sandbox adapter foundation. It does not submit a production payout. An authenticated API key, a sponsor-account balance, a signed mandate, or a Fincra “processing” response is not proof of a settled transfer. Production stays disabled until account eligibility, sponsor authorization, funding, fees, provider settlement and solidified official USDT Transfer evidence are independently verified.</p>
    </section>
  )
}
 + result.fystack.wallet.displayedValueUsd : 'Unavailable'}</strong></article>
          <article className="metric-card"><span>Workspace USDT total</span><strong>{result?.fystack?.workspaceUsdt?.totalBalance ?? 'Unavailable'}</strong></article>
          <article className="metric-card"><span>Wallet available USDT</span><strong>Not verified</strong></article>
          <article className="metric-card"><span>Held USDT</span><strong>Not verified</strong></article>
        </div>
        <p className="fine-print">Workspace totals aggregate across wallets and networks. Wallet display value is not a spendable USDT balance. FYStack wallet-level available/held balance, approved credit, provider-owned payout liquidity and payout authorization remain unverified. No ledger credit or transfer is created by these observations.</p>
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
        <h3>Fincra account and sponsor funding checks</h3>
        <div className="history-item"><div className="history-icon incoming"><ShieldCheck size={17} /></div><div className="history-main"><b>Authenticated business account</b><small>{fincra?.apiAuthenticated ? 'The server authenticated with Fincra.' : 'Fincra API credentials are not verified.'} {fincra?.businessIdMatches ? 'The business ID matches the authenticated profile.' : 'The business ID/profile match is not verified.'}</small></div></div>
        <div className="history-item"><div className="history-icon incoming"><Wallet size={17} /></div><div className="history-main"><b>Sponsor-owned Fincra USDT balance</b><small>{fincra?.usdtWalletFound && fincra?.availableUsdtBalance != null ? `${fincra.availableUsdtBalance} USDT available in the configured sponsor business account (${fincra.mode || 'unknown'} environment).` : 'No available USDT balance has been verified in the configured Fincra business account.'} This is money already held by that sponsor account, not free provider funding.</small></div></div>
        <div className="history-item"><div className="history-icon incoming"><ShieldCheck size={17} /></div><div className="history-main"><b>Provider-approved credit facility</b><small>A credit line is recognized only when Fincra has explicitly approved a documented facility for this sponsor account. No credit is assumed by this integration.</small></div></div>
      </div>

      <p className="fine-print">This release performs read-only account diagnostics and contains a gated sandbox adapter foundation. It does not submit a production payout. An authenticated API key, a sponsor-account balance, a signed mandate, or a Fincra “processing” response is not proof of a settled transfer. Production stays disabled until account eligibility, sponsor authorization, funding, fees, provider settlement and solidified official USDT Transfer evidence are independently verified.</p>
    </section>
  )
}
