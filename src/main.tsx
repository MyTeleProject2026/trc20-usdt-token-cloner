import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import AuthGate from './AuthGate.tsx'
import WalletVault from './WalletVault.tsx'
import './index.css'

const root = createRoot(document.getElementById('root')!)

root.render(
  <StrictMode>
    <AuthGate>
      <WalletVault />
    </AuthGate>
  </StrictMode>,
)
