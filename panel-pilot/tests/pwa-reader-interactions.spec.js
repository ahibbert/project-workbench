import { expect, test } from "@playwright/test";

async function stubBackend(page) {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ error: "Backend intentionally unavailable during reader interaction tests" }),
    });
  });
}

async function openDemo(page, settings = {}) {
  await page.addInitScript((saved) => {
    localStorage.setItem("panel-pilot-tap-hint-seen", "1");
    localStorage.setItem("panel-pilot-settings", JSON.stringify(saved));
  }, { readerMotion: "instant", ...settings });
  await stubBackend(page);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#nav-settings").click();
  if (await page.locator("#suwayomi-setup").isHidden()) await page.locator("#toggle-suwayomi-panel").click();
  const advanced = page.locator(".setup-advanced");
  if (!await advanced.getAttribute("open")) await advanced.locator("summary").click();
  await page.locator("#load-demo").click();
  await expect(page.locator("#reader-view")).toHaveClass(/\bactive\b/, { timeout: 30_000 });
  await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "true", { timeout: 30_000 });
  await expect(page.locator("#stage-image")).toBeVisible();
}

function dispatchTouches(page, type, touches) {
  return page.locator("#stage").evaluate((stage, payload) => {
    const event = new Event(payload.type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: payload.touches });
    Object.defineProperty(event, "changedTouches", { value: payload.touches });
    stage.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, touches });
}

test("whole-page reveal is persisted, mirrored in reader controls, and behaves as a navigation step", async ({ page }) => {
  await openDemo(page, { pageReveal: "before", cinematicMotion: true });

  await expect(page.locator("#panel-stat")).toContainText("Full page reveal · before");
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics().pageRevealActive)).toBe(true);
  await page.locator("#next-panel").click({ force: true });
  await expect(page.locator("#panel-stat")).toContainText("Panel 1");
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics().pageRevealActive)).toBe(false);
  await page.locator("#prev-panel").click({ force: true });
  await expect(page.locator("#panel-stat")).toContainText("Full page reveal · before");

  await page.locator(".reader-options > summary").click();
  await expect(page.locator("#page-reveal-reader")).toHaveValue("before");
  await expect(page.locator("#cinematic-motion-reader")).toBeChecked();
  await page.locator("#page-reveal-reader").selectOption("after");
  await page.locator("#cinematic-motion-reader").uncheck();

  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("panel-pilot-settings")));
  expect(persisted.pageReveal).toBe("after");
  expect(persisted.cinematicMotion).toBe(false);
  await expect(page.locator("#page-reveal")).toHaveValue("after");
  await expect(page.locator("#cinematic-motion")).not.toBeChecked();
});

test("after-panel reveal appears after the final panel and before the next page", async ({ page }) => {
  await openDemo(page, { pageReveal: "after" });
  await expect(page.locator("#panel-stat")).toContainText("Panel 1");
  const panelCount = await page.locator("#panel-strip .panel-thumb").count();
  expect(panelCount).toBeGreaterThan(1);

  for (let index = 1; index < panelCount; index += 1) {
    await page.locator("#next-panel").click({ force: true });
  }
  await expect(page.locator("#panel-stat")).toContainText(`Panel ${panelCount}`);
  await page.locator("#next-panel").click({ force: true });
  await expect(page.locator("#panel-stat")).toContainText("Full page reveal · after");
  await expect(page.locator("#page-stat")).toContainText("Page 1 / 2");

  await page.locator("#next-panel").click({ force: true });
  await expect(page.locator("#page-stat")).toContainText("Page 2 / 2", { timeout: 15_000 });
  await expect(page.locator("#panel-stat")).toContainText("Panel 1");
});

test("press-and-hold peeks at the page and pointer cancellation restores the exact crop", async ({ page }) => {
  await openDemo(page);
  const original = await page.locator("#stage-image").evaluate((image) => image.style.transform);
  const stage = page.locator("#stage");

  await stage.dispatchEvent("pointerdown", {
    pointerId: 41,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: 220,
    clientY: 260,
  });
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics().overviewKind)).toBe("hold");
  await expect(page.locator("#reader-overview-hint")).toBeVisible();
  await expect.poll(() => page.locator("#stage-image").evaluate((image) => image.style.transform)).not.toBe(original);

  await stage.dispatchEvent("pointercancel", {
    pointerId: 41,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: 220,
    clientY: 260,
  });
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics().overviewActive)).toBe(false);
  await expect(page.locator("#reader-overview-hint")).toBeHidden();
  await expect.poll(() => page.locator("#stage-image").evaluate((image) => image.style.transform)).toBe(original);
  await expect(page.locator("#panel-stat")).toContainText("Panel 1");
});

