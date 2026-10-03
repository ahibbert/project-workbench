import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(projectRoot, "dist");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};
function legacyWorker(cacheName, { cacheNavigation = false } = {}) {
  return `
  const cacheName = ${JSON.stringify(cacheName)};
  self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(cacheName).then(async (cache) => {
      await cache.put("/legacy-cache-marker", new Response("legacy"));
      ${cacheNavigation ? 'await cache.put("/", new Response("<!doctype html><title>Legacy v52 shell</title><main><h1>Legacy v52 shell</h1></main>", { headers: { "Content-Type": "text/html" } }));' : ""}
    }));
    self.skipWaiting();
  });
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  ${cacheNavigation ? `self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (event.request.mode === "navigate" && url.pathname === "/") {
      event.respondWith(caches.open(cacheName).then((cache) => cache.match("/")));
    }
  });` : ""}
`;
}

function bridgeWorker() {
  return `
  const shellCachePattern = /^panel-pilot-v\\d+$/;
  const deviceCacheName = "panels-device-chapters-v1";
  self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
  self.addEventListener("activate", (event) => event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== deviceCacheName && shellCachePattern.test(key)).map((key) => caches.delete(key)));
    await self.clients.claim();
  })()));
  self.addEventListener("fetch", (event) => {
    if (event.request.method === "GET" && new URL(event.request.url).origin === self.location.origin) {
      event.respondWith(fetch(event.request));
    }
  });
  `;
}

