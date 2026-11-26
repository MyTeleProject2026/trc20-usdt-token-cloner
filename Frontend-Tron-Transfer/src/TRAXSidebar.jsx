import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useState } from 'react'

export default function TRAXSidebar({ items, activePage, onNavigate, wallet, onConnect, onLock, workspace = 'owner' }) {
  const [collapsed, setCollapsed] = useState(false)
  return <aside className={collapsed ? 'trax-sidebar collapsed' : 'trax-sidebar'}>
    <div className="trax-sidebar-brand">
      <img src="/trax-token-mark.svg" alt="TRӾ token mark" />
      {!collapsed && <div><b>TRON TRANSFER</b><small>{workspace === 'sponsor' ? 'SPONSOR TREASURY · MAINNET' : 'OWNER CONTROL · MAINNET'}</small></div>}
    </div>
    <div className="trax-sidebar-network"><span className="trax-live-dot"/>{!collapsed && <><b>TRON Mainnet</b><small>{workspace === 'sponsor' ? 'Sponsor account workspace' : 'Owner account workspace'}</small></>}</div>
    <div className="trax-sidebar-label">{!collapsed && (workspace === 'sponsor' ? 'SPONSOR WORKSPACE' : 'OWNER WORKSPACE')}</div>
    <nav id="trax-desktop-workspace-nav" aria-label={workspace === 'sponsor' ? 'Sponsor workspace pages' : 'Owner workspace pages'}>
      {Object.entries(items.reduce((groups, item) => { const group = item.group || 'Workspace'; (groups[group] ||= []).push(item); return groups }, {})).map(([group, groupItems]) => <div className="trax-sidebar-group" key={group}><div className="trax-sidebar-group-title">{!collapsed && group}</div>{groupItems.map(item => {
        const Icon = item.icon
        return <button key={item.id} title={collapsed ? item.label : undefined} className={activePage === item.id ? 'active' : ''} aria-current={activePage === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>
          <Icon size={18}/>{!collapsed && <span>{item.label}</span>}
        </button>
      })}</div>)}
    </nav>
    <div className="trax-sidebar-bottom">
      {workspace === 'owner' && !collapsed && <div className="trax-sidebar-wallet"><small>OWNER WALLET</small><b>{wallet?.address ? wallet.address.slice(0,8)+'…'+wallet.address.slice(-6) : 'Not connected'}</b></div>}
      <button className="trax-sidebar-toggle" onClick={() => setCollapsed(value => !value)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed} aria-controls="trax-desktop-workspace-nav">
        {collapsed ? <PanelLeftOpen size={18}/> : <PanelLeftClose size={18}/>}
        {!collapsed && <span>Collapse menu</span>}
      </button>
      {workspace === 'owner' && !wallet && <button className="trax-sidebar-connect" onClick={onConnect}>Connect Owner Wallet</button>}
      {workspace === 'owner' && wallet && <button className="trax-sidebar-connect" onClick={onLock}>Lock owner wallet</button>}
    </div>
  </aside>
}
