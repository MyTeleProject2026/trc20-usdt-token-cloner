/* Installability-only service worker. Wallet, API and transaction traffic is never cached. */
const SERVICE_WORKER_VERSION = 'tron-transfer-pwa-v1'

self.addEventListener('install', event => {
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return

  const requestUrl = new URL(request.url)
  if (requestUrl.origin !== self.location.origin) return

  // Network-only by design: do not persist wallet state, API responses, balances,
  // transaction payloads, or stale application bundles in a service-worker cache.
  event.respondWith(fetch(request))
})