function startMigrationServer({ failWorker = false, legacyCacheName = "panel-pilot-v103", serverBuildId = "", historicalWorker = false, requireSession = false } = {}) {
  let servePhaseOneWorker = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");

    if (request.method === "POST" && url.pathname === "/__switch-to-phase-one") {
      servePhaseOneWorker = true;
      response.writeHead(204).end();
      return;
    }

    if (url.pathname === "/api/app-version") {
      if (!serverBuildId) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ buildId: serverBuildId, minimumLifecycleProtocol: 2 }));
      return;
    }

    if (url.pathname === "/api/expired") {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Authentication required", login: "/login" }));
      return;
    }

    if (url.pathname === "/login") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(readFileSync(join(projectRoot, "login.html")));
      return;
    }

    if (url.pathname === "/__session-check") {
      const authenticated = /(?:^|;\s*)panel_pilot_session=migration-test(?:;|$)/.test(
        String(request.headers.cookie || ""),
      );
      response.writeHead(authenticated ? 200 : 401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ authenticated }));
      return;
    }

    if (url.pathname === "/legacy.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Panels legacy migration fixture</title>");
      return;
    }

    if (url.pathname === "/sw.js" && failWorker) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Service worker intentionally unavailable");
      return;
    }

    if (url.pathname === "/src/sw.js" && historicalWorker) {
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "Service-Worker-Allowed": "/",
      });
      response.end(servePhaseOneWorker ? bridgeWorker() : legacyWorker(legacyCacheName, { cacheNavigation: true }));
      return;
    }

    if (url.pathname === "/sw.js" && !historicalWorker && !servePhaseOneWorker) {
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Service-Worker-Allowed": "/",
      });
      response.end(legacyWorker(legacyCacheName));
      return;
    }

    if (requireSession && !/(?:^|;\s*)panel_pilot_session=migration-test(?:;|$)/.test(String(request.headers.cookie || ""))) {
      response.writeHead(303, { Location: `/login?next=${encodeURIComponent(url.pathname)}` }).end();
      return;
    }

    const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const filePath = resolve(distRoot, relativePath);
    const buildRelativePath = relative(resolve(distRoot), filePath);
    if (buildRelativePath.startsWith("..") || isAbsolute(buildRelativePath)) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (!existsSync(filePath)) {
      response.writeHead(404).end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
      ...(url.pathname === "/sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
    });
    response.end(readFileSync(filePath));
  });

  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => {
          server.close((error) => error ? fail(error) : done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

test("a v103 worker waits for consent, preserves state, and reloads exactly once", async ({ page }) => {
  const fixture = await startMigrationServer();
  try {
    await page.addInitScript(() => {
      const count = Number(sessionStorage.getItem("panel-pilot-test-loads") || 0);
      sessionStorage.setItem("panel-pilot-test-loads", String(count + 1));
    });
    await page.goto(`${fixture.origin}/legacy.html`);

    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolveController) => {
          navigator.serviceWorker.addEventListener("controllerchange", resolveController, { once: true });
        });
      }
      localStorage.setItem("panel-pilot-progress-outbox", JSON.stringify([{
        chapterId: 103,
        lastPageRead: 7,
        completed: false,
        updatedAt: 1,
      }]));
      localStorage.setItem("panel-pilot-library", JSON.stringify([{
        mangaId: 103,
        mangaTitle: "Migration position fixture",
        sourceId: 7,
        sourceLabel: "Migration source",
        suwayomiLibrary: true,
        started: true,
        libraryStatus: "reading",
        chapterId: 103,
        chapterTitle: "Chapter 103",
        pageIndex: 7,
        panelIndex: 3,
        progressLabel: "Page 8, panel 4",
        serverUrl: "http://localhost:4567",
        updatedAt: "2026-10-01T00:00:00.000Z",
      }]));
      document.cookie = "panel_pilot_session=migration-test; Path=/; SameSite=Lax";
    });

    await page.evaluate(async () => {
      await fetch("/__switch-to-phase-one", { method: "POST" });
      const registration = await navigator.serviceWorker.getRegistration("/");
      await registration.update();
      await new Promise((resolveWaiting, rejectWaiting) => {
        const deadline = Date.now() + 10_000;
        const check = () => {
          if (registration.waiting) return resolveWaiting();
          if (Date.now() > deadline) return rejectWaiting(new Error("Phase 1 worker did not enter waiting state"));
          setTimeout(check, 50);
        };
        check();
      });
    });

    const waitingState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      return {
        hasWaitingWorker: Boolean(registration.waiting),
        oldWorkerStillControlsPage: navigator.serviceWorker.controller === registration.active,
        legacyCachePresent: (await caches.keys()).includes("panel-pilot-v103"),
      };
    });
    expect(waitingState).toEqual({
      hasWaitingWorker: true,
      oldWorkerStillControlsPage: true,
      legacyCachePresent: true,
    });

    await page.goto(`${fixture.origin}/`, { waitUntil: "load" });
    await expect(page.locator("#app-update")).toBeVisible();
    await page.locator("#nav-settings").click();
    await expect(page.locator("#settings-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#apply-app-update")).toBeVisible();
    await expect(page.locator("#app-update")).toBeVisible();
    const loadsBeforeActivation = await page.evaluate(() => Number(sessionStorage.getItem("panel-pilot-test-loads")));

    const appliedNavigation = page.waitForEvent("load");
    await page.locator("#apply-app-update").click();
    await appliedNavigation;
    await expect.poll(
      () => page.evaluate(() => Number(sessionStorage.getItem("panel-pilot-test-loads"))),
      { timeout: 15_000 },
    ).toBe(loadsBeforeActivation + 1);
    await page.waitForTimeout(500);

    const migratedState = await page.evaluate(async () => {
      const sessionResponse = await fetch("/__session-check", { cache: "no-store" });
      return {
        loads: Number(sessionStorage.getItem("panel-pilot-test-loads")),
        outbox: JSON.parse(localStorage.getItem("panel-pilot-progress-outbox")),
        library: JSON.parse(localStorage.getItem("panel-pilot-library")),
        sessionCookiePresent: document.cookie.includes("panel_pilot_session=migration-test"),
        sessionAuthenticated: sessionResponse.ok && (await sessionResponse.json()).authenticated,
        legacyCachePresent: (await caches.keys()).includes("panel-pilot-v103"),
        controllerPresent: Boolean(navigator.serviceWorker.controller),
      };
    });
    expect(migratedState).toEqual({
      loads: loadsBeforeActivation + 1,
      outbox: [{
        chapterId: 103,
        lastPageRead: 7,
        completed: false,
        updatedAt: 1,
        serverUrl: "http://localhost:4567",
      }],
      library: [expect.objectContaining({
        mangaId: 103,
        chapterId: 103,
        pageIndex: 7,
        panelIndex: 3,
        progressLabel: "Page 8, panel 4",
      })],
      sessionCookiePresent: true,
      sessionAuthenticated: true,
      legacyCachePresent: false,
      controllerPresent: true,
    });
  } finally {
    await fixture.close();
  }
});

