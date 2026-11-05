import { useEffect, useState } from 'react'
import { Building2, FileCheck2, RefreshCw, ShieldCheck, AlertTriangle, CheckCircle2 } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\/+$/, '')

async function api(path, token, options = {}) {
  const response = await fetch(API_BASE + path, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body || body.success === false) {
    throw new Error(body?.message || body?.error || 'Sponsor organization request failed.')
  }
  return body
}

function applicationMessage(input) {
  return [
    'TRON Transfer sponsor organization application',
    'Purpose: sign the organization details and declarations only. This is not a transaction or permission to spend.',
    'Version: sponsor-organization-application-v1',
    'Network: TRON Mainnet',
    'Sponsor wallet: ' + input.wallet,
    'Organization: ' + input.organizationName,
    'Business email: ' + input.businessEmail,
    'Jurisdiction: ' + input.jurisdiction,
    'Website: ' + (input.website || 'not provided'),
    'Requested roles: ' + input.roles.join(', '),
    'Declarations: authorized representative; controls the sponsor wallet; proposed funds are lawfully controlled; agrees to separate written mandate and transaction approval; consents to application-data processing.',
  ].join('\n')
}

function mandateMessage(input) {
  return [
    'TRON Transfer sponsor payout mandate',
    'Purpose: confirm the exact limits and agreement reference below. This is not a transaction and does not itself move funds.',
    'Version: sponsor-payout-mandate-v1',
    'Network: TRON Mainnet',
    'Sponsor wallet: ' + input.wallet,
    'Organization application: ' + input.applicationId,
    'Agreement reference: ' + input.agreementReference,
    'Agreement SHA-256: ' + input.agreementDigest,
    'Purpose: ' + input.purpose,
    'Maximum per payout (USDT base units): ' + input.perPayoutBaseUnits,
    'Daily maximum (USDT base units): ' + input.dailyBaseUnits,
    'Valid from: ' + input.validFrom,
    'Valid until: ' + input.validUntil,
    'This mandate is subject to independent review and can be revoked. Every payout still requires the sponsor-authorized signing method.',
  ].join('\n')
}

function parseUnits(value) {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(String(value || ''))) {
    throw new Error('Enter a positive USDT amount with up to six decimal places.')
  }
  const [whole, fraction = ''] = String(value).split('.')
  const result = BigInt(whole) * 1000000n + BigInt((fraction + '000000').slice(0, 6))
  if (result <= 0n) throw new Error('USDT limits must be greater than zero.')
  return result.toString()
}

function fromUnits(value) {
  try {
    const n = BigInt(String(value))
    const fraction = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '')
    return (n / 1000000n).toString() + (fraction ? '.' + fraction : '')
  } catch { return '—' }
}

function defaultDate(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86400000)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

