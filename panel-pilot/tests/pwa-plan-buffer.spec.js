import { expect, test } from "@playwright/test";

const serverUrl = "http://plan-buffer.invalid:4567";
const source = {
  id: 91,
  name: "plan-buffer-fixture",
  displayName: "Plan Buffer Source",
  lang: "en",
  isNsfw: false,
};

function manga(id, title, inLibrary = true) {
  return {
    id,
    title,
    thumbnailUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
    inLibrary,
    initialized: true,
    sourceId: source.id,
    source,
  };
}

function libraryItem(entry, status) {
  return {
    mangaId: entry.id,
    mangaTitle: entry.title,
    sourceId: entry.sourceId,
    sourceLabel: source.displayName,
    thumbnailUrl: entry.thumbnailUrl,
    serverUrl,
    suwayomiLibrary: true,
    libraryStatus: status,
    statusExplicit: true,
    started: status !== "plan_to_read",
    hidden: false,
    pinned: false,
    updatedAt: "2026-10-01T12:00:00.000Z",
  };
}

function chaptersFor(mangaId) {
  // Deliberately reverse the response to prove buffering uses series order,
  // rather than whichever order the GraphQL response happens to use.
  return Array.from({ length: 14 }, (_, offset) => {
    const number = offset + 1;
    return {
      id: mangaId * 100 + number,
      name: `Chapter ${number}`,
      mangaId,
      scanlator: "Fixture group",
      sourceOrder: number,
      chapterNumber: number,
      pageCount: 20,
      isRead: false,
      lastPageRead: 0,
      isDownloaded: false,
      isBookmarked: false,
    };
  }).reverse();
}

function expectedEarliestIds(mangaId) {
  return Array.from({ length: 10 }, (_, offset) => mangaId * 100 + offset + 1);
}

async function installPlanFixture(page, {
  initialItems = [],
  initialOutbox = [],
  libraryMangas = [],
  searchableManga = null,
  rejectedBufferResponses = 0,
  remoteProgressMangaIds = [],
  bufferResponseDelayMs = 0,
} = {}) {
  const items = initialItems.map((item) => ({ ...item }));
  const serverMangas = libraryMangas.map((entry) => ({ ...entry }));
  const chapterMap = new Map(
    [...libraryMangas, searchableManga].filter(Boolean).map((entry) => [Number(entry.id), chaptersFor(Number(entry.id))]),
  );
  remoteProgressMangaIds.forEach((mangaId) => {
    const chapter = chapterMap.get(Number(mangaId))?.find((entry) => entry.sourceOrder === 1);
    if (chapter) chapter.lastPageRead = 9;
  });
  const bufferPosts = [];
  const bufferPriorities = [];
  let remainingRejectedResponses = rejectedBufferResponses;
  let storedChapterQueries = 0;

  await page.addInitScript(({ baseUrl, seededItems, seededOutbox }) => {
    try { delete Navigator.prototype.serviceWorker; } catch { /* Service-worker behavior is outside this suite. */ }
    localStorage.setItem("panel-pilot-settings", JSON.stringify({ baseUrl, readerMotion: "instant" }));
    localStorage.setItem("panel-pilot-tap-hint-seen", "1");
    localStorage.setItem("panel-pilot-library", JSON.stringify(seededItems));
    localStorage.setItem("panel-pilot-progress-outbox", JSON.stringify(seededOutbox));
  }, { baseUrl: serverUrl, seededItems: initialItems, seededOutbox: initialOutbox });

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
        data = { sources: { nodes: [source] } };
      } else if (query.includes("GET_LIBRARY_MANGAS")) {
        data = { mangas: { totalCount: serverMangas.length, nodes: structuredClone(serverMangas) } };
      } else if (query.includes("GET_STORED_CHAPTERS")) {
        storedChapterQueries += 1;
        data = { chapters: { nodes: structuredClone(chapterMap.get(Number(variables.mangaId)) || []) } };
      } else if (query.includes("GET_MANGA_CHAPTERS_FETCH")) {
        const mangaId = Number(variables.input?.mangaId);
        data = { fetchChapters: { chapters: structuredClone(chapterMap.get(mangaId) || []) } };
      } else if (query.includes("GET_SOURCE_MANGAS_FETCH")) {
        data = {
          fetchSourceManga: {
            hasNextPage: false,
            mangas: searchableManga ? [{ ...searchableManga, source: undefined }] : [],
          },
        };
      } else if (query.includes("UPDATE_MANGA_LIBRARY")) {
        const mangaId = Number(variables.input?.id);
        const entry = searchableManga && Number(searchableManga.id) === mangaId ? searchableManga : null;
        if (entry && !serverMangas.some((candidate) => Number(candidate.id) === mangaId)) {
          serverMangas.push({ ...entry, inLibrary: true });
        }
        data = { updateManga: { manga: { id: mangaId, inLibrary: true } } };
      } else if (query.includes("GET_MANGA_CARD")) {
        const entry = [...serverMangas, searchableManga].find((candidate) => Number(candidate?.id) === Number(variables.id));
        data = { manga: entry ? { id: entry.id, title: entry.title, thumbnailUrl: entry.thumbnailUrl } : null };
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data }),
      });
      return;
    }

    if (url.pathname === "/api/library") {
      if (request.method() === "POST") {
        const payload = request.postDataJSON() || {};
        if (Array.isArray(payload.items)) {
          items.splice(0, items.length, ...payload.items.map((item) => ({ ...item })));
        }
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: structuredClone(items) }),
      });
      return;
    }

    if (url.pathname === "/api/download-buffer" && request.method() === "POST") {
      const payload = request.postDataJSON() || {};
      bufferPosts.push((payload.chapterIds || []).map(Number));
      bufferPriorities.push(payload.priority || "foreground");
      const uniqueIds = [...new Set(bufferPosts.flat())];
      const rejected = remainingRejectedResponses > 0 ? 1 : 0;
      remainingRejectedResponses = Math.max(0, remainingRejectedResponses - 1);
      if (bufferResponseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, bufferResponseDelayMs));
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          downloaded: 0,
          queued: uniqueIds.length,
          queuedFresh: uniqueIds.length,
          failed: 0,
          rejected,
          windowSize: uniqueIds.length,
          chapters: [],
          windowChapters: [],
        }),
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
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: false, connected: false }) });
      return;
    }

    if (url.pathname === "/api/mangabaka/recommendations") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [] }) });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  return {
    bufferPosts,
    bufferPriorities,
    storedChapterQueries: () => storedChapterQueries,
  };
}

