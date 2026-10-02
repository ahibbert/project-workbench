import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const privateTitle = {
  mangaId: 701,
  mangaTitle: "Private Lessons",
  sourceId: "manhwa18",
  sourceLabel: "Manhwa18.cc (EN)",
  isNsfw: true,
  mediaFormat: "manga",
  libraryStatus: "reading",
  chapterId: 7001,
  chapterTitle: "Chapter 4",
  progressLabel: "Page 3",
  updatedAt: "2026-10-02T03:00:00.000Z",
};

async function routeAppApis(page, { onConfigPost } = {}) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let payload = {};
    if (url.pathname === "/api/library") payload = { items: [privateTitle] };
    else if (url.pathname === "/api/moments") payload = { moments: [
      { id: "private-moment", title: "Private Lessons", sourceLabel: "Manhwa18.cc (EN)", isNsfw: true, imageUrl: "/private.jpg" },
      { id: "public-moment", title: "Saga", sourceLabel: "Comic Source", isNsfw: false, imageUrl: "/public.jpg" },
    ] };
    else if (url.pathname === "/api/comic-recommendations/config") {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        onConfigPost?.(body);
        payload = { configured: !body.clear, managedByEnvironment: false, hasContact: Boolean(body.contact) };
      } else payload = { configured: false, managedByEnvironment: false, hasContact: false };
    } else if (url.pathname === "/api/comic-recommendations") {
      payload = { configured: true, status: "needs-library", results: [], seedTitles: [] };
    } else if (url.pathname === "/api/mangabaka/status") payload = { configured: false, connected: false };
    else if (url.pathname === "/api/mangabaka/recommendations") payload = { configured: false, results: [] };
    else if (url.pathname === "/api/reading-stats") payload = { enabled: false };
    else if (url.pathname === "/api/source-profiles") payload = { profiles: [] };
    else if (url.pathname === "/api/suwayomi/graphql") payload = { data: {} };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
}

test("private-source titles, resume state, moments, and MangaBaka sync are hidden by default", async ({ page }) => {
  await routeAppApis(page);
  await page.addInitScript((item) => {
    localStorage.setItem("panel-pilot-library", JSON.stringify([item]));
  }, privateTitle);
  await page.goto("/");

  await expect(page.locator("#library-list")).not.toContainText("Private Lessons");
  await expect(page.locator("#nav-reader")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.PanelPilot.mangaBakaEligibleLibraryItem({
    mediaFormat: "manga",
    isNsfw: true,
  }))).toBe(false);

  await page.locator("#nav-moments").click();
  await expect(page.locator("#moments-grid .moment-card")).toHaveCount(1);
  await expect(page.locator("#moment-rediscovery-card .moment-card")).toHaveCount(1);
  await expect(page.locator("#moments-grid")).toContainText("Saga");
  await expect(page.locator("#moments-grid")).not.toContainText("Private Lessons");
  await expect(page.locator("#moment-rediscovery-card")).not.toContainText("Private Lessons");

  await page.locator("#nav-settings").click();
  await page.locator("#show-nsfw-sources").evaluate((checkbox) => {
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.locator("#nav-library").click();
  await expect(page.locator("#library-list")).toContainText("Private Lessons");
  await expect(page.locator("#nav-reader")).toBeVisible();
  await page.locator("#nav-moments").click();
  await expect(page.locator("#moments-grid .moment-card")).toHaveCount(2);
  await expect(page.locator("#moment-rediscovery-card .moment-card")).toHaveCount(1);
});

test("LibraryThing key can be stored from Settings without remaining in the DOM", async ({ page }) => {
  let posted = null;
  await routeAppApis(page, { onConfigPost: (payload) => { posted = payload; } });
  await page.goto("/");
  await page.locator("#nav-settings").click();
  await page.locator("#librarything-api-key").fill("private-librarything-key-123");
  await page.locator("#open-library-contact").fill("panels@example.test");
  await page.locator("#save-comic-recommendations-config").click();

  await expect(page.locator("#comic-recommendations-config-state")).toHaveText("Configured");
  await expect(page.locator("#librarything-api-key")).toHaveValue("");
  await expect(page.locator("#disconnect-comic-recommendations")).toBeVisible();
  expect(posted).toEqual({ apiKey: "private-librarything-key-123", contact: "panels@example.test" });
  await expect(page.locator("body")).not.toContainText("private-librarything-key-123");
});
