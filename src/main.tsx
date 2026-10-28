import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import MainnetExchangeDeposit from './MainnetExchangeDeposit.tsx'
import OkxDepositStatus from './OkxDepositStatus.tsx'
import WalletVault from './WalletVault.tsx'
import './index.css'

const root = createRoot(document.getElementById('root')!)

/**
 * The installed product is the single-owner Wallet Vault. Keep the two
 * read-only external-deposit status views available for reconciliation, but do
 * not expose the legacy multi-step sponsor workspace, sponsor operator console,
 * or watch-only wallet monitor as alternate app screens.
 *
 * Unknown/legacy hashes always return to the owner wallet rather than silently
 * mounting an unrelated workspace.
 */
function renderRoute() {
  const route = window.location.hash
  const isMainnetExchangeDeposit = route === '#/exchange-deposit'
  const isOkxDepositStatus = route === '#/okx-deposit-status'

  root.render(
    <StrictMode>
      {isMainnetExchangeDeposit
        ? <MainnetExchangeDeposit />
        : isOkxDepositStatus
          ? <OkxDepositStatus />
          : <WalletVault />}
    </StrictMode>,
  )
}

window.addEventListener('hashchange', renderRoute)
renderRoute()