async function expectNoDeviceLocalChapters(page) {
  const snapshot = await page.evaluate(async () => {
    const records = await new Promise((resolve, reject) => {
      const request = indexedDB.open("panels-device-library", 1);
      request.addEventListener("error", () => reject(request.error), { once: true });
      request.addEventListener("success", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("chapters")) {
          database.close();
          resolve([]);
          return;
        }
        const transaction = database.transaction("chapters", "readonly");
        const read = transaction.objectStore("chapters").getAll();
        read.addEventListener("success", () => {
          database.close();
          resolve(read.result || []);
        }, { once: true });
        read.addEventListener("error", () => reject(read.error), { once: true });
      }, { once: true });
    });
    const deviceRequests = (await caches.open("panels-device-chapters-v1").then((cache) => cache.keys()))
      .filter((request) => new URL(request.url).pathname.startsWith("/__panels_device_chapters/v1/"));
    return { records: records.length, cachedPages: deviceRequests.length };
  });
  expect(snapshot).toEqual({ records: 0, cachedPages: 0 });
}

test("an existing Plan-to-read title buffers its earliest ten server chapters once on startup", async ({ page }) => {
  const entry = manga(1901, "Existing Plan Fixture");
  const item = libraryItem(entry, "plan_to_read");
  const fixture = await installPlanFixture(page, {
    initialItems: [item],
    libraryMangas: [entry],
  });

  await page.goto("/");
  await expect.poll(() => fixture.storedChapterQueries()).toBeGreaterThan(0);
  await expect.poll(() => fixture.bufferPosts.length).toBe(1);
  expect(fixture.bufferPosts[0]).toEqual(expectedEarliestIds(entry.id));
  expect(fixture.bufferPriorities).toEqual(["background"]);
  expect(new Set(fixture.bufferPosts[0]).size).toBe(10);

  // Re-rendering and another library navigation must not enqueue the same set again.
  await page.locator("#nav-browse").click();
  await page.locator("#nav-library").click();
  await page.waitForTimeout(250);
  expect(fixture.bufferPosts).toHaveLength(1);

  await page.locator('[data-library-filter="plan_to_read"]').click();
  const latestPlannedCard = page.locator(".library-card").filter({ hasText: entry.title });
  await latestPlannedCard.locator(".manga-card-more > summary").click();
  await latestPlannedCard.locator(".library-status-select").selectOption("reading");
  await page.locator('[data-library-filter="reading"]').click();
  const readingCard = page.locator(".library-card").filter({ hasText: entry.title });
  await readingCard.locator(".manga-card-more > summary").click();
  await readingCard.locator(".library-status-select").selectOption("plan_to_read");
  await expect.poll(() => fixture.bufferPosts.length).toBe(2);
  expect(fixture.bufferPosts[1]).toEqual(expectedEarliestIds(entry.id));
  expect(fixture.bufferPriorities).toEqual(["background", "background"]);
  await expectNoDeviceLocalChapters(page);
});

