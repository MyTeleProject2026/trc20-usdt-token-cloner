import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, CircleDollarSign, ShieldCheck } from 'lucide-react'
import GasFreeProviderDiscovery from './GasFreeProviderDiscovery'
import SponsorResourceDelegation from './SponsorResourceDelegation'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')

type SponsorStatus = {
  enabled?: boolean
  mainnetEnabled?: boolean
  canSubmitSponsoredTransfer?: boolean
  network?: string
  provider?: string | null
  message?: string
  requiredBeforeEnablement?: string[]
}

type Props = { network: 'shasta' | 'nile' | 'mainnet'; walletAddress?: string }
type SponsorFunding = {
  status?: string
  sponsorAddress?: string
  requiredEnvironment?: string[]
  onChainBalanceRead?: boolean
  tokenBalancesComplete?: boolean
  tokenBalanceScope?: string
  cache?: { status?: string; ageMs?: number }
  checkedAt?: string
  note?: string
  native?: { status?: string; balanceTRX?: string; balanceSun?: string; accountExists?: boolean }
  tokens?: Array<{ asset: string; tokenContract: string; status: string; balanceBaseUnits?: string; decimals?: number }>
}
function formatSponsorAssetUnits(value?: string, decimals?: number) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)
    || !Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 255) return null
  const amount = BigInt(value)
  const scale = 10n ** BigInt(decimals as number)
  const whole = amount / scale
  const fraction = (amount % scale).toString().padStart(decimals as number, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

type Asset = 'VTRC' | 'TRX' | 'USDT'
type TokenSelectionProps = Props & { asset: Asset; onAssetChange: (asset: Asset) => void; onContinue: () => void }

export function TokenSelectionPage({ network, asset, onAssetChange, onContinue }: TokenSelectionProps) {

  const options = [
    { id: 'VTRC' as const, title: 'VTRC — independent project token', description: 'Your project token. It is not official Tether USDT. The exact deployed contract must be selected before sending.', badge: 'Project token' },
    { id: 'TRX' as const, title: 'TRX — native network asset', description: 'Used for native transfers and may be needed for TRON network fees. Shasta TRX has no Mainnet value.', badge: 'Network asset' },
    { id: 'USDT' as const, title: 'USDT — official Mainnet token', description: network === 'mainnet' ? 'Only the official TRON Mainnet USDT contract is allowlisted in this transfer flow. The app checks the exact address and six-decimal precision.' : 'Official Mainnet USDT is not available on this testnet. Test tokens are not Mainnet USDT and are not eligible in this transfer flow.', badge: network === 'mainnet' ? 'Official contract allowlisted' : 'Mainnet only' },
  ]

  return (
    <div className="space-y-xl">
      <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-lg">
        <div className="flex items-start gap-md">
          <CircleDollarSign className="size-6 shrink-0 text-brand-primary" aria-hidden="true" />
          <div>
            <h2 className="text-heading-xs font-semibold text-primary">Choose asset and transfer network</h2>
            <p className="mt-xs text-sm text-tertiary">Selected network: <strong>{network === 'shasta' ? 'Shasta testnet' : network === 'nile' ? 'Nile testnet' : 'TRON Mainnet'}</strong>. Asset identity and network must match the receiving wallet or exchange deposit instructions.</p>
          </div>
        </div>
        <div className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-sm text-utility-warning-700">
          <strong>Important:</strong> Shasta assets cannot be deposited as Mainnet assets. An on-chain transfer does not guarantee an exchange will credit a deposit.
        </div>
        <div className="grid grid-cols-1 gap-md md:grid-cols-3">
          {options.map((option) => (
            <button key={option.id} type="button" onClick={() => onAssetChange(option.id)} aria-pressed={asset === option.id} className={`rounded-xl border p-lg text-left transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring ${asset === option.id ? 'border-brand-primary bg-secondary' : 'border-secondary bg-primary hover:bg-secondary'}`}>
              <span className="text-xs font-semibold text-tertiary">{option.badge}</span>
              <span className="mt-sm block text-sm font-semibold text-primary">{option.title}</span>
              <span className="mt-sm block text-xs leading-relaxed text-tertiary">{option.description}</span>
              <span className="mt-md block text-xs font-semibold text-brand-primary">{asset === option.id ? 'Selected' : 'Select asset'}</span>
            </button>
          ))}
        </div>
        <div className="rounded-lg border border-secondary bg-secondary p-lg">
          <p className="text-sm font-semibold text-primary">Current selection: {asset}</p>
          <p className="mt-xs text-sm text-tertiary">{asset === 'VTRC' ? 'Before transfer, confirm the deployed VTRC contract address, token decimals, available balance, recipient and selected network.' : asset === 'TRX' ? 'Before transfer, confirm the sender has enough TRX for the transfer and any network fee.' : network === 'mainnet' ? 'The official TRON Mainnet USDT contract will be filled into the transfer form. Confirm the contract, six decimals, sender, receiver, amount, wallet network and fees before approving in TronLink.' : 'USDT transfers are Mainnet-only in this workflow. Switch the network selector to TRON Mainnet; testnet tokens are not official USDT.'}</p>
          <p className="mt-sm text-xs text-tertiary">Your selection is shared with the main workflow. No transaction is submitted from this page. VTRC remains limited to its selected Shasta test contract. USDT can continue only on Mainnet to the fixed official contract; sponsor-paid fees are not enabled.</p>
          <button type="button" onClick={onContinue} disabled={asset === 'USDT' && network !== 'mainnet'} className="mt-md rounded-lg bg-brand-primary px-md py-sm text-sm font-semibold text-white focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50">{asset === 'TRX' ? 'Continue to native TRX workflow' : asset === 'VTRC' ? 'Continue to token workflow' : network === 'mainnet' ? 'Continue to official USDT transfer' : 'USDT transfer requires Mainnet'}</button>
        </div>
      </section>
      <section className="rounded-xl border border-secondary bg-primary p-xl space-y-md">
        <h3 className="text-sm font-semibold text-primary">Before sending to an exchange</h3>
        <ul className="list-disc space-y-xs pl-lg text-sm text-tertiary">
          <li>Confirm the exchange supports the exact token and TRON network.</li>
          <li>Use the deposit address and any memo/tag exactly as the exchange displays them.</li>
          <li>Check minimum deposit and required confirmations directly with the exchange.</li>
          <li>Track blockchain confirmation separately from exchange account credit.</li>
        </ul>
      </section>
    </div>
  )
}

export default function SponsorProviderPage({ network, walletAddress = '' }: Props) {
  const [status, setStatus] = useState<SponsorStatus | null>(null)
  const [funding, setFunding] = useState<SponsorFunding | null>(null)
  const [fundingLoading, setFundingLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [providerName, setProviderName] = useState('')
  const [contact, setContact] = useState('')
  const [scope, setScope] = useState('network-fees')
  const [notice, setNotice] = useState('')
  const [applicationSubmitting, setApplicationSubmitting] = useState(false)
  const [applicationReference, setApplicationReference] = useState('')
  const [applicationStatus, setApplicationStatus] = useState('')
  const [privacyConsent, setPrivacyConsent] = useState(false)
  const [applicationNotice, setApplicationNotice] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    setFundingLoading(true)
    fetch(`${API_BASE}/api/tron/sponsorship/status`, { headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error('Sponsor status endpoint unavailable')
        return response.json()
      })
      .then((payload) => { if (active) setStatus(payload?.sponsorship || null) })
      .catch(() => { if (active) setStatus(null) })
      .finally(() => { if (active) setLoading(false) })

    fetch(`${API_BASE}/api/tron/sponsorship/funding-status?network=${encodeURIComponent(network)}`, {
      headers: { Accept: 'application/json' },
    })
      .then((response) => response.json())
      .then((payload) => { if (active) setFunding(payload?.funding || null) })
      .catch(() => { if (active) setFunding({ status: 'balance-check-unavailable', onChainBalanceRead: false }) })
      .finally(() => { if (active) setFundingLoading(false) })
    return () => { active = false }
  }, [network, walletAddress])

  const liveSubmissionEnabled = Boolean(status?.enabled && status?.canSubmitSponsoredTransfer && (network !== 'mainnet' || status?.mainnetEnabled))
  const refreshStatus = async () => {
    setLoading(true)
    setFundingLoading(true)
    setNotice('')
    try {
      const response = await fetch(`${API_BASE}/api/tron/sponsorship/status`, { headers: { Accept: 'application/json' } })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.message || 'Could not refresh sponsor status.')
      setStatus(payload?.sponsorship || null)
      const fundingResponse = await fetch(`${API_BASE}/api/tron/sponsorship/funding-status?network=${encodeURIComponent(network)}&refresh=1`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      const fundingPayload = await fundingResponse.json().catch(() => null)
      if (!fundingResponse.ok || fundingPayload?.success !== true || !fundingPayload?.funding) {
        // Partial per-asset results may help diagnosis, but are not a complete snapshot.
        setFunding(fundingPayload?.funding || {
          status: 'balance-check-unavailable',
          onChainBalanceRead: false,
          note: 'No complete sponsor balance snapshot was verified.',
        })
        const detail = fundingPayload?.message || fundingPayload?.error
        setNotice(detail
          ? `Sponsor status refreshed, but funding verification is incomplete: ${String(detail)}. Any individually verified balance remains read-only; no transfer was submitted.`
          : `Sponsor status refreshed, but the balance endpoint returned HTTP ${fundingResponse.status}. No complete funding snapshot was verified and no transfer was submitted.`)
        return
      }
      setFunding(fundingPayload.funding)
      setNotice('Provider status checked and a successful solidified-chain funding snapshot loaded. Individual balances remain read-only; no application or transfer was submitted.')
    } catch (error) {
      // Clear prior results on a failed refresh so stale sponsor readiness or
      // balances cannot be mistaken for current, verified state.
      setStatus(null)
      setFunding({
        status: 'balance-check-unavailable',
        onChainBalanceRead: false,
        note: 'Sponsor status or funding refresh failed. No current funding snapshot is verified.',
      })
      setNotice(error instanceof Error ? error.message : 'Sponsor status is unavailable. Previous funding data was cleared.')
    } finally {
      setLoading(false)
      setFundingLoading(false)
    }
  }

  const submitProviderApplication = async () => {
    const normalizedName = providerName.trim()
    const normalizedEmail = contact.trim().toLowerCase()
    if (normalizedName.length < 2 || normalizedName.length > 120) {
      setApplicationNotice('Enter a provider or organization name between 2 and 120 characters.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail) || normalizedEmail.length > 254) {
      setApplicationNotice('Enter a valid business contact email.')
      return
    }
    if (!['network-fees', 'trx-grant', 'trc20-grant'].includes(scope)) {
      setApplicationNotice('Choose one of the listed sponsorship scopes.')
      return
    }
    if (!privacyConsent) {
      setApplicationNotice('Consent is required before the backend can store these contact details.')
      return
    }
    setApplicationSubmitting(true)
    setApplicationNotice('')
    try {
      const response = await fetch(`${API_BASE}/api/tron/sponsorship/provider-applications`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerName: normalizedName,
          contactEmail: normalizedEmail,
          scope,
          privacyConsent: true,
        }),
        credentials: 'omit',
        cache: 'no-store',
      })
      const payload = await response.json()
      if (!response.ok || payload?.success !== true || typeof payload?.application?.reference !== 'string') {
        throw new Error(payload?.message || 'The backend did not confirm that the application was stored.')
      }
      setApplicationReference(payload.application.reference)
      setApplicationStatus(payload.application.status || 'pending-review')
      setApplicationNotice('Application stored for manual due diligence. Save the reference below to check its status later. No sponsor agreement or transfer authorization was created.')
    } catch (error) {
      setApplicationNotice(error instanceof Error ? error.message : 'Could not submit the provider application. No successful submission was confirmed.')
    } finally {
      setApplicationSubmitting(false)
    }
  }

  const checkProviderApplicationStatus = async () => {
    if (!applicationReference) {
      setApplicationNotice('Submit an application successfully first; a status reference is required.')
      return
    }
    setApplicationSubmitting(true)
    setApplicationNotice('')
    try {
      const response = await fetch(`${API_BASE}/api/tron/sponsorship/provider-applications/${encodeURIComponent(applicationReference)}/status`, {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
      })
      const payload = await response.json()
      if (!response.ok || payload?.success !== true || typeof payload?.application?.status !== 'string') {
        throw new Error(payload?.message || 'Could not read the application status from the backend.')
      }
      setApplicationStatus(payload.application.status)
      setApplicationNotice('Status refreshed from the backend. Provider due diligence is separate from sponsor funding and fee authorization.')
    } catch (error) {
      setApplicationNotice(error instanceof Error ? error.message : 'Application status is unavailable.')
    } finally {
      setApplicationSubmitting(false)
    }
  }

  return (
    <div className="space-y-xl">
      <SponsorResourceDelegation network={network} walletAddress={walletAddress} />
      <GasFreeProviderDiscovery walletAddress={walletAddress} walletNetwork={network} />
      <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-lg">
        <div className="flex items-start gap-md">
          <ShieldCheck className="size-6 shrink-0 text-brand-primary" aria-hidden="true" />
          <div>
            <h2 className="text-heading-xs font-semibold text-primary">Sponsor provider directory and application</h2>
            <p className="mt-xs text-sm text-tertiary">Network: {network === 'shasta' ? 'Shasta testnet' : network === 'nile' ? 'Nile testnet' : 'TRON Mainnet'}. Review the live backend gate before treating any provider as available.</p>
          </div>
        </div>
        <div className={`flex items-start gap-sm rounded-lg border p-md text-sm ${liveSubmissionEnabled ? 'border-utility-success-200 bg-utility-success-50 text-utility-success-700' : 'border-utility-warning-200 bg-utility-warning-50 text-utility-warning-700'}`}>
          {liveSubmissionEnabled ? <CheckCircle2 className="mt-xxs size-4 shrink-0" /> : <AlertTriangle className="mt-xxs size-4 shrink-0" />}
          <div>
            <p className="font-semibold">{loading ? 'Checking provider status…' : liveSubmissionEnabled ? 'Backend reports sponsored submission enabled' : 'No verified sponsor submission is available'}</p>
            <p className="mt-xs">{status?.message || 'The backend did not confirm an enabled, funded, verified sponsor provider. Assume the sender must cover network fees.'}</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-md md:grid-cols-3">
          <div className="rounded-lg border border-secondary bg-secondary p-md"><p className="text-xs font-semibold text-primary">Network fee coverage</p><p className="mt-xs text-xs text-tertiary">{liveSubmissionEnabled ? `Backend gate enabled for ${status?.network || network}` : 'Not available until a provider, signer, funding, limits and evidence are verified.'}</p></div>
          <div className="rounded-lg border border-secondary bg-secondary p-md"><p className="text-xs font-semibold text-primary">Sponsor-funded asset grant</p><p className="mt-xs text-xs text-tertiary">A fee sponsor is not automatically a TRX or token principal provider. Asset grants require separate authorization and on-chain evidence.</p></div>
          <div className="rounded-lg border border-secondary bg-secondary p-md"><p className="text-xs font-semibold text-primary">Exchange deposits</p><p className="mt-xs text-xs text-tertiary">Sponsors cannot guarantee exchange credit. Only the receiving platform can confirm its deposit accounting.</p></div>
        </div>
        {status?.requiredBeforeEnablement?.length ? <details className="rounded-lg border border-secondary p-md"><summary className="cursor-pointer text-sm font-semibold text-primary">Required activation gates</summary><ul className="mt-sm list-disc space-y-xs pl-lg text-xs text-tertiary">{status.requiredBeforeEnablement.map((item) => <li key={item}>{item.replaceAll('-', ' ')}</li>)}</ul></details> : null}
        <section aria-live="polite" className="rounded-lg border border-secondary p-md space-y-sm">
          <h3 className="text-sm font-semibold text-primary">Sponsor wallet on-chain balances (read-only)</h3>
          {fundingLoading ? <p className="text-xs text-tertiary">Checking the selected network's solidified chain state…</p>
            : funding?.native?.status === 'verified'
              ? <div className="space-y-xs">
                  <p className="text-sm text-primary">Native TRX: <strong>{funding.native.balanceTRX} TRX</strong></p>
                  <p className="text-xs text-tertiary">Source: Tatum TRON SolidityNode. Account present: {funding.native.accountExists ? 'yes' : 'no'}.</p>
                  {funding.tokens?.length ? <div className="space-y-xs">
                    {funding.tokens.map((item) => <p key={item.asset + item.tokenContract} className="break-all text-xs text-tertiary">
                      <strong>{item.asset}</strong> ({item.tokenContract}): {item.status === 'verified' ? `${formatSponsorAssetUnits(item.balanceBaseUnits, item.decimals) ?? item.balanceBaseUnits} (base units: ${item.balanceBaseUnits}; ${item.decimals} decimals)` : 'balance unavailable; not treated as zero'}
                    </p>)}
                  </div> : <p className="text-xs text-tertiary">{funding.tokenBalanceScope === 'invalid-token-contract-allowlist' || funding.tokenBalanceScope === 'token-contract-allowlist-too-large' ? 'Token contract configuration is invalid; token balances are withheld.' : 'No token contracts were configured for read-only balance checks on this network.'}</p>}
                  {funding.tokenBalancesComplete === false && Boolean(funding.tokens?.length) && <p className="text-xs text-tertiary">At least one token balance could not be verified; inspect each token result above.</p>}
                  {funding.checkedAt && <p className="text-xs text-tertiary">Snapshot time: {funding.checkedAt}{funding.cache?.status === 'cached' ? ` · cached ${Math.ceil((funding.cache.ageMs || 0) / 1000)}s ago` : funding.cache?.status === 'refresh-throttled' ? ` · refresh throttled; snapshot ${Math.ceil((funding.cache.ageMs || 0) / 1000)}s old` : ' · fresh provider read'}</p>}
                </div>
              : <p className="text-xs text-tertiary">{funding?.status === 'sponsor-address-not-configured'
                  ? `No sponsor address is configured for this network. Set ${funding.requiredEnvironment?.join(', ') || 'the network-specific sponsor address'} server-side before the balance can be checked.`
                  : funding?.status === 'provider-credentials-missing'
                    ? 'Sponsor address is configured, but the server-side Tatum credential is missing; no balance was inferred.'
                    : funding?.status === 'invalid-token-contract-allowlist'
                      ? 'Native TRX was queried, but the configured token contract allowlist is invalid; token balances are withheld.'
                      : 'A fresh sponsor balance could not be verified from the selected network.'}</p>}
          <p className="text-xs text-tertiary">A verified balance snapshot is not sponsor consent, signing authority, or a reserved spend budget. It does not enable transfers or imply receiver credit. Failed token queries are shown as unavailable, never as zero.</p>
        </section>
        <button type="button" onClick={() => void refreshStatus()} disabled={loading || fundingLoading} className="rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary disabled:opacity-50">{loading || fundingLoading ? 'Checking…' : 'Refresh provider status and balances'}</button>
        {notice && <p role="status" className="text-xs text-tertiary">{notice}</p>}
      </section>
      <section className="rounded-xl border border-secondary bg-primary p-xl space-y-lg">
        <div>
          <h3 className="text-heading-xs font-semibold text-primary">Provider application</h3>
          <p className="mt-xs text-sm text-tertiary">Submit an application for manual provider due diligence. Only the organization name, business contact email and requested scope are stored, and only after consent and a confirmed backend response.</p>
        </div>
        <div className="grid grid-cols-1 gap-md md:grid-cols-2">
          <label className="flex flex-col gap-xs text-sm font-medium text-secondary">Provider / organization name
            <input required maxLength={120} value={providerName} onChange={(e) => setProviderName(e.target.value)} className="rounded-md border border-primary bg-primary px-md py-sm text-sm text-primary" placeholder="Organization name" autoComplete="organization" />
          </label>
          <label className="flex flex-col gap-xs text-sm font-medium text-secondary">Business contact email
            <input required type="email" maxLength={254} value={contact} onChange={(e) => setContact(e.target.value)} className="rounded-md border border-primary bg-primary px-md py-sm text-sm text-primary" placeholder="name@example.com" autoComplete="email" />
          </label>
          <label className="flex flex-col gap-xs text-sm font-medium text-secondary md:col-span-2">Proposed sponsorship scope
            <select value={scope} onChange={(e) => setScope(e.target.value)} className="rounded-md border border-primary bg-primary px-md py-sm text-sm text-primary">
              <option value="network-fees">Network fee / resource sponsorship</option>
              <option value="trx-grant">Native TRX asset grant</option>
              <option value="trc20-grant">Allowlisted TRC-20 asset grant</option>
            </select>
          </label>
        </div>
        <label className="flex items-start gap-sm text-xs text-secondary">
          <input type="checkbox" checked={privacyConsent} onChange={(e) => setPrivacyConsent(e.target.checked)} className="mt-xxs size-4 shrink-0" />
          <span>I consent to storing this organization name and business email in the project database for manual provider onboarding review. I will not submit passwords, private keys, recovery phrases, API secrets, or wallet signing material.</span>
        </label>
        <div className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-xs text-utility-warning-700">
          <strong>Important:</strong> Submission is an intake request only. It is not provider approval, sponsor consent, proof of funds, or permission to submit a transaction. No fee sponsorship is enabled by this form.
        </div>
        <button type="button" onClick={() => void submitProviderApplication()} disabled={applicationSubmitting || !privacyConsent} className="rounded-lg border border-transparent bg-brand-solid px-md py-sm text-sm font-semibold text-primary-on-brand disabled:cursor-not-allowed disabled:opacity-50">
          {applicationSubmitting ? 'Submitting…' : 'Submit provider application'}
        </button>
        {applicationReference && <div className="rounded-lg border border-secondary bg-secondary p-md space-y-sm">
          <p className="text-sm font-semibold text-primary">Application reference</p>
          <p className="break-all font-mono text-xs text-primary">{applicationReference}</p>
          <p className="text-xs text-tertiary">Current status: <strong>{applicationStatus || 'pending-review'}</strong>. Save this reference before leaving or refreshing the page. It reveals status only, not your contact details.</p>
          <button type="button" onClick={() => void checkProviderApplicationStatus()} disabled={applicationSubmitting} className="rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary disabled:opacity-50">Check application status</button>
        </div>}
        {applicationNotice && <p role="status" className="text-xs text-tertiary">{applicationNotice}</p>}
        <p className="text-xs text-tertiary">The application is reviewed manually; no automatic email confirmation is sent. Acceptance for due diligence does not enable transfers.</p>
      </section>
    </div>
  )
}
