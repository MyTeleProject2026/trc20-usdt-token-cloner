import { useEffect, useState } from 'react'
import { TronWeb } from 'tronweb'
import { AlertTriangle, ArrowLeftRight, ArrowDownToLine, Blocks, Network, Coins, History, Layers3, PauseCircle, Rocket, ShieldCheck, Wallet } from 'lucide-react'
import { discoverTronLinkProvider, requestTronLinkConnection } from './tronlink-provider.mjs'
import TRXMainnetPanel from './TRXMainnetPanel.jsx'
import TRAXSidebar from './TRAXSidebar.jsx'
import MobileNavBar from './MobileNavBar.jsx'
import AetheriaMcpMesh from './AetheriaMcpMesh.jsx'
import SponsorWalletManager from './SponsorWalletManager.jsx'

const NAV_ITEMS = [
  { id: 'sponsor', label: 'TRON TRANSFER SPONSOR', shortLabel: 'Sponsor', description: 'Imported sponsor wallet · live resources and verified delegation', icon: ShieldCheck },
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

function isValidTronAddress(address) {
  try { return TronWeb.isAddress(String(address || '')) && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(address)) }
  catch { return false }
}

export default function App() {
  const [activePage, setActivePage] = useState(() => window.location.hash === '#/sponsor' ? 'sponsor' : 'home')
  const [wallet, setWallet] = useState(null)
  const [walletBusy, setWalletBusy] = useState(false)
  const [walletError, setWalletError] = useState('')
  const [walletNotice, setWalletNotice] = useState('')

  async function connectWallet() {
    setWalletBusy(true)
    setWalletError('')
    setWalletNotice('')
    try {
      const provider = await discoverTronLinkProvider(window)
      if (!provider) throw new Error("No compatible injected TRON wallet was detected. Open this page in TronLink's DApp browser or enable its browser extension.")
      const { address, tronWeb } = await requestTronLinkConnection(provider, window)
      if (!isValidTronAddress(address)) throw new Error('TronLink returned an invalid TRON address.')
      const host = new URL(String(tronWeb.fullNode?.host || '')).hostname.toLowerCase()
      if (host !== 'api.trongrid.io') throw new Error('Network mismatch. Switch TronLink to TRON Mainnet and reconnect.')
      setWallet({ address, tronWeb, provider })
      setWalletNotice('Wallet connected. Every contract write still requires a separate TronLink approval.')
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Wallet connection failed.')
    } finally {
      setWalletBusy(false)
    }
  }

  function lockWallet() {
    setWallet(null)
    setActivePage('home')
    setWalletNotice('Wallet disconnected from this workspace. Your wallet remains under your control in TronLink.')
  }

  useEffect(() => {
    const provider = wallet?.provider
    if (!provider?.on) return undefined
    const invalidate = () => {
      setWallet(null)
      setActivePage('home')
      setWalletNotice('TronLink account or network changed. Reconnect and verify the intended owner address.')
    }
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) provider.on(event, invalidate)
    return () => {
      if (typeof provider.removeListener === 'function') {
        for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) provider.removeListener(event, invalidate)
      }
    }
  }, [wallet?.provider])

  const page = NAV_ITEMS.find(item => item.id === activePage) || NAV_ITEMS[0]
  return <div className="trax-admin-shell">
    <TRAXSidebar items={NAV_ITEMS} activePage={activePage} onNavigate={setActivePage} wallet={wallet} onConnect={connectWallet} onLock={lockWallet}/>
    <div className="trax-admin-main">
      <header className="trax-admin-topbar">
        <div className="trax-topbar-title">
          <span className="trax-kicker">TRӾ smart-contract manager · TRON TRANSFER OWNER CONSOLE</span>
          <h1>{page.label}</h1>
          <p>{page.description}</p>
        </div>
        <div className="trax-topbar-actions">
          <span className="trax-mainnet-badge"><i/> TRON MAINNET</span>
          {wallet ? <button type="button" className="trax-topbar-wallet" onClick={lockWallet}><Wallet size={15}/>{wallet.address.slice(0,7)}…{wallet.address.slice(-5)} · Lock Owner</button> : <button type="button" className="trax-topbar-connect" disabled={walletBusy} onClick={connectWallet}>{walletBusy ? 'Connecting…' : 'Connect Owner Wallet'}</button>}
        </div>
      </header>
      <main className="trax-admin-content">
        {(walletError || walletNotice) && <div className={walletError ? 'trax-shell-alert error' : 'trax-shell-alert'} role={walletError ? 'alert' : 'status'}><AlertTriangle size={16}/><span>{walletError || walletNotice}</span><button onClick={() => {setWalletError('');setWalletNotice('')}} aria-label="Dismiss">×</button></div>}
        {activePage === 'sponsor' ? <SponsorWalletManager/> : activePage === 'home' ? <AetheriaMcpMesh wallet={wallet} onNavigate={setActivePage}/> : <TRXMainnetPanel wallet={wallet} onConnect={connectWallet} activePage={activePage} onNavigate={setActivePage}/>}
      </main>
      <footer className="trax-admin-footer">TRON TRANSFER · WALLET-CONTROLLED OWNER WORKSPACE · TRON MAINNET</footer>
    </div>
    <MobileNavBar items={NAV_ITEMS} activePage={activePage} onNavigate={setActivePage}/>
  </div>
}
