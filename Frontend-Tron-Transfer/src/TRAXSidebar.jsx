import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useMemo, useState } from 'react'

const OWNER_GROUPS = [
  { title: 'Workspace', ids: ['home', 'portfolio'] },
  { title: 'Token operations', ids: ['issuance', 'credits', 'batch', 'transfers', 'withdraw', 'history', 'balance'] },
  { title: 'Contract controls', ids: ['deploy', 'pause', 'minting', 'ownership'] },
]
const SPONSOR_GROUPS = [
  { title: 'Treasury', ids: ['sponsor'] },
  { title: 'Resource operations', ids: ['sponsor-resources', 'sponsor-automation'] },
  { title: 'Monitoring', ids: ['sponsor-activity'] },
]

export default function TRAXSidebar({ items, activePage, onNavigate, wallet, onConnect, onLock, workspace = 'owner' }) {
  const [collapsed, setCollapsed] = useState(false)
  const groups = useMemo(() => {
    const definitions = workspace === 'sponsor' ? SPONSOR_GROUPS : OWNER_GROUPS
    return definitions.map(group => ({
      ...group,
      items: group.ids.map(id => items.find(item => item.id === id)).filter(Boolean),
    })).filter(group => group.items.length)
  }, [items, workspace])

  return <aside className={collapsed ? 'trax-sidebar collapsed' : 'trax-sidebar'}>
    <a className="trax-sidebar-brand" href="#/home" onClick={event => { event.preventDefault(); onNavigate(workspace === 'sponsor' ? 'sponsor' : 'home') }}>
      <img src="https://thesvg.org/icons/tron/default.svg" alt="" />
      {!collapsed && <div><b>TRON TRANSFER</b><small>MAINNET OPERATIONS</small></div>}
    </a>
    <div className="trax-sidebar-network">
      <span className="trax-live-dot"/>
      {!collapsed && <div><b>TRON Mainnet</b><small>{workspace === 'sponsor' ? 'Independent Sponsor wallet' : 'Owner administration'}</small></div>}
      {!collapsed && <span className="trax-network-tag">LIVE</span>}
    </div>
    <div className="trax-sidebar-label">{!collapsed && (workspace === 'sponsor' ? 'SPONSOR TREASURY · MAINNET' : 'OWNER CONTROL · MAINNET')}</div>
    <nav id="trax-desktop-workspace-nav" aria-label={workspace === 'sponsor' ? 'Sponsor workspace pages' : 'Owner workspace pages'}>
      {groups.map(group => <section className="trax-sidebar-group" key={group.title} aria-label={group.title}>
        {!collapsed && <h2>{group.title}</h2>}
        {group.items.map(item => {
          const Icon = item.icon
          return <button key={item.id} title={collapsed ? item.label : undefined} className={activePage === item.id ? 'active' : ''} aria-current={activePage === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>
            <Icon size={18}/>{!collapsed && <span>{item.shortLabel || item.label}</span>}
          </button>
        })}
      </section>)}
    </nav>
    <div className="trax-sidebar-bottom">
      {workspace === 'owner' && !collapsed && <div className="trax-sidebar-wallet"><small>OWNER WALLET</small><b>{wallet?.address ? wallet.address.slice(0,8)+'…'+wallet.address.slice(-6) : 'Not connected'}</b></div>}
      <button className="trax-sidebar-toggle" onClick={() => setCollapsed(value => !value)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed} aria-controls="trax-desktop-workspace-nav">
        {collapsed ? <PanelLeftOpen size={18}/> : <PanelLeftClose size={18}/>}
        {!collapsed && <span>Collapse menu</span>}
      </button>
      {workspace === 'owner' && !wallet && <button className="trax-sidebar-connect" onClick={onConnect}>Unlock Owner Wallet</button>}
      {workspace === 'owner' && wallet && <button className="trax-sidebar-connect" onClick={onLock}>Lock Owner wallet</button>}
    </div>
  </aside>
}
