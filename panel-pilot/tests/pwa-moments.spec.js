import { expect, test } from "@playwright/test";


test("a reader panel can be saved, downloaded, browsed, and removed as a high-resolution moment", async ({ page }) => {
  const stored = [];
  let capturedPayload = null;
  await page.route("**/api/moments**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/image")) {
      await route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      });
      return;
    }
    if (request.method() === "POST") {
      capturedPayload = request.postDataJSON();
      const moment = {
        id: "1790899200000-0123456789abcdef",
        title: capturedPayload.title,
        chapterTitle: capturedPayload.chapterTitle,
        mediaFormat: capturedPayload.mediaFormat,
        pageIndex: capturedPayload.pageIndex,
        panelIndex: capturedPayload.panelIndex,
        width: capturedPayload.width,
        height: capturedPayload.height,
        byteSize: 4096,
        createdAt: "2026-10-02T00:00:00+00:00",
        imageUrl: "/api/moments/1790899200000-0123456789abcdef/image",
      };
      stored.unshift(moment);
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ moment }) });
      return;
    }
    if (request.method() === "DELETE") {
      stored.length = 0;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ moments: stored }) });
  });

  await page.goto("/");
  await page.locator("#nav-settings").click();
  if (!await page.locator("#suwayomi-setup").isVisible()) await page.locator("#toggle-suwayomi-panel").click();
  if (!await page.locator("#load-demo").isVisible()) await page.locator(".setup-advanced > summary").click();
  await page.locator("#load-demo").click();
  await expect(page.locator("#reader-loading")).toHaveAttribute("aria-hidden", "true", { timeout: 20_000 });
  await page.locator(".reader-options > summary").click();
  await page.locator("#save-moment").click();

  await expect.poll(() => capturedPayload).not.toBeNull();
  expect(capturedPayload.imageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect(capturedPayload.width).toBeGreaterThan(100);
  expect(capturedPayload.height).toBeGreaterThan(100);
  expect(capturedPayload.mediaFormat).toBe("manga");

  await page.locator("#reader-back").click();
  await page.locator("#nav-moments").click();
  await expect(page.locator("#moments-grid .moment-card")).toHaveCount(1);
  await expect(page.locator("#moments-grid .moment-card")).toContainText("Demo chapter");
  await expect(page.locator("#moment-rediscovery")).toBeVisible();
  await expect(page.locator("#moment-rediscovery-card .moment-card-featured")).toContainText("Demo chapter");
  await expect(page.locator("#moments-grid .moment-download")).toHaveAttribute("download", /\.jpg$/);
  await expect(page.locator("#moments-count")).toHaveText("1 saved");

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#moments-grid").getByRole("button", { name: "Remove" }).click();
  await expect(page.locator("#moments-grid .moment-card")).toHaveCount(0);
  await expect(page.locator("#moment-rediscovery")).toBeHidden();
  await expect(page.locator("#moments-count")).toHaveText("0 saved");
});
