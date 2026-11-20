import { useCallback, useEffect, useState } from 'react'
import { Activity, Gauge, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'
import './sponsor-console.css'

const API = String(import.meta.env.VITE_RESOURCE_API_URL || 'https://tron-transfer-resource-api.onrender.com').replace(/\/$/, '')

function Metric({ label, value, suffix = '' }) {
  return <article className="sponsor-metric"><span>{label}</span><strong>{value ?? '—'}{suffix}</strong></article>
}

export default function SponsorConsole() {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setBusy(true); setError('')
    try {
      const response = await fetch(`${API}/api/tron/sponsor/status`, { headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(`Sponsor API returned HTTP ${response.status}`)
      const result = await response.json()
      if (!result.success) throw new Error('Sponsor status could not be loaded.')
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load Sponsor status.')
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])
  const sponsor = data?.sponsor
  const resources = sponsor?.resources
  const caps = data?.capabilities

  return <section className="sponsor-console" aria-labelledby="sponsor-title">
    <div className="sponsor-console-heading">
      <div><span className="sponsor-eyebrow">INDEPENDENT RESOURCE PROVIDER · TRON MAINNET</span><h2 id="sponsor-title">TRON TRANSFER Sponsor</h2><p>Dedicated Sponsor account status, staking limits and resource delegation readiness.</p></div>
      <button type="button" onClick={refresh} disabled={busy}><RefreshCw size={15}/> {busy ? 'Refreshing…' : 'Refresh Mainnet'}</button>
    </div>
    {error && <p className="sponsor-error" role="alert">{error}</p>}
    <div className="sponsor-metrics">
      <Metric label="Sponsor TRX balance" value={sponsor?.account?.trx?.toFixed(6)} suffix=" TRX"/>
      <Metric label="Energy available" value={resources ? Math.max(0, resources.energyLimit - resources.energyUsed).toLocaleString() : null}/>
      <Metric label="Free Bandwidth" value={resources ? Math.max(0, resources.freeNetLimit - resources.freeNetUsed).toLocaleString() : null}/>
      <Metric label="Staked Bandwidth" value={resources ? Math.max(0, resources.netLimit - resources.netUsed).toLocaleString() : null}/>
    </div>
    <div className="sponsor-panels">
      <article><h3><Wallet size={17}/> Wallet identities</h3><p>Sponsor: <code>{sponsor?.account?.address || 'Not configured'}</code></p><p>Owner recipient: <code>{data?.owner?.address || 'Not configured'}</code></p><p>Network: <strong>{data?.network || 'Checking…'}</strong></p></article>
      <article><h3><Gauge size={17}/> Stake 2.0 limits</h3><p>Protocol minimum: <strong>{data?.limits?.minimumStakeTrx ?? 1} TRX per operation</strong></p><p>Automatic stake ceiling: <strong>{data?.limits?.maximumAutomaticStakeTrx ?? 10} TRX</strong></p><p>Protected liquid reserve: <strong>{data?.limits?.protectedLiquidReserveTrx ?? 2} TRX</strong></p><p>Automatic unstaking: <strong>Disabled</strong></p></article>
      <article><h3><ShieldCheck size={17}/> Signing readiness</h3><p>Server signer: <strong>{caps?.serverSignerConfigured ? 'Configured' : 'Not configured'}</strong></p><p>Admin authorization: <strong>{caps?.adminAuthorizationConfigured ? 'Configured' : 'Not configured'}</strong></p><p>Transaction engine: <strong>{caps?.stakingEnabled ? 'Configured · activation gated' : 'Disabled'}</strong></p><p className="sponsor-warning">{caps?.reason || 'Readiness is being checked.'}</p></article>
    </div>
    <div className="sponsor-actions">
      <button type="button" disabled title="Requires the reviewed server-side Stake 2.0 signer">Stake for Energy</button>
      <button type="button" disabled title="Requires the reviewed server-side Stake 2.0 signer">Stake for Bandwidth</button>
      <button type="button" disabled title="Requires verified staking and authenticated delegation service">Delegate to Owner</button>
      <button type="button" disabled title="Automatic unstaking is intentionally disabled">Unstake / Reclaim</button>
    </div>
    <p className="sponsor-footnote"><Activity size={14}/> This page currently displays live, read-only Mainnet account resources. It does not claim to stake, purchase, or delegate resources. Transaction controls remain disabled until server-side signing, admin authorization, transaction simulation, and audit protections are completed.</p>
  </section>
}
