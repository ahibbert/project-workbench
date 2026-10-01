import { expect, test } from "@playwright/test";

const serverUrl = "http://cross-device.invalid:4567";
const manga = {
  id: 1701,
  title: "Cross-device fixture",
  thumbnailUrl: "",
  inLibrary: true,
  initialized: true,
  sourceId: 71,
  source: {
    id: 71,
    name: "cross-device-fixture",
    displayName: "Cross-device source",
    lang: "en",
    isNsfw: false,
  },
};

function chapter(id, sourceOrder, overrides = {}) {
  return {
    id,
    name: `Chapter ${sourceOrder}`,
    mangaId: manga.id,
    scanlator: "Fixture group",
    sourceOrder,
    chapterNumber: sourceOrder,
    pageCount: 12,
    isRead: false,
    lastPageRead: 0,
    isDownloaded: false,
    isBookmarked: false,
    ...overrides,
  };
}

function libraryItem(chapterId, pageIndex, updatedAt) {
  return {
    mangaId: manga.id,
    mangaTitle: manga.title,
    sourceId: manga.sourceId,
    sourceLabel: manga.source.displayName,
    suwayomiLibrary: true,
    started: true,
    libraryStatus: "reading",
    chapterId,
    chapterTitle: `Chapter ${chapterId === 2701 ? 1 : 2}`,
    pageIndex,
    panelIndex: 0,
    progressLabel: `Page ${pageIndex + 1}`,
    serverUrl,
    updatedAt,
  };
}

function createSharedBackend(initialChapters) {
  const chapters = initialChapters.map((entry) => ({ ...entry }));
  const events = [];
  const hydrationCounts = new Map();
  const blockedUpdates = new Set();
  const blockedHydrations = new Set();

  return {
    chapters,
    events,
    hydrationCount(device) {
      return hydrationCounts.get(device) || 0;
    },
    blockUpdates(device) {
      blockedUpdates.add(device);
    },
    allowUpdates(device) {
      blockedUpdates.delete(device);
    },
    blockHydration(device) {
      blockedHydrations.add(device);
    },
    async attach(page, device) {
      await page.route(/\/api(?:\/|$)/, async (route) => {
        const request = route.request();
        const url = new URL(request.url());

        if (url.pathname === "/api/suwayomi/graphql") {
          const payload = request.postDataJSON() || {};
          const query = String(payload.query || "");
          const variables = payload.variables || {};
          let data = {};

          if (query.includes("HEALTH")) {
            data = { __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" } } };
          } else if (query.includes("GET_SOURCES_LIST")) {
            data = { sources: { nodes: [manga.source] } };
          } else if (query.includes("GET_LIBRARY_MANGAS")) {
            data = { mangas: { totalCount: 1, nodes: [manga] } };
          } else if (query.includes("GET_STORED_CHAPTERS")) {
            hydrationCounts.set(device, (hydrationCounts.get(device) || 0) + 1);
            events.push({ device, type: "hydrate", chapters: structuredClone(chapters) });
            if (blockedHydrations.has(device)) {
              await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({ error: "Stored chapters are temporarily unavailable" }),
              });
              return;
            }
            data = { chapters: { nodes: structuredClone(chapters) } };
          } else if (query.includes("GET_CHAPTER_PROGRESS")) {
            const target = chapters.find((entry) => entry.id === Number(variables.id));
            events.push({ device, type: "chapter-progress", chapterId: Number(variables.id) });
            data = { chapter: target ? structuredClone(target) : null };
          } else if (query.includes("UPDATE_CHAPTER_PROGRESS")) {
            const chapterId = Number(variables.input?.id);
            const patch = variables.input?.patch || {};
            if (blockedUpdates.has(device)) {
              events.push({ device, type: "update", chapterId, patch: structuredClone(patch), accepted: false });
              await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({ error: "Device is temporarily offline" }),
              });
              return;
            }
            const target = chapters.find((entry) => entry.id === chapterId);
            if (target) {
              if (Object.hasOwn(patch, "lastPageRead")) target.lastPageRead = Number(patch.lastPageRead) || 0;
              if (Object.hasOwn(patch, "isRead")) target.isRead = Boolean(patch.isRead);
            }
            events.push({ device, type: "update", chapterId, patch: structuredClone(patch), accepted: true });
            data = { updateChapter: { chapter: target ? structuredClone(target) : null } };
          }

          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ data }),
          });
          return;
        }

        if (url.pathname === "/api/library") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ items: [] }),
          });
          return;
        }

        if (url.pathname === "/api/download-buffer/status") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ downloaded: 0, queued: 0, failed: 0, windowSize: 0, chapters: [] }),
          });
          return;
        }

        if (url.pathname === "/api/mangabaka/status") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ configured: false, connected: false }),
          });
          return;
        }

        if (url.pathname === "/api/mangabaka/recommendations") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ results: [] }),
          });
          return;
        }

        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });
    },
  };
}

