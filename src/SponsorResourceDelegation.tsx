import { useState } from 'react'
import { Activity, CheckCircle2, ExternalLink, RefreshCw, ShieldCheck, TriangleAlert, Zap } from 'lucide-react'

type Props = { network: 'shasta' | 'nile' | 'mainnet'; walletAddress?: string }
type Resource = 'ENERGY' | 'BANDWIDTH'
type DelegationRecord = { transactionId: string; owner: string; receiver: string; resource: Resource; amountSun: string }
type Verification = { status: 'verified' | 'pending' | 'failed'; message: string; blockNumber?: number; delegatedBaseUnits?: string; persistence?: { persisted: boolean; duplicate?: boolean; reason?: string } }

const SHASTA_RPC = 'https://api.shasta.trongrid.io'
const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\\/+$/, '')
const MIN_DELEGATION_SUN = 1_000_000n

function parseTrxToSun(value: string): bigint {
  const input = value.trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(input)) {
    throw new Error('Enter a positive TRX amount with no more than 6 decimal places.')
  }
  const [whole, fraction = ''] = input.split('.')
  const amount = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
  if (amount < MIN_DELEGATION_SUN) throw new Error('TRON requires at least 1 TRX equivalent for a resource delegation.')
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount is too large for the transaction builder.')
  return amount
}

function formatSun(value: string | bigint): string {
  const amount = typeof value === 'bigint' ? value : BigInt(value)
  const whole = amount / 1_000_000n
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? whole.toString() + '.' + fraction : whole.toString()
}

function normalizeBase58Address(tronWeb: any, value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    const address = value.startsWith('T') ? value : tronWeb.address.fromHex(value)
    return tronWeb.address.toHex(address).replace(/^0x/i, '').toLowerCase()
  } catch {
    return ''
  }
}

function getSelectedShastaTronWeb(expectedAddress: string, selectedNetwork: string) {
  if (selectedNetwork !== 'shasta') throw new Error('Resource delegation is currently restricted to Shasta testnet. Mainnet delegation is not enabled in this workspace.')
  const provider = (window as any).tron
  const tronWeb = provider?.isTronLink === true ? provider.tronWeb : null
  if (!tronWeb?.defaultAddress?.base58 || typeof tronWeb.trx?.getCanDelegatedMaxSize !== 'function') {
    throw new Error('TronLink is unavailable or does not support confirmed resource queries. Open this page in the TronLink browser and reconnect.')
  }
  const rawHost = String(tronWeb.fullNode?.host || tronWeb.fullNode?.nodeUrl || '')
  let parsed: URL
  try { parsed = new URL(rawHost) } catch { throw new Error('Could not verify TronLink’s selected network endpoint.') }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'api.shasta.trongrid.io'
    || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new Error('Safety check failed: TronLink must use the recognized HTTPS Shasta node for this test-only operation.')
  }
  if (expectedAddress && tronWeb.defaultAddress.base58 !== expectedAddress) {
    throw new Error('The connected wallet account has changed. Reconnect from the page header before continuing.')
  }
  if (!tronWeb.isAddress(tronWeb.defaultAddress.base58)) throw new Error('TronLink returned an invalid sponsor address.')
  return { tronWeb, sponsorAddress: tronWeb.defaultAddress.base58 }
}

/**
 * Manual sponsor resource delegation. The connected sponsor signs with TronLink;
 * the app never sees a private key. This is an on-chain Stake-2.0 operation, not a
 * token transfer or a provider API submission.
 */
