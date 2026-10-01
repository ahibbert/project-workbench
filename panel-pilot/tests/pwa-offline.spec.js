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

function startOfflineFixture({ healthySuwayomi = false } = {}) {
  let apiProbeRequests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");

    if (url.pathname === "/api/cache-probe") {
      apiProbeRequests += 1;
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ marker: "online-api-response", request: apiProbeRequests }));
      return;
    }

    if (healthySuwayomi && url.pathname === "/api/suwayomi/graphql") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ data: {
        __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" } },
        sources: { nodes: [] },
        mangas: { totalCount: 0, nodes: [] },
      } }));
      return;
    }

    if (healthySuwayomi && url.pathname === "/api/library") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ items: [] }));
      return;
    }

    if (healthySuwayomi && url.pathname === "/api/download-buffer/status") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ downloaded: 0, queued: 0, failed: 0, windowSize: 0 }));
      return;
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Suwayomi intentionally unavailable in offline fixture" }));
      return;
    }

    if (url.pathname === "/logout" || url.pathname.startsWith("/logout/")) {
      response.writeHead(302, { Location: "/login" }).end();
      return;
    }

    if (url.pathname === "/" && url.searchParams.get("status") === "500") {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Intentional root failure");
      return;
    }

    const relativePath = url.pathname === "/"
      ? "index.html"
      : url.pathname === "/login" || url.pathname.startsWith("/login/")
        ? "login.html"
        : decodeURIComponent(url.pathname.slice(1));
    const filePath = resolve(distRoot, relativePath);
    const buildRelativePath = relative(resolve(distRoot), filePath);
    if (buildRelativePath.startsWith("..") || isAbsolute(buildRelativePath) || !existsSync(filePath)) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
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

async function establishControlledApp(page, origin) {
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise((resolveController, rejectController) => {
      const timeout = window.setTimeout(
        () => rejectController(new Error("The app did not become service-worker controlled")),
        10_000,
      );
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        window.clearTimeout(timeout);
        resolveController();
      }, { once: true });
    });
  });
  await page.reload({ waitUntil: "networkidle" });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

async function seedLocalAppState(page) {
  await page.evaluate(() => {
    localStorage.setItem("panel-pilot-settings", JSON.stringify({
      activeView: "library",
      baseUrl: "http://127.0.0.1:65530",
      panelPadding: 17,
      readerMotion: "instant",
    }));
    localStorage.setItem("panel-pilot-library", JSON.stringify([{
      mangaId: 301,
      mangaTitle: "Offline Fixture Library Title",
      sourceId: 12,
      sourceLabel: "Local fixture",
      libraryStatus: "reading",
      statusExplicit: true,
      started: true,
      hidden: false,
      pinned: false,
      updatedAt: "2026-10-01T00:00:00.000Z",
    }]));
  });
}

async function offlineNavigationResult(context, url) {
  const probePage = await context.newPage();
  try {
    return await probePage.goto(url, { waitUntil: "domcontentloaded", timeout: 5_000 })
      .then(async (response) => ({
        ok: Boolean(response?.ok()),
        status: response?.status() || 0,
        body: response ? await response.text().catch(() => "") : "",
      }))
      .catch((error) => ({ ok: false, status: 0, body: "", error: error.message }));
  } finally {
    await probePage.close();
  }
}

