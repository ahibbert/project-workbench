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
  await expect(page).toHaveTitle("Panels");
  await expect(page.locator(".kicker").first()).toHaveText("Panels");
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

test("MangaBaka recommendation covers support legacy and nested image payloads", async ({ page }) => {
  const coverUrls = [
    "https://covers.mangabaka.test/nested-x1.svg",
    "https://covers.mangabaka.test/raw.svg",
    "https://covers.mangabaka.test/legacy.svg",
  ];
  await page.route("https://covers.mangabaka.test/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="250" height="350"><rect width="250" height="350" fill="#16847d"/></svg>',
    });
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/mangabaka/recommendations") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mode: "personalized",
          results: [
            {
              media_type: "manga",
              titles: [{ language: "en", is_primary: true, title: "Nested density cover" }],
              cover_image: { x250: { x1: coverUrls[0], x2: "https://covers.mangabaka.test/nested-x2.svg" } },
            },
            {
              media_type: "manga",
              titles: [{ language: "en", is_primary: true, title: "Raw object cover" }],
              cover_image: { raw: { url: coverUrls[1], width: 1200, height: 1680 } },
            },
            {
              media_type: "manga",
              titles: [{ language: "en", is_primary: true, title: "Legacy string cover" }],
              cover: { x250: coverUrls[2] },
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ error: "Backend intentionally unavailable during cover compatibility test" }),
    });
  });

  await page.goto("/", { waitUntil: "networkidle" });
  const images = page.locator("#mangabaka-results .manga-cover-image");
  await expect(images).toHaveCount(3);
  await expect(images.evaluateAll((items) => items.map((item) => item.getAttribute("src")))).resolves.toEqual(coverUrls);

  await page.locator("#nav-browse").click();
  await images.first().scrollIntoViewIfNeeded();
  await expect(page.locator("#mangabaka-results .manga-cover-button.cover-loaded")).toHaveCount(3);
});

test("the floating navigation and status surfaces remain separated across mobile layouts", async ({ page }) => {
  await stubBackend(page);
  await page.goto("/", { waitUntil: "networkidle" });

  for (const viewport of [
    { width: 320, height: 720 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 507, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(async () => {
      document.body.classList.add("has-reading-miniplayer", "has-download-status");
      document.querySelector("#nav-reader").hidden = false;
      document.querySelector("#download-status-button").hidden = false;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const rect = (selector) => {
        const bounds = document.querySelector(selector).getBoundingClientRect();
        return {
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
          left: bounds.left,
          width: bounds.width,
          height: bounds.height,
        };
      };
      const navigation = document.querySelector(".app-nav");
      const navigationStyle = getComputedStyle(navigation);
      return {
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        bodyPaddingBottom: Number.parseFloat(getComputedStyle(document.body).paddingBottom),
        navigation: rect(".app-nav"),
        navigationButtons: [...document.querySelectorAll(".app-nav-button")].map((button) => button.getBoundingClientRect().height),
        miniplayer: rect("#nav-reader"),
        downloads: rect("#download-status-button"),
        navigationBackground: navigationStyle.backgroundColor,
        navigationBackdrop: navigationStyle.backdropFilter,
      };
    });

    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.navigation.left).toBeGreaterThanOrEqual(8);
    expect(layout.navigation.right).toBeLessThanOrEqual(layout.viewportWidth - 8);
    expect(layout.navigation.bottom).toBeLessThanOrEqual(layout.viewportHeight - 8);
    expect(layout.navigation.height).toBeGreaterThanOrEqual(44);
    expect(layout.navigationButtons.every((height) => height >= 44)).toBe(true);
    expect(layout.miniplayer.left).toBeGreaterThanOrEqual(0);
    expect(layout.miniplayer.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.miniplayer.bottom).toBeLessThanOrEqual(layout.navigation.top);
    expect(layout.downloads.left).toBeGreaterThanOrEqual(0);
    expect(layout.downloads.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.downloads.bottom).toBeLessThanOrEqual(layout.miniplayer.top);
    expect(layout.bodyPaddingBottom).toBeGreaterThanOrEqual(layout.viewportHeight - layout.downloads.top);
    expect(layout.navigationBackground).toBe("rgb(255, 255, 255)");
    expect(layout.navigationBackdrop).toBe("none");
  }
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

test("bubble-aware framing expands only the panel that owns a clipped speech bubble", async ({ page }) => {
  await stubBackend(page);
  await page.goto("/", { waitUntil: "networkidle" });

  const result = await page.evaluate(() => {
    const panels = [
      { x: 0.10, y: 0.10, w: 0.36, h: 0.34 },
      { x: 0.54, y: 0.10, w: 0.36, h: 0.34 },
    ];
    const bubbles = [
      { x: 0.075, y: 0.16, w: 0.08, h: 0.10, score: 0.92 },
      { x: 0.73, y: 0.16, w: 0.10, h: 0.10, score: 0.95 },
    ];
    return {
      left: window.PanelPilot.bubbleAwarePanelRect(panels[0], bubbles, panels),
      right: window.PanelPilot.bubbleAwarePanelRect(panels[1], bubbles, panels),
      leftOwner: window.PanelPilot.bubblePanelIndex(bubbles[0], panels),
      rightOwner: window.PanelPilot.bubblePanelIndex(bubbles[1], panels),
    };
  });

  expect(result.leftOwner).toBe(0);
  expect(result.rightOwner).toBe(1);
  expect(result.left.x).toBeLessThan(0.10);
  expect(result.left.x + result.left.w).toBeLessThan(0.54);
  expect(result.left.bubbleCount).toBe(1);
  expect(result.right.x).toBe(0.54);
  expect(result.right.bubbleCount).toBe(1);
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