async function seedDevice(page, { item = null, outbox = [] } = {}) {
  await page.addInitScript(({ baseUrl, initialItem, initialOutbox }) => {
    try { delete Navigator.prototype.serviceWorker; } catch { /* This suite does not exercise worker behavior. */ }
    localStorage.setItem("panel-pilot-settings", JSON.stringify({
      baseUrl,
      readerMotion: "instant",
    }));
    localStorage.setItem("panel-pilot-tap-hint-seen", "1");
    if (initialItem) localStorage.setItem("panel-pilot-library", JSON.stringify([initialItem]));
    if (initialOutbox.length) localStorage.setItem("panel-pilot-progress-outbox", JSON.stringify(initialOutbox));
  }, { baseUrl: serverUrl, initialItem: item, initialOutbox: outbox });
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
    window.__setCrossDeviceVisibility = (nextVisibility) => {
      visibility = nextVisibility;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
}

async function setProgressState(page, item, outbox) {
  await page.evaluate(({ nextItem, nextOutbox }) => {
    localStorage.setItem("panel-pilot-library", JSON.stringify([nextItem]));
    localStorage.setItem("panel-pilot-progress-outbox", JSON.stringify(nextOutbox));
  }, { nextItem: item, nextOutbox: outbox });
}

async function storedProgress(page) {
  return page.evaluate(() => {
    const items = JSON.parse(localStorage.getItem("panel-pilot-library") || "[]");
    const outbox = JSON.parse(localStorage.getItem("panel-pilot-progress-outbox") || "[]");
    return { item: items[0] || null, outbox };
  });
}

async function openAndHydrate(page, backend, device, previousHydrations = 0) {
  await page.goto("/");
  await expect.poll(() => backend.hydrationCount(device)).toBeGreaterThan(previousHydrations);
}

test("phone to iPad to phone keeps the furthest page and discards the returning phone's stale outbox", async ({ browser }) => {
  const backend = createSharedBackend([chapter(2701, 1, { lastPageRead: 4 })]);
  const phoneContext = await browser.newContext({ ...test.info().project.use, viewport: { width: 390, height: 844 } });
  const tabletContext = await browser.newContext({ ...test.info().project.use, viewport: { width: 820, height: 1180 } });
  const phone = await phoneContext.newPage();
  const tablet = await tabletContext.newPage();

  try {
    await backend.attach(phone, "phone");
    await backend.attach(tablet, "ipad");
    await installVisibilityShim(phone);
    backend.blockUpdates("phone");
    await seedDevice(phone, {
      item: libraryItem(2701, 5, "2026-10-01T08:05:00.000Z"),
      outbox: [{
        serverUrl,
        chapterId: 2701,
        lastPageRead: 5,
        completed: false,
        updatedAt: Date.parse("2026-10-01T08:05:00.000Z"),
      }],
    });
    await seedDevice(tablet, {
      item: libraryItem(2701, 8, "2026-10-01T08:10:00.000Z"),
      outbox: [{
        serverUrl,
        chapterId: 2701,
        lastPageRead: 8,
        completed: false,
        updatedAt: Date.parse("2026-10-01T08:10:00.000Z"),
      }],
    });

    await openAndHydrate(phone, backend, "phone");
    await expect.poll(() => backend.events.some((event) => (
      event.device === "phone" && event.type === "update" && event.accepted === false
    ))).toBe(true);
    await expect(phone.locator("#library-sync-status")).toHaveAttribute("data-state", "queued");
    await expect(phone.locator("#library-sync-status-label")).toHaveText("Queued");
    await expect(phone.locator("#library-sync-status")).not.toHaveAttribute("data-state", "synced");
    await phone.evaluate(() => window.__setCrossDeviceVisibility("hidden"));

    await openAndHydrate(tablet, backend, "ipad");
    await expect.poll(() => backend.chapters[0].lastPageRead).toBe(8);

    const phoneHydrations = backend.hydrationCount("phone");
    backend.allowUpdates("phone");
    await phone.evaluate(() => {
      window.__setCrossDeviceVisibility("visible");
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect.poll(() => backend.hydrationCount("phone")).toBeGreaterThan(phoneHydrations);
    await expect.poll(async () => (await storedProgress(phone)).item?.pageIndex).toBe(8);
    await expect.poll(async () => (await storedProgress(phone)).outbox.length).toBe(0);
    await expect(phone.locator("#library-sync-status")).toHaveAttribute("data-state", "synced");
    await expect(phone.locator("#library-sync-status-label")).toHaveText("Synced");
    expect(backend.chapters[0].lastPageRead).toBe(8);
    expect(backend.events.filter((event) => (
      event.device === "phone" && event.type === "update" && event.patch.lastPageRead === 5 && event.accepted
    ))).toHaveLength(0);
  } finally {
    await phoneContext.close();
    await tabletContext.close();
  }
});

test("server completion is authoritative over a stale device and advances its resume chapter", async ({ browser }) => {
  const backend = createSharedBackend([
    chapter(2701, 1, { lastPageRead: 6 }),
    chapter(2702, 2),
  ]);
  const phoneContext = await browser.newContext({ ...test.info().project.use, viewport: { width: 390, height: 844 } });
  const tabletContext = await browser.newContext({ ...test.info().project.use, viewport: { width: 820, height: 1180 } });
  const phone = await phoneContext.newPage();
  const tablet = await tabletContext.newPage();

  try {
    await backend.attach(phone, "phone");
    await backend.attach(tablet, "ipad");
    await seedDevice(phone, {
      item: libraryItem(2701, 6, "2026-10-01T09:00:00.000Z"),
    });
    await seedDevice(tablet, {
      item: libraryItem(2701, 11, "2026-10-01T09:10:00.000Z"),
      outbox: [{
        serverUrl,
        chapterId: 2701,
        lastPageRead: 11,
        completed: true,
        updatedAt: Date.parse("2026-10-01T09:10:00.000Z"),
      }],
    });

    await openAndHydrate(phone, backend, "phone");
    await setProgressState(phone, libraryItem(2701, 7, "2026-10-01T09:05:00.000Z"), [{
      serverUrl,
      chapterId: 2701,
      lastPageRead: 7,
      completed: false,
      updatedAt: Date.parse("2026-10-01T09:05:00.000Z"),
    }]);

    await openAndHydrate(tablet, backend, "ipad");
    await expect.poll(() => backend.chapters[0].isRead).toBe(true);
    expect(backend.chapters[0].lastPageRead).toBe(11);

    const phoneHydrations = backend.hydrationCount("phone");
    await phone.reload();
    await expect.poll(() => backend.hydrationCount("phone")).toBeGreaterThan(phoneHydrations);
    await expect.poll(async () => (await storedProgress(phone)).item?.chapterId).toBe(2702);
    await expect.poll(async () => (await storedProgress(phone)).outbox.length).toBe(0);
    expect(backend.chapters[0]).toMatchObject({ isRead: true, lastPageRead: 11 });
    expect(backend.events.filter((event) => (
      event.device === "phone" && event.type === "update" && event.chapterId === 2701
    ))).toHaveLength(0);
  } finally {
    await phoneContext.close();
    await tabletContext.close();
  }
});

test("the pre-mutation guard discards stale queued progress when title hydration is unavailable", async ({ browser }) => {
  const backend = createSharedBackend([chapter(2701, 1, { lastPageRead: 9 })]);
  const context = await browser.newContext({ ...test.info().project.use, viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();

  try {
    backend.blockHydration("phone");
    await backend.attach(phone, "phone");
    await seedDevice(phone, {
      item: libraryItem(2701, 5, "2026-10-01T10:00:00.000Z"),
      outbox: [{
        serverUrl,
        chapterId: 2701,
        lastPageRead: 5,
        completed: false,
        updatedAt: Date.parse("2026-10-01T10:00:00.000Z"),
      }],
    });

    await openAndHydrate(phone, backend, "phone");
    await expect.poll(() => backend.events.some((event) => (
      event.device === "phone" && event.type === "chapter-progress" && event.chapterId === 2701
    ))).toBe(true);
    await expect.poll(async () => (await storedProgress(phone)).outbox.length).toBe(0);
    expect(backend.chapters[0].lastPageRead).toBe(9);
    expect(backend.events.filter((event) => event.device === "phone" && event.type === "update")).toHaveLength(0);
  } finally {
    await context.close();
  }
});
