import { useEffect, useState } from 'react'
import { ExternalLink, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react'
import { TronWeb } from 'tronweb'

const BITPIE_ADDRESS = 'TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT'
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
  const [position, setPosition] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [providerReadiness, setProviderReadiness] = useState(null)

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

  async function verifyPosition() {
    setBusy(true)
    setError('')
    setPosition(null)
    try {
      if (!/^0x[0-9a-f]{64}$/i.test(requestId.trim())) throw new Error('Enter the 32-byte escrow request ID (0x followed by 64 hexadecimal characters).')
      if (!ESCROW_ADDRESS || !TronWeb.isAddress(ESCROW_ADDRESS)) throw new Error('No valid deployed escrow contract is configured. Mainnet verification is unavailable until the audited contract is deployed and its address is configured.')
      const client = new TronWeb({ fullHost: 'https://api.trongrid.io' })
      const contract = await client.contract(ABI, ESCROW_ADDRESS)
      const result = await contract.getPosition(requestId.trim()).call()
      const beneficiary = result.beneficiary || result[0]
      const amountSun = result.amountSun ?? result[1]
      const unlockAt = Number(result.unlockAt ?? result[2])
      const claimed = Boolean(result.claimed ?? result[3])
      if (beneficiary !== BITPIE_ADDRESS) throw new Error('This escrow request is not assigned to the configured Bitpie destination. No balance is displayed.')
      if (BigInt(String(amountSun)) <= 0n) throw new Error('The escrow contract returned no funded amount for this request.')
      setPosition({ beneficiary, amountSun: String(amountSun), unlockAt, claimed })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not verify the escrow position on TRON Mainnet.')
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
        <span className="eyebrow">ESCROW CONTRACT</span>
        <div className="address-box"><span>Configured Mainnet contract</span><b>{ESCROW_ADDRESS || 'Not deployed / not configured'}</b></div>
        {ESCROW_ADDRESS && <a href={'https://tronscan.org/#/address/'+ESCROW_ADDRESS} target="_blank" rel="noreferrer">View escrow contract on TRONSCAN <ExternalLink size={13}/></a>}
      </div>
      <div className="form-stack">
        <label>Escrow request ID (bytes32)<input value={requestId} onChange={(event) => setRequestId(event.target.value)} placeholder="0x… 64 hexadecimal characters" autoComplete="off" spellCheck="false"/></label>
        <button className="primary-button" disabled={busy || !requestId.trim()} onClick={() => void verifyPosition()}><RefreshCw size={15}/>{busy ? 'Verifying on TRON…' : 'Verify escrow position'}</button>
      </div>
      {error && <div className="notice notice-error" role="alert"><AlertTriangle size={16}/><span>{error}</span></div>}
      {position && <div className="recipient-results">
        <div className="recipient-balance-grid">
          <article className="metric-card"><span>Contract-held amount</span><strong>{formatSun(position.amountSun)} <small>TRX</small></strong></article>
          <article className="metric-card"><span>Position status</span><strong>{position.claimed ? 'Claimed' : Date.now() / 1000 >= position.unlockAt ? 'Unlocked' : 'Locked'}</strong></article>
          <article className="metric-card"><span>Unlock time</span><strong>{new Date(position.unlockAt * 1000).toLocaleString()}</strong></article>
          <article className="metric-card"><span>Beneficiary match</span><strong>{position.beneficiary === BITPIE_ADDRESS ? 'Verified' : 'Mismatch'}</strong></article>
        </div>
        <div className="notice notice-success"><ShieldCheck size={16}/><span>Position details were read directly from the configured TRON Mainnet escrow contract. Confirm the contract and funding transaction independently on TRONSCAN.</span></div>
      </div>}
      <p className="fine-print">A position appears here only after a provider has funded the deployed escrow contract and the beneficiary position has been recorded on-chain. No local balance is fabricated.</p>
    </section>
  )
}