test("changing a library title to Plan to read buffers the earliest ten chapters without device downloads", async ({ page }) => {
  const entry = manga(1902, "Changed Plan Fixture");
  const fixture = await installPlanFixture(page, {
    initialItems: [libraryItem(entry, "reading")],
    libraryMangas: [entry],
  });

  await page.goto("/");
  await expect.poll(() => fixture.storedChapterQueries()).toBeGreaterThan(0);
  expect(fixture.bufferPosts).toHaveLength(0);

  const card = page.locator(".library-card").filter({ hasText: entry.title });
  await expect(card).toBeVisible();
  await card.locator(".manga-card-more > summary").click();
  await card.locator(".library-status-select").selectOption("plan_to_read");

  await expect.poll(() => fixture.bufferPosts.length).toBe(1);
  expect(fixture.bufferPosts[0]).toEqual(expectedEarliestIds(entry.id));
  expect(fixture.bufferPriorities).toEqual(["background"]);
  await page.locator('[data-library-filter="plan_to_read"]').click();
  const plannedCard = page.locator(".library-card").filter({ hasText: entry.title });
  await expect(plannedCard).toBeVisible();
  await plannedCard.locator(".manga-card-more > summary").click();
  await plannedCard.locator(".library-status-select").selectOption("plan_to_read");
  await page.waitForTimeout(250);
  expect(fixture.bufferPosts).toHaveLength(1);
  await expectNoDeviceLocalChapters(page);
});

test("adding a searched title to Plan to read buffers it on the server only", async ({ page }) => {
  const entry = manga(1903, "Added Plan Fixture", false);
  const fixture = await installPlanFixture(page, { searchableManga: entry });

  await page.goto("/");
  await page.locator("#nav-browse").click();
  await expect(page.locator("#source-select option")).toHaveCount(2);
  await page.locator("#search-query").fill(entry.title);
  await page.locator("#search-source").click();
  const result = page.locator(".browse-card").filter({ hasText: entry.title });
  await expect(result).toBeVisible();
  await result.locator(".manga-cover-button").click();
  await expect(page.locator("#detail-title")).toHaveText(entry.title);
  await page.locator("#detail-library").click();

  await expect.poll(() => fixture.bufferPosts.length).toBe(1);
  expect(fixture.bufferPosts[0]).toEqual(expectedEarliestIds(entry.id));
  expect(fixture.bufferPriorities).toEqual(["background"]);
  await expect(page.locator("#detail-library")).toHaveText("In library");
  await expectNoDeviceLocalChapters(page);
});

test("a rejected Plan buffer response is retried and is not cached as success", async ({ page }) => {
  const entry = manga(1904, "Retry Plan Fixture");
  const fixture = await installPlanFixture(page, {
    initialItems: [libraryItem(entry, "plan_to_read")],
    libraryMangas: [entry],
    rejectedBufferResponses: 1,
  });

  await page.goto("/");
  await expect.poll(() => fixture.bufferPosts.length, { timeout: 5000 }).toBe(2);
  expect(fixture.bufferPosts[0]).toEqual(expectedEarliestIds(entry.id));
  expect(fixture.bufferPosts[1]).toEqual(expectedEarliestIds(entry.id));
  expect(fixture.bufferPriorities).toEqual(["background", "background"]);
  await expectNoDeviceLocalChapters(page);
});

test("a delayed Plan buffer request cannot restore progress pruned by another title", async ({ page }) => {
  const planned = manga(1905, "Delayed Plan Fixture");
  const reading = manga(1906, "Concurrent Reading Fixture");
  const initialOutbox = [planned, reading].map((entry) => ({
    serverUrl,
    mangaId: entry.id,
    chapterId: entry.id * 100 + 1,
    lastPageRead: 4,
    completed: false,
    updatedAt: Date.parse("2026-10-01T12:00:00.000Z"),
  }));
  const fixture = await installPlanFixture(page, {
    initialItems: [libraryItem(planned, "plan_to_read"), libraryItem(reading, "reading")],
    initialOutbox,
    libraryMangas: [planned, reading],
    remoteProgressMangaIds: [planned.id, reading.id],
    bufferResponseDelayMs: 350,
  });

  await page.goto("/");
  await expect.poll(() => fixture.bufferPosts.length).toBe(1);
  await expect.poll(async () => page.evaluate(() => (
    JSON.parse(localStorage.getItem("panel-pilot-progress-outbox") || "[]").length
  ))).toBe(0);
});
