import { expect, test } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";

test.use({ serviceWorkers: "block" });

const epubFixture = Buffer.from(
  readFileSync(new URL("./fixtures/alice-public-domain.epub.b64", import.meta.url), "utf8").trim(),
  "base64",
);
const epubReaderAsset = readdirSync(new URL("../dist/assets", import.meta.url))
  .find((name) => /^epub-reader-(?!engine).+\.js$/.test(name));

const book = {
  id: 1,
  title: "Alice's Adventures in Wonderland",
  subtitle: "",
  description: "A public-domain adventure.",
  authors: ["Lewis Carroll"],
  coverUrl: "",
  epubUrl: "/api/books/1/epub",
  hasEpub: true,
  libraryStatus: "plan_to_read",
  dateAdded: "2026-10-02T00:00:00Z",
  lastSyncedAt: "2026-10-02T00:00:00Z",
};

async function stubApp(page, {
  booksEnabled,
  queued = [],
  removed = [],
  progressState = { current: null },
  progressWrites = [],
  progressResponder = null,
  downloads = [],
  recommendations = null,
  releaseRecords = null,
  bookSearchQueries = [],
  preferenceResponder = null,
  preferenceWrites = [],
  account = null,
  suwayomiRequests = [],
  moments = [],
  momentWrites = [],
  seriesContext = null,
}) {
  let currentBook = { ...book, libraryStatus: progressState.current ? "reading" : book.libraryStatus };
  let currentPreferences = {
    theme: "light", fontFamily: "publisher", fontSize: 100, lineHeight: 1.5,
    contentWidth: 720, readingFlow: "paginated", textAlignment: "start",
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ account: account ?? {
          id: "local", username: "local", displayName: "Local reader", isAdmin: true,
          contentTypes: ["books", "manga", "comic", "webtoon"],
        } }),
      });
      return;
    }
    if (url.pathname === "/api/books/status") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          enabled: booksEnabled,
          shelfmarkConfigured: booksEnabled,
          cwaConfigured: booksEnabled,
          books: booksEnabled ? 1 : 0,
          activeDownloads: 0,
          lastSync: null,
          syncError: "",
        }),
      });
      return;
    }
    if (url.pathname === "/api/books") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ books: [{ ...currentBook, progress: progressState.current }], total: 1, limit: 200, offset: 0 }) });
      return;
    }
    if (url.pathname === "/api/books/1/library-status" && route.request().method() === "POST") {
      currentBook = { ...currentBook, libraryStatus: route.request().postDataJSON().status };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ book: currentBook }) });
      return;
    }
    if (url.pathname === "/api/books/1/progress" && route.request().method() === "POST") {
      const incoming = route.request().postDataJSON();
      progressWrites.push(incoming);
      if (progressResponder) {
        const response = await progressResponder({ incoming, index: progressWrites.length - 1 });
        if (response?.status && response.status >= 400) {
          await route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body || { error: "Offline" }) });
          return;
        }
      }
      progressState.current = { ...incoming, bookId: 1, revision: (progressState.current?.revision || 0) + 1, updatedAt: new Date().toISOString() };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ progress: progressState.current }) });
      return;
    }
    if (url.pathname === "/api/books/1/epub") {
      await route.fulfill({ status: 200, contentType: "application/epub+zip", body: epubFixture });
      return;
    }
    if (url.pathname === "/api/moments" && route.request().method() === "POST") {
      const incoming = route.request().postDataJSON();
      momentWrites.push(incoming);
      const moment = {
        ...incoming,
        id: `1760000000000-${String(momentWrites.length).padStart(16, "0")}`,
        mediaFormat: "book",
        isNsfw: false,
        createdAt: new Date().toISOString(),
        byteSize: String(incoming.quote || "").length,
      };
      moments.unshift(moment);
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ moment }) });
      return;
    }
    if (url.pathname === "/api/moments") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ moments }) });
      return;
    }
    if (url.pathname === "/api/books/preferences" || url.pathname === "/api/books/1/preferences") {
      if (route.request().method() === "POST") {
        const incoming = route.request().postDataJSON();
        preferenceWrites.push(incoming);
        if (preferenceResponder) {
          const response = await preferenceResponder({ incoming, index: preferenceWrites.length - 1 });
          if (response?.delay) await new Promise((resolve) => setTimeout(resolve, response.delay));
          if (response?.status && response.status >= 400) {
            await route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify({ error: response.error || "Preferences unavailable" }) });
            return;
          }
          currentPreferences = { ...currentPreferences, ...(response?.preferences || incoming) };
        } else {
          currentPreferences = { ...currentPreferences, ...incoming };
        }
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        preferences: currentPreferences,
        ...(url.pathname.includes("/1/") ? { scope: "book", scopeLabel: currentBook.title } : {}),
      }) });
      return;
    }
    if (url.pathname === "/api/books/1" && route.request().method() === "DELETE") {
      removed.push(1);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 1, removed: true }) });
      return;
    }
    if (url.pathname === "/api/books/1") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ book: currentBook, progress: progressState.current, series: seriesContext }) });
      return;
    }
    if (url.pathname === "/api/books/2/library" && route.request().method() === "POST") {
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ book: { id: 2, title: "Through the Looking-Glass", libraryStatus: "plan_to_read" } }) });
      return;
    }
    if (url.pathname === "/api/books/search") {
      bookSearchQueries.push(url.searchParams.get("query"));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ books: [{
        provider: "openlibrary", providerBookId: "OL123W", token: "opaque-book-token", title: "The Mercy of Gods",
        authors: ["James S. A. Corey"], isbn: "9780356517759", language: "en", publishedDate: "2024",
      }] }) });
      return;
    }
    if (url.pathname === "/api/book-recommendations") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        configured: true, status: "ready", mode: "personalized", results: recommendations ?? [{
          id: "librarything:mercy", title: "The Mercy of Gods", authors: ["James S. A. Corey"],
          coverUrl: "", identifiers: { isbn: ["9780356517759"] },
          reason: { type: "because_you_read", seedTitles: ["Leviathan Wakes"] },
        }],
      }) });
      return;
    }
    if (url.pathname === "/api/recommendations/similar") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        schemaVersion: 1,
        configured: true,
        status: "ready",
        provider: "librarything",
        seedTitle: "Alice's Adventures in Wonderland",
        results: [{
          id: "librarything-looking-glass", title: "Through the Looking-Glass", authors: ["Lewis Carroll"],
          coverUrl: "", identifiers: { isbn: ["9780141439648"] },
          reason: { type: "because_you_read", seedTitles: ["Alice's Adventures in Wonderland"] },
        }],
      }) });
      return;
    }
    if (url.pathname === "/api/books/releases") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ releases: releaseRecords ?? [{
        token: "opaque-release-token", id: "release-1", source: "direct_download",
        title: "The Mercy of Gods EPUB", language: "en", format: "EPUB", sizeBytes: 2_000_000,
      }] }) });
      return;
    }
    if (url.pathname === "/api/books/downloads" && route.request().method() === "POST") {
      queued.push(route.request().postDataJSON());
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ download: {
        taskId: "release-1", title: "The Mercy of Gods", status: "queued", progress: 0,
      } }) });
      return;
    }
    if (url.pathname === "/api/books/downloads") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ downloads }) });
      return;
    }
    if (url.pathname === "/api/library") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
      return;
    }
    if (url.pathname === "/api/suwayomi/graphql") {
      suwayomiRequests.push(route.request().postDataJSON?.() || {});
      const query = String(route.request().postDataJSON?.()?.query || "");
      const data = query.includes("HEALTH")
        ? { __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" } } }
        : query.includes("GET_SOURCES_LIST") ? { sources: { nodes: [] } } : {};
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

async function openEpubReader(page) {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  await page.locator(".book-library-card").getByRole("button", { name: /Alice's Adventures/ }).click();
  await page.getByRole("button", { name: "Read book" }).click();
  await expect(page.frameLocator(".epub-viewport iframe").locator("body")).toContainText("Alice was beginning");
}

test("books navigation disappears completely while the feature is disabled", async ({ page }) => {
  await stubApp(page, { booksEnabled: false });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#nav-books")).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/books-enabled/);
});

test("a books-only household account gets a private book-first shell", async ({ page }) => {
  const suwayomiRequests = [];
  await stubApp(page, {
    booksEnabled: true,
    account: {
      id: "acct_11111111111111111111111111111111", username: "reader2",
      displayName: "Reader Two", isAdmin: false, contentTypes: ["books"],
    },
    suwayomiRequests,
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("body")).toHaveAttribute("data-account-id", "acct_11111111111111111111111111111111");
  await expect(page.locator("body")).toHaveAttribute("data-visual-content", "false");
  await expect(page.locator("#nav-moments")).toBeVisible();
  await page.locator("#nav-settings").click();
  await expect(page.locator("#current-account-name")).toHaveText("Reader Two");
  await expect(page.locator("#account-administration")).toBeHidden();
  await expect(page.locator(".suwayomi-panel")).toBeHidden();
  await page.locator("#nav-browse").click();
  await expect(page).toHaveURL(/#books-search$/);
  await expect(page.getByRole("heading", { name: "Browse books" })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.locator("#network-status-title")).toHaveText("You’re offline");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#network-status-title")).toHaveText("Connection restored");
  await expect(page.locator("#network-status-banner")).not.toContainText("Suwayomi");
  expect(suwayomiRequests).toEqual([]);
});

test("enabled books join the main library and open an isolated detail view", async ({ page }) => {
  await stubApp(page, { booksEnabled: true });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#nav-books")).toBeHidden();
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  const bookCard = page.locator(".book-library-card");
  await expect(bookCard).toContainText("Book");
  await bookCard.getByRole("button", { name: /Alice's Adventures in Wonderland/ }).click();
  await expect(page).toHaveURL(/#book-detail\?id=1$/);
  await expect(page.locator(".book-detail h2")).toHaveText("Alice's Adventures in Wonderland");
  await expect(page.locator(".book-detail .primary-button")).toBeEnabled();
  await expect(page.locator(".book-about")).toContainText("A public-domain adventure.");
  await expect(page.locator(".book-contents-list .epub-toc-link").first()).toBeVisible();
  await page.getByLabel("Library group", { exact: true }).selectOption("paused");
  await expect(page.getByLabel("Library group", { exact: true })).toHaveValue("paused");
  await page.locator("#nav-settings").click();
  await expect(page.locator("#book-services-panel")).toBeVisible();
  await expect(page.locator("#book-services-note")).toContainText("Shelfmark ready");
});

test("book details show reading order and add the next shared-catalogue volume instantly", async ({ page }) => {
  await stubApp(page, {
    booksEnabled: true,
    seriesContext: {
      name: "Alice",
      currentBookId: 1,
      missingPositions: [3],
      items: [
        { ...book, seriesName: "Alice", seriesPosition: 1, inLibrary: true },
        { id: 2, title: "Through the Looking-Glass", seriesName: "Alice", seriesPosition: 2, inLibrary: false, libraryStatus: "", hasEpub: true },
      ],
    },
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  await page.locator(".book-library-card").getByRole("button", { name: /Alice's Adventures/ }).click();
  await expect(page.locator(".book-series-panel")).toContainText("Missing from the shared catalogue: volume 3");
  await expect(page.locator(".book-series-panel")).toContainText("Through the Looking-Glass");
  await page.locator(".book-series-item").filter({ hasText: "Through the Looking-Glass" }).getByRole("button", { name: "Add" }).click();
  await expect(page).toHaveURL(/#book-detail\?id=2$/);
});

test("a selected book passage saves to Moments and reopens at its exact EPUB location", async ({ page }) => {
  const moments = [];
  const momentWrites = [];
  await stubApp(page, { booksEnabled: true, moments, momentWrites });
  await openEpubReader(page);

  const paragraph = page.frameLocator(".epub-viewport iframe").locator("p").filter({ hasText: "Alice was beginning" }).first();
  await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByRole("button", { name: "Save highlight" })).toBeVisible();
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.locator(".epub-lookup-dialog")).toBeVisible();
  await expect(page.locator(".epub-lookup-copy")).toContainText("Alice was beginning");
  await page.locator(".epub-lookup-dialog").getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Save highlight" }).click();
  await expect(page.locator(".epub-reader-notice")).toContainText("Highlight saved to Moments");
  expect(momentWrites).toHaveLength(1);
  expect(momentWrites[0]).toMatchObject({
    momentType: "text",
    bookId: 1,
    title: "Alice's Adventures in Wonderland",
  });
  expect(momentWrites[0].quote).toContain("Alice was beginning");
  expect(momentWrites[0].locator).toMatch(/^epubcfi\(/);

  await page.locator(".epub-back").click();
  await page.locator("#nav-moments").click();
  await expect(page.locator("#moments-grid .moment-card-text")).toContainText("Alice was beginning");
  await expect(page.locator("#moments-grid").getByRole("button", { name: "Read from here" })).toBeVisible();
  await page.locator("#moments-grid").getByRole("button", { name: "Read from here" }).click();
  await expect(page).toHaveURL(/#book-read\?id=1&href=epubcfi/);
  await expect(page.frameLocator(".epub-viewport iframe").locator("body")).toContainText("Alice was beginning");
});

test("Moments filter, browse book highlights, and share a local quote card", async ({ page }) => {
  const moments = [
    { id: "book-a", momentType: "text", mediaFormat: "book", bookId: 1, title: "Alice's Adventures in Wonderland", chapterTitle: "Chapter I", quote: "Alice was beginning to get very tired.", locator: "epubcfi(/6/2!/4/2/1:0)", createdAt: "2026-10-03T00:00:00Z" },
    { id: "book-b", momentType: "text", mediaFormat: "book", bookId: 1, title: "Alice's Adventures in Wonderland", chapterTitle: "Chapter II", quote: "The Rabbit actually took a watch out of its waistcoat-pocket.", locator: "epubcfi(/6/4!/4/2/1:0)", createdAt: "2026-10-03T01:00:00Z" },
    { id: "panel-a", momentType: "image", mediaFormat: "manga", title: "Kingdom", chapterTitle: "Chapter 1", imageUrl: "/api/moments/panel-a/image", width: 100, height: 200, byteSize: 100, createdAt: "2026-10-03T02:00:00Z" },
  ];
  await stubApp(page, { booksEnabled: true, moments });
  await page.addInitScript(() => { window.__quoteShares = []; navigator.share = async (payload) => { window.__quoteShares.push(payload); }; navigator.canShare = () => true; });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#nav-moments").click();
  await expect(page.locator(".moments-collection-heading")).toHaveText([/Book highlights/, /Panel moments/]);
  await page.getByRole("button", { name: "Highlights", exact: true }).click();
  await expect(page.locator(".moments-collection")).toHaveCount(1);
  await page.getByRole("button", { name: "Read highlights" }).click();
  await expect(page.locator("#highlight-browser")).toContainText("Highlight 1 of 2");
  await page.locator("#highlight-browser").getByRole("button", { name: "Next ›" }).click();
  await expect(page.locator("#highlight-browser")).toContainText("Highlight 2 of 2");
  await page.locator("#highlight-browser").getByRole("button", { name: "Share quote card" }).click();
  await expect.poll(() => page.evaluate(() => window.__quoteShares.length)).toBe(1);
  await expect(page.locator("#highlight-browser").getByRole("button", { name: "Close" })).toBeVisible();
});

test("Library home brings together resume, rediscovery, and the next recommendation", async ({ page }) => {
  const moments = [{ id: "home-highlight", momentType: "text", mediaFormat: "book", bookId: 1, title: "Alice's Adventures in Wonderland", chapterTitle: "Chapter I", quote: "Alice was beginning to get very tired.", locator: "epubcfi(/6/2!/4/2/1:0)", createdAt: "2026-10-03T00:00:00Z" }];
  await stubApp(page, { booksEnabled: true, moments, progressState: { current: { locator: "epubcfi(/6/2!/4/2/1:0)", progression: 0.2, updatedAt: "2026-10-03T01:00:00Z" } } });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#smart-home-rail")).toContainText("Continue");
  await expect(page.locator("#smart-home-rail")).toContainText("Rediscover");
  await expect(page.locator("#smart-home-rail")).toContainText("Try next");
  await page.locator("#smart-home-rail [data-kind='moment']").click();
  await expect(page.locator("#moments-view")).toBeVisible();
  await expect(page.locator("#moment-rediscovery-card")).toContainText("Alice was beginning");
});

test("books join the main Library filters without entering manga storage", async ({ page }) => {
  await stubApp(page, { booksEnabled: true });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#library-format-books")).toBeVisible();
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  const card = page.locator(".book-library-card");
  await expect(card).toContainText("Book");
  await expect(card).toContainText("Plan to read");
  await card.getByRole("button", { name: /Alice's Adventures in Wonderland/ }).click();
  await expect(page).toHaveURL(/#book-detail\?id=1$/);
});

test("the unified Library search finds books by title or author", async ({ page }) => {
  await stubApp(page, { booksEnabled: true });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Plan/ }).click();
  const search = page.getByRole("searchbox", { name: "Search library" });
  await search.fill("Lewis Carroll");
  await expect(page.locator(".book-library-card")).toHaveCount(1);
  await expect(page.locator("#library-count")).toHaveText("1 match");
  await search.fill("unrelated author");
  await expect(page.locator(".book-library-card")).toHaveCount(0);
  await expect(page.locator("#library-list")).toContainText("No matching titles");
});

test("global Continue Reading resumes the most recent EPUB position", async ({ page }) => {
  const progressState = { current: {
    bookId: 1,
    locatorType: "cfi",
    locator: "epubcfi(/6/2!/4/2/1:0)",
    resourceHref: "chapter1.xhtml",
    progression: 0.42,
    revision: 1,
    updatedAt: "2026-10-02T12:00:00Z",
  } };
  await stubApp(page, { booksEnabled: true, progressState });
  await page.goto("/", { waitUntil: "networkidle" });
  const resume = page.locator("#nav-reader");
  await expect(resume).toBeVisible();
  await expect(resume).toContainText("Alice's Adventures in Wonderland");
  await expect(resume).toContainText("42% read");
  await resume.click();
  await expect(page).toHaveURL(/#book-read\?id=1$/);
  await expect(page.locator(".epub-reader")).toBeVisible();
});

test("Shelfmark acquisition offers only normalized EPUB choices and queues an opaque token", async ({ page }) => {
  const queued = [];
  await stubApp(page, { booksEnabled: true, queued });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#nav-browse").click();
  await page.locator(".browse-media-switch").getByRole("button", { name: "Books" }).click();
  await expect(page).toHaveURL(/#books-search$/);
  await expect(page.locator(".books-content .browse-media-switch").getByRole("button", { name: "Books" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("searchbox", { name: "Book title or author" }).fill("The Mercy of Gods");
  await page.locator(".books-search-form").getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: /The Mercy of Gods/ }).click();
  await expect(page.locator(".book-release-row")).toContainText("EPUB");
  await expect(page.locator(".book-release-row")).not.toContainText("PDF");
  await page.getByRole("button", { name: "Add to Library" }).click();
  await expect.poll(() => queued.length).toBe(1);
  expect(queued[0].releaseToken).toBe("opaque-release-token");
  expect(queued[0].bookToken).toBe("opaque-book-token");
  expect(JSON.stringify(queued[0])).not.toContain("download_url");
  expect(queued[0].book).toBeUndefined();
});

test("failed Shelfmark records are identified and untried alternatives are offered first", async ({ page }) => {
  const releaseRecords = [{
    token: "untried-token", source: "direct_download", title: "The Bright Sword",
    language: "en", format: "EPUB", sizeBytes: 3_670_016, downloads: 98,
    publisher: "Penguin Publishing Group", publishedYear: "2024", attemptStatus: "", attemptError: "",
    catalogSource: "libgen", score: 91, recommendation: "Recommended",
    scoreReasons: ["English match", "Edition metadata available"],
    sourceReliability: { attempts: 4, successes: 3 },
  }, {
    token: "failed-token", source: "direct_download", title: "The Bright Sword : A Novel of King Arthur",
    language: "en", format: "EPUB", sizeBytes: 10_000_000, downloads: 1466,
    publisher: "Penguin Random House", publishedYear: "2024", attemptStatus: "failed",
    attemptError: "No configured Shelfmark mirror could retrieve this EPUB",
    attemptErrorAction: "Choose another release; this one is unlikely to succeed on an immediate retry.",
    catalogSource: "annas_archive", score: 82, recommendation: "Previously failed",
    scoreReasons: ["English match"], sourceReliability: { attempts: 2, successes: 0 },
  }];
  await stubApp(page, { booksEnabled: true, releaseRecords });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#nav-browse").click();
  await page.locator(".browse-media-switch").getByRole("button", { name: "Books" }).click();
  await page.getByRole("searchbox", { name: "Book title or author" }).fill("The Mercy of Gods");
  await page.locator(".books-search-form").getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: /The Mercy of Gods/ }).click();
  const rows = page.locator(".book-release-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("3.5 MB");
  await expect(rows.first()).toContainText("Recommended");
  await expect(rows.first()).toContainText("91/100");
  await expect(rows.first()).toContainText("3/4 successful here");
  await expect(rows.first()).toContainText("Untried");
  await expect(rows.last()).toContainText("No configured Shelfmark mirror");
  await expect(rows.last()).toContainText("Choose another release");
  await expect(rows.last().getByRole("button")).toHaveText("Retry this record");
  await expect(page.locator(".books-release-note")).toContainText("Untried EPUB records are shown first");
});

test("Books for you enters the normal Shelfmark edition and release flow", async ({ page }) => {
  const bookSearchQueries = [];
  await stubApp(page, { booksEnabled: true, bookSearchQueries });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#nav-browse").click();
  await page.locator(".browse-media-switch").getByRole("button", { name: "Books" }).click();
  await expect(page.locator(".book-recommendation-card")).toContainText("Because you read Leviathan Wakes");
  await page.locator(".book-recommendation-card").getByRole("button", { name: "Read this" }).click();
  await expect(page.getByRole("searchbox", { name: "Book title or author" })).toHaveValue("The Mercy of Gods");
  await expect.poll(() => bookSearchQueries.at(-1)).toBe("9780356517759");
  await expect(page.getByRole("button", { name: /The Mercy of Gods/ })).toBeVisible();
});

test("book details can find related titles and enter the normal acquisition flow", async ({ page }) => {
  const bookSearchQueries = [];
  await stubApp(page, { booksEnabled: true, bookSearchQueries });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  await page.locator(".book-library-card").getByRole("button", { name: /Alice's Adventures/ }).click();
  await page.getByRole("button", { name: "More like this" }).click();
  const dialog = page.getByRole("dialog", { name: /More like Alice/ });
  await expect(dialog).toContainText("Through the Looking-Glass");
  await dialog.getByRole("button", { name: "Find this book" }).click();
  await expect(page).toHaveURL(/#books-search\?/);
  await expect(page.getByRole("searchbox", { name: "Book title or author" })).toHaveValue("Through the Looking-Glass");
  await expect.poll(() => bookSearchQueries.at(-1)).toBe("9780141439648");
});

test("book Browse keeps recommendations separate and shows only useful acquisition activity", async ({ page }) => {
  const now = Date.now();
  const recommendations = ["The Faith of Beasts", "Leviathan Wakes", "Shroud"].map((title, index) => ({
    id: `recommendation-${index}`,
    title,
    authors: [index === 2 ? "Adrian Tchaikovsky" : "James S. A. Corey"],
    coverUrl: "",
    reason: { type: "because_you_read", seedTitles: ["The Mercy of Gods"] },
  }));
  const downloads = [
    { taskId: "active", title: "Active Book", status: "downloading", progress: 0.42, updatedAt: new Date(now).toISOString() },
    { taskId: "recent", title: "Recent Book", status: "ready", bookId: 1, progress: 1, updatedAt: new Date(now - 5 * 60_000).toISOString() },
    { taskId: "failed", title: "Failed Book", status: "failed", error: "Source failed", updatedAt: new Date(now - 2 * 60_000).toISOString() },
    { taskId: "old", title: "Old Ready Book", status: "ready", bookId: 1, progress: 1, updatedAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    { taskId: "cancelled", title: "Cancelled Book", status: "cancelled", updatedAt: new Date(now).toISOString() },
  ];
  await stubApp(page, { booksEnabled: true, recommendations, downloads });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#nav-browse").click();
  await page.locator(".browse-media-switch").getByRole("button", { name: "Books" }).click();

  await expect(page.locator("#books-connection")).toHaveCount(0);
  await expect(page.locator(".books-content > .books-back")).toHaveCount(0);
  const cards = page.locator(".book-recommendation-card");
  await expect(cards).toHaveCount(3);
  const bounds = await cards.evaluateAll((items) => items.map((item) => item.getBoundingClientRect()).map((rect) => ({ left: rect.left, right: rect.right })));
  expect(bounds[0].right).toBeLessThanOrEqual(bounds[1].left + 0.5);
  expect(bounds[1].right).toBeLessThanOrEqual(bounds[2].left + 0.5);
  const actionBounds = await cards.evaluateAll((items) => items.map((item) => {
    const card = item.getBoundingClientRect();
    const button = item.querySelector("button").getBoundingClientRect();
    return { cardLeft: card.left, cardRight: card.right, buttonLeft: button.left, buttonRight: button.right };
  }));
  actionBounds.forEach((item) => {
    expect(item.buttonLeft).toBeGreaterThanOrEqual(item.cardLeft - 0.5);
    expect(item.buttonRight).toBeLessThanOrEqual(item.cardRight + 0.5);
  });

  await expect(page.locator(".books-downloads h2")).toHaveText("Acquisition activity");
  await expect(page.locator(".books-downloads")).toContainText("Active Book");
  await expect(page.locator(".books-downloads")).toContainText("Downloading · 42%");
  await expect(page.locator(".books-downloads")).toContainText("Recent Book");
  await expect(page.locator(".books-downloads")).toContainText("Failed Book");
  await page.getByRole("button", { name: "Find another release" }).click();
  await expect(page.getByRole("searchbox", { name: "Book title or author" })).toHaveValue("Failed Book");
  await expect(page.locator(".books-downloads")).not.toContainText("Old Ready Book");
  await expect(page.locator(".books-downloads")).not.toContainText("Cancelled Book");
});

test("a book can be removed from Panel Pilot without deleting CWA", async ({ page }) => {
  const removed = [];
  await stubApp(page, { booksEnabled: true, removed });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  await page.locator(".book-library-card").getByRole("button", { name: /Alice's Adventures/ }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove from library" }).click();
  await expect.poll(() => removed).toEqual([1]);
  await expect(page).toHaveURL(/#library$/);
});

test("EPUB reader opens a public-domain fixture and persists an exact CFI", async ({ page }) => {
  const progressWrites = [];
  const progressState = { current: null };
  await stubApp(page, { booksEnabled: true, progressWrites, progressState });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  await page.locator(".book-library-card").getByRole("button", { name: /Alice's Adventures/ }).click();
  await page.getByRole("button", { name: "Read book" }).click();
  await expect(page).toHaveURL(/#book-read\?id=1$/);
  await expect(page.locator(".epub-reader")).toBeVisible();
  await expect(page.locator(".epub-reader-title")).toHaveText("Alice's Adventures in Wonderland");
  await expect(page.frameLocator(".epub-viewport iframe").locator("body")).toContainText("Alice was beginning to get very tired");
  await expect(page.getByRole("slider", { name: "Book progress" })).toBeEnabled({ timeout: 10_000 });
  await expect(page.locator(".epub-progress-location")).toHaveText(/\d+% \(\d+\/\d+\)/);
  await expect(page.locator(".epub-time-remaining")).toHaveText(/(?:page|End of)/);
  await expect(page.locator(".epub-time-remaining")).not.toContainText("Generating");
  await expect(page.frameLocator(".epub-viewport iframe").locator("[data-panels-section-heading]").first()).toHaveText("Down the Rabbit-Hole");
  await expect.poll(() => page.frameLocator(".epub-viewport iframe").locator("[data-panels-section-heading]").first().evaluate((heading) => getComputedStyle(heading).display)).toBe("block");
  await page.getByRole("button", { name: "Contents" }).click();
  await expect(page.locator(".epub-toc")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  const epubBody = page.frameLocator(".epub-viewport iframe").locator("body");
  await epubBody.evaluate(() => {
    CSSStyleSheet.prototype.insertRule = () => { throw new Error("Safari stylesheet is not attached"); };
  });
  await page.locator(".epub-settings summary").click();
  await page.getByLabel("Theme").selectOption("sepia");
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-theme", "sepia");
  await expect.poll(() => epubBody.evaluate((body) => body.style.background)).not.toBe("");
  await page.getByLabel("Text size").selectOption("130");
  await expect.poll(() => epubBody.evaluate((body) => body.style.fontSize)).toBe("130%");
  await expect(page.locator(".epub-reader-state")).toBeHidden();
  await page.locator(".epub-settings summary").click();
  await expect.poll(() => progressWrites.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(progressWrites.at(-1).locatorType).toBe("cfi");
  expect(progressWrites.at(-1).locator).toMatch(/^epubcfi\(/);
  expect(progressWrites.at(-1).revision).toBe(0);

  await page.getByRole("button", { name: "Books", exact: false }).first().click();
  await expect(page).toHaveURL(/#book-detail\?id=1$/);
  await expect(page.getByRole("button", { name: "Continue reading" })).toBeVisible();
  const writesBeforeReopen = progressWrites.length;
  await page.getByRole("button", { name: "Continue reading" }).click();
  await expect(page.frameLocator(".epub-viewport iframe").locator("body")).toContainText("Alice was beginning to get very tired");
  await expect.poll(() => progressWrites.length, { timeout: 10_000 }).toBeGreaterThan(writesBeforeReopen);
  expect(progressWrites.at(-1).revision).toBeGreaterThanOrEqual(1);
});

test("books library and EPUB controls remain usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApp(page, { booksEnabled: true });
  await page.goto("/", { waitUntil: "networkidle" });
  const navLayout = await page.locator(".app-nav").evaluate((nav) => ({
    columns: getComputedStyle(nav).gridTemplateColumns.split(" ").length,
    visibleButtons: [...nav.querySelectorAll(".app-nav-button")].filter((button) => !button.hidden).length,
  }));
  expect(navLayout).toEqual({ columns: 5, visibleButtons: 5 });
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  await expect(page.locator(".book-library-card")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator(".book-library-card").getByRole("button", { name: /Alice's Adventures/ }).click();
  await page.getByRole("button", { name: "Read book" }).click();
  await expect(page.locator(".epub-toolbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page" })).toHaveText("");
  await expect.poll(() => page.getByRole("button", { name: "Next page" }).evaluate((button) => ({
    opacity: getComputedStyle(button).opacity,
    height: button.getBoundingClientRect().height,
  }))).toMatchObject({ opacity: "0", height: expect.any(Number) });
  await page.locator(".epub-settings summary").click();
  await expect(page.getByLabel("Page width")).toBeVisible();
  await page.getByLabel("Page width").selectOption("1200");
  const fullWidth = await page.locator(".epub-viewport").evaluate((viewport) => viewport.getBoundingClientRect().width);
  await page.getByLabel("Page width").selectOption("560");
  await expect.poll(() => page.locator(".epub-viewport").evaluate((viewport) => viewport.getBoundingClientRect().width)).toBeLessThan(fullWidth - 40);
  await expect.poll(() => page.locator(".epub-settings-panel").evaluate((panel) => ({
    background: getComputedStyle(panel).backgroundColor,
    position: getComputedStyle(panel).position,
  }))).toEqual({ background: "rgb(255, 255, 255)", position: "fixed" });
  await expect.poll(() => page.locator(".epub-reader").evaluate((reader) => {
    const panel = reader.querySelector(".epub-settings-panel");
    const footer = reader.querySelector(".epub-footer");
    const bounds = footer.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return panel.contains(hit);
  })).toBe(true);
  await page.locator(".epub-settings-panel").evaluate((panel) => {
    const top = panel.getBoundingClientRect().top;
    const dispatch = (type, y) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const touches = type === "touchend" ? [] : [{ clientX: 190, clientY: y }];
      Object.defineProperty(event, "touches", { value: touches });
      Object.defineProperty(event, "changedTouches", { value: [{ clientX: 190, clientY: y }] });
      panel.dispatchEvent(event);
    };
    dispatch("touchstart", top + 20);
    dispatch("touchmove", top + 100);
    dispatch("touchend", top + 100);
  });
  await expect(page.locator(".epub-settings")).not.toHaveAttribute("open", "");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("every EPUB preference value applies and combinations survive reflow", async ({ page }) => {
  await stubApp(page, { booksEnabled: true });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  await page.locator(".book-library-card").getByRole("button", { name: /Alice's Adventures/ }).click();
  await page.getByRole("button", { name: "Read book" }).click();
  await expect(page.frameLocator(".epub-viewport iframe").locator("body")).toContainText("Alice was beginning");
  await page.locator(".epub-settings summary").click();
  const cases = [
    ["Theme", ["light", "sepia", "dark"]],
    ["Typeface", ["publisher", "serif", "sans"]],
    ["Text size", ["85", "100", "115", "130", "150"]],
    ["Line spacing", ["1.3", "1.5", "1.8", "2"]],
    ["Page width", ["560", "720", "900", "1200"]],
    ["Alignment", ["start", "left", "justify"]],
  ];
  for (const [label, values] of cases) {
    for (const value of values) {
      await page.getByLabel(label).selectOption(value);
      await expect(page.getByLabel(label)).toHaveValue(value);
      await expect(page.locator(".epub-reader-state")).toBeHidden();
    }
  }
  for (const flow of ["scrolled", "paginated"]) {
    await page.getByLabel("Reading flow").selectOption(flow);
    await expect(page.locator(".epub-reader")).toHaveAttribute("data-flow", flow);
    await expect(page.frameLocator(".epub-viewport iframe").locator("body")).toContainText("Alice was beginning");
  }
  const body = page.frameLocator(".epub-viewport iframe").locator("body");
  await expect.poll(() => body.evaluate((element) => ({
    font: element.style.fontFamily,
    size: element.style.fontSize,
    lineHeight: element.style.lineHeight,
    alignment: element.style.textAlign,
  }))).toEqual({ font: "system-ui, sans-serif", size: "150%", lineHeight: "2", alignment: "justify" });
});

test("centre taps toggle overlay controls without resizing or repaginating the EPUB", async ({ page }) => {
  await stubApp(page, { booksEnabled: true });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  await page.locator(".book-library-card").getByRole("button", { name: /Alice's Adventures/ }).click();
  await page.getByRole("button", { name: "Read book" }).click();
  const body = page.frameLocator(".epub-viewport iframe").locator("body");
  await expect(body).toContainText("Alice was beginning");
  const readerGeometry = () => page.locator(".epub-reader").evaluate((reader) => {
    const stage = reader.querySelector(".epub-stage").getBoundingClientRect();
    const viewport = reader.querySelector(".epub-viewport").getBoundingClientRect();
    return { stage: [stage.x, stage.y, stage.width, stage.height], viewport: [viewport.x, viewport.y, viewport.width, viewport.height] };
  });
  const initialGeometry = await readerGeometry();
  await page.getByRole("button", { name: "Hide reader controls from page centre" }).click();
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "false");
  await expect.poll(() => page.locator(".epub-reader").evaluate((reader) => {
    const stage = reader.querySelector(".epub-stage");
    return Math.abs(stage.getBoundingClientRect().height - reader.getBoundingClientRect().height);
  })).toBeLessThan(2);
  expect(await readerGeometry()).toEqual(initialGeometry);
  await page.getByRole("button", { name: "Show reader controls from page centre" }).click();
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "true");
  expect(await readerGeometry()).toEqual(initialGeometry);

  await page.waitForTimeout(500);
  await body.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    element.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: view.innerWidth / 2,
      clientY: view.innerHeight / 2,
    }));
  });
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "false");

  await page.waitForTimeout(500);
  await body.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    const dispatch = (type, touches, changedTouches = touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: touches });
      Object.defineProperty(event, "changedTouches", { value: changedTouches });
      element.dispatchEvent(event);
    };
    const touch = { clientX: view.innerWidth / 2, clientY: view.innerHeight / 2 };
    dispatch("touchstart", [touch]);
    dispatch("touchend", [], [touch]);
  });
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "true");
  await page.waitForTimeout(500);
  await body.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    const dispatch = (type, touches, changedTouches = touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: touches });
      Object.defineProperty(event, "changedTouches", { value: changedTouches });
      element.dispatchEvent(event);
    };
    const touch = { clientX: view.innerWidth / 2, clientY: view.innerHeight / 2 };
    dispatch("touchstart", [touch]);
    dispatch("touchend", [], [touch]);
  });
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "false");
});

test("fullscreen falls back to distraction-free controls on unsupported browsers", async ({ page }) => {
  await stubApp(page, { booksEnabled: true });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  await page.locator(".book-library-card").getByRole("button", { name: /Alice's Adventures/ }).click();
  await page.getByRole("button", { name: "Read book" }).click();
  await expect(page.frameLocator(".epub-viewport iframe").locator("body")).toContainText("Alice was beginning");
  const fullscreen = page.locator(".epub-fullscreen");
  await fullscreen.evaluate((button) => {
    Object.defineProperty(button.closest(".epub-reader"), "requestFullscreen", { value: undefined, configurable: true });
    Object.defineProperty(button.closest(".epub-reader"), "webkitRequestFullscreen", { value: undefined, configurable: true });
  });
  await fullscreen.click();
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "false");
  await expect(page.locator(".epub-time-remaining")).not.toContainText("not available");
});

test("EPUB mobile chrome meets touch targets and themed dialogs remain readable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApp(page, { booksEnabled: true });
  await openEpubReader(page);

  const targetHeights = await page.locator(".epub-toolbar .epub-tool").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
  expect(targetHeights.every((height) => height >= 44)).toBe(true);

  await page.locator(".epub-settings summary").click();
  await page.getByLabel("Theme").selectOption("dark");
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-theme", "dark");
  await page.locator(".epub-settings summary").click();
  await page.getByRole("button", { name: "Contents" }).click();
  await expect.poll(() => page.locator(".epub-toc").evaluate((dialog) => ({
    background: getComputedStyle(dialog).backgroundColor,
    color: getComputedStyle(dialog).color,
  }))).toEqual({ background: "rgb(23, 25, 24)", color: "rgb(228, 229, 223)" });
  await page.getByRole("button", { name: "Close" }).click();

  const fullscreen = page.locator(".epub-fullscreen");
  await fullscreen.evaluate((button) => {
    Object.defineProperty(button.closest(".epub-reader"), "requestFullscreen", { value: undefined, configurable: true });
    Object.defineProperty(button.closest(".epub-reader"), "webkitRequestFullscreen", { value: undefined, configurable: true });
  });
  await fullscreen.click();
  await expect(fullscreen).toHaveText("Focus");
  await expect(fullscreen).toHaveAttribute("aria-label", "Enter distraction-free reading");
});

test("nested EPUB contents preserve their hierarchy", async ({ page }) => {
  await page.goto("/panel-test.html");
  await page.evaluate(async (asset) => {
    const { renderEpubToc } = await import(`/assets/${asset}`);
    const host = document.createElement("nav");
    host.id = "toc-test-host";
    document.body.append(host);
    renderEpubToc([{ label: "Part one", href: "part.xhtml", subitems: [
      { label: "Chapter one", href: "chapter.xhtml", subitems: [{ label: "Scene one", href: "scene.xhtml" }] },
    ] }], host, () => {});
  }, epubReaderAsset);
  await expect(page.locator("#toc-test-host > .epub-toc-root > .epub-toc-item > .epub-toc-children")).toHaveCount(1);
  await expect(page.locator("#toc-test-host .epub-toc-children .epub-toc-children")).toHaveCount(1);
  await expect(page.locator("#toc-test-host .epub-toc-link")).toHaveText(["Part one", "Chapter one", "Scene one"]);
});

test("EPUB book menu searches full text and organizes saved highlights by chapter", async ({ page }) => {
  const moments = [{
    id: "book-highlight-1", momentType: "text", mediaFormat: "book", bookId: 1,
    title: "Alice's Adventures in Wonderland", chapterTitle: "Chapter I",
    quote: "Alice was beginning to get very tired", locator: "epubcfi(/6/2!/4/2/1:0)",
    resourceHref: "chapter1.xhtml", progression: 0.02,
  }];
  await stubApp(page, { booksEnabled: true, moments });
  await openEpubReader(page);
  await page.getByRole("button", { name: "Contents" }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search this book" }).fill("Alice");
  await page.locator(".epub-search-form").getByRole("button", { name: "Search" }).click();
  await expect(page.locator(".epub-search-status")).toContainText(/match/i);
  await expect(page.locator(".epub-search-result").first()).toContainText(/Alice/i);
  await page.getByRole("button", { name: "Highlights" }).click();
  await expect(page.locator(".epub-highlight-group")).toContainText("Chapter I");
  await expect(page.locator(".epub-highlight-link")).toContainText("Alice was beginning");
});

test("book details explicitly download and remove an account-scoped offline EPUB", async ({ page }) => {
  await stubApp(page, { booksEnabled: true });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  await page.locator(".book-library-card").getByRole("button", { name: /Alice's Adventures/ }).click();
  const offline = page.getByRole("button", { name: "Download for offline" });
  await expect(offline).toBeVisible();
  await offline.click();
  await expect(page.getByRole("button", { name: "Remove offline copy" })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const cache = await caches.open("panels-offline-books-v1");
    return (await cache.keys()).some((request) => request.url.includes("/api/books/1/epub?offlineAccount=local"));
  })).toBe(true);
  await page.getByRole("button", { name: "Remove offline copy" }).click();
  await expect(page.getByRole("button", { name: "Download for offline" })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const cache = await caches.open("panels-offline-books-v1");
    return (await cache.keys()).length;
  })).toBe(0);
});

test("a cold offline launch reconstructs the saved book and opens its cached EPUB", async ({ page }) => {
  await stubApp(page, { booksEnabled: true });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  await page.locator(".book-library-card").getByRole("button", { name: /Alice's Adventures/ }).click();
  await page.getByRole("button", { name: "Download for offline" }).click();
  await expect(page.getByRole("button", { name: "Remove offline copy" })).toBeVisible();
  await page.locator("#nav-library").click();
  await page.unroute("**/api/**");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /^Books$/ }).first()).toBeVisible();
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  await expect(page.locator(".book-library-card")).toContainText("Alice's Adventures in Wonderland");
  await page.locator(".book-library-card").getByRole("button", { name: /Alice's Adventures/ }).click();
  await page.getByRole("button", { name: /Read book|Continue reading/ }).click();
  await expect(page.frameLocator(".epub-viewport iframe").locator("body")).toContainText("Alice was beginning");
});

test("EPUB preferences are latest-wins and failed changes revert without blocking reading", async ({ page }) => {
  let failNext = false;
  const preferenceWrites = [];
  await stubApp(page, {
    booksEnabled: true,
    preferenceWrites,
    preferenceResponder: async ({ incoming, index }) => {
      if (failNext) {
        failNext = false;
        return { status: 503, error: "Temporarily unavailable" };
      }
      return { delay: index === 0 ? 350 : 0, preferences: incoming };
    },
  });
  await openEpubReader(page);
  await page.locator(".epub-settings summary").click();
  await page.getByLabel("Theme").selectOption("dark");
  await page.getByLabel("Theme").selectOption("sepia");
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-theme", "sepia");
  await page.waitForTimeout(450);
  await expect(page.getByLabel("Theme")).toHaveValue("sepia");

  failNext = true;
  await page.getByLabel("Text size").selectOption("130");
  await expect(page.getByLabel("Text size")).toHaveValue("100");
  await expect(page.locator(".epub-reader-notice")).toContainText("previous setting has been restored");
  await expect(page.locator(".epub-reader-state")).toBeHidden();

  await page.getByLabel("Theme").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".epub-settings")).not.toHaveAttribute("open", "");
  await expect(page.locator(".epub-settings summary")).toBeFocused();
});

test("EPUB iframe keyboard navigation, cancelled gestures, and lifecycle flush stay reliable", async ({ page }) => {
  const progressWrites = [];
  await stubApp(page, { booksEnabled: true, progressWrites });
  await openEpubReader(page);
  await expect.poll(() => progressWrites.length).toBeGreaterThan(0);
  progressWrites.length = 0;
  const body = page.frameLocator(".epub-viewport iframe").locator("body");
  await body.press("ArrowRight");
  await expect.poll(() => progressWrites.length, { timeout: 3000 }).toBeGreaterThan(0);

  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "true");
  await body.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    const options = { bubbles: true, clientX: view.innerWidth / 2, clientY: view.innerHeight / 2, pointerId: 5 };
    element.dispatchEvent(new PointerEvent("pointerdown", options));
    element.dispatchEvent(new PointerEvent("pointercancel", options));
    element.dispatchEvent(new PointerEvent("pointerup", options));
  });
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "true");

  progressWrites.length = 0;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect.poll(() => progressWrites.length).toBeGreaterThan(0);
  expect(progressWrites.at(-1).locator).toMatch(/^epubcfi\(/);

  progressWrites.length = 0;
  await page.evaluate(() => document.dispatchEvent(new Event("freeze")));
  await expect.poll(() => progressWrites.length).toBeGreaterThan(0);
  expect(progressWrites.at(-1).locator).toMatch(/^epubcfi\(/);
});

test("external EPUB links require an explicit safe handoff", async ({ page }) => {
  await stubApp(page, { booksEnabled: true });
  await page.addInitScript(() => {
    window.__openedExternal = [];
    window.open = (...args) => { window.__openedExternal.push(args); return null; };
  });
  await openEpubReader(page);
  const body = page.frameLocator(".epub-viewport iframe").locator("body");
  await body.evaluate((element) => {
    const link = element.ownerDocument.createElement("a");
    link.textContent = "Publisher website";
    link.dataset.externalHref = "https://example.com/about";
    element.prepend(link);
    link.click();
  });
  await expect(page.locator(".epub-external-link")).toBeVisible();
  await expect(page.locator(".epub-external-copy")).toContainText("example.com");
  expect(await page.evaluate(() => window.__openedExternal.length)).toBe(0);
  await page.getByRole("button", { name: "Open in browser" }).click();
  expect(await page.evaluate(() => window.__openedExternal)).toEqual([["https://example.com/about", "_blank", "noopener,noreferrer"]]);
});

test("EPUB footnotes open as readable popovers without losing the current page", async ({ page }) => {
  await stubApp(page, { booksEnabled: true });
  await openEpubReader(page);
  const body = page.frameLocator(".epub-viewport iframe").locator("body");
  await body.evaluate((element) => {
    const link = element.ownerDocument.createElement("a");
    link.href = "#panels-note-1";
    link.setAttribute("epub:type", "noteref");
    link.textContent = "1";
    const note = element.ownerDocument.createElement("aside");
    note.id = "panels-note-1";
    note.textContent = "A concise explanatory footnote.";
    element.prepend(link);
    element.append(note);
  });
  await page.frameLocator(".epub-viewport iframe").getByRole("link", { name: "1" }).click();
  await expect(page.locator(".epub-footnote-dialog")).toBeVisible();
  await expect(page.locator(".epub-footnote-copy")).toContainText("A concise explanatory footnote");
  await page.locator(".epub-footnote-dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.frameLocator(".epub-viewport iframe").locator("body")).toContainText("Alice was beginning");
});

test("iOS-style content touches always escape distraction-free reading in both flows", async ({ page }) => {
  await stubApp(page, { booksEnabled: true });
  await openEpubReader(page);

  const tapContent = async () => {
    const body = page.frameLocator(".epub-viewport iframe").locator("body");
    await body.evaluate((element) => {
      const view = element.ownerDocument.defaultView;
      const target = element.querySelector("p") || element;
      const touch = { identifier: 7, target, clientX: view.innerWidth / 2, clientY: view.innerHeight / 2 };
      const dispatch = (type, touches, changedTouches) => {
        const event = new Event(type, { bubbles: true, cancelable: true, composed: false });
        Object.defineProperty(event, "touches", { value: touches });
        Object.defineProperty(event, "targetTouches", { value: touches });
        Object.defineProperty(event, "changedTouches", { value: changedTouches });
        target.dispatchEvent(event);
      };
      dispatch("touchstart", [touch], [touch]);
      dispatch("touchend", [], [touch]);
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: touch.clientX, clientY: touch.clientY }));
    });
  };

  for (const flow of ["paginated", "scrolled"]) {
    if (flow === "scrolled") {
      await page.locator(".epub-settings summary").click();
      await page.getByLabel("Reading flow").selectOption(flow);
      await expect(page.locator(".epub-reader")).toHaveAttribute("data-flow", flow);
      await expect(page.frameLocator(".epub-viewport iframe").locator("body")).toContainText("Alice was beginning");
      await page.locator(".epub-settings summary").click();
    }
    await tapContent();
    await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "false");
    await expect(page.getByRole("button", { name: "Show reader controls", exact: true })).toBeVisible();
    await page.waitForTimeout(400);
    await tapContent();
    await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "true");
    await page.waitForTimeout(400);
  }

  await tapContent();
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "false");
  await page.getByRole("button", { name: "Show reader controls", exact: true }).click();
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "true");
});

test("hidden paginated EPUB has an unobstructed parent centre escape zone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApp(page, { booksEnabled: true });
  await openEpubReader(page);
  const body = page.frameLocator(".epub-viewport iframe").locator("body");
  await body.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    const point = { clientX: view.innerWidth / 2, clientY: view.innerHeight / 2, pointerId: 12, bubbles: true };
    element.dispatchEvent(new PointerEvent("pointerdown", point));
    element.dispatchEvent(new PointerEvent("pointerup", point));
  });
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "false");

  const geometry = await page.locator(".epub-reader").evaluate((reader) => {
    const stage = reader.querySelector(".epub-stage");
    const zone = reader.querySelector(".epub-centre-restore");
    const handle = reader.querySelector(".epub-restore-controls");
    const viewport = reader.querySelector(".epub-viewport");
    const stageRect = stage.getBoundingClientRect();
    const zoneRect = zone.getBoundingClientRect();
    const handleRect = handle.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const hit = document.elementFromPoint(zoneRect.left + zoneRect.width / 2, zoneRect.top + zoneRect.height / 2);
    return {
      zoneDisplay: getComputedStyle(zone).display,
      zoneZ: Number(getComputedStyle(zone).zIndex),
      leftRatio: (zoneRect.left - stageRect.left) / stageRect.width,
      rightRatio: (zoneRect.right - stageRect.left) / stageRect.width,
      topRatio: (zoneRect.top - stageRect.top) / stageRect.height,
      bottomRatio: (zoneRect.bottom - stageRect.top) / stageRect.height,
      areaRatio: (zoneRect.width * zoneRect.height) / (stageRect.width * stageRect.height),
      centreHit: hit === zone,
      contentClearsHandle: viewportRect.top >= handleRect.bottom - 1,
    };
  });
  expect(geometry).toMatchObject({ zoneDisplay: "block", zoneZ: 4, centreHit: true, contentClearsHandle: true });
  expect(geometry.leftRatio).toBeGreaterThanOrEqual(0.32);
  expect(geometry.rightRatio).toBeLessThanOrEqual(0.68);
  expect(geometry.topRatio).toBeGreaterThanOrEqual(0.38);
  expect(geometry.bottomRatio).toBeLessThanOrEqual(0.62);
  expect(geometry.areaRatio).toBeLessThanOrEqual(0.08);

  const zone = page.getByRole("button", { name: "Show reader controls from page centre" });
  await zone.click();
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "true");
  const hideZone = page.getByRole("button", { name: "Hide reader controls from page centre" });
  await expect(hideZone).toBeVisible();
  await hideZone.click();
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "false");
  await zone.click();
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "true");

  await page.locator(".epub-settings summary").click();
  await page.getByLabel("Reading flow").selectOption("scrolled");
  await page.locator(".epub-settings summary").click();
  await expect(page.frameLocator(".epub-viewport iframe").locator("body")).toContainText("Alice was beginning");
  await expect(page.getByRole("button", { name: "Previous page" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Next page" })).toBeHidden();
  await body.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    const point = { clientX: view.innerWidth / 2, clientY: view.innerHeight / 2, pointerId: 13, bubbles: true };
    element.dispatchEvent(new PointerEvent("pointerdown", point));
    element.dispatchEvent(new PointerEvent("pointerup", point));
  });
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "false");
  await expect(zone).toBeHidden();
});

test("offline lifecycle recovery restores an exact CFI then reconciles canonically", async ({ page }) => {
  let offline = false;
  const progressWrites = [];
  const progressState = { current: null };
  await stubApp(page, {
    booksEnabled: true,
    progressWrites,
    progressState,
    progressResponder: async () => offline ? { status: 503 } : null,
  });
  await openEpubReader(page);
  await expect.poll(() => progressWrites.length).toBeGreaterThan(0);
  offline = true;
  progressWrites.length = 0;
  await page.getByRole("button", { name: "Next page" }).click();
  await page.waitForTimeout(100);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect.poll(() => progressWrites.length).toBeGreaterThan(0);
  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem("panel-pilot:book-position:1")));
  expect(cached.locator).toMatch(/^epubcfi\(/);
  expect(cached.baseRevision).toBe(progressState.current.revision);

  await page.getByRole("button", { name: /Books library/ }).click();
  offline = false;
  progressWrites.length = 0;
  await page.getByRole("button", { name: "Continue reading" }).click();
  await expect(page.frameLocator(".epub-viewport iframe").locator("body")).toContainText("Alice was beginning");
  await expect.poll(() => progressWrites.some((write) => write.locator === cached.locator), { timeout: 4000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("panel-pilot:book-position:1"))).toBeNull();
});

test("continuous EPUB hides edge overlays while page keys move by a readable viewport", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await stubApp(page, { booksEnabled: true });
  await openEpubReader(page);
  await page.locator(".epub-settings summary").click();
  await page.getByLabel("Reading flow").selectOption("scrolled");
  await page.locator(".epub-settings summary").click();
  const body = page.frameLocator(".epub-viewport iframe").locator("body");
  await expect(body).toContainText("Alice was beginning");
  await body.evaluate((element) => { element.style.minHeight = "4000px"; });
  const scrollPosition = () => page.locator(".epub-viewport").evaluate((viewport) => {
    const container = viewport.querySelector(".epub-container");
    const frame = viewport.querySelector("iframe");
    return { outer: container?.scrollTop || 0, inner: frame?.contentWindow?.scrollY || 0, height: container?.clientHeight || frame?.clientHeight || 0 };
  });
  const before = await scrollPosition();
  await expect(page.getByRole("button", { name: "Next page" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Previous page" })).toBeHidden();
  await body.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true })));
  await expect.poll(async () => {
    const current = await scrollPosition();
    return Math.max(current.outer, current.inner);
  }).toBeGreaterThan(Math.max(before.outer, before.inner));
  const afterEdge = await scrollPosition();
  expect(Math.max(afterEdge.outer, afterEdge.inner) - Math.max(before.outer, before.inner)).toBeLessThanOrEqual(afterEdge.height * 0.95 + 2);
  await page.locator(".epub-viewport").evaluate((viewport) => {
    viewport.querySelector(".epub-container")?.scrollTo({ top: 0 });
    viewport.querySelector("iframe")?.contentWindow?.scrollTo({ top: 0 });
  });
  await body.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true })));
  await expect.poll(async () => Math.max((await scrollPosition()).outer, (await scrollPosition()).inner)).toBeGreaterThan(0);
  const afterDown = await scrollPosition();
  await body.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true })));
  await expect.poll(async () => Math.max((await scrollPosition()).outer, (await scrollPosition()).inner)).toBeLessThan(Math.max(afterDown.outer, afterDown.inner));
  await body.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })));
  await expect.poll(async () => Math.max((await scrollPosition()).outer, (await scrollPosition()).inner)).toBeGreaterThan(0);
});

