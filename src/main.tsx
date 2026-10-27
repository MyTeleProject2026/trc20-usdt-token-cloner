import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './WorkflowApp.tsx'
import AuthGate from './AuthGate.tsx'
import SponsorSignerConsole from './SponsorSignerConsole.tsx'
import MainnetExchangeDeposit from './MainnetExchangeDeposit.tsx'
import './index.css'

const root = createRoot(document.getElementById('root')!)

function renderRoute() {
  const route = window.location.hash
  const isMainnetExchangeDeposit = route === '#/exchange-deposit'
  const isSponsorOperator = route === '#/sponsor-operator'
  root.render(
    <StrictMode>
      {isMainnetExchangeDeposit
        ? <MainnetExchangeDeposit />
        : <AuthGate>
            {isSponsorOperator ? <SponsorSignerConsole /> : <App />}
          </AuthGate>}
    </StrictMode>,
  )
}

window.addEventListener('hashchange', renderRoute)
renderRoute()
