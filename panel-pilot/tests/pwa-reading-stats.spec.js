import { expect, test } from "@playwright/test";

const initialSettings = {
  enabled: false,
  showStats: true,
  showRhythm: true,
  celebrations: true,
  timezone: "Australia/Sydney",
  dayStartHour: 4,
  since: null,
};

const populatedSummary = {
  schemaVersion: 1,
  range: "30d",
  since: "2026-09-25T08:00:00Z",
  activeSeconds: 7_380,
  pages: 412,
  chapterFinishes: 12,
  uniqueChapters: 10,
  rereads: 2,
  completedTitles: 1,
  readingDays: 6,
  titlesExplored: 3,
  currentRhythm: 3,
  longestRhythm: 5,
  totals: {
    activeSeconds: 7_380,
    pages: 412,
    chapterFinishes: 12,
    uniqueChapters: 10,
    rereads: 2,
    completedTitles: 1,
    readingDays: 6,
    titlesExplored: 3,
  },
  trend: { current: { activeSeconds: 7_380, chapterFinishes: 12 }, previous: { activeSeconds: 3_600, chapterFinishes: 5 } },
  rhythm: { currentDays: 3, longestDays: 5, through: "2026-10-02" },
  calendar: [
    { date: "2026-09-30", activeSeconds: 1_800, chapterFinishes: 2, readingDay: true },
    { date: "2026-10-01", activeSeconds: 2_400, chapterFinishes: 4, readingDay: true },
    { date: "2026-10-02", activeSeconds: 3_180, chapterFinishes: 6, readingDay: true },
  ],
  achievements: [
    { id: "first-finish", name: "First finish", title: "First finish", description: "Finish your first chapter", unlockedAt: "2026-09-25T08:12:00Z" },
    { id: "ten-finishes", name: "Ten chapters", title: "Ten chapters", description: "Finish ten unique chapters", unlockedAt: "2026-10-02T08:12:00Z" },
  ],
};

function emptySummary(settings) {
  const totals = {
    activeSeconds: 0,
    pages: 0,
    chapterFinishes: 0,
    uniqueChapters: 0,
    rereads: 0,
    completedTitles: 0,
    readingDays: 0,
    titlesExplored: 0,
  };
  return {
    schemaVersion: 1,
    range: "30d",
    since: settings.since,
    prospectiveSince: settings.since,
    ...totals,
    totals,
    currentRhythm: 0,
    longestRhythm: 0,
    trend: { current: totals, previous: null },
    rhythm: { currentDays: 0, longestDays: 0, through: null },
    calendar: [],
    achievements: [],
  };
}

