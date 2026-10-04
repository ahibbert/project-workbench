import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleSource = readFileSync(resolve(projectRoot, "src/device-chapters.js"));

function imagePath(chapterId, pageNumber) {
  return `/images/${chapterId}/${pageNumber}.svg`;
}

function mislabeledHtmlImagePath(chapterId, pageNumber) {
  return `/mislabeled-images/${chapterId}/${pageNumber}.jpg`;
}

function imageBody(chapterId, pageNumber) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="18"><rect width="12" height="18" fill="hsl(${(chapterId + pageNumber) % 360} 40% 80%)"/></svg>`);
}

function startModelFixture() {
  const requestCounts = new Map();
  const failOnce = new Set();
  const failAlways = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><meta charset=utf-8><title>Device model fixture</title>");
      return;
    }
    if (url.pathname === "/device-chapters.js") {
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript; charset=utf-8" });
      response.end(moduleSource);
      return;
    }
    const imageMatch = url.pathname.match(/^\/images\/(\d+)\/(\d+)\.svg$/);
    if (imageMatch) {
      requestCounts.set(url.pathname, (requestCounts.get(url.pathname) || 0) + 1);
      if (failAlways.has(url.pathname) || failOnce.delete(url.pathname)) {
        response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Fixture image failure");
        return;
      }
      const body = imageBody(Number(imageMatch[1]), Number(imageMatch[2]));
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": body.length,
        "Content-Type": "image/svg+xml; charset=utf-8",
      });
      response.end(body);
      return;
    }
    const mislabeledMatch = url.pathname.match(/^\/mislabeled-images\/(\d+)\/(\d+)\.jpg$/);
    if (mislabeledMatch) {
      requestCounts.set(url.pathname, (requestCounts.get(url.pathname) || 0) + 1);
      const body = Buffer.from("<!doctype html><html><head><title>Source block page</title></head><body>Not an image</body></html>");
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": body.length,
        "Content-Type": "image/jpeg",
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  return new Promise((resolveFixture, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveFixture({
        origin: `http://127.0.0.1:${address.port}`,
        failImageOnce(chapterId, pageNumber) { failOnce.add(imagePath(chapterId, pageNumber)); },
        failImageAlways(chapterId, pageNumber) { failAlways.add(imagePath(chapterId, pageNumber)); },
        requestCount(chapterId, pageNumber) { return requestCounts.get(imagePath(chapterId, pageNumber)) || 0; },
        mislabeledHtmlImagePath,
        close() { return new Promise((done, fail) => server.close((error) => error ? fail(error) : done())); },
      });
    });
  });
}

test("opened/read timestamps are monotonic and survive a safe replacement download", async ({ page }) => {
  const fixture = await startModelFixture();
  try {
    await page.goto(fixture.origin);
    const result = await page.evaluate(async () => {
      const api = await import("/device-chapters.js");
      const chapter = {
        serverUrl: location.origin,
        chapterId: 2101,
        mangaId: 77,
        title: "Device model fixture",
        sourceId: 9,
        sourceLabel: "Fixture source",
        chapterTitle: "Chapter 2101",
        chapterNumber: 2101,
        chapterOrder: 2101,
        scanlator: "Fixture group",
        pageUrls: [1, 2, 3].map((pageNumber) => `/images/2101/${pageNumber}.svg`),
      };
      await api.downloadDeviceChapter(chapter);
      await api.markDeviceChapterOpened(location.origin, 2101, { at: "2026-10-02T02:00:00.000Z" });
      await api.markDeviceChapterOpened(location.origin, 2101, { at: "2026-10-02T01:00:00.000Z" });
      await api.markDeviceChapterRead(location.origin, 2101, { at: "2026-10-02T03:00:00.000Z" });
      const marked = await api.getDeviceChapter(location.origin, 2101);
      await api.downloadDeviceChapter(chapter);
      const replaced = await api.getDeviceChapter(location.origin, 2101);
      let readyRetryError = null;
      try { await api.retryIncompleteDeviceChapter(location.origin, 2101); }
      catch (error) { readyRetryError = { name: error.name, message: error.message }; }
      return {
        marked: { lastOpenedAt: marked.lastOpenedAt, readAt: marked.readAt },
        replaced: { lastOpenedAt: replaced.lastOpenedAt, readAt: replaced.readAt, status: replaced.status },
        readyRetryError,
      };
    });

    expect(result).toEqual({
      marked: {
        lastOpenedAt: "2026-10-02T02:00:00.000Z",
        readAt: "2026-10-02T03:00:00.000Z",
      },
      replaced: {
        lastOpenedAt: "2026-10-02T02:00:00.000Z",
        readAt: "2026-10-02T03:00:00.000Z",
        status: "ready",
      },
      readyRetryError: {
        name: "InvalidStateError",
        message: "This device chapter is already ready.",
      },
    });
  } finally {
    await fixture.close();
  }
});

