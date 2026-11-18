import { useCallback, useState } from 'react'
import { Handshake, RefreshCw, Copy, Download, ShieldCheck, AlertTriangle } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\/+$/, '')
const OWNER_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

async function readResourceStatus(address) {
  const url = new URL(API_BASE + '/api/tron/resources/claims/readiness')
  url.searchParams.set('address', address)
  url.searchParams.set('refresh', '1')
  const response = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store', redirect: 'error' })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.success) throw new Error(body?.message || body?.error || 'Could not retrieve Mainnet resource readiness.')
  return body
}

function safeJson(value) {
  return JSON.stringify(value, null, 2)
}

export default function ResourceSponsorCenter({ wallet }) {
  const [snapshot, setSnapshot] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sponsorContact, setSponsorContact] = useState('')
  const address = wallet?.address || OWNER_ADDRESS

  const refresh = useCallback(async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await readResourceStatus(address)
      setSnapshot(result)
      setNotice('Live resource observations refreshed. Provider discovery is read-only; no grant or delegation has been requested.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Resource observation failed.')
    } finally { setBusy(false) }
  }, [address])

  const request = snapshot ? {
    title: 'TRON Mainnet Energy and Bandwidth sponsorship request',
    generatedAt: new Date().toISOString(),
    network: 'TRON Mainnet',
    beneficiaryWallet: address,
    purpose: 'One-time TRX token smart-contract deployment; sponsor is requested to delegate resources only, not to receive wallet credentials or ownership.',
    resourceObservation: {
      checkedAt: snapshot.checkedAt,
      status: snapshot.status,
      ownerResourceSnapshot: snapshot.checks?.ownerResourceSnapshot || 'unavailable',
      resourceSnapshot: snapshot.resourceSnapshot || null,
      providerReadiness: snapshot.providerReadiness || null,
      providerDiscovery: snapshot.publicProviderDiscovery || null,
    },
    requestedSponsorActions: [
      'Review the exact deployment transaction and fresh Energy/Bandwidth simulation before agreeing.',
      'If willing, use the sponsor-controlled wallet to delegate the required resources to the beneficiary address.',
      'Provide the delegation transaction ID and the resource amount/duration; the beneficiary independently verifies the delegation on TRON Mainnet.',
    ],
    safeguards: [
      'No private key, seed phrase, password, or wallet connection is requested from the beneficiary.',
      'No TRX or other payment is authorized by this request.',
      'No sponsor consent or funding is assumed; this request is not a reservation or grant.',
      'The sponsor retains control of its wallet and must approve every delegation transaction.',
      'The owner must separately approve the deployment transaction in TronLink.',
    ],
    limitations: [
      'A provider discovery response is not a grant.',
      'TEnergy public resource/health APIs are read-only and do not grant Energy or Bandwidth.',
      'The request must be reviewed and voluntarily accepted by a real sponsor.',
      'If sponsor resources are unavailable, deployment remains blocked unless an independently funded alternative is authorized.',
    ],
  } : null

  async function copyRequest() {
    if (!request) return
    try { await navigator.clipboard.writeText(safeJson(request)); setNotice('Sponsorship request copied. Send it directly to a sponsor you have independently vetted.') }
    catch { setError('Clipboard access is unavailable. Download the request JSON instead.') }
  }

  function downloadRequest() {
    if (!request) return
    const blob = new Blob([safeJson(request)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = 'tron-mainnet-resource-sponsorship-request.json'
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url)
    setNotice('Request downloaded. No sponsor has been contacted automatically.')
  }

  return <section className="trax-mainnet-panel" aria-labelledby="resource-sponsor-title">
    <div className="trax-panel-heading"><div><span className="trax-kicker">MAINNET RESOURCE SPONSORSHIP</span><h2 id="resource-sponsor-title">Sponsor Connection Center</h2><p>Prepare a verifiable request for a person or organization willing to delegate Energy and Bandwidth to your owner wallet.</p></div><Handshake size={28}/></div>
    <div className="trax-owner-card"><strong>Beneficiary wallet</strong><p>{address}</p><small>{wallet ? 'Connected wallet address. Resource delegation does not transfer token ownership.' : 'Configured owner address. Connect TronLink to confirm the active account before deployment.'}</small></div>
    <div className="trax-panel-actions"><button type="button" onClick={refresh} disabled={busy}><RefreshCw size={15}/>{busy ? 'Refreshing…' : 'Refresh Mainnet resource observations'}</button></div>
    {error && <p role="alert" className="trax-shell-alert error"><AlertTriangle size={16}/>{error}</p>}
    {notice && <p role="status" className="trax-shell-alert">{notice}</p>}
    {snapshot && <div className="trax-readiness-card">
      <h3>Latest provider and resource observations</h3>
      <p>Checked: {snapshot.checkedAt ? new Date(snapshot.checkedAt).toLocaleString() : 'unknown'}</p>
      <p>Overall status: <strong>{snapshot.status}</strong></p>
      <ul>{Object.entries(snapshot.checks || {}).map(([key,value]) => <li key={key}>{key}: <strong>{value}</strong></li>)}</ul>
      <p>{snapshot.automaticClaim?.reason || 'Automatic grant status unavailable.'}</p>
    </div>}
    <label className="trax-field"><span>Sponsor contact reference (optional)</span><input value={sponsorContact} onChange={event => setSponsorContact(event.target.value)} maxLength={160} placeholder="Name, organization, or contact email for your own records"/></label>
    <div className="trax-panel-actions"><button type="button" disabled={!request} onClick={copyRequest}><Copy size={15}/>Copy sponsorship request</button><button type="button" disabled={!request} onClick={downloadRequest}><Download size={15}/>Download request JSON</button></div>
    <div className="trax-security-note"><ShieldCheck size={18}/><p><strong>Wallet safety:</strong> This center never requests sponsor credentials, signs transactions, transfers funds, or claims a grant. The sponsor must independently approve delegation using their own wallet. Deployment remains disabled until actual Mainnet resources are verified.</p></div>
    {sponsorContact.trim() && <p className="trax-muted">Contact reference saved only in this open page; it is not sent to the server or sponsor.</p>}
  </section>
}
