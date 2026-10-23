import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, CircleDollarSign, ShieldCheck } from 'lucide-react'
import GasFreeProviderDiscovery from './GasFreeProviderDiscovery'

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
    { id: 'USDT' as const, title: 'USDT — external token contract', description: 'Only use a verified official contract for the selected network. This page does not assume a contract or exchange listing.', badge: 'Contract verification required' },
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

export default function SponsorProviderPage({ network, walletAddress = '' }: Props) {
  const [status, setStatus] = useState<SponsorStatus | null>(null)
  const [funding, setFunding] = useState<SponsorFunding | null>(null)
  const [fundingLoading, setFundingLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [providerName, setProviderName] = useState('')
  const [contact, setContact] = useState('')
  const [scope, setScope] = useState('network-fees')
  const [notice, setNotice] = useState('')

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
      const fundingResponse = await fetch(`${API_BASE}/api/tron/sponsorship/funding-status?network=${encodeURIComponent(network)}&refresh=1`, { headers: { Accept: 'application/json' } })
      const fundingPayload = await fundingResponse.json()
      setFunding(fundingPayload?.funding || null)
      setNotice('Provider status checked and latest funding snapshot loaded (balances may be cached for up to 10 seconds). No application or transfer was submitted.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Sponsor status is unavailable.')
    } finally {
      setLoading(false)
      setFundingLoading(false)
    }
  }

  return (
    <div className="space-y-xl">
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
                  {funding.checkedAt && <p className="text-xs text-tertiary">Snapshot time: {funding.checkedAt}{funding.cache?.status === 'cached' ? ` · cached ${Math.ceil((funding.cache.ageMs || 0) / 1000)}s ago` : ' · fresh provider read'}</p>}
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
        <div><h3 className="text-heading-xs font-semibold text-primary">Provider application draft</h3><p className="mt-xs text-sm text-tertiary">Enter details to prepare an application draft. This repository does not yet expose a secure provider-application API, so this form deliberately does not send or store your details.</p></div>
        <div className="grid grid-cols-1 gap-md md:grid-cols-2">
          <label className="flex flex-col gap-xs text-sm font-medium text-secondary">Provider / organization name<input value={providerName} onChange={(e) => setProviderName(e.target.value)} className="rounded-md border border-primary bg-primary px-md py-sm text-sm text-primary" placeholder="Organization name" autoComplete="organization" /></label>
          <label className="flex flex-col gap-xs text-sm font-medium text-secondary">Business contact email<input type="email" value={contact} onChange={(e) => setContact(e.target.value)} className="rounded-md border border-primary bg-primary px-md py-sm text-sm text-primary" placeholder="name@example.com" autoComplete="email" /></label>
          <label className="flex flex-col gap-xs text-sm font-medium text-secondary md:col-span-2">Proposed sponsorship scope<select value={scope} onChange={(e) => setScope(e.target.value)} className="rounded-md border border-primary bg-primary px-md py-sm text-sm text-primary"><option value="network-fees">Network fee / resource sponsorship</option><option value="trx-grant">Native TRX asset grant</option><option value="trc20-grant">Allowlisted TRC-20 asset grant</option></select></label>
        </div>
        <div className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-xs text-utility-warning-700"><strong>Not submitted.</strong> Do not enter passwords, private keys, recovery phrases, API secrets or wallet signing material. Provider onboarding requires a secured backend, verification and review before it can be accepted.</div>
        <button type="button" onClick={() => setNotice(`Draft reviewed locally for scope: ${scope}. No application was sent or saved. A secure provider-application API must be implemented before submission can be enabled.`)} className="rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary">Review application draft</button>
        {notice && <p role="status" className="text-xs text-tertiary">{notice}</p>}
        <p className="text-xs text-tertiary">Draft fields currently remain only in this open page state; providerName/contact are not transmitted to the backend.</p>
      </section>
    </div>
  )
}
