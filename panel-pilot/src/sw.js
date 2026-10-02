import {
  cleanupOutdatedCaches,
  matchPrecache,
  precache,
} from "workbox-precaching";

const legacyAppCachePattern = /^panel-pilot-v\d+$/;
const deviceChapterCacheName = "panels-device-chapters-v1";
const deviceChapterPathPrefix = "/__panels_device_chapters/v1/";
const lifecycleProtocolVersion = 2;
const workerBuildId = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "unknown";

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

function isObsoleteLegacyAppCache(cacheKey) {
  return cacheKey !== deviceChapterCacheName && legacyAppCachePattern.test(cacheKey);
}

async function deviceChapterResponse(request) {
  const chapterCache = await caches.open(deviceChapterCacheName);
  const cachedResponse = await chapterCache.match(request, { ignoreSearch: true });
  if (cachedResponse) return cachedResponse;
  return new Response("Device chapter media not found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "DEVICE_CHAPTER_CAPABILITY") {
    event.ports?.[0]?.postMessage({ supported: true, version: 1 });
  }
  if (event.data?.type === "APP_LIFECYCLE_CAPABILITY") {
    event.ports?.[0]?.postMessage({
      supported: true,
      protocolVersion: lifecycleProtocolVersion,
      buildId: workerBuildId,
    });
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheKeys = await caches.keys();
    await Promise.all(
      cacheKeys
        .filter(isObsoleteLegacyAppCache)
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

  if (url.pathname.startsWith(deviceChapterPathPrefix)) {
    event.respondWith(deviceChapterResponse(request));
    return;
  }

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
