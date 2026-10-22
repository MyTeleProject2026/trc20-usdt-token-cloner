import { useEffect, useState } from 'react'
import { TronWeb } from 'tronweb'
import { ShieldCheck, SearchCheck, Activity, BadgeCheck } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TRACE_ID = /^[A-Za-z0-9_-]{1,128}$/

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

type GasFreeAsset = {
  tokenAddress: string
  tokenSymbol: string
  decimals: number
  activationFeeBaseUnits: string | null
  transferFeeBaseUnits: string | null
  frozenBaseUnits: string | null
  providerReportedBalanceBaseUnits?: string
}

type GasFreeAccountResult = {
  success?: boolean
  status?: string
  network?: string
  message?: string
  reason?: string
  requiredEnvironment?: string[]
  accountLookupVerified?: boolean
  account?: {
    accountAddress: string
    gasFreeAddress: string
    active: boolean
    nonce: number
    allowSubmit: boolean
    assets: GasFreeAsset[]
    chainFinalityVerified: boolean
    note: string
  }
}

type SolidifiedTokenVerification = {
  success?: boolean
  verified?: boolean
  status?: string
  message?: string
  error?: string
  reason?: string
  blockNumber?: number
  logIndex?: number
  amountSun?: string
  persistence?: { persisted?: boolean; reason?: string }
}

type SolidifiedTokenBalance = {
  success?: boolean
  status?: string
  network?: string
  tokenContract?: string
  receiverAddress?: string
  balanceBaseUnits?: string
  decimals?: number
  error?: string
  message?: string
}