function createStatsBackend({ settings: settingsOverrides = {}, summary = null, missing = false } = {}) {
  const state = {
    settings: { ...initialSettings, ...settingsOverrides },
    summary,
    online: true,
    requests: [],
    receivedEvents: [],
    eventIds: new Set(),
    resets: 0,
  };

  return {
    state,
    setOnline(value) { state.online = value; },
    async attach(page) {
      await page.addInitScript(() => {
        try { delete Navigator.prototype.serviceWorker; } catch { /* Worker behavior is covered elsewhere. */ }
        localStorage.setItem("panel-pilot-tap-hint-seen", "1");
        localStorage.setItem("panel-pilot-settings", JSON.stringify({ readerMotion: "instant" }));
      });

      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        state.requests.push({ method: request.method(), pathname: url.pathname, search: url.search });

        if (url.pathname.startsWith("/api/reading-stats")) {
          if (missing) {
            await route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Unknown endpoint"}' });
            return;
          }
          if (!state.online) {
            await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"offline"}' });
            return;
          }

          if (url.pathname === "/api/reading-stats" && request.method() === "GET") {
            const range = url.searchParams.get("range") || "30d";
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                ...(state.summary || emptySummary(state.settings)),
                range,
                settings: state.settings,
              }),
            });
            return;
          }
          if (url.pathname === "/api/reading-stats/settings" && request.method() === "POST") {
            const patch = request.postDataJSON() || {};
            const allowed = new Set(["enabled", "showStats", "showRhythm", "celebrations", "timezone", "dayStartHour"]);
            const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
            if (unknown.length) {
              await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: `Unknown settings: ${unknown.join(", ")}` }) });
              return;
            }
            state.settings = { ...state.settings, ...patch };
            if (patch.enabled === true && !state.settings.since) state.settings.since = "2026-10-02T08:00:00Z";
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.settings) });
            return;
          }
          if (url.pathname === "/api/reading-stats/events" && request.method() === "POST") {
            const payload = request.postDataJSON() || {};
            if (!state.settings.enabled) {
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ accepted: 0, duplicates: 0, disabled: true, newlyUnlocked: [] }),
              });
              return;
            }
            let accepted = 0;
            let duplicates = 0;
            for (const event of payload.events || []) {
              if (state.eventIds.has(event.eventId)) {
                duplicates += 1;
              } else {
                accepted += 1;
                state.eventIds.add(event.eventId);
                state.receivedEvents.push(event);
              }
            }
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                accepted,
                duplicates,
                acknowledgedEventIds: (payload.events || []).map((event) => event.eventId),
                newlyUnlocked: [],
              }),
            });
            return;
          }
          if (url.pathname === "/api/reading-stats/export" && request.method() === "GET") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              headers: { "Content-Disposition": 'attachment; filename="panels-reading-stats.json"' },
              body: JSON.stringify({
                schemaVersion: 1,
                settings: state.settings,
                events: state.receivedEvents,
                achievements: state.summary?.achievements || [],
              }),
            });
            return;
          }
          if (url.pathname === "/api/reading-stats/reset" && request.method() === "POST") {
            const payload = request.postDataJSON() || {};
            if (payload.confirm !== "ERASE") {
              await route.fulfill({ status: 400, contentType: "application/json", body: '{"error":"Confirmation required"}' });
              return;
            }
            state.resets += 1;
            state.receivedEvents = [];
            state.eventIds.clear();
            state.summary = null;
            state.settings = { ...state.settings, since: null, enabled: false };
            await route.fulfill({ status: 200, contentType: "application/json", body: '{"reset":true}' });
            return;
          }
        }

        if (url.pathname === "/api/library") {
          await route.fulfill({ status: 200, contentType: "application/json", body: '{"items":[]}' });
          return;
        }
        if (url.pathname === "/api/download-buffer/status") {
          await route.fulfill({ status: 200, contentType: "application/json", body: '{"downloaded":0,"queued":0,"failed":0,"windowSize":0,"chapters":[]}' });
          return;
        }
        if (url.pathname === "/api/mangabaka/status") {
          await route.fulfill({ status: 200, contentType: "application/json", body: '{"configured":false,"connected":false}' });
          return;
        }
        if (url.pathname === "/api/mangabaka/recommendations") {
          await route.fulfill({ status: 200, contentType: "application/json", body: '{"results":[]}' });
          return;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });
    },
  };
}

async function openStats(page) {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Stats$/i }).click();
  await expect(page.locator("#stats-view")).toHaveClass(/\bactive\b/);
}

test("reading stats are an explicit prospective opt-in", async ({ page }) => {
  const backend = createStatsBackend();
  await backend.attach(page);
  await openStats(page);

  const welcome = page.locator("#stats-welcome");
  await expect(page.getByRole("heading", { name: /reading stats/i })).toBeVisible();
  await expect(welcome.getByText(/starts? (tracking|counting) (when|after) you enable/i)).toBeVisible();
  await expect(welcome.getByText(/cannot reconstruct past reading/i)).toBeVisible();
  await page.getByRole("button", { name: /start tracking|enable reading stats/i }).click();

  await expect.poll(() => backend.state.settings.enabled).toBe(true);
  expect(backend.state.settings.timezone).toBeTruthy();
  expect(backend.state.settings.dayStartHour).toBeGreaterThanOrEqual(0);
  await expect(page.getByText(/since/i)).toBeVisible();
});

