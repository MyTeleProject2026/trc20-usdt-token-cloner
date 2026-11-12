import { useEffect, useState } from 'react'
import { ExternalLink, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react'
import { TronWeb } from 'tronweb'

const BITPIE_ADDRESS = String(import.meta.env.VITE_RESTRICTED_TRX_BENEFICIARY_ADDRESS || 'TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT').trim()
const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\/+$/, '')
const ESCROW_ADDRESS = String(import.meta.env.VITE_RESTRICTED_TRX_ESCROW_ADDRESS || '').trim()
const ABI = [{
  inputs: [{ name: 'requestId', type: 'bytes32' }],
  name: 'getPosition',
  outputs: [
    { name: 'beneficiary', type: 'address' },
    { name: 'amountSun', type: 'uint256' },
    { name: 'unlockAt', type: 'uint64' },
    { name: 'claimed', type: 'bool' },
  ],
  stateMutability: 'view',
  type: 'function',
}]

function formatSun(value) {
  try {
    const sun = BigInt(String(value))
    const whole = sun / 1_000_000n
    const fraction = (sun % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
    return whole.toString() + (fraction ? '.' + fraction : '')
  } catch { return 'Unavailable' }
}

export default function RestrictedTRXEscrow() {
  const [requestId, setRequestId] = useState('')
  const [transactionId, setTransactionId] = useState('')
  const [position, setPosition] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [providerReadiness, setProviderReadiness] = useState(null)
  const [bitpieAccount, setBitpieAccount] = useState(null)
  const [accountError, setAccountError] = useState('')
  const [discoveredPositions, setDiscoveredPositions] = useState([])
  const [discoverBusy, setDiscoverBusy] = useState(false)
  const [discoveryError, setDiscoveryError] = useState('')

  useEffect(() => {
    let active = true
    fetch(API_BASE + '/api/restricted-trx/provider-readiness', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok && !payload.readiness) throw new Error('Provider readiness endpoint is unavailable.')
        return payload.readiness
      })
      .then((readiness) => { if (active) setProviderReadiness(readiness) })
      .catch(() => { if (active) setProviderReadiness(null) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    async function loadBitpieAccount() {
      try {
        const token = sessionStorage.getItem('tron-transfer:owner-session:v1') || ''
        if (!token) throw new Error('Sign in as the platform owner to query solidified public-chain data.')
        const response = await fetch(API_BASE + '/api/public-tron/account/' + encodeURIComponent(BITPIE_ADDRESS), {
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
          credentials: 'omit', cache: 'no-store', redirect: 'error',
        })
        const payload = await response.json()
        if (!response.ok || payload.success !== true) throw new Error(payload.error || 'Public TRON account lookup failed.')
        if (active) setBitpieAccount(payload.data)
      } catch (cause) {
        if (active) setAccountError(cause instanceof Error ? cause.message : 'Public TRON account lookup failed.')
      }
    }
    void loadBitpieAccount()
    return () => { active = false }
  }, [])

  async function discoverPositions() {
    setDiscoverBusy(true)
    setDiscoveryError('')
    setDiscoveredPositions([])
    try {
      if (!ESCROW_ADDRESS || !TronWeb.isAddress(ESCROW_ADDRESS)) throw new Error('No audited Mainnet escrow contract is configured.')
      const token = sessionStorage.getItem('tron-transfer:owner-session:v1') || ''
      if (!token) throw new Error('Sign in with the configured owner wallet before discovering escrow positions.')
      const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token }
      const base = API_BASE + '/api/public-tron/escrow/' + encodeURIComponent(ESCROW_ADDRESS) +
        '/beneficiary/' + encodeURIComponent(BITPIE_ADDRESS)
      const countResponse = await fetch(base + '/count', { headers, credentials: 'omit', cache: 'no-store', redirect: 'error' })
      const countPayload = await countResponse.json()
      if (!countResponse.ok || countPayload.success !== true) throw new Error(countPayload.error || 'Could not read the beneficiary position count.')
      const count = Number(countPayload.data.count)
      if (!Number.isSafeInteger(count) || count < 0 || count > 1000) throw new Error('The contract returned an invalid or excessive position count.')
      const positions = []
      for (let index = 0; index < count; index += 1) {
        const idResponse = await fetch(base + '/request/' + index, { headers, credentials: 'omit', cache: 'no-store', redirect: 'error' })
        const idPayload = await idResponse.json()
        if (!idResponse.ok || idPayload.success !== true) throw new Error('Could not read escrow request ID at index ' + index + '.')
        const requestId = idPayload.data.requestId
        const positionResponse = await fetch(API_BASE + '/api/public-tron/escrow/' + encodeURIComponent(ESCROW_ADDRESS) +
          '/position/' + encodeURIComponent(requestId), { headers, credentials: 'omit', cache: 'no-store', redirect: 'error' })
        const positionPayload = await positionResponse.json()
        if (!positionResponse.ok || positionPayload.success !== true) throw new Error('Could not read escrow position ' + requestId + '.')
        const candidate = positionPayload.data
        if (candidate.beneficiary !== BITPIE_ADDRESS || BigInt(String(candidate.amountSun)) <= 0n) continue
        positions.push({
          requestId,
          amountSun: String(candidate.amountSun),
          unlockAt: Number(candidate.unlockAt),
          claimed: Boolean(candidate.claimed),
        })
      }
      setDiscoveredPositions(positions)
      if (positions.length === 0) setDiscoveryError('No escrow positions are registered to this Bitpie address.')
    } catch (cause) {
      setDiscoveryError(cause instanceof Error ? cause.message : 'Could not discover escrow positions.')
    } finally {
      setDiscoverBusy(false)
    }
  }

  async function verifyPosition() {
    setBusy(true)
    setError('')
    setPosition(null)
    try {
      const normalizedRequestId = requestId.trim()
      const normalizedTxid = transactionId.trim()
      if (!/^0x[0-9a-f]{64}$/i.test(normalizedRequestId)) {
        throw new Error('Enter the 32-byte escrow request ID (0x followed by 64 hexadecimal characters).')
      }
      if (!/^[0-9a-f]{64}$/i.test(normalizedTxid)) {
        throw new Error('Enter the 64-character TRON funding transaction ID.')
      }
      if (!ESCROW_ADDRESS || !TronWeb.isAddress(ESCROW_ADDRESS)) {
        throw new Error('No audited Mainnet escrow contract is configured. Verification is unavailable until deployment.')
      }
      const token = sessionStorage.getItem('tron-transfer:owner-session:v1') || ''
      if (!token) throw new Error('Sign in with the configured owner wallet before verifying escrow.')
      const response = await fetch(
        API_BASE + '/api/restricted-trx/escrow/verify/' +
          encodeURIComponent(normalizedRequestId) + '/' + encodeURIComponent(normalizedTxid),
        {
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        },
      )
      const payload = await response.json()
      if (response.status === 202) throw new Error('The funding transaction is not yet solidified. Check again later; no restricted balance is credited yet.')
      if (!response.ok || payload.verified !== true || payload.result?.verified !== true) {
        throw new Error(payload.result?.reason || payload.error || 'Escrow verification failed. No restricted balance is recognized.')
      }
      setPosition(payload.result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not independently verify this escrow position.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel provider-panel">
      <div className="section-heading">
        <div><span className="eyebrow">TRON MAINNET · ON-CHAIN ESCROW VIEWER</span><h2>Restricted TRX custody</h2><p>Read-only verification of a real contract-held position linked to your Bitpie address. This is not a Bitpie wallet deposit or spendable Bitpie balance.</p></div>
      </div>
      <div className="notice notice-warning"><AlertTriangle size={17}/><div><b>Important wallet distinction</b><p>TRX held by the escrow contract is not held inside Bitpie. Bitpie will not show it as ordinary wallet balance. This viewer reads the actual contract position from TRON Mainnet.</p></div></div>
      <div className="notice notice-warning"><AlertTriangle size={17}/><div><b>Provider funding readiness</b><p>{providerReadiness?.message || 'Provider readiness has not been retrieved.'}</p><p>{providerReadiness ? 'Verified liquidity: ' + (providerReadiness.liquidityVerified ? 'yes' : 'no') + ' · Automated funding: ' + (providerReadiness.canBroadcastTransaction ? 'enabled' : 'disabled') : 'Status unavailable.'}</p>{providerReadiness?.blockers?.length > 0 && <small>Blockers: {providerReadiness.blockers.join(', ')}</small>}</div></div>
      <div className="settings-group">
        <span className="eyebrow">BENEFICIARY BITPIE ADDRESS</span>
        <div className="address-box"><span>Allowlisted beneficiary</span><b>{BITPIE_ADDRESS}</b></div>
        <a href={'https://tronscan.org/#/address/'+BITPIE_ADDRESS} target="_blank" rel="noreferrer">View Bitpie address on TRONSCAN <ExternalLink size={13}/></a>
      </div>
      <div className="settings-group">
        <span className="eyebrow">BITPIE ADDRESS · PUBLIC SOLIDIFIED TRON BALANCE</span>
        <div className="address-box"><span>Native TRX balance at beneficiary address</span><b>{bitpieAccount ? formatSun(bitpieAccount.balanceSun) + ' TRX' : 'Not verified'}</b></div>
        <p className="fine-print">{bitpieAccount ? 'Verified from solidified TRON state. The amount shown here is the actual native balance at this address; whether one key can spend it depends on the on-chain permission thresholds below. This is not a smart-contract escrow credit.' : accountError || 'Loading public chain balance…'}</p>
        {bitpieAccount?.permissionAssessment?.available ? (
          <div className={bitpieAccount.permissionAssessment.restrictedAgainstSingleKey ? 'notice notice-success' : 'notice notice-warning'}>
            <ShieldCheck size={16}/>
            <div>
              <b>{bitpieAccount.permissionAssessment.restrictedAgainstSingleKey ? 'On-chain multisignature restriction detected' : 'A single signer may be able to move funds'}</b>
              <p>{bitpieAccount.permissionAssessment.restrictedAgainstSingleKey
                ? 'The solidified account permissions require multiple keys for the checked transfer, contract-call, and permission-update operations. This is an on-chain restriction, not a Bitpie credit annotation.'
                : 'At least one permission can authorize a value-moving or permission-update operation with one configured key. This address is not restricted against single-key spending.'}</p>
              <small>Owner threshold: {bitpieAccount.permissionAssessment.ownerThreshold}; checked active permissions: {bitpieAccount.permissionAssessment.activePermissions.length}.</small>
            </div>
          </div>
        ) : (
          <div className="notice notice-warning"><AlertTriangle size={16}/><span>On-chain multisignature permissions could not be verified. Do not treat this address as restricted.</span></div>
        )}
      </div>
      <div className="settings-group">
        <span className="eyebrow">ESCROW CONTRACT</span>
        <div className="address-box"><span>Configured Mainnet contract</span><b>{ESCROW_ADDRESS || 'Not deployed / not configured'}</b></div>
        {ESCROW_ADDRESS && <a href={'https://tronscan.org/#/address/'+ESCROW_ADDRESS} target="_blank" rel="noreferrer">View escrow contract on TRONSCAN <ExternalLink size={13}/></a>}
      </div>
      <div className="settings-group">
        <div className="section-heading">
          <div><span className="eyebrow">BENEFICIARY INDEX</span><h3>Discover Bitpie-linked escrow positions</h3><p>Reads registered beneficiary positions from solidified contract state. These entries are not fully verified until the funding transaction ID passes receipt, event, sender, amount and collateral checks.</p></div>
        </div>
        <button className="primary-button" disabled={discoverBusy || !ESCROW_ADDRESS} onClick={() => void discoverPositions()}>
          <RefreshCw size={15}/>{discoverBusy ? 'Reading solidified contract state…' : 'Discover escrow positions'}
        </button>
        {discoveryError && <div className="notice notice-warning" role="status"><AlertTriangle size={16}/><span>{discoveryError}</span></div>}
        {discoveredPositions.length > 0 && <div className="recipient-results">
          {discoveredPositions.map((item) => (
            <article className="metric-card" key={item.requestId}>
              <span>Discovered position · transaction proof still required</span>
              <strong>{formatSun(item.amountSun)} <small>TRX</small></strong>
              <p className="fine-print">Request ID: {item.requestId}</p>
              <p className="fine-print">Status: {item.claimed ? 'Claimed' : Date.now() / 1000 >= item.unlockAt ? 'Unlock time reached' : 'Time-locked'}</p>
              <button className="secondary-button" disabled={item.claimed} onClick={() => setRequestId(item.requestId)}>Use this request ID</button>
            </article>
          ))}
        </div>}
      </div>
      <div className="form-stack">
        <label>Escrow request ID (bytes32)<input value={requestId} onChange={(event) => setRequestId(event.target.value)} placeholder="0x… 64 hexadecimal characters" autoComplete="off" spellCheck="false"/></label>
        <label>Funding transaction ID<input value={transactionId} onChange={(event) => setTransactionId(event.target.value)} placeholder="64 hexadecimal characters" autoComplete="off" spellCheck="false"/></label>
        <button className="primary-button" disabled={busy || !requestId.trim() || !transactionId.trim()} onClick={() => void verifyPosition()}><RefreshCw size={15}/>{busy ? 'Verifying on TRON…' : 'Verify escrow position'}</button>
      </div>
      {error && <div className="notice notice-error" role="alert"><AlertTriangle size={16}/><span>{error}</span></div>}
      {position && <div className="recipient-results">
        <div className="recipient-balance-grid">
          <article className="metric-card"><span>Contract-held amount</span><strong>{formatSun(position.amountSun)} <small>TRX</small></strong></article>
          <article className="metric-card"><span>Position status</span><strong>{position.claimed ? 'Claimed' : Date.now() / 1000 >= position.unlockAt ? 'Unlocked' : 'Locked'}</strong></article>
          <article className="metric-card"><span>Unlock time</span><strong>{new Date(position.unlockAt * 1000).toLocaleString()}</strong></article>
          <article className="metric-card"><span>Beneficiary match</span><strong>{position.beneficiary === BITPIE_ADDRESS ? 'Verified' : 'Mismatch'}</strong></article>
        </div>
        <div className="notice notice-success"><ShieldCheck size={16}/><span>Position, funding event, provider sender, principal amount, and aggregate collateral were verified from solidified TRON state. This is contract-held TRX, not a Bitpie app deposit.</span></div>
        {position.explorerTransactionUrl && <a href={position.explorerTransactionUrl} target="_blank" rel="noreferrer">Open verified funding transaction on TRONSCAN <ExternalLink size={13}/></a>}
        {position.explorerContractUrl && <a href={position.explorerContractUrl} target="_blank" rel="noreferrer">Open escrow contract on TRONSCAN <ExternalLink size={13}/></a>}
      </div>}
      <p className="fine-print">A position appears here only after a provider has funded the deployed escrow contract and the beneficiary position has been recorded on-chain. No local balance is fabricated.</p>
    </section>
  )
}
