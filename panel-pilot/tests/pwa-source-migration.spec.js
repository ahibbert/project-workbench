import { expect, test } from "@playwright/test";

const oldSource = { id: 77, name: "oldmanga", displayName: "Old Manga", lang: "en", isNsfw: false };
const newSource = { id: 88, name: "newmanga", displayName: "Reliable Manga", lang: "en", isNsfw: false };
const weakSource = { id: 99, name: "weakmanga", displayName: "Unreliable Manga", lang: "en", isNsfw: false };
const oldManga = { id: 801, title: "Golden Kamuy", sourceId: oldSource.id, thumbnailUrl: "" };
const newManga = { id: 901, title: "Golden Kamuy", sourceId: newSource.id, thumbnailUrl: "" };
const weakManga = { id: 902, title: "Golden Kamuy", sourceId: weakSource.id, thumbnailUrl: "" };

function chapter(mangaId, id) {
  return {
    id,
    name: "Chapter 42",
    mangaId,
    scanlator: "Fixture group",
    sourceOrder: 42,
    chapterNumber: 42,
    pageCount: 4,
    isRead: false,
    lastPageRead: 2,
    isDownloaded: false,
    isBookmarked: false,
  };
}

function pageImage(number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1350" viewBox="0 0 900 1350">
    <rect width="900" height="1350" fill="#f8f4ea"/>
    <rect x="30" y="30" width="840" height="620" fill="white" stroke="#202522" stroke-width="12"/>
    <rect x="30" y="690" width="840" height="630" fill="white" stroke="#202522" stroke-width="12"/>
    <text x="450" y="675" text-anchor="middle" font-size="48">Page ${number}</text>
  </svg>`;
}

test("a failed chapter can migrate to another source without losing reading state", async ({ page }) => {
  const oldChapter = chapter(oldManga.id, 80142);
  const newChapter = chapter(newManga.id, 90142);
  const mangaLibraryState = new Map([[oldManga.id, true], [newManga.id, false]]);
  const sourceSearches = [];
  const libraryUpdates = [];
  let sharedLibrary = [{
    mangaId: oldManga.id,
    mangaTitle: oldManga.title,
    sourceId: oldSource.id,
    sourceLabel: oldSource.displayName,
    mediaFormat: "manga",
    mediaFormatSource: "automatic",
    mangabakaId: 4242,
    mangabakaTitle: "Golden Kamuy",
    mangabakaMatchSource: "manual",
    mangabakaAccountKey: "fixture-account",
    libraryStatus: "reading",
    statusExplicit: true,
    started: true,
    chapterId: oldChapter.id,
    chapterTitle: oldChapter.name,
    pageIndex: 2,
    panelIndex: 1,
    panelMode: "manga",
    readingDirection: "rtl",
    progressLabel: "Page 3, panel 2",
    serverUrl: "http://migration.invalid:4567",
    suwayomiLibrary: true,
    updatedAt: "2026-10-02T00:00:00.000Z",
  }];

  await page.addInitScript((items) => {
    try { delete Navigator.prototype.serviceWorker; } catch { /* This test does not exercise service workers. */ }
    localStorage.setItem("panel-pilot-tap-hint-seen", "1");
    localStorage.setItem("panel-pilot-settings", JSON.stringify({
      baseUrl: "http://migration.invalid:4567",
      readerMotion: "instant",
    }));
    localStorage.setItem("panel-pilot-library", JSON.stringify(items));
  }, sharedLibrary);

  await page.route(/\/api(?:\/|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const imageMatch = url.pathname.match(/^\/api\/image\/source-migration\/(\d+)\.svg$/);
    if (imageMatch) {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: pageImage(Number(imageMatch[1])) });
      return;
    }
    if (url.pathname === "/api/suwayomi/graphql") {
      const payload = request.postDataJSON() || {};
      const query = String(payload.query || "");
      const variables = payload.variables || {};
      let data = {};
      if (query.includes("HEALTH")) {
        data = { __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" } } };
      } else if (query.includes("GET_SOURCES_LIST")) {
        data = { sources: { nodes: [oldSource, weakSource, newSource] } };
      } else if (query.includes("GET_LIBRARY_MANGAS")) {
        const nodes = [oldManga, newManga]
          .filter((manga) => mangaLibraryState.get(manga.id))
          .map((manga) => ({
            ...manga,
            inLibrary: true,
            initialized: true,
            source: manga.sourceId === oldSource.id ? oldSource : newSource,
          }));
        data = { mangas: { totalCount: nodes.length, nodes } };
      } else if (query.includes("GET_MANGA_CARD")) {
        const manga = Number(variables.id) === oldManga.id ? oldManga : newManga;
        data = { manga };
      } else if (query.includes("GET_STORED_CHAPTERS")) {
        const mangaId = Number(variables.mangaId);
        data = { chapters: { nodes: mangaId === oldManga.id ? [oldChapter] : mangaId === newManga.id ? [newChapter] : [] } };
      } else if (query.includes("GET_MANGA_CHAPTERS_FETCH")) {
        const mangaId = Number(variables.input?.mangaId);
        data = { fetchChapters: { chapters: mangaId === oldManga.id ? [oldChapter] : [newChapter] } };
      } else if (query.includes("GET_SOURCE_MANGAS_FETCH")) {
        const sourceId = Number(variables.input?.source);
        if (variables.input?.type === "SEARCH") sourceSearches.push(sourceId);
        data = {
          fetchSourceManga: {
            hasNextPage: false,
            mangas: variables.input?.type === "SEARCH"
              ? sourceId === newSource.id ? [newManga] : sourceId === weakSource.id ? [weakManga] : []
              : [],
          },
        };
      } else if (query.includes("UPDATE_MANGA_LIBRARY")) {
        const id = Number(variables.input?.id);
        const inLibrary = Boolean(variables.input?.patch?.inLibrary);
        mangaLibraryState.set(id, inLibrary);
        libraryUpdates.push({ id, inLibrary });
        data = { updateManga: { manga: { id, inLibrary } } };
      } else if (query.includes("GET_CHAPTER_PAGES_FETCH")) {
        const chapterId = Number(variables.input?.chapterId);
        if (chapterId === oldChapter.id) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ errors: [{ message: "API rate limit exceeded" }], data: { fetchChapterPages: null } }),
          });
          return;
        }
        data = {
          fetchChapterPages: {
            chapter: { ...newChapter, manga: { source: newSource } },
            pages: [1, 2, 3, 4].map((number) => `/api/image/source-migration/${number}.svg`),
          },
        };
      } else if (query.includes("UPDATE_CHAPTER_PROGRESS")) {
        data = { updateChapter: { chapter: { id: Number(variables.input?.id), ...variables.input?.patch } } };
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
      return;
    }
    if (url.pathname === "/api/library") {
      if (request.method() === "POST") sharedLibrary = request.postDataJSON()?.items || sharedLibrary;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: sharedLibrary }) });
      return;
    }
    if (url.pathname === "/api/library/migrate") {
      const migration = request.postDataJSON() || {};
      const previousKey = `${migration.from?.sourceId}:${migration.from?.mangaId}`;
      const replacementKey = `${migration.item?.sourceId}:${migration.item?.mangaId}`;
      sharedLibrary = [
        migration.item,
        ...sharedLibrary.filter((item) => ![
          previousKey,
          replacementKey,
        ].includes(`${item.sourceId}:${item.mangaId}`)),
      ];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: sharedLibrary }) });
      return;
    }
    if (url.pathname === "/api/source-profiles") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          profiles: [
            { sourceId: String(newSource.id), sourceLabel: newSource.displayName, score: 92, confidence: "established", attempts: 20, consecutiveFailures: 0 },
            { sourceId: String(weakSource.id), sourceLabel: weakSource.displayName, score: 41, confidence: "established", attempts: 20, consecutiveFailures: 3 },
          ],
        }),
      });
      return;
    }
    if (url.pathname === "/api/download-buffer/status") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ downloaded: 0, queued: 0, failed: 0, windowSize: 0, chapters: [] }) });
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

  await page.goto("/", { waitUntil: "networkidle" });
  const card = page.locator(".library-card").filter({ hasText: "Golden Kamuy" });
  await expect(card).toBeVisible();

  await card.locator('[data-library-action="chapters"]').click();
  await expect(page.locator("#detail-change-source")).toBeVisible();
  await page.locator("#detail-change-source").click();
  await expect(page.locator("#recommendation-context-title")).toHaveText("Move Golden Kamuy to another source");
  await page.locator("#clear-recommendation-context").click();
  await page.locator("#nav-library").click();

  await card.locator(".manga-cover-button").click();

  await expect(page.locator("#reader-error-title")).toContainText("Could not");
  await expect(page.locator("#reader-error-message")).toContainText("rate-limited");
  await expect(page.locator("#reader-error-source")).toBeVisible();
  await page.locator("#reader-error-source").click();

  await expect(page.locator("#recommendation-context-title")).toHaveText("Move Golden Kamuy to another source");
  const replacement = page.locator("#manga-results .manga-card").filter({
    has: page.locator(".manga-cover-eyebrow", { hasText: /^Reliable Manga \(en\)$/ }),
  });
  await expect(replacement).toBeVisible();
  await expect(page.locator("#manga-results .manga-card").first()).toContainText("Reliable Manga");
  await expect(replacement).toContainText("Recommended · 92/100 · established");
  await replacement.locator(".manga-cover-button").click();
  await expect(page.locator("#detail-library")).toHaveText("Switch to this source");
  await page.locator("#detail-library").click();

  await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
  await expect(page.locator("#reader-error")).toBeHidden();
  await expect(page.locator("#page-stat")).toContainText("Page 3");
  await expect.poll(() => libraryUpdates).toContainEqual({ id: newManga.id, inLibrary: true });
  await expect.poll(() => libraryUpdates).toContainEqual({ id: oldManga.id, inLibrary: false });
  expect(sourceSearches).toContain(newSource.id);
  expect(sourceSearches).toContain(weakSource.id);
  expect(sourceSearches).not.toContain(oldSource.id);

  await expect.poll(async () => page.evaluate(() => {
    const items = JSON.parse(localStorage.getItem("panel-pilot-library") || "[]");
    return items.map((item) => ({
      mangaId: item.mangaId,
      sourceId: item.sourceId,
      status: item.libraryStatus,
      mangabakaId: item.mangabakaId,
      chapterId: item.chapterId,
      pageIndex: item.pageIndex,
    }));
  })).toEqual([{
    mangaId: newManga.id,
    sourceId: newSource.id,
    status: "reading",
    mangabakaId: 4242,
    chapterId: newChapter.id,
    pageIndex: 2,
  }]);
});