type GasFreeTraceResult = {
  success?: boolean
  status?: string
  network?: string
  message?: string
  reason?: string
  requiredEnvironment?: string[]
  traceLookupVerified?: boolean
  trace?: {
    traceId: string
    state: string
    senderAddress: string | null
    gasFreeAddress: string | null
    receiverAddress: string | null
    providerAddress: string | null
    tokenAddress: string | null
    amountBaseUnits?: string
    maxFeeBaseUnits?: string
    transactionId: string | null
    createdAt: string | null
    updatedAt: string | null
    expiredAt: string | null
    verifiedOnChain: boolean
    note: string
  }
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

/** Provider inventory, account, and trace reads only; no authorization is signed or submitted. */
export default function GasFreeProviderDiscovery() {
  const [network, setNetwork] = useState<'mainnet' | 'nile'>('nile')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<GasFreeCapabilities | null>(null)
  const [requestError, setRequestError] = useState('')
  const [accountAddress, setAccountAddress] = useState('')
  const [accountLoading, setAccountLoading] = useState(false)
  const [accountError, setAccountError] = useState('')
  const [accountResult, setAccountResult] = useState<GasFreeAccountResult | null>(null)
  const [traceId, setTraceId] = useState('')
  const [traceLoading, setTraceLoading] = useState(false)
  const [traceError, setTraceError] = useState('')
  const [traceResult, setTraceResult] = useState<GasFreeTraceResult | null>(null)
  const [chainVerificationLoading, setChainVerificationLoading] = useState(false)
  const [chainVerificationError, setChainVerificationError] = useState('')
  const [chainVerificationResult, setChainVerificationResult] = useState<SolidifiedTokenVerification | null>(null)
  const [receiverBalanceLoading, setReceiverBalanceLoading] = useState(false)
  const [receiverBalanceError, setReceiverBalanceError] = useState('')
  const [receiverBalance, setReceiverBalance] = useState<SolidifiedTokenBalance | null>(null)

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

  const inspectAccount = async () => {
    const address = accountAddress.trim()
    setAccountError('')
    setAccountResult(null)
    if (!TRON_ADDRESS.test(address)) {
      setAccountError('Enter a valid TRON Base58 EOA address beginning with T.')
      return
    }
    setAccountLoading(true)
    try {
      const params = new URLSearchParams({ network, address })
      const response = await fetch(`${API_BASE}/api/gasfree/account?${params.toString()}`, {
        headers: { Accept: 'application/json' },
      })
      const payload: GasFreeAccountResult = await response.json()
      if (!response.ok || !payload?.success || !payload.account) {
        throw new Error(payload?.message || payload?.reason || 'GasFree account lookup is unavailable.')
      }
      setAccountResult(payload)
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : 'GasFree account lookup is unavailable.')
    } finally {
      setAccountLoading(false)
    }
  }

  const inspectTrace = async () => {
    const id = traceId.trim()
    setTraceError('')
    setTraceResult(null)
    if (!TRACE_ID.test(id)) {
      setTraceError('Enter the provider-issued trace ID. Do not enter a wallet address or private information.')
      return
    }
    setTraceLoading(true)
    try {
      const params = new URLSearchParams({ network, traceId: id })
      const response = await fetch(`${API_BASE}/api/gasfree/trace?${params.toString()}`, {
        headers: { Accept: 'application/json' },
      })
      const payload: GasFreeTraceResult = await response.json()
      if (!response.ok || !payload?.success || !payload.trace) {
        throw new Error(payload?.message || payload?.reason || 'GasFree transfer status is unavailable.')
      }
      setTraceResult(payload)
    } catch (error) {
      setTraceError(error instanceof Error ? error.message : 'GasFree transfer status is unavailable.')
    } finally {
      setTraceLoading(false)
    }
  }

  const verifyTraceOnChain = async () => {
    const trace = traceResult?.trace
    setChainVerificationError('')
    setChainVerificationResult(null)
    setReceiverBalanceError('')
    setReceiverBalance(null)

    if (!trace
      || !trace.transactionId
      || !/^[0-9a-f]{64}$/i.test(trace.transactionId)
      || !trace.senderAddress || !TRON_ADDRESS.test(trace.senderAddress)
      || !trace.receiverAddress || !TRON_ADDRESS.test(trace.receiverAddress)
      || !trace.tokenAddress || !TRON_ADDRESS.test(trace.tokenAddress)
      || !trace.amountBaseUnits || !/^[1-9][0-9]*$/.test(trace.amountBaseUnits)) {
      setChainVerificationError('The provider has not returned a complete transaction ID, sender, receiver, token contract, and positive amount. Chain verification is not available yet.')
      return
    }

    setChainVerificationLoading(true)
    try {
      const tronWeb = new TronWeb({
        fullHost: network === 'mainnet' ? 'https://api.trongrid.io' : 'https://nile.trongrid.io',
      })
      const toHexAddress = (address: string) => tronWeb.address.toHex(address).replace(/^41/i, '')
      const params = new URLSearchParams({
        network,
        contract: toHexAddress(trace.tokenAddress),
        from: toHexAddress(trace.senderAddress),
        to: toHexAddress(trace.receiverAddress),
        amountSun: trace.amountBaseUnits,
      })
      const response = await fetch(
        `${API_BASE}/api/tron/verify-transfer/${encodeURIComponent(trace.transactionId)}?${params.toString()}`,
        { headers: { Accept: 'application/json' } },
      )
      const payload: SolidifiedTokenVerification = await response.json()
      setChainVerificationResult(payload)

      if (!response.ok || payload?.success !== true) {
        setChainVerificationError(payload?.message || payload?.error || payload?.status || 'Solidified-chain verification is unavailable.')
        return
      }
      if (payload.verified !== true) {
        setChainVerificationError(payload.message || payload.reason || 'The transfer is not yet independently verified on solidified chain state. Retry the same trace later; do not resend the transfer.')
        return
      }

      setReceiverBalanceLoading(true)
      try {
        const balanceParams = new URLSearchParams({
          network,
          contract: trace.tokenAddress,
          address: trace.receiverAddress,
        })
        const balanceResponse = await fetch(`${API_BASE}/api/tron/token-balance?${balanceParams.toString()}`, {
          headers: { Accept: 'application/json' },
        })
        const balancePayload: SolidifiedTokenBalance = await balanceResponse.json()
        if (!balanceResponse.ok || balancePayload?.success !== true
          || typeof balancePayload.balanceBaseUnits !== 'string'
          || !/^[0-9]+$/.test(balancePayload.balanceBaseUnits)
          || !Number.isInteger(balancePayload.decimals)
          || (balancePayload.decimals as number) < 0
          || (balancePayload.decimals as number) > 255) {
          throw new Error(balancePayload?.message || balancePayload?.error || 'Could not read the receiver token balance from solidified chain state.')
        }
        setReceiverBalance(balancePayload)
      } catch (error) {
        setReceiverBalanceError(error instanceof Error ? error.message : 'Could not read the receiver token balance from solidified chain state.')
      } finally {
        setReceiverBalanceLoading(false)
      }
    } catch (error) {
      setChainVerificationError(error instanceof Error ? error.message : 'Solidified-chain verification is unavailable.')
    } finally {
      setChainVerificationLoading(false)
    }
  }

  useEffect(() => {
    void refresh(network)
    setAccountResult(null)
    setTraceResult(null)
    setChainVerificationError('')
    setChainVerificationResult(null)
    setReceiverBalance(null)
    setReceiverBalanceError('')
    // The effect is intentionally scoped to selectedNetwork changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network])

  const live = result?.success === true && result.reachable === true

  return (
    <section className="rounded-xl border border-secondary bg-primary p-xl space-y-lg">
      <div className="flex items-start gap-md">
        <ShieldCheck className="size-6 shrink-0 text-brand-primary" aria-hidden="true" />
        <div className="min-w-0">
          <h3 className="text-heading-xs font-semibold text-primary">GasFree provider integration</h3>
          <p className="mt-xs text-sm text-tertiary">Reads provider directory, token fee configuration, GasFree account metadata, and provider trace status. These read-only calls do not authorize or submit a transfer.</p>
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
                <p className={`mt-xs text-xs font-semibold ${network === 'mainnet' && token.tokenAddress === OFFICIAL_MAINNET_USDT ? 'text-utility-success-700' : 'text-utility-warning-700'}`}>
                  {network === 'mainnet' && token.tokenAddress === OFFICIAL_MAINNET_USDT
                    ? 'Exact contract matches Tether-published TRON Mainnet USDT.'
                    : token.symbol.toUpperCase() === 'USDT'
                      ? network === 'mainnet'
                        ? 'Symbol says USDT, but this is not the official Tether TRON Mainnet contract.'
                        : 'Provider symbol only: testnet assets are separate from Mainnet USDT.'
                      : 'Verify the exact token contract independently; the symbol alone does not establish asset identity.'}
                </p>
                <p className="mt-xs text-sm text-secondary">Activation fee: {formatBaseUnits(token.activationFeeBaseUnits, token.decimals)} {token.symbol}</p>
                <p className="text-sm text-secondary">Transfer fee: {formatBaseUnits(token.transferFeeBaseUnits, token.decimals)} {token.symbol}</p>
              </div>
            )) : <p className="text-sm text-tertiary">No token is marked supported in the current provider response.</p>}
          </div>
        </>
      )}

      <div className="rounded-xl border border-secondary p-lg space-y-md">
        <div className="flex items-start gap-sm">
          <SearchCheck className="size-5 shrink-0 text-brand-primary" aria-hidden="true" />
          <div>
            <h4 className="text-sm font-semibold text-primary">Inspect a GasFree account</h4>
            <p className="mt-xs text-xs text-tertiary">Queries the account associated with an EOA. It does not move funds or sign anything. Provider metadata is not a substitute for an independently verified chain balance.</p>
          </div>
        </div>
        <label className="flex flex-col gap-xs text-sm font-medium text-secondary">
          TRON EOA address
          <input value={accountAddress} onChange={(event) => setAccountAddress(event.target.value)} autoComplete="off" spellCheck={false} placeholder="T..." className="w-full rounded-md border border-primary bg-primary px-md py-sm font-mono text-sm text-primary" />
        </label>
        <button type="button" onClick={() => void inspectAccount()} disabled={accountLoading} className="w-full rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary disabled:opacity-50">
          {accountLoading ? 'Querying account…' : 'Inspect provider account'}
        </button>
        {accountError && <p role="alert" className="text-sm text-utility-danger-700">{accountError}</p>}
        {accountResult?.account && (
          <div className="rounded-lg border border-secondary bg-secondary p-md space-y-sm">
            <p className="text-sm font-semibold text-primary">Provider account response — {accountResult.network}</p>
            <p className="break-all text-xs text-tertiary">EOA: {accountResult.account.accountAddress}</p>
            <p className="break-all text-xs text-tertiary">GasFree account: {accountResult.account.gasFreeAddress}</p>
            <div className="grid grid-cols-2 gap-sm text-sm">
              <p className="text-secondary">Active: <strong>{accountResult.account.active ? 'Yes' : 'No'}</strong></p>
              <p className="text-secondary">Recommended nonce: <strong>{accountResult.account.nonce}</strong></p>
              <p className="text-secondary col-span-2">Provider allows another submission: <strong>{accountResult.account.allowSubmit ? 'Yes' : 'No'}</strong></p>
            </div>
            {accountResult.account.assets.length ? accountResult.account.assets.map((asset) => (
              <div key={asset.tokenAddress} className="rounded-md border border-secondary p-sm">
                <p className="text-sm font-semibold text-primary">{asset.tokenSymbol} — provider-reported asset metadata</p>
                <p className="break-all text-xs text-tertiary">Contract: {asset.tokenAddress}</p>
                <p className="text-xs text-secondary">Activation fee: {asset.activationFeeBaseUnits === null ? 'unknown' : `${formatBaseUnits(asset.activationFeeBaseUnits, asset.decimals)} ${asset.tokenSymbol}`}</p>
                <p className="text-xs text-secondary">Transfer fee: {asset.transferFeeBaseUnits === null ? 'unknown' : `${formatBaseUnits(asset.transferFeeBaseUnits, asset.decimals)} ${asset.tokenSymbol}`}</p>
                <p className="text-xs text-secondary">Frozen for pending transfers: {asset.frozenBaseUnits === null ? 'unknown' : `${formatBaseUnits(asset.frozenBaseUnits, asset.decimals)} ${asset.tokenSymbol}`}</p>
                <p className="text-xs text-tertiary">{asset.providerReportedBalanceBaseUnits === undefined ? 'Spendable balance not provided in the documented account response; it is unknown, not zero.' : `Provider-reported balance (not independently verified): ${formatBaseUnits(asset.providerReportedBalanceBaseUnits, asset.decimals)} ${asset.tokenSymbol}`}</p>
              </div>
            )) : <p className="text-xs text-tertiary">No assets were returned in the provider account response.</p>}
            <p className="text-xs text-tertiary">{accountResult.account.note}</p>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-secondary p-lg space-y-md">
        <div className="flex items-start gap-sm">
          <Activity className="size-5 shrink-0 text-brand-primary" aria-hidden="true" />
          <div>
            <h4 className="text-sm font-semibold text-primary">Track a provider-issued transfer trace</h4>
            <p className="mt-xs text-xs text-tertiary">Use a trace ID returned after a GasFree authorization is accepted. No submission occurs here, and a provider status is not final chain evidence.</p>
          </div>
        </div>
        <label className="flex flex-col gap-xs text-sm font-medium text-secondary">
          Provider trace ID
          <input value={traceId} onChange={(event) => setTraceId(event.target.value)} autoComplete="off" spellCheck={false} placeholder="trace ID returned by provider" className="w-full rounded-md border border-primary bg-primary px-md py-sm font-mono text-sm text-primary" />
        </label>
        <button type="button" onClick={() => void inspectTrace()} disabled={traceLoading} className="w-full rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary disabled:opacity-50">
          {traceLoading ? 'Checking transfer status…' : 'Query provider transfer status'}
        </button>
        {traceError && <p role="alert" className="text-sm text-utility-danger-700">{traceError}</p>}
        {traceResult?.trace && (
          <div className="rounded-lg border border-secondary bg-secondary p-md space-y-sm">
            <p className="text-sm font-semibold text-primary">Provider state: {traceResult.trace.state}</p>
            <p className="break-all text-xs text-tertiary">Trace ID: {traceResult.trace.traceId}</p>
            <p className="break-all text-xs text-tertiary">Transaction ID: {traceResult.trace.transactionId || 'Not reported yet'}</p>
            <p className="break-all text-xs text-tertiary">Receiver: {traceResult.trace.receiverAddress || 'Not reported'}</p>
            <p className="break-all text-xs text-tertiary">Token contract: {traceResult.trace.tokenAddress || 'Not reported'}</p>
            {traceResult.trace.amountBaseUnits && <p className="text-xs text-secondary">Transferred base units reported by provider: {traceResult.trace.amountBaseUnits}</p>}
            {traceResult.trace.maxFeeBaseUnits && <p className="text-xs text-secondary">Maximum authorized fee base units: {traceResult.trace.maxFeeBaseUnits}</p>}
            <p className="text-xs font-semibold text-utility-warning-700">Chain verification: not established by this trace lookup.</p>
            <p className="text-xs text-tertiary">{traceResult.trace.note}</p>
            <button
              type="button"
              onClick={() => void verifyTraceOnChain()}
              disabled={chainVerificationLoading || receiverBalanceLoading}
              className="w-full rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary disabled:opacity-50"
            >
              {chainVerificationLoading ? 'Verifying solidified chain evidence…' : 'Verify transaction and recheck receiver balance'}
            </button>
            {chainVerificationError && <p role="alert" className="text-sm text-utility-warning-700">{chainVerificationError}</p>}
            {chainVerificationResult && (
              <div className="rounded-lg border border-secondary p-md space-y-xs">
                <p className="flex items-center gap-xs text-sm font-semibold text-primary">
                  {chainVerificationResult.verified ? <BadgeCheck className="size-4 text-utility-success-700" aria-hidden="true" /> : null}
                  {chainVerificationResult.verified ? 'Transfer verified against solidified transaction and receipt' : `Chain verification: ${chainVerificationResult.status || 'not verified'}`}
                </p>
                {chainVerificationResult.blockNumber !== undefined && <p className="text-xs text-secondary">Solidified block: {chainVerificationResult.blockNumber}</p>}
                {chainVerificationResult.logIndex !== undefined && <p className="text-xs text-secondary">Matching Transfer event log index: {chainVerificationResult.logIndex}</p>}
                {chainVerificationResult.verified && <p className="text-xs text-tertiary">The exact contract, parties and amount matched a Transfer event in the solidified receipt. This still does not establish exchange-account credit.</p>}
                {chainVerificationResult.persistence && <p className="text-xs text-tertiary">Verification persistence: {chainVerificationResult.persistence.persisted ? 'saved' : `not saved — ${chainVerificationResult.persistence.reason || 'storage unavailable'}`}</p>}
              </div>
            )}
            {receiverBalanceLoading && <p role="status" className="text-xs text-tertiary">Reading receiver balance from the selected network’s solidified state…</p>}
            {receiverBalanceError && <p role="alert" className="text-sm text-utility-warning-700">{receiverBalanceError}</p>}
            {receiverBalance?.success && receiverBalance.balanceBaseUnits !== undefined && receiverBalance.decimals !== undefined && (
              <div className="rounded-lg border border-secondary bg-primary p-md space-y-xs">
                <p className="text-sm font-semibold text-primary">Solidified receiver token balance</p>
                <p className="text-lg font-semibold text-primary">{formatBaseUnits(receiverBalance.balanceBaseUnits, receiverBalance.decimals)}</p>
                <p className="break-all text-xs text-tertiary">Network: {receiverBalance.network || network}</p>
                <p className="break-all text-xs font-mono text-tertiary">Contract: {receiverBalance.tokenContract || traceResult.trace.tokenAddress}</p>
                <p className="break-all text-xs font-mono text-tertiary">Receiver: {receiverBalance.receiverAddress || traceResult.trace.receiverAddress}</p>
                <p className="text-xs text-tertiary">On-chain balance of this exact token contract, not proof of official token identity or exchange deposit credit.</p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-sm text-utility-warning-700">
        <p className="font-semibold">Not a confirmed free sponsor</p>
        <p className="mt-xs">{result?.feePolicy || 'GasFree documents activation and transfer fees denominated in the transferred token. Review the live schedule and the provider’s written terms.'}</p>
        <p className="mt-xs">{result?.note || 'Provider listing and API reachability do not prove funding or a zero-fee offer. Sponsored submission and sponsor-funded principal remain disabled.'}</p>
        <p className="mt-xs font-semibold">Live transfer submission: disabled. Sponsor funding verification: not established.</p>
      </div>
    </section>
  )
}