test("two-finger overview springs back and leaves continuous webtoon scrolling untouched", async ({ page }) => {
  await openDemo(page);
  const original = await page.locator("#stage-image").evaluate((image) => image.style.transform);
  const firstTouches = [
    { identifier: 1, clientX: 120, clientY: 250 },
    { identifier: 2, clientX: 330, clientY: 250 },
  ];
  expect(await dispatchTouches(page, "touchstart", firstTouches)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics().overviewKind)).toBe("pinch");
  expect(await dispatchTouches(page, "touchmove", [
    { identifier: 1, clientX: 175, clientY: 250 },
    { identifier: 2, clientX: 275, clientY: 250 },
  ])).toBe(true);
  await expect.poll(() => page.locator("#stage-image").evaluate((image) => image.style.transform)).not.toBe(original);
  expect(await dispatchTouches(page, "touchend", [])).toBe(true);
  await expect.poll(() => page.locator("#stage-image").evaluate((image) => image.style.transform)).toBe(original);

  await page.locator("#webtoon-mode").evaluate((button) => button.click());
  await expect(page.locator("body")).toHaveClass(/\bwebtoon-scroll\b/, { timeout: 30_000 });
  const prevented = await dispatchTouches(page, "touchstart", firstTouches);
  expect(prevented).toBe(false);
  expect(await page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics().overviewActive)).toBe(false);
});

test("cinematic motion adapts the pan and respects both its toggle and reduced-motion", async ({ page }) => {
  await openDemo(page, { readerMotion: "smooth", cinematicMotion: true });
  await page.locator("#next-panel").click({ force: true });
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics().cinematicPan)).toBe("sweep");
  const cinematicDuration = await page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics().cinematicDuration);
  expect(cinematicDuration).toBeGreaterThan(220);

  await page.locator(".reader-options > summary").click();
  await page.locator("#cinematic-motion-reader").uncheck();
  await page.keyboard.press("Escape");
  await page.locator("#next-panel").click({ force: true });
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics().cinematicPan)).toBe("standard");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".reader-options > summary").click();
  await page.locator("#cinematic-motion-reader").check();
  await page.keyboard.press("Escape");
  await page.locator("#next-panel").click({ force: true });
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics())).toMatchObject({
    cinematicPan: "instant",
    cinematicDuration: 0,
  });
});

test("high-zoom clarity is mirrored and resting panels use settled-size rendering", async ({ page }) => {
  await openDemo(page, { highZoomClarity: "maximum", highZoomEnhancement: true, readerMotion: "smooth" });

  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics().cameraSettled)).toBe(true);
  await expect(page.locator("#high-zoom-clarity")).toHaveValue("maximum");
  await page.locator(".reader-options > summary").click();
  await expect(page.locator("#high-zoom-clarity-reader")).toHaveValue("maximum");
  await expect(page.locator("#high-zoom-enhancement-reader")).toBeChecked();
  await expect.poll(
    () => page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics().highZoomEnhancementStatus),
    { timeout: 20_000 }
  ).toBe("ready");
  await expect(page.locator("#stage-enhancement")).toBeVisible();

  const rendering = await page.locator("#stage-image").evaluate((image) => ({
    baseWidth: Number(image.dataset.cameraBaseWidth),
    cameraSettled: image.dataset.cameraSettled,
    transform: image.style.transform,
    width: Number.parseFloat(image.style.width),
  }));
  const camera = await page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics().camera);
  expect(rendering.cameraSettled).toBe("true");
  expect(rendering.transform).toMatch(/^translate\(/);
  expect(rendering.width).toBeCloseTo(rendering.baseWidth * camera.scale, 2);

  await page.locator("#high-zoom-clarity-reader").selectOption("off");
  await expect(page.locator("#high-zoom-clarity")).toHaveValue("off");
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics())).toMatchObject({
    highZoomClarity: "off",
    clarityApplied: false,
    cameraSettled: true,
  });
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("panel-pilot-settings")));
  expect(persisted.highZoomClarity).toBe("off");

  await page.locator("#high-zoom-enhancement-reader").uncheck();
  await expect(page.locator("#high-zoom-enhancement")).not.toBeChecked();
  await expect(page.locator("#stage-enhancement")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.PanelPilot.getReaderInteractionDiagnostics().highZoomEnhancementStatus)).toBe("off");
});
