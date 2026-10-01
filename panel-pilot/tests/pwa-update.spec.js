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
const legacyWorker = `
  const cacheName = "panel-pilot-v103";
  self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(cacheName).then((cache) => cache.put(
      "/legacy-cache-marker",
      new Response("legacy"),
    )));
    self.skipWaiting();
  });
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
`;

function startMigrationServer({ failWorker = false } = {}) {
  let servePhaseOneWorker = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");

    if (request.method === "POST" && url.pathname === "/__switch-to-phase-one") {
      servePhaseOneWorker = true;
      response.writeHead(204).end();
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

    if (url.pathname === "/sw.js" && !servePhaseOneWorker) {
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Service-Worker-Allowed": "/",
      });
      response.end(legacyWorker);
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
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
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

    await page.goto(`${fixture.origin}/`, { waitUntil: "networkidle" });
    await expect(page.locator("#app-update")).toBeVisible();
    await page.locator("#nav-settings").click();
    await expect(page.locator("#settings-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#apply-app-update")).toBeVisible();
    await expect(page.locator("#app-update")).toBeVisible();
    const loadsBeforeActivation = await page.evaluate(() => Number(sessionStorage.getItem("panel-pilot-test-loads")));

    await page.locator("#apply-app-update").click();
    await expect.poll(
      () => page.evaluate(() => Number(sessionStorage.getItem("panel-pilot-test-loads"))),
      { timeout: 15_000 },
    ).toBe(loadsBeforeActivation + 1);
    await page.waitForTimeout(500);

    const migratedState = await page.evaluate(async () => ({
      loads: Number(sessionStorage.getItem("panel-pilot-test-loads")),
      outbox: JSON.parse(localStorage.getItem("panel-pilot-progress-outbox")),
      sessionCookiePresent: document.cookie.includes("panel_pilot_session=migration-test"),
      legacyCachePresent: (await caches.keys()).includes("panel-pilot-v103"),
      controllerPresent: Boolean(navigator.serviceWorker.controller),
    }));
    expect(migratedState).toEqual({
      loads: loadsBeforeActivation + 1,
      outbox: [{
        chapterId: 103,
        lastPageRead: 7,
        completed: false,
        updatedAt: 1,
        serverUrl: "http://localhost:4567",
      }],
      sessionCookiePresent: true,
      legacyCachePresent: false,
      controllerPresent: true,
    });
  } finally {
    await fixture.close();
  }
});

test("a registration failure does not prevent the online application from working", async ({ page }) => {
  const fixture = await startMigrationServer({ failWorker: true });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    const response = await page.goto(`${fixture.origin}/`, { waitUntil: "networkidle" });
    expect(response?.ok()).toBeTruthy();
    await expect(page.locator("#library-view")).toHaveClass(/\bactive\b/);
    await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
    await page.locator("#nav-settings").click();
    await expect(page.locator("#settings-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#app-update-note")).toContainText(/unavailable|could not|failed/i);
    await page.locator("#check-app-update").click();
    await expect(page.locator("#app-update-note")).toContainText(/unavailable|could not|failed/i);
    await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
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

    await page.goto(`${fixture.origin}/`, { waitUntil: "networkidle" });
    await page.locator("#nav-settings").click();
    await expect(page.locator("#settings-view")).toHaveClass(/\bactive\b/);
    await page.locator("#check-app-update").click();

    await expect(page.locator("#app-update-note")).toContainText(/up to date|current/i);
    await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
  } finally {
    await fixture.close();
  }
});
