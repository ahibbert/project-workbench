import { expect, test } from "@playwright/test";

const fixtureManga = {
  mangaId: 601,
  mangaTitle: "Reader resilience fixture",
  sourceId: 21,
  sourceLabel: "Resilience source",
  libraryStatus: "reading",
  statusExplicit: true,
  started: true,
  hidden: false,
  pinned: false,
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function fixtureChapter(id, pageCount = 6) {
  return {
    id,
    name: `Resilience chapter ${id}`,
    mangaId: fixtureManga.mangaId,
    scanlator: "Fixture group",
    sourceOrder: id,
    chapterNumber: id,
    pageCount,
    isRead: false,
    lastPageRead: 0,
    isDownloaded: false,
    isBookmarked: false,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixtureImage(chapterId, pageNumber, { webtoon = false } = {}) {
  const width = 360;
  const height = webtoon ? 1440 : 540;
  const hue = (Number(chapterId) * 17 + pageNumber * 43) % 360;
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="hsl(${hue} 38% 92%)"/>
      <rect x="18" y="18" width="324" height="${height - 36}" rx="8" fill="white" stroke="#202522" stroke-width="8"/>
      <path d="M 22 ${Math.round(height / 2)} H 338" stroke="#202522" stroke-width="8"/>
    </svg>
  `;
}

async function installBackend(page, {
  chapterIds = [1101, 1102],
  pageCount = 6,
  webtoon = false,
} = {}) {
  const chapters = chapterIds.map((id) => fixtureChapter(id, pageCount));
  let libraryItems = [{ ...fixtureManga }];
  const chapterGates = new Map();
  const imageGates = new Map();
  const payloadRequests = new Map();
  const imageRequests = new Map();
  const imageFailures = new Map();
  const progressMutations = [];

  const imagePath = (chapterId, pageNumber) => `/api/image/reader-resilience/${chapterId}/${pageNumber}.svg`;
  const pagesFor = (chapterId) => Array.from(
    { length: pageCount },
    (_, index) => imagePath(chapterId, index + 1),
  );

  await page.route(/\/api(?:\/|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    const imageMatch = url.pathname.match(/^\/api\/image\/reader-resilience\/(\d+)\/(\d+)\.svg$/);
    if (imageMatch) {
      const chapterId = Number(imageMatch[1]);
      const pageNumber = Number(imageMatch[2]);
      const path = url.pathname;
      imageRequests.set(path, (imageRequests.get(path) || 0) + 1);
      const gate = imageGates.get(path);
      if (gate) await gate.promise;
      const remainingFailures = imageFailures.get(path) || 0;
      if (remainingFailures > 0) {
        imageFailures.set(path, remainingFailures - 1);
        await route.fulfill({ status: 503, contentType: "text/plain", body: "Temporary image failure" }).catch(() => {});
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml; charset=utf-8",
        headers: { "Cache-Control": "no-store" },
        body: fixtureImage(chapterId, pageNumber, { webtoon }),
      }).catch(() => {});
      return;
    }

    if (url.pathname === "/api/suwayomi/graphql") {
      const payload = request.postDataJSON() || {};
      const query = String(payload.query || "");
      const variables = payload.variables || {};
      let data = {};
      if (query.includes("GET_MANGA_CHAPTERS_FETCH")) {
        data = { fetchChapters: { chapters } };
      } else if (query.includes("GET_STORED_CHAPTERS")) {
        data = { chapters: { nodes: chapters } };
      } else if (query.includes("GET_CHAPTER_PAGES_FETCH")) {
        const chapterId = Number(variables.input?.chapterId);
        payloadRequests.set(chapterId, (payloadRequests.get(chapterId) || 0) + 1);
        const gate = chapterGates.get(chapterId);
        if (gate) await gate.promise;
        const chapter = chapters.find((entry) => entry.id === chapterId);
        data = {
          fetchChapterPages: {
            chapter: chapter ? {
              ...chapter,
              manga: { source: { name: "fixture", displayName: fixtureManga.sourceLabel, lang: "en" } },
            } : null,
            pages: chapter ? pagesFor(chapterId) : [],
          },
        };
      } else if (query.includes("UPDATE_CHAPTER_PROGRESS")) {
        progressMutations.push(structuredClone(variables));
        data = {
          updateChapter: {
            chapter: {
              id: Number(variables.input?.id),
              isRead: Boolean(variables.input?.patch?.isRead),
              lastPageRead: Number(variables.input?.patch?.lastPageRead) || 0,
            },
          },
        };
      } else if (query.includes("UPDATE_MANGA_LIBRARY")) {
        data = { updateManga: { manga: { id: fixtureManga.mangaId, inLibrary: true } } };
      } else if (query.includes("HEALTH")) {
        data = { __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" } } };
      } else if (query.includes("GET_SOURCES_LIST")) {
        data = { sources: { nodes: [] } };
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) }).catch(() => {});
      return;
    }

    if (url.pathname === "/api/library") {
      if (request.method() === "POST") {
        const payload = request.postDataJSON() || {};
        if (Array.isArray(payload.items)) libraryItems = payload.items;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: libraryItems }),
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
    chapters,
    imagePath,
    progressMutations,
    holdChapter(chapterId) {
      const gate = deferred();
      chapterGates.set(Number(chapterId), gate);
      return () => {
        chapterGates.delete(Number(chapterId));
        gate.resolve();
      };
    },
    holdImage(chapterId, pageNumber) {
      const path = imagePath(chapterId, pageNumber);
      const gate = deferred();
      imageGates.set(path, gate);
      return () => {
        imageGates.delete(path);
        gate.resolve();
      };
    },
    failImage(chapterId, pageNumber, times = 1) {
      imageFailures.set(imagePath(chapterId, pageNumber), times);
    },
    payloadRequestCount(chapterId) {
      return payloadRequests.get(Number(chapterId)) || 0;
    },
    imageRequestCount(chapterId, pageNumber) {
      return imageRequests.get(imagePath(chapterId, pageNumber)) || 0;
    },
  };
}

async function seedSettings(page, overrides = {}, { tapHintSeen = true } = {}) {
  await page.addInitScript(({ settings, shouldSeedTapHint }) => {
    try { delete Navigator.prototype.serviceWorker; } catch { /* The suite does not exercise service-worker behavior. */ }
    if (shouldSeedTapHint && !localStorage.getItem("panel-pilot-tap-hint-seen")) {
      localStorage.setItem("panel-pilot-tap-hint-seen", "1");
    } else if (!shouldSeedTapHint) {
      localStorage.removeItem("panel-pilot-tap-hint-seen");
    }
    if (!localStorage.getItem("panel-pilot-settings")) {
      localStorage.setItem("panel-pilot-settings", JSON.stringify({
        baseUrl: "http://resilience.invalid:4567",
        readerMotion: "instant",
        ...settings,
      }));
    }
  }, { settings: overrides, shouldSeedTapHint: tapHintSeen });
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
    window.__setReaderTestVisibility = (nextVisibility) => {
      visibility = nextVisibility;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
}

async function installWakeLockMock(page, mode = "available") {
  await page.addInitScript((initialMode) => {
    let mode = initialMode;
    const stats = { requests: 0, releases: 0, active: 0 };
    window.__readerWakeLock = {
      setMode(nextMode) { mode = nextMode; },
      snapshot() { return { ...stats, mode }; },
    };
    if (mode === "unsupported") {
      try { delete Navigator.prototype.wakeLock; } catch { /* The own-property fallback below is sufficient. */ }
      try { delete navigator.wakeLock; } catch { /* Chromium may expose the property on its prototype only. */ }
      return;
    }
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        async request(type) {
          stats.requests += 1;
          if (type !== "screen") throw new TypeError(`Unexpected wake lock type: ${type}`);
          if (mode === "reject") throw new DOMException("Wake lock denied by fixture", "NotAllowedError");
          const sentinel = new EventTarget();
          sentinel.released = false;
          sentinel.release = async () => {
            if (sentinel.released) return;
            sentinel.released = true;
            stats.releases += 1;
            stats.active = Math.max(0, stats.active - 1);
            sentinel.dispatchEvent(new Event("release"));
          };
          stats.active += 1;
          return sentinel;
        },
      },
    });
  }, mode);
}

async function gotoApp(page) {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
}

async function openDemo(page) {
  await page.locator("#nav-settings").click();
  if (!await page.locator("#suwayomi-setup").isVisible()) {
    await page.locator("#toggle-suwayomi-panel").click();
  }
  if (!await page.locator("#load-demo").isVisible()) {
    await page.locator(".setup-advanced > summary").click();
  }
  await page.locator("#load-demo").click();
  await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/, { timeout: 20_000 });
  await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "true", { timeout: 20_000 });
}

async function openChapterList(page) {
  await page.locator("#nav-library").click();
  const card = page.locator(".library-card").filter({ hasText: fixtureManga.mangaTitle });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Chapters", exact: true }).click();
  await expect(page.locator("[data-chapter-id]").first()).toBeVisible();
}

async function requestChapter(page, chapterId) {
  await page.evaluate((id) => {
    const input = document.querySelector("#chapter-id");
    input.value = String(id);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#load-chapter-pages").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, chapterId);
}

async function moveToPage(page, targetPage, direction = 1) {
  const control = page.locator(direction > 0 ? "#next-panel" : "#prev-panel");
  const pagePattern = new RegExp(`^Page ${targetPage}(?:\\s|$)`);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (pagePattern.test(await page.locator("#page-stat").textContent() || "")) return;
    await expect(control).toBeEnabled();
    await control.click();
    await page.waitForTimeout(50);
  }
  await expect(page.locator("#page-stat")).toHaveText(pagePattern, { timeout: 15_000 });
}

async function expectExclusiveReaderOverlay(page, selector) {
  await expect.poll(() => page.evaluate((activeSelector) => {
    const reader = document.querySelector("#reader-view");
    const surface = reader.querySelector(activeSelector);
    const overlays = [
      document.querySelector("#reader-loading")?.classList.contains("active") ? "#reader-loading" : null,
      ...["#reader-error", "#reader-complete", "#reader-tap-hint"].filter((candidate) => (
        !document.querySelector(candidate)?.hidden
      )),
    ].filter(Boolean);
    const siblings = [...reader.children];
    return {
      overlays,
      surfaceInert: surface.inert,
      inertSiblingCount: siblings.filter((child) => child !== surface && child.inert).length,
      siblingCount: siblings.length - 1,
    };
  }, selector)).toEqual({
    overlays: [selector],
    surfaceInert: false,
    inertSiblingCount: await page.locator("#reader-view > *").count() - 1,
    siblingCount: await page.locator("#reader-view > *").count() - 1,
  });
}

async function expectReaderIsolationCleared(page) {
  await expect.poll(() => page.locator("#reader-view > [inert]").count()).toBe(0);
}

async function openFixtureChapter(page, chapterId = 1101) {
  await openChapterList(page);
  await page.locator(`[data-chapter-id="${chapterId}"] [data-chapter-action="read"]`).click();
  await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/, { timeout: 20_000 });
  await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "true", { timeout: 20_000 });
  await expect.poll(() => page.evaluate((id) => {
    const stageSource = document.querySelector("#stage-image")?.getAttribute("src") || "";
    const stripSource = document.querySelector(".stage-strip img")?.getAttribute("src") || "";
    return stageSource.includes(`/${id}/`) || stripSource.includes(`/${id}/`);
  }, chapterId)).toBe(true);
}

test("wake lock follows reader visibility and the persisted preference", async ({ page }) => {
  await seedSettings(page, { keepScreenAwake: true });
  await installVisibilityShim(page);
  await installWakeLockMock(page);
  await installBackend(page);
  await gotoApp(page);
  await openDemo(page);

  await expect.poll(() => page.evaluate(() => window.__readerWakeLock.snapshot())).toMatchObject({
    requests: 1,
    active: 1,
  });
  await expect(page.locator("#wake-lock-status")).toContainText(/awake|active/i);

  await page.evaluate(() => window.__setReaderTestVisibility("hidden"));
  await expect.poll(() => page.evaluate(() => window.__readerWakeLock.snapshot())).toMatchObject({
    releases: 1,
    active: 0,
  });
  await page.evaluate(() => window.__setReaderTestVisibility("visible"));
  await expect.poll(() => page.evaluate(() => window.__readerWakeLock.snapshot())).toMatchObject({
    requests: 2,
    active: 1,
  });

  await page.locator("#reader-back").click();
  await expect.poll(() => page.evaluate(() => window.__readerWakeLock.snapshot())).toMatchObject({
    releases: 2,
    active: 0,
  });
  await openDemo(page);
  await expect.poll(() => page.evaluate(() => window.__readerWakeLock.snapshot())).toMatchObject({
    requests: 3,
    active: 1,
  });

  await page.locator(".reader-options > summary").click();
  await expect(page.locator("#keep-screen-awake")).toBeVisible();
  await expect(page.locator("#keep-screen-awake")).toBeChecked();
  await page.locator("#keep-screen-awake").uncheck();
  await expect.poll(() => page.evaluate(() => window.__readerWakeLock.snapshot().active)).toBe(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("panel-pilot-settings")).keepScreenAwake)).toBe(false);
  await page.reload({ waitUntil: "networkidle" });
  await openDemo(page);
  await page.locator(".reader-options > summary").click();
  await expect(page.locator("#keep-screen-awake")).not.toBeChecked();
});

test("unsupported and rejected wake lock APIs leave reading usable", async ({ browser }) => {
  for (const mode of ["unsupported", "reject"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await seedSettings(page, { keepScreenAwake: true });
    await installVisibilityShim(page);
    await installWakeLockMock(page, mode);
    await installBackend(page);
    await gotoApp(page);
    await openDemo(page);
    await expect(page.locator("#wake-lock-status")).toContainText(/unsupported|not supported|not available|unavailable|denied|could not/i);
    await expect(page.locator("#stage-image")).toBeVisible();
    await context.close();
  }
});

test("an image held while hidden resumes without a false timeout", async ({ page }) => {
  await seedSettings(page);
  await installVisibilityShim(page);
  const backend = await installBackend(page, { chapterIds: [1101], pageCount: 1 });
  const release = backend.holdImage(1101, 1);
  await gotoApp(page);

  const loadResult = page.evaluate(async (url) => {
    try {
      const image = await window.PanelPilot.loadImage(url, { retry: false, timeoutMs: 250 });
      return { ok: true, width: image.naturalWidth };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }, backend.imagePath(1101, 1));
  await expect.poll(() => backend.imageRequestCount(1101, 1)).toBe(1);
  await page.evaluate(() => window.__setReaderTestVisibility("hidden"));
  await page.waitForTimeout(650);
  await page.evaluate(() => window.__setReaderTestVisibility("visible"));
  release();
  expect(await loadResult).toMatchObject({ ok: true, width: 360 });
});

test("the current stage image recovers transiently and keeps permanent failures actionable without losing position", async ({ page }) => {
  await seedSettings(page);
  const backend = await installBackend(page, { chapterIds: [1101], pageCount: 1 });
  await gotoApp(page);
  await openFixtureChapter(page);

  await page.locator("#next-panel").click();
  await expect(page.locator("#panel-stat")).toHaveText(/^Panel 2 \/ /);
  const position = await page.evaluate(() => ({
    page: document.querySelector("#page-stat")?.textContent,
    panel: document.querySelector("#panel-stat")?.textContent,
    detectorRuns: window.PanelPilot.getReaderLifecycleDiagnostics().detectorRuns,
  }));
  const initialRequests = backend.imageRequestCount(1101, 1);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");

  backend.failImage(1101, 1, 1);
  await page.locator("#stage-image").evaluate((image) => image.dispatchEvent(new Event("error")));
  await expect.poll(() => backend.imageRequestCount(1101, 1), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(initialRequests + 2);
  await expect(page.locator("#reader-error")).toBeHidden();
  await expect.poll(() => page.evaluate(() => ({
    page: document.querySelector("#page-stat")?.textContent,
    panel: document.querySelector("#panel-stat")?.textContent,
    detectorRuns: window.PanelPilot.getReaderLifecycleDiagnostics().detectorRuns,
  }))).toEqual(position);

  const beforePermanentFailure = backend.imageRequestCount(1101, 1);
  await cdp.send("Network.clearBrowserCache");
  backend.failImage(1101, 1, 20);
  await page.locator("#stage-image").evaluate((image) => image.dispatchEvent(new Event("error")));
  await expect(page.locator("#reader-error")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#reader-error-title")).toHaveText("Could not load this page");
  await expect.poll(() => page.evaluate(() => ({
    page: document.querySelector("#page-stat")?.textContent,
    panel: document.querySelector("#panel-stat")?.textContent,
    detectorRuns: window.PanelPilot.getReaderLifecycleDiagnostics().detectorRuns,
  }))).toEqual(position);
  expect(backend.imageRequestCount(1101, 1)).toBeGreaterThan(beforePermanentFailure);

  backend.failImage(1101, 1, 0);
  await page.locator("#reader-error-retry").click();
  await expect(page.locator("#reader-error")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator("#stage-image")).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    page: document.querySelector("#page-stat")?.textContent,
    panel: document.querySelector("#panel-stat")?.textContent,
    detectorRuns: window.PanelPilot.getReaderLifecycleDiagnostics().detectorRuns,
  }))).toEqual(position);
});

test("stale and cancelled chapter responses cannot replace current reader state", async ({ page }) => {
  await seedSettings(page);
  const backend = await installBackend(page, { pageCount: 2 });
  const releaseStale = backend.holdChapter(1101);
  await gotoApp(page);
  await openChapterList(page);

  await requestChapter(page, 1101);
  await expect.poll(() => backend.payloadRequestCount(1101)).toBe(1);
  await requestChapter(page, 1102);
  await expect.poll(() => backend.payloadRequestCount(1102)).toBe(1);
  await expect(page.locator("#stage-image")).toHaveAttribute("src", /\/1102\//, { timeout: 20_000 });
  releaseStale();
  await page.waitForTimeout(300);
  await expect(page.locator("#stage-image")).toHaveAttribute("src", /\/1102\//);

  const releaseCancelled = backend.holdChapter(1101);
  await requestChapter(page, 1101);
  await expect.poll(() => backend.payloadRequestCount(1101)).toBe(2);
  await expect(page.locator("#reader-loading-cancel")).toBeVisible();
  await page.locator("#reader-loading-cancel").click();
  releaseCancelled();
  await page.waitForTimeout(300);
  await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#reader-error")).toBeHidden();
  await expect(page.locator("#stage-image")).not.toHaveAttribute("src", /\/1101\//);
});

test("pagehide preserves the exact page and panel while BFCache pageshow resumes once", async ({ page }) => {
  await seedSettings(page, { keepScreenAwake: true });
  await installVisibilityShim(page);
  await installWakeLockMock(page);
  await installBackend(page, { chapterIds: [1101], pageCount: 5 });
  await gotoApp(page);
  await openFixtureChapter(page);

  await moveToPage(page, 3);
  await page.locator("#next-panel").click();
  await expect(page.locator("#page-stat")).toHaveText("Page 3 / 5");
  await expect(page.locator("#panel-stat")).toHaveText(/^Panel 2 \/ /);
  const positionBeforeHide = await page.evaluate(() => ({
    page: document.querySelector("#page-stat")?.textContent,
    panel: document.querySelector("#panel-stat")?.textContent,
    detectorRuns: window.PanelPilot.getReaderLifecycleDiagnostics().detectorRuns,
  }));
  const backgroundStartsBeforeHide = await page.evaluate(() => (
    window.PanelPilot.getPerformanceStats().backgroundStarts
  ));

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect.poll(() => page.evaluate(() => {
    const outbox = JSON.parse(localStorage.getItem("panel-pilot-progress-outbox") || "[]");
    return outbox.length;
  })).toBe(1);
  await expect.poll(() => page.evaluate(() => {
    const [item] = JSON.parse(localStorage.getItem("panel-pilot-library") || "[]");
    return item ? { pageIndex: item.pageIndex, panelIndex: item.panelIndex } : null;
  })).toEqual({ pageIndex: 2, panelIndex: 1 });
  await expect.poll(() => page.evaluate(() => window.__readerWakeLock.snapshot().active)).toBe(0);

  const requestsBeforeResume = await page.evaluate(() => window.__readerWakeLock.snapshot().requests);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect.poll(() => page.evaluate(() => window.__readerWakeLock.snapshot().active)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__readerWakeLock.snapshot().requests)).toBe(requestsBeforeResume + 1);
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getPerformanceStats().backgroundStarts))
    .toBe(backgroundStartsBeforeHide + 1);
  await expect.poll(() => page.evaluate(() => ({
    page: document.querySelector("#page-stat")?.textContent,
    panel: document.querySelector("#panel-stat")?.textContent,
    detectorRuns: window.PanelPilot.getReaderLifecycleDiagnostics().detectorRuns,
  }))).toEqual(positionBeforeHide);
});

test("next-chapter prefetch pauses and restarts across hidden and pagehide lifecycle transitions", async ({ page }) => {
  await seedSettings(page);
  await installVisibilityShim(page);
  const backend = await installBackend(page, { chapterIds: [1101, 1102], pageCount: 3 });
  const releaseBackgroundPage = backend.holdImage(1101, 2);
  await gotoApp(page);
  await openFixtureChapter(page, 1101);

  const position = await page.evaluate(() => ({
    page: document.querySelector("#page-stat")?.textContent,
    panel: document.querySelector("#panel-stat")?.textContent,
  }));
  await expect.poll(() => backend.imageRequestCount(1101, 2)).toBe(1);
  await page.evaluate(() => window.__setReaderTestVisibility("hidden"));
  releaseBackgroundPage();
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderLifecycleDiagnostics().prefetchStatus))
    .toBe("idle");
  await page.waitForTimeout(500);
  expect(backend.payloadRequestCount(1102)).toBe(0);

  await page.evaluate(() => window.__setReaderTestVisibility("visible"));
  await expect.poll(() => backend.payloadRequestCount(1102), { timeout: 30_000 }).toBe(1);
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderLifecycleDiagnostics().prefetchStatus), {
    timeout: 30_000,
  }).toBe("ready");

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderLifecycleDiagnostics().prefetchStatus))
    .toBe("idle");
  await page.waitForTimeout(500);
  expect(backend.payloadRequestCount(1102)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect.poll(() => backend.payloadRequestCount(1102), { timeout: 30_000 }).toBe(2);
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderLifecycleDiagnostics().prefetchStatus), {
    timeout: 30_000,
  }).toBe("ready");
  await expect.poll(() => page.evaluate(() => ({
    page: document.querySelector("#page-stat")?.textContent,
    panel: document.querySelector("#panel-stat")?.textContent,
  }))).toEqual(position);
});

test("reader memory stays capped and revisiting a prepared page does not rerun detection", async ({ page }) => {
  await seedSettings(page);
  await installBackend(page, { chapterIds: [1101], pageCount: 10 });
  await gotoApp(page);
  await openFixtureChapter(page);

  await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.getReaderLifecycleDiagnostics)).toBe("function");
  for (let targetPage = 2; targetPage <= 8; targetPage += 1) {
    await moveToPage(page, targetPage, 1);
  }

  await page.evaluate(() => window.PanelPilot.trimReaderMemory({ aggressive: true }));
  const trimmed = await page.evaluate(() => window.PanelPilot.getReaderLifecycleDiagnostics());
  expect(trimmed.residentDecodedImages).toBeLessThanOrEqual(trimmed.decodedImageCap);
  const detectorRunsBefore = trimmed.detectorRuns;

  for (let targetPage = 7; targetPage >= 1; targetPage -= 1) {
    await moveToPage(page, targetPage, -1);
  }
  const revisited = await page.evaluate(() => window.PanelPilot.getReaderLifecycleDiagnostics());
  expect(revisited.detectorRuns).toBe(detectorRunsBefore);
  expect(revisited.residentDecodedImages).toBeLessThanOrEqual(revisited.decodedImageCap);
});

test("a long webtoon caps decoded images and live DOM nodes while its render window advances", async ({ page }) => {
  const pageCount = 14;
  await seedSettings(page, { panelMode: "webtoon" });
  await installBackend(page, { chapterIds: [1101], pageCount, webtoon: true });
  await gotoApp(page);
  await openFixtureChapter(page);

  await expect.poll(() => page.evaluate(() => ({
    nextSourceIndex: window.PanelPilot.getPerformanceStats().webtoonPreparation?.nextSourceIndex,
    backgroundPreparing: window.PanelPilot.getReaderLifecycleDiagnostics().backgroundPreparing,
  })), { timeout: 30_000 }).toEqual({ nextSourceIndex: pageCount, backgroundPreparing: false });
  await expect(page.locator("body")).toHaveClass(/\bwebtoon-scroll\b/);
  await expect(page.locator("#panel-stat")).toHaveText("Continuous scroll");
  await expect(page.locator("#toggle-fit")).toHaveText("Guided taps");

  const initial = await page.evaluate(() => {
    const diagnostics = window.PanelPilot.getReaderLifecycleDiagnostics();
    const strip = document.querySelector(".stage-strip");
    return {
      decoded: diagnostics.residentDecodedImages,
      decodedCap: diagnostics.decodedImageCap,
      liveNodes: diagnostics.liveWebtoonImageNodes,
      liveCap: diagnostics.liveWebtoonImageCap,
      images: strip?.querySelectorAll("img[data-segment-index]").length || 0,
      placeholders: strip?.querySelectorAll("[data-segment-placeholder]").length || 0,
      children: strip?.children.length || 0,
    };
  });
  expect(initial.decoded).toBeLessThanOrEqual(initial.decodedCap);
  expect(initial.liveNodes).toBeLessThanOrEqual(initial.liveCap);
  expect(initial.images).toBe(initial.liveNodes);
  expect(initial.children).toBe(pageCount);
  expect(initial.images + initial.placeholders).toBe(pageCount);

  await page.locator("#stage-image-wrap").evaluate((wrap) => {
    wrap.scrollTop = wrap.scrollHeight * 0.82;
    wrap.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(async () => {
    const indexes = await page.locator(".stage-strip img[data-segment-index]").evaluateAll((images) => (
      images.map((image) => Number(image.dataset.segmentIndex))
    ));
    return Math.max(...indexes) >= 10;
  }, { timeout: 20_000, intervals: [20, 30, 50] }).toBe(true);

  const advanced = await page.evaluate(() => {
    const diagnostics = window.PanelPilot.getReaderLifecycleDiagnostics();
    const strip = document.querySelector(".stage-strip");
    const liveIndexes = [...strip.querySelectorAll("img[data-segment-index]")]
      .map((image) => Number(image.dataset.segmentIndex));
    return {
      decoded: diagnostics.residentDecodedImages,
      decodedCap: diagnostics.decodedImageCap,
      liveNodes: diagnostics.liveWebtoonImageNodes,
      liveCap: diagnostics.liveWebtoonImageCap,
      minLiveIndex: Math.min(...liveIndexes),
      maxLiveIndex: Math.max(...liveIndexes),
      children: strip.children.length,
    };
  });
  expect(advanced.decoded).toBeLessThanOrEqual(advanced.decodedCap);
  expect(advanced.liveNodes).toBeLessThanOrEqual(advanced.liveCap);
  expect(advanced.minLiveIndex).toBeGreaterThan(0);
  expect(advanced.maxLiveIndex).toBeGreaterThanOrEqual(10);
  expect(advanced.children).toBe(pageCount);

  const stage = await page.locator("#stage").boundingBox();
  await page.locator("#stage").click({
    position: {
      x: Math.round((stage?.width || 820) / 2),
      y: Math.round((stage?.height || 1180) / 2),
    },
  });
  await page.locator(".reader-options > summary").click();
  await page.locator("#toggle-fit").click();
  await expect(page.locator("body")).not.toHaveClass(/\bwebtoon-scroll\b/);
  await expect(page.locator("#toggle-fit")).toHaveText("Continuous scroll");
  await expect(page.locator("#panel-stat")).toHaveText(/^Panel \d+ \/ \d+$/);
  const panelBefore = await page.locator("#panel-stat").textContent();
  await page.locator("#next-panel").click();
  await expect(page.locator("#panel-stat")).not.toHaveText(panelBefore || "");
});

test("continuous webtoon scrolling opens the next chapter at the bottom", async ({ page }) => {
  await seedSettings(page, { panelMode: "webtoon" });
  await installBackend(page, { chapterIds: [1101, 1102], pageCount: 3, webtoon: true });
  await gotoApp(page);
  await openFixtureChapter(page, 1101);

  await expect.poll(() => page.evaluate(() => ({
    nextSourceIndex: window.PanelPilot.getPerformanceStats().webtoonPreparation?.nextSourceIndex,
    backgroundPreparing: window.PanelPilot.getReaderLifecycleDiagnostics().backgroundPreparing,
  })), { timeout: 30_000 }).toEqual({ nextSourceIndex: 3, backgroundPreparing: false });

  await page.locator("#stage-image-wrap").dispatchEvent("pointerdown", { pointerType: "touch" });
  await page.locator("#stage-image-wrap").evaluate((wrap) => {
    wrap.scrollTop = wrap.scrollHeight;
    wrap.dispatchEvent(new Event("scroll"));
  });

  await expect(page.locator("#chapter-title")).toHaveText("Resilience chapter 1102", { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (
    document.querySelector(".stage-strip img")?.getAttribute("src") || ""
  ))).toContain("/1102/");
  await expect(page.locator("body")).toHaveClass(/\bwebtoon-scroll\b/);
  await expect(page.locator("#panel-stat")).toHaveText("Continuous scroll");
});

test("a failed webtoon segment recovers without escaping strip bounds", async ({ page }) => {
  await seedSettings(page, { panelMode: "webtoon" });
  const backend = await installBackend(page, { chapterIds: [1101], pageCount: 4, webtoon: true });
  backend.failImage(1101, 3, 2);
  await gotoApp(page);
  await openFixtureChapter(page);

  await expect.poll(async () => {
    const diagnostics = await page.evaluate(() => window.PanelPilot?.getReaderLifecycleDiagnostics?.());
    return diagnostics?.webtoonFailedIndex;
  }, { timeout: 15_000 }).toBe(2);

  for (let attempt = 0; attempt < 30 && await page.locator("#reader-error").isHidden(); attempt += 1) {
    await page.locator("#next-panel").click();
  }
  await expect(page.locator("#reader-error")).toBeVisible();
  await page.locator("#reader-error-retry").click();
  await expect.poll(() => backend.imageRequestCount(1101, 3), { timeout: 15_000 }).toBeGreaterThan(2);
  await expect.poll(() => page.locator(".stage-strip img").count(), { timeout: 15_000 }).toBe(4);

  const bounds = await page.locator(".stage-strip").evaluate((strip) => {
    const stripRect = strip.getBoundingClientRect();
    return [...strip.querySelectorAll("img")].every((image) => {
      const rect = image.getBoundingClientRect();
      return rect.left >= stripRect.left - 1
        && rect.right <= stripRect.right + 1
        && rect.top >= stripRect.top - 1
        && rect.bottom <= stripRect.bottom + 1;
    });
  });
  expect(bounds).toBe(true);
});

test("reader layout respects visual viewport changes without horizontal overflow", async ({ page }) => {
  await seedSettings(page);
  await installBackend(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoApp(page);
  await openDemo(page);

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 507, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      window.visualViewport?.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("orientationchange"));
    });
    await expect.poll(() => page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.visualViewport?.width || window.innerWidth,
      reader: (() => {
        const rect = document.querySelector("#reader-view").getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      })(),
    }))).toMatchObject({
      documentWidth: viewport.width,
      bodyWidth: viewport.width,
      viewportWidth: viewport.width,
      reader: { left: 0, right: viewport.width },
    });
  }
});

test("the first viewport fit is not suppressed during a fast reader startup", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => 100,
    });
  });
  await seedSettings(page);
  await installBackend(page, { chapterIds: [1101], pageCount: 2 });
  await gotoApp(page);
  await openFixtureChapter(page);

  await expect.poll(() => page.evaluate(() => window.PanelPilot.getPerformanceStats().viewportFits)).toBe(1);
});

test("rotation preserves page and panel, coalesces one refit, and does not rerun detection", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await seedSettings(page);
  await installBackend(page, { chapterIds: [1101], pageCount: 4 });
  await gotoApp(page);
  await openFixtureChapter(page);
  const stageBox = await page.locator("#stage").boundingBox();
  await page.locator("#stage").click({
    position: { x: Math.round((stageBox?.width || 820) / 2), y: Math.round((stageBox?.height || 1180) / 2) },
  });
  await expect(page.locator("#next-panel")).toBeVisible();
  await moveToPage(page, 3);
  await page.locator("#next-panel").click();
  await expect(page.locator("#panel-stat")).toHaveText(/^Panel 2 \/ /);
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderLifecycleDiagnostics().metadataPages)).toBe(4);
  await page.waitForTimeout(250);

  const before = await page.evaluate(() => ({
    page: document.querySelector("#page-stat")?.textContent,
    panel: document.querySelector("#panel-stat")?.textContent,
    detectorRuns: window.PanelPilot.getReaderLifecycleDiagnostics().detectorRuns,
    cameraFits: window.PanelPilot.getPerformanceStats().cameraFits,
    viewportFits: window.PanelPilot.getPerformanceStats().viewportFits,
    transform: document.querySelector("#stage-image")?.style.transform,
  }));

  await page.setViewportSize({ width: 1180, height: 820 });
  await page.evaluate(() => {
    window.visualViewport?.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("orientationchange"));
  });
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getPerformanceStats().viewportFits)).toBe(before.viewportFits + 1);
  await page.waitForTimeout(250);

  const after = await page.evaluate(() => ({
    page: document.querySelector("#page-stat")?.textContent,
    panel: document.querySelector("#panel-stat")?.textContent,
    detectorRuns: window.PanelPilot.getReaderLifecycleDiagnostics().detectorRuns,
    cameraFits: window.PanelPilot.getPerformanceStats().cameraFits,
    viewportFits: window.PanelPilot.getPerformanceStats().viewportFits,
    transform: document.querySelector("#stage-image")?.style.transform,
  }));
  expect(after.page).toBe(before.page);
  expect(after.panel).toBe(before.panel);
  expect(after.detectorRuns).toBe(before.detectorRuns);
  expect(after.viewportFits).toBe(before.viewportFits + 1);
  expect(after.cameraFits).toBeGreaterThan(before.cameraFits);
  expect(after.transform).not.toBe(before.transform);

  await page.setViewportSize({ width: 820, height: 1180 });
  await page.evaluate(() => {
    window.visualViewport?.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("orientationchange"));
  });
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getPerformanceStats().viewportFits))
    .toBe(before.viewportFits + 2);
  await expect.poll(() => page.evaluate(() => ({
    page: document.querySelector("#page-stat")?.textContent,
    panel: document.querySelector("#panel-stat")?.textContent,
    detectorRuns: window.PanelPilot.getReaderLifecycleDiagnostics().detectorRuns,
  }))).toEqual({
    page: before.page,
    panel: before.panel,
    detectorRuns: before.detectorRuns,
  });
});

test("the built shell keeps safe-area, no-collision, and non-composited header invariants across supported widths", async ({ page }) => {
  await seedSettings(page);
  await installBackend(page);
  await gotoApp(page);

  const contract = await page.evaluate(async () => {
    const rules = [];
    const collectRules = (ruleList) => {
      for (const rule of ruleList) {
        if (rule.selectorText) rules.push({ selector: rule.selectorText, cssText: rule.style.cssText });
        else if (rule.cssRules) collectRules(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) collectRules(sheet.cssRules);
    const declarationsFor = (selector) => rules
      .filter((rule) => rule.selector.split(",").map((item) => item.trim()).includes(selector))
      .map((rule) => rule.cssText)
      .join(" ");
    const header = document.querySelector("#library-view .view-header");
    const activeView = document.querySelector("#library-view");
    document.documentElement.style.setProperty("--app-nav-bottom-inset", "31px");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const navigation = document.querySelector(".app-nav").getBoundingClientRect();
    return {
      viewport: document.querySelector('meta[name="viewport"]')?.content || "",
      root: declarationsFor(":root"),
      viewHeader: declarationsFor(".view-header"),
      readerTopbar: declarationsFor(".reader-topbar"),
      readerControls: declarationsFor(".reader-controls"),
      appNav: declarationsFor(".app-nav"),
      computed: {
        activeViewAnimation: getComputedStyle(activeView).animationName,
        activeViewTransform: getComputedStyle(activeView).transform,
        headerFilter: getComputedStyle(header).filter,
        headerBackdrop: getComputedStyle(header).backdropFilter,
        navigationBottom: Math.round(innerHeight - navigation.bottom),
      },
    };
  });

  expect(contract.viewport).toContain("viewport-fit=cover");
  expect(contract.root).toMatch(/--app-nav-bottom-inset:\s*max\([^;]*safe-area-inset-bottom/i);
  expect(contract.viewHeader).toMatch(/safe-area-inset-(?:top|left|right)/i);
  expect(contract.readerTopbar).toMatch(/safe-area-inset-(?:top|left|right)/i);
  expect(contract.readerControls).toMatch(/safe-area-inset-(?:bottom|left|right)/i);
  expect(contract.appNav).toMatch(/safe-area-inset-left/i);
  expect(contract.appNav).toMatch(/safe-area-inset-right/i);
  expect(contract.appNav).toMatch(/bottom:\s*var\(--app-nav-bottom-inset\)/i);
  expect(contract.computed).toEqual({
    activeViewAnimation: "none",
    activeViewTransform: "none",
    headerFilter: "none",
    headerBackdrop: "none",
    navigationBottom: 31,
  });

  for (const viewport of [
    { width: 320, height: 720 },
    { width: 390, height: 844 },
    { width: 507, height: 768 },
    { width: 820, height: 1180 },
  ]) {
    await page.setViewportSize(viewport);
    await openDemo(page);
    const readerLayout = await page.evaluate(() => {
      document.body.classList.remove("reader-chrome-hidden");
      const rect = (selector) => {
        const bounds = document.querySelector(selector).getBoundingClientRect();
        return {
          top: Math.round(bounds.top),
          right: Math.round(bounds.right),
          bottom: Math.round(bounds.bottom),
          left: Math.round(bounds.left),
        };
      };
      return {
        documentWidth: document.documentElement.scrollWidth,
        reader: rect("#reader-view"),
        topbar: rect(".reader-topbar"),
        controls: rect(".reader-controls"),
      };
    });
    expect(readerLayout.documentWidth).toBeLessThanOrEqual(viewport.width);
    expect(readerLayout.reader).toMatchObject({ left: 0, right: viewport.width });
    expect(readerLayout.topbar.left).toBeGreaterThanOrEqual(0);
    expect(readerLayout.topbar.right).toBeLessThanOrEqual(viewport.width);
    expect(readerLayout.topbar.top).toBeGreaterThanOrEqual(0);
    expect(readerLayout.controls.left).toBeGreaterThanOrEqual(0);
    expect(readerLayout.controls.right).toBeLessThanOrEqual(viewport.width);
    expect(readerLayout.controls.bottom).toBeLessThanOrEqual(viewport.height);
    expect(readerLayout.topbar.bottom).toBeLessThan(readerLayout.controls.top);

    await page.locator("#reader-back").click();
    await expect(page.locator("#settings-view")).toHaveClass(/\bactive\b/);
    const shellLayout = await page.evaluate(async () => {
      document.body.classList.add("has-reading-miniplayer", "has-download-status");
      document.querySelector("#nav-reader").hidden = false;
      document.querySelector("#download-status-button").hidden = false;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = (selector) => {
        const bounds = document.querySelector(selector).getBoundingClientRect();
        return {
          top: Math.round(bounds.top),
          right: Math.round(bounds.right),
          bottom: Math.round(bounds.bottom),
          left: Math.round(bounds.left),
        };
      };
      const navigation = rect(".app-nav");
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportHeight: innerHeight,
        bodyPaddingBottom: Number.parseFloat(getComputedStyle(document.body).paddingBottom),
        navigation,
        miniplayer: rect("#nav-reader"),
        downloads: rect("#download-status-button"),
      };
    });
    expect(shellLayout.documentWidth).toBeLessThanOrEqual(viewport.width);
    expect(shellLayout.viewportHeight - shellLayout.navigation.bottom).toBe(31);
    expect(shellLayout.navigation.left).toBeGreaterThanOrEqual(0);
    expect(shellLayout.navigation.right).toBeLessThanOrEqual(viewport.width);
    expect(shellLayout.miniplayer.left).toBeGreaterThanOrEqual(0);
    expect(shellLayout.miniplayer.right).toBeLessThanOrEqual(viewport.width);
    expect(shellLayout.miniplayer.bottom).toBeLessThanOrEqual(shellLayout.navigation.top);
    expect(shellLayout.downloads.left).toBeGreaterThanOrEqual(0);
    expect(shellLayout.downloads.right).toBeLessThanOrEqual(viewport.width);
    expect(shellLayout.downloads.bottom).toBeLessThanOrEqual(shellLayout.miniplayer.top);
    expect(shellLayout.bodyPaddingBottom).toBeGreaterThanOrEqual(
      shellLayout.viewportHeight - shellLayout.downloads.top,
    );
  }
});

test("iPad full-page reading advances whole pages and returns to panel navigation", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.addInitScript(() => {
    window.__readerFullscreenRequests = 0;
    window.__readerFullscreenExits = 0;
    window.__mockFullscreenElement = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => window.__mockFullscreenElement,
    });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value() {
        window.__readerFullscreenRequests += 1;
        window.__mockFullscreenElement = this;
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      },
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value() {
        window.__readerFullscreenExits += 1;
        window.__mockFullscreenElement = null;
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      },
    });
  });
  await seedSettings(page);
  await installBackend(page, { chapterIds: [1101], pageCount: 3 });
  await gotoApp(page);
  await openFixtureChapter(page);

  await expect(page.locator("#page-stat")).toHaveText(/^Page 1 \/ 3$/);
  await expect(page.locator("#panel-stat")).toHaveText(/^Panel 1 \/ [2-9]\d*$/);

  const stageBox = await page.locator("#stage").boundingBox();
  await page.locator("#stage").click({
    position: { x: Math.round((stageBox?.width || 820) / 2), y: Math.round((stageBox?.height || 1180) / 2) },
  });
  await expect(page.locator(".reader-options > summary")).toBeVisible();
  await page.locator(".reader-options > summary").click();
  const toggle = page.locator("#toggle-fit");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveText("Full page");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await toggle.click();
  await expect(toggle).toHaveText("Panel view");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#panel-stat")).toHaveText("Full page");
  await expect(page.locator("body")).toHaveClass(/\breader-full-page\b/);
  await expect.poll(() => page.evaluate(() => ({
    requests: window.__readerFullscreenRequests,
    fullscreenReader: document.fullscreenElement === document.querySelector("#reader-view"),
  }))).toEqual({ requests: 1, fullscreenReader: true });

  const presentation = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const stage = document.querySelector("#stage").getBoundingClientRect();
    const readerStyle = getComputedStyle(document.querySelector("#reader-view"));
    const image = document.querySelector("#stage-image");
    const imageStyle = getComputedStyle(image);
    const transform = new DOMMatrix(imageStyle.transform);
    const expectedScale = Math.min(
      stage.width / Number.parseFloat(image.style.width),
      stage.height / Number.parseFloat(image.style.height),
    );
    return {
      stage: {
        top: Math.round(stage.top),
        right: Math.round(stage.right),
        bottom: Math.round(stage.bottom),
        left: Math.round(stage.left),
      },
      borderWidth: readerStyle.borderWidth,
      borderRadius: readerStyle.borderRadius,
      imageShadow: imageStyle.boxShadow,
      scaleDelta: Math.abs(transform.a - expectedScale),
      chromeHidden: document.body.classList.contains("reader-chrome-hidden"),
    };
  });
  expect(presentation.stage).toEqual({ top: 0, right: 820, bottom: 1180, left: 0 });
  expect(presentation.borderWidth).toBe("0px");
  expect(presentation.borderRadius).toBe("0px");
  expect(presentation.imageShadow).toBe("none");
  expect(presentation.scaleDelta).toBeLessThan(0.001);
  expect(presentation.chromeHidden).toBe(true);

  const fullPageStage = await page.locator("#stage").boundingBox();
  await page.locator("#stage").click({
    position: { x: 40, y: Math.round((fullPageStage?.height || 1180) / 2) },
  });
  await expect(page.locator("#page-stat")).toHaveText(/^Page 2 \/ 3$/);
  await expect(page.locator("#panel-stat")).toHaveText("Full page");
  await expect(toggle).toHaveText("Panel view");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await page.locator("#stage").click({
    position: {
      x: Math.round((fullPageStage?.width || 820) / 2),
      y: Math.round((fullPageStage?.height || 1180) / 2),
    },
  });
  await expect(page.locator(".reader-options > summary")).toBeVisible();
  await page.locator(".reader-options > summary").click();
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveText("Full page");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#panel-stat")).toHaveText(/^Panel 1 \/ [2-9]\d*$/);
  await expect(page.locator("body")).not.toHaveClass(/\breader-full-page\b/);
  await expect.poll(() => page.evaluate(() => ({
    exits: window.__readerFullscreenExits,
    fullscreenElement: document.fullscreenElement,
  }))).toEqual({ exits: 1, fullscreenElement: null });

  await page.locator("#next-panel").click();
  await expect(page.locator("#page-stat")).toHaveText(/^Page 2 \/ 3$/);
  await expect(page.locator("#panel-stat")).toHaveText(/^Panel 2 \/ [2-9]\d*$/);
});

test("loading progress, modal focus, and the Next action remain accessible", async ({ page }) => {
  await seedSettings(page);
  await installBackend(page, { chapterIds: [1101], pageCount: 1 });
  await gotoApp(page);

  const progress = page.locator("#reader-loading-progress");
  await expect(progress).toHaveAttribute("role", "progressbar");
  await expect(progress).toHaveAttribute("aria-labelledby", "reader-loading-text");
  await expect(progress).toHaveAttribute("aria-valuemin", "0");
  await expect(progress).toHaveAttribute("aria-valuemax", "100");
  await expect(progress).toHaveAttribute("aria-valuenow", /^\d+$/);

  await openDemo(page);
  const next = page.locator("#next-panel");
  await expect(next).toBeVisible();
  await expect(next).toHaveAccessibleName(/^Next panel/);
  const box = await next.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  const panelBefore = await page.locator("#panel-stat").textContent();
  await next.focus();
  await expect(next).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#panel-stat")).not.toHaveText(panelBefore || "");

  await page.locator("#reader-back").click({ force: true });
  await expect(page.locator("#settings-view")).toHaveClass(/\bactive\b/);
  await openFixtureChapter(page);
  await requestChapter(page, 9999);
  await expect(page.locator("#reader-error")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#reader-error-retry")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#reader-error-back")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#reader-error-retry")).toBeFocused();
});

test("reader overlays own focus, isolate siblings, and switch without competing modals", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedSettings(page, {}, { tapHintSeen: false });
  const backend = await installBackend(page, { chapterIds: [1101], pageCount: 1 });
  const releaseCancelledLoad = backend.holdChapter(1101);
  await gotoApp(page);
  await openChapterList(page);

  const read = page.locator('[data-chapter-id="1101"] [data-chapter-action="read"]');
  await read.focus();
  await read.click();
  await expect.poll(() => backend.payloadRequestCount(1101)).toBe(1);
  await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "false");
  await expectExclusiveReaderOverlay(page, "#reader-loading");
  await expect(page.locator("#reader-loading-cancel")).toBeFocused();
  await page.locator("#reader-back").evaluate((button) => button.focus());
  await expect(page.locator("#reader-loading-cancel")).toBeFocused();

  await page.locator("#reader-loading-cancel").click();
  await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "true");
  await expectReaderIsolationCleared(page);
  await expect(page.locator("#manga-detail")).toBeVisible();
  await expect(read).toBeFocused();
  releaseCancelledLoad();

  const releaseSuccessfulLoad = backend.holdChapter(1101);
  await read.click();
  await expect.poll(() => backend.payloadRequestCount(1101)).toBe(2);
  await expectExclusiveReaderOverlay(page, "#reader-loading");
  releaseSuccessfulLoad();

  await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "true", { timeout: 20_000 });
  await expect(page.locator("#reader-tap-hint")).toBeVisible({ timeout: 5_000 });
  await expectExclusiveReaderOverlay(page, "#reader-tap-hint");
  await expect(page.locator("#reader-tap-hint-close")).toBeFocused();
  await expect(page.locator("#reader-error")).toBeHidden();
  await expect(page.locator("#reader-complete")).toBeHidden();

  await page.locator("#reader-tap-hint-close").click();
  await expect(page.locator("#reader-tap-hint")).toBeHidden();
  await expectReaderIsolationCleared(page);
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement;
    return !active?.closest?.("[hidden], [inert]");
  })).toBe(true);

  for (let attempt = 0; attempt < 8 && await page.locator("#reader-complete").isHidden(); attempt += 1) {
    await page.locator("#next-panel").click();
  }
  await expect(page.locator("#reader-complete")).toBeVisible();
  await expectExclusiveReaderOverlay(page, "#reader-complete");
  await expect(page.locator("#reader-complete-chapters")).toBeFocused();
  await expect(page.locator("#reader-error")).toBeHidden();
  await expect(page.locator("#reader-tap-hint")).toBeHidden();

  const releaseInvalidLoad = backend.holdChapter(9999);
  await requestChapter(page, 9999);
  await expect.poll(() => backend.payloadRequestCount(9999)).toBe(1);
  await expectExclusiveReaderOverlay(page, "#reader-loading");
  await expect(page.locator("#reader-complete")).toBeHidden();
  releaseInvalidLoad();

  await expect(page.locator("#reader-error")).toBeVisible({ timeout: 10_000 });
  await expectExclusiveReaderOverlay(page, "#reader-error");
  await expect(page.locator("#reader-error-retry")).toBeFocused();
  await expect(page.locator("#reader-complete")).toBeHidden();
  await expect(page.locator("#reader-tap-hint")).toBeHidden();

  await page.evaluate(() => {
    const input = document.querySelector("#chapter-id");
    input.value = "1101";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const releaseRetryLoad = backend.holdChapter(1101);
  await page.locator("#reader-error-retry").click();
  await expect.poll(() => backend.payloadRequestCount(1101)).toBe(3);
  await expectExclusiveReaderOverlay(page, "#reader-loading");
  await expect(page.locator("#reader-error")).toBeHidden();
  releaseRetryLoad();
  await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "true", { timeout: 20_000 });
  await expect(page.locator("#reader-error")).toBeHidden();
  await expectReaderIsolationCleared(page);
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement;
    return !active?.closest?.("[hidden], [inert]");
  })).toBe(true);
});
