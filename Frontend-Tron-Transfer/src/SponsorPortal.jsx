import { useEffect, useState } from 'react'
import { LockKeyhole, Wallet } from 'lucide-react'
import { discoverTronLinkProvider, requestTronLinkConnection } from './tronlink-provider.mjs'
import SponsorDirectPayouts from './SponsorDirectPayouts.jsx'

function isValidMainnetAddress(address, tronWeb) {
  try {
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(address || ''))
      && tronWeb?.isAddress?.(String(address)) === true
  } catch {
    return false
  }
}

function isTronMainnet(tronWeb) {
  try {
    return new URL(String(tronWeb?.fullNode?.host || '')).hostname.toLowerCase() === 'api.trongrid.io'
  } catch {
    return false
  }
}

/**
 * Isolated sponsor-only surface. It never renders the private owner dashboard.
 * Sponsor capabilities are limited by the wallet-authenticated backend routes.
 */
export default function SponsorPortal() {
  const [wallet, setWallet] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function connectSponsorWallet() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const provider = await discoverTronLinkProvider(window)
      if (!provider) throw new Error('TronLink was not detected. Open this page in the TronLink DApp browser, unlock the sponsor wallet, and connect again.')
      const { address, tronWeb } = await requestTronLinkConnection(provider, window)
      if (!isValidMainnetAddress(address, tronWeb)) throw new Error('TronLink returned an invalid TRON address.')
      if (!isTronMainnet(tronWeb)) throw new Error('Network mismatch. Switch the sponsor wallet to TRON Mainnet, then reconnect.')
      if (tronWeb.defaultAddress?.base58 && tronWeb.defaultAddress.base58 !== address) {
        throw new Error('The selected TronLink account changed during connection. Reconnect and try again.')
      }
      setWallet({ address, tronWeb, provider })
      setNotice('Sponsor wallet connected to TRON Mainnet. Signing a wallet identity message does not transfer funds.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect the sponsor wallet.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const provider = wallet?.provider
    if (!provider || typeof provider.on !== 'function') return undefined
    const invalidate = () => {
      setWallet(null)
      setNotice('The connected sponsor account or network changed. Reconnect before continuing.')
    }
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) provider.on(event, invalidate)
    return () => {
      if (typeof provider.removeListener === 'function') {
        for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) provider.removeListener(event, invalidate)
      }
    }
  }, [wallet?.provider])

  return (
    <div className="app-shell sponsor-portal-shell">
      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="eyebrow">TRON TRANSFER · INVITED SPONSOR ACCESS</span>
            <h1>Self-custody sponsor portal</h1>
          </div>
          <div className="topbar-actions">
            <a className="outline-button" href="/" rel="noreferrer">Owner workspace</a>
          </div>
        </header>
        <div className="content">
          <section className="panel sponsor-public-brief" aria-labelledby="sponsor-brief-title">
            <div className="section-heading">
              <div>
                <span className="eyebrow">VOLUNTARY SPONSORSHIP · NO DEPOSIT TO THE PROJECT</span>
                <h2 id="sponsor-brief-title">Support capped TRON Mainnet USDT payouts without handing over custody</h2>
                <p>Tron Transfer is seeking independent individuals willing to sponsor selected, reviewed USDT TRC20 withdrawals from their own TRON Mainnet wallet. The sponsor remains in control of the funds and signs every exact payout in TronLink.</p>
              </div>
              <div className="panel-icon"><LockKeyhole /></div>
            </div>
            <div className="owner-session-card sponsor-target-card">
              <strong>Initial sponsorship target</strong>
              <p><strong>$5,000–$10,000 equivalent in official TRON Mainnet USDT</strong></p>
              <small>This is a target for sponsor-controlled available capacity, not a request to deposit or transfer funds to the project operator. A sponsor may start with a smaller cap, fund only one payout, or decline any request.</small>
            </div>
            <div className="sponsor-brief-grid">
              <div>
                <h3>How sponsor control works</h3>
                <ol>
                  <li>Connect only the wallet you own and intend to use for sponsorship.</li>
                  <li>Complete a one-time wallet-address ownership challenge and the platform's manual review.</li>
                  <li>Check live official USDT and TRON network resources; set limits that you are comfortable with.</li>
                  <li>Review the exact recipient and amount, then sign that specific transaction in your own TronLink wallet.</li>
                  <li>The backend validates the signed transaction, broadcasts it, and checks the solidified Mainnet receipt and official USDT Transfer event.</li>
                </ol>
              </div>
              <div>
                <h3>What this does not ask you to do</h3>
                <ul>
                  <li>Do not send funds to the developer or a platform-controlled wallet.</li>
                  <li>Do not share seed phrases, private keys, passwords, OTPs or remote access.</li>
                  <li>Do not rely on screenshots, a displayed balance or a sponsor profile as proof of funding.</li>
                  <li>Do not expect guaranteed returns, reimbursement, interest or a guaranteed number of payouts.</li>
                </ul>
              </div>
            </div>
            <p className="fine-print">Project status: this sponsor-recruitment work is in draft pull request #153 and is not merged or verified as deployed to production. No individual sponsor is currently confirmed approved and funded, no provider has authorized a payout account or credit facility, and no funded Mainnet pilot is claimed. Review the <a href="https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/blob/ui/modern-crypto-dashboard-theme/docs/SPONSOR_BRIEF.md" target="_blank" rel="noreferrer">public sponsor brief</a>, <a href="https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/blob/ui/modern-crypto-dashboard-theme/docs/EXTERNAL_SPONSOR_OPERATING_CONTRACT.md" target="_blank" rel="noreferrer">sponsor operating rules</a>, <a href="https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/pull/153" target="_blank" rel="noreferrer">implementation PR #153</a>, and <a href="https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/issues/new?template=individual-sponsor-inquiry.yml" target="_blank" rel="noreferrer">public sponsor inquiry form</a> before participating.</p>
          </section>
          <section className="panel provider-panel">
            <div className="section-heading">
              <div>
                <span className="eyebrow">TRON MAINNET · OFFICIAL USDT TRC20</span>
                <h2>Connect the wallet that will sponsor payments</h2>
                <p>This separate portal does not expose the private owner dashboard. A sponsor must control its own wallet, complete the wallet-identity check, be approved by the platform owner, maintain real USDT and network-fee resources, and sign each exact transfer.</p>
              </div>
              <div className="panel-icon"><LockKeyhole /></div>
            </div>
            {error && <div className="notice notice-error" role="alert">{error}</div>}
            {notice && <div className="notice notice-success" role="status">{notice}</div>}
            {wallet
              ? <div className="owner-session-card">
                  <strong><Wallet size={15} /> Sponsor wallet connected</strong>
                  <small>{wallet.address}</small>
                  <button className="secondary-button" disabled={busy} onClick={() => void connectSponsorWallet()}>Reconnect sponsor wallet</button>
                </div>
              : <div className="form-stack">
                  <p className="fine-print">Connect only the wallet whose owner has agreed to sponsor. Do not enter or share private keys, seed phrases, passwords or recovery codes.</p>
                  <button className="primary-button" disabled={busy} onClick={() => void connectSponsorWallet()}><Wallet size={16} /> {busy ? 'Connecting…' : 'Connect sponsor TronLink'}</button>
                </div>}
            <p className="fine-print">Wallet approval in this platform is not KYC, KYB, sanctions screening or source-of-funds verification. Any legal or compliance requirements remain applicable and must not be bypassed.</p>
          </section>
          <SponsorDirectPayouts wallet={wallet} ownerSession={null} mode="sponsor" />
        </div>
        <footer className="app-footer">TRON TRANSFER · SPONSOR WALLET SURFACE · TRON MAINNET · OFFICIAL USDT TRC20</footer>
      </main>
    </div>
  )
}
