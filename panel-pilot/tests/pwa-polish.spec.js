import { expect, test } from "@playwright/test";

const serverUrl = "http://polish-fixture.invalid:4567";
const source = {
  id: 77,
  name: "polish-fixture",
  displayName: "Polish Fixture",
  lang: "en",
  isNsfw: false,
  supportsLatest: true,
};
const cover = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='360'%3E%3Crect width='240' height='360' fill='%23276f71'/%3E%3C/svg%3E";

const fixtureMangas = [
  {
    id: 801,
    title: "Reading Fixture",
    thumbnailUrl: cover,
    inLibrary: true,
    initialized: true,
    sourceId: source.id,
    source,
  },
  {
    id: 802,
    title: "Planned Fixture",
    thumbnailUrl: cover,
    inLibrary: true,
    initialized: true,
    sourceId: source.id,
    source,
  },
];

const seededLibrary = [
  {
    mangaId: 801,
    mangaTitle: "Reading Fixture",
    sourceId: source.id,
    sourceLabel: source.displayName,
    thumbnailUrl: cover,
    serverUrl,
    chapterId: 80101,
    chapterTitle: "Chapter 1",
    pageIndex: 2,
    panelIndex: 1,
    progressLabel: "Page 3, panel 2",
    mediaFormat: "comic",
    libraryStatus: "reading",
    statusExplicit: true,
    started: true,
    hidden: false,
    pinned: false,
    updatedAt: "2026-10-01T10:00:00.000Z",
  },
  {
    mangaId: 802,
    mangaTitle: "Planned Fixture",
    sourceId: source.id,
    sourceLabel: source.displayName,
    thumbnailUrl: cover,
    serverUrl,
    mediaFormat: "manga",
    mangabakaId: 8802,
    mangabakaTitle: "Planned Fixture",
    mangabakaMatchSource: "exact-title",
    mangabakaAccountKey: "fixture-account",
    libraryStatus: "plan_to_read",
    statusExplicit: true,
    started: false,
    hidden: false,
    pinned: false,
    updatedAt: "2026-10-01T09:00:00.000Z",
  },
];

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function chapterFor(mangaId) {
  return {
    id: mangaId * 100 + 1,
    name: "Chapter 1",
    mangaId,
    scanlator: "Fixture group",
    sourceOrder: 1,
    chapterNumber: 1,
    pageCount: 12,
    isRead: false,
    lastPageRead: mangaId === 801 ? 2 : 0,
    isDownloaded: false,
    isBookmarked: false,
  };
}

function searchManga(query, id) {
  return {
    id,
    title: query,
    thumbnailUrl: cover,
    inLibrary: false,
    initialized: true,
    sourceId: source.id,
  };
}

function failedBufferStatus() {
  return {
    activeChapterId: null,
    downloaded: 1,
    downloadStateKnown: true,
    failed: 2,
    failedInWindow: 0,
    panelReady: 1,
    preparedChapterIds: [80101],
    queued: 0,
    queuedFresh: 0,
    retrying: 0,
    windowSize: 1,
    windowChapters: [{
      chapterId: 80101,
      id: 80101,
      mangaId: 801,
      mangaTitle: "Reading Fixture",
      sourceId: source.id,
      sourceLabel: source.displayName,
      name: "Chapter 1",
      chapterNumber: 1,
      state: "downloaded",
      panelReady: true,
      isDownloaded: true,
      lastError: "",
    }],
    failedChapters: [{
      chapterId: 80201,
      id: 80201,
      mangaId: 802,
      mangaTitle: "Planned Fixture",
      sourceId: source.id,
      sourceLabel: source.displayName,
      name: "Chapter 8",
      chapterNumber: 8,
      state: "failed",
      panelReady: false,
      isDownloaded: false,
      lastError: "The fixture source is temporarily unavailable",
    }, {
      chapterId: 80102,
      id: 80102,
      mangaId: 801,
      mangaTitle: "Reading Fixture",
      sourceId: source.id,
      sourceLabel: source.displayName,
      name: "Chapter 2",
      chapterNumber: 2,
      state: "failed",
      panelReady: false,
      isDownloaded: false,
      lastError: "Rate limited",
    }],
  };
}

