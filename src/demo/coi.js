// Cross-origin isolation for hosts that will not send the headers.
//
// The runtime is built with threads, so the page needs SharedArrayBuffer, so it
// has to be cross-origin isolated — and a static host like GitHub Pages has no
// way to set Cross-Origin-Opener-Policy on its responses. A service worker can:
// it sits in front of every request the page makes and adds the headers to the
// responses on their way back, which is enough for the browser to grant
// isolation on the next load.
//
// The file is loaded as a classic script by the page *and* installed as the
// worker itself, hence the two halves.

if (typeof window === 'undefined') {
  // ---------------------------------------------------------- the worker ---
  self.addEventListener('install', () => self.skipWaiting())
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

  self.addEventListener('fetch', (event) => {
    const request = event.request

    // A cache-only request from a different origin cannot be served by fetch();
    // letting it fall through to the network is the documented workaround.
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return

    event.respondWith(
      fetch(request)
        .then((response) => {
          // An opaque response has no headers to rewrite, and constructing a
          // new Response from one would strip its body.
          if (response.status === 0) return response

          const headers = new Headers(response.headers)
          headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
          headers.set('Cross-Origin-Opener-Policy', 'same-origin')
          if (!headers.has('Cross-Origin-Resource-Policy')) {
            headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
          }

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        })
        .catch((err) => {
          console.error('[coi]', err)
          throw err
        }),
    )
  })
} else {
  // ------------------------------------------------------------ the page ---
  if (window.crossOriginIsolated) {
    // The server sends the headers itself; nothing to do.
  } else if (!window.isSecureContext) {
    console.warn('[coi] service workers need a secure context — serve over https or localhost')
  } else if (!navigator.serviceWorker) {
    console.warn('[coi] this browser has no service workers, so the page cannot be isolated')
  } else {
    navigator.serviceWorker
      .register(document.currentScript.src)
      .then((registration) => {
        // Reload once, so the document itself comes back through the worker and
        // is served with the headers. `sessionStorage` is what stops that from
        // becoming a loop when isolation still does not take.
        if (registration.active && !navigator.serviceWorker.controller) {
          if (sessionStorage.getItem('coi-reloaded') === '1') {
            console.warn('[coi] still not isolated after a reload; giving up')
            return
          }
          sessionStorage.setItem('coi-reloaded', '1')
          window.location.reload()
        } else if (window.crossOriginIsolated) {
          sessionStorage.removeItem('coi-reloaded')
        }
      })
      .catch((err) => console.error('[coi] registration failed', err))
  }
}
