import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(projectRoot, "dist");
const budgets = {
  indexHtml: 40 * 1024,
  mainJavaScript: 302 * 1024,
  mainCss: 72 * 1024,
  criticalPath: 422 * 1024,
  installShell: 660 * 1024,
  domContentLoadedMs: 1_500,
  loadMs: 2_000,
  applicationReadyMs: 2_500,
  startupLongTaskMs: 250,
  interactionPaintMs: 250,
};

function readDist(path) {
  return readFileSync(join(distRoot, path), "utf8");
}

function tagAttribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] ?? null;
}

function normalizedBuildPath(reference) {
  const path = String(reference || "").split(/[?#]/, 1)[0];
  return decodeURIComponent(path).replace(/^\.\//, "").replace(/^\//, "");
}

function localAssetReferences(html) {
  const references = [];
  for (const match of html.matchAll(/<(?:script|link|img)\b[^>]*>/gi)) {
    const reference = tagAttribute(match[0], "src") ?? tagAttribute(match[0], "href");
    if (!reference || /^(?:data:|https?:|\/\/|#)/i.test(reference)) continue;
    references.push(normalizedBuildPath(reference));
  }
  return [...new Set(references)];
}

function precachePaths(worker) {
  const paths = [];
  const pattern = /(?:\burl|["']url["'])\s*:\s*["']([^"']+)["']/g;
  for (const match of worker.matchAll(pattern)) paths.push(normalizedBuildPath(match[1]));
  return [...new Set(paths)];
}

function fileBytes(path) {
  const absolute = join(distRoot, path);
  expect(existsSync(absolute), `dist/${path} must exist`).toBeTruthy();
  return statSync(absolute).size;
}

function shellEntryAssets(indexHtml) {
  return localAssetReferences(indexHtml).filter((path) => /\.(?:js|css)$/i.test(path));
}

test("production shell assets stay inside explicit raw-byte budgets", () => {
  expect(existsSync(distRoot), "dist is missing; run npm run build before this suite").toBeTruthy();
  const indexHtml = readDist("index.html");
  const entries = shellEntryAssets(indexHtml);
  const scripts = entries.filter((path) => path.endsWith(".js"));
  const styles = entries.filter((path) => path.endsWith(".css"));
  expect(scripts).toHaveLength(1);
  expect(styles).toHaveLength(1);

  const sizes = {
    indexHtml: fileBytes("index.html"),
    mainJavaScript: fileBytes(scripts[0]),
    mainCss: fileBytes(styles[0]),
  };
  const criticalAssets = new Set(["index.html", ...localAssetReferences(indexHtml)]);
  const criticalPath = [...criticalAssets].reduce((total, path) => total + fileBytes(path), 0);
  const worker = readDist("sw.js");
  const installAssets = new Set([...precachePaths(worker), "sw.js"]);
  const installShell = [...installAssets].reduce((total, path) => total + fileBytes(path), 0);

  expect(sizes.indexHtml, `index.html is ${sizes.indexHtml} bytes`).toBeLessThanOrEqual(budgets.indexHtml);
  expect(sizes.mainJavaScript, `${scripts[0]} is ${sizes.mainJavaScript} bytes`).toBeLessThanOrEqual(budgets.mainJavaScript);
  expect(sizes.mainCss, `${styles[0]} is ${sizes.mainCss} bytes`).toBeLessThanOrEqual(budgets.mainCss);
  expect(criticalPath, `initial local references use ${criticalPath} bytes`).toBeLessThanOrEqual(budgets.criticalPath);
  expect(installShell, `precache plus worker use ${installShell} bytes`).toBeLessThanOrEqual(budgets.installShell);
});

test("built shell has no blocking-script, chained-style, or manual-version regressions", () => {
  const htmlFiles = ["index.html", "login.html", "panel-test.html"];
  for (const htmlFile of htmlFiles) {
    const html = readDist(htmlFile);
    expect(html, `${htmlFile} must not contain a manually synchronized version query`).not.toMatch(/\?v=/i);
    expect(html, `${htmlFile} must not load remote shell resources`).not.toMatch(/<(?:script|link)\b[^>]+(?:src|href)=["'](?:https?:)?\/\//i);

    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const tag = match[0];
      const attributes = match[1];
      const body = match[2].trim();
      const source = tagAttribute(tag, "src");
      if (!source) {
        const mainEnd = html.indexOf("</main>");
        expect(
          match.index > mainEnd && mainEnd >= 0,
          `${htmlFile} contains an inline script before its visible shell has parsed`,
        ).toBeTruthy();
        expect(
          Buffer.byteLength(body),
          `${htmlFile} inline enhancement is large enough to become a startup task`,
        ).toBeLessThanOrEqual(2_048);
        continue;
      }
      const nonBlocking = /\btype\s*=\s*["']module["']/i.test(attributes)
        || /\b(?:defer|async)(?:\s|=|$)/i.test(attributes);
      expect(nonBlocking, `${htmlFile} loads a blocking script: ${tag}`).toBeTruthy();
      expect(normalizedBuildPath(source), `${htmlFile} script must be content hashed`).toMatch(/-[A-Za-z0-9_-]{6,}\.js$/);
    }

    for (const reference of localAssetReferences(html)) {
      expect(reference, `${htmlFile} references a versioned query instead of a content hash`).not.toContain("?v=");
      expect(existsSync(join(distRoot, reference)), `${htmlFile} references missing dist/${reference}`).toBeTruthy();
    }
  }

  const indexHtml = readDist("index.html");
  const stylesheetTags = [...indexHtml.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi)].map((match) => match[0]);
  expect(stylesheetTags).toHaveLength(1);
  const stylesheet = normalizedBuildPath(tagAttribute(stylesheetTags[0], "href"));
  expect(basename(stylesheet)).toMatch(/-[A-Za-z0-9_-]{6,}\.css$/);
  expect(readDist(stylesheet), "CSS @import creates a second render-blocking request chain").not.toMatch(/@import\s/i);
});

function performanceLibrary() {
  return Array.from({ length: 40 }, (_, index) => ({
    mangaId: 10_000 + index,
    mangaTitle: `Performance title ${index + 1}`,
    sourceId: 77,
    sourceLabel: "Performance Fixture",
    serverUrl: "http://performance-fixture.invalid:4567",
    ...(index % 2 === 0 ? {
      chapterId: 20_000 + index,
      chapterTitle: `Chapter ${index + 1}`,
      pageIndex: 2,
      panelIndex: 1,
      progressLabel: "Page 3, panel 2",
    } : {}),
    libraryStatus: index % 2 === 0 ? "reading" : "plan_to_read",
    statusExplicit: true,
    started: index % 2 === 0,
    hidden: false,
    pinned: index === 0,
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
  }));
}

async function installFastLocalBackend(page, library) {
  await page.addInitScript(({ items }) => {
    try { delete Navigator.prototype.serviceWorker; } catch { /* Service-worker timing is covered separately. */ }
    window.__phase8LongTasks = [];
    if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes("longtask")) {
      const observer = new PerformanceObserver((list) => {
        window.__phase8LongTasks.push(...list.getEntries().map((entry) => ({
          duration: entry.duration,
          startTime: entry.startTime,
        })));
      });
      observer.observe({ type: "longtask", buffered: true });
    }
    localStorage.setItem("panel-pilot-settings", JSON.stringify({
      baseUrl: "http://performance-fixture.invalid:4567",
      libraryFilter: "reading",
      readerMotion: "instant",
    }));
    localStorage.setItem("panel-pilot-library", JSON.stringify(items));
    localStorage.setItem("panel-pilot-tap-hint-seen", "1");
  }, { items: library });

  await page.route(/\/api(?:\/|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    if (url.pathname === "/api/library") {
      body = { items: library };
    } else if (url.pathname === "/api/download-buffer/status") {
      body = { downloaded: 0, failed: 0, queued: 0, windowSize: 0, windowChapters: [] };
    } else if (url.pathname === "/api/mangabaka/status") {
      body = { configured: false, connected: false };
    } else if (url.pathname === "/api/mangabaka/recommendations") {
      body = { results: [] };
    } else if (url.pathname === "/api/suwayomi/graphql") {
      const payload = request.postDataJSON() || {};
      const query = String(payload.query || "");
      let data = {};
      if (query.includes("HEALTH")) {
        data = { __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" } } };
      } else if (query.includes("GET_SOURCES_LIST")) {
        data = { sources: { nodes: [] } };
      } else if (query.includes("GET_LIBRARY_MANGAS")) {
        data = { mangas: { totalCount: 0, nodes: [] } };
      }
      body = { data };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test("mocked local startup and primary interactions stay inside practical paint budgets", async ({ page }) => {
  const library = performanceLibrary();
  await installFastLocalBackend(page, library);
  await page.goto("/", { waitUntil: "load" });
  await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
  await expect(page.locator(".library-card")).toHaveCount(20);

  const startup = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const tasks = window.__phase8LongTasks || [];
    return {
      domContentLoaded: navigation?.domContentLoadedEventEnd || Number.POSITIVE_INFINITY,
      load: navigation?.loadEventEnd || Number.POSITIVE_INFINITY,
      applicationReady: performance.now(),
      maximumLongTask: Math.max(0, ...tasks.map((entry) => Number(entry.duration) || 0)),
    };
  });
  expect(startup.domContentLoaded, JSON.stringify(startup)).toBeLessThanOrEqual(budgets.domContentLoadedMs);
  expect(startup.load, JSON.stringify(startup)).toBeLessThanOrEqual(budgets.loadMs);
  expect(startup.applicationReady, JSON.stringify(startup)).toBeLessThanOrEqual(budgets.applicationReadyMs);
  expect(startup.maximumLongTask, JSON.stringify(startup)).toBeLessThanOrEqual(budgets.startupLongTaskMs);

  const interactions = await page.evaluate(async () => {
    const paintedClick = async (selector) => {
      const target = document.querySelector(selector);
      const started = performance.now();
      target.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - started;
    };
    return {
      showAll: await paintedClick('[data-library-filter="all"]'),
      browse: await paintedClick("#nav-browse"),
      library: await paintedClick("#nav-library"),
      showReading: await paintedClick('[data-library-filter="reading"]'),
    };
  });
  await expect(page.locator(".library-card")).toHaveCount(20);
  await expect(page.locator("#library-view")).toHaveClass(/\bactive\b/);
  for (const [name, duration] of Object.entries(interactions)) {
    expect(duration, `${name} took ${duration.toFixed(1)}ms through two painted frames`).toBeLessThanOrEqual(budgets.interactionPaintMs);
  }
});