async function installPolishFixture(page, { holdStoredChapters = false, detailChapters = null } = {}) {
  const storedStarted = deferred();
  const releaseStored = deferred();
  const firstSearchStarted = deferred();
  const releaseFirstSearch = deferred();
  const items = structuredClone(seededLibrary);
  let storedQueries = 0;
  let searchRequests = 0;
  const progressMutations = [];
  const downloadBufferRequests = [];

  await page.addInitScript(({ baseUrl, library }) => {
    try { delete Navigator.prototype.serviceWorker; } catch { /* PWA lifecycle is outside this suite. */ }
    localStorage.setItem("panel-pilot-settings", JSON.stringify({
      baseUrl,
      readerMotion: "instant",
      libraryFilter: "reading",
    }));
    localStorage.setItem("panel-pilot-library", JSON.stringify(library));
    localStorage.setItem("panel-pilot-tap-hint-seen", "1");
  }, { baseUrl: serverUrl, library: seededLibrary });

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
        data = { mangas: { totalCount: fixtureMangas.length, nodes: structuredClone(fixtureMangas) } };
      } else if (query.includes("GET_STORED_CHAPTERS")) {
        storedQueries += 1;
        storedStarted.resolve();
        if (holdStoredChapters) await releaseStored.promise;
        data = { chapters: { nodes: [chapterFor(Number(variables.mangaId))] } };
      } else if (query.includes("GET_SOURCE_MANGAS_FETCH")) {
        const input = variables.input || {};
        const requested = String(input.query || "");
        if (input.type === "POPULAR" || !requested) {
          data = { fetchSourceManga: { hasNextPage: false, mangas: [] } };
        } else {
          searchRequests += 1;
          if (requested === "First request") {
            firstSearchStarted.resolve();
            await releaseFirstSearch.promise;
          }
          const results = requested === "Focus cards"
            ? [searchManga("First Focus Card", 9101), searchManga("Second Focus Card", 9102)]
            : [searchManga(`${requested} result`, requested === "First request" ? 9201 : 9202)];
          data = { fetchSourceManga: { hasNextPage: false, mangas: results } };
        }
      } else if (query.includes("GET_MANGA_CHAPTERS_FETCH")) {
        data = { fetchChapters: { chapters: detailChapters || [chapterFor(Number(variables.input?.mangaId) || 9101)] } };
      } else if (query.includes("GET_MANGA_CARD")) {
        const manga = fixtureMangas.find((entry) => Number(entry.id) === Number(variables.id));
        data = { manga: manga ? { id: manga.id, title: manga.title, thumbnailUrl: manga.thumbnailUrl } : null };
      } else if (query.includes("UPDATE_CHAPTER_PROGRESS")) {
        progressMutations.push(structuredClone(variables.input));
        data = { updateChapter: { chapter: { id: Number(variables.input?.id), ...variables.input?.patch } } };
      } else if (query.includes("UPDATE_MANGA_LIBRARY")) {
        data = { updateManga: { manga: { id: Number(variables.input?.id), inLibrary: true } } };
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
          items.splice(0, items.length, ...structuredClone(payload.items));
        }
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: structuredClone(items) }),
      });
      return;
    }

    if (url.pathname === "/api/download-buffer/status") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(failedBufferStatus()) });
      return;
    }

    if (url.pathname === "/api/download-buffer") {
      const payload = request.postDataJSON() || {};
      downloadBufferRequests.push(payload);
      const response = failedBufferStatus();
      if (Array.isArray(payload.chapterIds)) {
        const retried = new Set(payload.chapterIds.map(Number));
        response.failedChapters = response.failedChapters.filter((chapter) => !retried.has(Number(chapter.chapterId)));
        response.failed = response.failedChapters.length;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
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
    firstSearchStarted: () => firstSearchStarted.promise,
    releaseFirstSearch: () => releaseFirstSearch.resolve(),
    releaseStoredChapters: () => releaseStored.resolve(),
    searchRequests: () => searchRequests,
    progressMutations,
    downloadBufferRequests,
    storedQueries: () => storedQueries,
    storedStarted: () => storedStarted.promise,
  };
}

async function openReadyBrowse(page) {
  await page.goto("/");
  await expect(page.locator("#source-select option")).toHaveCount(2);
  await expect(page.locator("#search-source")).toBeEnabled();
  await page.locator("#nav-browse").click();
  await expect(page.locator("#browse-view")).toHaveClass(/\bactive\b/);
}

