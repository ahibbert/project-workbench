import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test.use({ serviceWorkers: "block" });

const epubFixture = Buffer.from(
  readFileSync(new URL("./fixtures/alice-public-domain.epub.b64", import.meta.url), "utf8").trim(),
  "base64",
);

const book = {
  id: 1,
  title: "Alice's Adventures in Wonderland",
  subtitle: "",
  description: "A public-domain adventure.",
  authors: ["Lewis Carroll"],
  coverUrl: "",
  epubUrl: "/api/books/1/epub",
  hasEpub: true,
  dateAdded: "2026-10-02T00:00:00Z",
  lastSyncedAt: "2026-10-02T00:00:00Z",
};

async function stubApp(page, { booksEnabled, queued = [], progressState = { current: null }, progressWrites = [] }) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
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
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ books: [{ ...book, progress: progressState.current }], total: 1, limit: 200, offset: 0 }) });
      return;
    }
    if (url.pathname === "/api/books/1/progress" && route.request().method() === "POST") {
      const incoming = route.request().postDataJSON();
      progressWrites.push(incoming);
      progressState.current = { ...incoming, bookId: 1, revision: (progressState.current?.revision || 0) + 1, updatedAt: new Date().toISOString() };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ progress: progressState.current }) });
      return;
    }
    if (url.pathname === "/api/books/1/epub") {
      await route.fulfill({ status: 200, contentType: "application/epub+zip", body: epubFixture });
      return;
    }
    if (url.pathname === "/api/books/preferences") {
      const preferences = route.request().method() === "POST" ? route.request().postDataJSON() : {
        theme: "light", fontFamily: "publisher", fontSize: 100, lineHeight: 1.5,
        contentWidth: 720, readingFlow: "paginated", textAlignment: "start",
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preferences }) });
      return;
    }
    if (url.pathname === "/api/books/1") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ book, progress: progressState.current }) });
      return;
    }
    if (url.pathname === "/api/books/search") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ books: [{
        provider: "openlibrary", providerBookId: "OL123W", token: "opaque-book-token", title: "The Mercy of Gods",
        authors: ["James S. A. Corey"], isbn: "9780356517759", language: "en", publishedDate: "2024",
      }] }) });
      return;
    }
    if (url.pathname === "/api/books/releases") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ releases: [{
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
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ downloads: [] }) });
      return;
    }
    if (url.pathname === "/api/library") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
      return;
    }
    if (url.pathname === "/api/suwayomi/graphql") {
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

test("books navigation disappears completely while the feature is disabled", async ({ page }) => {
  await stubApp(page, { booksEnabled: false });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#nav-books")).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/books-enabled/);
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
  await page.locator("#nav-settings").click();
  await expect(page.locator("#book-services-panel")).toBeVisible();
  await expect(page.locator("#book-services-note")).toContainText("Shelfmark ready");
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
  await page.getByRole("button", { name: "Find books" }).click();
  await expect(page).toHaveURL(/#books-search$/);
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
  await expect(page.locator(".epub-time-remaining")).not.toContainText("Generating");
  await page.getByRole("button", { name: "Contents" }).click();
  await expect(page.locator(".epub-toc")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
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
  await page.getByRole("button", { name: /^Books$/ }).first().click();
  await page.getByRole("button", { name: /^Plan/ }).click();
  await expect(page.locator(".book-library-card")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator(".book-library-card").getByRole("button", { name: /Alice's Adventures/ }).click();
  await page.getByRole("button", { name: "Read book" }).click();
  await expect(page.locator(".epub-toolbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page" })).toBeVisible();
  await page.locator(".epub-settings summary").click();
  await expect(page.getByLabel("Page width")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
