import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, CircleDollarSign, ShieldCheck } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')

type SponsorStatus = {
  enabled?: boolean
  mainnetEnabled?: boolean
  canSubmitSponsoredTransfer?: boolean
  network?: string
  provider?: string | null
  message?: string
  requiredBeforeEnablement?: string[]
}

type Props = { network: 'shasta' | 'mainnet' }
type SponsorPageProps = Props & { refreshKey: number }
type Asset = 'VTRC' | 'TRX' | 'USDT'
type TokenSelectionProps = Props & { asset: Asset; onAssetChange: (asset: Asset) => void; onContinue: () => void }

export function TokenSelectionPage({ network, asset, onAssetChange, onContinue }: TokenSelectionProps) {

  const options = [
    { id: 'VTRC' as const, title: 'VTRC — independent project token', description: 'Your project token. It is not official Tether USDT. The exact deployed contract must be selected before sending.', badge: 'Project token' },
    { id: 'TRX' as const, title: 'TRX — native network asset', description: 'Used for native transfers and may be needed for TRON network fees. Shasta TRX has no Mainnet value.', badge: 'Network asset' },
    { id: 'USDT' as const, title: 'USDT — external token contract', description: 'Only use a verified official contract for the selected network. This page does not assume a contract or exchange listing.', badge: 'Contract verification required' },
  ]

  return (
    <div className="space-y-xl">
      <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-lg">
        <div className="flex items-start gap-md">
          <CircleDollarSign className="size-6 shrink-0 text-brand-primary" aria-hidden="true" />
          <div>
            <h2 className="text-heading-xs font-semibold text-primary">Choose asset and transfer network</h2>
            <p className="mt-xs text-sm text-tertiary">Selected network: <strong>{network === 'shasta' ? 'Shasta testnet' : 'TRON Mainnet'}</strong>. Asset identity and network must match the receiving wallet or exchange deposit instructions.</p>
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
          <p className="mt-xs text-sm text-tertiary">{asset === 'VTRC' ? 'Before transfer, confirm the deployed VTRC contract address, token decimals, available balance, recipient and selected network.' : asset === 'TRX' ? 'Before transfer, confirm the sender has enough TRX for the transfer and any network fee.' : 'Sending is not enabled from this chooser until the official contract address is independently verified for this exact network.'}</p>
          <p className="mt-sm text-xs text-tertiary">Your selection is shared with the main workflow. No transaction is submitted from this page. VTRC still requires the exact deployed contract and balance check; USDT remains blocked until a verified network-specific contract allowlist exists.</p>
          <button type="button" onClick={onContinue} className="mt-md rounded-lg bg-brand-primary px-md py-sm text-sm font-semibold text-white focus-visible:ring-2 focus-visible:ring-focus-ring">{asset === 'TRX' ? 'Continue to native TRX workflow' : asset === 'VTRC' ? 'Continue to token workflow' : 'Review USDT requirements'}</button>
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

export default function SponsorProviderPage({ network, refreshKey }: SponsorPageProps) {
  const [status, setStatus] = useState<SponsorStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [providerName, setProviderName] = useState('')
  const [contact, setContact] = useState('')
  const [scope, setScope] = useState('network-fees')
  const [statusNotice, setStatusNotice] = useState('')
  const [draftNotice, setDraftNotice] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    fetch(`${API_BASE}/api/tron/sponsorship/status`, { headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error('Sponsor status endpoint unavailable')
        return response.json()
      })
      .then((payload) => { if (active) setStatus(payload?.sponsorship || null) })
      .catch(() => { if (active) setStatus(null) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [network, refreshKey])

  const copyApplicationDraft = async () => {
    setDraftNotice('')
    const organization = providerName.trim()
    const email = contact.trim()
    if (!organization || !email) {
      setDraftNotice('Enter an organization name and a business contact email before copying the draft.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setDraftNotice('Enter a valid business contact email address.')
      return
    }

    const scopeLabel = scope === 'network-fees'
      ? 'Network fee / resource sponsorship'
      : scope === 'trx-grant'
        ? 'Native TRX asset grant'
        : 'Allowlisted TRC-20 asset grant'
    const draft = [
      'Subject: External sponsorship partnership inquiry',
      '',
      `Organization: ${organization}`,
      `Business contact: ${email}`,
      `Proposed scope: ${scopeLabel}`,
      `Selected network: ${network === 'shasta' ? 'Shasta testnet' : 'TRON Mainnet'}`,
      '',
      'We would like to discuss a voluntary, externally funded sponsorship arrangement.',
      'Please provide written details on supported operations, funding, pricing, supported networks, authorization, limits, and failure/refund handling.',
      '',
      'This message is a draft only. No funds, credentials, or wallet signing material are included.',
    ].join('\\n')

    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(draft)
      setDraftNotice('Inquiry draft copied to clipboard. Nothing was sent or stored by this application.')
    } catch {
      setDraftNotice('Clipboard access was blocked. You can select and copy the form values manually; nothing was sent or stored.')
    }
  }

  const liveSubmissionEnabled = Boolean(status?.enabled && status?.canSubmitSponsoredTransfer && status?.network === network && (network !== 'mainnet' || status?.mainnetEnabled))
  const refreshStatus = async () => {
    setLoading(true)
    setStatusNotice('')
    try {
      const response = await fetch(`${API_BASE}/api/tron/sponsorship/status`, { headers: { Accept: 'application/json' } })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.message || 'Could not refresh sponsor status.')
      setStatus(payload?.sponsorship || null)
      setStatusNotice('Status refreshed. No application or transfer was submitted.')
    } catch (error) {
      setStatusNotice(error instanceof Error ? error.message : 'Sponsor status is unavailable.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-xl">
      <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-lg">
        <div className="flex items-start gap-md">
          <ShieldCheck className="size-6 shrink-0 text-brand-primary" aria-hidden="true" />
          <div>
            <h2 className="text-heading-xs font-semibold text-primary">Sponsor provider directory and application</h2>
            <p className="mt-xs text-sm text-tertiary">Network: {network === 'shasta' ? 'Shasta testnet' : 'TRON Mainnet'}. Review the live backend gate before treating any provider as available.</p>
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
        <button type="button" onClick={() => void refreshStatus()} disabled={loading} className="rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary disabled:opacity-50">{loading ? 'Checking…' : 'Refresh provider status'}</button>
        {statusNotice && <p role="status" className="text-xs text-tertiary">{statusNotice}</p>}
      </section>
      <section className="rounded-xl border border-secondary bg-primary p-xl space-y-lg">
        <div><h3 className="text-heading-xs font-semibold text-primary">Provider application draft</h3><p className="mt-xs text-sm text-tertiary">Enter details to prepare an application draft. This repository does not yet expose a secure provider-application API, so this form deliberately does not send or store your details.</p></div>
        <div className="grid grid-cols-1 gap-md md:grid-cols-2">
          <label className="flex flex-col gap-xs text-sm font-medium text-secondary">Provider / organization name<input value={providerName} onChange={(e) => setProviderName(e.target.value)} className="rounded-md border border-primary bg-primary px-md py-sm text-sm text-primary" placeholder="Organization name" autoComplete="organization" /></label>
          <label className="flex flex-col gap-xs text-sm font-medium text-secondary">Business contact email<input type="email" value={contact} onChange={(e) => setContact(e.target.value)} className="rounded-md border border-primary bg-primary px-md py-sm text-sm text-primary" placeholder="name@example.com" autoComplete="email" /></label>
          <label className="flex flex-col gap-xs text-sm font-medium text-secondary md:col-span-2">Proposed sponsorship scope<select value={scope} onChange={(e) => setScope(e.target.value)} className="rounded-md border border-primary bg-primary px-md py-sm text-sm text-primary"><option value="network-fees">Network fee / resource sponsorship</option><option value="trx-grant">Native TRX asset grant</option><option value="trc20-grant">Allowlisted TRC-20 asset grant</option></select></label>
        </div>
        <div className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-xs text-utility-warning-700"><strong>Not submitted.</strong> Do not enter passwords, private keys, recovery phrases, API secrets or wallet signing material. Provider onboarding requires a secured backend, verification and review before it can be accepted.</div>
        <button type="button" onClick={() => void copyApplicationDraft()} className="rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary focus-visible:ring-2 focus-visible:ring-focus-ring">Copy provider application draft</button>
        {draftNotice && <p role="status" className="text-xs text-tertiary">{draftNotice}</p>}
        <p className="text-xs text-tertiary">Draft fields currently remain only in this open page state; providerName/contact are not transmitted to the backend.</p>
      </section>
    </div>
  )
}