test("library card disclosure, focus, and cover nodes survive a background readiness refresh", async ({ page }) => {
  const fixture = await installPolishFixture(page, { holdStoredChapters: true });
  await page.goto("/");
  await fixture.storedStarted();

  const card = page.locator(".library-card").filter({ hasText: "Reading Fixture" });
  await expect(card).toHaveCount(1);
  const disclosure = card.locator(".manga-card-more");
  await disclosure.locator("summary").click();
  await expect(disclosure).toHaveAttribute("open", "");
  const select = disclosure.locator(".library-status-select");
  await select.focus();
  await expect(select).toBeFocused();

  const coverNode = await card.locator(".manga-cover-button").elementHandle();
  const imageNode = await card.locator(".manga-cover-image").elementHandle();
  const disclosureNode = await disclosure.elementHandle();
  const selectNode = await select.elementHandle();
  expect(coverNode).not.toBeNull();
  expect(imageNode).not.toBeNull();
  expect(disclosureNode).not.toBeNull();
  expect(selectNode).not.toBeNull();

  fixture.releaseStoredChapters();
  await expect(page.locator("#library-sync-status-label")).toHaveText("Synced");

  const preserved = await page.evaluate(([oldCover, oldImage, oldDisclosure, oldSelect]) => {
    const currentCard = [...document.querySelectorAll(".library-card")]
      .find((item) => item.textContent.includes("Reading Fixture"));
    return {
      cover: oldCover.isConnected && oldCover === currentCard?.querySelector(".manga-cover-button"),
      image: oldImage.isConnected && oldImage === currentCard?.querySelector(".manga-cover-image"),
      disclosure: oldDisclosure.isConnected && oldDisclosure === currentCard?.querySelector(".manga-card-more"),
      open: oldDisclosure.open,
      focus: document.activeElement === oldSelect,
    };
  }, [coverNode, imageNode, disclosureNode, selectNode]);
  expect(preserved).toEqual({ cover: true, image: true, disclosure: true, open: true, focus: true });
});

test("Browse search is latest-request-wins when the first response arrives last", async ({ page }) => {
  const fixture = await installPolishFixture(page);
  await openReadyBrowse(page);

  await page.locator("#search-query").fill("First request");
  await page.locator("#search-source").click();
  await fixture.firstSearchStarted();

  await page.locator("#search-query").fill("Second request");
  await page.locator("#search-query").press("Enter");
  await expect.poll(() => fixture.searchRequests()).toBe(2);
  await expect(page.locator("#manga-results")).toContainText("Second request result");

  fixture.releaseFirstSearch();
  await expect(page.locator("#search-source")).toBeEnabled();
  await expect(page.locator("#manga-results .browse-card")).toHaveCount(1);
  await expect(page.locator("#manga-results")).toContainText("Second request result");
  await expect(page.locator("#manga-results")).not.toContainText("First request result");
});

test("a blank replacement search cancels an older request instead of restoring stale results", async ({ page }) => {
  const fixture = await installPolishFixture(page);
  await openReadyBrowse(page);

  await page.locator("#search-query").fill("First request");
  await page.locator("#search-source").click();
  await fixture.firstSearchStarted();
  await page.locator("#search-query").fill("");
  await page.locator("#search-query").press("Enter");
  fixture.releaseFirstSearch();

  await expect(page.locator("#manga-results")).not.toContainText("First request result");
  await expect(page.locator("#manga-results .manga-skeleton")).toHaveCount(0);
  await expect(page.locator("#search-source")).toBeEnabled();
});

test("closing manga detail restores focus to the exact initiating Browse card", async ({ page }) => {
  await installPolishFixture(page);
  await openReadyBrowse(page);

  await page.locator("#search-query").fill("Focus cards");
  await page.locator("#search-query").press("Enter");
  const cards = page.locator("#manga-results .manga-cover-button");
  await expect(cards).toHaveCount(2);
  const initiatingCard = cards.nth(1);
  await expect(initiatingCard).toHaveAccessibleName(/Second Focus Card/);
  await initiatingCard.focus();
  await initiatingCard.press("Enter");
  await expect(page.locator("#manga-detail")).toBeVisible();
  await expect(page.locator("#detail-title")).toHaveText("Second Focus Card");

  await page.locator("#close-manga-detail").click();
  await expect(page.locator("#manga-detail")).toBeHidden();
  await expect(initiatingCard).toBeFocused();
});

