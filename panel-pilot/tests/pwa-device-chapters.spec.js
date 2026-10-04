import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(projectRoot, "dist");
const manga = {
  mangaId: 501,
  mangaTitle: "Device Chapter Fixture",
  sourceId: 12,
  sourceLabel: "Fixture source",
  libraryStatus: "reading",
  statusExplicit: true,
  started: true,
  hidden: false,
  pinned: false,
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const chapters = [
  {
    id: 1101,
    name: "Device chapter one",
    mangaId: manga.mangaId,
    scanlator: "Fixture group",
    sourceOrder: 1,
    chapterNumber: 1,
    pageCount: 3,
    isRead: false,
    lastPageRead: 0,
    isDownloaded: false,
    isBookmarked: false,
  },
  {
    id: 1102,
    name: "Device chapter two",
    mangaId: manga.mangaId,
    scanlator: "Fixture group",
    sourceOrder: 2,
    chapterNumber: 2,
    pageCount: 3,
    isRead: false,
    lastPageRead: 0,
    isDownloaded: false,
    isBookmarked: false,
  },
];
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};
const phaseThreeWorker = `
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
`;
const incapableUpdateWorker = `
  self.addEventListener("message", (event) => {
    if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  });
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
`;

function imagePath(chapterId, pageNumber) {
  return `/api/image/device-chapters/${chapterId}/${pageNumber}.svg`;
}

function fixturePages(chapterId) {
  return [1, 2, 3].map((pageNumber) => imagePath(chapterId, pageNumber));
}

function fixtureImage(chapterId, pageNumber) {
  const hue = (Number(chapterId) + pageNumber * 47) % 360;
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="360" height="540" viewBox="0 0 360 540">
      <rect width="360" height="540" fill="hsl(${hue} 32% 93%)"/>
      <rect x="18" y="18" width="324" height="504" rx="8" fill="white" stroke="#202522" stroke-width="8"/>
    </svg>
  `);
}

function fixtureMultiPanelImage(chapterId, pageNumber) {
  const hue = (Number(chapterId) + pageNumber * 47) % 360;
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="360" height="540" viewBox="0 0 360 540">
      <rect width="360" height="540" fill="white"/>
      <g fill="hsl(${hue} 32% 93%)" stroke="#202522" stroke-width="7">
        <rect x="12" y="12" width="158" height="246"/>
        <rect x="190" y="12" width="158" height="246"/>
        <rect x="12" y="282" width="158" height="246"/>
        <rect x="190" y="282" width="158" height="246"/>
      </g>
    </svg>
  `);
}

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function startDeviceChapterFixture({
  phaseThreeController = false,
  incapableUpdate = false,
  mangaBakaConnected = false,
} = {}) {
  const missingImages = new Set();
  const nonImageResponses = new Set();
  const emptyImageResponses = new Set();
  const multiPanelImages = new Set();
  const heldImages = new Set();
  const pendingImages = new Map();
  const imageRequests = new Map();
  const syntheticRequests = new Map();
  const failedChapterPayloads = new Set();
  const chapterPayloadRequests = new Map();
  const failedProgressBases = new Set();
  const progressAttempts = [];
  const chapterListRequests = new Map();
  const progressMutations = [];
  const mangaBakaMutations = [];
  let libraryItems = [{ ...manga }];
  let libraryResumeRevision = 0;
  let serveUpdatedWorker = false;
  let failChapterListQueries = false;

  function sendImage(response, chapterId, pageNumber) {
    const body = multiPanelImages.has(imagePath(chapterId, pageNumber))
      ? fixtureMultiPanelImage(chapterId, pageNumber)
      : fixtureImage(chapterId, pageNumber);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": body.length,
      "Content-Type": "image/svg+xml; charset=utf-8",
    });
    response.end(body);
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");

    if (url.pathname === "/__switch-device-worker" && request.method === "POST") {
      serveUpdatedWorker = true;
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === "/sw.js" && phaseThreeController && !serveUpdatedWorker) {
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Service-Worker-Allowed": "/",
      });
      response.end(phaseThreeWorker);
      return;
    }

    if (url.pathname === "/sw.js" && incapableUpdate && serveUpdatedWorker) {
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Service-Worker-Allowed": "/",
      });
      response.end(incapableUpdateWorker);
      return;
    }

    if (url.pathname.startsWith("/__panels_device_chapters/v1/")) {
      syntheticRequests.set(url.pathname, (syntheticRequests.get(url.pathname) || 0) + 1);
    }

    if (url.pathname.startsWith("/api/")) {
      const authenticated = /(?:^|;\s*)panel_pilot_session=device-chapter-fixture(?:;|$)/.test(
        request.headers.cookie || "",
      );
      if (!authenticated) {
        response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Fixture session required", login: "/login" }));
        return;
      }
    }

    const imageMatch = url.pathname.match(/^\/api\/image\/device-chapters\/(\d+)\/(\d+)\.svg$/);
    if (imageMatch) {
      const chapterId = Number(imageMatch[1]);
      const pageNumber = Number(imageMatch[2]);
      imageRequests.set(url.pathname, (imageRequests.get(url.pathname) || 0) + 1);
      if (missingImages.has(url.pathname)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Fixture page intentionally missing");
        return;
      }
      if (nonImageResponses.has(url.pathname)) {
        const body = Buffer.from("Fixture page is not an image");
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Length": body.length,
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end(body);
        return;
      }
      if (emptyImageResponses.has(url.pathname)) {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Length": 0,
          "Content-Type": "image/svg+xml; charset=utf-8",
        });
        response.end();
        return;
      }
      if (heldImages.has(url.pathname)) {
        if (!pendingImages.has(url.pathname)) pendingImages.set(url.pathname, new Set());
        pendingImages.get(url.pathname).add(response);
        response.once("close", () => pendingImages.get(url.pathname)?.delete(response));
        return;
      }
      sendImage(response, chapterId, pageNumber);
      return;
    }

    if (url.pathname === "/api/suwayomi/graphql") {
      const payload = await readJsonRequest(request);
      const query = String(payload.query || "");
      const variables = payload.variables || {};
      const serverBase = url.searchParams.get("base") || "";
      let data;
      if (query.includes("GET_MANGA_CHAPTERS_FETCH")) {
        chapterListRequests.set("fetch", (chapterListRequests.get("fetch") || 0) + 1);
        if (failChapterListQueries) {
          response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "Fixture live chapter-list failure" }));
          return;
        }
        data = { fetchChapters: { chapters } };
      } else if (query.includes("GET_STORED_CHAPTERS")) {
        chapterListRequests.set("stored", (chapterListRequests.get("stored") || 0) + 1);
        if (failChapterListQueries) {
          response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "Fixture stored chapter-list failure" }));
          return;
        }
        data = { chapters: { nodes: chapters } };
      } else if (query.includes("GET_CHAPTER_PAGES_FETCH")) {
        const chapterId = Number(variables.input?.chapterId);
        chapterPayloadRequests.set(chapterId, (chapterPayloadRequests.get(chapterId) || 0) + 1);
        if (failedChapterPayloads.has(chapterId)) {
          response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "Fixture Suwayomi chapter failure" }));
          return;
        }
        const chapter = chapters.find((item) => item.id === chapterId);
        data = {
          fetchChapterPages: {
            chapter: chapter ? {
              ...chapter,
              manga: { source: { name: "fixture", displayName: manga.sourceLabel, lang: "en" } },
            } : null,
            pages: chapter ? fixturePages(chapterId) : [],
          },
        };
      } else if (query.includes("UPDATE_CHAPTER_PROGRESS")) {
        progressAttempts.push({
          ...structuredClone(variables),
          serverBase,
        });
        if (failedProgressBases.has(serverBase)) {
          response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "Fixture progress server failure" }));
          return;
        }
        progressMutations.push({
          ...structuredClone(variables),
          serverBase,
        });
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
        data = { updateManga: { manga: { id: manga.mangaId, inLibrary: true } } };
      } else if (query.includes("HEALTH")) {
        data = { __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" } } };
      } else if (query.includes("GET_SOURCES_LIST")) {
        data = { sources: { nodes: [] } };
      } else {
        data = {};
      }
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ data }));
      return;
    }

    if (url.pathname === "/api/library") {
      if (request.method === "POST") {
        const payload = await readJsonRequest(request);
        libraryItems = Array.isArray(payload.items) ? payload.items : libraryItems;
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ items: libraryItems }));
      } else {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ items: libraryItems }));
      }
      return;
    }

    if (url.pathname === "/api/download-buffer/status") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ downloaded: 0, queued: 0, failed: 0, windowSize: 0, chapters: [] }));
      return;
    }

    if (url.pathname === "/api/mangabaka/status") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(mangaBakaConnected ? {
        configured: true,
        connected: true,
        profile: { id: "fixture-mangabaka-account" },
        recommendations: { ready: true },
      } : { configured: false, connected: false }));
      return;
    }

    if (url.pathname === "/api/mangabaka/library" && request.method === "POST") {
      mangaBakaMutations.push(await readJsonRequest(request));
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ updated: true }));
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
        holdImage(chapterId, pageNumber) {
          heldImages.add(imagePath(chapterId, pageNumber));
        },
        releaseImage(chapterId, pageNumber) {
          const path = imagePath(chapterId, pageNumber);
          heldImages.delete(path);
          const responses = [...(pendingImages.get(path) || [])];
          pendingImages.delete(path);
          responses.forEach((pendingResponse) => {
            if (!pendingResponse.destroyed) sendImage(pendingResponse, chapterId, pageNumber);
          });
        },
        markImageMissing(chapterId, pageNumber) {
          missingImages.add(imagePath(chapterId, pageNumber));
        },
        markImageNonImage(chapterId, pageNumber) {
          nonImageResponses.add(imagePath(chapterId, pageNumber));
        },
        markImageEmpty(chapterId, pageNumber) {
          emptyImageResponses.add(imagePath(chapterId, pageNumber));
        },
        markChapterMultiPanel(chapterId) {
          fixturePages(chapterId).forEach((path) => multiPanelImages.add(path));
        },
        imageRequestCount(chapterId, pageNumber) {
          return imageRequests.get(imagePath(chapterId, pageNumber)) || 0;
        },
        failChapterPayload(chapterId) {
          failedChapterPayloads.add(Number(chapterId));
        },
        failProgressForBase(serverBase) {
          failedProgressBases.add(String(serverBase).replace(/\/+$/, ""));
        },
        failChapterLists() {
          failChapterListQueries = true;
        },
        chapterPayloadRequestCount(chapterId) {
          return chapterPayloadRequests.get(Number(chapterId)) || 0;
        },
        chapterListRequestCount(kind = "") {
          if (kind) return chapterListRequests.get(kind) || 0;
          return [...chapterListRequests.values()].reduce((total, count) => total + count, 0);
        },
        setLibraryResume(chapterId, overrides = {}) {
          const chapter = chapters.find((entry) => entry.id === Number(chapterId));
          libraryResumeRevision += 1;
          libraryItems = [{
            ...manga,
            chapterId: Number(chapterId),
            chapterTitle: chapter?.name || `Chapter ${chapterId}`,
            pageIndex: 0,
            panelIndex: 0,
            progressLabel: "Page 1",
            updatedAt: new Date(Date.UTC(2099, 0, 1, 0, 0, libraryResumeRevision)).toISOString(),
            ...structuredClone(overrides),
          }];
        },
        progressAttempts,
        syntheticRequestCount(pathname = "") {
          if (pathname) return syntheticRequests.get(pathname) || 0;
          return [...syntheticRequests.values()].reduce((total, count) => total + count, 0);
        },
        progressMutations,
        mangaBakaMutations,
        librarySnapshot() {
          return structuredClone(libraryItems);
        },
        close() {
          for (const responses of pendingImages.values()) {
            for (const pendingResponse of responses) pendingResponse.destroy();
          }
          pendingImages.clear();
          return new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
        },
      });
    });
  });
}