test("dashboard exposes understandable metrics, trend, calendar, rhythm, and achievements", async ({ page }) => {
  const backend = createStatsBackend({
    settings: { enabled: true, since: populatedSummary.since },
    summary: populatedSummary,
  });
  await backend.attach(page);
  await openStats(page);

  const dashboard = page.locator("#stats-dashboard");
  await expect(dashboard.getByText(/2h\s*3m|123\s*min/i)).toBeVisible();
  await expect(dashboard.getByText("12", { exact: true })).toBeVisible();
  await expect(dashboard.getByText(/10.*unique|unique.*10/i)).toBeVisible();
  await expect(dashboard.getByText(/2.*reread|reread.*2/i)).toBeVisible();
  await expect(dashboard.getByText(/6.*reading days|reading days.*6/i)).toBeVisible();
  await expect(page.locator("#stats-titles")).toHaveText(/3 titles/i);
  await expect(dashboard.getByText(/current.*3|3.*current/i)).toBeVisible();
  await expect(dashboard.getByText(/longest.*5|5.*longest/i)).toBeVisible();
  await expect(dashboard.getByText("First finish", { exact: true })).toHaveCount(1);
  await expect(dashboard.getByText("Ten chapters", { exact: true })).toHaveCount(1);
  await expect(page.locator("#stats-achievement-list [data-unlocked='true']")).toHaveCount(2);

  const calendar = page.locator("#stats-calendar");
  await expect(calendar).toBeVisible();
  await expect(calendar.locator('[aria-label*="2026-10-02"]')).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: /range/i })).toHaveValue("30d");
});

test("offline events survive reload and retry idempotently when connectivity returns", async ({ page }) => {
  const backend = createStatsBackend({ settings: { enabled: true, since: populatedSummary.since } });
  await backend.attach(page);
  backend.setOnline(false);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.readingStats?.recordChapterFinish)).toBe("function");
  await page.evaluate(async () => {
    await window.PanelPilot.readingStats.recordPageView({ titleKey: "title-key", chapterKey: "chapter-key", pageIndex: 8, offline: true });
    await window.PanelPilot.readingStats.recordChapterFinish({ titleKey: "title-key", chapterKey: "chapter-key", attemptId: "attempt-key", offline: true });
    await window.PanelPilot.readingStats.flush();
  });
  await expect.poll(() => page.evaluate(() => window.PanelPilot.readingStats.getOutbox().then((items) => items.length))).toBe(2);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => window.PanelPilot.readingStats.getOutbox().then((items) => items.length))).toBe(2);

  backend.setOnline(true);
  await page.evaluate(async () => {
    await window.PanelPilot.readingStats.flush();
    await window.PanelPilot.readingStats.flush();
  });
  await expect.poll(() => backend.state.receivedEvents.length).toBe(2);
  await expect.poll(() => page.evaluate(() => window.PanelPilot.readingStats.getOutbox().then((items) => items.length))).toBe(0);
  expect(new Set(backend.state.receivedEvents.map((event) => event.eventId)).size).toBe(2);
  expect(backend.state.receivedEvents.every((event) => event.schemaVersion === 1)).toBe(true);
});

test("active-minute events use opaque keys and never send titles, covers, URLs, or third-party analytics", async ({ page }) => {
  const backend = createStatsBackend({ settings: { enabled: true, since: populatedSummary.since } });
  await backend.attach(page);
  const thirdPartyRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) thirdPartyRequests.push(request.url());
  });
  await page.goto("/", { waitUntil: "networkidle" });

  await page.evaluate(async () => {
    await window.PanelPilot.readingStats.recordActiveSeconds(37, {
      titleKey: "sha256:6ba23f8b",
      chapterKey: "sha256:9f86d081",
    });
    await window.PanelPilot.readingStats.flush();
  });
  await expect.poll(() => backend.state.receivedEvents.length).toBe(1);
  const event = backend.state.receivedEvents[0];
  expect(event.type).toBe("active_minute");
  expect(event.seconds).toBe(37);
  expect(event.minuteKey).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
  expect(event.deviceId).toBeTruthy();
  expect(event.titleKey).toBe("sha256:6ba23f8b");
  expect(event.chapterKey).toBe("sha256:9f86d081");
  const encoded = JSON.stringify(event).toLowerCase();
  expect(encoded).not.toContain("title\"");
  expect(encoded).not.toContain("cover");
  expect(encoded).not.toContain("http");
  expect(thirdPartyRequests).toEqual([]);
});