export default function SponsorOrganizationOnboarding({ wallet, identityToken, identityMatchesWallet, ownerSession }) {
  const [application, setApplication] = useState(null)
  const [mandates, setMandates] = useState([])
  const [applications, setApplications] = useState([])
  const [mandateQueue, setMandateQueue] = useState([])
  const [organizationName, setOrganizationName] = useState('')
  const [businessEmail, setBusinessEmail] = useState('')
  const [jurisdiction, setJurisdiction] = useState('')
  const [website, setWebsite] = useState('')
  const [roles, setRoles] = useState(['asset-principal', 'network-fees'])
  const [agreementReference, setAgreementReference] = useState('')
  const [agreementFile, setAgreementFile] = useState(null)
  const [purpose, setPurpose] = useState('both')
  const [perPayoutLimit, setPerPayoutLimit] = useState('')
  const [dailyLimit, setDailyLimit] = useState('')
  const [validFrom, setValidFrom] = useState(defaultDate())
  const [validUntil, setValidUntil] = useState(defaultDate(30))
  const [reviewReference, setReviewReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function refresh() {
    setError('')
    try {
      if (identityMatchesWallet && identityToken) {
        const result = await api('/api/tron/organizations/me', identityToken)
        setApplication(result.application || null)
        setMandates(Array.isArray(result.mandates) ? result.mandates : [])
      } else {
        setApplication(null)
        setMandates([])
      }
      if (ownerSession?.sessionToken) {
        const [appResult, mandateResult] = await Promise.all([
          api('/api/tron/organizations/applications', ownerSession.sessionToken),
          api('/api/tron/organizations/mandates', ownerSession.sessionToken),
        ])
        setApplications(Array.isArray(appResult.applications) ? appResult.applications : [])
        setMandateQueue(Array.isArray(mandateResult.mandates) ? mandateResult.mandates : [])
      } else {
        setApplications([])
        setMandateQueue([])
      }
    } catch (cause) {
      setError(cause?.message || 'Could not refresh organization onboarding.')
    }
  }

  useEffect(() => { void refresh() }, [identityToken, identityMatchesWallet, ownerSession?.sessionToken])

  async function submitApplication() {
    setBusy(true); setError(''); setNotice('')
    try {
      if (!identityMatchesWallet || !identityToken) throw new Error('Verify the connected sponsor wallet identity first.')
      if (!wallet?.tronWeb?.trx?.signMessageV2) throw new Error('TronLink message signing is unavailable.')
      const input = {
        wallet: wallet.address,
        organizationName: organizationName.trim(),
        businessEmail: businessEmail.trim().toLowerCase(),
        jurisdiction: jurisdiction.trim(),
        website: website.trim(),
        roles: [...roles].sort(),
      }
      const message = applicationMessage(input)
      const signature = await wallet.tronWeb.trx.signMessageV2(message)
      const result = await api('/api/tron/organizations/applications', identityToken, {
        method: 'POST',
        body: JSON.stringify({
          organizationName: input.organizationName,
          businessEmail: input.businessEmail,
          jurisdiction: input.jurisdiction,
          website: input.website,
          requestedRoles: input.roles,
          applicationSignature: signature,
        }),
      })
      setApplication(result.application)
      setNotice('Organization application submitted. It is pending due diligence and does not authorize a payout.')
      await refresh()
    } catch (cause) {
      setError(cause?.message || 'Organization application failed.')
    } finally { setBusy(false) }
  }

  async function submitMandate() {
    setBusy(true); setError(''); setNotice('')
    try {
      if (!identityMatchesWallet || !application || application.status !== 'accepted-for-due-diligence') {
        throw new Error('The organization application must first be accepted for due diligence.')
      }
      if (!agreementFile) throw new Error('Select the signed sponsorship agreement document to calculate its SHA-256 digest.')
      if (agreementFile.size > 5 * 1024 * 1024) throw new Error('Agreement file must be 5 MB or smaller.')
      const bytes = await agreementFile.arrayBuffer()
      const hash = await crypto.subtle.digest('SHA-256', bytes)
      const agreementDigest = Array.from(new Uint8Array(hash)).map((v) => v.toString(16).padStart(2, '0')).join('')
      const perPayoutBaseUnits = parseUnits(perPayoutLimit)
      const dailyBaseUnits = parseUnits(dailyLimit)
      if (BigInt(dailyBaseUnits) < BigInt(perPayoutBaseUnits)) throw new Error('Daily limit must be at least the per-payout limit.')
      const from = new Date(validFrom)
      const until = new Date(validUntil)
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(until.getTime())) throw new Error('Choose valid mandate dates.')
      const input = {
        wallet: wallet.address,
        applicationId: application.id,
        agreementReference: agreementReference.trim(),
        agreementDigest,
        purpose,
        perPayoutBaseUnits,
        dailyBaseUnits,
        validFrom: from.toISOString(),
        validUntil: until.toISOString(),
      }
      const signature = await wallet.tronWeb.trx.signMessageV2(mandateMessage(input))
      const result = await api('/api/tron/organizations/applications/' + encodeURIComponent(application.id) + '/mandates', identityToken, {
        method: 'POST',
        body: JSON.stringify({
          agreementReference: input.agreementReference,
          agreementDigest,
          purpose,
          perPayoutLimit: perPayoutLimit.trim(),
          dailyLimit: dailyLimit.trim(),
          validFrom: input.validFrom,
          validUntil: input.validUntil,
          mandateSignature: signature,
        }),
      })
      setNotice('Signed mandate submitted for independent review. Payout authorization remains disabled.')
      setAgreementFile(null)
      await refresh()
    } catch (cause) {
      setError(cause?.message || 'Sponsor mandate submission failed.')
    } finally { setBusy(false) }
  }

  async function revokeMandate(id) {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api('/api/tron/organizations/mandates/' + encodeURIComponent(id) + '/revoke', identityToken, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setNotice(result.note || 'Mandate revoked.')
      await refresh()
    } catch (cause) { setError(cause?.message || 'Mandate revocation failed.') }
    finally { setBusy(false) }
  }

  async function reviewApplication(id, decision) {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api('/api/tron/organizations/applications/' + encodeURIComponent(id) + '/review', ownerSession.sessionToken, {
        method: 'POST',
        body: JSON.stringify({ decision, reviewReference: reviewReference.trim() }),
      })
      setNotice('Application review state updated: ' + result.application.status)
      setReviewReference('')
      await refresh()
    } catch (cause) { setError(cause?.message || 'Application review failed.') }
    finally { setBusy(false) }
  }

  async function reviewMandate(id, decision) {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api('/api/tron/organizations/mandates/' + encodeURIComponent(id) + '/review', ownerSession.sessionToken, {
        method: 'POST',
        body: JSON.stringify({ decision, verificationReference: reviewReference.trim() }),
      })
      setNotice(result.note || 'Mandate review updated.')
      setReviewReference('')
      await refresh()
    } catch (cause) { setError(cause?.message || 'Mandate review failed.') }
    finally { setBusy(false) }
  }

  const rolesText = roles.includes('asset-principal') && roles.includes('network-fees')
    ? 'USDT principal and network fees'
    : roles.includes('asset-principal') ? 'USDT principal' : 'network fees'

  return (
    <section className="sponsor-organization-onboarding">
      <div className="section-heading compact">
        <div><span className="eyebrow">ORGANIZATION SPONSOR INTAKE</span><h3>External sponsor organization</h3></div>
        <button className="secondary-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} /> Refresh</button>
      </div>
      <p className="fine-print">An organization application is not proof of company identity, source of funds or authority to spend. A signed agreement must be reviewed before a mandate can be authorized. Sponsors keep control of their wallet and sign their own transfers.</p>
      {error && <div className="notice notice-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
      {notice && <div className="notice notice-success" role="status"><CheckCircle2 size={16} /><span>{notice}</span></div>}

      {!identityMatchesWallet ? (
        <p className="fine-print">Connect the proposed sponsor's TronLink wallet and verify its identity before submitting an organization application or mandate.</p>
      ) : !application ? (
        <div className="form-stack">
          <label>Organization legal name<input value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} maxLength={120} placeholder="Registered organization name" /></label>
          <label>Business contact email<input type="email" value={businessEmail} onChange={(e) => setBusinessEmail(e.target.value)} maxLength={254} placeholder="treasury@example.org" /></label>
          <label>Jurisdiction<input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} maxLength={100} placeholder="Country or state of registration" /></label>
          <label>Official website (HTTPS, optional)<input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} maxLength={300} placeholder="https://organization.example" /></label>
          <fieldset className="form-stack">
            <legend>Requested sponsorship roles</legend>
            <label><input type="checkbox" checked={roles.includes('asset-principal')} onChange={(e) => setRoles((old) => e.target.checked ? [...new Set([...old, 'asset-principal'])] : old.filter((x) => x !== 'asset-principal'))} /> USDT payout principal</label>
            <label><input type="checkbox" checked={roles.includes('network-fees')} onChange={(e) => setRoles((old) => e.target.checked ? [...new Set([...old, 'network-fees'])] : old.filter((x) => x !== 'network-fees'))} /> TRON network fees/resources</label>
          </fieldset>
          <button className="primary-button" disabled={busy || organizationName.trim().length < 2 || !businessEmail.trim() || jurisdiction.trim().length < 2 || roles.length === 0} onClick={() => void submitApplication()}><Building2 size={16} /> Sign and submit organization application</button>
        </div>
      ) : (
        <div className="owner-session-card">
          <strong><ShieldCheck size={15} /> {application.organizationName} · {application.status}</strong>
          <small>Sponsor wallet: {application.sponsorWalletAddress}</small>
          <small>Jurisdiction: {application.jurisdiction} · Roles: {rolesText}</small>
          <small>Application reference: {application.id}</small>
          <small>Organization verification: not independently verified · payout authorization: no</small>
        </div>
      )}

      {identityMatchesWallet && application?.status === 'accepted-for-due-diligence' && (
        <div className="sponsor-funding-destination">
          <h4><FileCheck2 size={16} /> Submit signed sponsorship mandate</h4>
          <p className="fine-print">Use only an agreement signed by the sponsor and the platform counterparty. The file stays in this browser; only its SHA-256 digest and reference are sent to the backend.</p>
          <label>Agreement reference<input value={agreementReference} onChange={(e) => setAgreementReference(e.target.value)} placeholder="Signed agreement reference" /></label>
          <label>Signed agreement file (PDF, maximum 5 MB)<input type="file" accept=".pdf,application/pdf" onChange={(e) => setAgreementFile(e.target.files?.[0] || null)} /></label>
          <label>Mandate purpose<select value={purpose} onChange={(e) => setPurpose(e.target.value)}><option value="asset-principal">USDT payout principal</option><option value="network-fees">Network fees/resources only</option><option value="both">USDT principal and network fees</option></select></label>
          <label>Maximum per payout (USDT)<input value={perPayoutLimit} onChange={(e) => setPerPayoutLimit(e.target.value)} inputMode="decimal" placeholder="e.g. 50" /></label>
          <label>Daily maximum (USDT)<input value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} inputMode="decimal" placeholder="e.g. 200" /></label>
          <label>Valid from<input type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} /></label>
          <label>Valid until<input type="datetime-local" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></label>
          <button className="primary-button" disabled={busy || !agreementReference.trim() || !agreementFile || !perPayoutLimit.trim() || !dailyLimit.trim()} onClick={() => void submitMandate()}><ShieldCheck size={16} /> Sign and submit mandate</button>
        </div>
      )}

      {mandates.length > 0 && (
        <div className="sponsor-funding-destination">
          <h4>Mandate history</h4>
          {mandates.map((item) => <article className="transaction-row" key={item.id}>
            <div className="transaction-main"><strong>{item.status} · {item.purpose}</strong><span>{item.agreementReference}</span><small>Per payout: {fromUnits(item.perPayoutLimitBaseUnits)} USDT · Daily: {fromUnits(item.dailyLimitBaseUnits)} USDT</small><small>Valid until: {new Date(item.validUntil).toLocaleString()}</small></div>
            {['signed-awaiting-review', 'verified', 'authorized'].includes(item.status) && <div className="transaction-actions"><button className="outline-button" disabled={busy} onClick={() => void revokeMandate(item.id)}>Revoke mandate</button></div>}
          </article>)}
        </div>
      )}

      {ownerSession?.sessionToken && (
        <div className="sponsor-funding-destination">
          <h4>Owner organization review queue</h4>
          {!applications.length ? <p className="fine-print">No organization applications awaiting review.</p> : applications.map((item) => <article className="transaction-row" key={item.id}>
            <div className="transaction-main"><strong>{item.organizationName} · {item.status}</strong><span>{item.sponsorWalletAddress}</span><small>{item.businessEmail} · {item.jurisdiction}</small><small>Roles: {item.requestedRoles.join(', ')}</small><small>Reference: {item.id}</small></div>
            <div className="transaction-actions">
              <button className="secondary-button" disabled={busy || item.status === 'in-review'} onClick={() => void reviewApplication(item.id, 'in-review')}>Mark in review</button>
              <button className="primary-button" disabled={busy} onClick={() => void reviewApplication(item.id, 'accepted-for-due-diligence')}>Accept for due diligence</button>
              <button className="outline-button" disabled={busy} onClick={() => void reviewApplication(item.id, 'declined')}>Decline</button>
            </div>
          </article>)}
          <h4>Signed sponsor mandates</h4>
          {!mandateQueue.length ? <p className="fine-print">No signed mandates awaiting owner review.</p> : mandateQueue.map((item) => <article className="transaction-row" key={item.id}>
            <div className="transaction-main"><strong>{item.status} · {item.purpose}</strong><span>{item.sponsorWalletAddress}</span><small>{item.agreementReference}</small><small>Digest: {item.agreementDigest}</small><small>Per payout: {fromUnits(item.perPayoutLimitBaseUnits)} USDT · Daily: {fromUnits(item.dailyLimitBaseUnits)} USDT</small><small>Valid until: {new Date(item.validUntil).toLocaleString()}</small></div>
            <div className="transaction-actions">
              {item.status === 'signed-awaiting-review' && <button className="secondary-button" disabled={busy} onClick={() => void reviewMandate(item.id, 'verify')}>Verify agreement evidence</button>}
              {item.status === 'verified' && <button className="primary-button" disabled={busy} onClick={() => void reviewMandate(item.id, 'authorize')}>Authorize mandate</button>}
              <button className="outline-button" disabled={busy} onClick={() => void reviewMandate(item.id, 'decline')}>Decline</button>
            </div>
          </article>)}
          <label>Owner verification reference<input value={reviewReference} onChange={(e) => setReviewReference(e.target.value)} placeholder="External evidence / case reference (8+ chars)" /></label>
          <p className="fine-print">Authorization requires the owner to have independently checked organization identity, legal authority, the signed agreement and funding-source representations. This workflow records that decision; it does not perform external KYC.</p>
        </div>
      )}
    </section>
  )
}
