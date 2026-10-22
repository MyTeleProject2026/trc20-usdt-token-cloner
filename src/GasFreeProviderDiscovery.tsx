import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')

type GasFreeCapabilities = {
  success?: boolean
  status?: string
  configured?: boolean
  reachable?: boolean
  network?: string
  networkLabel?: string
  reason?: string
  message?: string
  requiredEnvironment?: string[]
  providerCount?: number
  supportedTokenCount?: number
  providers?: Array<{
    address: string
    name: string
    config?: { minDeadlineDuration?: number | null; maxDeadlineDuration?: number | null }
  }>
  tokens?: Array<{
    tokenAddress: string
    symbol: string
    decimals: number
    supported: boolean
    activationFeeBaseUnits: string
    transferFeeBaseUnits: string
    feeCurrency: string
  }>
  feePolicy?: string
  note?: string
  providerFundingVerified?: boolean
  canSubmitSponsoredTransfer?: boolean
}

function formatBaseUnits(baseUnits: string, decimals: number): string {
  try {
    const amount = BigInt(baseUnits)
    const scale = 10n ** BigInt(decimals)
    const whole = amount / scale
    const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
    return fraction ? `${whole}.${fraction}` : String(whole)
  } catch {
    return 'unavailable'
  }
}

/** Live provider/token discovery only: no authorization is signed or submitted. */
export default function GasFreeProviderDiscovery() {
  const [network, setNetwork] = useState<'mainnet' | 'nile'>('nile')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<GasFreeCapabilities | null>(null)
  const [requestError, setRequestError] = useState('')

  const refresh = async (selectedNetwork: 'mainnet' | 'nile' = network) => {
    setLoading(true)
    setRequestError('')
    try {
      const response = await fetch(`${API_BASE}/api/gasfree/capabilities?network=${selectedNetwork}`, {
        headers: { Accept: 'application/json' },
      })
      const payload: GasFreeCapabilities = await response.json()
      setResult(payload)
      if (!response.ok && payload?.status !== 'not-configured') {
        setRequestError(payload?.message || 'GasFree provider discovery is unavailable.')
      }
    } catch {
      setRequestError('Could not reach the GasFree discovery endpoint. No transfer was submitted.')
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh(network)
    // The effect is intentionally scoped to selectedNetwork changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network])

  const live = result?.success === true && result.reachable === true

  return (
    <section className="rounded-xl border border-secondary bg-primary p-xl space-y-lg">
      <div className="flex items-start gap-md">
        <ShieldCheck className="size-6 shrink-0 text-brand-primary" aria-hidden="true" />
        <div className="min-w-0">
          <h3 className="text-heading-xs font-semibold text-primary">GasFree live provider discovery</h3>
          <p className="mt-xs text-sm text-tertiary">Queries the provider directory and current supported-token fee configuration. This is read-only; it does not authorize or submit a transfer.</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-md sm:grid-cols-2">
        <label className="flex flex-col gap-xs text-sm font-medium text-secondary">
          GasFree provider environment
          <select value={network} onChange={(event) => setNetwork(event.target.value as 'mainnet' | 'nile')} className="rounded-md border border-primary bg-primary px-md py-sm text-sm text-primary">
            <option value="nile">Nile testnet — integration testing</option>
            <option value="mainnet">TRON Mainnet — production</option>
          </select>
        </label>
        <div className="flex items-end">
          <button type="button" onClick={() => void refresh()} disabled={loading} className="w-full rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary disabled:opacity-50">
            {loading ? 'Checking provider…' : 'Refresh provider inventory'}
          </button>
        </div>
      </div>
      {requestError && <p role="alert" className="text-sm text-utility-danger-700">{requestError}</p>}
      {loading && <p role="status" className="text-sm text-tertiary">Checking the selected provider environment…</p>}
      {result && !live && !loading && (
        <div className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-sm text-utility-warning-700">
          <p className="font-semibold">{result.status === 'not-configured' ? 'Provider API access is not configured' : 'Provider discovery is not verified'}</p>
          <p className="mt-xs">{result.message || result.reason || 'No verified response was returned.'}</p>
          {result.requiredEnvironment && <p className="mt-xs">Required server-side variables: {result.requiredEnvironment.join(', ')}. Never put the API secret in frontend variables.</p>}
        </div>
      )}
      {live && (
        <>
          <div className="rounded-lg border border-secondary bg-secondary p-md">
            <p className="text-sm font-semibold text-primary">{result.networkLabel}: live provider configuration returned</p>
            <p className="mt-xs text-xs text-tertiary">{result.providerCount ?? 0} provider(s), {result.supportedTokenCount ?? 0} supported token(s) in the returned configuration.</p>
          </div>
          <div className="space-y-sm">
            <h4 className="text-sm font-semibold text-primary">Providers reported by GasFree</h4>
            {result.providers?.length ? result.providers.map((provider) => (
              <div key={provider.address} className="rounded-lg border border-secondary p-md">
                <p className="text-sm font-semibold text-primary">{provider.name}</p>
                <p className="mt-xs break-all text-xs font-mono text-tertiary">{provider.address}</p>
                {provider.config && <p className="mt-xs text-xs text-tertiary">Deadline range: {provider.config.minDeadlineDuration ?? 'unknown'}–{provider.config.maxDeadlineDuration ?? 'unknown'} seconds.</p>}
              </div>
            )) : <p className="text-sm text-tertiary">The provider returned no currently listed service providers.</p>}
          </div>
          <div className="space-y-sm">
            <h4 className="text-sm font-semibold text-primary">Supported token fee schedule</h4>
            {result.tokens?.filter((token) => token.supported).length ? result.tokens.filter((token) => token.supported).map((token) => (
              <div key={token.tokenAddress} className="rounded-lg border border-secondary p-md">
                <p className="text-sm font-semibold text-primary">{token.symbol} <span className="font-normal text-tertiary">({token.decimals} decimals; provider-reported symbol)</span></p>
                <p className="mt-xs break-all text-xs font-mono text-tertiary">Contract: {token.tokenAddress}</p>
                <p className="mt-xs text-sm text-secondary">Activation fee: {formatBaseUnits(token.activationFeeBaseUnits, token.decimals)} {token.symbol}</p>
                <p className="text-sm text-secondary">Transfer fee: {formatBaseUnits(token.transferFeeBaseUnits, token.decimals)} {token.symbol}</p>
              </div>
            )) : <p className="text-sm text-tertiary">No token is marked supported in the current provider response.</p>}
          </div>
        </>
      )}
      <div className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-sm text-utility-warning-700">
        <p className="font-semibold">Not a confirmed free sponsor</p>
        <p className="mt-xs">{result?.feePolicy || 'GasFree documents activation and transfer fees denominated in the transferred token. Review the live schedule and the provider’s written terms.'}</p>
        <p className="mt-xs">{result?.note || 'Provider listing and API reachability do not prove funding or a zero-fee offer. Sponsored submission and sponsor-funded principal remain disabled.'}</p>
        <p className="mt-xs font-semibold">Live transfer submission: disabled. Sponsor funding verification: not established.</p>
      </div>
    </section>
  )
}