test("people can hide rhythm and celebrations, disable collection, export, and erase history", async ({ page }) => {
  const backend = createStatsBackend({
    settings: { enabled: true, since: populatedSummary.since },
    summary: populatedSummary,
  });
  await backend.attach(page);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Settings$/i }).click();

  const statsGroup = page.getByRole("group", { name: /reading stats/i });
  await expect(statsGroup).toBeVisible();
  await statsGroup.getByRole("checkbox", { name: /show.*rhythm/i }).uncheck();
  await statsGroup.getByRole("checkbox", { name: /celebrations/i }).uncheck();
  await expect.poll(() => backend.state.settings.showRhythm).toBe(false);
  await expect.poll(() => backend.state.settings.celebrations).toBe(false);

  const downloadPromise = page.waitForEvent("download");
  await statsGroup.getByRole("button", { name: /export/i }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/panels.*reading.*stats.*\.json/i);

  await statsGroup.getByRole("checkbox", { name: /track|collect|reading stats/i }).uncheck();
  await expect.poll(() => backend.state.settings.enabled).toBe(false);

  await statsGroup.getByRole("button", { name: /erase|reset/i }).click();
  const dialog = page.getByRole("dialog", { name: /erase|reset/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill("ERASE");
  await dialog.getByRole("button", { name: /erase|reset/i }).click();
  await expect.poll(() => backend.state.resets).toBe(1);
  await expect(dialog).toBeHidden();
});

test("an older server returning 404 degrades gracefully without breaking existing app features", async ({ page }) => {
  const backend = createStatsBackend({ missing: true });
  await backend.attach(page);
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.goto("/", { waitUntil: "networkidle" });

  await expect(page).toHaveTitle("Panels");
  await expect(page.locator("#library-view")).toHaveClass(/\bactive\b/);
  await page.getByRole("button", { name: /^Browse$/i }).click();
  await expect(page.locator("#browse-view")).toHaveClass(/\bactive\b/);
  await page.getByRole("button", { name: /^Settings$/i }).click();
  await expect(page.locator("#settings-view")).toHaveClass(/\bactive\b/);
  await expect(page.getByText(/reading stats.*unavailable|update.*server/i)).toBeVisible();
  expect(runtimeErrors).toEqual([]);

  const detector = await page.evaluate(() => typeof window.PanelPilot?.detectPanels);
  expect(detector).toBe("function");
});

test("the stats outbox and device identity survive an application reload", async ({ page }) => {
  const backend = createStatsBackend({ settings: { enabled: true, since: populatedSummary.since } });
  await backend.attach(page);
  backend.setOnline(false);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const before = await page.evaluate(async () => {
    await window.PanelPilot.readingStats.recordChapterFinish({
      titleKey: "title-key",
      chapterKey: "chapter-key",
      attemptId: "attempt-key",
      offline: true,
    });
    const items = await window.PanelPilot.readingStats.getOutbox();
    return { deviceId: items[0].deviceId, eventId: items[0].eventId };
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  const after = await page.evaluate(async () => {
    const items = await window.PanelPilot.readingStats.getOutbox();
    return { deviceId: items[0].deviceId, eventId: items[0].eventId };
  });
  expect(after).toEqual(before);

  backend.setOnline(true);
  await page.evaluate(() => window.PanelPilot.readingStats.flush());
  await expect.poll(() => backend.state.receivedEvents.length).toBe(1);
  expect(backend.state.receivedEvents[0]).toMatchObject({ ...before, offline: true });
});

test("a server-disabled response never discards unaccepted local events", async ({ page }) => {
  const backend = createStatsBackend({ settings: { enabled: false } });
  await backend.attach(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.readingStats?.recordPageView)).toBe("function");

  await page.evaluate(async () => {
    await window.PanelPilot.readingStats.recordPageView({
      titleKey: "sha256:title-key",
      chapterKey: "sha256:chapter-key",
      pageIndex: 1,
      offline: false,
    });
    await window.PanelPilot.readingStats.flush();
  });
  await expect.poll(() => page.evaluate(() => window.PanelPilot.readingStats.getOutbox().then((items) => items.length))).toBe(1);
  expect(backend.state.receivedEvents).toEqual([]);
});
