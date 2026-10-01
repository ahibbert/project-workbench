import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(projectRoot, "dist");
const deviceDatabase = "panels-device-library";
const deviceStore = "chapters";
const deviceCache = "panels-device-chapters-v1";
const devicePathPrefix = "/__panels_device_chapters/v1/";
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function startStorageFixture() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");

    if (url.pathname === "/lease-holder.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><body data-ready="false"><script>
        const channel = new BroadcastChannel("panels-device-library-operations-v1");
        channel.addEventListener("message", (event) => {
          const message = event.data;
          if (message?.type !== "PROBE_OPERATION") return;
          channel.postMessage({
            type: "OPERATION_ALIVE",
            probeId: message.probeId,
            ownerId: message.ownerId,
            key: message.key,
            operationId: message.operationId,
          });
        });
        document.body.dataset.ready = "true";
      </script></body>`);
      return;
    }

    if (url.pathname === "/api/suwayomi/graphql") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const query = String(payload.query || "");
      let data = {};
      if (query.includes("HEALTH")) {
        data = { __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" } } };
      } else if (query.includes("GET_SOURCES_LIST")) {
        data = { sources: { nodes: [] } };
      } else if (query.includes("GET_LIBRARY_MANGA")) {
        data = { mangas: { totalCount: 0, nodes: [] } };
      }
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ data }));
      return;
    }

    if (url.pathname === "/api/library") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ items: [] }));
      return;
    }

    if (url.pathname === "/api/download-buffer/status") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ downloaded: 0, queued: 0, failed: 0, windowSize: 0, chapters: [] }));
      return;
    }

    if (url.pathname === "/api/mangabaka/status") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ configured: false, connected: false }));
      return;
    }

    if (url.pathname === "/api/mangabaka/recommendations") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ results: [] }));
      return;
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({}));
      return;
    }

    const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const filePath = resolve(distRoot, relativePath);
    const buildRelativePath = relative(distRoot, filePath);
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

  return new Promise((resolveFixture, rejectFixture) => {
    server.once("error", rejectFixture);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveFixture({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}

async function mockStorageManager(context, configuration = {}) {
  await context.addInitScript((config) => {
    const calls = { estimate: 0, persist: 0, persisted: 0 };
    globalThis.__panelsStorageFixture = calls;
    if (config.mode === "unsupported") {
      Object.defineProperty(navigator, "storage", { configurable: true, value: undefined });
      return;
    }
    let retained = Boolean(config.persisted);
    const storage = {};
    if (!config.omitEstimate) {
      storage.estimate = async () => {
        calls.estimate += 1;
        if (config.rejectEstimate) throw new Error("Fixture storage estimate unavailable");
        return { usage: config.usageBytes, quota: config.quotaBytes };
      };
    }
    if (!config.omitPersisted) {
      storage.persisted = async () => {
        calls.persisted += 1;
        if (config.rejectPersisted) throw new Error("Fixture persistence status unavailable");
        return retained;
      };
    }
    if (!config.omitPersist) {
      storage.persist = async () => {
        calls.persist += 1;
        if (config.rejectPersist) throw new Error("Fixture persistence request rejected");
        retained = Boolean(config.persistResult);
        return retained;
      };
    }
    Object.defineProperty(navigator, "storage", { configurable: true, value: storage });
  }, configuration);
}

async function installVisibilityShim(page) {
  await page.addInitScript(() => {
    let visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => visibility === "hidden",
    });
    window.__setStorageTestVisibility = (nextVisibility) => {
      visibility = nextVisibility;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
}

function packageKey(serverUrl, chapterId) {
  return JSON.stringify([String(serverUrl).replace(/\/+$/, ""), String(chapterId)]);
}

function readyPackage(overrides = {}) {
  return {
    serverUrl: "https://server-a.example",
    chapterId: 2101,
    mangaId: 701,
    title: "Storage fixture alpha",
    chapterTitle: "Chapter 1",
    chapterNumber: 1,
    sourceLabel: "Fixture source",
    status: "ready",
    pageSizes: [1024, 2048],
    totalPages: 2,
    ...overrides,
  };
}

async function seedDeviceStorage(page, packageSpecs, { unrelated = false } = {}) {
  return page.evaluate(async ({ specs, includeUnrelated, dbName, storeName, cacheName, pathPrefix }) => {
    const database = await new Promise((resolveDatabase, rejectDatabase) => {
      const request = indexedDB.open(dbName, 1);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName, { keyPath: "key" });
        }
      });
      request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
      request.addEventListener("error", () => rejectDatabase(request.error), { once: true });
    });
    const cache = await caches.open(cacheName);
    const keys = [];
    const records = [];
    for (const spec of specs) {
      const normalizedServer = String(spec.serverUrl).replace(/\/+$/, "");
      const key = JSON.stringify([normalizedServer, String(spec.chapterId)]);
      keys.push(key);
      const pageSizes = Array.isArray(spec.pageSizes) ? spec.pageSizes : [];
      const totalPages = Number(spec.totalPages) || pageSizes.length;
      const pageUrls = Array.from({ length: totalPages }, (_, index) => `/fixture/pages/${spec.chapterId}/${index}`);
      const pages = [];
      for (let index = 0; index < pageSizes.length; index += 1) {
        const cacheUrl = `${pathPrefix}${encodeURIComponent(key)}/fixture/${index}`;
        const bytes = new Uint8Array(Number(pageSizes[index]) || 1);
        bytes.fill((index + Number(spec.chapterId)) % 251);
        await cache.put(cacheUrl, new Response(bytes, {
          status: 200,
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Length": String(bytes.byteLength),
            "Content-Type": "image/png",
          },
        }));
        pages[index] = {
          index,
          sourceUrl: pageUrls[index],
          cacheUrl,
          contentType: "image/png",
          size: bytes.byteLength,
          completedAt: "2026-10-01T00:00:00.000Z",
        };
      }
      const timestamp = "2026-10-01T00:00:00.000Z";
      records.push({
        key,
        serverUrl: normalizedServer,
        chapterId: spec.chapterId,
        mangaId: spec.mangaId,
        title: spec.title,
        chapterTitle: spec.chapterTitle,
        chapterNumber: spec.chapterNumber,
        chapterOrder: spec.chapterNumber,
        sourceId: spec.sourceId || 12,
        sourceLabel: spec.sourceLabel || "Fixture source",
        scanlator: "Fixture group",
        thumbnailUrl: "",
        pageUrls,
        pages,
        status: spec.status,
        totalPages,
        downloadedPages: pages.filter(Boolean).length,
        createdAt: timestamp,
        updatedAt: timestamp,
        readyAt: spec.status === "ready" ? timestamp : null,
        error: spec.error || null,
        ...(spec.lease ? { lease: spec.lease } : {}),
      });
    }
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    store.clear();
    records.forEach((record) => store.put(record));
    await new Promise((resolveTransaction, rejectTransaction) => {
      transaction.addEventListener("complete", resolveTransaction, { once: true });
      transaction.addEventListener("abort", () => rejectTransaction(transaction.error), { once: true });
      transaction.addEventListener("error", () => rejectTransaction(transaction.error), { once: true });
    });
    database.close();

    if (includeUnrelated) {
      localStorage.setItem("phase-five-unrelated", "preserve-me");
      const unrelatedCache = await caches.open("panels-unrelated-fixture");
      await unrelatedCache.put("/unrelated-fixture", new Response("preserve-me"));
    }
    return keys;
  }, {
    specs: packageSpecs,
    includeUnrelated: unrelated,
    dbName: deviceDatabase,
    storeName: deviceStore,
    cacheName: deviceCache,
    pathPrefix: devicePathPrefix,
  });
}

async function inspectDeviceStorage(page) {
  return page.evaluate(async ({ dbName, storeName, cacheName }) => {
    const database = await new Promise((resolveDatabase, rejectDatabase) => {
      const request = indexedDB.open(dbName, 1);
      request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
      request.addEventListener("error", () => rejectDatabase(request.error), { once: true });
    });
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    const records = await new Promise((resolveRecords, rejectRecords) => {
      request.addEventListener("success", () => resolveRecords(request.result), { once: true });
      request.addEventListener("error", () => rejectRecords(request.error), { once: true });
    });
    database.close();
    const cache = await caches.open(cacheName);
    const paths = (await cache.keys()).map((entry) => new URL(entry.url).pathname);
    return {
      records: records.map((record) => ({
        key: record.key,
        status: record.status,
        downloadedPages: record.downloadedPages,
        storedBytes: record.storedBytes,
      })),
      paths,
      unrelatedValue: localStorage.getItem("phase-five-unrelated"),
      caches: await caches.keys(),
    };
  }, { dbName: deviceDatabase, storeName: deviceStore, cacheName: deviceCache });
}

async function prepareStorageDashboard(page, context, fixture, packages, options = {}) {
  await mockStorageManager(context, options.storage || {
    usageBytes: 20 * 1024 * 1024,
    quotaBytes: 100 * 1024 * 1024,
    persisted: false,
    persistResult: true,
  });
  await page.addInitScript(() => {
    localStorage.setItem("panel-pilot-tap-hint-seen", "1");
    localStorage.setItem("panel-pilot-settings", JSON.stringify({ readerMotion: "instant" }));
  });
  await page.goto(`${fixture.origin}/`, { waitUntil: "networkidle" });
  const keys = await seedDeviceStorage(page, packages, { unrelated: options.unrelated });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#nav-settings").click();
  await expect(page.locator("#device-storage-panel")).toBeVisible();
  await expect(page.locator("#device-storage-summary")).not.toContainText(/checking|loading/i);
  return keys;
}

function storageGroup(page, serverHost) {
  return page.locator(".device-storage-group").filter({ hasText: serverHost });
}

function storageRow(page, { chapterTitle, serverHost = "" }) {
  const parent = serverHost ? storageGroup(page, serverHost) : page.locator("#device-storage-list");
  return parent.locator("[data-device-storage-row]").filter({
    has: page.getByText(chapterTitle, { exact: true }),
  });
}

async function checkboxState(page, identity) {
  const checkbox = storageRow(page, identity).locator("[data-device-storage-select]");
  if (!await checkbox.count()) return { found: false };
  return { found: true, checked: await checkbox.isChecked(), disabled: await checkbox.isDisabled() };
}

async function selectPackage(page, identity) {
  const checkbox = storageRow(page, identity).locator("[data-device-storage-select]");
  await expect(checkbox).toBeEnabled();
  await checkbox.check();
}

async function rowExists(page, identity) {
  return await storageRow(page, identity).count() > 0;
}

test("the storage dashboard separates chapter bytes from origin usage", async ({ page, context }) => {
  const fixture = await startStorageFixture();
  try {
    const packages = [
      readyPackage(),
      readyPackage({
        chapterId: 2102,
        title: "Storage fixture beta",
        chapterTitle: "Chapter 2 incomplete",
        chapterNumber: 2,
        status: "paused",
        pageSizes: [4096],
        totalPages: 3,
        error: { code: "paused", name: "AbortError", message: "Paused for fixture" },
      }),
    ];
    await prepareStorageDashboard(page, context, fixture, packages);

    await expect(page.locator("#device-storage-title")).toHaveText("Device storage");
    await expect(page.locator("#device-storage-summary")).toContainText(/2 chapters/i);
    await expect(page.locator("#device-storage-summary")).toContainText(/7(?:\.0+)?\s*(?:KB|KiB)/i);
    await expect(page.locator("#device-storage-origin-note")).toContainText(/20(?:\.0)?\s*(?:MB|MiB)/i);
    await expect(page.locator("#device-storage-origin-note")).toContainText(/100(?:\.0)?\s*(?:MB|MiB)/i);
    await expect(page.locator("#device-storage-list")).toContainText("Storage fixture alpha");
    await expect(page.locator("#device-storage-list")).toContainText("Chapter 2 incomplete");

    const meter = await page.locator("#device-storage-progress").evaluate((progress) => ({
      value: progress.value,
      max: progress.max,
      label: progress.getAttribute("aria-labelledby"),
    }));
    expect(meter.max).toBeGreaterThan(0);
    expect(meter.value / meter.max).toBeCloseTo(0.2, 2);
    expect(meter.label).toBe("device-storage-progress-label");
    await expect(page.locator("#device-storage-summary")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("#device-storage-summary")).toHaveAttribute("aria-atomic", "true");
    await expect(page.locator("#device-storage-list")).not.toHaveAttribute("aria-live", /.+/);
  } finally {
    await fixture.close();
  }
});

test("the storage manager never writes credential-bearing server URLs into its DOM", async ({ page, context }) => {
  const fixture = await startStorageFixture();
  try {
    await prepareStorageDashboard(page, context, fixture, [readyPackage({
      serverUrl: "https://reader:secret@credential-host.example/",
      title: "Credential redaction fixture",
      sourceLabel: "Private Suwayomi",
    })]);

    const panel = page.locator("#device-storage-panel");
    await expect(panel).toContainText("credential-host.example");
    await expect(panel).not.toContainText("reader");
    await expect(panel).not.toContainText("secret");
    const serializedPanel = await panel.evaluate((element) => element.outerHTML);
    expect(serializedPanel).not.toContain("reader");
    expect(serializedPanel).not.toContain("secret");
    expect(serializedPanel).not.toContain("reader%3Asecret");
  } finally {
    await fixture.close();
  }
});

test("explicit Refresh reconciles evicted pages and stored-byte totals", async ({ page, context }) => {
  const fixture = await startStorageFixture();
  try {
    const [key] = await prepareStorageDashboard(page, context, fixture, [readyPackage()]);
    await expect(page.locator("#device-storage-summary")).toContainText(/3(?:\.0+)?\s*KB/i);

    const removed = await page.evaluate(async ({ cacheName, encodedKey }) => {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      const target = requests.find((request) => {
        const path = new URL(request.url).pathname;
        return path.includes(encodedKey) && path.endsWith("/1");
      });
      return target ? cache.delete(target) : false;
    }, { cacheName: deviceCache, encodedKey: encodeURIComponent(key) });
    expect(removed).toBe(true);

    // A routine render still shows the last verified checkpoint until the user
    // requests the intentionally more expensive integrity reconciliation.
    await expect(page.locator("#device-storage-summary")).toContainText(/3(?:\.0+)?\s*KB/i);
    await page.locator("#device-storage-refresh").click();
    await expect(page.locator("#device-storage-result")).toContainText(/refreshed/i);
    await expect(page.locator("#device-storage-summary")).toContainText(/1(?:\.0+)?\s*KB/i);
    await expect(storageRow(page, {
      chapterTitle: "Chapter 1",
      serverHost: "server-a.example",
    })).toContainText(/Partial 1\/2/i);

    const record = (await inspectDeviceStorage(page)).records.find((entry) => entry.key === key);
    expect(record).toMatchObject({ status: "paused", downloadedPages: 1, storedBytes: 1024 });
  } finally {
    await fixture.close();
  }
});

test("returning to visible Settings refreshes the storage snapshot", async ({ page, context }) => {
  const fixture = await startStorageFixture();
  try {
    await installVisibilityShim(page);
    await prepareStorageDashboard(page, context, fixture, [readyPackage()]);
    const estimatesBefore = await page.evaluate(() => globalThis.__panelsStorageFixture.estimate);

    await page.evaluate(() => {
      window.__setStorageTestVisibility("hidden");
      window.__setStorageTestVisibility("visible");
    });

    await expect.poll(
      () => page.evaluate(() => globalThis.__panelsStorageFixture.estimate),
    ).toBeGreaterThan(estimatesBefore);
    await expect(page.locator("#device-storage-summary")).toContainText(/1 chapter/i);
  } finally {
    await fixture.close();
  }
});

test("persistence is requested only by the explicit control and reports the result", async ({ page, context }) => {
  const fixture = await startStorageFixture();
  try {
    await prepareStorageDashboard(page, context, fixture, [readyPackage()]);
    expect(await page.evaluate(() => globalThis.__panelsStorageFixture.persist)).toBe(0);

    await page.locator("#device-storage-persist").click();
    await expect(page.locator("#device-storage-retention-note")).toContainText(/protected|persistent/i);
    expect(await page.evaluate(() => globalThis.__panelsStorageFixture.persist)).toBe(1);

    await page.locator("#device-storage-refresh").click();
    await expect(page.locator("#device-storage-retention-note")).toContainText(/protected|persistent/i);
    expect(await page.evaluate(() => globalThis.__panelsStorageFixture.persist)).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("a clean persistence denial is truthful and leaves package management usable", async ({ page, context }) => {
  const fixture = await startStorageFixture();
  try {
    await prepareStorageDashboard(page, context, fixture, [readyPackage()], {
      storage: {
        usageBytes: 20 * 1024 * 1024,
        quotaBytes: 100 * 1024 * 1024,
        persisted: false,
        persistResult: false,
      },
    });
    await page.locator("#device-storage-persist").click();
    await expect(page.locator("#device-storage-result")).toContainText(/not granted/i);
    await expect(page.locator("#device-storage-retention-note")).toContainText(/may remove|not protected/i);
    expect(await page.evaluate(() => globalThis.__panelsStorageFixture.persist)).toBe(1);
    expect(await checkboxState(page, {
      chapterTitle: "Chapter 1",
      serverHost: "server-a.example",
    })).toMatchObject({ found: true, disabled: false });
  } finally {
    await fixture.close();
  }
});

test("empty storage and status-only retention APIs expose no destructive or unsupported actions", async ({ page, context }) => {
  const fixture = await startStorageFixture();
  try {
    await prepareStorageDashboard(page, context, fixture, [], {
      storage: {
        usageBytes: 1024,
        quotaBytes: 10 * 1024 * 1024,
        persisted: false,
        omitPersist: true,
      },
    });
    await expect(page.locator("#device-storage-summary")).toContainText(/0 chapters.*0 B/i);
    await expect(page.locator("#device-storage-list")).toContainText(/no chapters/i);
    await expect(page.locator("#device-storage-select-all")).toBeDisabled();
    await expect(page.locator("#device-storage-remove-selected")).toBeDisabled();
    await expect(page.locator("#device-storage-persist")).toBeHidden();
    expect(await page.evaluate(() => globalThis.__panelsStorageFixture.persist)).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("bulk removal works offline and isolates servers, packages, and unrelated storage", async ({ page, context }) => {
  const fixture = await startStorageFixture();
  try {
    const packages = [
      readyPackage(),
      readyPackage({ serverUrl: "https://server-b.example/", title: "Same ID, server B" }),
      readyPackage({ chapterId: 2103, title: "Unselected package", chapterTitle: "Chapter 3" }),
    ];
    const [removeKey, otherServerKey, unselectedKey] = await prepareStorageDashboard(
      page,
      context,
      fixture,
      packages,
      { unrelated: true },
    );

    const removeIdentity = { chapterTitle: "Chapter 1", serverHost: "server-a.example" };
    const otherServerIdentity = { chapterTitle: "Chapter 1", serverHost: "server-b.example" };
    await expect(storageGroup(page, "server-a.example")).toBeVisible();
    await expect(storageGroup(page, "server-b.example")).toBeVisible();
    await expect(storageGroup(page, "server-a.example")).not.toContainText("server-b.example");
    await expect(storageGroup(page, "server-b.example")).not.toContainText("server-a.example");
    await selectPackage(page, removeIdentity);
    await expect(page.locator("#device-storage-selected-count")).toContainText("1");
    await page.locator("#device-storage-remove-selected").click();
    await expect(page.locator("#device-storage-dialog")).toHaveAttribute("open", "");

    await context.setOffline(true);
    await page.locator("#device-storage-confirm").click();
    await expect.poll(() => rowExists(page, removeIdentity)).toBe(false);
    await expect.poll(() => rowExists(page, otherServerIdentity)).toBe(true);

    const stored = await inspectDeviceStorage(page);
    expect(stored.records.map((record) => record.key)).toEqual(expect.arrayContaining([otherServerKey, unselectedKey]));
    expect(stored.records.map((record) => record.key)).not.toContain(removeKey);
    expect(stored.paths.some((path) => path.includes(encodeURIComponent(removeKey)))).toBe(false);
    expect(stored.paths.some((path) => path.includes(encodeURIComponent(otherServerKey)))).toBe(true);
    expect(stored.unrelatedValue).toBe("preserve-me");
    expect(stored.caches).toContain("panels-unrelated-fixture");
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("cancelling bulk removal preserves data and returns focus", async ({ page, context }) => {
  const fixture = await startStorageFixture();
  try {
    const [key] = await prepareStorageDashboard(page, context, fixture, [readyPackage()]);
    const identity = { chapterTitle: "Chapter 1", serverHost: "server-a.example" };
    await selectPackage(page, identity);
    await page.locator("#device-storage-remove-selected").click();
    await expect(page.locator("#device-storage-dialog")).toHaveAttribute("open", "");
    await page.locator("#device-storage-cancel").click();

    await expect(page.locator("#device-storage-dialog")).not.toHaveAttribute("open", "");
    await expect.poll(() => rowExists(page, identity)).toBe(true);
    expect((await inspectDeviceStorage(page)).records.map((record) => record.key)).toContain(key);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("device-storage-remove-selected");
  } finally {
    await fixture.close();
  }
});

test("bulk removal settles every item and leaves a failed removal retryable", async ({ page, context }) => {
  const fixture = await startStorageFixture();
  try {
    const packages = [
      readyPackage(),
      readyPackage({
        chapterId: 2102,
        title: "Removal succeeds",
        chapterTitle: "Chapter 2",
        chapterNumber: 2,
      }),
    ];
    const [failedKey, removedKey] = await prepareStorageDashboard(page, context, fixture, packages);
    await page.evaluate(({ cachePrefix, key }) => {
      const originalDelete = Cache.prototype.delete;
      Cache.prototype.delete = function fixtureDelete(request, options) {
        const path = new URL(String(request?.url || request), location.href).pathname;
        if (path.startsWith(`${cachePrefix}${encodeURIComponent(key)}/`)) {
          return Promise.reject(new Error("Fixture cache removal failure"));
        }
        return originalDelete.call(this, request, options);
      };
    }, { cachePrefix: devicePathPrefix, key: failedKey });

    const failedIdentity = { chapterTitle: "Chapter 1", serverHost: "server-a.example" };
    const removedIdentity = { chapterTitle: "Chapter 2", serverHost: "server-a.example" };
    await selectPackage(page, failedIdentity);
    await selectPackage(page, removedIdentity);
    await page.locator("#device-storage-remove-selected").click();
    await page.locator("#device-storage-confirm").click();

    await expect.poll(() => rowExists(page, removedIdentity)).toBe(false);
    await expect.poll(() => rowExists(page, failedIdentity)).toBe(true);
    await expect(page.locator("#device-storage-result")).toContainText(/1.*(?:failed|could not)|(?:failed|could not).*1/i);
    const records = (await inspectDeviceStorage(page)).records;
    expect(records.map((record) => record.key)).toContain(failedKey);
    expect(records.map((record) => record.key)).not.toContain(removedKey);
    expect(records.find((record) => record.key === failedKey)?.status).toBe("removing");
  } finally {
    await fixture.close();
  }
});

test("active downloads cannot be selected while incomplete packages can", async ({ page, context }) => {
  const fixture = await startStorageFixture();
  const leasePage = await context.newPage();
  try {
    await leasePage.goto(`${fixture.origin}/lease-holder.html`);
    await expect(leasePage.locator("body")).toHaveAttribute("data-ready", "true");
    const activeKey = packageKey("https://server-a.example", 2101);
    const operationId = "fixture-active-operation";
    const packages = [
      readyPackage({
        status: "downloading",
        pageSizes: [1024],
        totalPages: 3,
        lease: {
          ownerId: "fixture-lease-owner",
          operationId,
          kind: "download",
          heartbeatAt: Date.now(),
          expiresAt: Date.now() + 120_000,
        },
      }),
      readyPackage({
        chapterId: 2102,
        title: "Paused package",
        chapterTitle: "Chapter 2 paused",
        chapterNumber: 2,
        status: "paused",
        pageSizes: [2048],
        totalPages: 3,
        error: { code: "paused", name: "AbortError", message: "Paused" },
      }),
    ];
    const [, pausedKey] = await prepareStorageDashboard(page, context, fixture, packages);

    const active = await checkboxState(page, { chapterTitle: "Chapter 1", serverHost: "server-a.example" });
    expect(active.found ? active.disabled : true).toBe(true);
    expect(await checkboxState(page, { chapterTitle: "Chapter 2 paused", serverHost: "server-a.example" }))
      .toMatchObject({ found: true, disabled: false });
  } finally {
    await leasePage.close();
    await fixture.close();
  }
});

test("unsupported and rejected storage APIs degrade without hiding chapter controls", async ({ browser }) => {
  for (const scenario of [
    { width: 320, storage: { mode: "unsupported" } },
    {
      width: 390,
      storage: {
        rejectEstimate: true,
        rejectPersisted: true,
        rejectPersist: true,
        usageBytes: 0,
        quotaBytes: 0,
      },
    },
  ]) {
    const { storage, width } = scenario;
    const context = await browser.newContext({ viewport: { width, height: 720 } });
    const page = await context.newPage();
    const fixture = await startStorageFixture();
    try {
      const [key] = await prepareStorageDashboard(page, context, fixture, [readyPackage()], { storage });
      await expect(page.locator("#device-storage-origin-note")).toContainText(/unavailable|unsupported|could not|does not expose/i);
      const identity = { chapterTitle: "Chapter 1", serverHost: "server-a.example" };
      await expect.poll(() => rowExists(page, identity)).toBe(true);
      expect(await checkboxState(page, identity)).toMatchObject({ found: true, disabled: false });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      const removeButton = storageRow(page, identity).locator("[data-device-storage-remove]");
      await removeButton.evaluate((button) => button.scrollIntoView({ block: "center" }));
      const bounds = await page.evaluate(() => {
        const panel = document.querySelector("#device-storage-panel")?.getBoundingClientRect();
        const navigation = document.querySelector(".app-nav")?.getBoundingClientRect();
        const remove = document.querySelector("[data-device-storage-remove]")?.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          panel: panel ? { left: panel.left, right: panel.right } : null,
          navigation: navigation ? {
            left: navigation.left,
            right: navigation.right,
            top: navigation.top,
            bottom: navigation.bottom,
          } : null,
          remove: remove ? { left: remove.left, right: remove.right, bottom: remove.bottom } : null,
        };
      });
      expect(bounds.panel).not.toBeNull();
      expect(bounds.navigation).not.toBeNull();
      expect(bounds.remove).not.toBeNull();
      expect(bounds.panel.left).toBeGreaterThanOrEqual(0);
      expect(bounds.panel.right).toBeLessThanOrEqual(bounds.viewportWidth);
      expect(bounds.navigation.left).toBeGreaterThanOrEqual(0);
      expect(bounds.navigation.right).toBeLessThanOrEqual(bounds.viewportWidth);
      expect(bounds.navigation.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
      expect(bounds.remove.left).toBeGreaterThanOrEqual(0);
      expect(bounds.remove.right).toBeLessThanOrEqual(bounds.viewportWidth);
      expect(bounds.remove.bottom).toBeLessThanOrEqual(bounds.navigation.top);

      if (storage.rejectPersist) {
        await page.locator("#device-storage-persist").click();
        await expect(page.locator("#device-storage-result")).toContainText(/unavailable|rejected|could not|not granted|not protected/i);
        await expect.poll(() => rowExists(page, identity)).toBe(true);
      }
    } finally {
      await fixture.close();
      await context.close();
    }
  }
});