test("library filters expose truthful pressed-button semantics and work from the keyboard", async ({ page }) => {
  await installPolishFixture(page);
  await page.goto("/");
  await expect(page.locator(".library-card")).toHaveCount(1);

  const reading = page.locator('[data-library-filter="reading"]');
  const planned = page.locator('[data-library-filter="plan_to_read"]');
  const all = page.locator('[data-library-filter="all"]');
  await expect(page.locator('[data-library-count="reading"]')).toHaveText("1");
  await expect(page.locator('[data-library-count="plan_to_read"]')).toHaveText("1");
  await expect(page.locator('[data-library-count="all"]')).toHaveText("2");

  await planned.focus();
  await planned.press("Enter");
  await expect(page.locator(".library-card")).toHaveCount(1);
  await expect(page.locator("#library-list")).toContainText("Planned Fixture");
  await expect(page.locator("#library-list")).not.toContainText("Reading Fixture");

  await all.focus();
  await all.press("Space");
  await expect(page.locator(".library-card")).toHaveCount(2);

  await expect(page.locator("#library-filters")).toHaveAttribute("role", "group");
  await expect(page.locator("#library-filters")).toHaveAccessibleName(/library.*status/i);
  for (const [button, pressed] of [[reading, "false"], [planned, "false"], [all, "true"]]) {
    await expect(button).toHaveAttribute("aria-pressed", pressed);
    await expect(button).not.toHaveAttribute("role", "tab");
  }
});

test("library formats filter titles, persist corrections, and detach comics from MangaBaka", async ({ page }) => {
  await installPolishFixture(page);
  await page.goto("/");

  const allFormats = page.locator('[data-library-format-filter="all"]');
  const manga = page.locator('[data-library-format-filter="manga"]');
  const comics = page.locator('[data-library-format-filter="comic"]');
  const webtoons = page.locator('[data-library-format-filter="webtoon"]');
  await comics.click();
  await expect(comics).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#library-list")).toContainText("Reading Fixture");
  await expect(page.locator("#library-list")).not.toContainText("Planned Fixture");

  await manga.click();
  await page.locator('[data-library-filter="all"]').click();
  await expect(page.locator("#library-list")).toContainText("Planned Fixture");
  await expect(page.locator("#library-list")).not.toContainText("Reading Fixture");

  const planned = page.locator(".library-card").filter({ hasText: "Planned Fixture" });
  await planned.locator(".manga-card-more summary").click();
  await planned.locator(".library-format-select").selectOption("comic");
  await expect(page.locator("#library-list")).not.toContainText("Planned Fixture");
  await comics.click();
  await expect(page.locator("#library-list")).toContainText("Planned Fixture");
  await expect.poll(() => page.evaluate(() => {
    const items = JSON.parse(localStorage.getItem("panel-pilot-library") || "[]");
    return items.find((item) => item.mangaId === 802);
  })).toMatchObject({ mediaFormat: "comic", panelMode: "comic" });
  const saved = await page.evaluate(() => {
    const items = JSON.parse(localStorage.getItem("panel-pilot-library") || "[]");
    return items.find((item) => item.mangaId === 802);
  });
  expect(saved).not.toHaveProperty("mangabakaId");
  expect(await page.evaluate(() => ({
    comic: window.PanelPilot.mangaBakaEligibleLibraryItem({ mediaFormat: "comic" }),
    manga: window.PanelPilot.mangaBakaEligibleLibraryItem({ mediaFormat: "manga" }),
    webtoon: window.PanelPilot.mangaBakaEligibleLibraryItem({ mediaFormat: "webtoon" }),
  }))).toEqual({ comic: false, manga: true, webtoon: false });
  expect(await page.evaluate(() => ({
    comic: window.PanelPilot.inferredMediaFormat({ sourceLabel: "ReadComicOnline (en)" }),
    manga: window.PanelPilot.inferredMediaFormat({ sourceLabel: "MangaDex (en)" }),
    webtoon: window.PanelPilot.inferredMediaFormat({ sourceLabel: "WEBTOON (en)" }),
  }))).toEqual({ comic: "comic", manga: "manga", webtoon: "webtoon" });
  await expect(allFormats).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#library-format-filters")).toHaveAccessibleName(/library.*format/i);
});