async function prepareApp(page, context, fixture, { controlled = false } = {}) {
  await context.addCookies([{
    name: "panel_pilot_session",
    value: "device-chapter-fixture",
    url: fixture.origin,
  }]);
  await page.addInitScript(() => {
    localStorage.setItem("panel-pilot-tap-hint-seen", "1");
    localStorage.setItem("panel-pilot-settings", JSON.stringify({ readerMotion: "instant" }));
  });
  await page.goto(`${fixture.origin}/`, { waitUntil: "networkidle" });
  if (!controlled) return;
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(
    () => page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    {
      message: "the initial app page should be claimed by the active service worker",
      timeout: 20_000,
    },
  ).toBe(true);
  await page.reload({ waitUntil: "networkidle" });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

async function openChapterList(page) {
  const row = chapterRow(page, chapters[0].id);
  if (await row.isVisible().catch(() => false)) return;
  await page.locator("#nav-library").click();
  const card = page.locator(".library-card").filter({ hasText: manga.mangaTitle });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Chapters", exact: true }).click();
  await expect(row).toBeVisible();
}

function chapterRow(page, chapterId) {
  return page.locator(`[data-chapter-id="${chapterId}"]`);
}

function chapterAction(page, chapterId, action) {
  return chapterRow(page, chapterId).locator(`[data-device-action="${action}"]`);
}

function deviceStorageRow(page, chapterTitle) {
  return page.locator("[data-device-storage-row]").filter({
    has: page.getByText(chapterTitle, { exact: true }),
  });
}

async function deviceState(page, chapterId) {
  const status = chapterRow(page, chapterId).locator("[data-device-chapter-state]");
  return String(await status.getAttribute("data-device-chapter-state") || await status.textContent() || "")
    .trim()
    .toLowerCase();
}

async function expectDeviceReady(page, chapterId) {
  await expect.poll(() => deviceState(page, chapterId), { timeout: 15_000 }).toMatch(/^(ready|downloaded)$/);
  await expect(chapterAction(page, chapterId, "open")).toBeVisible();
}

async function downloadChapter(page, chapterId) {
  const action = chapterAction(page, chapterId, "download");
  await expect(action).toBeVisible();
  await action.click();
}

async function advanceReaderToNextPage(page) {
  await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "true", { timeout: 10_000 });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (/Page [2-9]/.test(await page.locator("#page-stat").textContent() || "")) return;
    const lastPanel = page.locator("#panel-strip [data-panel-index]").last();
    if (await lastPanel.count()) await lastPanel.evaluate((button) => button.click());
    await page.locator("#next-panel").evaluate((button) => button.click());
    await page.waitForTimeout(150);
  }
  await expect(page.locator("#page-stat")).toContainText(/Page [2-9]/, { timeout: 5_000 });
}

async function advanceReaderUntilChapter(page, chapterTitle) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await page.locator("#chapter-title").textContent() || "").includes(chapterTitle)) return;
    if (await page.locator("#reader-complete").isVisible()) {
      await page.locator("#reader-complete-next").click();
    } else {
      const lastPanel = page.locator("#panel-strip [data-panel-index]").last();
      if (await lastPanel.count()) await lastPanel.evaluate((button) => button.click());
      await page.locator("#next-panel").evaluate((button) => button.click());
    }
    await page.waitForTimeout(150);
  }
  await expect(page.locator("#chapter-title")).toContainText(chapterTitle, { timeout: 5_000 });
}

