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
  const isLegacyWorkspace = route === '#/workspace'

  root.render(
    <StrictMode>
      {isWalletVault
        ? <WalletVault />
        : isWatchOnlyWallets
          ? <WatchOnlyWallets />
          : isMainnetExchangeDeposit
            ? <MainnetExchangeDeposit />
            : isOkxDepositStatus
              ? <OkxDepositStatus />
              : isLegacyWorkspace || isSponsorOperator
                ? <AuthGate>{isSponsorOperator ? <SponsorSignerConsole /> : <App />}</AuthGate>
                : <WalletVault />}
    </StrictMode>,
  )
}

window.addEventListener('hashchange', renderRoute)
renderRoute()
