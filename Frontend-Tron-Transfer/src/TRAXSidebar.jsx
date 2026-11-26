import { ChevronDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

function groupId(value) {
  return 'trax-sidebar-group-' + String(value || 'workspace').toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

export default function TRAXSidebar({ items, activePage, onNavigate, wallet, onConnect, onLock, workspace = 'owner' }) {
  const [collapsed, setCollapsed] = useState(false)
  const groups = useMemo(() => Object.entries(items.reduce((result, item) => {
    const group = item.group || 'Workspace'
    ;(result[group] ||= []).push(item)
    return result
  }, {})), [items])
  const activeGroup = items.find(item => item.id === activePage)?.group || groups[0]?.[0] || 'Workspace'
  const [expandedGroups, setExpandedGroups] = useState(() => new Set([activeGroup]))

  useEffect(() => {
    setExpandedGroups(previous => new Set([...previous, activeGroup]))
  }, [activeGroup])

  function toggleGroup(group) {
    setExpandedGroups(previous => {
      const next = new Set(previous)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  return <aside className={collapsed ? 'trax-sidebar collapsed' : 'trax-sidebar'}>
    <div className="trax-sidebar-brand">
      <img src="/trax-token-mark.svg" alt="TRӾ token mark" />
      {!collapsed && <div><b>TRON TRANSFER</b><small>{workspace === 'sponsor' ? 'SPONSOR TREASURY · MAINNET' : 'OWNER CONTROL · MAINNET'}</small></div>}
    </div>
    <div className="trax-sidebar-network"><span className="trax-live-dot"/>{!collapsed && <><b>TRON Mainnet</b><small>{workspace === 'sponsor' ? 'Sponsor account workspace' : 'Owner account workspace'}</small></>}</div>
    {!collapsed && <div className="trax-sidebar-label">{workspace === 'sponsor' ? 'SPONSOR WORKSPACE' : 'OWNER WORKSPACE'}</div>}
    <nav id="trax-desktop-workspace-nav" aria-label={workspace === 'sponsor' ? 'Sponsor workspace navigation' : 'Owner workspace navigation'}>
      {groups.map(([group, groupItems]) => {
        const open = expandedGroups.has(group)
        const id = groupId(group)
        return <section className="trax-sidebar-group" key={group}>
          {!collapsed && <button type="button" className="trax-sidebar-group-toggle" aria-expanded={open} aria-controls={id} onClick={() => toggleGroup(group)}>
            <span>{group}</span><ChevronDown size={14} aria-hidden="true"/>
          </button>}
          <div id={id} className="trax-sidebar-group-items" hidden={!open}>
            {groupItems.map(item => {
              const Icon = item.icon
              return <button type="button" key={item.id} title={collapsed ? item.label : undefined} className={activePage === item.id ? 'active' : ''} aria-current={activePage === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>
                <Icon size={18}/>{!collapsed && <span>{item.label}</span>}
              </button>
            })}
          </div>
        </section>
      })}
    </nav>
    <div className="trax-sidebar-bottom">
      {workspace === 'owner' && !collapsed && <div className="trax-sidebar-wallet"><small>OWNER WALLET</small><b>{wallet?.address ? wallet.address.slice(0,8)+'…'+wallet.address.slice(-6) : 'Locked'}</b></div>}
      <button type="button" className="trax-sidebar-toggle" onClick={() => setCollapsed(value => !value)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed} aria-controls="trax-desktop-workspace-nav">
        {collapsed ? <PanelLeftOpen size={18}/> : <PanelLeftClose size={18}/>}
        {!collapsed && <span>Collapse menu</span>}
      </button>
      {workspace === 'owner' && !wallet && <button type="button" className="trax-sidebar-connect" onClick={onConnect}>Unlock Owner Wallet</button>}
      {workspace === 'owner' && wallet && <button type="button" className="trax-sidebar-connect" onClick={onLock}>Lock owner wallet</button>}
    </div>
  </aside>
}