test("a legacy v52 shell is repaired without deleting downloaded chapters or device data", async ({ page }) => {
  const fixture = await startMigrationServer({
    legacyCacheName: "panel-pilot-v52",
    serverBuildId: "server-build-newer-than-client",
    historicalWorker: true,
    requireSession: true,
  });
  try {
    await page.goto(`${fixture.origin}/legacy.html`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/src/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolveController) => {
          navigator.serviceWorker.addEventListener("controllerchange", resolveController, { once: true });
        });
      }
      const serverUrl = location.origin;
      const chapterKey = JSON.stringify([serverUrl, "52"]);
      const chapterPath = `/__panels_device_chapters/v1/${encodeURIComponent(chapterKey)}/fixture/0`;
      const chapterBody = "downloaded-page-52";
      const chapterCache = await caches.open("panels-device-chapters-v1");
      await chapterCache.put(
        chapterPath,
        new Response(chapterBody, { headers: { "Content-Type": "image/jpeg" } }),
      );
      const deviceDatabase = await new Promise((resolveDatabase, rejectDatabase) => {
        const request = indexedDB.open("panels-device-library", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("chapters", { keyPath: "key" });
        request.onerror = () => rejectDatabase(request.error);
        request.onsuccess = () => resolveDatabase(request.result);
      });
      const timestamp = new Date().toISOString();
      await new Promise((resolveRecord, rejectRecord) => {
        const transaction = deviceDatabase.transaction("chapters", "readwrite");
        transaction.objectStore("chapters").put({
          key: chapterKey,
          serverUrl,
          chapterId: 52,
          mangaId: 52,
          title: "Legacy downloaded chapter",
          chapterTitle: "Chapter 52",
          pageUrls: ["/fixture/page-52.jpg"],
          pages: [{
            index: 0,
            sourceUrl: "/fixture/page-52.jpg",
            cacheUrl: chapterPath,
            contentType: "image/jpeg",
            size: chapterBody.length,
            completedAt: timestamp,
          }],
          status: "ready",
          totalPages: 1,
          downloadedPages: 1,
          storedBytes: chapterBody.length,
          createdAt: timestamp,
          updatedAt: timestamp,
          readyAt: timestamp,
          error: null,
        });
        transaction.oncomplete = resolveRecord;
        transaction.onerror = () => rejectRecord(transaction.error);
        transaction.onabort = () => rejectRecord(transaction.error);
      });
      deviceDatabase.close();
      sessionStorage.setItem("legacy-chapter-path", chapterPath);
      localStorage.setItem("panel-pilot-library", JSON.stringify([{ mangaId: 52, pageIndex: 8 }]));
      await new Promise((resolveDatabase, rejectDatabase) => {
        const request = indexedDB.open("panels-v52-preservation", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("reader");
        request.onerror = () => rejectDatabase(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction("reader", "readwrite");
          transaction.objectStore("reader").put({ pageIndex: 8 }, "position");
          transaction.oncomplete = () => {
            request.result.close();
            resolveDatabase();
          };
          transaction.onerror = () => rejectDatabase(transaction.error);
        };
      });
    });

    await page.goto(`${fixture.origin}/`, { waitUntil: "load" });
    await expect(page.getByRole("heading", { name: "Legacy v52 shell" })).toBeVisible();
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const oldController = navigator.serviceWorker.controller;
      const changed = new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
      await fetch("/__switch-to-phase-one", { method: "POST" });
      await registration.update();
      if (navigator.serviceWorker.controller === oldController) await changed;
    });
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).includes("panel-pilot-v52"))).toBe(false);

    await page.goto(`${fixture.origin}/`, { waitUntil: "load" });
    await expect(page).toHaveURL(/\/login\?next=/);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Password", exact: true })).toHaveCount(1);

    const preserved = await page.evaluate(async () => {
      const cached = await (await caches.open("panels-device-chapters-v1")).match(
        sessionStorage.getItem("legacy-chapter-path"),
      );
      const position = await new Promise((resolvePosition, rejectPosition) => {
        const request = indexedDB.open("panels-v52-preservation");
        request.onerror = () => rejectPosition(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction("reader");
          const get = transaction.objectStore("reader").get("position");
          get.onsuccess = () => resolvePosition(get.result);
          get.onerror = () => rejectPosition(get.error);
        };
      });
      return {
        chapter: await cached?.text(),
        library: JSON.parse(localStorage.getItem("panel-pilot-library")),
        position,
        caches: await caches.keys(),
      };
    });
    expect(preserved.chapter).toBe("downloaded-page-52");
    expect(preserved.library).toEqual([expect.objectContaining({ mangaId: 52, pageIndex: 8 })]);
    expect(preserved.position).toEqual({ pageIndex: 8 });
    expect(preserved.caches).toContain("panels-device-chapters-v1");

    await page.context().addCookies([{
      name: "panel_pilot_session",
      value: "migration-test",
      url: fixture.origin,
    }]);
    await page.goto(`${fixture.origin}/`, { waitUntil: "load" });
    await expect(page.locator("#library-view")).toHaveClass(/\bactive\b/);
    await expect.poll(() => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      return [registration?.active, registration?.waiting, registration?.installing]
        .some((worker) => worker?.scriptURL.endsWith("/sw.js"));
    }), { timeout: 15_000 }).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("an expired API session redirects globally to a friendly sign-in state", async ({ page }) => {
  const fixture = await startMigrationServer();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto(`${fixture.origin}/#settings`, { waitUntil: "load" });
    await page.evaluate(() => fetch("/api/expired").catch(() => null));
    await page.waitForURL(/\/login\?reason=expired&next=/);
    await expect(page.locator(".expired")).toBeVisible();
    await expect(page.locator(".expired")).toContainText(/session expired.*continue where you left off/i);
    const next = new URL(page.url()).searchParams.get("next");
    expect(next).toContain("#settings");
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("the global Update ready control activates a waiting worker and reloads exactly once", async ({ page }) => {
  const fixture = await startMigrationServer();
  try {
    await page.addInitScript(() => {
      const count = Number(sessionStorage.getItem("panel-pilot-global-update-loads") || 0);
      sessionStorage.setItem("panel-pilot-global-update-loads", String(count + 1));
    });
    await page.goto(`${fixture.origin}/legacy.html`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolveController) => {
          navigator.serviceWorker.addEventListener("controllerchange", resolveController, { once: true });
        });
      }
      await fetch("/__switch-to-phase-one", { method: "POST" });
      const registration = await navigator.serviceWorker.getRegistration("/");
      await registration.update();
      await new Promise((resolveWaiting, rejectWaiting) => {
        const deadline = Date.now() + 10_000;
        const check = () => {
          if (registration.waiting) return resolveWaiting();
          if (Date.now() > deadline) return rejectWaiting(new Error("Updated worker did not enter waiting state"));
          setTimeout(check, 50);
        };
        check();
      });
    });

    await page.goto(`${fixture.origin}/`, { waitUntil: "load" });
    const updateReady = page.locator("#app-update");
    await expect(updateReady).toBeVisible();
    const loadsBeforeActivation = await page.evaluate(
      () => Number(sessionStorage.getItem("panel-pilot-global-update-loads")),
    );

    const globalNavigation = page.waitForEvent("load");
    await updateReady.click();
    await globalNavigation;
    await expect.poll(
      () => page.evaluate(() => Number(sessionStorage.getItem("panel-pilot-global-update-loads"))),
      { timeout: 15_000 },
    ).toBe(loadsBeforeActivation + 1);
    await page.waitForTimeout(500);

    expect(await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      return {
        loads: Number(sessionStorage.getItem("panel-pilot-global-update-loads")),
        hasWaitingWorker: Boolean(registration?.waiting),
        controllerPresent: Boolean(navigator.serviceWorker.controller),
      };
    })).toEqual({
      loads: loadsBeforeActivation + 1,
      hasWaitingWorker: false,
      controllerPresent: true,
    });
  } finally {
    await fixture.close();
  }
});