test("a controlled app reloads its shell and local state while offline", async ({ page, context }) => {
  const fixture = await startOfflineFixture();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await establishControlledApp(page, fixture.origin);
    await seedLocalAppState(page);
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByText("Offline Fixture Library Title", { exact: true })).toBeVisible();

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.locator("#library-view")).toHaveClass(/\bactive\b/);
    await expect(page.getByText("Offline Fixture Library Title", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
    await page.locator("#nav-settings").click();
    await expect(page.locator("#server-url")).toHaveValue("http://127.0.0.1:65530");
    await expect(page.locator("#panel-padding")).toHaveValue("17");

    await page.evaluate(() => { location.hash = "#reader"; });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#reader-error")).toBeVisible();
    await expect(page.locator("#reader-error-message")).toContainText(/reconnect|offline|device-local/i);
    await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "true");
    expect(pageErrors).toEqual([]);
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("online-only and excluded routes never receive the offline app shell", async ({ page, context }) => {
  const fixture = await startOfflineFixture();
  try {
    await establishControlledApp(page, fixture.origin);
    const onlineApi = await page.evaluate(async () => {
      const response = await fetch("/api/cache-probe");
      return response.json();
    });
    expect(onlineApi.marker).toBe("online-api-response");

    const cachedPaths = await page.evaluate(async () => {
      const paths = [];
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        for (const request of await cache.keys()) paths.push(new URL(request.url).pathname);
      }
      return paths;
    });
    expect(cachedPaths.some((path) => path === "/api" || path.startsWith("/api/"))).toBe(false);
    expect(cachedPaths).not.toContain("/login.html");
    expect(cachedPaths).not.toContain("/panel-test.html");

    const onlineLogin = await offlineNavigationResult(context, `${fixture.origin}/login`);
    expect(onlineLogin.status).toBe(200);
    expect(onlineLogin.body).not.toContain('id="library-view"');
    const onlineRootFailure = await offlineNavigationResult(context, `${fixture.origin}/?status=500`);
    expect(onlineRootFailure.status).toBe(500);
    expect(onlineRootFailure.body).toContain("Intentional root failure");
    expect(onlineRootFailure.body).not.toContain('id="library-view"');

    await context.setOffline(true);
    const offlineApi = await page.evaluate(async () => {
      try {
        const response = await fetch("/api/cache-probe");
        return { resolved: true, status: response.status, body: await response.text() };
      } catch (error) {
        return { resolved: false, message: error.message };
      }
    });
    expect(offlineApi.resolved).toBe(false);

    for (const pathname of ["/login", "/logout", "/panel-test.html", "/arbitrary-navigation"]) {
      const result = await offlineNavigationResult(context, `${fixture.origin}${pathname}`);
      expect(result.ok, `${pathname} unexpectedly resolved successfully offline`).toBe(false);
      expect(result.body).not.toContain('id="library-view"');
      expect(result.body).not.toContain("Panel Pilot — Guided Reader");
    }
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("network state is announced and recovers without reloading the app", async ({ page, context }) => {
  const fixture = await startOfflineFixture();
  try {
    await page.addInitScript(() => {
      const loads = Number(sessionStorage.getItem("panel-pilot-offline-loads") || 0);
      sessionStorage.setItem("panel-pilot-offline-loads", String(loads + 1));
    });
    await establishControlledApp(page, fixture.origin);
    const loadsBeforeTransition = await page.evaluate(
      () => Number(sessionStorage.getItem("panel-pilot-offline-loads")),
    );

    await context.setOffline(true);
    await expect(page.locator("#network-status-banner")).toBeVisible();
    await expect(page.locator("#network-status-title")).toContainText(/offline/i);
    await expect(page.locator("#network-status-note")).toContainText(/local|offline|connection/i);
    await expect(page.locator("#retry-network")).toBeVisible();

    await context.setOffline(false);
    await expect.poll(async () => {
      const title = await page.locator("#network-status-title").textContent();
      const note = await page.locator("#network-status-note").textContent();
      return `${title || ""} ${note || ""}`;
    }).toMatch(/reconnecting|restored|back online|server.+unavailable|could not reach/i);
    expect(await page.evaluate(() => Number(sessionStorage.getItem("panel-pilot-offline-loads"))))
      .toBe(loadsBeforeTransition);
    await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("a successful reconnect reports restoration and then clears the banner", async ({ page, context }) => {
  const fixture = await startOfflineFixture({ healthySuwayomi: true });
  try {
    await establishControlledApp(page, fixture.origin);
    await context.setOffline(true);
    await expect(page.locator("#network-status-title")).toContainText(/offline/i);

    await context.setOffline(false);
    await expect(page.locator("#network-status-banner")).toHaveAttribute("data-state", "restored");
    await expect(page.locator("#network-status-title")).toContainText(/restored/i);
    await expect(page.locator("#network-status-banner")).toBeHidden({ timeout: 6_000 });
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("hashed JavaScript, CSS, and icon shell assets remain available offline", async ({ page, context }) => {
  const fixture = await startOfflineFixture();
  try {
    await establishControlledApp(page, fixture.origin);
    const shellAssets = await page.evaluate(() => [
      ...Array.from(document.querySelectorAll('script[src]'), (node) => node.src),
      ...Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'), (node) => node.href),
      ...Array.from(document.querySelectorAll('link[rel="apple-touch-icon"][href]'), (node) => node.href),
    ]);
    expect(shellAssets.length).toBeGreaterThanOrEqual(3);

    await context.setOffline(true);
    const offlineAssets = await page.evaluate(async (urls) => Promise.all(urls.map(async (url) => {
      try {
        const response = await fetch(url, { cache: "reload" });
        return {
          pathname: new URL(url).pathname,
          ok: response.ok,
          length: (await response.arrayBuffer()).byteLength,
        };
      } catch (error) {
        return { pathname: new URL(url).pathname, ok: false, length: 0, error: error.message };
      }
    })), shellAssets);

    expect(offlineAssets).toHaveLength(shellAssets.length);
    for (const asset of offlineAssets) {
      expect(asset.ok, `${asset.pathname} was not served offline`).toBe(true);
      expect(asset.length, `${asset.pathname} returned an empty response`).toBeGreaterThan(0);
    }
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});
