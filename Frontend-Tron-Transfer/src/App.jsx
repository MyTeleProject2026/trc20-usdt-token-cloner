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
import './owner-admin-redesign.css'
import { createManagedWalletAuthClient } from './managed-wallet-auth-client.mjs'

const ownerAuthClient = createManagedWalletAuthClient({ role: 'owner' })



class OwnerWorkspaceErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, message: '' } }
  static getDerivedStateFromError(error) { return { hasError: true, message: String(error?.message || 'Unknown render error').slice(0, 240) } }
  componentDidCatch(error, info) { console.error('Owner workspace render failure', error, info?.componentStack) }
  componentDidUpdate(previousProps) { if (previousProps.activePage !== this.props.activePage && this.state.hasError) this.setState({ hasError: false, message: '' }) }
  render() {
    if (this.state.hasError) return <section className="trax-shell-alert error" role="alert"><AlertTriangle size={16}/><div><strong>This Owner page could not be displayed.</strong><p>A render error does not confirm transaction status. Check the durable Owner operation ledger and solidified Mainnet receipt before retrying; do not create a replacement operation until the original is reconciled.</p><p>Diagnostic: <code>{this.state.message}</code></p></div><button type="button" className="trax-topbar-connect" onClick={() => this.setState({ hasError: false, message: '' })}>Retry this page</button><button type="button" className="trax-topbar-security" onClick={() => this.props.onNavigate('home')}>Owner overview</button></section>
    return this.props.children
  }
}

class SponsorWorkspaceErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, message: '' } }
  static getDerivedStateFromError(error) { return { hasError: true, message: String(error?.message || 'Unknown render error').slice(0, 240) } }
  componentDidCatch(error, info) { console.error('Sponsor workspace render failure', error, info?.componentStack) }
  componentDidUpdate(previousProps) { if (previousProps.activePage !== this.props.activePage && this.state.hasError) this.setState({ hasError: false, message: '' }) }
  render() {
    if (this.state.hasError) return <section className="sponsor-card sponsor-render-error" role="alert"><div className="sponsor-card-heading"><AlertTriangle/><div><h3>This Sponsor page could not be displayed</h3><p>A render error does not confirm transaction status. Check the durable Sponsor ledger and solidified Mainnet receipt before retrying; do not create a replacement operation until the original is reconciled.</p><p className="sponsor-muted">Diagnostic: <code>{this.state.message}</code></p></div></div><div className="sponsor-actions"><button type="button" className="sponsor-primary" onClick={() => this.setState({ hasError: false, message: '' })}>Retry this page</button><button type="button" className="sponsor-secondary" onClick={() => this.props.onNavigate('sponsor')}>Return to Sponsor overview</button></div></section>
    return this.props.children
  }
}

