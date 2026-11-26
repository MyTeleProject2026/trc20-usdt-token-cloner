import { useEffect, useState } from 'react'
import './pwa-install.css'

function isAppleMobileDevice() {
  if (typeof navigator === 'undefined') return false
  return /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function isRunningStandalone() {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || navigator.standalone === true
}

export default function PWAInstallButton() {
  const [installPrompt, setInstallPrompt] = useState(null)
  const [installed, setInstalled] = useState(isRunningStandalone)
  const [showHelp, setShowHelp] = useState(false)
  const appleMobile = isAppleMobileDevice()

  useEffect(() => {
    const onBeforeInstallPrompt = event => {
      event.preventDefault()
      setInstallPrompt(event)
    }
    const onAppInstalled = () => {
      setInstalled(true)
      setInstallPrompt(null)
      setShowHelp(false)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onAppInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onAppInstalled)
    }
  }, [])

  if (installed) return null

  async function handleInstall() {
    if (!installPrompt) {
      setShowHelp(value => !value)
      return
    }

    try {
      await installPrompt.prompt()
      const choice = await installPrompt.userChoice
      if (choice?.outcome === 'accepted') setInstalled(true)
    } finally {
      setInstallPrompt(null)
    }
  }

  return (
    <div className="pwa-install-control">
      <button
        type="button"
        className="pwa-install-button"
        onClick={handleInstall}
        aria-expanded={showHelp}
        aria-controls="pwa-install-help"
      >
        <span aria-hidden="true">⇩</span>
        Install app
      </button>
      {showHelp && (
        <p className="pwa-install-help" id="pwa-install-help" role="status">
          {appleMobile
            ? 'In Safari, tap Share, then choose “Add to Home Screen”.'
            : 'Open your browser menu and choose “Install app” or “Add to Home screen”.'}
        </p>
      )}
    </div>
  )
}
