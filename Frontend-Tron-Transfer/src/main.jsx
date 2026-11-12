import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import SponsorPortal from './SponsorPortal.jsx'
import CustomerRestrictedCredits from './CustomerRestrictedCredits.jsx'
import './styles.css'

const root = createRoot(document.getElementById('root'))

function renderRoute() {
  const page = window.location.hash === '#/sponsor' ? <SponsorPortal /> : window.location.hash === '#/credits' ? <CustomerRestrictedCredits /> : <App />
  root.render(
    <React.StrictMode>
      {page}
    </React.StrictMode>,
  )
}

window.addEventListener('hashchange', renderRoute)
renderRoute()