async function devicePackageIntegrity(page, chapterId) {
  return page.evaluate(async (requestedChapterId) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("panels-device-library", 1);
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const records = await new Promise((resolve, reject) => {
      const transaction = database.transaction("chapters", "readonly");
      const request = transaction.objectStore("chapters").getAll();
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    database.close();
    const record = records.find((entry) => Number(entry.chapterId) === Number(requestedChapterId));
    if (!record) return null;
    const cache = await caches.open("panels-device-chapters-v1");
    const cachedPaths = (await cache.keys())
      .map((request) => new URL(request.url).pathname)
      .filter((path) => path.startsWith(`/__panels_device_chapters/v1/${encodeURIComponent(record.key)}/`));
    return {
      status: record.status,
      totalPages: record.totalPages,
      downloadedPages: record.downloadedPages,
      storedBytes: record.storedBytes,
      cachePaths: record.pages.map((entry) => entry?.cacheUrl || "").filter(Boolean),
      cachedPages: cachedPaths.length,
    };
  }, chapterId);
}

async function seedReadyDeviceChapter(page, chapterId) {
  const chapter = chapters.find((entry) => entry.id === Number(chapterId));
  if (!chapter) throw new Error(`Unknown device chapter fixture ${chapterId}`);
  return page.evaluate(async ({ chapterFixture, mangaFixture, sourceUrls }) => {
    const serverUrl = "http://localhost:4567";
    const key = JSON.stringify([serverUrl, String(chapterFixture.id)]);
    const cache = await caches.open("panels-device-chapters-v1");
    const timestamp = new Date().toISOString();
    const pages = [];

    for (let index = 0; index < sourceUrls.length; index += 1) {
      const sourceUrl = sourceUrls[index];
      const response = await fetch(sourceUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`Could not seed fixture page ${index + 1}`);
      const blob = await response.blob();
      const cacheUrl = `/__panels_device_chapters/v1/${encodeURIComponent(key)}/seed/${index}`;
      const contentType = response.headers.get("content-type") || blob.type || "image/svg+xml";
      await cache.put(
        new Request(new URL(cacheUrl, location.origin)),
        new Response(blob, {
          status: 200,
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Length": String(blob.size),
            "Content-Type": contentType,
          },
        }),
      );
      pages.push({
        index,
        sourceUrl,
        cacheUrl,
        contentType,
        size: blob.size,
        completedAt: timestamp,
      });
    }

    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("panels-device-library", 1);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains("chapters")) {
          request.result.createObjectStore("chapters", { keyPath: "key" });
        }
      });
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const storedBytes = pages.reduce((total, item) => total + item.size, 0);
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("chapters", "readwrite");
      transaction.objectStore("chapters").put({
        key,
        serverUrl,
        chapterId: chapterFixture.id,
        mangaId: mangaFixture.mangaId,
        title: mangaFixture.mangaTitle,
        chapterTitle: chapterFixture.name,
        chapterNumber: chapterFixture.chapterNumber,
        chapterOrder: chapterFixture.sourceOrder,
        sourceId: mangaFixture.sourceId,
        sourceLabel: mangaFixture.sourceLabel,
        scanlator: chapterFixture.scanlator,
        thumbnailUrl: "",
        pageUrls: sourceUrls,
        pages,
        status: "ready",
        totalPages: pages.length,
        downloadedPages: pages.length,
        storedBytes,
        createdAt: timestamp,
        updatedAt: timestamp,
        readyAt: timestamp,
        error: null,
      });
      transaction.addEventListener("complete", resolve, { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
    });
    database.close();
    return { key, storedBytes, cachePaths: pages.map((item) => item.cacheUrl) };
  }, {
    chapterFixture: chapter,
    mangaFixture: manga,
    sourceUrls: fixturePages(chapter.id),
  });
}

async function installQuotaFailureShim(page) {
  await page.evaluate(() => {
    window.__failDeviceChapterStorage = true;
    const nativeOpen = caches.open.bind(caches);
    caches.open = async (...args) => {
      const cache = await nativeOpen(...args);
      if (!cache.__panelPilotQuotaShim) {
        const nativePut = cache.put.bind(cache);
        cache.put = async (request, response) => {
          if (window.__failDeviceChapterStorage && new URL(String(request.url || request), location.href).pathname.startsWith("/__panels_device_chapters/v1/")) {
            throw new DOMException("Fixture storage quota exhausted", "QuotaExceededError");
          }
          return nativePut(request, response);
        };
        Object.defineProperty(cache, "__panelPilotQuotaShim", { value: true });
      }
      return cache;
    };
  });
}

async function installIndexedDbFailureShim(page) {
  await page.addInitScript(() => {
    Object.defineProperty(IDBFactory.prototype, "open", {
      configurable: true,
      value() {
        throw new DOMException("Fixture private-mode storage denial", "SecurityError");
      },
    });
  });
}

