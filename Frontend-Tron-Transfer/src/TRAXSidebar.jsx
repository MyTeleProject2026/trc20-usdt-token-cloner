import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useState } from 'react'

export default function TRAXSidebar({ items, activePage, onNavigate, wallet, onConnect, onLock }) {
  const [collapsed, setCollapsed] = useState(false)
  return <aside className={collapsed ? 'trax-sidebar collapsed' : 'trax-sidebar'}>
    <div className="trax-sidebar-brand">
      <img src="https://thesvg.org/icons/tron/default.svg" alt="TRON icon" />
      {!collapsed && <div><b>TRON TRANSFER</b><small>OWNER CONTROL · MAINNET</small></div>}
    </div>
    <div className="trax-sidebar-network"><span className="trax-live-dot"/>{!collapsed && <><b>TRON Mainnet</b><small>Target network</small></>}</div>
    <div className="trax-sidebar-label">{!collapsed && 'WORKSPACE'}</div>
    <nav id="trax-desktop-workspace-nav" aria-label="Desktop workspace navigation">
      {items.map(item => {
        const Icon = item.icon
        return <button key={item.id} title={collapsed ? item.label : undefined} className={activePage === item.id ? 'active' : ''} aria-current={activePage === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>
          <Icon size={18}/>{!collapsed && <span>{item.label}</span>}
        </button>
      })}
    </nav>
    <div className="trax-sidebar-bottom">
      {!collapsed && <div className="trax-sidebar-wallet"><small>OWNER WALLET</small><b>{wallet?.address ? wallet.address.slice(0,8)+'…'+wallet.address.slice(-6) : 'Not connected'}</b></div>}
      <button className="trax-sidebar-toggle" onClick={() => setCollapsed(value => !value)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed} aria-controls="trax-desktop-workspace-nav">
        {collapsed ? <PanelLeftOpen size={18}/> : <PanelLeftClose size={18}/>}
        {!collapsed && <span>Collapse menu</span>}
      </button>
      {!wallet && <button className="trax-sidebar-connect" onClick={onConnect}>Connect TronLink</button>}
      {wallet && <button className="trax-sidebar-connect" onClick={onLock}>Lock wallet</button>}
    </div>
  </aside>
}
