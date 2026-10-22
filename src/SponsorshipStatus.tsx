import { useEffect, useState } from 'react'
import { AlertCircle, ShieldCheck } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')

type Sponsorship = {
  enabled?: boolean
  status?: string
  network?: string
  provider?: string | null
  mainnetEnabled?: boolean
  canSubmitSponsoredTransfer?: boolean
  fundingPolicy?: { mode?: string; userFundsRequiredForSponsoredFlow?: boolean; externalSponsorConfirmed?: boolean; sponsorFundingVerified?: boolean; paidProviderPurchasesAllowed?: boolean; feeSponsorshipAvailable?: boolean; sponsorFundedAssetTransfersAvailable?: boolean; unpaidFallbackToUserFunds?: boolean }
  receiverRestrictionsAvailable?: boolean
  receiverBalance?: { sponsorAssetGrantEnabled?: boolean; sponsoredFeeCoverage?: string; spendableSource?: string; exchangeCredit?: string }
  requiredBeforeEnablement?: string[]
  message?: string
}

export default function SponsorshipStatus() {
  const [status, setStatus] = useState<Sponsorship | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    fetch(`${API_BASE}/api/tron/sponsorship/status`, { headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error('Sponsorship status endpoint unavailable')
        return response.json()
      })
      .then((payload) => {
        if (active) setStatus(payload?.sponsorship || null)
      })
      .catch(() => {
        if (active) setStatus(null)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const active = Boolean(status?.enabled && status?.canSubmitSponsoredTransfer)
  return (
    <section className="mb-xl flex gap-lg rounded-xl border border-secondary bg-primary p-lg" aria-live="polite">
      {active
        ? <ShieldCheck className="mt-xxs size-5 shrink-0 text-fg-success-primary" aria-hidden="true" />
        : <AlertCircle className="mt-xxs size-5 shrink-0 text-utility-warning-600" aria-hidden="true" />}
      <div className="min-w-0">
        <p className="text-sm font-semibold text-primary">
          {loading ? 'Checking transfer sponsorship…' : active ? 'Sponsored transfer service available' : 'Fee sponsorship is not enabled'}
        </p>
        <p className="mt-xxs text-sm text-tertiary">
          {loading
            ? 'Checking the backend status. Do not assume a transaction is sponsored until the service confirms it.'
            : status?.message || 'Sponsorship status could not be loaded. Assume you must cover network fees yourself.'}
        </p>
        <div className="mt-md grid grid-cols-1 gap-sm sm:grid-cols-3">
          <div className="rounded-lg border border-secondary bg-secondary p-md">
            <p className="text-xs font-semibold text-primary">Network fee sponsorship</p>
            <p className="mt-xs text-xs text-tertiary">{active ? `Available on ${status?.network || 'configured network'}` : 'Unavailable — wait for a verified external sponsor; never fall back to user funds.'}</p>
          </div>
          <div className="rounded-lg border border-secondary bg-secondary p-md">
            <p className="text-xs font-semibold text-primary">Sponsor-funded TRX / USDT grant</p>
            <p className="mt-xs text-xs text-tertiary">{status?.receiverBalance?.sponsorAssetGrantEnabled ? 'Grant policy is enabled; verify each grant on-chain.' : 'Disabled — no sponsor-funded asset balance is verified; do not show credits as spendable.'}</p>
          </div>
          <div className="rounded-lg border border-secondary bg-secondary p-md">
            <p className="text-xs font-semibold text-primary">Spendable receiver balance</p>
            <p className="mt-xs text-xs text-tertiary">Only the actual on-chain wallet balance is spendable. Sponsor budgets and pending grants are never shown as wallet funds.</p>
          </div>
        </div>
        <p className="mt-xs text-xs text-tertiary">
          {active
            ? `Network: ${status?.network || 'not specified'} · Provider: ${status?.provider || 'verified sponsor'}`
            : 'No verified sponsor provider/account or funded budget is integrated. Exchange credit is independently controlled by each exchange; normal external wallets cannot enforce sponsor spending restrictions after receipt.'}
        </p>
        {status?.requiredBeforeEnablement?.length ? <details className="mt-sm text-xs text-tertiary"><summary className="cursor-pointer font-semibold text-secondary">Sponsor activation requirements</summary><ul className="mt-sm list-disc space-y-xs pl-lg">{status.requiredBeforeEnablement.map((item) => <li key={item}>{item.replaceAll('-', ' ')}</li>)}</ul></details> : null}
      </div>
    </section>
  )
}