test("the device media namespace is cache-only and ignores query strings", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  const syntheticPath = "/__panels_device_chapters/v1/runtime-boundary/page-0";
  try {
    await prepareApp(page, context, fixture, { controlled: true });

    const miss = await page.evaluate(async (path) => {
      const response = await fetch(`${path}?attempt=miss`, { cache: "reload" });
      return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        body: await response.text(),
      };
    }, syntheticPath);
    expect(miss).toEqual({
      status: 404,
      cacheControl: "no-store",
      body: "Device chapter media not found",
    });
    expect(fixture.syntheticRequestCount()).toBe(0);

    const hit = await page.evaluate(async (path) => {
      const cache = await caches.open("panels-device-chapters-v1");
      await cache.put(
        new Request(new URL(path, location.origin)),
        new Response("cached-device-page", {
          status: 200,
          headers: { "Content-Type": "image/svg+xml; charset=utf-8" },
        }),
      );
      const response = await fetch(`${path}?signed=value&revision=2`, { cache: "reload" });
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: await response.text(),
      };
    }, syntheticPath);
    expect(hit).toEqual({
      status: 200,
      contentType: "image/svg+xml; charset=utf-8",
      body: "cached-device-page",
    });
    expect(fixture.syntheticRequestCount()).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("Clear app cache preserves downloaded device media", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  try {
    await page.addInitScript(() => {
      const loads = Number(sessionStorage.getItem("panels-device-cache-loads") || 0);
      sessionStorage.setItem("panels-device-cache-loads", String(loads + 1));
    });
    await prepareApp(page, context, fixture, { controlled: true });
    const syntheticPath = await page.evaluate(async () => {
      const serverUrl = "http://127.0.0.1:4567";
      const chapterId = "cache-cleanup";
      const key = JSON.stringify([serverUrl, chapterId]);
      const path = `/__panels_device_chapters/v1/${encodeURIComponent(key)}/fixture/0`;
      const body = "preserve-device-media";
      const bodySize = new TextEncoder().encode(body).byteLength;
      const deviceCache = await caches.open("panels-device-chapters-v1");
      await deviceCache.put(
        new Request(new URL(path, location.origin)),
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );

      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("panels-device-library", 1);
        request.addEventListener("upgradeneeded", () => {
          if (!request.result.objectStoreNames.contains("chapters")) {
            request.result.createObjectStore("chapters", { keyPath: "key" });
          }
        });
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), { once: true });
      });
      const timestamp = new Date().toISOString();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("chapters", "readwrite");
        transaction.objectStore("chapters").put({
          key,
          serverUrl,
          chapterId,
          mangaId: "cache-cleanup-manga",
          title: "Cache cleanup fixture",
          chapterTitle: "Preserved chapter",
          chapterNumber: 1,
          chapterOrder: 1,
          sourceId: "fixture-source",
          sourceLabel: "Fixture source",
          scanlator: "Fixture group",
          thumbnailUrl: "",
          pageUrls: ["/api/image/device-chapters/cache-cleanup/1.png"],
          pages: [{
            index: 0,
            sourceUrl: "/api/image/device-chapters/cache-cleanup/1.png",
            cacheUrl: path,
            contentType: "image/png",
            size: bodySize,
            completedAt: timestamp,
          }],
          status: "ready",
          totalPages: 1,
          downloadedPages: 1,
          storedBytes: bodySize,
          createdAt: timestamp,
          updatedAt: timestamp,
          readyAt: timestamp,
          error: null,
        });
        transaction.addEventListener("complete", resolve, { once: true });
        transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
        transaction.addEventListener("error", () => reject(transaction.error), { once: true });
      });
      database.close();

      const legacyCache = await caches.open("panel-pilot-v999");
      await legacyCache.put("/legacy-app-shell", new Response("remove-app-cache"));
      return path;
    });
    const loadsBeforeClear = await page.evaluate(
      () => Number(sessionStorage.getItem("panels-device-cache-loads")),
    );

    await page.locator("#nav-settings").click();
    await page.locator("#toggle-suwayomi-panel").click();
    await page.locator(".setup-advanced > summary").click();
    await expect(page.locator("#clear-app-cache")).toBeVisible();
    await Promise.all([
      page.waitForEvent("load", { timeout: 15_000 }),
      page.locator("#clear-app-cache").click(),
    ]);
    await expect.poll(
      () => page.evaluate(() => Number(sessionStorage.getItem("panels-device-cache-loads"))),
    ).toBe(loadsBeforeClear + 1);

    const cacheState = await page.evaluate(async (path) => {
      const keys = await caches.keys();
      const deviceCache = await caches.open("panels-device-chapters-v1");
      const response = await deviceCache.match(`${path}?after=clear`, { ignoreSearch: true });
      return {
        deviceCachePresent: keys.includes("panels-device-chapters-v1"),
        legacyCachePresent: keys.includes("panel-pilot-v999"),
        body: response ? await response.text() : "",
      };
    }, syntheticPath);
    expect(cacheState).toEqual({
      deviceCachePresent: true,
      legacyCachePresent: false,
      body: "preserve-device-media",
    });
    expect(fixture.syntheticRequestCount()).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("a device chapter is not ready until every page has been stored", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  fixture.holdImage(1101, 3);
  try {
    await prepareApp(page, context, fixture);
    await openChapterList(page);
    await downloadChapter(page, 1101);

    await expect.poll(() => fixture.imageRequestCount(1101, 3)).toBeGreaterThan(0);
    expect(await deviceState(page, 1101)).not.toMatch(/^(ready|downloaded)$/);
    await expect(chapterAction(page, 1101, "pause")).toBeFocused();
    await expect(chapterAction(page, 1101, "open")).toBeHidden();

    fixture.releaseImage(1101, 3);
    await expectDeviceReady(page, 1101);
  } finally {
    fixture.releaseImage(1101, 3);
    await fixture.close();
  }
});

test("a downloaded chapter survives reload, opens offline, and advances", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await openChapterList(page);
    await expectDeviceReady(page, 1101);
    await chapterAction(page, 1101, "open").click();

    await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#chapter-title")).toContainText("Device chapter one");
    await advanceReaderToNextPage(page);
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

for (const scenario of [
  { mode: "manga", direction: "rtl", pageIndex: 1, panelIndex: 1 },
  { mode: "comic", direction: "ltr", pageIndex: 2, panelIndex: 2 },
  { mode: "webtoon", direction: "rtl", pageIndex: 0, panelIndex: 3 },
]) {
  test(`offline ${scenario.mode} reading restores ${scenario.direction.toUpperCase()} page and panel position`, async ({ page, context }) => {
    const fixture = await startDeviceChapterFixture();
    try {
      fixture.markChapterMultiPanel(1101);
      fixture.setLibraryResume(1101, {
        pageIndex: scenario.pageIndex,
        panelIndex: scenario.panelIndex,
        panelMode: scenario.mode,
        readingDirection: scenario.direction,
        progressLabel: `Page ${scenario.pageIndex + 1}, panel ${scenario.panelIndex + 1}`,
      });
      await prepareApp(page, context, fixture, { controlled: true });
      await openChapterList(page);
      await downloadChapter(page, 1101);
      await expectDeviceReady(page, 1101);
      const imageRequestsBeforeOfflineOpen = [1, 2, 3].map((pageNumber) => (
        fixture.imageRequestCount(1101, pageNumber)
      ));

      await context.setOffline(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("#nav-library").click();
      const card = page.locator(".library-card").filter({ hasText: manga.mangaTitle });
      await expect(card).toBeVisible();
      await card.locator(".manga-cover-button").click();

      await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
      await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "true", { timeout: 15_000 });
      await expect(page.locator("#reader-error")).toBeHidden();
      await expect(page.locator(`#${scenario.mode}-mode`)).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(`#${scenario.direction}-order`)).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("#page-stat")).toHaveText(
        scenario.mode === "webtoon" ? /^Page 1 \/ 1$/ : new RegExp(`^Page ${scenario.pageIndex + 1} \\/ 3$`),
      );
      await expect(page.locator("#panel-stat")).toHaveText(
        scenario.mode === "webtoon"
          ? "Continuous scroll"
          : new RegExp(`^Panel ${scenario.panelIndex + 1} \\/ \\d+$`),
      );
      if (scenario.mode === "webtoon") {
        await expect(page.locator("body")).toHaveClass(/\bwebtoon-scroll\b/);
        await expect.poll(() => page.locator("#stage-image-wrap").evaluate((wrap) => wrap.scrollTop)).toBeGreaterThan(0);
      } else {
        const panelTotal = Number((await page.locator("#panel-stat").textContent())?.split("/")[1]);
        expect(panelTotal).toBeGreaterThan(scenario.panelIndex);
      }
      expect([1, 2, 3].map((pageNumber) => fixture.imageRequestCount(1101, pageNumber)))
        .toEqual(imageRequestsBeforeOfflineOpen);
    } finally {
      await context.setOffline(false);
      await fixture.close();
    }
  });
}

