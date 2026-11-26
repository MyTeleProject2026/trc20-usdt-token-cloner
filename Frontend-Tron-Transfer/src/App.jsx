import React, { useEffect, useState } from 'react'
import { Activity, AlertTriangle, ArrowLeftRight, ArrowDownToLine, Blocks, Network, Coins, History, Layers3, PauseCircle, Rocket, ShieldCheck, Wallet } from 'lucide-react'
import TRXMainnetPanel from './TRXMainnetPanel.jsx'
import TRAXSidebar from './TRAXSidebar.jsx'
import MobileNavBar from './MobileNavBar.jsx'
import AetheriaMcpMesh from './AetheriaMcpMesh.jsx'
import SponsorWalletManager from './SponsorWalletManager.jsx'
import OwnerWalletAccess from './OwnerWalletAccess.jsx'
import OwnerAccountSecurity from './OwnerAccountSecurity.jsx'
import PWAInstallButton from './PWAInstallButton.jsx'
import { createManagedWalletAuthClient } from './managed-wallet-auth-client.mjs'

const ownerAuthClient = createManagedWalletAuthClient({ role: 'owner' })

class SponsorWorkspaceErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, message: '' } }
  static getDerivedStateFromError(error) { return { hasError: true, message: String(error?.message || 'Unknown render error').slice(0, 240) } }
  componentDidCatch(error, info) { console.error('Sponsor workspace render failure', error, info?.componentStack) }
  componentDidUpdate(previousProps) { if (previousProps.activePage !== this.props.activePage && this.state.hasError) this.setState({ hasError: false, message: '' }) }
  render() {
    if (this.state.hasError) return <section className="sponsor-card sponsor-render-error" role="alert"><div className="sponsor-card-heading"><AlertTriangle/><div><h3>This Sponsor page could not be displayed</h3><p>The error is isolated to this page. No transaction was submitted.</p><p className="sponsor-muted">Diagnostic: <code>{this.state.message}</code></p></div></div><div className="sponsor-actions"><button type="button" className="sponsor-primary" onClick={() => this.setState({ hasError: false, message: '' })}>Retry this page</button><button type="button" className="sponsor-secondary" onClick={() => this.props.onNavigate('sponsor')}>Return to Sponsor overview</button></div></section>
    return this.props.children
  }
}

const NAV_ITEMS = [
  { id: 'sponsor', label: 'Sponsor overview', shortLabel: 'Overview', description: 'Independent Sponsor wallet · live capacity and execution readiness', icon: ShieldCheck },
  { id: 'sponsor-resources', label: 'Resource markets', shortLabel: 'Resources', description: 'Energy, Bandwidth, staking and delegation controls', icon: Activity },
  { id: 'sponsor-automation', label: 'Automation & limits', shortLabel: 'Automation', description: 'Owner resource targets, preflight and guarded automation', icon: Network },
  { id: 'sponsor-activity', label: 'Activity & audit', shortLabel: 'Activity', description: 'Sponsor operations, wallet transactions and verification history', icon: History },
  { id: 'home', label: 'AETHERIA MCP Mesh', shortLabel: 'Home', description: 'Global MCP mesh · live infrastructure, API execution and TRON Mainnet resources', icon: Network },
  { id: 'portfolio', label: 'Owner portfolio', shortLabel: 'Portfolio', description: 'Contract health and owner portfolio', icon: Wallet },
  { id: 'deploy', label: 'Deploy & verify', description: 'Create or inspect the TRӾ Mainnet contract', icon: Rocket },
  { id: 'issuance', label: 'Owner issuance', shortLabel: 'Issue', description: 'Mint new TRӾ to a recipient address', icon: Coins },
  { id: 'credits', label: 'External credits', shortLabel: 'Credits', description: 'Single-address TRӾ credit issuance', icon: ArrowDownToLine },
  { id: 'batch', label: 'Batch credits', description: 'Issue credits to up to 50 addresses', icon: Layers3 },
  { id: 'pause', label: 'Emergency pause', description: 'Pause or resume token transfers', icon: PauseCircle },
  { id: 'minting', label: 'Minting authorization', description: 'Enable or disable owner issuance', icon: ShieldCheck },
  { id: 'transfers', label: 'Token transfers', shortLabel: 'Transfer', description: 'Transfer existing owner-held TRӾ', icon: ArrowLeftRight },
  { id: 'withdraw', label: 'Withdraw', shortLabel: 'Withdraw', description: 'Send official USDT from the Owner wallet', icon: ArrowDownToLine },
  { id: 'ownership', label: 'Ownership transfer', description: 'Two-step owner handoff', icon: Wallet },
  { id: 'history', label: 'Credit history', description: 'Confirmed on-chain OwnerCredit events', icon: History },
  { id: 'balance', label: 'External balance lookup', description: 'Read any address token balance', icon: Blocks },
]


