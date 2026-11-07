import { useEffect, useState } from 'react'
import { FileCheck2, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\/+$/, '')
const EVIDENCE_TYPES = ['legal-entity-registration','beneficial-ownership','authorized-representative','sponsor-wallet-control','provider-account-ownership','provider-signer-policy','signed-agreement','source-of-funds','funding-balance','other']

async function api(path, token, options = {}) {
  const response = await fetch(API_BASE + path, {
    ...options,
    headers: { Accept:'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}), ...(token ? {Authorization:'Bearer '+token} : {}) },
    credentials:'omit', cache:'no-store', redirect:'error',
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body || body.success === false) throw new Error(body?.error || 'Governance API request failed.')
  return body
}

function reviewMessage(input) {
  return [
    'TRON Transfer independent sponsor evidence review',
    'Version: sponsor-evidence-review-v1',
    'Network: TRON Mainnet',
    'Application: ' + input.applicationId,
    'Mandate: ' + input.mandateId,
    'Evidence-set SHA-256: ' + input.evidenceSetDigest,
    'Decision: ' + input.decision,
    'Reviewer wallet: ' + input.reviewerWalletAddress,
    'Reviewer role: ' + input.reviewerRole,
    'Independence attested: true',
    'Conflict check passed: true',
    'Evidence review reference: ' + input.decisionEvidenceReference,
    'Decided at: ' + input.decidedAt,
    'This signature records an evidence review only. It is not a transaction, signer instruction, payout authorization or permission to spend.',
  ].join('\n')
}

function revocationMessage(input) {
  return [
    'TRON Transfer sponsor governance revocation',
    'Version: sponsor-governance-revocation-v1',
    'Application: ' + input.applicationId,
    'Scope: ' + input.scopeType,
    'Scope ID: ' + input.scopeId,
    'Mandate: ' + (input.mandateId || 'none'),
    'Actor wallet: ' + input.actorWalletAddress,
    'Actor role: ' + input.actorRole,
    'Reason: ' + input.reasonCode,
    'Emergency: ' + String(input.emergency),
    'Event reference: ' + input.eventReference,
    'Effective at: ' + input.effectiveAt,
    'This signature records a governance revocation only. It does not submit or authorize a transaction.',
  ].join('\n')
}

export default function SponsorOrganizationGovernance({ wallet }) {
  const [token, setToken] = useState('')
  const [mandateId, setMandateId] = useState('')
  const [config, setConfig] = useState(null)
  const [records, setRecords] = useState(null)
  const [evidenceType, setEvidenceType] = useState('signed-agreement')
  const [objectKey, setObjectKey] = useState('')
  const [contentSha256, setContentSha256] = useState('')
  const [mediaType, setMediaType] = useState('application/pdf')
  const [byteSize, setByteSize] = useState('')
  const [retentionPolicyReference, setRetentionPolicyReference] = useState('retention-policy-v1')
  const [reviewReference, setReviewReference] = useState('')
  const [revocationReference, setRevocationReference] = useState('')
  const [reasonCode, setReasonCode] = useState('sponsor-request')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let current = true
    setToken('')
    setRecords(null)
    setConfig(null)
    async function authenticate() {
      if (!wallet?.address || !wallet?.tronWeb?.trx?.signMessageV2) return
      try {
        const challenge = await api('/api/auth/tron/challenge', null, {method:'POST', body:JSON.stringify({address:wallet.address,network:'mainnet'})})
        const signature = await wallet.tronWeb.trx.signMessageV2(challenge.message)
        const verified = await api('/api/auth/tron/verify', null, {method:'POST', body:JSON.stringify({address:wallet.address,network:'mainnet',nonce:challenge.nonce,signature})})
        if (!current || verified.authenticated !== true || verified.address !== wallet.address || verified.network !== 'mainnet') return
        setToken(verified.sessionToken)
        setNotice('Wallet identity session established. Governance signatures do not transfer funds.')
      } catch (cause) {
        if (current) setError(cause?.message || 'Could not authenticate the connected wallet.')
      }
    }
    void authenticate()
    return () => { current = false }
  }, [wallet?.address, wallet?.tronWeb])

  async function refresh() {
    if (!token || !mandateId.trim()) throw new Error('Authenticate the wallet and enter a mandate ID first.')
    const [cfg, state] = await Promise.all([
      api('/api/tron/organizations/governance/config', token),
      api('/api/tron/organizations/mandates/' + encodeURIComponent(mandateId.trim()) + '/governance', token),
    ])
    setConfig(cfg)
    setRecords(state)
  }

  async function run(action) {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (cause) { setError(cause?.message || 'Governance action failed.') }
    finally { setBusy(false) }
  }

  async function submitEvidence() {
    await run(async () => {
      if (!token) throw new Error('Connect and authenticate the sponsor or reviewer wallet first.')
      const result = await api('/api/tron/organizations/mandates/' + encodeURIComponent(mandateId.trim()) + '/evidence', token, {
        method:'POST', body:JSON.stringify({
          evidenceType, storageProvider:'approved-private-document-vault', objectKey:objectKey.trim(),
          contentSha256:contentSha256.trim().toLowerCase(), mediaType, byteSize:Number(byteSize),
          encryptedAtRest:true, retentionPolicyReference:retentionPolicyReference.trim(),
        }),
      })
      setNotice('Evidence metadata recorded as pending independent review. No document was uploaded to this platform.')
      await refresh()
    })
  }

  async function submitReview() {
    await run(async () => {
      if (!config?.reviewerRole) throw new Error('This wallet is not in the trusted reviewer registry.')
      if (!records?.evidenceSetDigest) throw new Error('Load a non-empty evidence set before reviewing.')
      const decidedAt = new Date().toISOString()
      const input = { applicationId:records.applicationId, mandateId:mandateId.trim(), evidenceSetDigest:records.evidenceSetDigest,
        decision:'approved', reviewerWalletAddress:wallet.address, reviewerRole:config.reviewerRole,
        decisionEvidenceReference:reviewReference.trim(), decidedAt }
      if (input.decisionEvidenceReference.length < 8) throw new Error('Enter a case or evidence review reference of at least 8 characters.')
      const signature = await wallet.tronWeb.trx.signMessageV2(reviewMessage(input))
      const result = await api('/api/tron/organizations/mandates/' + encodeURIComponent(mandateId.trim()) + '/reviews', token, {
        method:'POST', body:JSON.stringify({decision:'approved',decisionEvidenceReference:input.decisionEvidenceReference,decidedAt,
          signature,independenceAttested:true,conflictCheckPassed:true}),
      })
      setNotice(result.independentReview?.quorumMet ? 'Two-person independent review quorum met. This still does not authorize payouts.' : 'Signed reviewer decision recorded. A second distinct reviewer with the other required role is still needed.')
      await refresh()
    })
  }

  async function revoke() {
    await run(async () => {
      if (!records?.applicationId) throw new Error('Load the mandate governance record first.')
      const emergency = config?.securityOfficer === true
      const actorRole = emergency ? 'security-officer' : 'sponsor-representative'
      const eventReference = revocationReference.trim()
      if (eventReference.length < 8) throw new Error('Enter a revocation case reference of at least 8 characters.')
      const effectiveAt = new Date().toISOString()
      const input = { applicationId:records.applicationId, scopeType:'mandate', scopeId:mandateId.trim(), mandateId:mandateId.trim(),
        actorWalletAddress:wallet.address, actorRole, reasonCode, emergency, eventReference, effectiveAt }
      const signature = await wallet.tronWeb.trx.signMessageV2(revocationMessage(input))
      await api('/api/tron/organizations/mandates/' + encodeURIComponent(mandateId.trim()) + '/revoke', token, {
        method:'POST', body:JSON.stringify({reasonCode,eventReference,emergency,signature,effectiveAt}),
      })
      setNotice('Signed revocation event appended. The related mandate has been marked revoked; no funds were moved.')
      await refresh()
    })
  }

  return (
    <section className="panel provider-panel sponsor-governance-panel">
      <div className="section-heading">
        <div><span className="eyebrow">STAGE 7 · ORGANIZATIONAL GOVERNANCE</span><h2>Evidence, independent review and revocation</h2>
          <p>Metadata-only evidence references, trusted wallet signatures and append-only governance records. This panel cannot initiate a payout.</p></div>
        <div className="panel-icon"><ShieldCheck /></div>
      </div>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {notice && <div className="notice notice-success" role="status">{notice}</div>}
      <label>Mandate ID<input value={mandateId} onChange={(e)=>setMandateId(e.target.value)} placeholder="Existing organization mandate UUID" /></label>
      <div className="transaction-actions">
        <button className="secondary-button" disabled={busy || !token || !mandateId.trim()} onClick={()=>void run(refresh)}><RefreshCw size={15}/> Load governance record</button>
        <span className="fine-print">{token ? 'Wallet authenticated: '+wallet.address : 'Connect a TRON Mainnet wallet to authenticate.'}</span>
      </div>
      {records && <div className="settings-group">
        <strong>Evidence-set SHA-256</strong><code>{records.evidenceSetDigest || 'No evidence metadata submitted'}</code>
        <p className="fine-print">Independent quorum: {records.independentReview?.quorumMet ? 'met' : 'not met'} · {records.independentReview?.reviewerCount || 0}/2 distinct reviewers</p>
        <p className="fine-print">Payout authorized: no · Signer operation: none · Transaction broadcast: none</p>
        {(records.evidence || []).map((item)=><article className="transaction-row" key={item.id}>
          <div className="transaction-main"><strong>{item.evidenceType}</strong><span>{item.id}</span><small>{item.mediaType} · {item.byteSize} bytes · SHA-256 {item.contentSha256}</small><small>Vault reference: {item.objectKey}</small><small>Metadata only · pending independent inspection</small></div>
        </article>)}
        {(records.reviewerDecisions || []).map((item,i)=><p className="fine-print" key={i}>{item.reviewerRole}: {item.decision} · {item.reviewerWalletAddress} · {item.decidedAt}</p>)}
        {(records.revocations || []).map((item,i)=><p className="fine-print" key={i}>Revoked: {item.reasonCode} · {item.eventReference} · {item.effectiveAt}</p>)}
      </div>}
      <div className="settings-group">
        <h3><FileCheck2 size={17}/> Submit private-vault evidence metadata</h3>
        <p className="fine-print">Upload the original document only to your approved encrypted private vault. This form records its vault object key and digest; it does not upload, fetch, encrypt or malware-scan the file.</p>
        <label>Evidence type<select value={evidenceType} onChange={(e)=>setEvidenceType(e.target.value)}>{EVIDENCE_TYPES.map((value)=><option key={value} value={value}>{value}</option>)}</select></label>
        <label>Private vault object key<input value={objectKey} onChange={(e)=>setObjectKey(e.target.value)} placeholder="vault-managed/object-key" /></label>
        <label>Content SHA-256<input value={contentSha256} onChange={(e)=>setContentSha256(e.target.value)} placeholder="64 hexadecimal characters" /></label>
        <label>Media type<select value={mediaType} onChange={(e)=>setMediaType(e.target.value)}><option value="application/pdf">PDF</option><option value="image/jpeg">JPEG</option><option value="image/png">PNG</option></select></label>
        <label>File size in bytes<input type="number" min="1" max="20971520" value={byteSize} onChange={(e)=>setByteSize(e.target.value)} /></label>
        <label>Retention policy reference<input value={retentionPolicyReference} onChange={(e)=>setRetentionPolicyReference(e.target.value)} /></label>
        <button className="secondary-button" disabled={busy || !token || !mandateId.trim()} onClick={()=>void submitEvidence()}>Record evidence metadata</button>
      </div>
      <div className="settings-group">
        <h3><ShieldCheck size={17}/> Independent reviewer approval</h3>
        <p className="fine-print">Trusted role: {config?.reviewerRole || 'not assigned to this wallet'}. Each reviewer signs the exact current evidence-set digest. Sponsor wallets and evidence submitters cannot review their own case.</p>
        <label>Independent review case reference<input value={reviewReference} onChange={(e)=>setReviewReference(e.target.value)} placeholder="External review case reference (8+ characters)" /></label>
        <button className="secondary-button" disabled={busy || !token || !config?.reviewerRole || !records?.evidenceSetDigest} onClick={()=>void submitReview()}>Sign and submit independent approval</button>
      </div>
      <div className="settings-group">
        <h3><AlertTriangle size={17}/> Append signed revocation event</h3>
        <label>Reason<select value={reasonCode} onChange={(e)=>setReasonCode(e.target.value)}>{['sponsor-request','suspected-compromise','authority-withdrawn','provider-account-changed','evidence-invalidated','policy-breach','legal-or-compliance-hold','other'].map((v)=><option key={v}>{v}</option>)}</select></label>
        <label>Revocation case reference<input value={revocationReference} onChange={(e)=>setRevocationReference(e.target.value)} placeholder="Incident or revocation reference (8+ characters)" /></label>
        <button className="outline-button" disabled={busy || !token || !records?.applicationId} onClick={()=>void revoke()}>Sign and revoke mandate</button>
        <p className="fine-print">A sponsor can revoke its own mandate. Emergency revocation is restricted to a trusted security-officer wallet configured on the server.</p>
      </div>
    </section>
  )
}
