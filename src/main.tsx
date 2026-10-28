import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import OwnerControlApp from './OwnerControlApp'
import './index.css'

// The bundled web UI and Android APK share one owner-only entry point.
// Legacy explorer, sponsor-console and exchange-status pages are not exposed
// as client-side routes; the only operational workspace is Wallet Vault.
const root = createRoot(document.getElementById('root')!)
root.render(
  <StrictMode>
    <OwnerControlApp />
  </StrictMode>,
)