test("a registration failure does not prevent the online application or Test Lab from working", async ({ page, context }) => {
  const fixture = await startMigrationServer({ failWorker: true });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    const response = await page.goto(`${fixture.origin}/`, { waitUntil: "load" });
    expect(response?.ok()).toBeTruthy();
    await expect(page.locator("#library-view")).toHaveClass(/\bactive\b/);
    await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
    await page.locator("#nav-settings").click();
    await expect(page.locator("#settings-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#app-update-note")).toContainText(/unavailable|could not|failed/i);
    await page.locator("#check-app-update").click();
    await expect(page.locator("#app-update-note")).toContainText(/unavailable|could not|failed/i);
    await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
    const lab = await context.newPage();
    await lab.goto(`${fixture.origin}/panel-test.html`, { waitUntil: "networkidle" });
    await expect.poll(() => lab.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
    await lab.close();
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("a manual update check reports the current build when no update is waiting", async ({ page }) => {
  const fixture = await startMigrationServer();
  try {
    await page.goto(`${fixture.origin}/legacy.html`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolveController) => {
          navigator.serviceWorker.addEventListener("controllerchange", resolveController, { once: true });
        });
      }
    });

    await page.goto(`${fixture.origin}/`, { waitUntil: "load" });
    await page.locator("#nav-settings").click();
    await expect(page.locator("#settings-view")).toHaveClass(/\bactive\b/);
    await page.locator("#check-app-update").click();

    await expect(page.locator("#app-update-note")).toContainText(/up to date|current/i);
    await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
  } finally {
    await fixture.close();
  }
});
