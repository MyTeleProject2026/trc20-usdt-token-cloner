import { MAINNET_ACTIONS, readMainnetActionControls, writeMainnetActionControls } from './mainnet-action-controls.mjs'
import { useCallback, useEffect, useState } from 'react'

const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const RESOURCE_API = String(import.meta.env?.VITE_RESOURCE_API_BASE_URL || 'https://tron-transfer-resource-api.onrender.com').replace(/\/+$/, '')

export default function OwnerSettings() {
  const [controls, setControls] = useState(() => readMainnetActionControls())
  const [providerState, setProviderState] = useState({ loading: false, resource: null, promo: null, error: '' })
  const refreshProviderState = useCallback(async () => {
    setProviderState(current => ({ ...current, loading: true, error: '' }))
    const query = '?address=' + encodeURIComponent(OWNER) + '&refresh=1'
    const [resourceResult, promoResult] = await Promise.allSettled([
      fetch(RESOURCE_API + '/api/tron/resources/free-delegation/status' + query, { cache: 'no-store' }).then(async response => {
        const body = await response.json()
        if (!response.ok || body?.success !== true) throw new Error(body?.message || body?.status || 'Mainnet delegation status unavailable')
        return body
      }),
      fetch(RESOURCE_API + '/api/tron/tenergy/promo?address=' + encodeURIComponent(OWNER), { cache: 'no-store' }).then(async response => {
        const body = await response.json()
        if (!response.ok || body?.success !== true) throw new Error(body?.message || body?.error || 'TEnergy promotion status unavailable')
        return body
      }),
    ])
    setProviderState({ loading: false, resource: resourceResult.status === 'fulfilled' ? resourceResult.value : null, promo: promoResult.status === 'fulfilled' ? promoResult.value : null, error: [resourceResult, promoResult].filter(result => result.status === 'rejected').map(result => result.reason?.message || 'Provider status unavailable').join(' · ') })
  }, [])
  useEffect(() => { refreshProviderState() }, [refreshProviderState])
  function update(id, enabled) {
    setControls(current => writeMainnetActionControls({ ...current, [id]: enabled }))
  }
  return <section className="trax-panel" aria-labelledby="owner-settings-title">
    <div className="trax-section-heading">
      <div><span className="trax-kicker">TRON MAINNET · LOCAL ACTION PERMISSIONS</span><h2 id="owner-settings-title">Owner action controls</h2>
      <p>Individually allow or block sensitive application actions. These switches are local workspace controls, not blockchain permissions or resource grants.</p></div>
    </div>
    <div className="trax-settings-list">
      {MAINNET_ACTIONS.map(action => <label className="trax-settings-row" key={action.id}>
        <span><strong>{action.label}</strong><small>{action.description}</small></span>
        <input type="checkbox" role="switch" checked={controls[action.id]} onChange={event => update(action.id, event.target.checked)} aria-label={action.label}/>
      </label>)}
    </div>
    <div className="trax-settings-provider" aria-live="polite">
      <div className="trax-section-heading">
        <div><h3>Resource providers &amp; delegation</h3><p>Live read-only status for the configured owner. Provider availability is not a resource grant.</p></div>
        <button type="button" className="outline-button" onClick={refreshProviderState} disabled={providerState.loading}>{providerState.loading ? 'Refreshing…' : 'Refresh provider status'}</button>
      </div>
      <div className="trax-settings-row"><span><strong>Energy sponsor</strong><small>{providerState.resource?.policy?.sponsorAccountConfigured ? 'Sponsor account configured' : 'No sponsor account configured'}</small></span><b>{providerState.resource?.policy?.sponsorAccountConfigured ? 'Configured' : 'Unavailable'}</b></div>
      <div className="trax-settings-row"><span><strong>Paid Energy rental</strong><small>Paid rental fallback is not enabled in the current resource policy.</small></span><b>{providerState.resource?.policy?.paidRentalEnabled ? 'Enabled' : 'Disabled'}</b></div>
      <div className="trax-settings-row"><span><strong>Free Bandwidth</strong><small>Protocol free Bandwidth is read from the live Mainnet account resource snapshot.</small></span><b>{providerState.resource?.success ? 'On-chain read' : 'Unknown'}</b></div>
      <div className="trax-settings-row"><span><strong>Inbound delegated Energy</strong><small>{providerState.resource?.success ? String(providerState.resource.inboundDelegations?.count ?? 0) + ' delegation record(s) found' : 'Awaiting a successful Mainnet resource read'}</small></span><b>{providerState.resource?.success ? 'Read' : 'Unavailable'}</b></div>
      <div className="trax-settings-row"><span><strong>TEnergy promotion</strong><small>{providerState.promo?.promo?.state || providerState.promo?.terms?.state || 'Status not confirmed'} · {providerState.promo?.redemption?.status || 'no redemption status'}</small></span><b>{providerState.promo?.success ? 'Provider response' : 'Unknown'}</b></div>
      {providerState.error && <p className="trax-settings-note" role="status">{providerState.error}</p>}
      <p className="trax-settings-note">A provider response or promotion eligibility is not proof of usable Energy. Deployment readiness only counts fresh on-chain resources and independently verified delegation. No paid rental or sponsor is activated by this screen.</p>
    </div>
    <div className="trax-state-banner">
      <b>Non-bypassable Mainnet safeguards</b>
      <span>These switches cannot override owner/network matching, live Energy and Bandwidth checks, zero-TRX-burn policy, fee limits, transaction integrity, TronLink approval, solidified receipts or contract verification. Turning signing or broadcasting off blocks the corresponding operation; turning it on only permits the normal checks to run.</span>
    </div>
    <p className="trax-settings-note">Resource acquisition remains conditional on an actual provider offer, owner eligibility and confirmed on-chain delegation. No free Energy, Bandwidth sponsorship or TRX balance is created by enabling a switch.</p>
  </section>
}
