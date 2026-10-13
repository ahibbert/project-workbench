import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const modules = process.env.WORKSPACE_NODE_MODULES ?? resolve("node_modules");
const edgePath = process.env.EDGE_PATH;
const requireFromModules = createRequire(resolve(modules, "playwright", "package.json"));
const { chromium } = requireFromModules("playwright");
const siteUrl = process.env.SITE_URL ?? "http://127.0.0.1:8765/";

const browser = await chromium.launch({ headless: true, executablePath: edgePath });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(siteUrl, { waitUntil: "networkidle" });
  await page.waitForSelector(".project-object");

  assert.equal(await page.locator(".project-zone").count(), 3);
  assert.equal(await page.locator(".project-object").count(), 14);
  assert.equal(await page.locator(".post-card").count(), 3);
  assert.equal(await page.locator(".project-sheet").count(), 0, "No project should be open by default.");

  const shell = await page.locator(".site-shell").first().boundingBox();
  const header = await page.locator(".site-header").boundingBox();
  assert.ok(shell.width <= 981, `Content shell is too wide: ${shell.width}`);
  assert.equal(Math.round(header.width), 1440, "Header background should span the viewport.");

  const marginButton = page.getByRole("button", { name: "Open Margin" });
  await marginButton.click();
  assert.equal(await page.locator(".project-sheet").count(), 1);
  assert.equal(await page.locator(".project-sheet h3").textContent(), "Margin");
  const desktopPosition = await page.evaluate(() => {
    const selected = document.querySelector(".project-object.is-selected").getBoundingClientRect();
    const sheet = document.querySelector(".project-sheet").getBoundingClientRect();
    return { selectedRight: selected.right, sheetLeft: sheet.left };
  });
  assert.ok(desktopPosition.sheetLeft > desktopPosition.selectedRight, "Desktop detail sheet should open to the right of the cards.");
  await page.getByRole("button", { name: "Close Margin" }).click();
  assert.equal(await page.locator(".project-sheet").count(), 0);

  const accessibility = await page.evaluate(() => {
    const headings = [...document.querySelectorAll("h1, h2, h3")].map((heading) => Number(heading.tagName[1]));
    const skippedHeading = headings.some((level, index) => index > 0 && level - headings[index - 1] > 1);
    const unnamedLinks = [...document.querySelectorAll("a")].filter(
      (link) => !(link.getAttribute("aria-label") || link.textContent.trim())
    ).length;
    const unnamedButtons = [...document.querySelectorAll("button")].filter(
      (button) => !(button.getAttribute("aria-label") || button.textContent.trim())
    ).length;
    return {
      h1s: document.querySelectorAll("h1").length,
      mains: document.querySelectorAll("main").length,
      navs: document.querySelectorAll("nav[aria-label]").length,
      skippedHeading,
      unnamedLinks,
      unnamedButtons,
    };
  });
  assert.deepEqual(accessibility, {
    h1s: 1,
    mains: 1,
    navs: 2,
    skippedHeading: false,
    unnamedLinks: 0,
    unnamedButtons: 0,
  });

  const researchLink = page.getByRole("link", { name: "Research", exact: true }).first();
  await researchLink.focus();
  const focusStyle = await researchLink.evaluate((link) => getComputedStyle(link).outlineWidth);
  assert.notEqual(focusStyle, "0px", "Keyboard focus must remain visible.");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".project-object");
  await page.getByRole("button", { name: "Open Little Now" }).click();
  const mobile = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    navWidth: document.querySelector(".nav-links")?.getBoundingClientRect().width,
    heroWidth: document.querySelector(".hero-copy")?.getBoundingClientRect().width,
    sheetInsideSelectedUnit: Boolean(document.querySelector(".project-unit:has(.project-object.is-selected) > .project-sheet")),
  }));
  assert.ok(mobile.scrollWidth <= mobile.viewportWidth, `Mobile page overflows: ${JSON.stringify(mobile)}`);
  assert.ok(mobile.navWidth <= mobile.viewportWidth);
  assert.ok(mobile.heroWidth <= mobile.viewportWidth);
  assert.equal(mobile.sheetInsideSelectedUnit, true, "Mobile sheet should unfold directly beneath its selected card.");

  console.log("Browser checks passed at desktop and 390px mobile widths.");
} finally {
  await browser.close();
}
