import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, ShieldCheck, Wallet } from 'lucide-react'

const REQUEST = Object.freeze({
  network: 'TRON Mainnet',
  asset: 'Native TRX',
  amount: '100',
  recipient: 'TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT',
  fundingSource: 'Approved provider-owned funds only',
  status: 'draft-provider-not-connected',
})

export default function BitpieTrxRequest() {
  const [copied, setCopied] = useState(false)

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(REQUEST.recipient)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="panel provider-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">PRIVATE OWNER · NATIVE TRX PAYOUT</span>
          <h2>Bitpie provider-funded withdrawal</h2>
          <p>A fixed 100 TRX request draft for the Bitpie receiving address. This is a native TRX transfer, not USDT TRC20.</p>
        </div>
        <div className="panel-icon"><Wallet /></div>
      </div>

      <div className="notice notice-warning" role="status">
        <AlertTriangle size={17} />
        <span><b>Draft only — no provider is connected or authorized.</b> No transfer has been submitted and no TRX has been credited.</span>
      </div>

      <div className="recipient-balance-grid">
        <article className="metric-card"><span>Requested amount</span><strong>100 <small>TRX</small></strong></article>
        <article className="metric-card"><span>Network</span><strong>TRON <small>Mainnet</small></strong></article>
        <article className="metric-card"><span>Funding source</span><strong>Provider <small>only</small></strong></article>
        <article className="metric-card"><span>Execution status</span><strong>Not submitted</strong></article>
      </div>

      <div className="settings-group">
        <span className="eyebrow">BITPIE DESTINATION · VERIFY IN BITPIE BEFORE USE</span>
        <div className="address-box">
          <span>TRX receiving address</span>
          <b className="address-value">{REQUEST.recipient}</b>
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={copyAddress}><Copy size={15} />{copied ? 'Address copied' : 'Copy address'}</button>
          <a className="outline-button" href={'https://tronscan.org/#/address/' + REQUEST.recipient} target="_blank" rel="noreferrer">View on TRONSCAN <ExternalLink size={13} /></a>
        </div>
      </div>

      <div className="settings-group">
        <span className="eyebrow">RESTRICTED PAYOUT POLICY</span>
        <ul className="fine-print">
          <li>Asset is native TRX on TRON Mainnet only.</li>
          <li>Destination and amount are fixed in this request draft: 100 TRX to the address above.</li>
          <li>Funding must come from a provider-owned funded account or an explicitly approved credit facility.</li>
          <li>Provider authorization, available TRX principal, network-fee coverage, daily limits and idempotency must pass before execution.</li>
          <li>The panel must display a transaction ID as pending until the solidified Mainnet transaction confirms the exact recipient and amount.</li>
        </ul>
      </div>

      <div className="notice notice-warning">
        <ShieldCheck size={17} />
        <span>Provider readiness is not established by this draft. The existing TRX payout route remains hard-disabled for real-value execution. Do not remove that safety gate until a real provider account, funded balance or approved credit, authorization and end-to-end verification have been independently validated.</span>
      </div>
      <p className="fine-print">Before any payout, compare this address with Bitpie → TRX → Receive on TRON Mainnet. Never provide a seed phrase or private key to a provider or to this application.</p>
    </section>
  )
}
