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

// Web push. The payload carries ids only (never Seal text); the ledger fetches the Seal after the tap.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function sealIds(data) {
  if (data && typeof data === 'object' && UUID.test(data.sealId) && UUID.test(data.guildId)) {
    return { sealId: data.sealId, guildId: data.guildId }
  }
  return null
}

self.addEventListener('push', (event) => {
  let ids = null
  try {
    ids = sealIds(event.data ? event.data.json() : null)
  } catch {
    ids = null
  }
  if (!ids) {
    return
  }
  event.waitUntil(
    self.registration.showNotification('A Seal awaits your stamp', {
      body: 'Open the ledger to review it.',
      tag: ids.sealId,
      data: ids,
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const ids = sealIds(event.notification.data)
  const target = ids ? `/?seal=${ids.sealId}#seals-heading` : '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) {
        return open.navigate(target).then(() => open.focus())
      }
      return self.clients.openWindow(target)
    })
  )
})
