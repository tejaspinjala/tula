// Minimal service worker: makes the ledger shell installable and keeps the shell available
// offline. API calls and anything not a same-origin GET always go to the network.
const SHELL = 'ledger-shell-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(['/', '/icon.svg'])))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  ) {
    return
  }
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then((r) => r || caches.match('/'))
    )
  )
})