test("a ready device chapter survives suspension without network fallback or position loss", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);

    await context.setOffline(true);
    await chapterAction(page, 1101, "open").click();
    await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#chapter-title")).toContainText("Device chapter one");
    await advanceReaderToNextPage(page);

    const positionBefore = {
      page: await page.locator("#page-stat").textContent(),
      panel: await page.locator("#panel-stat").textContent(),
    };
    const integrityBefore = await devicePackageIntegrity(page, 1101);
    expect(integrityBefore).toMatchObject({
      status: "ready",
      totalPages: 3,
      downloadedPages: 3,
      cachedPages: 3,
    });
    const requestCountsBefore = {
      chapter: fixture.chapterPayloadRequestCount(1101),
      images: [1, 2, 3].map((pageNumber) => fixture.imageRequestCount(1101, pageNumber)),
      synthetic: fixture.syntheticRequestCount(),
    };
    const networkFallbacks = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/suwayomi/graphql" || pathname.startsWith("/api/image/device-chapters/")) {
        networkFallbacks.push(`${request.method()} ${pathname}`);
      }
    });

    await page.evaluate(async () => {
      let visibility = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => visibility === "hidden",
      });
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator("#reader-error")).toBeHidden();
    await expect(page.locator("#page-stat")).toHaveText(positionBefore.page || "");
    await expect(page.locator("#panel-stat")).toHaveText(positionBefore.panel || "");
    await expect.poll(() => page.evaluate(() => {
      const diagnostics = window.PanelPilot.getReaderLifecycleDiagnostics();
      const image = document.querySelector("#stage-image");
      return {
        activeView: diagnostics.activeView,
        visibilityState: diagnostics.visibilityState,
        currentImageReady: Boolean(image?.complete && image.naturalWidth > 0),
      };
    })).toEqual({
      activeView: "reader",
      visibilityState: "visible",
      currentImageReady: true,
    });
    await page.waitForTimeout(300);

    expect(await devicePackageIntegrity(page, 1101)).toEqual(integrityBefore);
    expect(fixture.chapterPayloadRequestCount(1101)).toBe(requestCountsBefore.chapter);
    expect([1, 2, 3].map((pageNumber) => fixture.imageRequestCount(1101, pageNumber)))
      .toEqual(requestCountsBefore.images);
    expect(fixture.syntheticRequestCount()).toBe(requestCountsBefore.synthetic);
    expect(networkFallbacks).toEqual([]);
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("an interrupted download stays resumable and reuses completed pages", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  fixture.holdImage(1101, 3);
  try {
    await prepareApp(page, context, fixture);
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expect.poll(() => fixture.imageRequestCount(1101, 3)).toBeGreaterThan(0);
    await expect.poll(() => fixture.imageRequestCount(1101, 2)).toBeGreaterThan(0);
    const completedPageRequests = fixture.imageRequestCount(1101, 1) + fixture.imageRequestCount(1101, 2);

    await page.reload({ waitUntil: "domcontentloaded" });
    await openChapterList(page);
    expect(await deviceState(page, 1101)).not.toMatch(/^(ready|downloaded)$/);
    await expect(chapterAction(page, 1101, "download")).toBeVisible();

    fixture.releaseImage(1101, 3);
    await chapterAction(page, 1101, "download").click();
    await expectDeviceReady(page, 1101);
    expect(fixture.imageRequestCount(1101, 1) + fixture.imageRequestCount(1101, 2)).toBe(completedPageRequests);
  } finally {
    fixture.releaseImage(1101, 3);
    await fixture.close();
  }
});

test("a missing page reports an incomplete package while the online app and Test Lab remain usable", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  fixture.markImageMissing(1101, 2);
  try {
    await prepareApp(page, context, fixture);
    await openChapterList(page);
    await downloadChapter(page, 1101);

    await expect.poll(() => deviceState(page, 1101), { timeout: 15_000 })
      .toMatch(/failed|error|incomplete|interrupted|retry|unavailable/);
    await expect(chapterRow(page, 1101).locator("[data-device-chapter-state]"))
      .toContainText(/Incomplete .* retry/i);
    await expect(chapterAction(page, 1101, "download")).toHaveAccessibleName(/Resume download Device chapter one/i);
    await expect(chapterAction(page, 1101, "open")).toBeHidden();
    await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");

    const lab = await context.newPage();
    const response = await lab.goto(`${fixture.origin}/panel-test.html`, { waitUntil: "networkidle" });
    expect(response?.ok()).toBeTruthy();
    await expect(lab.locator("#test-results")).toHaveCount(1);
    await expect.poll(() => lab.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
    await lab.close();
  } finally {
    await fixture.close();
  }
});

test("non-image and empty page responses never become ready and leave the online app usable", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    fixture.markImageNonImage(1101, 2);
    fixture.markImageEmpty(1102, 2);
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);

    for (const chapterId of [1101, 1102]) {
      await downloadChapter(page, chapterId);
      await expect.poll(() => deviceState(page, chapterId), { timeout: 15_000 })
        .toMatch(/failed|error|incomplete|interrupted|retry|unavailable/);
      await expect(chapterAction(page, chapterId, "open")).toBeHidden();
      await expect(chapterAction(page, chapterId, "download")).toBeVisible();
      await expect.poll(() => devicePackageIntegrity(page, chapterId)).toMatchObject({
        status: "failed",
        totalPages: 3,
        downloadedPages: 1,
        cachedPages: 1,
      });
    }

    await page.locator("#nav-settings").click();
    await expect(page.locator("#settings-view")).toHaveClass(/\bactive\b/);
    await page.goto(`${fixture.origin}/panel-test.html`, { waitUntil: "networkidle" });
    await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("an IndexedDB privacy denial is nonfatal to online reading and Test Lab", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await installIndexedDbFailureShim(page);
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);

    await chapterRow(page, 1101).locator('[data-chapter-action="read"]').click();
    await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/, { timeout: 20_000 });
    await expect(page.locator("#chapter-title")).toContainText("Device chapter one");
    await expect(page.locator("#stage-image")).toBeVisible();

    await page.goto(`${fixture.origin}/panel-test.html`, { waitUntil: "networkidle" });
    await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("quota exhaustion is reported honestly without breaking online navigation", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  try {
    await prepareApp(page, context, fixture);
    await openChapterList(page);
    await installQuotaFailureShim(page);
    await downloadChapter(page, 1101);

    await expect.poll(() => deviceState(page, 1101), { timeout: 15_000 })
      .toMatch(/failed|error|incomplete|quota|storage|retry|unavailable/);
    await expect(chapterRow(page, 1101).locator("[data-device-chapter-state]"))
      .toContainText(/Storage full .* retry/i);
    await expect(chapterAction(page, 1101, "download")).toHaveAccessibleName(/Resume download Device chapter one/i);
    await expect(chapterAction(page, 1101, "open")).toBeHidden();
    await page.locator("#nav-settings").click();
    await expect(page.locator("#settings-view")).toHaveClass(/\bactive\b/);
    await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
  } finally {
    await fixture.close();
  }
});

