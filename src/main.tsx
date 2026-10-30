import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './WorkflowApp.tsx'
import AuthGate from './AuthGate.tsx'
import SponsorSignerConsole from './SponsorSignerConsole.tsx'
import SponsorPayoutAuthorization from './SponsorPayoutAuthorization.tsx'
import MainnetExchangeDeposit from './MainnetExchangeDeposit.tsx'
import OkxDepositStatus from './OkxDepositStatus.tsx'
import WalletVault from './WalletVault.tsx'
import WatchOnlyWallets from './WatchOnlyWallets.tsx'
import TestnetSandbox from './TestnetSandbox.tsx'
import './index.css'

const root = createRoot(document.getElementById('root')!)

function renderRoute() {
  const route = window.location.hash
  const isSponsorPayoutAuthorization = route === '#/sponsor-authorization'
  const isMainnetExchangeDeposit = route === '#/exchange-deposit'
  const isSponsorOperator = route === '#/sponsor-operator'
  const isOkxDepositStatus = route === '#/okx-deposit-status'
  const isWalletVault = route === '#/wallet'
  const isTestnetSandbox = route === '#/testnet-sandbox'
  const isWatchOnlyWallets = route === '#/watch-wallets'
  const isLegacyWorkspace = route === '#/workspace'

  const page = isTestnetSandbox
    ? <TestnetSandbox />
    : isWalletVault
      ? <WalletVault />
      : isWatchOnlyWallets
        ? <WatchOnlyWallets />
        : isMainnetExchangeDeposit
          ? <MainnetExchangeDeposit />
          : isOkxDepositStatus
            ? <OkxDepositStatus />
            : isLegacyWorkspace || isSponsorOperator
              ? (isSponsorOperator ? <SponsorSignerConsole /> : <App />)
              : <WalletVault />

  // Independent sponsor owners use wallet-message authentication on the dedicated
  // intent approval page; they must not need the platform operator's owner password.
  if (isSponsorPayoutAuthorization) {
    root.render(
      <StrictMode>
        <SponsorPayoutAuthorization />
      </StrictMode>,
    )
    return
  }

  // Every operator/application route shares the same single-owner authentication gate.
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
