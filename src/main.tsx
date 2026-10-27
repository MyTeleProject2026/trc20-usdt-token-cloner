import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './WorkflowApp.tsx'
import AuthGate from './AuthGate.tsx'
import SponsorSignerConsole from './SponsorSignerConsole.tsx'
import './index.css'

const root = createRoot(document.getElementById('root')!)

function renderRoute() {
  const isSponsorOperator = window.location.hash === '#/sponsor-operator'
  root.render(
    <StrictMode>
      <AuthGate>
        {isSponsorOperator ? <SponsorSignerConsole /> : <App />}
      </AuthGate>
    </StrictMode>,
  )
}

window.addEventListener('hashchange', renderRoute)
renderRoute()
