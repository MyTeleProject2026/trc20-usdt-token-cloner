import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './WorkflowApp.tsx'
import AuthGate from './AuthGate.tsx'
import SponsorSignerConsole from './SponsorSignerConsole.tsx'
import MainnetExchangeDeposit from './MainnetExchangeDeposit.tsx'
import OkxDepositStatus from './OkxDepositStatus.tsx'
import WalletVault from './WalletVault.tsx'
import WatchOnlyWallets from './WatchOnlyWallets.tsx'
import './index.css'

const root = createRoot(document.getElementById('root')!)

function renderRoute() {
  const route = window.location.hash
  const isMainnetExchangeDeposit = route === '#/exchange-deposit'
  const isSponsorOperator = route === '#/sponsor-operator'
  const isOkxDepositStatus = route === '#/okx-deposit-status'
  const isWalletVault = route === '#/wallet'
  const isWatchOnlyWallets = route === '#/watch-wallets'
  // The authenticated default route opens the owner wallet dashboard. Keep the workflow builder as an explicit workspace route.
  const isWorkspace = route === '#/workspace'

  const page = isWalletVault
    ? <WalletVault />
    : isWatchOnlyWallets
      ? <WatchOnlyWallets />
      : isMainnetExchangeDeposit
        ? <MainnetExchangeDeposit />
        : isOkxDepositStatus
          ? <OkxDepositStatus />
          : isWorkspace || isSponsorOperator
            ? (isSponsorOperator ? <SponsorSignerConsole /> : <App />)
            : <WalletVault />

  // Every application route shares the same single-owner authentication gate.
  // The gate has no public registration flow and restores only a server-verified
  // owner session; public/read-only pages are gated too to keep the owner panel private.
  root.render(
    <StrictMode>
      <AuthGate>{page}</AuthGate>
    </StrictMode>,
  )
}

window.addEventListener('hashchange', renderRoute)
renderRoute()
