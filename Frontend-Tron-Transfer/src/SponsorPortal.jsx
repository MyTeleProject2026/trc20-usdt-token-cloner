import { useEffect, useState } from 'react'
import { ExternalLink, LockKeyhole, ShieldCheck, Wallet } from 'lucide-react'
import { TronWeb } from 'tronweb'
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
            <a href="#/sponsor" onClick={(event) => event.preventDefault()} aria-label="Sponsor portal route"><ExternalLink size={12}/> Sponsor portal route: #/sponsor</a>
          </section>
          <SponsorDirectPayouts wallet={wallet} ownerSession={null} mode="sponsor" />
        </div>
        <footer className="app-footer">TRON TRANSFER · SPONSOR WALLET SURFACE · TRON MAINNET · OFFICIAL USDT TRC20</footer>
      </main>
    </div>
  )
}
