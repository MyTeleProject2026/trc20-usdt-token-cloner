import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Grid2X2, X } from 'lucide-react'

const primaryIds = ['overview', 'issuance', 'credits', 'transfers']

export default function MobileNavBar({ items, activePage, onNavigate }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const moreButtonRef = useRef(null)
  const sheetRef = useRef(null)
  const wasMoreOpen = useRef(false)
  const primary = items.filter(item => primaryIds.includes(item.id))
  const secondary = items.filter(item => !primaryIds.includes(item.id))

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const close = event => { if (event.key === 'Escape') setMoreOpen(false) }
    if (moreOpen) {
      document.body.style.overflow = 'hidden'
      document.addEventListener('keydown', close)
      sheetRef.current?.querySelector('button')?.focus()
    } else if (wasMoreOpen.current) {
      moreButtonRef.current?.focus()
    }
    wasMoreOpen.current = moreOpen
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', close)
    }
  }, [moreOpen])

  const choose = id => {
    onNavigate(id)
    setMoreOpen(false)
  }

  return <>
    {moreOpen && <>
      <button className="trax-mobile-backdrop" aria-label="Close navigation menu" onClick={() => setMoreOpen(false)}/>
      <section className="trax-mobile-sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-label="More TRӾ sections">
        <div className="trax-mobile-sheet-heading">
          <div><span className="trax-kicker">TRON TRANSFER · MAINNET</span><h2>More workspace</h2></div>
          <button className="trax-icon-button" onClick={() => setMoreOpen(false)} aria-label="Close menu"><X size={18}/></button>
        </div>
        <div className="trax-mobile-sheet-grid">
          {secondary.map(item => {
            const Icon = item.icon
            return <button key={item.id} className={activePage === item.id ? 'selected' : ''} onClick={() => choose(item.id)}>
              <span className="trax-nav-icon"><Icon size={17}/></span>
              <span><b>{item.label}</b><small>{item.description}</small></span>
              <ChevronRight size={15}/>
            </button>
          })}
        </div>
      </section>
    </>}
    <nav className="trax-mobile-nav" aria-label="Main mobile navigation">
      {primary.map(item => {
        const Icon = item.icon
        return <button key={item.id} className={activePage === item.id ? 'active' : ''} aria-current={activePage === item.id ? 'page' : undefined} onClick={() => choose(item.id)}>
          <Icon size={19}/><span>{item.shortLabel || item.label}</span>
        </button>
      })}
      <button ref={moreButtonRef} className={moreOpen || secondary.some(item => item.id === activePage) ? 'active' : ''} aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}>
        <Grid2X2 size={19}/><span>More</span>
      </button>
    </nav>
  </>
}
