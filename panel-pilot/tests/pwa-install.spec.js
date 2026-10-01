import { expect, test } from "@playwright/test";

async function stubBackend(page) {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ error: "Backend intentionally unavailable during PWA UX tests" }),
    });
  });
}

async function dispatchInstallPrompt(page, outcome = "accepted") {
  await page.evaluate((selectedOutcome) => {
    window.__panelPilotInstallPromptCalls = 0;
    const installPrompt = new Event("beforeinstallprompt", { cancelable: true });
    Object.defineProperties(installPrompt, {
      prompt: {
        value: async () => {
          window.__panelPilotInstallPromptCalls += 1;
          return { outcome: selectedOutcome };
        },
      },
      userChoice: {
        value: Promise.resolve({ outcome: selectedOutcome, platform: "web" }),
      },
    });
    window.dispatchEvent(installPrompt);
  }, outcome);
}

async function openSettings(page) {
  await page.locator("#nav-settings").click();
  await expect(page.locator("#settings-view")).toHaveClass(/\bactive\b/);
}

test("the explicit install action invokes the browser prompt once and reflects installation", async ({ page }) => {
  await stubBackend(page);
  await page.goto("/", { waitUntil: "networkidle" });

  await dispatchInstallPrompt(page);
  await openSettings(page);
  await expect(page.locator("#install-app")).toBeVisible();
  await expect(page.locator("#app-install-state")).toContainText(/ready|available|install/i);

  await page.locator("#install-app").click();
  await expect.poll(
    () => page.evaluate(() => window.__panelPilotInstallPromptCalls),
  ).toBe(1);

  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(page.locator("#app-install-state")).toContainText(/installed/i);
  await expect(page.locator("#install-app")).toBeHidden();
});

test("a dismissed browser install prompt is one-shot and leaves the application usable", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await stubBackend(page);
  await page.goto("/", { waitUntil: "networkidle" });

  await dispatchInstallPrompt(page, "dismissed");
  await openSettings(page);
  await expect(page.locator("#install-app")).toBeVisible();
  await page.locator("#install-app").click();

  await expect.poll(
    () => page.evaluate(() => window.__panelPilotInstallPromptCalls),
  ).toBe(1);
  await expect(page.locator("#install-app")).toBeHidden();
  await expect(page.locator("#app-install-note")).toContainText(/dismissed|try again/i);
  await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanels)).toBe("function");
  expect(pageErrors).toEqual([]);
});

test("iOS browser mode shows Add to Home Screen guidance instead of a custom prompt", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperties(navigator, {
      maxTouchPoints: { configurable: true, get: () => 5 },
      platform: { configurable: true, get: () => "iPhone" },
      standalone: { configurable: true, get: () => false },
      userAgent: {
        configurable: true,
        get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 Version/16.4 Mobile/15E148 Safari/604.1",
      },
    });
  });
  await stubBackend(page);

  await page.goto("/", { waitUntil: "networkidle" });
  await openSettings(page);
  await expect(page.locator("#ios-install-steps")).toBeVisible();
  await expect(page.locator("#ios-install-steps")).toContainText(/home screen/i);
  await expect(page.locator("#install-app")).toBeHidden();
  await expect(page.locator("#app-install-note")).toContainText(/share|home screen/i);
});

test("iPadOS desktop user agents with touch receive Home Screen guidance", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperties(navigator, {
      maxTouchPoints: { configurable: true, get: () => 5 },
      platform: { configurable: true, get: () => "MacIntel" },
      standalone: { configurable: true, get: () => false },
      userAgent: {
        configurable: true,
        get: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/16.4 Safari/605.1.15",
      },
    });
  });
  await stubBackend(page);

  await page.goto("/", { waitUntil: "networkidle" });
  await openSettings(page);
  await expect(page.locator("#ios-install-steps")).toBeVisible();
  await expect(page.locator("#app-install-note")).toContainText(/share|home screen/i);
  await expect(page.locator("#install-app")).toBeHidden();
});

test("iOS standalone mode is reported as installed and suppresses install guidance", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperties(navigator, {
      maxTouchPoints: { configurable: true, get: () => 5 },
      platform: { configurable: true, get: () => "iPhone" },
      standalone: { configurable: true, get: () => true },
      userAgent: {
        configurable: true,
        get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 Version/16.4 Mobile/15E148 Safari/604.1",
      },
    });
  });
  await stubBackend(page);

  await page.goto("/", { waitUntil: "networkidle" });
  await openSettings(page);
  await expect(page.locator("#app-install-state")).toContainText(/installed/i);
  await expect(page.locator("#install-app")).toBeHidden();
  await expect(page.locator("#ios-install-steps")).toBeHidden();

  await dispatchInstallPrompt(page);
  await expect(page.locator("#install-app")).toBeHidden();
});

test("an unsupported desktop browser settles on useful neutral install guidance", async ({ page }) => {
  await stubBackend(page);
  await page.goto("/", { waitUntil: "networkidle" });
  await openSettings(page);

  await expect(page.locator("#app-install-state")).toContainText(/browser menu/i);
  await expect(page.locator("#app-install-note")).toContainText(/browser|install/i);
  await expect(page.locator("#install-app")).toBeHidden();
  await expect(page.locator("#ios-install-steps")).toBeHidden();
});
