import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

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

async function stubApp(page, { booksEnabled }) {
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
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ books: [book], total: 1, limit: 200, offset: 0 }) });
      return;
    }
    if (url.pathname === "/api/books/1") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ book }) });
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

test("enabled books library is lazy-loaded and opens an isolated detail view", async ({ page }) => {
  await stubApp(page, { booksEnabled: true });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#nav-books")).toBeVisible();
  await page.locator("#nav-books").click();
  await expect(page).toHaveURL(/#books$/);
  await expect(page.locator(".book-card")).toContainText("Alice's Adventures in Wonderland");
  await expect(page.locator(".book-card")).toContainText("Lewis Carroll");
  await page.locator(".book-card").click();
  await expect(page).toHaveURL(/#book-detail\?id=1$/);
  await expect(page.locator(".book-detail h2")).toHaveText("Alice's Adventures in Wonderland");
  await expect(page.locator(".book-detail .primary-button")).toBeEnabled();
});
