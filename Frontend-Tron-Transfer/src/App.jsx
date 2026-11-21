import React, { useEffect, useState } from 'react'
import { Activity, AlertTriangle, ArrowLeftRight, ArrowDownToLine, Blocks, Network, Coins, History, Layers3, PauseCircle, Rocket, ShieldCheck, Wallet } from 'lucide-react'
import TRXMainnetPanel from './TRXMainnetPanel.jsx'
import TRAXSidebar from './TRAXSidebar.jsx'
import MobileNavBar from './MobileNavBar.jsx'
import AetheriaMcpMesh from './AetheriaMcpMesh.jsx'
import SponsorWalletManager from './SponsorWalletManager.jsx'
import OwnerWalletAccess from './OwnerWalletAccess.jsx'

class SponsorWorkspaceErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false } }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error, info) { console.error('Sponsor workspace render failure', error, info?.componentStack) }
  componentDidUpdate(previousProps) { if (previousProps.activePage !== this.props.activePage && this.state.hasError) this.setState({ hasError: false }) }
  render() {
    if (this.state.hasError) return <section className="sponsor-card sponsor-render-error" role="alert"><div className="sponsor-card-heading"><AlertTriangle/><div><h3>Sponsor workspace page failed to render</h3><p>The failure was contained so it cannot blank the entire application. No transaction was submitted.</p></div></div><button type="button" className="sponsor-secondary" onClick={() => this.setState({ hasError: false })}>Retry this page</button></section>
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
  { id: 'ownership', label: 'Ownership transfer', description: 'Two-step owner handoff', icon: Wallet },
  { id: 'history', label: 'Credit history', description: 'Confirmed on-chain OwnerCredit events', icon: History },
  { id: 'balance', label: 'External balance lookup', description: 'Read any address token balance', icon: Blocks },
]


export default function App() {
  const [activePage, setActivePage] = useState(() => window.location.hash === '#/sponsor' ? 'sponsor' : 'home')
  const [wallet, setWallet] = useState(null)
  const [walletError, setWalletError] = useState('')
  const [walletNotice, setWalletNotice] = useState('')
  const [ownerAccessOpen, setOwnerAccessOpen] = useState(false)

  function connectWallet() {
    setWalletError('')
    setWalletNotice('')
    setOwnerAccessOpen(true)
  }

  function acceptOwnerWallet(ownerWallet) {
    setWallet(ownerWallet)
    setOwnerAccessOpen(false)
    setWalletError('')
    setWalletNotice('Owner Wallet unlocked. Transactions are signed locally by your encrypted Owner vault; each write still requires explicit application confirmation.')
  }

  function lockWallet() {
    setWallet(null)
    setOwnerAccessOpen(true)
    setActivePage('home')
    setWalletNotice('Owner Wallet locked. Its encrypted local backup remains available for unlock or logout.')
  }


  useEffect(() => {
    if (!wallet) return undefined
    let idleTimer
    let backgroundTimer
    const lock = () => {
      setWallet(null)
      setActivePage('home')
      setOwnerAccessOpen(true)
      setWalletNotice('Owner Wallet automatically locked. Unlock it with your local vault password to continue.')
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
          <div className="trax-workspace-switch" role="group" aria-label="Wallet workspace">
            <button type="button" className={!sponsorWorkspace ? 'active' : ''} aria-pressed={!sponsorWorkspace} onClick={() => setActivePage('home')}>Owner workspace</button>
            <button type="button" className={sponsorWorkspace ? 'active sponsor' : ''} aria-pressed={sponsorWorkspace} onClick={() => setActivePage('sponsor')}>Sponsor workspace</button>
          </div>
          <span className="trax-mainnet-badge"><i/> TRON MAINNET</span>
          {!sponsorWorkspace && (wallet ? <button type="button" className="trax-topbar-wallet" onClick={lockWallet}><Wallet size={15}/>{wallet.address.slice(0,7)}…{wallet.address.slice(-5)} · Lock Owner</button> : <button type="button" className="trax-topbar-connect" onClick={connectWallet}>Unlock Owner Wallet</button>)}
        </div>
      </header>
      <main className="trax-admin-content">
        {(walletError || walletNotice) && <div className={walletError ? 'trax-shell-alert error' : 'trax-shell-alert'} role={walletError ? 'alert' : 'status'}><AlertTriangle size={16}/><span>{walletError || walletNotice}</span><button onClick={() => {setWalletError('');setWalletNotice('')}} aria-label="Dismiss">×</button></div>}
        <div hidden={!sponsorWorkspace} aria-hidden={!sponsorWorkspace}>
          <SponsorWorkspaceErrorBoundary activePage={activePage}><SponsorWalletManager activePage={activePage} onNavigate={setActivePage} workspaceActive={sponsorWorkspace}/></SponsorWorkspaceErrorBoundary>
        </div>
        <div hidden={sponsorWorkspace} aria-hidden={sponsorWorkspace}>
          {activePage === 'home' ? <AetheriaMcpMesh wallet={wallet} onNavigate={setActivePage}/> : <TRXMainnetPanel wallet={wallet} onConnect={connectWallet} activePage={activePage} onNavigate={setActivePage}/>}
        </div>
      </main>
      {ownerAccessOpen && <OwnerWalletAccess onUnlock={acceptOwnerWallet} onClose={() => setOwnerAccessOpen(false)}/>}
    <footer className="trax-admin-footer">TRON TRANSFER · INDEPENDENT OWNER SIGNING · TRON MAINNET</footer>
    </div>
    <MobileNavBar items={visibleNavItems} activePage={activePage} onNavigate={setActivePage} workspace={sponsorWorkspace ? "sponsor" : "owner"}/>
  </div>
}