test("direct library actions repaint immediately instead of leaving an in-use card stale", async ({ page }) => {
  await installPolishFixture(page);
  await page.goto("/");
  await page.locator('[data-library-filter="all"]').click();

  const card = page.locator(".library-card").filter({ hasText: "Reading Fixture" });
  await card.locator(".manga-card-more summary").click();
  await card.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(card.getByText("Pinned", { exact: true })).toBeVisible();
  await card.locator(".manga-card-more summary").click();
  await expect(card.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
});

test("chapter details can change library group and mark every earlier chapter as read", async ({ page }) => {
  const chapters = [5, 4, 3, 2, 1].map((number) => ({
    ...chapterFor(801),
    id: 81000 + number,
    name: `Chapter ${number}`,
    sourceOrder: number,
    chapterNumber: number,
    pageCount: 10 + number,
    lastPageRead: 0,
  }));
  const fixture = await installPolishFixture(page, { detailChapters: chapters });
  await page.goto("/");

  const card = page.locator(".library-card").filter({ hasText: "Reading Fixture" });
  await card.getByRole("button", { name: "Chapters", exact: true }).click();
  await expect(page.locator("#manga-detail")).toBeVisible();
  await expect(page.locator("#detail-library-status")).toHaveValue("reading");

  await page.locator("#detail-library-status").selectOption("paused");
  await expect(page.locator("#detail-library-status")).toHaveValue("paused");
  await expect.poll(() => page.evaluate(() => {
    const items = JSON.parse(localStorage.getItem("panel-pilot-library") || "[]");
    return items.find((item) => item.mangaId === 801)?.libraryStatus;
  })).toBe("paused");

  const selected = page.locator('[data-chapter-id="81004"]');
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Mark 3 chapters before Chapter 4 as read?");
    expect(dialog.message()).toContain("Chapter 4 itself will stay unchanged.");
    await dialog.accept();
  });
  await selected.getByRole("button", { name: /Mark 3 chapters before Chapter 4 as read/ }).click();
  await expect.poll(() => fixture.progressMutations.length).toBe(4);

  expect(fixture.progressMutations
    .map((input) => ({ id: input.id, patch: input.patch }))
    .sort((left, right) => left.id - right.id)).toEqual([
      { id: 80101, patch: { isRead: true, lastPageRead: 11 } },
      { id: 81001, patch: { isRead: true, lastPageRead: 10 } },
      { id: 81002, patch: { isRead: true, lastPageRead: 11 } },
      { id: 81003, patch: { isRead: true, lastPageRead: 12 } },
    ]);
  await expect(selected.locator(".chapter-device-copy > span")).not.toContainText("Read");
  await expect(page.locator('[data-chapter-id="81003"] .chapter-device-copy > span')).toContainText("Read");
  await expect(selected.getByRole("button", { name: /Mark earlier/ })).toHaveCount(0);
});

test("chapter actions stay inside a 430px mobile viewport", async ({ page }) => {
  const chapters = [5, 4, 3, 2, 1].map((number) => ({
    ...chapterFor(801),
    id: 81000 + number,
    name: `Chapter ${number}`,
    sourceOrder: number,
    chapterNumber: number,
    pageCount: 10 + number,
    lastPageRead: 0,
  }));
  await installPolishFixture(page, { detailChapters: chapters });
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto("/");

  const card = page.locator(".library-card").filter({ hasText: "Reading Fixture" });
  await card.getByRole("button", { name: "Chapters", exact: true }).click();
  const actions = page.locator('[data-chapter-id="81004"] .chapter-actions');
  await expect(actions).toBeVisible();

  const layout = await actions.evaluate((node) => {
    const bounds = (selector) => {
      const rect = node.querySelector(selector).getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom };
    };
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      actionScrollWidth: node.scrollWidth,
      actionClientWidth: node.clientWidth,
      status: bounds(".device-chapter-status"),
      read: bounds('[data-chapter-action="read"]'),
      markEarlier: bounds('[data-chapter-action="mark-earlier-read"]'),
      download: bounds('[data-device-action="download"]'),
    };
  });

  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.actionScrollWidth).toBeLessThanOrEqual(layout.actionClientWidth);
  for (const control of [layout.status, layout.read, layout.markEarlier, layout.download]) {
    expect(control.right).toBeLessThanOrEqual(layout.viewportWidth);
  }
  expect(layout.status.bottom).toBeLessThanOrEqual(layout.read.top);
  expect(Math.abs(layout.read.top - layout.markEarlier.top)).toBeLessThan(1);
  expect(layout.download.top).toBeGreaterThanOrEqual(layout.read.bottom);
});

