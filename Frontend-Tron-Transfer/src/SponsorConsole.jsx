import { useCallback, useEffect, useState } from 'react'
import { Activity, Gauge, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'
import './sponsor-console.css'

const API = String(import.meta.env.VITE_RESOURCE_API_URL || 'https://tron-transfer-resource-api.onrender.com').replace(/\/$/, '')

function Metric({ label, value, suffix = '' }) {
  return <article className="sponsor-metric"><span>{label}</span><strong>{value ?? '—'}{suffix}</strong></article>
}

export default function SponsorConsole() {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [adminToken, setAdminToken] = useState('')
  const [stakeAmount, setStakeAmount] = useState('1')
  const [stakeResource, setStakeResource] = useState('ENERGY')
  const [plan, setPlan] = useState(null)
  const [planning, setPlanning] = useState(false)
  const [delegationTxid, setDelegationTxid] = useState('')
  const [requiredEnergy, setRequiredEnergy] = useState('0')
  const [requiredBandwidth, setRequiredBandwidth] = useState('0')
  const [verification, setVerification] = useState(null)
  const [verifying, setVerifying] = useState(false)
  const [operation, setOperation] = useState('stake')
  const [confirmationPhrase, setConfirmationPhrase] = useState('')
  const [operationResult, setOperationResult] = useState(null)
  const [executing, setExecuting] = useState(false)
  const [operationKey, setOperationKey] = useState(() => globalThis.crypto?.randomUUID?.() || '')

  const refresh = useCallback(async () => {
    setBusy(true); setError('')
    try {
      const response = await fetch(`${API}/api/tron/sponsor/status`, { headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(`Sponsor API returned HTTP ${response.status}`)
      const result = await response.json()
      if (!result.success) throw new Error('Sponsor status could not be loaded.')
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load Sponsor status.')
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])
  const runStakePreflight = async (event) => {
    event.preventDefault(); setPlanning(true); setPlan(null); setError('')
    try {
      const response = await fetch(`${API}/api/tron/sponsor/stake/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ amountTrx: stakeAmount, resource: stakeResource }) })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || result.plan?.status || 'Stake preflight failed.')
      setPlan(result.plan)
    } catch (e) { setError(e instanceof Error ? e.message : 'Stake preflight failed.') }
    finally { setPlanning(false); setAdminToken('') }
  }

  const verifyDelegation = async (event) => {
    event.preventDefault(); setVerifying(true); setVerification(null); setError('')
    try {
      const response = await fetch(`${API}/api/tron/sponsor/delegation/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ transactionId: delegationTxid.trim(), required: { ENERGY: requiredEnergy, BANDWIDTH: requiredBandwidth } }) })
      const result = await response.json()
      if (!result.verification) throw new Error(result.error || 'Delegation verification failed.')
      setVerification(result.verification)
    } catch (e) { setError(e instanceof Error ? e.message : 'Delegation verification failed.') }
    finally { setVerifying(false); setAdminToken('') }
  }

  const executeSponsorOperation = async (event) => {
    event.preventDefault(); setExecuting(true); setOperationResult(null); setError('')
    try {
      if (!operationKey) throw new Error('Secure idempotency key generation is unavailable in this browser.')
      const [whole, fraction = ''] = stakeAmount.split('.')
      if (!/^(0|[1-9][0-9]*)$/.test(whole) || !/^[0-9]{0,6}$/.test(fraction)) throw new Error('Enter a valid TRX amount with up to six decimals.')
      const amountSun = (BigInt(whole) * 1000000n + BigInt((fraction + '000000').slice(0, 6))).toString()
      const response = await fetch(`${API}/api/tron/sponsor/transaction/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ operation, amountSun, resource: stakeResource, idempotencyKey: operationKey, confirmPhrase: confirmationPhrase }) })
      const result = await response.json()
      setOperationResult(result)
      if (!response.ok) throw new Error(result.error || result.resultCode || 'Sponsor transaction was not completed.')
      if (result.solidified) { setConfirmationPhrase(''); setAdminToken(''); setOperationKey(globalThis.crypto?.randomUUID?.() || '') }
    } catch (e) { setError(e instanceof Error ? e.message : 'Sponsor transaction failed. Do not retry with a new idempotency key until the previous outcome is reconciled.') }
    finally { setExecuting(false) }
  }

  const sponsor = data?.sponsor
  const resources = sponsor?.resources
  const caps = data?.capabilities
  const readiness = data?.readiness

  return <section className="sponsor-console" aria-labelledby="sponsor-title">
    <div className="sponsor-console-heading">
      <div><span className="sponsor-eyebrow">INDEPENDENT RESOURCE PROVIDER · TRON MAINNET</span><h2 id="sponsor-title">TRON TRANSFER Sponsor</h2><p>Dedicated Sponsor account status, staking limits and resource delegation readiness.</p></div>
      <button type="button" onClick={refresh} disabled={busy}><RefreshCw size={15}/> {busy ? 'Refreshing…' : 'Refresh Mainnet'}</button>
    </div>
    {error && <p className="sponsor-error" role="alert">{error}</p>}
    <div className="sponsor-metrics">
      <Metric label="Sponsor TRX balance" value={sponsor?.account?.trx?.toFixed(6)} suffix=" TRX"/>
      <Metric label="Spendable after reserve" value={readiness?.spendableTrxAfterReserve?.toFixed(6)} suffix=" TRX"/>
      <Metric label="Energy available" value={resources ? Math.max(0, resources.energyLimit - resources.energyUsed).toLocaleString() : null}/>
      <Metric label="Free Bandwidth" value={resources ? Math.max(0, resources.freeNetLimit - resources.freeNetUsed).toLocaleString() : null}/>
      <Metric label="Staked Bandwidth" value={resources ? Math.max(0, resources.netLimit - resources.netUsed).toLocaleString() : null}/>
    </div>
    <div className="sponsor-panels">
      <article><h3><Wallet size={17}/> Wallet identities</h3><p>Sponsor: <code>{sponsor?.account?.address || 'Not configured'}</code></p><p>Owner recipient: <code>{data?.owner?.address || 'Not configured'}</code></p><p>Network: <strong>{data?.network || 'Checking…'}</strong></p></article>
      <article><h3><Gauge size={17}/> Stake 2.0 limits</h3><p>Application policy floor: <strong>{data?.limits?.minimumStakeTrx ?? 1} TRX per operation</strong></p><p>Automatic stake ceiling: <strong>{data?.limits?.maximumAutomaticStakeTrx ?? 10} TRX</strong></p><p>Protected liquid reserve: <strong>{data?.limits?.protectedLiquidReserveTrx ?? 2} TRX</strong></p><p>Automatic unstaking: <strong>Disabled</strong></p></article>
      <article><h3><ShieldCheck size={17}/> Signing readiness</h3><p>Server signer address match: <strong>{caps?.serverSignerAddressMatches ? 'Verified' : 'Not verified'}</strong></p><p>Admin authorization: <strong>{caps?.adminAuthorizationConfigured ? 'Configured' : 'Not configured'}</strong></p><p>Transaction engine: <strong>{caps?.stakingEnabled ? 'Configured · activation gated' : 'Disabled'}</strong></p><p className="sponsor-warning">{caps?.reason || 'Readiness is being checked.'}</p></article>
    </div>
    <article className="sponsor-readiness"><h3>Mainnet readiness checks</h3><p>Independent Sponsor / Owner identities: <strong>{readiness?.sponsorOwnerIdentityVerified ? 'Verified' : 'Not verified'}</strong></p><p>Stake operation: <strong>Disabled pending signer review</strong></p><p>Owner contract deployment: <strong>Not authorized by Sponsor status</strong></p>{readiness?.blockers?.length > 0 && <ul>{readiness.blockers.map((item) => <li key={item}>{item}</li>)}</ul>}</article>
    <form className="sponsor-stake-planner" onSubmit={runStakePreflight}>
      <h3>Stake 2.0 policy preflight</h3>
      <p>Validate a proposed Sponsor stake against a fresh Mainnet balance, the 2 TRX protected reserve and the configured automatic stake ceiling. This does not create or sign a transaction.</p>
      <label>Admin authorization token<input type="password" autoComplete="off" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} required minLength={32} placeholder="Enter your server-configured Sponsor admin token" /></label>
      <label>Stake amount (TRX)<input inputMode="decimal" value={stakeAmount} onChange={(event) => setStakeAmount(event.target.value)} required pattern="[0-9]+(\.[0-9]{1,6})?" /></label>
      <label>Resource<select value={stakeResource} onChange={(event) => setStakeResource(event.target.value)}><option value="ENERGY">Energy</option><option value="BANDWIDTH">Bandwidth</option></select></label>
      <button type="submit" disabled={planning || !adminToken}>{planning ? 'Checking Mainnet…' : 'Run Stake Preflight'}</button>
      {plan && <p className="sponsor-plan-success" role="status">Preflight passed: {plan.amountTrx} TRX for {plan.resource}. Remaining liquid balance: {(Number(plan.remainingLiquidBalanceSun) / 1000000).toFixed(6)} TRX. No transaction created, signed or broadcast.</p>}
    </form>
    <form className="sponsor-stake-planner" onSubmit={verifyDelegation}>
      <h3>Verify Owner delegation on Mainnet</h3>
      <p>Enter the Sponsor delegation transaction ID. The API checks the solidified transaction, successful receipt, Owner recipient, delegation record and current Owner resource capacity. It does not broadcast.</p>
      <label>Admin authorization token<input type="password" autoComplete="off" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} required minLength={32} /></label>
      <label>Delegation transaction ID<input value={delegationTxid} onChange={(event) => setDelegationTxid(event.target.value)} required minLength={64} maxLength={64} pattern="[a-fA-F0-9]{64}" /></label>
      <label>Required Energy (units)<input inputMode="numeric" value={requiredEnergy} onChange={(event) => setRequiredEnergy(event.target.value)} required pattern="[0-9]+" /></label>
      <label>Required Bandwidth (units)<input inputMode="numeric" value={requiredBandwidth} onChange={(event) => setRequiredBandwidth(event.target.value)} required pattern="[0-9]+" /></label>
      <button type="submit" disabled={verifying || !adminToken}>{verifying ? 'Verifying solidified state…' : 'Verify Owner Delegation'}</button>
      {verification && <p className={verification.verified ? 'sponsor-plan-success' : 'sponsor-error'} role="status">{verification.status} · Solidified: {verification.solidified ? 'Yes' : 'No'} · Energy: {verification.ENERGY ?? '—'} · Bandwidth: {verification.BANDWIDTH ?? '—'}</p>}
    </form>
    <form className="sponsor-stake-planner" onSubmit={executeSponsorOperation}>
      <h3>Stake 2.0 Mainnet transaction</h3>
      <p>Creates and signs a real Mainnet transaction using the server-held Sponsor key only when both backend execution flags are enabled. Every operation requires explicit confirmation and a durable idempotency record.</p>
      <label>Operation<select value={operation} onChange={(event) => setOperation(event.target.value)}><option value="stake">Stake TRX 2.0</option><option value="delegate">Delegate frozen resource to Owner</option></select></label>
      <label>Amount (TRX)<input inputMode="decimal" value={stakeAmount} onChange={(event) => setStakeAmount(event.target.value)} required pattern="[0-9]+(\.[0-9]{1,6})?" /></label>
      <label>Resource<select value={stakeResource} onChange={(event) => setStakeResource(event.target.value)}><option value="ENERGY">Energy</option><option value="BANDWIDTH">Bandwidth</option></select></label>
      <label>Admin authorization token<input type="password" autoComplete="off" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} required minLength={32} /></label>
      <label>Type exact confirmation phrase<input value={confirmationPhrase} onChange={(event) => setConfirmationPhrase(event.target.value)} autoComplete="off" required /></label>
      <p className="sponsor-warning">Required phrase: <code>CONFIRM TRON MAINNET SPONSOR TRANSACTION</code>. This can lock Sponsor TRX or delegate frozen resources. Confirm the amount and Owner address before proceeding.</p>
      <button type="submit" disabled={executing || !adminToken || !operationKey || (operation === 'stake' ? !caps?.canStake : !caps?.canDelegate)}>{executing ? 'Submitting Mainnet transaction…' : operation === 'stake' ? 'Confirm & Stake on Mainnet' : 'Confirm & Delegate to Owner'}</button>
      {operationResult && <p className={operationResult.solidified ? 'sponsor-plan-success' : 'sponsor-error'} role="status">{operationResult.resultCode || operationResult.error || operationResult.operationStatus} · TX: {operationResult.transactionId || 'Not returned'} · Solidified: {operationResult.solidified ? 'Yes' : 'No'} · Retry allowed: {operationResult.retryAllowed ? 'Yes' : 'No'}</p>}
    </form>
    <div className="sponsor-actions">
      <button type="button" disabled title="Requires the reviewed server-side Stake 2.0 signer">Stake for Energy</button>
      <button type="button" disabled title="Requires the reviewed server-side Stake 2.0 signer">Stake for Bandwidth</button>
      <button type="button" disabled title="Requires verified staking and authenticated delegation service">Delegate to Owner</button>
      <button type="button" disabled title="Automatic unstaking is intentionally disabled">Unstake / Reclaim</button>
    </div>
    <p className="sponsor-footnote"><Activity size={14}/> This page displays live Mainnet resources. Transaction submission is gated by server-side feature flags, a matching Sponsor signer, admin authorization, durable idempotency, and exact per-operation confirmation. A broadcast is not reported as complete until solidified verification succeeds.</p>
  </section>
}
