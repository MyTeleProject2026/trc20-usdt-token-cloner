import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Activity, AlertTriangle, CheckCircle2, ExternalLink, FileCheck2, LockKeyhole, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'

type SponsorSession = {
  address: string
  expiresAt: number
  sessionToken: string
}
type SponsorApplication = {
  id: string
  sponsorReference: string
  organizationName: string
  businessEmail: string
  jurisdiction: string
  website: string | null
  sponsorWalletAddress: string
  network: 'mainnet'
  requestedRoles: string[]
  status: string
  reviewReference: string | null
  createdAt: string
  updatedAt: string
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const SESSION_KEY = 'tron-token-studio:sponsor-organization-session:v1'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const MAINNET_HOST = 'api.trongrid.io'

function getProvider(): any {
  const candidates = [(window as any).tron, (window as any).tronLink]
  return candidates.find((provider) => provider?.isTronLink === true && typeof provider.request === 'function') || null
}

async function requestWalletAccess(provider: any): Promise<void> {
  try {
    await provider.request({ method: 'eth_requestAccounts' })
  } catch (error) {
    const code = Number((error as any)?.code)
    const message = String((error as any)?.message || error || '')
    if (code === -32601 || code === 4200 || /method not found|unsupported method|method not supported/i.test(message)) {
      await provider.request({ method: 'tron_requestAccounts' })
    } else {
      throw error
    }
  }
}

function checkMainnet(tronWeb: any): void {
  let parsed: URL
  try {
    parsed = new URL(String(tronWeb?.fullNode?.host || tronWeb?.fullNode?.nodeUrl || ''))
  } catch {
    throw new Error('TronLink did not expose a verifiable network endpoint. Select TRON Mainnet and reconnect.')
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== MAINNET_HOST
    || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new Error('Network mismatch. Select TRON Mainnet through the official TronGrid endpoint in TronLink.')
  }
}

function walletError(error: unknown): string {
  const code = Number((error as any)?.code)
  const message = String((error as any)?.message || error || '').trim()
  if (code === 4001 || /user rejected|request rejected|confirmation declined/i.test(message)) {
    return 'The wallet request was declined. Approve the connection and identity-message prompt in TronLink to continue.'
  }
  if (code === -32002 || /already pending|already processing/i.test(message)) {
    return 'A TronLink request is already open. Complete or close that prompt before trying again.'
  }
  if (/wallet is locked|not unlocked/i.test(message)) {
    return 'Unlock TronLink, select the sponsor organization wallet, and retry.'
  }
  return message.slice(0, 240) || 'Could not connect to TronLink. Open a compatible wallet and retry.'
}

async function apiJson(path: string, options: RequestInit = {}) {
  const response = await fetch(API_BASE + path, {
    ...options,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const payload = await response.json().catch(() => null)
  return { response, payload }
}

async function signIn(address: string, tronWeb: any): Promise<SponsorSession> {
  if (typeof tronWeb?.trx?.signMessageV2 !== 'function') {
    throw new Error('This TronLink version does not support signMessageV2. Update TronLink and retry.')
  }
  const challengeResult = await apiJson('/api/auth/tron/challenge', {
    method: 'POST',
    body: JSON.stringify({ address, network: 'mainnet' }),
  })
  const challenge = challengeResult.payload
  if (!challengeResult.response.ok || challenge?.success !== true || challenge.network !== 'mainnet'
    || typeof challenge.message !== 'string' || typeof challenge.nonce !== 'string'
    || !Number.isFinite(challenge.expiresAt) || challenge.expiresAt <= Date.now()) {
    throw new Error(challenge?.message || challenge?.error || 'Mainnet wallet identity challenge failed.')
  }

  // Identity message only. This is not a transaction signature and authorizes no transfer.
  const signature = await tronWeb.trx.signMessageV2(challenge.message)
  if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) {
    throw new Error('TronLink returned an invalid identity-message signature.')
  }
  checkMainnet(tronWeb)
  if (String(tronWeb?.defaultAddress?.base58 || '') !== address) {
    throw new Error('The active wallet changed while signing. Reconnect the intended sponsor account.')
  }

  const verifyResult = await apiJson('/api/auth/tron/verify', {
    method: 'POST',
    body: JSON.stringify({ address, network: 'mainnet', nonce: challenge.nonce, signature }),
  })
  const verified = verifyResult.payload
  if (!verifyResult.response.ok || verified?.success !== true || verified?.authenticated !== true
    || verified.address !== address || verified.network !== 'mainnet'
    || typeof verified.sessionToken !== 'string' || !Number.isFinite(verified.expiresAt)
    || verified.expiresAt <= Date.now()) {
    throw new Error(verified?.message || verified?.error || 'Mainnet wallet identity verification failed.')
  }

  const currentProvider = getProvider()
  const currentTronWeb = currentProvider?.tronWeb || (window as any).tronWeb
  checkMainnet(currentTronWeb)
  if (String(currentTronWeb?.defaultAddress?.base58 || '') !== address) {
    void fetch(API_BASE + '/api/auth/tron/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + verified.sessionToken },
      credentials: 'omit',
      cache: 'no-store',
    }).catch(() => undefined)
    throw new Error('The active sponsor wallet changed after signing. The new session was revoked.')
  }
  return { address, expiresAt: verified.expiresAt, sessionToken: verified.sessionToken }
}

function formatDate(value?: string | null): string {
  if (!value) return 'Not reviewed yet'
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'Unavailable'
}

export default function SponsorOrganizationPortal() {
  const [session, setSession] = useState<SponsorSession | null>(null)
  const [application, setApplication] = useState<SponsorApplication | null>(null)
  const [organizationName, setOrganizationName] = useState('')
  const [businessEmail, setBusinessEmail] = useState('')
  const [jurisdiction, setJurisdiction] = useState('')
  const [website, setWebsite] = useState('')
  const [assetPrincipal, setAssetPrincipal] = useState(true)
  const [networkFees, setNetworkFees] = useState(true)
  const [authority, setAuthority] = useState(false)
  const [walletControl, setWalletControl] = useState(false)
  const [lawfulFunds, setLawfulFunds] = useState(false)
  const [terms, setTerms] = useState(false)
  const [privacy, setPrivacy] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [loadingApplication, setLoadingApplication] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function loadOwnApplication(active: SponsorSession) {
    setLoadingApplication(true)
    try {
      const result = await apiJson('/api/tron/sponsorship/organizations/me', {
        headers: { Authorization: 'Bearer ' + active.sessionToken },
      })
      if (result.response.status === 404) {
        setApplication(null)
        return
      }
      if (!result.response.ok || result.payload?.success !== true || !result.payload?.application) {
        throw new Error(result.payload?.error || 'Could not read the application for this wallet.')
      }
      setApplication(result.payload.application as SponsorApplication)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read the application status.')
    } finally {
      setLoadingApplication(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    async function restore() {
      let token = ''
      try { token = window.sessionStorage.getItem(SESSION_KEY) || '' } catch {}
      if (!token) return
      try {
        const result = await apiJson('/api/auth/tron/session', {
          headers: { Authorization: 'Bearer ' + token },
        })
        const payload = result.payload
        if (!result.response.ok || payload?.success !== true || payload?.authenticated !== true
          || payload.network !== 'mainnet' || !ADDRESS_PATTERN.test(String(payload.address || ''))
          || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) {
          throw new Error('Sponsor wallet session expired.')
        }
        if (cancelled) return
        const restored = { address: payload.address, expiresAt: payload.expiresAt, sessionToken: token }
        setSession(restored)
        await loadOwnApplication(restored)
      } catch {
        try { window.sessionStorage.removeItem(SESSION_KEY) } catch {}
      }
    }
    void restore()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!session) return
    const timeout = window.setTimeout(() => {
      try { window.sessionStorage.removeItem(SESSION_KEY) } catch {}
      setSession(null)
      setApplication(null)
      setNotice('Your 30-minute wallet identity session expired. Reconnect to continue.')
    }, Math.max(0, session.expiresAt - Date.now()))
    return () => window.clearTimeout(timeout)
  }, [session])

  async function connectWallet() {
    if (connecting) return
    setConnecting(true)
    setError('')
    setNotice('')
    try {
      const provider = getProvider()
      if (!provider) throw new Error('TronLink was not detected. Open this page in a browser with a compatible TronLink wallet installed.')
      await requestWalletAccess(provider)
      const tronWeb = provider.tronWeb || (window as any).tronWeb
      if (!tronWeb || typeof tronWeb !== 'object') throw new Error('TronLink approved access but did not expose TronWeb. Unlock the wallet and reconnect.')
      checkMainnet(tronWeb)
      const address = String(tronWeb?.defaultAddress?.base58 || '')
      if (!ADDRESS_PATTERN.test(address) || (typeof tronWeb.isAddress === 'function' && !tronWeb.isAddress(address))) {
        throw new Error('TronLink did not provide a valid authorized TRON address.')
      }
      const signedSession = await signIn(address, tronWeb)
      try { window.sessionStorage.setItem(SESSION_KEY, signedSession.sessionToken) } catch {}
      setSession(signedSession)
      setApplication(null)
      await loadOwnApplication(signedSession)
      setNotice('Mainnet wallet identity verified. No transaction was created or authorized.')
    } catch (caught) {
      setError(walletError(caught))
    } finally {
      setConnecting(false)
    }
  }

  async function submitApplication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session || submitting) return
    setSubmitting(true)
    setError('')
    setNotice('')
    try {
      const requestedRoles = [
        ...(assetPrincipal ? ['asset-principal'] : []),
        ...(networkFees ? ['network-fees'] : []),
      ]
      const result = await apiJson('/api/tron/sponsorship/organizations', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + session.sessionToken },
        body: JSON.stringify({
          organizationName,
          businessEmail,
          jurisdiction,
          website: website.trim() || null,
          requestedRoles,
          authorityToRepresentOrganization: authority,
          controlsSponsorWallet: walletControl,
          lawfulSourceOfFunds: lawfulFunds,
          acceptsSponsorTerms: terms,
          privacyConsent: privacy,
        }),
      })
      if (!result.response.ok || result.payload?.success !== true || !result.payload?.application) {
        throw new Error(result.payload?.message || result.payload?.error || 'The organization application was not accepted by the backend.')
      }
      setApplication(result.payload.application as SponsorApplication)
      setNotice(result.payload.duplicate
        ? 'This wallet already has the same open application. The existing record has been loaded.'
        : 'Application received for manual owner due diligence. It does not authorize sponsor transfers or count as liquidity.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not submit the sponsor application.')
    } finally {
      setSubmitting(false)
    }
  }

  async function signOut() {
    const token = session?.sessionToken
    try { window.sessionStorage.removeItem(SESSION_KEY) } catch {}
    setSession(null)
    setApplication(null)
    setNotice('Sponsor wallet signed out.')
    if (token) {
      await fetch(API_BASE + '/api/auth/tron/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        credentials: 'omit',
        cache: 'no-store',
      }).catch(() => undefined)
    }
  }

  const requestedRoles = [
    ...(assetPrincipal ? ['asset-principal'] : []),
    ...(networkFees ? ['network-fees'] : []),
  ]

  return (
    <main className="sponsor-onboarding-screen">
      <section className="sponsor-onboarding-shell">
        <header className="sponsor-onboarding-header">
          <a className="sponsor-onboarding-brand" href="#/sponsor-onboarding" aria-label="TRON Token Studio sponsor portal">
            <span className="sponsor-onboarding-logo"><ShieldCheck size={23} /></span>
            <span><strong>TRON Token Studio</strong><small>EXTERNAL SPONSOR PORTAL</small></span>
          </a>
          <a className="sponsor-onboarding-owner-link" href="#/wallet">Owner console <ExternalLink size={14} /></a>
        </header>

        <section className="sponsor-onboarding-hero">
          <p className="studio-eyebrow">ORGANIZATION PARTNERSHIP · TRON MAINNET</p>
          <h1>Connect a sponsor organization</h1>
          <p>Register an organization and the Mainnet wallet it controls. Each application is reviewed separately before any sponsor balance or payout authority can be considered.</p>
          <div className="sponsor-onboarding-trust-row">
            <span><LockKeyhole size={15} /> Wallet-signed identity</span>
            <span><FileCheck2 size={15} /> Recorded attestations</span>
            <span><Activity size={15} /> No transfer signing</span>
          </div>
        </section>

        {error && <div className="sponsor-onboarding-message sponsor-onboarding-message--error" role="alert"><AlertTriangle size={18} /><span>{error}</span></div>}
        {notice && <div className="sponsor-onboarding-message" role="status"><CheckCircle2 size={18} /><span>{notice}</span></div>}

        <section className="sponsor-onboarding-card" aria-labelledby="sponsor-wallet-heading">
          <div className="sponsor-onboarding-card-head">
            <div><p className="sponsor-onboarding-step">STEP 01</p><h2 id="sponsor-wallet-heading">Verify sponsor wallet control</h2></div>
            {session && <span className="sponsor-onboarding-status"><CheckCircle2 size={14} /> Verified session</span>}
          </div>
          {!session ? (
            <>
              <p className="sponsor-onboarding-copy">Connect the wallet that the organization is authorized to use. TronLink will show a short identity message stating that it authorizes no transfer.</p>
              <button className="studio-button studio-button--primary sponsor-onboarding-connect" type="button" onClick={() => void connectWallet()} disabled={connecting}>
                {connecting ? <RefreshCw className="studio-spin" size={17} /> : <Wallet size={17} />}
                {connecting ? 'Connecting wallet…' : 'Connect & sign in with TronLink'}
              </button>
              <p className="sponsor-onboarding-note">Mainnet only. This portal never asks for a private key, recovery phrase, or seed phrase.</p>
            </>
          ) : (
            <div className="sponsor-onboarding-wallet">
              <span className="sponsor-onboarding-wallet-icon"><Wallet size={19} /></span>
              <div><small>Authenticated sponsor wallet · TRON Mainnet</small><strong>{session.address}</strong><small>Session expires {formatDate(new Date(session.expiresAt).toISOString())}</small></div>
              <button className="studio-button studio-button--secondary" type="button" onClick={() => void signOut()}>Sign out</button>
            </div>
          )}
        </section>

        {session && (
          <>
            {loadingApplication ? <div className="sponsor-onboarding-card"><p><RefreshCw className="studio-spin" size={16} /> Checking this wallet's application…</p></div> : null}
            {application ? (
              <section className="sponsor-onboarding-card" aria-labelledby="sponsor-existing-heading">
                <div className="sponsor-onboarding-card-head"><div><p className="sponsor-onboarding-step">APPLICATION STATUS</p><h2 id="sponsor-existing-heading">{application.organizationName}</h2></div><span className="sponsor-onboarding-status">{application.status.replaceAll('-', ' ')}</span></div>
                <dl className="sponsor-onboarding-details">
                  <div><dt>Sponsor reference</dt><dd>{application.sponsorReference}</dd></div>
                  <div><dt>Wallet address</dt><dd>{application.sponsorWalletAddress}</dd></div>
                  <div><dt>Requested roles</dt><dd>{application.requestedRoles.map((role) => role.replaceAll('-', ' ')).join(', ')}</dd></div>
                  <div><dt>Submitted</dt><dd>{formatDate(application.createdAt)}</dd></div>
                  <div><dt>Review reference</dt><dd>{application.reviewReference || 'Not assigned'}</dd></div>
                </dl>
                <p className="sponsor-onboarding-note">This record is a due-diligence application only. It does not create an approved sponsor agreement, allocate USDT, or authorize a transfer.</p>
              </section>
            ) : (
              <section className="sponsor-onboarding-card" aria-labelledby="sponsor-application-heading">
                <div className="sponsor-onboarding-card-head"><div><p className="sponsor-onboarding-step">STEP 02</p><h2 id="sponsor-application-heading">Organization application</h2></div><span className="sponsor-onboarding-status">Manual review</span></div>
                <form className="sponsor-onboarding-form" onSubmit={(event) => void submitApplication(event)}>
                  <div className="sponsor-onboarding-form-grid">
                    <label>Legal organization name<input value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} minLength={2} maxLength={120} required autoComplete="organization" /></label>
                    <label>Business contact email<input type="email" value={businessEmail} onChange={(event) => setBusinessEmail(event.target.value)} maxLength={254} required autoComplete="email" /></label>
                    <label>Jurisdiction of registration<input value={jurisdiction} onChange={(event) => setJurisdiction(event.target.value)} minLength={2} maxLength={100} required placeholder="Country or legal jurisdiction" /></label>
                    <label>Organization website <span>(optional, HTTPS)</span><input type="url" value={website} onChange={(event) => setWebsite(event.target.value)} maxLength={300} placeholder="https://organization.example" /></label>
                  </div>

                  <fieldset className="sponsor-onboarding-fieldset">
                    <legend>Requested sponsorship role(s)</legend>
                    <label><input type="checkbox" checked={assetPrincipal} onChange={(event) => setAssetPrincipal(event.target.checked)} /> <span><strong>USDT asset principal</strong><small>Organization may supply USDT principal for separately approved payouts.</small></span></label>
                    <label><input type="checkbox" checked={networkFees} onChange={(event) => setNetworkFees(event.target.checked)} /> <span><strong>Network fees / resources</strong><small>Organization may supply TRX or delegated Energy/Bandwidth under a separate mandate.</small></span></label>
                    {requestedRoles.length === 0 && <p className="sponsor-onboarding-validation">Select at least one role.</p>}
                  </fieldset>

                  <fieldset className="sponsor-onboarding-fieldset">
                    <legend>Required declarations</legend>
                    <label><input type="checkbox" checked={authority} onChange={(event) => setAuthority(event.target.checked)} required /> <span><strong>I am authorized to represent this organization.</strong><small>Authority may be requested for independent review.</small></span></label>
                    <label><input type="checkbox" checked={walletControl} onChange={(event) => setWalletControl(event.target.checked)} required /> <span><strong>The authenticated wallet is controlled by the organization or an authorized signer.</strong><small>Wallet ownership is proven by the identity signature; organizational authority is separately reviewed.</small></span></label>
                    <label><input type="checkbox" checked={lawfulFunds} onChange={(event) => setLawfulFunds(event.target.checked)} required /> <span><strong>The proposed funds are lawfully controlled and may be used for the stated sponsorship purpose.</strong></span></label>
                    <label><input type="checkbox" checked={terms} onChange={(event) => setTerms(event.target.checked)} required /> <span><strong>I accept separate written sponsor terms, caps, and transaction approvals before funding or payouts.</strong></span></label>
                    <label><input type="checkbox" checked={privacy} onChange={(event) => setPrivacy(event.target.checked)} required /> <span><strong>I consent to storing these organization details for manual due diligence.</strong></span></label>
                  </fieldset>

                  <button className="studio-button studio-button--primary sponsor-onboarding-submit" type="submit" disabled={submitting || !organizationName.trim() || !businessEmail.trim() || !jurisdiction.trim() || requestedRoles.length === 0 || !authority || !walletControl || !lawfulFunds || !terms || !privacy}>
                    {submitting ? <RefreshCw className="studio-spin" size={17} /> : <FileCheck2 size={17} />}
                    {submitting ? 'Submitting application…' : 'Submit for owner due diligence'}
                  </button>
                  <p className="sponsor-onboarding-note">Attestations are declarations, not independent proof of incorporation, beneficial ownership, legal mandate, source of funds, or signer authority. Do not submit keys, seed phrases, private credentials, or transaction data.</p>
                </form>
              </section>
            )}
          </>
        )}

        <section className="sponsor-onboarding-footer-card">
          <strong><ShieldCheck size={17} /> Important: application is not funding</strong>
          <p>Approval to proceed with due diligence does not authorize a payout. Sponsor liquidity can count only after a separate exact-scope agreement, active budget, fresh Mainnet USDT verification, and commitment reconciliation. The platform does not custody your private key.</p>
        </section>
        <footer className="sponsor-onboarding-footer"><span>TRON Token Studio · External sponsor intake</span><a href="https://tronscan.org" target="_blank" rel="noopener noreferrer">TRON Mainnet explorer <ExternalLink size={12} /></a></footer>
      </section>
    </main>
  )
}