test("removing one package leaves another downloaded chapter available offline", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);
    await downloadChapter(page, 1102);
    await expectDeviceReady(page, 1102);

    page.once("dialog", (dialog) => dialog.accept());
    await chapterAction(page, 1101, "remove").click();
    await expect(chapterAction(page, 1101, "download")).toBeVisible();
    expect(await deviceState(page, 1101)).not.toMatch(/^(ready|downloaded)$/);
    await expectDeviceReady(page, 1102);

    await context.setOffline(true);
    await chapterAction(page, 1102, "open").click();
    await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#chapter-title")).toContainText("Device chapter two");
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("offline bulk removal preserves progress and server state while the surviving package opens", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  const preservedOutbox = [{
    serverUrl: "http://localhost:4567",
    chapterId: 1102,
    lastPageRead: 1,
    completed: false,
    updatedAt: 1,
  }];
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);
    await downloadChapter(page, 1102);
    await expectDeviceReady(page, 1102);

    await page.evaluate((outbox) => {
      localStorage.setItem("panel-pilot-progress-outbox", JSON.stringify(outbox));
    }, preservedOutbox);
    const serverLibraryBefore = fixture.librarySnapshot();
    const progressMutationsBefore = fixture.progressMutations.length;

    await page.locator("#nav-settings").click();
    await expect(page.locator("#device-storage-panel")).toBeVisible();
    await page.locator("#device-storage-manager > summary").click();
    const removeRow = deviceStorageRow(page, "Device chapter one");
    const survivingRow = deviceStorageRow(page, "Device chapter two");
    await expect(removeRow).toBeVisible();
    await expect(survivingRow).toBeVisible();
    await removeRow.locator("[data-device-storage-select]").check();
    await page.locator("#device-storage-remove-selected").click();
    await expect(page.locator("#device-storage-dialog")).toHaveAttribute("open", "");

    await context.setOffline(true);
    await page.locator("#device-storage-confirm").click();
    await expect(removeRow).toHaveCount(0);
    await expect(survivingRow).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("panel-pilot-progress-outbox") || "[]")))
      .toEqual(preservedOutbox);
    expect(fixture.librarySnapshot()).toEqual(serverLibraryBefore);
    expect(fixture.progressMutations).toHaveLength(progressMutationsBefore);
    await survivingRow.locator("[data-device-storage-select]").check();
    await expect(page.locator("#device-storage-remove-selected")).toBeEnabled();

    await openChapterList(page);
    await chapterAction(page, 1102, "open").click();
    await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#chapter-title")).toContainText("Device chapter two");
    await advanceReaderToNextPage(page);
    await page.locator("#device-storage-refresh").evaluate((button) => button.click());
    await expect.poll(() => survivingRow.locator("[data-device-storage-select]").isDisabled()).toBe(true);
    await expect(page.locator("#device-storage-remove-selected")).toBeDisabled();
    await expect(page.locator("#device-storage-panel")).toBeHidden();
    await expect(page.locator("#device-storage-remove-selected")).toBeHidden();
    await expect.poll(() => devicePackageIntegrity(page, 1102)).toMatchObject({
      status: "ready",
      downloadedPages: 3,
      cachedPages: 3,
    });
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("bulk removal excludes the active offline reader while another package remains removable", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);
    await downloadChapter(page, 1102);
    await expectDeviceReady(page, 1102);

    await context.setOffline(true);
    await chapterAction(page, 1101, "open").click();
    await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#chapter-title")).toContainText("Device chapter one");

    // Refreshing from the hidden Settings surface preserves the active reader
    // while forcing the package manager to evaluate its current exclusion set.
    await page.locator("#device-storage-refresh").evaluate((button) => button.click());
    const activeRow = deviceStorageRow(page, "Device chapter one");
    const removableRow = deviceStorageRow(page, "Device chapter two");
    await expect(activeRow).toContainText(/open in reader.*close it before removing/i);
    await expect(activeRow.locator("[data-device-storage-select]")).toBeDisabled();
    await expect(activeRow.locator("[data-device-storage-remove]")).toBeDisabled();
    await expect(removableRow.locator("[data-device-storage-select]")).toBeEnabled();
    await expect(removableRow.locator("[data-device-storage-remove]")).toBeEnabled();

    await page.locator("#device-storage-select-all").evaluate((checkbox) => checkbox.click());
    await expect(activeRow.locator("[data-device-storage-select]")).not.toBeChecked();
    await expect(removableRow.locator("[data-device-storage-select]")).toBeChecked();
    await expect(page.locator("#device-storage-selected-count")).toHaveText("1 selected");

    await page.locator("#device-storage-remove-selected").evaluate((button) => button.click());
    await expect(page.locator("#device-storage-dialog")).toHaveAttribute("open", "");
    await expect(page.locator("#device-storage-dialog-description")).toContainText(/remove 1 chapter/i);
    await page.locator("#device-storage-confirm").evaluate((button) => button.click());

    await expect(removableRow).toHaveCount(0);
    await expect.poll(() => devicePackageIntegrity(page, 1101)).toMatchObject({
      status: "ready",
      downloadedPages: 3,
      cachedPages: 3,
    });
    expect(await devicePackageIntegrity(page, 1102)).toBeNull();
    await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#chapter-title")).toContainText("Device chapter one");
    await advanceReaderToNextPage(page);
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("offline reading coalesces latest progress and one reconnect mutation clears the outbox", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);

    await context.setOffline(true);
    await chapterAction(page, 1101, "open").click();
    await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
    await advanceReaderToNextPage(page);
    await page.waitForTimeout(700);

    const queued = await page.evaluate(() => JSON.parse(
      localStorage.getItem("panel-pilot-progress-outbox") || "[]",
    ));
    expect(queued).toHaveLength(1);
    expect(queued[0].chapterId).toBe(1101);
    expect(queued[0].lastPageRead).toBeGreaterThanOrEqual(1);

    await context.setOffline(false);
    await expect.poll(() => fixture.progressMutations.length, { timeout: 15_000 }).toBe(1);
    expect(fixture.progressMutations[0].input.id).toBe(1101);
    expect(fixture.progressMutations[0].input.patch.lastPageRead).toBe(queued[0].lastPageRead);
    await expect.poll(() => page.evaluate(() => JSON.parse(
      localStorage.getItem("panel-pilot-progress-outbox") || "[]",
    ).length)).toBe(0);
    await page.waitForTimeout(500);
    expect(fixture.progressMutations).toHaveLength(1);
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("offline MangaBaka progress coalesces to the latest entry and is acknowledged once after reconnect", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture({ mangaBakaConnected: true });
  const accountKey = "fixture-mangabaka-account";
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await context.setOffline(true);
    await page.addInitScript(({ key, account }) => {
      if (sessionStorage.getItem("fixture-mangabaka-outbox-seeded")) return;
      sessionStorage.setItem("fixture-mangabaka-outbox-seeded", "1");
      localStorage.setItem(key, JSON.stringify({
        accountKey: account,
        entries: [
          { series_id: 9901, state: "reading", progress_chapter: 2, accountKey: account, revision: 1 },
          { series_id: 9901, state: "paused", progress_chapter: 4, accountKey: account, revision: 3 },
          { series_id: 9901, state: "reading", progress_chapter: 7, accountKey: account, revision: 2 },
        ],
      }));
    }, { key: "panel-pilot-mangabaka-outbox", account: accountKey });
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect.poll(() => page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem("panel-pilot-mangabaka-outbox") || "{}");
      return saved.entries || [];
    })).toEqual([{
      series_id: 9901,
      state: "paused",
      progress_chapter: 7,
      accountKey,
      revision: 3,
    }]);
    expect(fixture.mangaBakaMutations).toHaveLength(0);

    await context.setOffline(false);
    await expect.poll(() => fixture.mangaBakaMutations.length, { timeout: 15_000 }).toBe(1);
    expect(fixture.mangaBakaMutations[0]).toEqual({
      accountKey,
      entries: [{ series_id: 9901, state: "paused", progress_chapter: 7 }],
    });
    await expect.poll(() => page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem("panel-pilot-mangabaka-outbox") || "{}");
      return saved.entries || [];
    })).toEqual([]);
    await page.waitForTimeout(400);
    expect(fixture.mangaBakaMutations).toHaveLength(1);
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("an older controller blocks device actions until the capability update is applied", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture({ phaseThreeController: true });
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);

    await expect(chapterRow(page, 1101).locator("[data-device-chapter-state]"))
      .toContainText(/apply app update/i);
    await expect(chapterAction(page, 1101, "download")).toBeDisabled();
    expect(fixture.imageRequestCount(1101, 1)).toBe(0);

    await page.evaluate(() => fetch("/__switch-device-worker", { method: "POST" }));
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      if (!registration) throw new Error("No fixture service-worker registration found");
      await registration.update();
      for (let attempt = 0; attempt < 100 && !registration.waiting; attempt += 1) {
        await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
      }
      if (!registration.waiting) throw new Error("Updated worker did not enter the waiting state");
    });
    await expect(page.locator("#app-update")).toBeVisible({ timeout: 10_000 });
    await Promise.all([
      page.waitForEvent("load", { timeout: 15_000 }),
      page.locator("#app-update").click(),
    ]);

    await openChapterList(page);
    await expect(chapterAction(page, 1101, "download")).toBeEnabled({ timeout: 10_000 });
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);
  } finally {
    await fixture.close();
  }
});