test("the server-buffer sheet is modal, traps focus, closes, and restores focus to its pill", async ({ page }) => {
  await installPolishFixture(page);
  await page.goto("/");
  const pill = page.locator("#download-status-button");
  await expect(pill).toBeVisible();
  await pill.click();

  const sheet = page.locator("#download-status-sheet");
  const close = page.locator("#download-status-close");
  const retry = page.locator("#download-status-retry");
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("role", "dialog");
  await expect(sheet).toHaveAttribute("aria-modal", "true");
  await expect(close).toBeFocused();
  await expect(retry).toBeVisible();

  await close.press("Shift+Tab");
  await expect(retry).toBeFocused();
  await retry.press("Tab");
  await expect(close).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(pill).toBeFocused();
});

test("the failed download total filters to actionable failed chapters", async ({ page }) => {
  const fixture = await installPolishFixture(page);
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto("/");
  await page.locator("#download-status-button").click();

  const filter = page.locator("#download-stat-failed-filter");
  await expect(filter).toContainText("2");
  await expect(filter).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".download-chapter-row")).toHaveCount(1);
  await expect(page.locator(".download-chapter-row")).toHaveAttribute("data-state", "downloaded");

  await filter.click();
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#download-status-title")).toHaveText("Failed server downloads");
  await expect(page.locator(".download-chapter-row")).toHaveCount(2);
  await expect(page.locator('.download-chapter-row[data-state="failed"]')).toHaveCount(2);
  await expect(page.locator(".download-chapter-error").first()).toContainText("temporarily unavailable");

  await page.getByRole("button", { name: "Retry Chapter 8" }).click();
  await expect.poll(() => fixture.downloadBufferRequests).toContainEqual({
    chapterIds: [80201],
    priority: "background",
  });

  await filter.click();
  await expect(filter).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".download-chapter-row")).toHaveCount(1);
  await expect(page.locator(".download-chapter-row")).toHaveAttribute("data-state", "downloaded");
});

test("the server-buffer sheet locks scrolling and restores focus after touch-style activation", async ({ page }) => {
  await installPolishFixture(page);
  await page.goto("/");
  await expect(page.locator("#download-status-button")).toBeVisible();

  await page.evaluate(() => {
    document.querySelector("#stage")?.focus();
    document.querySelector("#download-status-button")?.click();
  });
  await expect(page.locator("body")).toHaveClass(/\bdownload-sheet-open\b/);
  await expect(page.locator("#download-status-sheet")).toBeVisible();
  await page.evaluate(() => document.querySelector("#download-status-close")?.click());
  await expect(page.locator("body")).not.toHaveClass(/\bdownload-sheet-open\b/);
  await expect(page.locator("#download-status-button")).toBeFocused();
});

test("visible server-buffer language stays distinct from device-download language", async ({ page }) => {
  await installPolishFixture(page);
  await page.goto("/");
  const pill = page.locator("#download-status-button");
  await expect(pill).toBeVisible();
  await pill.click();

  const copy = await page.evaluate(() => ({
    pill: document.querySelector("#download-status-button")?.getAttribute("aria-label") || "",
    sheet: [
      document.querySelector("#download-status-title")?.textContent,
      document.querySelector(".download-status-eyebrow")?.textContent,
      document.querySelector("#download-status-summary")?.textContent,
    ].filter(Boolean).join(" "),
    serverNote: document.querySelector("#offline-note")?.textContent || "",
    deviceHeading: document.querySelector("#device-storage-title")?.textContent || "",
    deviceSummary: document.querySelector("#device-storage-summary")?.textContent || "",
  }));
  const problems = [];
  if (!/server/i.test(copy.pill)) problems.push(`server-buffer pill is ambiguous: ${copy.pill}`);
  if (!/server/i.test(copy.sheet)) problems.push(`server-buffer sheet is ambiguous: ${copy.sheet}`);
  if (!/server/i.test(copy.serverNote)) problems.push(`server-buffer settings note is ambiguous: ${copy.serverNote}`);
  if (!/device/i.test(`${copy.deviceHeading} ${copy.deviceSummary}`)) {
    problems.push(`device-download section is ambiguous: ${copy.deviceHeading} ${copy.deviceSummary}`);
  }
  expect(problems).toEqual([]);
});

