// BuildPro+ service worker: an offline launch page, and nothing else.
//
// It does NOT cache the app, its data or any API call. Every request still
// goes to the network exactly as before, so a deploy is picked up immediately
// and nobody is ever shown stale numbers. The only thing it adds: when a page
// load fails because the phone has no connection, show /offline.html instead
// of the browser's error screen (which, in the installed Android app, looks
// like the app is broken).
const CACHE = 'buildpro-offline-v1'
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.add(new Request(OFFLINE_URL, { cache: 'reload' }))),
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return
  event.respondWith(
    fetch(event.request).catch(async () => (await caches.match(OFFLINE_URL)) || Response.error()),
  )
})