test("an approved waiting-worker update preserves a ready device chapter package", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture({ phaseThreeController: true });
  try {
    await page.addInitScript(() => {
      const loads = Number(sessionStorage.getItem("panels-device-update-loads") || 0);
      sessionStorage.setItem("panels-device-update-loads", String(loads + 1));
    });
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await expect(chapterAction(page, 1101, "download")).toBeDisabled();

    const seeded = await seedReadyDeviceChapter(page, 1101);
    const beforeUpdate = await devicePackageIntegrity(page, 1101);
    expect(beforeUpdate).toMatchObject({
      status: "ready",
      totalPages: 3,
      downloadedPages: 3,
      storedBytes: seeded.storedBytes,
      cachedPages: 3,
      cachePaths: seeded.cachePaths,
    });
    const loadsBeforeActivation = await page.evaluate(
      () => Number(sessionStorage.getItem("panels-device-update-loads")),
    );

    await page.evaluate(() => fetch("/__switch-device-worker", { method: "POST" }));
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      if (!registration) throw new Error("No fixture service-worker registration found");
      await registration.update();
      for (let attempt = 0; attempt < 100 && !registration.waiting; attempt += 1) {
        await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
      }
      if (!registration.waiting) throw new Error("Updated worker did not enter the waiting state");
    });
    await expect(page.locator("#app-update")).toBeVisible({ timeout: 10_000 });

    await Promise.all([
      page.waitForEvent("load", { timeout: 15_000 }),
      page.locator("#app-update").click(),
    ]);
    await expect.poll(
      () => page.evaluate(() => Number(sessionStorage.getItem("panels-device-update-loads"))),
    ).toBe(loadsBeforeActivation + 1);
    await openChapterList(page);
    await expectDeviceReady(page, 1101);

    const afterUpdate = await devicePackageIntegrity(page, 1101);
    expect(afterUpdate).toEqual(beforeUpdate);
    const sourceRequestsBeforeOfflineOpen = [1, 2, 3].map(
      (pageNumber) => fixture.imageRequestCount(1101, pageNumber),
    );

    await context.setOffline(true);
    await chapterAction(page, 1101, "open").click();
    await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#chapter-title")).toContainText("Device chapter one");
    await advanceReaderToNextPage(page);
    expect([1, 2, 3].map((pageNumber) => fixture.imageRequestCount(1101, pageNumber)))
      .toEqual(sourceRequestsBeforeOfflineOpen);
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("a capability failure without a waiting worker does not advertise an app update", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture({ phaseThreeController: true });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);

    await expect(chapterAction(page, 1101, "download")).toBeDisabled();
    await expect.poll(() => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      return Boolean(registration?.waiting);
    })).toBe(false);

    // Exercise the fail-closed action path even though the UI correctly keeps
    // the unsupported action disabled.
    await chapterAction(page, 1101, "download").evaluate((button) => {
      button.disabled = false;
      button.click();
    });

    await expect(page.locator("#app-update-note")).toContainText(/offline chapter support.*reload/i, { timeout: 5_000 });
    await expect(page.locator("#app-update-note")).not.toContainText(/update ready|apply it/i);
    await expect(page.locator("#app-update")).toBeHidden();
    await page.locator("#nav-settings").click();
    await expect(page.locator("#apply-app-update")).toBeHidden();
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("a delayed reply from the previous controller cannot restore device readiness", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture({ incapableUpdate: true });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  try {
    await page.addInitScript(() => {
      const NativeMessageChannel = window.MessageChannel;
      const nativeSetTimeout = window.setTimeout.bind(window);
      const nativeWindowSetTimeout = window.setTimeout;
      window.__deviceCapabilityRepliesCaptured = 0;
      window.__deviceCapabilityRepliesDelivered = 0;

      window.MessageChannel = class DelayedCapabilityMessageChannel {
        constructor() {
          const channel = new NativeMessageChannel();
          this.port2 = channel.port2;
          this.port1 = {};
          Object.defineProperty(this.port1, "onmessage", {
            set(handler) {
              channel.port1.onmessage = (event) => {
                window.__deviceCapabilityRepliesCaptured += 1;
                nativeSetTimeout(() => {
                  window.__deviceCapabilityRepliesDelivered += 1;
                  handler(event);
                }, 2_500);
              };
            },
          });
        }
      };

      // Keep the app's capability timeout from winning before the deliberately
      // delayed old-controller reply can exercise the generation guard.
      window.setTimeout = (handler, delay, ...args) => nativeWindowSetTimeout(
        handler,
        delay === 1_500 ? 8_000 : delay,
        ...args,
      );
    });

    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await expect.poll(() => page.evaluate(() => window.__deviceCapabilityRepliesCaptured)).toBeGreaterThan(0);
    const oldReplyCount = await page.evaluate(() => window.__deviceCapabilityRepliesCaptured);

    await page.evaluate(() => fetch("/__switch-device-worker", { method: "POST" }));
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      if (!registration) throw new Error("No fixture service-worker registration found");

      const waitingWorker = await new Promise((resolveWaiting, rejectWaiting) => {
        const timeout = setTimeout(() => rejectWaiting(new Error("Incapable worker did not begin waiting")), 10_000);
        const inspectWorker = () => {
          if (registration.waiting) {
            clearTimeout(timeout);
            resolveWaiting(registration.waiting);
            return;
          }
          const worker = registration.installing;
          if (!worker) return;
          const inspectState = () => {
            if (registration.waiting || worker.state === "installed") {
              clearTimeout(timeout);
              resolveWaiting(registration.waiting || worker);
            }
          };
          worker.addEventListener("statechange", inspectState);
          inspectState();
        };
        registration.addEventListener("updatefound", inspectWorker);
        registration.update().then(inspectWorker, (error) => {
          clearTimeout(timeout);
          rejectWaiting(error);
        });
        inspectWorker();
      });

      await new Promise((resolveController, rejectController) => {
        const timeout = setTimeout(() => rejectController(new Error("Incapable worker did not take control")), 10_000);
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          clearTimeout(timeout);
          resolveController();
        }, { once: true });
        waitingWorker.postMessage({ type: "SKIP_WAITING" });
      });
    });

    await expect.poll(
      () => page.evaluate(() => window.__deviceCapabilityRepliesDelivered),
      { timeout: 6_000 },
    ).toBeGreaterThanOrEqual(oldReplyCount);
    await page.waitForTimeout(100);

    await expect(chapterAction(page, 1101, "download")).toBeDisabled();
    await expect(chapterRow(page, 1101).locator("[data-device-chapter-state]"))
      .toContainText(/preparing offline support|update app/i);
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("cache eviction downgrades a ready package to resumable", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);

    const deleted = await page.evaluate(async () => {
      const cache = await caches.open("panels-device-chapters-v1");
      const requests = await cache.keys();
      const pageRequest = requests.find((request) => (
        decodeURIComponent(new URL(request.url).pathname).includes("1101")
      ));
      return pageRequest ? cache.delete(pageRequest) : false;
    });
    expect(deleted).toBe(true);

    await page.reload({ waitUntil: "networkidle" });
    await openChapterList(page);
    expect(await deviceState(page, 1101)).not.toMatch(/^(ready|downloaded)$/);
    await expect(chapterRow(page, 1101).locator("[data-device-chapter-state]"))
      .toContainText(/partial|incomplete|resume|retry/i);
    await expect(chapterAction(page, 1101, "download")).toHaveAccessibleName(/resume|download/i);
    await expect(chapterAction(page, 1101, "open")).toBeHidden();
  } finally {
    await fixture.close();
  }
});