test("persistent controls keep 44px touch targets and tertiary text remains legible with AA contrast", async ({ page }) => {
  await installPolishFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".library-card")).toHaveCount(1);
  await expect(page.locator("#download-status-button")).toBeVisible();

  const audit = await page.evaluate(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const label = (node) => node.id
      ? `#${node.id}`
      : `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}:${String(node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 36)}`;
    const parseColor = (value) => {
      const channels = String(value).match(/[\d.]+/g)?.map(Number) || [];
      return { r: channels[0] || 0, g: channels[1] || 0, b: channels[2] || 0, a: channels.length > 3 ? channels[3] : 1 };
    };
    const blend = (foreground, background) => ({
      r: foreground.r * foreground.a + background.r * (1 - foreground.a),
      g: foreground.g * foreground.a + background.g * (1 - foreground.a),
      b: foreground.b * foreground.a + background.b * (1 - foreground.a),
      a: 1,
    });
    const backgroundFor = (node) => {
      const layers = [];
      for (let current = node; current instanceof Element; current = current.parentElement) {
        const color = parseColor(getComputedStyle(current).backgroundColor);
        if (color.a > 0) layers.push(color);
      }
      return layers.reverse().reduce((background, layer) => blend(layer, background), { r: 255, g: 255, b: 255, a: 1 });
    };
    const luminance = ({ r, g, b }) => [r, g, b]
      .map((channel) => channel / 255)
      .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (left, right) => {
      const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a);
      return (lighter + 0.05) / (darker + 0.05);
    };

    const touchSelectors = [
      "#toggle-hidden-library",
      ".library-filter",
      ".library-card .manga-cover-button",
      ".library-card .manga-card-actions button",
      ".library-card .manga-card-more summary",
      "#download-status-button",
      "#nav-reader",
      ".app-nav-button",
    ];
    const textSelectors = [
      ".view-subtitle",
      ".library-filter-help",
      ".library-filter",
      ".library-filter span",
      ".manga-cover-eyebrow",
      ".manga-cover-meta",
      ".manga-card-badge",
      ".manga-card-actions button",
      ".manga-card-more summary",
      ".app-nav-button",
      ".download-status-copy strong",
      ".download-status-copy small",
      ".reader-resume-kicker",
      ".reading-miniplayer small",
    ];
    const contrastSelectors = [
      ".view-subtitle",
      ".library-filter-help",
      ".library-filter",
      ".manga-card-actions button",
      ".manga-card-more summary",
      ".app-nav-button",
      ".download-status-copy strong",
      ".download-status-copy small",
      ".reader-resume-kicker",
      ".reading-miniplayer small",
    ];

    const nodesFor = (selectors) => [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
      .filter(visible);
    const undersizedTargets = nodesFor(touchSelectors).flatMap((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width + 0.01 < 44 || rect.height + 0.01 < 44
        ? [`${label(node)} = ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}`]
        : [];
    });
    const tinyText = nodesFor(textSelectors).flatMap((node) => {
      const size = Number.parseFloat(getComputedStyle(node).fontSize);
      return size + 0.01 < 12 ? [`${label(node)} = ${size.toFixed(2)}px`] : [];
    });
    const lowContrast = nodesFor(contrastSelectors).flatMap((node) => {
      const foreground = blend(parseColor(getComputedStyle(node).color), backgroundFor(node));
      const ratio = contrast(foreground, backgroundFor(node));
      return ratio + 0.01 < 4.5 ? [`${label(node)} = ${ratio.toFixed(2)}:1`] : [];
    });
    return { undersizedTargets, tinyText, lowContrast };
  });

  expect(audit).toEqual({ undersizedTargets: [], tinyText: [], lowContrast: [] });
});

test("iPad-width secondary controls keep readable type and touch sizing", async ({ page }) => {
  await installPolishFixture(page);
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/");
  await page.locator('[data-library-filter="all"]').click();
  await page.locator(".library-card").first().locator(".manga-card-more summary").click();

  const issues = await page.evaluate(() => {
    const selectors = [
      "#toggle-hidden-library",
      ".library-sync-status",
      ".manga-card-more summary",
      ".manga-card-menu .quiet-card-action",
      ".app-nav-button",
      ".download-status-button",
    ];
    return selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).flatMap((node) => {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      const size = Number.parseFloat(getComputedStyle(node).fontSize);
      const failures = [];
      if (size < 12) failures.push(`${selector} text ${size.toFixed(2)}px`);
      if ((node.matches("button, summary")) && (rect.width < 44 || rect.height < 44)) {
        failures.push(`${selector} target ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}`);
      }
      return failures;
    });
  });
  expect(issues).toEqual([]);
});
