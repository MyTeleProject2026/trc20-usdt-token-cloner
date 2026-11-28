import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Grid2X2, Wallet, X } from 'lucide-react'

const OWNER_PRIMARY = ['home', 'deploy', 'monitor', 'portfolio', 'profile']
const SPONSOR_PRIMARY = ['sponsor', 'sponsor-resources', 'sponsor-activity']

function grouped(items) {
  return Object.entries(items.reduce((result, item) => {
    const group = item.group || 'Workspace'
    ;(result[group] ||= []).push(item)
    return result
  }, {}))
}

export default function MobileNavBar({ items, activePage, onNavigate, workspace = 'owner' }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const moreButtonRef = useRef(null)
  const sheetRef = useRef(null)
  const wasMoreOpen = useRef(false)
  const primaryIds = workspace === 'sponsor' ? SPONSOR_PRIMARY : OWNER_PRIMARY
  const primary = items.filter(item => primaryIds.includes(item.id))
  const secondary = items.filter(item => !primaryIds.includes(item.id))
  const secondaryGroups = useMemo(() => grouped(secondary), [secondary])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const close = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMoreOpen(false)
        return
      }
      if (event.key !== 'Tab' || !sheetRef.current) return
      const focusable = [...sheetRef.current.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    if (moreOpen) {
      document.body.style.overflow = 'hidden'
      document.addEventListener('keydown', close)
      sheetRef.current?.querySelector('button')?.focus()
    } else if (wasMoreOpen.current) moreButtonRef.current?.focus()
    wasMoreOpen.current = moreOpen
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', close)
    }
  }, [moreOpen])

  const choose = id => { onNavigate(id); setMoreOpen(false) }
  const isSecondaryActive = secondary.some(item => item.id === activePage)

  return <>
    {moreOpen && <>
      <button type="button" className="trax-mobile-backdrop" aria-label="Close navigation menu" onClick={() => setMoreOpen(false)}/>
      <section id="trax-mobile-sheet" className="trax-mobile-sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-label={workspace === 'sponsor' ? 'More Sponsor sections' : 'More Owner sections'}>
        <div className="trax-mobile-sheet-heading">
          <div><span className="trax-kicker">TRON TRANSFER · MAINNET</span><h2>More workspace · {workspace === 'sponsor' ? 'Sponsor' : 'Owner'}</h2><p>Choose a task area</p></div>
          <button type="button" className="trax-icon-button" onClick={() => setMoreOpen(false)} aria-label="Close menu"><X size={18}/></button>
        </div>
        <div className="trax-mobile-sheet-groups">
          {secondaryGroups.map(([group, groupItems]) => <section className="trax-mobile-sheet-group" key={group}>
            <h3>{group}</h3>
            <div className="trax-mobile-sheet-grid">
              {groupItems.map(item => {
                const Icon = item.icon
                return <button type="button" key={item.id} className={activePage === item.id ? 'selected' : ''} onClick={() => choose(item.id)}>
                  <span className="trax-nav-icon"><Icon size={17}/></span>
                  <span><b>{item.label}</b><small>{item.description}</small></span>
                  <ChevronRight size={15}/>
                </button>
              })}
            </div>
          </section>)}
          {workspace === 'sponsor' && <button type="button" className="trax-mobile-owner-switch" onClick={() => choose('home')}><Wallet size={17}/><span><b>Switch to Owner workspace</b><small>Return to Owner administration</small></span><ChevronRight size={15}/></button>}
        </div>
      </section>
    </>}
    <nav className={'trax-mobile-nav' + (workspace === 'sponsor' ? ' trax-mobile-nav-sponsor' : '')} aria-label={workspace === 'sponsor' ? 'Sponsor workspace navigation' : 'Owner workspace navigation'}>
      {primary.map(item => {
        const Icon = item.icon
        return <button type="button" key={item.id} className={activePage === item.id ? 'active' : ''} aria-current={activePage === item.id ? 'page' : undefined} onClick={() => choose(item.id)}>
          <Icon size={19}/><span>{item.shortLabel || item.label}</span>
        </button>
      })}
      <button type="button" ref={moreButtonRef} className={moreOpen || isSecondaryActive ? 'active' : ''} aria-expanded={moreOpen} aria-haspopup="dialog" aria-controls="trax-mobile-sheet" onClick={() => setMoreOpen(value => !value)}>
        <Grid2X2 size={19}/><span>More</span>
      </button>
    </nav>
  </>
}