function pageFromLocation() {
  const candidate = window.location.hash.replace(/^#\/?/, '')
  return NAV_ITEMS.some(item => item.id === candidate) ? candidate : 'home'
}

export default function App() {
  const [activePage, setActivePage] = useState(pageFromLocation)
  const [wallet, setWallet] = useState(null)
  const [walletError, setWalletError] = useState('')
  const [walletNotice, setWalletNotice] = useState('')
  const [ownerAccessOpen, setOwnerAccessOpen] = useState(false)
  const [ownerSecurityOpen, setOwnerSecurityOpen] = useState(false)

  useEffect(() => {
    let active = true
    const restoreOwnerSession = () => ownerAuthClient.session().then(session => {
      if (active && session?.success && session.role === 'owner' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(session.address || ''))) {
        setOwnerAccessOpen(true)
      }
    }).catch(() => {})
    void restoreOwnerSession()
    window.addEventListener('tron-transfer:owner-session-refreshed', restoreOwnerSession)
    return () => { active = false; window.removeEventListener('tron-transfer:owner-session-refreshed', restoreOwnerSession) }
  }, [])

  // Keep each workspace/page addressable and make browser Back/Forward work.
  useEffect(() => {
    const syncFromLocation = () => setActivePage(pageFromLocation())
    window.addEventListener('popstate', syncFromLocation)
    window.addEventListener('hashchange', syncFromLocation)
    return () => {
      window.removeEventListener('popstate', syncFromLocation)
      window.removeEventListener('hashchange', syncFromLocation)
    }
  }, [])

  useEffect(() => {
    const nextHash = '#/' + activePage
    if (window.location.hash !== nextHash) window.history.pushState({ tronTransferPage: activePage }, '', nextHash)
  }, [activePage])

  function connectWallet() {
    setWalletError('')
    setWalletNotice('')
    setOwnerAccessOpen(true)
  }

  function acceptOwnerWallet(ownerWallet) {
    setWallet(ownerWallet)
    setOwnerAccessOpen(false)
    setWalletError('')
    setWalletNotice('Owner application session authenticated and the encrypted local Owner Wallet is unlocked. Every transaction still requires explicit confirmation.')
  }

  function lockWallet() {
    setOwnerSecurityOpen(false)
    ownerAuthClient.logout().catch(() => {})
    setWallet(null)
    setOwnerAccessOpen(true)
    setActivePage('home')
    setWalletNotice('Owner password session signed out and the local signing key has been cleared from memory.')
  }


  useEffect(() => {
    if (!wallet) return undefined
    let idleTimer
    let backgroundTimer
    const lock = () => {
      ownerAuthClient.logout().catch(() => {})
      setWallet(null)
      setActivePage('home')
      setOwnerAccessOpen(true)
      setWalletNotice('Owner session automatically signed out and the local signing key was cleared. Sign in and unlock again to continue.')
    }
    const resetIdle = () => {
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(lock, 5 * 60 * 1000)
    }
    const onVisibility = () => {
      window.clearTimeout(backgroundTimer)
      if (document.visibilityState === 'hidden') backgroundTimer = window.setTimeout(lock, 60 * 1000)
      else resetIdle()
    }
    for (const event of ['pointerdown','keydown','touchstart','scroll']) window.addEventListener(event, resetIdle, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    resetIdle()
    return () => {
      window.clearTimeout(idleTimer)
      window.clearTimeout(backgroundTimer)
      for (const event of ['pointerdown','keydown','touchstart','scroll']) window.removeEventListener(event, resetIdle)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [wallet])

  const sponsorWorkspace = activePage.startsWith('sponsor')
  const visibleNavItems = sponsorWorkspace ? NAV_ITEMS.filter(item => item.id.startsWith('sponsor')) : NAV_ITEMS.filter(item => !item.id.startsWith('sponsor'))
  const page = NAV_ITEMS.find(item => item.id === activePage) || NAV_ITEMS[0]
  return <div className="trax-admin-shell">
    <TRAXSidebar items={visibleNavItems} activePage={activePage} onNavigate={setActivePage} wallet={wallet} onConnect={connectWallet} onLock={lockWallet} workspace={sponsorWorkspace ? "sponsor" : "owner"}/>
    <div className="trax-admin-main">
      <header className="trax-admin-topbar">
        <div className="trax-topbar-title">
          <span className="trax-kicker">TRӾ smart-contract manager · TRON TRANSFER OWNER CONSOLE</span>
          <h1>{page.label}</h1>
          <p>{page.description}</p>
        </div>
        <div className="trax-topbar-actions">
          <PWAInstallButton />
          <div className="trax-workspace-switch" role="group" aria-label="Wallet workspace">
            <button type="button" className={!sponsorWorkspace ? 'active' : ''} aria-current={!sponsorWorkspace ? 'page' : undefined} aria-pressed={!sponsorWorkspace} onClick={() => setActivePage('home')}>Owner workspace</button>
            <button type="button" className={sponsorWorkspace ? 'active sponsor' : ''} aria-current={sponsorWorkspace ? 'page' : undefined} aria-pressed={sponsorWorkspace} onClick={() => setActivePage('sponsor')}>Sponsor workspace</button>
          </div>
          <span className="trax-mainnet-badge"><i/> TRON MAINNET <b>·</b> {sponsorWorkspace ? "SPONSOR" : "OWNER"}</span>
          {!sponsorWorkspace && (wallet ? <><button type="button" className="trax-topbar-security" onClick={() => setOwnerSecurityOpen(true)}>Account security</button><button type="button" className="trax-topbar-wallet" onClick={lockWallet}><Wallet size={15}/>{wallet.address.slice(0,7)}…{wallet.address.slice(-5)} · Lock Owner</button></> : <button type="button" className="trax-topbar-connect" onClick={connectWallet}>Unlock Owner Wallet</button>)}
        </div>
      </header>
      <main id="trax-workspace-main" className="trax-admin-content" tabIndex={-1}>
        {(walletError || walletNotice) && <div className={walletError ? 'trax-shell-alert error' : 'trax-shell-alert'} role={walletError ? 'alert' : 'status'}><AlertTriangle size={16}/><span>{walletError || walletNotice}</span><button onClick={() => {setWalletError('');setWalletNotice('')}} aria-label="Dismiss">×</button></div>}
        <div hidden={!sponsorWorkspace} aria-hidden={!sponsorWorkspace}>
          <SponsorWorkspaceErrorBoundary activePage={activePage} onNavigate={setActivePage}><SponsorWalletManager activePage={activePage} onNavigate={setActivePage} workspaceActive={sponsorWorkspace}/></SponsorWorkspaceErrorBoundary>
        </div>
        <div hidden={sponsorWorkspace} aria-hidden={sponsorWorkspace}>
          {activePage === 'home' ? <AetheriaMcpMesh wallet={wallet} onNavigate={setActivePage}/> : <TRXMainnetPanel wallet={wallet} onConnect={connectWallet} activePage={activePage} onNavigate={setActivePage}/>}
        </div>
      </main>
      {ownerAccessOpen && <OwnerWalletAccess onUnlock={acceptOwnerWallet} onClose={() => setOwnerAccessOpen(false)}/>}
      {ownerSecurityOpen && wallet && <div className="owner-security-modal-backdrop" role="dialog" aria-modal="true" aria-label="Owner account security" onMouseDown={event => { if (event.target === event.currentTarget) setOwnerSecurityOpen(false) }}><div className="owner-security-modal"><button type="button" className="owner-security-modal-close" onClick={() => setOwnerSecurityOpen(false)}>Close</button><OwnerAccountSecurity wallet={wallet} onConnect={connectWallet}/></div></div>}
    <footer className="trax-admin-footer">TRON TRANSFER · INDEPENDENT OWNER SIGNING · TRON MAINNET</footer>
    </div>
    <MobileNavBar items={visibleNavItems} activePage={activePage} onNavigate={setActivePage} workspace={sponsorWorkspace ? "sponsor" : "owner"}/>
  </div>
}
