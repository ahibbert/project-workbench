import {
  cleanupOutdatedCaches,
  matchPrecache,
  precache,
} from "workbox-precaching";

const legacyAppCachePattern = /^panel-pilot-v\d+$/;

cleanupOutdatedCaches();
precache(self.__WB_MANIFEST);

function isOnlineOnlyPath(pathname) {
  return pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/login"
    || pathname.startsWith("/login/")
    || pathname === "/logout"
    || pathname.startsWith("/logout/");
}

function isAppShellNavigation(request, pathname) {
  return request.mode === "navigate"
    && (pathname === "/" || pathname === "/index.html");
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheKeys = await caches.keys();
    await Promise.all(
      cacheKeys
        .filter((cacheKey) => legacyAppCachePattern.test(cacheKey))
        .map((cacheKey) => caches.delete(cacheKey)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isOnlineOnlyPath(url.pathname)) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (error) {
        if (isAppShellNavigation(request, url.pathname)) {
          const appShell = await matchPrecache("/index.html");
          if (appShell) return appShell;
        }
        throw error;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      return await fetch(request);
    } catch (error) {
      const precachedResponse = await matchPrecache(request);
      if (precachedResponse) return precachedResponse;
      throw error;
    }
  })());
});
