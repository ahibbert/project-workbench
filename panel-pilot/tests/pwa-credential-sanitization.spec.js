import { expect, test } from "@playwright/test";

async function stubBackend(page, requests, { failProgress = false } = {}) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({
      method: request.method(),
      pathname: url.pathname,
      search: url.search,
      postData: request.postData(),
      headers: request.headers(),
    });
    if (url.pathname === "/api/suwayomi/graphql") {
      const body = request.postDataJSON?.() || {};
      const query = String(body.query || "");
      if (failProgress && query.includes("GET_CHAPTER_PROGRESS")) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Progress fixture unavailable" }) });
        return;
      }
      const data = query.includes("HEALTH")
        ? { __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" } } }
        : query.includes("GET_SOURCES_LIST")
          ? { sources: { nodes: [] } }
          : {};
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
      return;
    }
    if (url.pathname === "/api/library") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });
}

async function openSuwayomiSettings(page) {
  await page.locator("#nav-settings").click();
  await page.locator("#toggle-suwayomi-panel").click();
  await expect(page.locator("#suwayomi-setup")).toBeVisible();
}

test("rejects credential-bearing base URLs before saving or querying", async ({ page }) => {
  const requests = [];
  await page.addInitScript(() => {
    localStorage.setItem("panel-pilot-settings", JSON.stringify({ baseUrl: "http://existing.example:4567", readerMotion: "instant" }));
  });
  await stubBackend(page, requests);
  await page.goto("/", { waitUntil: "networkidle" });
  await openSuwayomiSettings(page);

  requests.length = 0;
  await page.locator("#server-url").fill("http://reader:secret@suwayomi.example:4567");
  await expect(page.locator("#connection-note")).toContainText("username or password");
  await page.locator("#test-connection").click();
  await expect(page.locator("#connection-note")).toContainText("username or password");

  await page.locator("#server-url").fill("ftp://reader:secret@suwayomi.example:4567");
  await expect(page.locator("#connection-note")).toContainText("http:// or https://");
  await page.locator("#test-connection").click();
  await expect(page.locator("#connection-note")).toContainText("http:// or https://");

  expect(requests.filter(({ pathname }) => pathname === "/api/suwayomi/graphql")).toEqual([]);
  const { persisted, serialized } = await page.evaluate(() => ({
    persisted: JSON.parse(localStorage.getItem("panel-pilot-settings")),
    serialized: JSON.stringify(localStorage),
  }));
  expect(persisted.baseUrl).toBe("http://existing.example:4567");
  expect(serialized).not.toContain("reader:secret@");
  expect(serialized).not.toContain("secret");
});

test("migrates credential-bearing settings, library, and progress records in localStorage", async ({ page }) => {
  const requests = [];
  await page.addInitScript(() => {
    const credentialUrl = "https://reader:secret@suwayomi.example:4567/";
    localStorage.setItem("panel-pilot-settings", JSON.stringify({ baseUrl: credentialUrl, readerMotion: "instant", keepScreenAwake: true }));
    localStorage.setItem("panel-pilot-library", JSON.stringify([{
      mangaId: 101,
      sourceId: "source-1",
      mangaTitle: "Credential migration fixture",
      serverUrl: credentialUrl,
      libraryStatus: "reading",
    }]));
    localStorage.setItem("panel-pilot-progress-outbox", JSON.stringify([{
      serverUrl: credentialUrl,
      chapterId: 202,
      lastPageRead: 3,
      completed: false,
    }]));
  });
  await stubBackend(page, requests, { failProgress: true });
  await page.goto("/", { waitUntil: "networkidle" });

  const migrated = await page.evaluate(() => ({
    settings: JSON.parse(localStorage.getItem("panel-pilot-settings") || "{}"),
    library: JSON.parse(localStorage.getItem("panel-pilot-library") || "[]"),
    progress: JSON.parse(localStorage.getItem("panel-pilot-progress-outbox") || "[]"),
    serialized: JSON.stringify(localStorage),
  }));
  expect(migrated.settings).toMatchObject({ baseUrl: "https://suwayomi.example:4567", keepScreenAwake: true });
  expect(migrated.library[0].serverUrl).toBe("https://suwayomi.example:4567");
  expect(migrated.progress).toHaveLength(1);
  expect(migrated.progress.every((entry) => entry.serverUrl === "https://suwayomi.example:4567")).toBe(true);
  expect(JSON.stringify(requests)).not.toContain("reader:secret@");
  expect(JSON.stringify(requests)).not.toContain("reader%3Asecret%40");
  expect(JSON.stringify(requests)).not.toContain("secret");
  expect(migrated.serialized).not.toContain("reader:secret@");
  expect(migrated.serialized).not.toContain("secret");
});