export default function SponsorResourceDelegation({ network, walletAddress = '' }: Props) {
  const [receiver, setReceiver] = useState('')
  const [resource, setResource] = useState<Resource>('ENERGY')
  const [amountTrx, setAmountTrx] = useState('10')
  const [capacity, setCapacity] = useState<{ energy: string; bandwidth: string } | null>(null)
  const [capacityLoading, setCapacityLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [record, setRecord] = useState<DelegationRecord | null>(null)
  const [verification, setVerification] = useState<Verification | null>(null)
  const [notice, setNotice] = useState<{ kind: 'info' | 'success' | 'error'; text: string } | null>(null)

  const refreshCapacity = async () => {
    setCapacityLoading(true)
    setNotice(null)
    try {
      const { tronWeb, sponsorAddress } = getSelectedShastaTronWeb(walletAddress, network)
      const [energy, bandwidth] = await Promise.all([
        tronWeb.trx.getCanDelegatedMaxSize(sponsorAddress, 'ENERGY', { confirmed: true }),
        tronWeb.trx.getCanDelegatedMaxSize(sponsorAddress, 'BANDWIDTH', { confirmed: true }),
      ])
      const energySun = typeof energy?.max_size === 'string' ? energy.max_size
        : Number.isSafeInteger(energy?.max_size) && energy.max_size >= 0 ? String(energy.max_size) : null
      const bandwidthSun = typeof bandwidth?.max_size === 'string' ? bandwidth.max_size
        : Number.isSafeInteger(bandwidth?.max_size) && bandwidth.max_size >= 0 ? String(bandwidth.max_size) : null
      if (!energySun || !bandwidthSun || !/^(0|[1-9][0-9]*)$/.test(energySun) || !/^(0|[1-9][0-9]*)$/.test(bandwidthSun)) {
        throw new Error('Shasta did not return valid confirmed delegation limits. No transaction was submitted.')
      }
      setCapacity({ energy: energySun, bandwidth: bandwidthSun })
      setNotice({ kind: 'success', text: 'Current maximum delegatable stake-equivalent amounts were read from Shasta solidified state. These are TRX-equivalent stake amounts, not Energy units.' })
    } catch (error) {
      setCapacity(null)
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not read delegation capacity from Shasta.' })
    } finally {
      setCapacityLoading(false)
    }
  }

  const verifyDelegation = async (nextRecord = record) => {
    if (!nextRecord) {
      setNotice({ kind: 'error', text: 'Submit a delegation first; there is no transaction to verify.' })
      return
    }
    setVerification(null)
    setNotice({ kind: 'info', text: 'Checking transaction body, solidified receipt, and the resulting delegation record on Shasta…' })
    try {
      const { tronWeb } = getSelectedShastaTronWeb(nextRecord.owner, network)
      const postSolidified = async (path: string) => {
        const response = await fetch(SHASTA_RPC + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ value: nextRecord.transactionId }),
          cache: 'no-store',
        })
        if (!response.ok) throw new Error('Shasta solidified endpoint is unavailable.')
        return response.json()
      }
      const [transaction, info] = await Promise.all([
        postSolidified('/walletsolidity/gettransactionbyid'),
        postSolidified('/walletsolidity/gettransactioninfobyid'),
      ])
      if (!transaction?.txID || !info || Object.keys(info).length === 0 || !Number.isInteger(info.blockNumber)) {
        const pending = { status: 'pending' as const, message: 'The transaction is not yet present in solidified Shasta state. It is not marked verified; retry verification later and do not submit a second delegation.' }
        setVerification(pending)
        setNotice({ kind: 'info', text: pending.message })
        return
      }
      const contract = transaction.raw_data?.contract?.find((entry: any) => entry?.type === 'DelegateResourceContract')
      const value = contract?.parameter?.value
      const expectedResource = nextRecord.resource === 'ENERGY' ? 1 : 0
      const ownerHex = normalizeBase58Address(tronWeb, value?.owner_address)
      const receiverHex = normalizeBase58Address(tronWeb, value?.receiver_address)
      const expectedOwnerHex = normalizeBase58Address(tronWeb, nextRecord.owner)
      const expectedReceiverHex = normalizeBase58Address(tronWeb, nextRecord.receiver)
      const amountText = typeof value?.balance === 'number' && Number.isSafeInteger(value.balance)
        ? String(value.balance) : typeof value?.balance === 'string' ? value.balance : ''
      const transactionSucceeded = transaction.ret?.[0]?.contractRet === 'SUCCESS'
        && String(info.result || '').toUpperCase() !== 'FAILED'
      const exactTransaction = transaction.txID.toLowerCase() === nextRecord.transactionId.toLowerCase()
        && ownerHex !== '' && ownerHex === expectedOwnerHex
        && receiverHex !== '' && receiverHex === expectedReceiverHex
        && /^(0|[1-9][0-9]*)$/.test(amountText)
        && BigInt(amountText) === BigInt(nextRecord.amountSun)
        && Number(value?.resource) === expectedResource

      if (!exactTransaction || !transactionSucceeded) {
        const failed = { status: 'failed' as const, message: 'The solidified transaction does not match the exact expected sponsor, receiver, resource, amount, or successful execution. Do not treat this delegation as confirmed.' }
        setVerification(failed)
        setNotice({ kind: 'error', text: failed.message })
        return
      }

      if (typeof tronWeb.trx?.getDelegatedResourceV2 !== 'function') {
        const inconclusive = { status: 'pending' as const, blockNumber: info.blockNumber, message: 'The solidified delegation transaction matches, but this wallet’s TronWeb does not expose a confirmed delegation-state query. Transaction state is confirmed; resulting resource balance remains unverified.' }
        setVerification(inconclusive)
        setNotice({ kind: 'info', text: inconclusive.message })
        return
      }
      const delegatedPayload = await tronWeb.trx.getDelegatedResourceV2(nextRecord.owner, nextRecord.receiver, { confirmed: true })
      const rows = Array.isArray(delegatedPayload?.delegatedResource) ? delegatedPayload.delegatedResource : []
      const balanceKey = nextRecord.resource === 'ENERGY' ? 'frozen_balance_for_energy' : 'frozen_balance_for_bandwidth'
      const verifiedSun = rows
        .filter((row: any) => normalizeBase58Address(tronWeb, row?.from) === expectedOwnerHex
          && normalizeBase58Address(tronWeb, row?.to) === expectedReceiverHex)
        .reduce((total: bigint, row: any) => {
          const field = row?.[balanceKey]
          const textValue = typeof field === 'number' && Number.isSafeInteger(field) ? String(field)
            : typeof field === 'string' ? field : '0'
          return /^(0|[1-9][0-9]*)$/.test(textValue) ? total + BigInt(textValue) : total
        }, 0n)
      if (verifiedSun < BigInt(nextRecord.amountSun)) {
        const inconclusive = { status: 'pending' as const, blockNumber: info.blockNumber, delegatedBaseUnits: verifiedSun.toString(), message: 'The delegation transaction is solidified, but the recipient’s confirmed delegation record does not yet show the full expected resource allocation.' }
        setVerification(inconclusive)
        setNotice({ kind: 'info', text: inconclusive.message })
        return
      }
      const baseSuccessMessage = 'Solidified Shasta transaction and confirmed recipient delegation record match the exact sponsor, receiver, resource type, and amount.'
      let persistence: Verification['persistence'] = { persisted: false, reason: 'audit-persistence-not-confirmed' }
      try {
        const auditResponse = await fetch(API_BASE + '/api/tron/sponsorship/resource-delegations/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            network: 'shasta',
            transactionId: nextRecord.transactionId,
            sponsorAddress: nextRecord.owner,
            receiverAddress: nextRecord.receiver,
            resourceType: nextRecord.resource,
            stakeEquivalentSun: nextRecord.amountSun,
          }),
          cache: 'no-store',
        })
        const auditPayload = await auditResponse.json().catch(() => null)
        persistence = {
          persisted: auditResponse.ok && auditPayload?.verified === true && auditPayload?.persistence?.persisted === true,
          duplicate: auditPayload?.persistence?.duplicate === true,
          reason: auditPayload?.persistence?.reason || auditPayload?.error || (!auditResponse.ok ? `audit-api-http-${auditResponse.status}` : 'audit-persistence-not-confirmed'),
        }
      } catch {
        persistence = { persisted: false, reason: 'audit-api-unavailable' }
      }
      const success = { status: 'verified' as const, blockNumber: info.blockNumber, delegatedBaseUnits: verifiedSun.toString(), message: baseSuccessMessage, persistence }
      setVerification(success)
      setNotice(persistence.persisted
        ? { kind: 'success', text: baseSuccessMessage + ' Server independently re-verified and saved this evidence to the project audit ledger. This is resource delegation only; it does not prove a later token transfer or promise zero TRX fees.' }
        : { kind: 'error', text: baseSuccessMessage + ' However, the backend did not confirm audit persistence (' + persistence.reason + '). The on-chain delegation remains verified in this session; retry the verification action before relying on project audit history.' })
    } catch (error) {
      const failure = { status: 'pending' as const, message: error instanceof Error ? error.message : 'Solidified delegation verification is unavailable.' }
      setVerification(failure)
      setNotice({ kind: 'info', text: failure.message })
    }
  }

  const submitDelegation = async () => {
    setSubmitting(true)
    setRecord(null)
    setVerification(null)
    setNotice(null)
    try {
      if (network !== 'shasta') throw new Error('The live resource-delegation action is Shasta-testnet only. No Mainnet action is enabled.')
      const { tronWeb, sponsorAddress } = getSelectedShastaTronWeb(walletAddress, network)
      const recipientAddress = receiver.trim()
      if (!tronWeb.isAddress(recipientAddress)) throw new Error('Enter a valid TRON Base58 receiver wallet address.')
      if (recipientAddress === sponsorAddress) throw new Error('A sponsor cannot delegate resources to the same wallet.')
      const amountSun = parseTrxToSun(amountTrx)
      const currentCapacity = await tronWeb.trx.getCanDelegatedMaxSize(sponsorAddress, resource, { confirmed: true })
      const maxText = typeof currentCapacity?.max_size === 'string' ? currentCapacity.max_size
        : Number.isSafeInteger(currentCapacity?.max_size) && currentCapacity.max_size >= 0 ? String(currentCapacity.max_size) : ''
      if (!/^(0|[1-9][0-9]*)$/.test(maxText) || BigInt(maxText) < amountSun) {
        throw new Error('The current solidified delegation limit is lower than this requested amount. Refresh capacity and reduce the amount.')
      }
      const amountLabel = formatSun(amountSun)
      const confirmed = window.confirm(
        'Confirm Shasta resource delegation\n\nSponsor wallet: ' + sponsorAddress
        + '\nRecipient wallet receiving delegated resources: ' + recipientAddress
        + '\nResource: ' + resource
        + '\nStake-equivalent amount: ' + amountLabel + ' TRX'
        + '\n\nThis delegates resources from your existing Stake-2.0 allocation. It does NOT transfer the TRX principal, does NOT send tokens, and does NOT guarantee the recipient will pay zero TRX for every transaction. Delegation is unlocked and can be reclaimed by the sponsor, which may reduce the recipient’s available resources. Shasta has no Mainnet value. TronLink will request your approval. Continue?'
      )
      if (!confirmed) {
        setNotice({ kind: 'info', text: 'Delegation cancelled before signing; no transaction was submitted.' })
        return
      }

      // Build immediately before signing so transaction expiry does not occur while the form is open.
      const unsigned = await tronWeb.transactionBuilder.delegateResource(
        Number(amountSun), recipientAddress, resource, sponsorAddress, false, 0,
      )
      const contract = unsigned?.raw_data?.contract?.find((entry: any) => entry?.type === 'DelegateResourceContract')
      const value = contract?.parameter?.value
      const expectedResource = resource === 'ENERGY' ? 1 : 0
      if (!unsigned?.txID
        || normalizeBase58Address(tronWeb, value?.owner_address) !== normalizeBase58Address(tronWeb, sponsorAddress)
        || normalizeBase58Address(tronWeb, value?.receiver_address) !== normalizeBase58Address(tronWeb, recipientAddress)
        || BigInt(String(value?.balance ?? -1)) !== amountSun
        || Number(value?.resource) !== expectedResource) {
        throw new Error('Transaction builder output did not match the reviewed delegation details. The signing request was cancelled.')
      }

      // Re-check account and endpoint immediately before wallet signing.
      const { tronWeb: signer } = getSelectedShastaTronWeb(sponsorAddress, network)
      const signed = await signer.trx.sign(unsigned)
      if (!Array.isArray(signed?.signature) || signed.signature.length === 0) {
        throw new Error('TronLink did not return a signed transaction. No transaction was broadcast.')
      }
      // Never broadcast after account/network changes during the wallet prompt.
      const { tronWeb: broadcaster } = getSelectedShastaTronWeb(sponsorAddress, network)
      const broadcast: any = await broadcaster.trx.sendRawTransaction(signed)
      const transactionId = signed.txID || broadcast?.txid || broadcast?.txID || unsigned.txID
      if (broadcast?.result !== true || typeof transactionId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(transactionId)) {
        throw new Error('Shasta did not confirm transaction acceptance. Check TronLink activity and verify the transaction ID before retrying; do not blindly submit a duplicate.')
      }

      const submitted: DelegationRecord = { transactionId, owner: sponsorAddress, receiver: recipientAddress, resource, amountSun: amountSun.toString() }
      setRecord(submitted)
      setNotice({ kind: 'info', text: 'Delegation transaction accepted by Shasta. It is submitted, not yet verified. Verify the solidified receipt before considering the resources active.' })
      await verifyDelegation(submitted)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Resource delegation failed before confirmation.' })
    } finally {
      setSubmitting(false)
    }
  }

  const isShasta = network === 'shasta'
  const selectedMax = capacity ? (resource === 'ENERGY' ? capacity.energy : capacity.bandwidth) : null

  return (
    <section className="resource-delegation-panel rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-lg" aria-labelledby="resource-delegation-title">
      <div className="flex items-start gap-md">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-utility-brand-200 bg-utility-brand-50">
          <Zap className="size-5 text-fg-brand-primary" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-brand-primary">Live on-chain action · Shasta testnet</p>
          <h2 id="resource-delegation-title" className="mt-xs text-heading-xs font-semibold text-primary">Sponsor Energy / Bandwidth delegation</h2>
          <p className="mt-xs text-sm text-tertiary">Delegate already-staked resources from the connected sponsor wallet to a sender wallet using TronLink. The stake remains owned by the sponsor; this sends no TRX principal or tokens.</p>
        </div>
      </div>

      {!isShasta && <div role="alert" className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-sm text-utility-warning-700">Live delegation is locked to Shasta testnet in this release. Switch the app and TronLink to Shasta to use it. Mainnet delegation and automatic sponsor-fee claims remain disabled.</div>}
      {isShasta && !walletAddress && <div role="status" className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-sm text-utility-warning-700">Connect the sponsor wallet using the page header first. The sponsor must hold Stake-2.0 resources on Shasta and explicitly approve this operation in TronLink.</div>}

      <div className="rounded-lg border border-secondary bg-secondary p-md space-y-xs">
        <p className="text-xs font-semibold text-secondary">Connected sponsor wallet</p>
        <p className="break-all font-mono text-sm text-primary">{walletAddress || 'Not connected'}</p>
      </div>

      <div className="grid grid-cols-1 gap-md md:grid-cols-2">
        <label className="flex flex-col gap-xs text-sm font-medium text-secondary">
          Recipient sender wallet
          <input value={receiver} onChange={(event) => setReceiver(event.target.value)} autoComplete="off" spellCheck={false} placeholder="TRON Base58 account starting with T" className="w-full rounded-lg border border-primary bg-primary px-md py-sm text-sm text-primary" />
          <span className="text-xs font-normal text-tertiary">Enter the wallet that will later submit its own token transfer. Do not enter an exchange deposit unless you control and understand that account.</span>
        </label>
        <label className="flex flex-col gap-xs text-sm font-medium text-secondary">
          Resource type
          <select value={resource} onChange={(event) => setResource(event.target.value as Resource)} className="w-full rounded-lg border border-primary bg-primary px-md py-sm text-sm text-primary">
            <option value="ENERGY">Energy (for smart-contract calls)</option>
            <option value="BANDWIDTH">Bandwidth (transaction bytes)</option>
          </select>
          <span className="text-xs font-normal text-tertiary">Energy and Bandwidth are separate resources; delegating one does not guarantee both costs are covered.</span>
        </label>
        <label className="flex flex-col gap-xs text-sm font-medium text-secondary md:col-span-2">
          Amount to delegate (stake equivalent in TRX)
          <input value={amountTrx} onChange={(event) => setAmountTrx(event.target.value)} inputMode="decimal" autoComplete="off" placeholder="10" className="w-full rounded-lg border border-primary bg-primary px-md py-sm text-sm text-primary" />
          <span className="text-xs font-normal text-tertiary">Minimum 1 TRX equivalent. This is a delegation limit amount, not the number of Energy units and not a transfer of that TRX principal.</span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-sm">
        <button type="button" onClick={() => void refreshCapacity()} disabled={!isShasta || !walletAddress || capacityLoading || submitting} className="inline-flex items-center justify-center gap-sm rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary disabled:cursor-not-allowed disabled:opacity-50">
          {capacityLoading ? <RefreshCw className="size-4 animate-spin" aria-hidden="true" /> : <Activity className="size-4" aria-hidden="true" />}
          {capacityLoading ? 'Reading confirmed capacity…' : 'Check sponsor delegation capacity'}
        </button>
        <button type="button" onClick={() => void submitDelegation()} disabled={!isShasta || !walletAddress || submitting || !receiver.trim()} className="inline-flex items-center justify-center gap-sm rounded-lg border border-transparent bg-brand-solid px-md py-sm text-sm font-semibold text-primary-on-brand disabled:cursor-not-allowed disabled:opacity-50">
          {submitting ? <RefreshCw className="size-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="size-4" aria-hidden="true" />}
          {submitting ? 'Submitting / verifying…' : 'Review and delegate resources'}
        </button>
      </div>

      {selectedMax !== null && <div className="rounded-lg border border-secondary bg-secondary p-md space-y-xs" aria-live="polite">
        <p className="text-sm font-semibold text-primary">Confirmed maximum delegation capacity</p>
        <p className="text-sm text-secondary">Energy: {formatSun(capacity!.energy)} TRX-equivalent stake</p>
        <p className="text-sm text-secondary">Bandwidth: {formatSun(capacity!.bandwidth)} TRX-equivalent stake</p>
        <p className="text-xs text-tertiary">Current selected resource limit: {formatSun(selectedMax)} TRX-equivalent stake. Limits can change before signing, so the action rechecks this cap.</p>
      </div>}

      {record && <div className="rounded-lg border border-secondary bg-secondary p-md space-y-sm" aria-live="polite">
        <p className="text-sm font-semibold text-primary">Delegation transaction</p>
        <p className="break-all font-mono text-xs text-secondary">{record.transactionId}</p>
        <p className="text-xs text-tertiary">From {record.owner} → {record.receiver}; {record.resource}; {formatSun(record.amountSun)} TRX-equivalent stake.</p>
        <div className="flex flex-wrap items-center gap-sm">
          <button type="button" onClick={() => void verifyDelegation()} disabled={submitting} className="inline-flex items-center gap-sm rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary disabled:opacity-50">
            <RefreshCw className="size-4" aria-hidden="true" /> Re-check solidified delegation
          </button>
          <a href={'https://shasta.tronscan.org/#/transaction/' + encodeURIComponent(record.transactionId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-xs text-sm font-semibold text-brand-primary">
            Open Shasta explorer <ExternalLink className="size-4" aria-hidden="true" />
          </a>
        </div>
        {verification && <div className="rounded-md border border-secondary p-md">
          <p className="flex items-center gap-sm text-sm font-semibold text-primary">
            {verification.status === 'verified' ? <CheckCircle2 className="size-4 text-utility-success-600" aria-hidden="true" /> : <TriangleAlert className="size-4 text-utility-warning-600" aria-hidden="true" />}
            {verification.status === 'verified' ? 'Solidified delegation verified' : verification.status === 'pending' ? 'Delegation not yet fully verified' : 'Delegation verification failed'}
          </p>
          <p className="mt-xs text-xs text-secondary">{verification.message}</p>
          {verification.blockNumber && <p className="mt-xs text-xs text-tertiary">Solidified block: {verification.blockNumber}</p>}
          {verification.delegatedBaseUnits && <p className="mt-xs text-xs text-tertiary">Confirmed delegation: {formatSun(verification.delegatedBaseUnits)} TRX-equivalent stake.</p>}
          {verification.persistence && <p className={`mt-xs text-xs ${verification.persistence.persisted ? 'text-utility-success-600' : 'text-utility-warning-700'}`}>Project audit ledger: {verification.persistence.persisted ? (verification.persistence.duplicate ? 'already saved (idempotent record)' : 'verified evidence saved') : 'not confirmed — ' + (verification.persistence.reason || 'unknown reason')}</p>}
        </div>}
      </div>}

      {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} aria-live="polite" className={`rounded-lg border p-md text-sm ${notice.kind === 'error' ? 'border-utility-error-200 bg-utility-error-50 text-utility-error-700' : notice.kind === 'success' ? 'border-utility-success-200 bg-utility-success-50 text-utility-success-700' : 'border-secondary bg-secondary text-secondary'}`}>{notice.text}</p>}

      <p className="text-xs text-tertiary">Important: this is a real Stake-2.0 resource delegation when the sponsor signs and the solidified chain verifies it. It is not a paid provider relay, does not transfer token principal, does not guarantee zero TRX expense, and does not enable automatic sponsored submission. Before the sender transfers tokens, confirm the actual receiver, token contract, sender balance, network and current resources. Never interpret a delegated resource amount as a spendable TRX or USDT balance.</p>
    </section>
  )
}