test("iPad viewport and orientation reflow preserve the exact EPUB position", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 1366 });
  const progressWrites = [];
  await stubApp(page, { booksEnabled: true, progressWrites });
  await openEpubReader(page);
  await expect.poll(() => progressWrites.length).toBeGreaterThan(0);
  const exact = progressWrites.at(-1).locator;
  progressWrites.length = 0;
  await page.evaluate(() => window.visualViewport?.dispatchEvent(new Event("resize")));
  await expect.poll(() => progressWrites.length, { timeout: 3000 }).toBeGreaterThan(0);
  expect(progressWrites.at(-1).locator).toBe(exact);
  progressWrites.length = 0;
  await page.setViewportSize({ width: 1366, height: 1024 });
  await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
  await expect.poll(() => progressWrites.length, { timeout: 3000 }).toBeGreaterThan(0);
  expect(progressWrites.at(-1).locator).toBe(exact);
});

test("long press and selected EPUB text never trigger taps", async ({ page }) => {
  await stubApp(page, { booksEnabled: true });
  await openEpubReader(page);
  const body = page.frameLocator(".epub-viewport iframe").locator("body");
  const paragraph = page.frameLocator(".epub-viewport iframe").locator("p").first();
  const point = await body.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    return { clientX: view.innerWidth / 2, clientY: view.innerHeight / 2 };
  });
  await paragraph.dispatchEvent("pointerdown", { ...point, pointerId: 44 });
  await page.waitForTimeout(550);
  await paragraph.dispatchEvent("pointerup", { ...point, pointerId: 44 });
  await paragraph.dispatchEvent("click", point);
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "true");
  await body.evaluate((element) => {
    const document = element.ownerDocument;
    const text = (element.querySelector("p") || element).firstChild;
    const range = document.createRange();
    range.selectNodeContents(text?.nodeType === Node.TEXT_NODE ? text.parentNode : (element.querySelector("p") || element));
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const view = document.defaultView;
    (element.querySelector("p") || element).dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: view.innerWidth / 2, clientY: view.innerHeight / 2 }));
  });
  await expect(page.locator(".epub-reader")).toHaveAttribute("data-controls-visible", "true");
});
