import { expect, test } from "@playwright/test";

async function stubBackend(page) {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ error: "Backend intentionally unavailable during frontend smoke tests" }),
    });
  });
}

function watchRuntimeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test("the built application loads without browser runtime errors", async ({ page }) => {
  await stubBackend(page);
  const errors = watchRuntimeErrors(page);

  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.ok()).toBeTruthy();
  await expect(page.locator("#library-view")).toHaveClass(/\bactive\b/);
  await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");

  const headerRendering = await page.locator("#library-view").evaluate((view) => {
    const header = view.querySelector(".view-header");
    const viewStyle = getComputedStyle(view);
    const headerStyle = getComputedStyle(header);
    return {
      animationName: viewStyle.animationName,
      transform: viewStyle.transform,
      isolation: headerStyle.isolation,
      filter: headerStyle.filter,
      backdropFilter: headerStyle.backdropFilter,
    };
  });
  expect(headerRendering).toEqual({
    animationName: "none",
    transform: "none",
    isolation: "auto",
    filter: "none",
    backdropFilter: "none",
  });

  expect(errors).toEqual([]);
});

test("Test Lab preserves and can invoke the window.PanelPilot detector contract", async ({ page }) => {
  await stubBackend(page);
  const errors = watchRuntimeErrors(page);

  const response = await page.goto("/panel-test.html", { waitUntil: "networkidle" });
  expect(response?.ok()).toBeTruthy();
  await expect(page.locator("#test-results")).toHaveCount(1);

  const panels = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 48;
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "black";
    context.lineWidth = 2;
    context.strokeRect(2, 2, 28, 44);

    const image = new Image();
    image.src = canvas.toDataURL("image/png");
    await image.decode();
    return window.PanelPilot.detectPanels(image, "rtl");
  });

  expect(Array.isArray(panels)).toBeTruthy();
  expect(panels.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("the demo chapter opens and advances to the next panel", async ({ page }) => {
  await stubBackend(page);
  const errors = watchRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem("panel-pilot-tap-hint-seen", "1");
    localStorage.setItem("panel-pilot-settings", JSON.stringify({ readerMotion: "instant" }));
  });

  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#nav-settings").click();
  await expect(page.locator("#settings-view")).toHaveClass(/\bactive\b/);
  await page.locator("#toggle-suwayomi-panel").click();
  await expect(page.locator("#suwayomi-setup")).toBeVisible();
  await page.locator(".setup-advanced > summary").click();
  await page.locator("#load-demo").click();

  await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/, { timeout: 30_000 });
  await expect(page.locator("#chapter-title")).toHaveText("Demo chapter");
  await expect(page.locator("#panel-stat")).toHaveText("Panel 1", { timeout: 30_000 });

  await page.locator("#next-panel").click({ force: true });
  await expect(page.locator("#panel-stat")).not.toHaveText("Panel 1", { timeout: 10_000 });
  expect(errors).toEqual([]);
});
