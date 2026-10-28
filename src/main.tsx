import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
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

  const page = isWalletVault
    ? <WalletVault />
    : isWatchOnlyWallets
      ? <WatchOnlyWallets />
      : isMainnetExchangeDeposit
        ? <MainnetExchangeDeposit />
        : isOkxDepositStatus
          ? <OkxDepositStatus />
          : isSponsorOperator
            ? <SponsorSignerConsole />
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