test("retrying an incomplete package reuses verified pages and reaches ready", async ({ page }) => {
  const fixture = await startModelFixture();
  fixture.failImageOnce(2201, 2);
  try {
    await page.goto(fixture.origin);
    const result = await page.evaluate(async () => {
      const api = await import("/device-chapters.js");
      const chapter = {
        serverUrl: location.origin,
        chapterId: 2201,
        mangaId: 77,
        title: "Device model fixture",
        chapterTitle: "Chapter 2201",
        pageUrls: [1, 2, 3].map((pageNumber) => `/images/2201/${pageNumber}.svg`),
      };
      try { await api.downloadDeviceChapter(chapter); } catch { /* expected fixture failure */ }
      const incomplete = await api.listIncompleteDeviceChapters();
      const before = incomplete[0];
      const progress = [];
      const ready = await api.retryIncompleteDeviceChapter(location.origin, 2201, {
        onProgress: (entry) => progress.push({ status: entry.status, completed: entry.completed, total: entry.total }),
      });
      return {
        before: {
          status: before.status,
          downloadedPages: before.downloadedPages,
          retryable: api.deviceChapterCanRetry(before),
          incomplete: api.deviceChapterIsIncomplete(before),
        },
        ready: { status: ready.status, downloadedPages: ready.downloadedPages, totalPages: ready.totalPages },
        remainingIncomplete: (await api.listIncompleteDeviceChapters()).length,
        progress,
      };
    });

    expect(result.before).toEqual({ status: "failed", downloadedPages: 1, retryable: true, incomplete: true });
    expect(result.ready).toEqual({ status: "ready", downloadedPages: 3, totalPages: 3 });
    expect(result.remainingIncomplete).toBe(0);
    expect(result.progress.at(-1)).toEqual({ status: "ready", completed: 3, total: 3 });
    expect(fixture.requestCount(2201, 1)).toBe(1);
    expect(fixture.requestCount(2201, 2)).toBe(2);
    expect(fixture.requestCount(2201, 3)).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("an HTML block page mislabeled as an image never becomes an offline chapter", async ({ page }) => {
  const fixture = await startModelFixture();
  try {
    await page.goto(fixture.origin);
    const result = await page.evaluate(async (pageUrl) => {
      const api = await import("/device-chapters.js");
      const chapter = {
        serverUrl: location.origin,
        chapterId: 2251,
        mangaId: 77,
        title: "Blocked source fixture",
        chapterTitle: "Chapter 2251",
        pageUrls: [pageUrl],
      };
      let error = "";
      try { await api.downloadDeviceChapter(chapter); } catch (reason) { error = reason.message; }
      const stored = await api.getDeviceChapter(location.origin, 2251);
      return { error, status: stored?.status, downloadedPages: stored?.downloadedPages };
    }, fixture.mislabeledHtmlImagePath(2251, 1));

    expect(result).toEqual({
      error: "Page download returned an HTML document instead of an image. This source download is invalid.",
      status: "failed",
      downloadedPages: 0,
    });
  } finally {
    await fixture.close();
  }
});

test("bulk incomplete cleanup honors excluded keys and never selects ready packages", async ({ page }) => {
  const fixture = await startModelFixture();
  fixture.failImageAlways(2301, 2);
  fixture.failImageAlways(2302, 2);
  try {
    await page.goto(fixture.origin);
    const result = await page.evaluate(async () => {
      const api = await import("/device-chapters.js");
      const makeChapter = (chapterId) => ({
        serverUrl: location.origin,
        chapterId,
        mangaId: 77,
        title: "Device model fixture",
        chapterTitle: `Chapter ${chapterId}`,
        pageUrls: [1, 2, 3].map((pageNumber) => `/images/${chapterId}/${pageNumber}.svg`),
      });
      for (const chapterId of [2301, 2302]) {
        try { await api.downloadDeviceChapter(makeChapter(chapterId)); } catch { /* expected fixture failure */ }
      }
      await api.downloadDeviceChapter(makeChapter(2303));
      const incomplete = await api.listIncompleteDeviceChapters();
      const protectedPackage = incomplete.find((chapterPackage) => Number(chapterPackage.chapterId) === 2301);
      const progress = [];
      const cleanup = await api.removeIncompleteDeviceChapters({
        excludeKeys: [protectedPackage.key],
        onProgress: (entry) => progress.push(entry.status),
      });
      const remaining = await api.listDeviceChapters();
      return {
        beforeIds: incomplete.map((chapterPackage) => Number(chapterPackage.chapterId)).sort(),
        cleanup: {
          eligible: cleanup.eligible,
          requested: cleanup.requested,
          removedIds: cleanup.removed.map((chapterPackage) => Number(chapterPackage.chapterId)),
          failed: cleanup.failed.length,
          excludedIds: cleanup.excluded.map((chapterPackage) => Number(chapterPackage.chapterId)),
        },
        progress,
        remaining: remaining.map((chapterPackage) => ({ chapterId: Number(chapterPackage.chapterId), status: chapterPackage.status })).sort((a, b) => a.chapterId - b.chapterId),
      };
    });

    expect(result.beforeIds).toEqual([2301, 2302]);
    expect(result.cleanup).toEqual({
      eligible: 2,
      requested: 1,
      removedIds: [2302],
      failed: 0,
      excludedIds: [2301],
    });
    expect(result.progress).toEqual(["removed"]);
    expect(result.remaining).toEqual([
      { chapterId: 2301, status: "failed" },
      { chapterId: 2303, status: "ready" },
    ]);
  } finally {
    await fixture.close();
  }
});
