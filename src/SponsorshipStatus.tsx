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
        <p className="mt-xs text-xs text-tertiary">
          {active
            ? `Network: ${status?.network || 'not specified'} · Provider: ${status?.provider || 'verified sponsor'}`
            : 'No sponsor-paid transfer is available. Mainnet sponsorship remains disabled; Shasta test assets cannot become spendable Mainnet funds.'}
        </p>
      </div>
    </section>
  )
}