const NAV_ITEMS = [
  { id: 'sponsor', group: 'Sponsor', label: 'Sponsor overview', shortLabel: 'Overview', description: 'Independent Sponsor wallet · live capacity and execution readiness', icon: ShieldCheck },
  { id: 'sponsor-resources', group: 'Sponsor', label: 'Resource markets', shortLabel: 'Resources', description: 'Energy, Bandwidth, staking and delegation controls', icon: Activity },
  { id: 'sponsor-automation', group: 'Provisioning', label: 'Automation & limits', shortLabel: 'Automation', description: 'Owner resource targets, preflight and guarded automation', icon: Network },
  { id: 'sponsor-activity', group: 'Audit', label: 'Activity & audit', shortLabel: 'Activity', description: 'Sponsor operations, wallet transactions and verification history', icon: History },
  { id: 'home', group: 'Overview', label: 'Home', shortLabel: 'Home', description: 'Global operations overview · TRON Mainnet', icon: Network },
  { id: 'monitor', group: 'Overview', label: 'Live monitor', shortLabel: 'Monitor', description: 'Live infrastructure, MCP execution, Mainnet resources and confirmed activity', icon: Activity },
  { id: 'profile', group: 'Account', label: 'Profile & security', shortLabel: 'Profile', description: 'Owner Admin session, wallet identity and account security', icon: ShieldCheck },
  { id: 'portfolio', group: 'Assets', label: 'Assets', shortLabel: 'Assets', description: 'Native TRX, official USDT and verified TRӾ balances', icon: Wallet },
  { id: 'deploy', group: 'Token operations', label: 'Deploy & verify', shortLabel: 'Deploy', description: 'Create or inspect the TRӾ Mainnet contract', icon: Rocket },
  { id: 'issuance', group: 'Token operations', label: 'Owner issuance', shortLabel: 'Issue', description: 'Mint new TRӾ to a recipient address', icon: Coins },
  { id: 'credits', group: 'Token operations', label: 'External credits', shortLabel: 'Credits', description: 'Single-address TRӾ credit issuance', icon: ArrowDownToLine },
  { id: 'batch', group: 'Token operations', label: 'Batch credits', description: 'Issue credits to up to 50 addresses', icon: Layers3 },
  { id: 'pause', group: 'Token operations', label: 'Emergency pause', description: 'Pause or resume token transfers', icon: PauseCircle },
  { id: 'minting', group: 'Token operations', label: 'Minting authorization', description: 'Enable or disable owner issuance', icon: ShieldCheck },
  { id: 'transfers', group: 'Transfers', label: 'Token transfers', shortLabel: 'Transfer', description: 'Transfer existing owner-held TRӾ', icon: ArrowLeftRight },
  { id: 'withdraw', label: 'Withdrawals', group: 'Transfers', shortLabel: 'Withdraw', description: 'Choose the asset-specific withdrawal workflow', icon: ArrowDownToLine },
  { id: 'withdraw-trx', label: 'Native TRX withdrawal', group: 'Transfers', description: 'Send native TRX from the Owner wallet', icon: ArrowDownToLine },
  { id: 'withdraw-usdt', label: 'Official USDT withdrawal', group: 'Transfers', description: 'Send official USDT TRC20 from the Owner wallet', icon: Coins },
  { id: 'ownership', group: 'Security', label: 'Ownership transfer', description: 'Two-step owner handoff', icon: Wallet },
  { id: 'history', group: 'Transfers', label: 'Credit history', description: 'Confirmed on-chain OwnerCredit events', icon: History },
  { id: 'balance', group: 'Assets', label: 'External balance lookup', description: 'Read any address token balance', icon: Blocks },
]


