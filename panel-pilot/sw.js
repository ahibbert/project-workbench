const cacheName = "panel-pilot-v102";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (
    event.request.method !== "GET" ||
    event.request.mode === "navigate" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/login" ||
    url.pathname === "/logout"
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const contentType = response.headers.get("Content-Type") || "";
        const scriptOrStyleIsHtml = /\.(?:js|css)$/.test(url.pathname) && contentType.includes("text/html");
        if (response.ok && !response.redirected && !scriptOrStyleIsHtml) {
          const copy = response.clone();
          caches.open(cacheName).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