test("migrates credential-bearing device chapter metadata and cache keys", async ({ page }) => {
  await stubBackend(page, []);
  await page.goto("/", { waitUntil: "networkidle" });

  const fixture = await page.evaluate(async () => {
    const credentialUrl = "https://reader:secret@suwayomi.example:4567";
    const sanitizedUrl = "https://suwayomi.example:4567";
    const chapterId = "303";
    const oldKey = JSON.stringify([credentialUrl, chapterId]);
    const newKey = JSON.stringify([sanitizedUrl, chapterId]);
    const oldPath = `/__panels_device_chapters/v1/${encodeURIComponent(oldKey)}/0`;
    const body = "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>";

    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("panels-device-library", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("chapters")) {
          request.result.createObjectStore("chapters", { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("chapters", "readwrite");
      transaction.objectStore("chapters").put({
        key: oldKey,
        // Exercise the legacy shape where the primary serverUrl was already
        // clean but the IndexedDB key and CacheStorage path still held credentials.
        serverUrl: sanitizedUrl,
        chapterId,
        mangaId: "101",
        mangaTitle: "Device credential migration fixture",
        chapterTitle: "Chapter 1",
        sourceLabel: "Fixture source",
        status: "ready",
        totalPages: 1,
        downloadedPages: 1,
        pageUrls: ["/api/image/credential-migration/1.svg"],
        pages: [{
          index: 0,
          sourceUrl: "/api/image/credential-migration/1.svg",
          cacheUrl: oldPath,
          contentType: "image/svg+xml",
          size: body.length,
        }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        readyAt: new Date().toISOString(),
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();

    const cache = await caches.open("panels-device-chapters-v1");
    await cache.put(oldPath, new Response(body, {
      status: 200,
      headers: { "content-type": "image/svg+xml", "content-length": String(body.length) },
    }));
    return { oldKey, newKey, oldPath };
  });

  await page.reload({ waitUntil: "networkidle" });
  await expect.poll(async () => page.evaluate(async (expectedKey) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("panels-device-library", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise((resolve, reject) => {
      const transaction = database.transaction("chapters", "readonly");
      const request = transaction.objectStore("chapters").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const cache = await caches.open("panels-device-chapters-v1");
    const paths = (await cache.keys()).map((request) => new URL(request.url).pathname);
    const record = records[0] || null;
    return {
      migrated: records.length === 1
        && record?.key === expectedKey
        && record?.serverUrl === "https://suwayomi.example:4567"
        && paths.includes(record?.pages?.[0]?.cacheUrl),
      records,
      paths,
      serialized: JSON.stringify({ records, paths }),
    };
  }, fixture.newKey)).toMatchObject({
    migrated: true,
    records: [expect.objectContaining({
      key: fixture.newKey,
      serverUrl: "https://suwayomi.example:4567",
      pages: [expect.objectContaining({ cacheUrl: expect.stringContaining(encodeURIComponent(fixture.newKey)) })],
    })],
  });

  const finalState = await page.evaluate(async ({ oldKey, newKey, oldPath }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("panels-device-library", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise((resolve, reject) => {
      const transaction = database.transaction("chapters", "readonly");
      const store = transaction.objectStore("chapters");
      const oldRequest = store.get(oldKey);
      const newRequest = store.get(newKey);
      let oldRecord;
      let newRecord;
      let remaining = 2;
      const done = () => { if (--remaining === 0) resolve({ oldRecord: oldRecord || null, newRecord: newRecord || null }); };
      oldRequest.onsuccess = () => { oldRecord = oldRequest.result; done(); };
      newRequest.onsuccess = () => { newRecord = newRequest.result; done(); };
      oldRequest.onerror = () => reject(oldRequest.error);
      newRequest.onerror = () => reject(newRequest.error);
    });
    database.close();
    const cache = await caches.open("panels-device-chapters-v1");
    const migratedPath = records.newRecord?.pages?.[0]?.cacheUrl || "";
    const migratedResponse = migratedPath ? await cache.match(new URL(migratedPath, location.origin).href) : null;
    return {
      oldRecord: records.oldRecord,
      oldCacheEntry: Boolean(await cache.match(new URL(oldPath, location.origin).href)),
      migratedBody: migratedResponse ? await migratedResponse.text() : null,
      serialized: JSON.stringify({ records, keys: (await cache.keys()).map((request) => request.url) }),
    };
  }, fixture);
  expect(finalState.oldRecord).toBeNull();
  expect(finalState.oldCacheEntry).toBe(false);
  expect(finalState.migratedBody).toBe("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>");
  expect(finalState.serialized).not.toContain("reader:secret@");
  expect(finalState.serialized).not.toContain("secret");
});

test("credential migration preserves the only offline copy when cache staging fails or a lease is active", async ({ page, context }) => {
  await stubBackend(page, []);
  await page.goto("/", { waitUntil: "networkidle" });
  const leasePage = await context.newPage();
  await stubBackend(leasePage, []);
  await leasePage.goto("/", { waitUntil: "networkidle" });
  await leasePage.evaluate(() => {
    const channel = new BroadcastChannel("panels-device-library-operations-v1");
    channel.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.type !== "PROBE_OPERATION" || message.ownerId !== "another-live-tab" || message.operationId !== "active-download") return;
      channel.postMessage({
        type: "OPERATION_ALIVE",
        probeId: message.probeId,
        ownerId: message.ownerId,
        key: message.key,
        operationId: message.operationId,
      });
    });
    window.__credentialMigrationLeaseChannel = channel;
  });

  const fixture = await page.evaluate(async () => {
    const credentialUrl = "https://reader:secret@suwayomi.example:4567";
    const cleanUrl = "https://suwayomi.example:4567";
    const makeFixture = (chapterId, lease = null) => {
      const oldKey = JSON.stringify([credentialUrl, chapterId]);
      const newKey = JSON.stringify([cleanUrl, chapterId]);
      const oldPath = `/__panels_device_chapters/v1/${encodeURIComponent(oldKey)}/0`;
      const body = `<svg xmlns='http://www.w3.org/2000/svg'><text>${chapterId}</text></svg>`;
      return { chapterId, oldKey, newKey, oldPath, body, lease };
    };
    const fixtures = [
      makeFixture("401"),
      makeFixture("402", {
        ownerId: "another-live-tab",
        operationId: "active-download",
        kind: "download",
        heartbeatAt: Date.now(),
        expiresAt: Date.now() + 600_000,
      }),
    ];
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("panels-device-library", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("chapters", "readwrite");
      for (const item of fixtures) {
        transaction.objectStore("chapters").put({
          key: item.oldKey,
          serverUrl: cleanUrl,
          chapterId: item.chapterId,
          mangaId: item.chapterId,
          mangaTitle: `Migration safety ${item.chapterId}`,
          chapterTitle: "Chapter 1",
          status: "ready",
          totalPages: 1,
          downloadedPages: 1,
          pageUrls: [`/fixture/${item.chapterId}.svg`],
          pages: [{ index: 0, sourceUrl: `/fixture/${item.chapterId}.svg`, cacheUrl: item.oldPath, contentType: "image/svg+xml", size: item.body.length }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          readyAt: new Date().toISOString(),
          ...(item.lease ? { lease: item.lease } : {}),
        });
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    const cache = await caches.open("panels-device-chapters-v1");
    for (const item of fixtures) {
      await cache.put(item.oldPath, new Response(item.body, { status: 200, headers: { "content-type": "image/svg+xml" } }));
    }
    sessionStorage.setItem("panels-test-fail-credential-cache-stage", "1");
    return fixtures;
  });

  await page.addInitScript(() => {
    if (sessionStorage.getItem("panels-test-fail-credential-cache-stage") !== "1" || typeof Cache !== "function") return;
    const originalPut = Cache.prototype.put;
    Cache.prototype.put = function patchedPut(request, response) {
      const path = new URL(typeof request === "string" ? request : request.url, location.origin).pathname;
      if (path.includes("/credential-migration-")) {
        return Promise.reject(new Error("Fixture cache staging failure"));
      }
      return originalPut.call(this, request, response);
    };
  });
  await page.reload({ waitUntil: "networkidle" });

  const preserved = await page.evaluate(async (fixtures) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("panels-device-library", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise((resolve, reject) => {
      const transaction = database.transaction("chapters", "readonly");
      const request = transaction.objectStore("chapters").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const cache = await caches.open("panels-device-chapters-v1");
    const bodies = {};
    for (const item of fixtures) {
      const response = await cache.match(new URL(item.oldPath, location.origin).href);
      bodies[item.chapterId] = response ? await response.text() : null;
    }
    return { records, bodies };
  }, fixture);

  for (const item of fixture) {
    const record = preserved.records.find(({ key }) => key === item.oldKey);
    expect(record).toBeTruthy();
    expect(preserved.records.some(({ key }) => key === item.newKey)).toBe(false);
    expect(preserved.bodies[item.chapterId]).toBe(item.body);
  }
  expect(preserved.records.find(({ key }) => key === fixture[0].oldKey)?.lease).toBeUndefined();
  expect(preserved.records.find(({ key }) => key === fixture[1].oldKey)?.lease?.operationId).toBe("active-download");
  await leasePage.close();
});

test("credential migration keeps the more complete package when a clean key already exists", async ({ page }) => {
  await stubBackend(page, []);
  await page.goto("/", { waitUntil: "networkidle" });

  const fixture = await page.evaluate(async () => {
    const credentialUrl = "https://reader:secret@suwayomi.example:4567";
    const cleanUrl = "https://suwayomi.example:4567";
    const chapterId = "501";
    const oldKey = JSON.stringify([credentialUrl, chapterId]);
    const newKey = JSON.stringify([cleanUrl, chapterId]);
    const oldPath = `/__panels_device_chapters/v1/${encodeURIComponent(oldKey)}/0`;
    const body = "<svg xmlns='http://www.w3.org/2000/svg'><text>complete legacy media</text></svg>";
    const timestamp = new Date().toISOString();
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("panels-device-library", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("chapters", "readwrite");
      const store = transaction.objectStore("chapters");
      store.put({
        key: oldKey, serverUrl: cleanUrl, chapterId, mangaId: "501", mangaTitle: "Collision fixture", chapterTitle: "Chapter 1",
        status: "ready", totalPages: 1, downloadedPages: 1, pageUrls: ["/fixture/501.svg"],
        pages: [{ index: 0, sourceUrl: "/fixture/501.svg", cacheUrl: oldPath, contentType: "image/svg+xml", size: body.length }],
        createdAt: timestamp, updatedAt: timestamp, readyAt: timestamp,
      });
      store.put({
        key: newKey, serverUrl: cleanUrl, chapterId, mangaId: "501", mangaTitle: "Collision fixture", chapterTitle: "Chapter 1",
        status: "paused", totalPages: 1, downloadedPages: 0, pageUrls: ["/fixture/501.svg"], pages: [],
        createdAt: timestamp, updatedAt: timestamp, readyAt: null,
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    const cache = await caches.open("panels-device-chapters-v1");
    await cache.put(oldPath, new Response(body, { status: 200, headers: { "content-type": "image/svg+xml" } }));
    return { oldKey, newKey, body };
  });

  await page.reload({ waitUntil: "networkidle" });
  await expect.poll(async () => page.evaluate(async ({ oldKey, newKey }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("panels-device-library", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise((resolve, reject) => {
      const transaction = database.transaction("chapters", "readonly");
      const store = transaction.objectStore("chapters");
      const oldRequest = store.get(oldKey);
      const newRequest = store.get(newKey);
      let oldRecord;
      let newRecord;
      let remaining = 2;
      const done = () => { if (--remaining === 0) resolve({ oldRecord: oldRecord || null, newRecord: newRecord || null }); };
      oldRequest.onsuccess = () => { oldRecord = oldRequest.result; done(); };
      newRequest.onsuccess = () => { newRecord = newRequest.result; done(); };
      oldRequest.onerror = () => reject(oldRequest.error);
      newRequest.onerror = () => reject(newRequest.error);
    });
    database.close();
    const cache = await caches.open("panels-device-chapters-v1");
    const path = records.newRecord?.pages?.[0]?.cacheUrl || "";
    const response = path ? await cache.match(new URL(path, location.origin).href) : null;
    return {
      done: !records.oldRecord && records.newRecord?.status === "ready" && records.newRecord?.downloadedPages === 1,
      body: response ? await response.text() : null,
      serialized: JSON.stringify(records),
    };
  }, fixture)).toMatchObject({ done: true, body: fixture.body });

  const serialized = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("panels-device-library", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("chapters", "readonly");
    const records = await new Promise((resolve, reject) => {
      const request = transaction.objectStore("chapters").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return JSON.stringify(records);
  });
  expect(serialized).not.toContain("reader:secret@");
  expect(serialized).not.toContain("secret");
});