function pageFromLocation() {
  const candidate = window.location.hash.replace(/^#\/?/, '')
  return NAV_ITEMS.some(item => item.id === candidate) ? candidate : 'home'
}

export default function App() {
  const [activePage, setActivePage] = useState(pageFromLocation)
  const [wallet, setWallet] = useState(null)
  const [ownerAdminPassword, setOwnerAdminPassword] = useState('')
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

  useEffect(() => {
    const clearTransientOwnerPassword = () => setOwnerAdminPassword('')
    window.addEventListener('tron-transfer:sponsor-device-ready', clearTransientOwnerPassword)
    return () => window.removeEventListener('tron-transfer:sponsor-device-ready', clearTransientOwnerPassword)
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
    setOwnerAdminPassword(String(ownerWallet.ownerAdminPassword || ''))
    setOwnerAccessOpen(false)
    setWalletError('')
    setWalletNotice('Owner application session authenticated and the encrypted local Owner Wallet is unlocked. Every transaction still requires explicit confirmation.')
  }

  function lockWallet() {
    setOwnerSecurityOpen(false)
    ownerAuthClient.logout().catch(() => {})
    window.dispatchEvent(new Event('tron-transfer:owner-session-ended'))
    setWallet(null)
    setOwnerAdminPassword('')
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
      window.dispatchEvent(new Event('tron-transfer:owner-session-ended'))
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
          <span className="trax-kicker">TRON TRANSFER · OWNER & SPONSOR OPERATIONS</span>
          <h1>{page.label}</h1>
          <p>{page.description}</p>
        </div>
        <div className="trax-topbar-actions">
          <PWAInstallButton />
          <div className="trax-workspace-switch" role="group" aria-label="Wallet workspace">
            <button type="button" className={!sponsorWorkspace ? 'active' : ''} aria-current={!sponsorWorkspace ? 'page' : undefined} aria-pressed={!sponsorWorkspace} onClick={() => setActivePage('home')}><Network size={14}/> Owner</button>
            <button type="button" className={sponsorWorkspace ? 'active sponsor' : ''} aria-current={sponsorWorkspace ? 'page' : undefined} aria-pressed={sponsorWorkspace} onClick={() => setActivePage('sponsor')}><Wallet size={14}/> Sponsor</button>
          </div>
          <span className="trax-mainnet-badge"><i/> TRON MAINNET <b>·</b> {sponsorWorkspace ? "SPONSOR" : "OWNER"}</span><span className="trax-session-state"><i/>{wallet ? 'APPLICATION SESSION ACTIVE' : 'SIGN-IN REQUIRED'}</span>
          {!sponsorWorkspace && (wallet ? <><button type="button" className="trax-topbar-security" onClick={() => setOwnerSecurityOpen(true)}>Account security</button><button type="button" className="trax-topbar-wallet" onClick={lockWallet}><Wallet size={15}/>{wallet.address.slice(0,7)}…{wallet.address.slice(-5)} · Lock Owner</button></> : <button type="button" className="trax-topbar-connect" onClick={connectWallet}>Sign in</button>)}
        </div>
      </header>
      <main id="trax-workspace-main" className="trax-admin-content" tabIndex={-1}>
        {(walletError || walletNotice) && <div className={walletError ? 'trax-shell-alert error' : 'trax-shell-alert'} role={walletError ? 'alert' : 'status'}><AlertTriangle size={16}/><span>{walletError || walletNotice}</span><button onClick={() => {setWalletError('');setWalletNotice('')}} aria-label="Dismiss">×</button></div>}
        {sponsorWorkspace
          ? <SponsorWorkspaceErrorBoundary activePage={activePage} onNavigate={setActivePage}><SponsorWalletManager activePage={activePage} onNavigate={setActivePage} workspaceActive ownerAdminPassword={ownerAdminPassword}/></SponsorWorkspaceErrorBoundary>
          : <OwnerWorkspaceErrorBoundary activePage={activePage} onNavigate={setActivePage}>{activePage === 'home' ? <AetheriaMcpMesh wallet={wallet} onNavigate={setActivePage} compact/> : activePage === 'monitor' ? <AetheriaMcpMesh wallet={wallet} onNavigate={setActivePage}/> : activePage === 'profile' ? <OwnerAccountSecurity wallet={wallet} onConnect={connectWallet}/> : <TRXMainnetPanel wallet={wallet} onConnect={connectWallet} activePage={activePage === 'assets' ? 'portfolio' : activePage} onNavigate={setActivePage}/></OwnerWorkspaceErrorBoundary>}
      </main>
      {ownerAccessOpen && <OwnerWalletAccess onUnlock={acceptOwnerWallet} onClose={() => setOwnerAccessOpen(false)}/>}
      {ownerSecurityOpen && wallet && <div className="owner-security-modal-backdrop" role="dialog" aria-modal="true" aria-label="Owner account security" onMouseDown={event => { if (event.target === event.currentTarget) setOwnerSecurityOpen(false) }}><div className="owner-security-modal"><button type="button" className="owner-security-modal-close" onClick={() => setOwnerSecurityOpen(false)}>Close</button><OwnerAccountSecurity wallet={wallet} onConnect={connectWallet}/></div></div>}
    <footer className="trax-admin-footer">TRON TRANSFER · ROLE-SEPARATED LOCAL SIGNING · TRON MAINNET</footer>
    </div>
    <MobileNavBar items={visibleNavItems} activePage={activePage} onNavigate={setActivePage} workspace={sponsorWorkspace ? "sponsor" : "owner"}/>
  </div>
}