test("a corrupt cached page reduces verified bytes and a resumed repair restores readiness", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);

    const ready = await devicePackageIntegrity(page, 1101);
    expect(ready).toMatchObject({ status: "ready", downloadedPages: 3, cachedPages: 3 });
    expect(ready.storedBytes).toBeGreaterThan(0);
    expect(ready.cachePaths).toHaveLength(3);

    await page.evaluate(async (cachePath) => {
      const cache = await caches.open("panels-device-chapters-v1");
      await cache.put(cachePath, new Response("corrupt fixture payload", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }));
    }, ready.cachePaths[1]);

    await page.locator("#nav-settings").click();
    await expect(page.locator("#device-storage-panel")).toBeVisible();
    await page.locator("#device-storage-refresh").click();
    await expect(page.locator("#device-storage-result")).toContainText(/refreshed/i);
    await expect.poll(() => devicePackageIntegrity(page, 1101)).toMatchObject({
      status: "paused",
      downloadedPages: 2,
      cachedPages: 2,
    });
    const partial = await devicePackageIntegrity(page, 1101);
    expect(partial.storedBytes).toBeLessThan(ready.storedBytes);

    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);
    await expect.poll(() => devicePackageIntegrity(page, 1101)).toMatchObject({
      status: "ready",
      downloadedPages: 3,
      cachedPages: 3,
      storedBytes: ready.storedBytes,
    });
  } finally {
    await fixture.close();
  }
});

test("continue reading prefers a ready local chapter before contacting Suwayomi", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);
    const chapterRequestsBeforeResume = fixture.chapterPayloadRequestCount(1101);

    fixture.setLibraryResume(1101);
    fixture.failChapterPayload(1101);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#nav-library").click();
    const card = page.locator(".library-card").filter({ hasText: manga.mangaTitle });
    await expect(card).toBeVisible();
    await card.locator(".manga-cover-button").click();

    await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#chapter-title")).toContainText("Device chapter one");
    await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "true", { timeout: 10_000 });
    await expect(page.locator("#reader-error")).toBeHidden();
    expect(fixture.chapterPayloadRequestCount(1101)).toBe(chapterRequestsBeforeResume);
  } finally {
    await fixture.close();
  }
});

test("a downloaded current chapter can advance online to a live-only next chapter", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);
    await chapterAction(page, 1101, "open").click();
    await expect(page.locator("#chapter-title")).toContainText("Device chapter one");

    await advanceReaderUntilChapter(page, "Device chapter two");
    await expect.poll(() => fixture.chapterPayloadRequestCount(1102)).toBeGreaterThan(0);
    await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
  } finally {
    await fixture.close();
  }
});

test("a direct library-card resume reports an offline unsaved chapter without an unhandled error", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  fixture.setLibraryResume(1102);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#nav-library").click();
    const card = page.locator(".library-card").filter({ hasText: manga.mangaTitle });
    await expect(card).toBeVisible();
    await card.locator(".manga-cover-button").click();

    await expect(page.locator("#reader-error")).toBeVisible();
    await expect(page.locator("#reader-error-message")).toContainText(/not been saved|reconnect|offline/i);
    expect(pageErrors).toEqual([]);
    await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("offline progress keeps its package server identity after the configured server changes", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  const alternateServer = "https://server-b.invalid:4567";
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);

    await context.setOffline(true);
    await chapterAction(page, 1101, "open").click();
    await advanceReaderToNextPage(page);
    await page.waitForTimeout(700);
    const queued = await page.evaluate(() => JSON.parse(
      localStorage.getItem("panel-pilot-progress-outbox") || "[]",
    ));
    expect(queued).toHaveLength(1);
    expect(queued[0].serverUrl).toBe("http://localhost:4567");

    await page.locator("#server-url").evaluate((input, value) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, alternateServer);
    await expect(page.locator("#server-url")).toHaveValue(alternateServer);
    await context.setOffline(false);

    await expect.poll(() => fixture.progressMutations.length, { timeout: 15_000 }).toBe(1);
    expect(fixture.progressMutations[0].serverBase).toBe(queued[0].serverUrl);
    expect(fixture.progressMutations[0].serverBase).not.toBe(alternateServer);
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("a cold offline local chapter can reconnect and advance to a live-only next chapter", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);

    fixture.setLibraryResume(1101);
    await page.reload({ waitUntil: "networkidle" });
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await openChapterList(page);
    await expect(chapterRow(page, 1101)).toBeVisible();
    await expect(chapterRow(page, 1102)).toHaveCount(0);
    await page.locator("#nav-library").click();
    const card = page.locator(".library-card").filter({ hasText: manga.mangaTitle });
    await expect(card).toBeVisible();
    await card.locator(".manga-cover-button").click();
    await expect(page.locator("#chapter-title")).toContainText("Device chapter one");

    const liveListRequestsBeforeReconnect = fixture.chapterListRequestCount("fetch");
    await context.setOffline(false);
    await expect.poll(
      () => fixture.chapterListRequestCount("fetch"),
      { timeout: 15_000 },
    ).toBeGreaterThan(liveListRequestsBeforeReconnect);
    await advanceReaderUntilChapter(page, "Device chapter two");
    await expect.poll(() => fixture.chapterPayloadRequestCount(1102)).toBeGreaterThan(0);
  } finally {
    await context.setOffline(false);
    await fixture.close();
  }
});

test("a failed progress server does not block another server-scoped queue entry", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  const serverA = "https://server-a.invalid:4567";
  const serverB = "https://server-b.invalid:4567";
  fixture.failProgressForBase(serverA);
  await page.addInitScript(({ firstServer, secondServer }) => {
    localStorage.setItem("panel-pilot-progress-outbox", JSON.stringify([
      {
        serverUrl: firstServer,
        chapterId: 1101,
        lastPageRead: 1,
        completed: false,
        updatedAt: Date.now() - 1,
      },
      {
        serverUrl: secondServer,
        chapterId: 1102,
        lastPageRead: 2,
        completed: false,
        updatedAt: Date.now(),
      },
    ]));
  }, { firstServer: serverA, secondServer: serverB });

  try {
    await prepareApp(page, context, fixture);
    await expect.poll(() => fixture.progressAttempts.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    expect(fixture.progressAttempts.some((attempt) => attempt.serverBase === serverA)).toBe(true);
    expect(fixture.progressAttempts.some((attempt) => attempt.serverBase === serverB)).toBe(true);
    await expect.poll(
      () => fixture.progressMutations.filter((mutation) => mutation.serverBase === serverB).length,
    ).toBe(1);

    await expect.poll(() => page.evaluate(() => JSON.parse(
      localStorage.getItem("panel-pilot-progress-outbox") || "[]",
    ))).toEqual([expect.objectContaining({ serverUrl: serverA, chapterId: 1101 })]);
  } finally {
    await fixture.close();
  }
});

test("online chapter-list failures fall back to local rows that still open", async ({ page, context }) => {
  const fixture = await startDeviceChapterFixture();
  try {
    await prepareApp(page, context, fixture, { controlled: true });
    await openChapterList(page);
    await downloadChapter(page, 1101);
    await expectDeviceReady(page, 1101);

    fixture.failChapterLists();
    await page.reload({ waitUntil: "networkidle" });
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    await openChapterList(page);

    await expect.poll(() => fixture.chapterListRequestCount("fetch")).toBeGreaterThan(0);
    await expect.poll(() => fixture.chapterListRequestCount("stored")).toBeGreaterThan(0);
    await expect(chapterRow(page, 1101)).toBeVisible();
    await expect(chapterRow(page, 1102)).toHaveCount(0);
    await expectDeviceReady(page, 1101);
    await chapterAction(page, 1101, "open").click();
    await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#chapter-title")).toContainText("Device chapter one");
  } finally {
    await fixture.close();
  }
});
