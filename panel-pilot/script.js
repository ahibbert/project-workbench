const storeKey = "panel-pilot-settings";
const panelModeStoreKey = "panel-pilot-panel-mode";
const libraryStoreKey = "panel-pilot-library";
const sourceIndexStoreKey = "panel-pilot-source-index";
const sourceIndexTtlMs = 24 * 60 * 60 * 1000;
const sourceIndexPageLimit = 6;
const sourceIndexRequestTimeoutMs = 12000;
const appVersion = "v95";
const appBuildTime = "2026-09-30";
const detectorVersion = "detector v18-ml-manga";
const pageImageRetryDelaysMs = [0, 350, 1200];
const chapterFetchRetryDelaysMs = [0, 700, 1800];
const backgroundPageConcurrency = 2;
const nextChapterPreparedPageCount = 3;
const downloadAheadChapterCount = 10;
const allSourcesValue = "__all__";
const defaultComickChapter = {
  label: "Frieren chapter 1",
  chap: "1",
  group: "Kirei Cake",
  url: "https://comick.live/comic/00-sousou-no-frieren/gx1Lk-chapter-1-en",
};

const queries = {
  health: `query HEALTH { __schema { queryType { name } mutationType { name } } }`,
  sources: `query GET_SOURCES_LIST {
    sources {
      nodes {
        id
        name
        displayName
        lang
        iconUrl
        isNsfw
        supportsLatest
        extension { pkgName repo }
      }
    }
  }`,
  libraryMangas: `query GET_LIBRARY_MANGAS {
    mangas(condition: { inLibrary: true }, first: 500) {
      totalCount
      nodes {
        id
        title
        thumbnailUrl
        inLibrary
        initialized
        sourceId
        source {
          id
          name
          displayName
          lang
          isNsfw
        }
      }
    }
  }`,
  searchSource: `mutation GET_SOURCE_MANGAS_FETCH($input: FetchSourceMangaInput!) {
    fetchSourceManga(input: $input) {
      hasNextPage
      mangas {
        id
        title
        thumbnailUrl
        inLibrary
        initialized
        sourceId
      }
    }
  }`,
  mangaCard: `query GET_MANGA_CARD($id: Int!) {
    manga(id: $id) {
      id
      title
      thumbnailUrl
    }
  }`,
  fetchChapters: `mutation GET_MANGA_CHAPTERS_FETCH($input: FetchChaptersInput!) {
    fetchChapters(input: $input) {
      chapters {
        id
        name
        mangaId
        scanlator
        sourceOrder
        chapterNumber
        pageCount
        isRead
        lastPageRead
        isDownloaded
        isBookmarked
      }
    }
  }`,
  fetchPages: `mutation GET_CHAPTER_PAGES_FETCH($input: FetchChapterPagesInput!) {
    fetchChapterPages(input: $input) {
      chapter {
        id
        name
        realUrl
        url
        pageCount
        manga {
          source {
            name
            displayName
            lang
          }
        }
      }
      pages
    }
  }`,
  updateChapter: `mutation UPDATE_CHAPTER_PROGRESS($input: UpdateChapterInput!) {
    updateChapter(input: $input) {
      chapter {
        id
        isRead
        lastPageRead
      }
    }
  }`,
  updateManga: `mutation UPDATE_MANGA_LIBRARY($input: UpdateMangaInput!) {
    updateManga(input: $input) {
      manga {
        id
        inLibrary
      }
    }
  }`,
  storedChapters: `query GET_STORED_CHAPTERS($mangaId: Int!) {
    chapters(condition: { mangaId: $mangaId }, first: 5000) {
      nodes {
        id
        name
        mangaId
        scanlator
        sourceOrder
        chapterNumber
        pageCount
        isRead
        lastPageRead
        isDownloaded
        isBookmarked
      }
    }
  }`,
};

const el = {
  stage: document.querySelector("#stage"),
  appViews: [...document.querySelectorAll(".app-view")],
  appNavButtons: [...document.querySelectorAll("[data-target-view]")],
  navReader: document.querySelector("#nav-reader"),
  navReaderCover: document.querySelector("#nav-reader-cover"),
  navReaderFallback: document.querySelector("#nav-reader-fallback"),
  navReaderImage: document.querySelector("#nav-reader-image"),
  navReaderLabel: document.querySelector("#nav-reader-label"),
  navReaderTitle: document.querySelector("#nav-reader-title"),
  readerBack: document.querySelector("#reader-back"),
  stageImage: document.querySelector("#stage-image"),
  stageImageWrap: document.querySelector("#stage-image-wrap"),
  readerLoading: document.querySelector("#reader-loading"),
  readerLoadingBar: document.querySelector("#reader-loading-bar"),
  readerLoadingText: document.querySelector("#reader-loading-text"),
  readerError: document.querySelector("#reader-error"),
  readerErrorTitle: document.querySelector("#reader-error-title"),
  readerErrorMessage: document.querySelector("#reader-error-message"),
  readerErrorRetry: document.querySelector("#reader-error-retry"),
  readerErrorBack: document.querySelector("#reader-error-back"),
  chapterTitle: document.querySelector("#chapter-title"),
  pageStat: document.querySelector("#page-stat"),
  panelStat: document.querySelector("#panel-stat"),
  panelCount: document.querySelector("#panel-count"),
  panelStrip: document.querySelector("#panel-strip"),
  prevPanel: document.querySelector("#prev-panel"),
  nextPanel: document.querySelector("#next-panel"),
  panelPadding: document.querySelector("#panel-padding"),
  panelPaddingValue: document.querySelector("#panel-padding-value"),
  toggleFit: document.querySelector("#toggle-fit"),
  hideReaderControls: document.querySelector("#hide-reader-controls"),
  toggleReaderMode: document.querySelector("#toggle-reader-mode"),
  readerOptions: document.querySelector(".reader-options"),
  redetect: document.querySelector("#redetect"),
  redetectChapter: document.querySelector("#redetect-chapter"),
  reportBadPanels: document.querySelector("#report-bad-panels"),
  mangaMode: document.querySelector("#manga-mode"),
  comicMode: document.querySelector("#comic-mode"),
  webtoonMode: document.querySelector("#webtoon-mode"),
  serverUrl: document.querySelector("#server-url"),
  testConnection: document.querySelector("#test-connection"),
  loadSources: document.querySelector("#load-sources"),
  loadDemo: document.querySelector("#load-demo"),
  clearAppCache: document.querySelector("#clear-app-cache"),
  showNsfwSources: document.querySelector("#show-nsfw-sources"),
  toggleSuwayomiPanel: document.querySelector("#toggle-suwayomi-panel"),
  suwayomiSetup: document.querySelector("#suwayomi-setup"),
  openSuwayomi: document.querySelector("#open-suwayomi"),
  toggleLibraryPanel: document.querySelector("#toggle-library-panel"),
  toggleHiddenLibrary: document.querySelector("#toggle-hidden-library"),
  libraryBody: document.querySelector("#library-body"),
  libraryList: document.querySelector("#library-list"),
  libraryCount: document.querySelector("#library-count"),
  toggleBrowsePanel: document.querySelector("#toggle-browse-panel"),
  browseBody: document.querySelector("#browse-body"),
  browsePrompt: document.querySelector("#browse-prompt"),
  browseOpenSettings: document.querySelector("#browse-open-settings"),
  sourceSelect: document.querySelector("#source-select"),
  sourceCount: document.querySelector("#source-count"),
  searchQuery: document.querySelector("#search-query"),
  searchSource: document.querySelector("#search-source"),
  mangaResults: document.querySelector("#manga-results"),
  mangaDetail: document.querySelector("#manga-detail"),
  closeMangaDetail: document.querySelector("#close-manga-detail"),
  detailCover: document.querySelector("#detail-cover"),
  detailCoverFallback: document.querySelector("#detail-cover-fallback"),
  detailCoverImage: document.querySelector("#detail-cover-image"),
  detailSource: document.querySelector("#detail-source"),
  detailTitle: document.querySelector("#detail-title"),
  mangaId: document.querySelector("#manga-id"),
  fetchChapters: document.querySelector("#fetch-chapters"),
  chapterList: document.querySelector("#chapter-list"),
  chapterCount: document.querySelector("#chapter-count"),
  scanlatorSelect: document.querySelector("#scanlator-select"),
  chapterId: document.querySelector("#chapter-id"),
  loadChapterPages: document.querySelector("#load-chapter-pages"),
  connectionDot: document.querySelector("#connection-dot"),
  connectionNote: document.querySelector("#connection-note"),
  versionNote: document.querySelector("#version-note"),
  syncProgress: document.querySelector("#sync-progress"),
  syncState: document.querySelector("#sync-state"),
  syncNote: document.querySelector("#sync-note"),
  offlineNote: document.querySelector("#offline-note"),
  appToast: document.querySelector("#app-toast"),
  rtlOrder: document.querySelector("#rtl-order"),
  ltrOrder: document.querySelector("#ltr-order"),
  comickUrl: document.querySelector("#comick-url"),
  loadComickChapters: document.querySelector("#load-comick-chapters"),
  loadComickLatest: document.querySelector("#load-comick-latest"),
  loadComickDefault: document.querySelector("#load-comick-default"),
  comickChapterNumber: document.querySelector("#comick-chapter-number"),
  loadComickNumber: document.querySelector("#load-comick-number"),
  loadComickMore: document.querySelector("#load-comick-more"),
  comickList: document.querySelector("#comick-list"),
  comickCount: document.querySelector("#comick-count"),
};

const state = {
  baseUrl: "http://localhost:4567",
  sources: [],
  visibleSources: [],
  sourceIndex: { entries: [], updatedAt: "", sourceIds: [] },
  sourceIndexing: false,
  mangas: [],
  chapters: [],
  chapterView: [],
  scanlatorFilter: "auto",
  currentManga: null,
  libraryItems: [],
  pendingResume: null,
  chapterPageUrls: [],
  pages: [],
  pageIndex: 0,
  panelIndex: 0,
  fullPage: false,
  panelMode: "manga",
  panelPadding: 8,
  readingDirection: "rtl",
  connected: false,
  comickChapters: [],
  comickPage: 0,
  comickHasMore: false,
  activeChapter: null,
  prepareGeneration: 0,
  backgroundPreparing: false,
  nextChapterPrefetch: null,
  nextChapterPrefetchTimer: null,
  mangaModelAvailable: null,
  navigationPending: false,
  navigationRequestId: 0,
  navigationCooldownUntil: 0,
  readerFocus: false,
  readerChromeVisible: true,
  activeView: "library",
  previousView: "library",
  suwayomiSetupOpen: false,
  showNsfwSources: false,
  showHiddenLibrary: false,
  libraryOpen: true,
  browseOpen: true,
  suwayomiSyncTimer: null,
  lastSuwayomiSyncKey: "",
  suwayomiSyncing: false,
  suwayomiSyncPromise: null,
  viewScrollPositions: { library: 0, browse: 0, settings: 0 },
  browseDiscoveryScroll: 0,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) || "{}");
    if (saved.baseUrl) state.baseUrl = saved.baseUrl;
    if (typeof saved.suwayomiSetupOpen === "boolean") state.suwayomiSetupOpen = saved.suwayomiSetupOpen;
    if (typeof saved.showNsfwSources === "boolean") state.showNsfwSources = saved.showNsfwSources;
    if (typeof saved.showHiddenLibrary === "boolean") state.showHiddenLibrary = saved.showHiddenLibrary;
    if (typeof saved.libraryOpen === "boolean") state.libraryOpen = saved.libraryOpen;
    if (typeof saved.browseOpen === "boolean") state.browseOpen = saved.browseOpen;
    if (isAppView(saved.activeView) && saved.activeView !== "reader") state.activeView = saved.activeView;
    if (isPanelMode(saved.panelMode)) state.panelMode = saved.panelMode;
    if (saved.scanlatorFilter) state.scanlatorFilter = saved.scanlatorFilter;
    const savedPanelMode = localStorage.getItem(panelModeStoreKey);
    if (isPanelMode(savedPanelMode)) state.panelMode = savedPanelMode;
    if (saved.readingDirection) state.readingDirection = saved.readingDirection;
    if (Number.isFinite(saved.panelPadding)) state.panelPadding = clamp(saved.panelPadding, 0, 25);
  } catch {
    // Ignore malformed local storage.
  }

  // Connection and diagnostics stay collapsed on every fresh app visit.
  state.suwayomiSetupOpen = false;

  el.serverUrl.value = state.baseUrl;
  if (el.showNsfwSources) el.showNsfwSources.checked = state.showNsfwSources;
  updateHiddenLibraryToggle();
  updateSuwayomiSetupPanel();
  updateCollapsiblePanel(el.libraryBody, el.toggleLibraryPanel, state.libraryOpen);
  updateCollapsiblePanel(el.browseBody, el.toggleBrowsePanel, state.browseOpen);
  updateSuwayomiLink();
  if (el.panelPadding) el.panelPadding.value = String(state.panelPadding);
  updatePaddingControl();
  updatePanelModeControls();
  setReadingDirection(state.readingDirection);
}

function saveSettings() {
  localStorage.setItem(panelModeStoreKey, state.panelMode);
  localStorage.setItem(
    storeKey,
    JSON.stringify({
      baseUrl: state.baseUrl,
      panelMode: state.panelMode,
      readingDirection: state.readingDirection,
      panelPadding: state.panelPadding,
      suwayomiSetupOpen: state.suwayomiSetupOpen,
      showNsfwSources: state.showNsfwSources,
      showHiddenLibrary: state.showHiddenLibrary,
      libraryOpen: state.libraryOpen,
      browseOpen: state.browseOpen,
      activeView: state.activeView === "reader" ? state.previousView : state.activeView,
      scanlatorFilter: state.scanlatorFilter,
    })
  );
}

function isAppView(view) {
  return view === "library" || view === "browse" || view === "reader" || view === "settings";
}

function setActiveView(view) {
  if (!isAppView(view)) return;
  const previous = state.activeView;
  if (previous && previous !== "reader") state.viewScrollPositions[previous] = window.scrollY;
  if (view === "reader" && previous !== "reader") {
    state.previousView = previous;
  }
  if (view !== "reader") {
    state.previousView = view;
  }

  state.activeView = view;
  el.appViews.forEach((item) => {
    const isActive = item.dataset.view === view;
    item.classList.toggle("active", isActive);
    item.toggleAttribute("hidden", !isActive);
  });
  el.appNavButtons.forEach((button) => {
    const isActive = button.dataset.targetView === view;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  });
  document.body.classList.toggle("reader-active", view === "reader");

  if (view === "reader") {
    setReaderFocus(isReaderFocusAvailable());
  } else {
    setReaderFocus(false);
  }
  requestAnimationFrame(() => {
    if (view !== "reader") window.scrollTo({ top: state.viewScrollPositions[view] || 0 });
    fitStage();
  });
  saveSettings();
}

function leaveReaderView() {
  cancelReaderNavigation();
  setActiveView(state.previousView && state.previousView !== "reader" ? state.previousView : "library");
}

function cleanBaseUrl() {
  const rawUrl = el.serverUrl?.value || state.baseUrl || "http://localhost:4567";
  state.baseUrl = rawUrl.trim().replace(/\/+$/, "");
  if (el.serverUrl) el.serverUrl.value = state.baseUrl;
  updateSuwayomiLink();
  saveSettings();
  return state.baseUrl;
}

function updateSuwayomiLink() {
  if (!el.openSuwayomi) return;
  const url = (el.serverUrl?.value || state.baseUrl || "http://localhost:4567").trim() || "http://localhost:4567";
  el.openSuwayomi.href = externalSuwayomiUrl(url);
}

function externalSuwayomiUrl(url) {
  try {
    const parsed = new URL(url);
    const localSuwayomi = ["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname);
    const localApp = ["localhost", "127.0.0.1", "0.0.0.0"].includes(location.hostname);
    if (localSuwayomi && !localApp && location.hostname) {
      return `http://${location.hostname}:4567`;
    }
  } catch {
    return url;
  }
  return url;
}

function updateSuwayomiSetupPanel() {
  if (!el.suwayomiSetup || !el.toggleSuwayomiPanel) return;
  el.suwayomiSetup.hidden = !state.suwayomiSetupOpen;
  el.toggleSuwayomiPanel.textContent = state.suwayomiSetupOpen ? "Done" : "Advanced";
  el.toggleSuwayomiPanel.setAttribute("aria-expanded", state.suwayomiSetupOpen ? "true" : "false");
}

function toggleSuwayomiSetupPanel() {
  state.suwayomiSetupOpen = !state.suwayomiSetupOpen;
  updateSuwayomiSetupPanel();
  saveSettings();
}

function updateCollapsiblePanel(body, button, isOpen) {
  if (!body || !button) return;
  body.hidden = !isOpen;
  button.textContent = isOpen ? "Hide" : "Show";
  button.setAttribute("aria-expanded", isOpen ? "true" : "false");
}

function toggleLibraryPanel() {
  state.libraryOpen = !state.libraryOpen;
  updateCollapsiblePanel(el.libraryBody, el.toggleLibraryPanel, state.libraryOpen);
  saveSettings();
}

function toggleBrowsePanel() {
  state.browseOpen = !state.browseOpen;
  updateCollapsiblePanel(el.browseBody, el.toggleBrowsePanel, state.browseOpen);
  saveSettings();
}

function setShowNsfwSources(value) {
  state.showNsfwSources = Boolean(value);
  if (el.showNsfwSources) el.showNsfwSources.checked = state.showNsfwSources;
  state.visibleSources = filterSourceVariants(state.sources);
  renderSources();
  renderLibrary();
  saveSettings();
}

function setShowHiddenLibrary(value) {
  state.showHiddenLibrary = Boolean(value);
  updateHiddenLibraryToggle();
  renderLibrary();
  saveSettings();
}

function updateHiddenLibraryToggle() {
  if (!el.toggleHiddenLibrary) return;
  el.toggleHiddenLibrary.textContent = state.showHiddenLibrary ? "Visible" : "Hidden";
  el.toggleHiddenLibrary.setAttribute("aria-pressed", state.showHiddenLibrary ? "true" : "false");
  el.toggleHiddenLibrary.classList.toggle("active", state.showHiddenLibrary);
}

function setConnection(connected, message, tone = "") {
  state.connected = connected;
  el.connectionDot.classList.toggle("connected", connected);
  el.connectionNote.textContent = message;
  el.connectionNote.className = `note ${tone}`;
}

async function graphQL(query, variables = {}, options = {}) {
  const baseUrl = cleanBaseUrl();
  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout = controller
    ? window.setTimeout(() => controller.abort(), options.timeoutMs)
    : null;
  try {
    const response = await fetch(appUrl(`/api/suwayomi/graphql?base=${encodeURIComponent(baseUrl)}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller?.signal,
    });

    const payload = await response.json().catch(() => null);
    handleAuthenticationResponse(response, payload);
    if (!response.ok || !payload) {
      throw new Error(`GraphQL request failed with HTTP ${response.status}`);
    }
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((item) => item.message).join(" / "));
    }
    return payload.data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("GraphQL request timed out");
    throw error;
  } finally {
    if (timeout) window.clearTimeout(timeout);
  }
}

function friendlySourceErrorMessage(error) {
  const message = error?.message || "Unknown error";
  if (/api rate limit exceeded|rate limit|mangahub\.io/i.test(message)) {
    return "This source has temporarily rate-limited chapter pages. Try again later or switch this title to another source.";
  }
  if (
    /cloudflare|403|502|unexpected json token|json input:\s*<|had '<'|<html|graphQL request failed with HTTP 200/i.test(message)
  ) {
    return "Source not responding, try again in a few minutes.";
  }
  return message;
}

async function localJson(path) {
  const response = await fetch(appUrl(path));
  const payload = await response.json().catch(() => null);
  handleAuthenticationResponse(response, payload);
  if (!response.ok || !payload) {
    throw new Error(`Local request failed with HTTP ${response.status}`);
  }
  if (payload.error) {
    throw new Error(payload.error);
  }
  return payload;
}

async function postLocalJson(path, body) {
  const response = await fetch(appUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  handleAuthenticationResponse(response, payload);
  if (!response.ok || !payload) {
    throw new Error(`Local request failed with HTTP ${response.status}`);
  }
  if (payload.error) {
    throw new Error(payload.error);
  }
  return payload;
}

function handleAuthenticationResponse(response, payload) {
  if (response.status !== 401) return;
  const login = payload?.login || "/login";
  const next = `${location.pathname}${location.search}${location.hash}`;
  location.assign(`${login}?next=${encodeURIComponent(next)}`);
  throw new Error("Your Panel Pilot session expired. Redirecting to sign in.");
}

function appUrl(path) {
  return new URL(path, location.origin).toString();
}

function normalizeUrl(url) {
  if (!url) return "";
  if (/^data:|^blob:|^https?:/i.test(url)) return url;
  const base = cleanBaseUrl();
  if (url.startsWith("/")) return `${new URL(base).origin}${url}`;
  return `${base}/${url}`;
}

function normalizeSuwayomiPageUrl(url) {
  if (!url) return "";
  if (url.startsWith("/api/image")) return appUrl(url);
  const base = cleanBaseUrl();
  let target = url;
  if (/^https?:/i.test(url)) {
    const parsed = new URL(url);
    const parsedBase = new URL(base);
    if (parsed.origin !== parsedBase.origin) return url;
    target = `${parsed.pathname}${parsed.search}`;
  }
  if (!target.startsWith("/")) target = `/${target}`;
  return appUrl(`/api/suwayomi/asset?base=${encodeURIComponent(base)}&path=${encodeURIComponent(target)}`);
}

function setReaderLoading(active, text = "Loading chapter...", progress = 12) {
  if (!el.readerLoading) return;
  el.readerLoading.classList.toggle("active", active);
  el.readerLoading.setAttribute("aria-hidden", active ? "false" : "true");
  if (el.readerLoadingText) el.readerLoadingText.textContent = text;
  if (el.readerLoadingBar) {
    el.readerLoadingBar.style.setProperty("--reader-loading-progress", `${clamp(progress, 0, 100)}%`);
  }
}

function isTextEntryTarget(target) {
  if (!target) return false;
  const tagName = target.tagName?.toLowerCase();
  return (
    target.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select"
  );
}

function isReaderFocusAvailable() {
  return window.matchMedia("(max-width: 1024px), (max-height: 540px) and (pointer: coarse)").matches;
}

function setReaderFocus(active) {
  state.readerFocus = Boolean(active && isReaderFocusAvailable());
  if (!state.readerFocus) state.readerChromeVisible = true;
  document.body.classList.toggle("reader-focus", state.readerFocus);
  document.body.classList.toggle("reader-chrome-hidden", state.readerFocus && !state.readerChromeVisible);
  if (el.toggleReaderMode) el.toggleReaderMode.textContent = state.activeView === "reader" ? "Back" : "Reader";
  requestAnimationFrame(fitStage);
}

function toggleReaderFocus() {
  if (state.activeView === "reader") {
    leaveReaderView();
    return;
  }
  setActiveView("reader");
}

function setReaderChromeVisible(visible) {
  state.readerChromeVisible = Boolean(visible);
  document.body.classList.toggle("reader-chrome-hidden", state.readerFocus && !state.readerChromeVisible);
  requestAnimationFrame(fitStage);
}

function toggleReaderChrome() {
  setReaderChromeVisible(!state.readerChromeVisible);
}

function hideReaderControls() {
  if (state.activeView !== "reader") return;
  setReaderFocus(true);
  setReaderChromeVisible(false);
}

async function loadComickChapters({ append = false, page = 1 } = {}) {
  const comicUrl = el.comickUrl.value.trim();
  if (!comicUrl) {
    setConnection(state.connected, "Enter a Comick comic URL first.", "bad");
    return;
  }

  setBusy(el.loadComickChapters, true, "Loading");
  setBusy(el.loadComickMore, true, "Loading");
  try {
    const payload = await localJson(
      `/api/comick/chapters?lang=en&page=${encodeURIComponent(page)}&url=${encodeURIComponent(comicUrl)}`
    );
    const chapters = payload.chapters || [];
    state.comickChapters = append ? mergeComickChapters(state.comickChapters, chapters) : chapters;
    state.comickPage = page;
    state.comickHasMore = chapters.length >= 60;
    renderComickChapters();
    setConnection(
      state.connected,
      `Loaded ${state.comickChapters.length} Comick chapters for ${payload.slug}.`,
      "good"
    );
  } catch (error) {
    setConnection(state.connected, `Could not load Comick chapters: ${error.message}`, "bad");
  } finally {
    setBusy(el.loadComickChapters, false);
    setBusy(el.loadComickMore, false);
  }
}

function mergeComickChapters(existing, next) {
  const seen = new Set(existing.map((chapter) => chapter.url));
  const merged = existing.slice();
  next.forEach((chapter) => {
    if (seen.has(chapter.url)) return;
    seen.add(chapter.url);
    merged.push(chapter);
  });
  return merged;
}

function renderComickChapters() {
  el.comickList.replaceChildren();
  el.comickCount.textContent = `${state.comickChapters.length} chapters`;
  if (el.loadComickMore) el.loadComickMore.disabled = !state.comickHasMore;

  if (!state.comickChapters.length) {
    el.comickList.append(emptyLine("No Comick chapters loaded."));
    return;
  }

  state.comickChapters.forEach((chapter) => {
    const item = document.createElement("div");
    item.className = "result-item";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = chapter.label;
    const meta = document.createElement("span");
    meta.textContent = chapter.group || "Comick";
    copy.append(title, meta);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Read";
    button.addEventListener("click", () => loadComickChapter(chapter));

    item.append(copy, button);
    el.comickList.append(item);
  });
}

async function loadComickLatest() {
  if (!state.comickChapters.length) {
    await loadComickChapters();
  }
  const chapter = state.comickChapters[0];
  if (chapter) {
    await loadComickChapter(chapter);
  }
}

async function loadComickDefault() {
  await loadComickChapter(defaultComickChapter);
}

async function loadComickMore() {
  await loadComickChapters({ append: true, page: state.comickPage + 1 || 2 });
}

async function loadComickNumber() {
  const chapterNumber = el.comickChapterNumber.value.trim();
  const comicUrl = el.comickUrl.value.trim();
  if (!chapterNumber || !comicUrl) {
    setConnection(state.connected, "Enter a Comick URL and chapter number first.", "bad");
    return;
  }

  setBusy(el.loadComickNumber, true, "Loading");
  try {
    const payload = await localJson(
      `/api/comick/chapters?lang=en&chap=${encodeURIComponent(chapterNumber)}&url=${encodeURIComponent(comicUrl)}`
    );
    const chapter = chooseComickChapter(payload.chapters || []);
    if (!chapter) throw new Error(`No chapter ${chapterNumber} found.`);
    await loadComickChapter(chapter);
  } catch (error) {
    setConnection(state.connected, `Could not load Comick chapter ${chapterNumber}: ${error.message}`, "bad");
  } finally {
    setBusy(el.loadComickNumber, false);
  }
}

function chooseComickChapter(chapters) {
  if (!chapters.length) return null;
  return (
    chapters.find((chapter) => chapter.group?.includes("Kirei Cake")) ||
    chapters.find((chapter) => chapter.group?.includes("Official")) ||
    chapters.find((chapter) => chapter.title) ||
    chapters[0]
  );
}

async function loadComickChapter(chapter) {
  setBusy(el.loadComickLatest, true, "Loading");
  setBusy(el.loadComickDefault, true, "Loading");
  setBusy(el.loadComickNumber, true, "Loading");
  try {
    const payload = await localJson(`/api/comick/chapter?url=${encodeURIComponent(chapter.url)}`);
    if (!payload.pages?.length) {
      throw new Error("No page images found on the chapter page.");
    }
    state.activeChapter = {
      type: "comick",
      chapter,
      comicUrl: el.comickUrl.value.trim(),
    };
    if (chapter.chap && el.comickChapterNumber) el.comickChapterNumber.value = chapter.chap;
    await loadChapter(payload.pages, payload.title || chapter.label);
    setConnection(
      state.connected,
      `Loaded ${payload.pages.length} Comick pages through the local image proxy.`,
      "good"
    );
  } catch (error) {
    setConnection(state.connected, `Could not load Comick chapter: ${error.message}`, "bad");
  } finally {
    setBusy(el.loadComickLatest, false);
    setBusy(el.loadComickDefault, false);
    setBusy(el.loadComickNumber, false);
  }
}

function setBusy(button, busy, labelWhenBusy = "Working") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = labelWhenBusy;
    button.disabled = true;
    return;
  }
  button.textContent = button.dataset.originalText || button.textContent;
  button.disabled = false;
}

async function testConnection() {
  setBusy(el.testConnection, true, "Testing");
  try {
    const data = await graphQL(queries.health);
    if (!data.__schema?.queryType?.name) throw new Error("Suwayomi did not return a valid response.");
    setConnection(true, "Suwayomi connected.", "good");
    return true;
  } catch (error) {
    setConnection(false, "Suwayomi is unavailable. Open Advanced to check the server connection.", "bad");
    return false;
  } finally {
    setBusy(el.testConnection, false);
  }
}

async function loadSources() {
  setBusy(el.loadSources, true, "Loading");
  try {
    const data = await graphQL(queries.sources);
    state.sources = (data.sources?.nodes || []).sort((a, b) =>
      sourceLabel(a).localeCompare(sourceLabel(b))
    );
    state.visibleSources = filterSourceVariants(state.sources);
    renderSources();
    loadSourceIndexCache();
    const hasFreshIndex = sourceIndexIsFresh();
    if (!hasFreshIndex) warmSourceIndexInBackground();
    setConnection(
      true,
      hasFreshIndex
        ? `Loaded ${state.visibleSources.length} usable sources from ${state.sources.length} installed sources. ${state.sourceIndex.entries.length} indexed titles ready.`
        : `Loaded ${state.visibleSources.length} usable sources from ${state.sources.length} installed sources. Indexing titles in the background.`,
      "good"
    );
    return true;
  } catch (error) {
    setConnection(false, `Could not load sources: ${friendlySourceErrorMessage(error)}`, "bad");
    return false;
  } finally {
    setBusy(el.loadSources, false);
  }
}

function sourceLabel(source) {
  const name = source.displayName || source.name || source.id;
  return source.lang ? `${name} (${source.lang})` : name;
}

function sourceFamilyKey(source) {
  const label = source.displayName || source.name || String(source.id || "");
  return label
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(en|eng|english|all|original|unoriginal|translated|scanlated)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isEnglishSource(source) {
  const lang = String(source.lang || "").toLowerCase();
  const label = sourceLabel(source).toLowerCase();
  return lang === "en" || /\b(en|eng|english)\b/.test(label);
}

function filterSourceVariants(sources) {
  const groups = new Map();
  sources.filter(isBrowseableSource).forEach((source) => {
    const key = sourceFamilyKey(source) || String(source.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(source);
  });

  const filtered = [];
  groups.forEach((items) => {
    if (items.length === 1) {
      filtered.push(items[0]);
      return;
    }

    const english = items.filter(isEnglishSource);
    filtered.push(...(english.length ? english : [items[0]]));
  });

  return filtered.sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b)));
}

function isBrowseableSource(source) {
  const label = sourceLabel(source).toLowerCase();
  if (label.includes("local source") || label.includes("localsourcelang")) return false;
  if (!state.showNsfwSources && isNsfwSource(source)) return false;
  return true;
}

function isNsfwSource(source) {
  if (!source) return false;
  const label = sourceLabel(source).toLowerCase();
  return label.includes("manhwa18") || label.includes("manhwa18.cc");
}

function renderSources() {
  el.sourceSelect.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = allSourcesValue;
  allOption.textContent = "All enabled sources";
  el.sourceSelect.append(allOption);

  state.visibleSources.forEach((source) => {
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = sourceLabel(source);
    el.sourceSelect.append(option);
  });
  el.sourceSelect.value = allSourcesValue;
  el.sourceCount.textContent = `${state.visibleSources.length} source${state.visibleSources.length === 1 ? "" : "s"} available`;
  if (el.browseOpenSettings) el.browseOpenSettings.hidden = state.visibleSources.length > 0;
}

async function searchSource() {
  const selectedSource = el.sourceSelect.value;
  const query = el.searchQuery.value.trim();
  if (!selectedSource) {
    setConnection(state.connected, "Connect Suwayomi in Settings to search manga.", "bad");
    showToast("Set up Suwayomi sources first.", "bad");
    return;
  }
  if (!query) {
    showToast("Enter a manga title first.", "bad");
    return;
  }

  if (el.browsePrompt) el.browsePrompt.hidden = true;
  renderMangaSkeletons();
  setBusy(el.searchSource, true, "Searching");
  let hadIndexedResults = false;
  try {
    const sources =
      selectedSource === allSourcesValue
        ? state.visibleSources
        : state.visibleSources.filter((source) => String(source.id) === String(selectedSource));
    const indexedResults = searchIndexedMangas(query, sources);
    hadIndexedResults = indexedResults.length > 0;
    if (hadIndexedResults) {
      state.mangas = sortMangaResults(indexedResults, query);
      renderMangaResults();
      setConnection(true, `Showing ${state.mangas.length} indexed result${state.mangas.length === 1 ? "" : "s"}. Refreshing live search...`, "good");
    }

    const results = [];
    const failures = [];
    for (const source of sources) {
      try {
        const data = await graphQL(queries.searchSource, {
          input: { source: source.id, query, page: 1, type: "SEARCH" },
        });
        (data.fetchSourceManga?.mangas || []).forEach((manga) => {
          results.push({ ...manga, sourceId: manga.sourceId || source.id });
        });
      } catch (error) {
        failures.push(sourceLabel(source));
      }
    }
    addMangasToSourceIndex(results);
    state.mangas = sortMangaResults(uniqueMangaResults(results), query);
    renderMangaResults();
    const suffix = failures.length ? ` ${failures.length} source${failures.length === 1 ? "" : "s"} did not respond.` : "";
    setConnection(true, `Found ${state.mangas.length} manga results across ${sources.length} source${sources.length === 1 ? "" : "s"}.${suffix}`, "good");
  } catch (error) {
    if (hadIndexedResults) {
      setConnection(true, `Showing indexed results. Live search failed: ${friendlySourceErrorMessage(error)}`, "good");
    } else {
      setConnection(false, `Search failed: ${friendlySourceErrorMessage(error)}`, "bad");
    }
  } finally {
    setBusy(el.searchSource, false);
  }
}

function loadSourceIndexCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(sourceIndexStoreKey) || "{}");
    if (!Array.isArray(cached.entries)) return;
    state.sourceIndex = {
      entries: uniqueMangaResults(cached.entries.filter((manga) => manga?.id && manga?.title && manga?.sourceId)),
      updatedAt: cached.updatedAt || "",
      sourceIds: Array.isArray(cached.sourceIds) ? cached.sourceIds.map(String) : [],
    };
  } catch {
    state.sourceIndex = { entries: [], updatedAt: "", sourceIds: [] };
  }
}

function saveSourceIndexCache() {
  try {
    localStorage.setItem(sourceIndexStoreKey, JSON.stringify(state.sourceIndex));
  } catch {
    // Search still works through live Suwayomi if the local index cannot be saved.
  }
}

function sourceIndexSignature(sources = state.visibleSources) {
  return sources.map((source) => String(source.id)).sort();
}

function sourceIndexIsFresh() {
  if (!state.sourceIndex.entries?.length) return false;
  const expected = sourceIndexSignature();
  const actual = (state.sourceIndex.sourceIds || []).map(String).sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) return false;
  const updatedAt = Date.parse(state.sourceIndex.updatedAt || "");
  return Number.isFinite(updatedAt) && Date.now() - updatedAt < sourceIndexTtlMs;
}

async function warmSourceIndexInBackground(force = false) {
  if (state.sourceIndexing || !state.visibleSources.length) return;
  if (!force && sourceIndexIsFresh()) return;
  state.sourceIndexing = true;
  const sources = [...state.visibleSources];
  const indexed = [];
  const failures = [];

  try {
    for (const source of sources) {
      for (let page = 1; page <= sourceIndexPageLimit; page += 1) {
        try {
          const data = await graphQL(queries.searchSource, {
            input: { source: source.id, query: "", page, type: "POPULAR" },
          }, { timeoutMs: sourceIndexRequestTimeoutMs });
          const mangas = data.fetchSourceManga?.mangas || [];
          mangas.forEach((manga) => indexed.push(normalizeIndexedManga(manga, source.id)));
          if (!data.fetchSourceManga?.hasNextPage || !mangas.length) break;
          await sleep(80);
        } catch {
          failures.push(sourceLabel(source));
          break;
        }
      }
    }

    state.sourceIndex = {
      entries: uniqueMangaResults(indexed.filter(Boolean)),
      updatedAt: new Date().toISOString(),
      sourceIds: sourceIndexSignature(sources),
    };
    saveSourceIndexCache();
    const suffix = failures.length ? ` ${failures.length} source${failures.length === 1 ? "" : "s"} could not be indexed.` : "";
    setConnection(true, `Indexed ${state.sourceIndex.entries.length} titles for faster search.${suffix}`, "good");
  } finally {
    state.sourceIndexing = false;
  }
}

function normalizeIndexedManga(manga, fallbackSourceId) {
  if (!manga?.id || !manga?.title) return null;
  return {
    id: manga.id,
    title: manga.title,
    sourceId: manga.sourceId || fallbackSourceId,
    thumbnailUrl: manga.thumbnailUrl,
    inLibrary: manga.inLibrary,
    initialized: manga.initialized,
  };
}

function addMangasToSourceIndex(results) {
  const additions = results.map((manga) => normalizeIndexedManga(manga, manga.sourceId)).filter(Boolean);
  if (!additions.length) return;
  state.sourceIndex = {
    entries: uniqueMangaResults([...(state.sourceIndex.entries || []), ...additions]),
    updatedAt: new Date().toISOString(),
    sourceIds: sourceIndexSignature(),
  };
  saveSourceIndexCache();
}

function searchIndexedMangas(query, sources) {
  const normalizedQuery = normalizeTitle(query);
  if (!normalizedQuery) return [];
  const terms = normalizedQuery.split(" ").filter(Boolean);
  const sourceIds = new Set(sources.map((source) => String(source.id)));
  return uniqueMangaResults(
    (state.sourceIndex.entries || [])
      .filter((manga) => sourceIds.has(String(manga.sourceId)))
      .filter((manga) => {
        const title = normalizeTitle(manga.title);
        return terms.every((term) => title.includes(term));
      })
      .slice(0, 80)
  );
}

function uniqueMangaResults(results) {
  const seen = new Set();
  return results.filter((manga) => {
    const key = `${manga.sourceId}:${manga.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortMangaResults(results, query) {
  const normalizedQuery = normalizeTitle(query);
  return results.sort((a, b) => {
    const aTitle = normalizeTitle(a.title);
    const bTitle = normalizeTitle(b.title);
    const aExact = aTitle === normalizedQuery ? 0 : 1;
    const bExact = bTitle === normalizedQuery ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return sourceRank(a.sourceId) - sourceRank(b.sourceId) || aTitle.localeCompare(bTitle);
  });
}

function sourceRank(sourceId) {
  const source = state.visibleSources.find((item) => String(item.id) === String(sourceId));
  const label = source ? sourceLabel(source).toLowerCase() : "";
  if (label.includes("mangadex")) return 0;
  if (label.includes("comick")) return 1;
  if (label.includes("readcomiconline")) return 2;
  return 10;
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderMangaResults() {
  el.mangaResults.replaceChildren();
  if (!state.mangas.length) {
    const empty = document.createElement("div");
    empty.className = "app-empty-state compact-empty";
    const art = document.createElement("span");
    art.className = "empty-illustration";
    art.setAttribute("aria-hidden", "true");
    art.textContent = "⌕";
    const heading = document.createElement("strong");
    heading.textContent = "No matching manga";
    const copy = document.createElement("span");
    copy.textContent = "Try a shorter title or choose another source.";
    empty.append(art, heading, copy);
    el.mangaResults.append(empty);
    return;
  }

  state.mangas.forEach((manga) => {
    const card = document.createElement("article");
    card.className = "manga-card browse-card";
    const source = state.sources.find((item) => String(item.id) === String(manga.sourceId));
    const sourceText = source ? sourceLabel(source) : manga.sourceId;
    const button = createCoverButton(manga, {
      title: manga.title,
      eyebrow: sourceText || "Source",
      meta: "View chapters",
    });
    button.addEventListener("click", async () => {
      el.mangaId.value = manga.id;
      el.chapterTitle.textContent = manga.title;
      state.currentManga = {
        id: manga.id,
        title: manga.title,
        sourceId: manga.sourceId,
        sourceLabel: sourceText,
        thumbnailUrl: manga.thumbnailUrl,
      };
      showMangaDetail(manga, sourceText);
      await fetchChapters();
    });
    card.append(button);
    el.mangaResults.append(card);
  });
}

function renderMangaSkeletons() {
  el.mangaResults.replaceChildren();
  for (let index = 0; index < 6; index += 1) {
    const card = document.createElement("div");
    card.className = "manga-skeleton";
    card.setAttribute("aria-hidden", "true");
    const cover = document.createElement("span");
    const line = document.createElement("span");
    card.append(cover, line);
    el.mangaResults.append(card);
  }
}

function showMangaDetail(manga, sourceText = "") {
  if (!el.mangaDetail || !el.browseBody) return;
  const title = manga?.title || manga?.mangaTitle || "Selected manga";
  const source = sourceText || manga?.sourceLabel || "Suwayomi source";
  state.browseDiscoveryScroll = window.scrollY;
  el.mangaDetail.closest(".browse-view")?.classList.add("detail-open");
  el.browseBody.hidden = true;
  el.mangaDetail.hidden = false;
  el.detailTitle.textContent = title;
  el.detailSource.textContent = source;
  el.detailCoverFallback.textContent = coverInitials(title);
  el.detailCover.style.setProperty("--cover-hue", String(coverHue(title)));
  el.detailCover.classList.remove("cover-loaded");
  el.detailCoverImage.hidden = true;
  el.detailCoverImage.removeAttribute("src");
  const coverUrl = normalizeMangaCoverUrl(manga?.thumbnailUrl);
  if (coverUrl) {
    el.detailCoverImage.onload = () => {
      el.detailCoverImage.hidden = false;
      el.detailCover.classList.add("cover-loaded");
    };
    el.detailCoverImage.onerror = () => {
      el.detailCoverImage.hidden = true;
      el.detailCover.classList.remove("cover-loaded");
    };
    el.detailCoverImage.src = coverUrl;
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeMangaDetail() {
  if (!el.mangaDetail || !el.browseBody) return;
  el.mangaDetail.hidden = true;
  el.mangaDetail.closest(".browse-view")?.classList.remove("detail-open");
  el.browseBody.hidden = false;
  requestAnimationFrame(() => {
    window.scrollTo({ top: state.browseDiscoveryScroll || 0 });
    el.searchQuery?.focus({ preventScroll: true });
  });
}

let toastTimer = null;
function showToast(message, tone = "") {
  if (!el.appToast || !message) return;
  window.clearTimeout(toastTimer);
  el.appToast.textContent = message;
  el.appToast.className = `app-toast visible ${tone}`;
  el.appToast.hidden = false;
  toastTimer = window.setTimeout(() => {
    el.appToast.classList.remove("visible");
    window.setTimeout(() => { el.appToast.hidden = true; }, 180);
  }, 2600);
}

function emptyLine(text) {
  const item = document.createElement("div");
  item.className = "result-item empty-result";
  const copy = document.createElement("div");
  const label = document.createElement("strong");
  label.textContent = text;
  copy.append(label);
  item.append(copy);
  return item;
}

function coverInitials(title) {
  const words = String(title || "Panel Pilot").trim().split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((word) => word[0]).join("") || "PP").toUpperCase();
}

function coverHue(title) {
  return [...String(title || "Panel Pilot")].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) % 360, 204);
}

function normalizeMangaCoverUrl(url) {
  const raw = String(url || "").trim();
  if (!raw || /^data:|^blob:/i.test(raw)) return raw;
  const base = String(el.serverUrl?.value || state.baseUrl || "http://localhost:4567").trim().replace(/\/+$/, "");
  try {
    let target = raw;
    if (/^https?:/i.test(raw)) {
      const parsed = new URL(raw);
      if (parsed.origin !== new URL(base).origin) return raw;
      target = `${parsed.pathname}${parsed.search}`;
    }
    if (!target.startsWith("/")) target = `/${target}`;
    return appUrl(`/api/suwayomi/asset?base=${encodeURIComponent(base)}&path=${encodeURIComponent(target)}`);
  } catch {
    return raw;
  }
}

function createCoverButton(item, content) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "manga-cover-button";
  button.setAttribute("aria-label", `${content.meta || "Open"} ${content.title || "manga"}`);
  button.style.setProperty("--cover-hue", String(coverHue(content.title)));

  const fallback = document.createElement("span");
  fallback.className = "cover-fallback";
  const initials = document.createElement("strong");
  initials.textContent = coverInitials(content.title);
  fallback.append(initials);
  button.append(fallback);

  const coverUrl = normalizeMangaCoverUrl(item.thumbnailUrl);
  if (coverUrl) {
    const image = document.createElement("img");
    image.className = "manga-cover-image";
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("load", () => button.classList.add("cover-loaded"));
    image.addEventListener("error", () => image.remove());
    image.src = coverUrl;
    button.append(image);
  }

  const overlay = document.createElement("span");
  overlay.className = "manga-cover-overlay";
  const eyebrow = document.createElement("span");
  eyebrow.className = "manga-cover-eyebrow";
  eyebrow.textContent = content.eyebrow || "Panel Pilot";
  const title = document.createElement("strong");
  title.className = "manga-cover-title";
  title.textContent = content.title || "Untitled";
  const meta = document.createElement("span");
  meta.className = "manga-cover-meta";
  meta.textContent = content.meta || "Open";
  overlay.append(eyebrow, title, meta);
  button.append(overlay);
  return button;
}

async function loadLibraryItems() {
  let localItems = [];
  try {
    localItems = JSON.parse(localStorage.getItem(libraryStoreKey) || "[]");
  } catch {
    localItems = [];
  }
  state.libraryItems = Array.isArray(localItems) ? localItems : [];
  renderLibrary();

  try {
    const payload = await localJson("/api/library");
    const remoteItems = Array.isArray(payload.items) ? payload.items : [];
    state.libraryItems = mergeLibraryItems(remoteItems, state.libraryItems);
    persistLibraryItemsLocally();
    if (state.libraryItems.length !== remoteItems.length) {
      saveLibraryItems();
    }
    renderLibrary();
  } catch {
    // Local storage remains the fallback when the shared library endpoint is unavailable.
    renderLibrary();
  }
}

function saveLibraryItems() {
  state.libraryItems = mergeLibraryItems(state.libraryItems);
  persistLibraryItemsLocally();
  postLocalJson("/api/library", { items: state.libraryItems }).catch(() => {});
}

function persistLibraryItemsLocally() {
  try {
    localStorage.setItem(libraryStoreKey, JSON.stringify(state.libraryItems));
  } catch {
    // The server copy is authoritative; local storage is only a convenience cache.
  }
}

function mergeLibraryItems(...lists) {
  const merged = [];
  const seen = new Map();
  lists
    .flat()
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
    .forEach((item) => {
      const key = libraryItemKey(item);
      if (!key) return;
      if (seen.has(key)) {
        const existing = seen.get(key);
        if (!existing.thumbnailUrl && item.thumbnailUrl) existing.thumbnailUrl = item.thumbnailUrl;
        return;
      }
      seen.set(key, item);
      merged.push(item);
    });
  return merged;
}

function renderLibrary() {
  if (!el.libraryList || !el.libraryCount) return;
  el.libraryList.replaceChildren();
  const allowedItems = libraryItemsAllowedByNsfw();
  const visibleItems = visibleLibraryItems();
  const hiddenCount = allowedItems.filter((item) => item.hidden).length;
  el.libraryCount.textContent = `${visibleItems.length} title${visibleItems.length === 1 ? "" : "s"}${hiddenCount ? ` · ${hiddenCount} hidden` : ""}`;
  updateReaderNav();
  if (!visibleItems.length) {
    const message = !state.showHiddenLibrary && hiddenCount
      ? "Your current titles are hidden. Show hidden titles to bring them back."
      : "Add a title from Browse and it will appear here with your reading progress.";
    const empty = document.createElement("div");
    empty.className = "app-empty-state";
    const art = document.createElement("span");
    art.className = "empty-illustration";
    art.setAttribute("aria-hidden", "true");
    art.textContent = "▤";
    const heading = document.createElement("strong");
    heading.textContent = hiddenCount ? "Nothing visible right now" : "Build your library";
    const copy = document.createElement("span");
    copy.textContent = message;
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = hiddenCount ? "Show hidden titles" : "Browse manga";
    action.addEventListener("click", () => hiddenCount ? setShowHiddenLibrary(true) : setActiveView("browse"));
    empty.append(art, heading, copy, action);
    el.libraryList.append(empty);
    return;
  }

  visibleItems.forEach((item) => {
    const card = document.createElement("article");
    card.className = `manga-card library-card${item.pinned ? " pinned-item" : ""}${item.hidden ? " hidden-item" : ""}`;
    const resumable = Number.isInteger(Number(item.chapterId)) && Number(item.chapterId) > 0;
    const cover = createCoverButton(item, {
      title: item.mangaTitle || "Untitled",
      eyebrow: item.chapterTitle || item.sourceLabel || "Suwayomi library",
      meta: resumable ? (item.progressLabel || "Resume reading") : "View chapters",
    });
    cover.addEventListener("click", () => selectLibraryManga(item, resumable));

    const badges = document.createElement("div");
    badges.className = "manga-card-badges";
    if (item.pinned) {
      const pinned = document.createElement("span");
      pinned.className = "manga-card-badge";
      pinned.textContent = "Pinned";
      badges.append(pinned);
    }
    if (item.hidden) {
      const hidden = document.createElement("span");
      hidden.className = "manga-card-badge muted-badge";
      hidden.textContent = "Hidden";
      badges.append(hidden);
    }

    const actions = document.createElement("div");
    actions.className = "manga-card-actions";
    const chapters = document.createElement("button");
    chapters.type = "button";
    chapters.textContent = "Chapters";
    chapters.addEventListener("click", () => selectLibraryManga(item, false));
    const pin = document.createElement("button");
    pin.type = "button";
    pin.textContent = item.pinned ? "Unpin" : "Pin";
    pin.className = "quiet-card-action";
    pin.addEventListener("click", () => setLibraryItemFlag(item, "pinned", !item.pinned));
    const hide = document.createElement("button");
    hide.type = "button";
    hide.textContent = item.hidden ? "Restore" : "Hide";
    hide.className = "quiet-card-action";
    hide.addEventListener("click", () => setLibraryItemFlag(item, "hidden", !item.hidden));
    const more = document.createElement("details");
    more.className = "manga-card-more";
    const moreLabel = document.createElement("summary");
    moreLabel.textContent = "More";
    moreLabel.setAttribute("aria-label", `More actions for ${item.mangaTitle || "manga"}`);
    const menu = document.createElement("div");
    menu.className = "manga-card-menu";
    menu.append(pin, hide);
    more.append(moreLabel, menu);
    actions.append(chapters, more);

    card.append(cover, badges, actions);
    el.libraryList.append(card);
  });
}

function readerResumeItem() {
  const available = state.libraryItems
    .filter((item) => !item.hidden)
    .filter((item) => Number.isInteger(Number(item.chapterId)) && Number(item.chapterId) > 0)
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  if (state.activeChapter?.type === "suwayomi" && state.currentManga?.id) {
    const currentKey = libraryItemKey({ mangaId: state.currentManga.id, sourceId: state.currentManga.sourceId });
    return available.find((item) => libraryItemKey(item) === currentKey) || available[0] || null;
  }
  return available[0] || null;
}

function updateReaderNav() {
  if (!el.navReader) return;
  const item = readerResumeItem();
  const hasResume = Boolean(item);
  const title = item?.mangaTitle || "";
  el.navReader.hidden = !hasResume;
  document.body.classList.toggle("has-reading-miniplayer", hasResume);
  if (!hasResume) return;
  el.navReaderLabel.textContent = title;
  el.navReaderTitle.textContent = [item.chapterTitle, item.progressLabel].filter(Boolean).join(" · ") || "Resume reading";
  el.navReaderFallback.textContent = coverInitials(item?.mangaTitle || "Panel Pilot");
  el.navReaderCover.style.setProperty("--cover-hue", String(coverHue(item?.mangaTitle || "Panel Pilot")));
  el.navReader.setAttribute("aria-label", `Resume ${title}${item.progressLabel ? `, ${item.progressLabel}` : ""}`);
  el.navReader.title = `${title}${item.progressLabel ? ` — ${item.progressLabel}` : ""}`;

  const coverUrl = normalizeMangaCoverUrl(item?.thumbnailUrl);
  el.navReaderCover.classList.remove("cover-loaded");
  el.navReaderImage.hidden = true;
  el.navReaderImage.removeAttribute("src");
  if (!coverUrl) return;
  el.navReaderImage.onload = () => {
    el.navReaderImage.hidden = false;
    el.navReaderCover.classList.add("cover-loaded");
  };
  el.navReaderImage.onerror = () => {
    el.navReaderImage.hidden = true;
    el.navReaderCover.classList.remove("cover-loaded");
  };
  el.navReaderImage.src = coverUrl;
}

async function openReaderFromNav() {
  const item = readerResumeItem();
  if (!item) {
    if (state.activeChapter && state.pages.length) setActiveView("reader");
    return;
  }
  const activeMatchesItem =
    state.activeChapter?.type === "suwayomi" &&
    Number(state.activeChapter.chapterId) === Number(item.chapterId) &&
    String(state.currentManga?.id) === String(item.mangaId);
  if (activeMatchesItem && state.pages.length) {
    setActiveView("reader");
    return;
  }
  const returnView = state.activeView === "reader" ? (state.previousView || "library") : state.activeView;
  el.navReader.setAttribute("aria-busy", "true");
  try {
    await selectLibraryManga(item, true);
    if (!state.activeChapter || !state.pages.length) setActiveView(returnView);
  } catch (error) {
    const message = friendlySourceErrorMessage(error);
    setConnection(state.connected, `Could not resume ${item.mangaTitle}: ${message}`, "bad");
    setActiveView("reader");
    showReaderError(`Could not resume ${item.mangaTitle}`, message);
  } finally {
    el.navReader.removeAttribute("aria-busy");
  }
}

async function hydrateLibraryCovers() {
  const missing = state.libraryItems.filter((item) => item.mangaId && !item.thumbnailUrl).slice(0, 40);
  if (!missing.length || !state.connected) return;
  let changed = false;
  const results = await Promise.allSettled(missing.map(async (item) => {
    const data = await graphQL(queries.mangaCard, { id: Number(item.mangaId) }, { timeoutMs: 8000 });
    return { key: libraryItemKey(item), manga: data.manga };
  }));
  const covers = new Map();
  results.forEach((result) => {
    if (result.status === "fulfilled" && result.value.manga?.thumbnailUrl) {
      covers.set(result.value.key, result.value.manga.thumbnailUrl);
    }
  });
  state.libraryItems = state.libraryItems.map((item) => {
    const thumbnailUrl = covers.get(libraryItemKey(item));
    if (!thumbnailUrl || item.thumbnailUrl) return item;
    changed = true;
    return { ...item, thumbnailUrl };
  });
  if (changed) {
    saveLibraryItems();
    renderLibrary();
  }
}

function visibleLibraryItems() {
  return sortLibraryItems(
    libraryItemsAllowedByNsfw().filter((item) => state.showHiddenLibrary || !item.hidden)
  );
}

function libraryItemsAllowedByNsfw() {
  // A title explicitly present in the user's library should remain visible.
  // The NSFW preference only limits discovery/search results.
  return state.libraryItems;
}

function waitFor(delayMs) {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, delayMs)));
}

async function withRetry(task, delays = [0]) {
  let lastError = null;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await waitFor(delays[attempt]);
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Request failed");
}

function sortLibraryItems(items) {
  return [...items].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
  });
}

function setLibraryItemFlag(item, field, value) {
  const key = libraryItemKey(item);
  state.libraryItems = state.libraryItems.map((existing) =>
    libraryItemKey(existing) === key ? { ...existing, [field]: value } : existing
  );
  saveLibraryItems();
  renderLibrary();
  showToast(field === "pinned" ? (value ? "Pinned to the top." : "Unpinned.") : (value ? "Hidden from Library." : "Restored to Library."));
}

function isNsfwLibraryItem(item) {
  const source = state.sources.find((entry) => String(entry.id) === String(item?.sourceId));
  if (source && isNsfwSource(source)) return true;
  const label = `${item?.sourceLabel || ""} ${item?.mangaTitle || item?.title || ""}`.toLowerCase();
  return label.includes("manhwa18") || label.includes("manhwa18.cc");
}

async function selectLibraryManga(item, resume) {
  if (!resume) {
    setActiveView("browse");
    showMangaDetail(item, item.sourceLabel);
  }
  state.currentManga = {
    id: item.mangaId,
    title: item.mangaTitle,
    sourceId: item.sourceId,
    sourceLabel: item.sourceLabel,
    thumbnailUrl: item.thumbnailUrl,
  };
  updateReaderNav();
  el.mangaId.value = item.mangaId;
  el.chapterId.value = item.chapterId || "";
  el.chapterTitle.textContent = item.chapterTitle || item.mangaTitle || "Selected manga";
  state.pendingResume = resume ? item : null;
  await fetchChapters();
  if (resume) await loadChapterPages();
}

async function ensureCurrentMangaInSuwayomiLibrary() {
  const mangaId = Number(state.currentManga?.id);
  if (!Number.isInteger(mangaId) || mangaId < 1) return false;
  const data = await graphQL(
    queries.updateManga,
    { input: { id: mangaId, patch: { inLibrary: true } } },
    { timeoutMs: 10000 }
  );
  return Boolean(data.updateManga?.manga?.inLibrary);
}

async function syncSuwayomiLibrary({ announce = false } = {}) {
  const data = await graphQL(queries.libraryMangas, {}, { timeoutMs: 15000 });
  const mangas = data.mangas?.nodes || [];
  const existingByKey = new Map(state.libraryItems.map((item) => [libraryItemKey(item), item]));
  const serverItems = mangas.map((manga) => {
    const key = libraryItemKey({ id: manga.id, sourceId: manga.sourceId });
    const existing = existingByKey.get(key) || {};
    const source = manga.source || state.sources.find((item) => String(item.id) === String(manga.sourceId));
    return {
      ...existing,
      mangaId: Number(manga.id),
      mangaTitle: manga.title,
      sourceId: manga.sourceId,
      sourceLabel: source ? sourceLabel(source) : (existing.sourceLabel || "Suwayomi"),
      thumbnailUrl: manga.thumbnailUrl || existing.thumbnailUrl,
      suwayomiLibrary: true,
      updatedAt: existing.updatedAt || "1970-01-01T00:00:00.000Z",
    };
  });
  state.libraryItems = mergeLibraryItems(serverItems, state.libraryItems);
  saveLibraryItems();
  renderLibrary();
  if (announce) {
    setSyncStatus("Synced", `${mangas.length} Suwayomi library title${mangas.length === 1 ? "" : "s"} available in Panel Pilot.`, "good");
    showToast("Library refreshed from Suwayomi.");
  }
  return mangas.length;
}

async function syncLibraryAndProgress() {
  setBusy(el.syncProgress, true, "Syncing");
  try {
    const count = await syncSuwayomiLibrary();
    const progressSynced = await syncSuwayomiProgress();
    setSyncStatus(
      "Synced",
      `${count} Suwayomi title${count === 1 ? "" : "s"} refreshed${progressSynced ? " and current progress sent" : ""}.`,
      "good"
    );
    showToast("Suwayomi library synced.");
  } catch (error) {
    setSyncStatus("Sync failed", friendlySourceErrorMessage(error), "bad");
  } finally {
    setBusy(el.syncProgress, false);
  }
}

function hideReaderError() {
  if (el.readerError) el.readerError.hidden = true;
}

function showReaderError(title, message) {
  if (!el.readerError) return;
  el.readerErrorTitle.textContent = title;
  el.readerErrorMessage.textContent = message;
  el.readerError.hidden = false;
  setReaderChromeVisible(true);
}

function rememberReadingProgress() {
  if (state.activeChapter?.type !== "suwayomi" || !state.currentManga?.id) return;
  const page = state.pages[state.pageIndex];
  const totalPanels = page?.panels.length || 0;
  const existing = state.libraryItems.find((item) => libraryItemKey(item) === libraryItemKey(state.currentManga));
  const source = state.sources.find((item) => String(item.id) === String(state.currentManga.sourceId));
  const item = {
    ...existing,
    mangaId: Number(state.currentManga.id),
    mangaTitle: state.currentManga.title,
    sourceId: state.currentManga.sourceId,
    sourceLabel: state.currentManga.sourceLabel,
    thumbnailUrl: state.currentManga.thumbnailUrl || existing?.thumbnailUrl,
    isNsfw: isNsfwSource(source) || isNsfwLibraryItem(state.currentManga),
    hidden: false,
    pinned: Boolean(existing?.pinned),
    chapterId: Number(state.activeChapter.chapterId),
    chapterTitle: el.chapterTitle.textContent,
    pageIndex: state.pageIndex,
    panelIndex: state.panelIndex,
    panelMode: state.panelMode,
    readingDirection: state.readingDirection,
    progressLabel: totalPanels
      ? `Page ${state.pageIndex + 1}, panel ${state.panelIndex + 1}`
      : `Page ${state.pageIndex + 1}`,
    updatedAt: new Date().toISOString(),
  };
  const key = libraryItemKey(item);
  state.libraryItems = [item, ...state.libraryItems.filter((existing) => libraryItemKey(existing) !== key)];
  saveLibraryItems();
  renderLibrary();
  scheduleSuwayomiProgressSync();
}

function currentSuwayomiPageIndex() {
  const pageCount = state.chapterPageUrls.length;
  if (!pageCount) return 0;
  if (state.panelMode !== "webtoon") return clamp(state.pageIndex, 0, pageCount - 1);
  const panels = state.pages[0]?.panels || [];
  if (!panels.length) return 0;
  const progress = clamp((state.panelIndex + 1) / panels.length, 0, 1);
  return clamp(Math.floor(progress * pageCount), 0, pageCount - 1);
}

function setSyncStatus(label, message, tone = "") {
  if (el.syncState) el.syncState.textContent = label;
  if (el.syncNote) {
    el.syncNote.textContent = message;
    el.syncNote.className = `note ${tone}`;
  }
}

function scheduleSuwayomiProgressSync() {
  if (state.activeChapter?.type !== "suwayomi") return;
  window.clearTimeout(state.suwayomiSyncTimer);
  state.suwayomiSyncTimer = window.setTimeout(() => {
    syncSuwayomiProgress().catch(() => {});
  }, 700);
}

async function syncSuwayomiProgress({ completed = false, manual = false } = {}) {
  const chapterId = Number(state.activeChapter?.chapterId);
  if (state.activeChapter?.type !== "suwayomi" || !Number.isInteger(chapterId)) {
    if (manual) setSyncStatus("Not reading", "Open a Suwayomi chapter before syncing.", "bad");
    return false;
  }
  const chapter = state.chapters.find((item) => Number(item.id) === chapterId);
  const localPage = completed
    ? Math.max(0, state.chapterPageUrls.length - 1)
    : currentSuwayomiPageIndex();
  const lastPageRead = Math.max(localPage, Number(chapter?.lastPageRead) || 0);
  const syncKey = `${chapterId}:${lastPageRead}:${completed ? "read" : "progress"}`;
  if (state.suwayomiSyncPromise) {
    if (!completed && !manual) return false;
    await state.suwayomiSyncPromise.catch(() => null);
  }
  if (!manual && syncKey === state.lastSuwayomiSyncKey) return true;

  state.suwayomiSyncing = true;
  setSyncStatus("Syncing", "Sending progress to Suwayomi…");
  let request = null;
  try {
    const patch = completed ? { lastPageRead, isRead: true } : { lastPageRead };
    request = graphQL(queries.updateChapter, { input: { id: chapterId, patch } }, { timeoutMs: 10000 });
    state.suwayomiSyncPromise = request;
    const data = await request;
    const updated = data.updateChapter?.chapter;
    if (chapter && updated) Object.assign(chapter, updated);
    state.lastSuwayomiSyncKey = syncKey;
    setSyncStatus(
      "Synced",
      completed
        ? "Chapter marked read in Suwayomi. Tachimanga can now merge it."
        : `Page ${lastPageRead + 1} sent to Suwayomi.`,
      "good"
    );
    return true;
  } catch (error) {
    setSyncStatus("Sync failed", `Could not update Suwayomi: ${friendlySourceErrorMessage(error)}`, "bad");
    if (manual) throw error;
    return false;
  } finally {
    if (state.suwayomiSyncPromise === request) state.suwayomiSyncPromise = null;
    state.suwayomiSyncing = false;
  }
}

async function finishChapterAndLoadNext() {
  if (state.activeChapter?.type === "suwayomi") {
    window.clearTimeout(state.suwayomiSyncTimer);
    void syncSuwayomiProgress({ completed: true }).catch(() => false);
  }
  await loadNextChapter();
}

function nextSuwayomiChapterAfter(chapterId) {
  const chapters = chapterSequenceFor(chapterId);
  const index = chapters.findIndex((chapter) => Number(chapter.id) === Number(chapterId));
  return index >= 1 ? chapters[index - 1] : null;
}

function downloadAheadChapters(chapterId) {
  const chapters = chapterSequenceFor(chapterId);
  const currentIndex = chapters.findIndex((chapter) => Number(chapter.id) === Number(chapterId));
  if (currentIndex < 0) return [];
  const firstIndex = Math.max(0, currentIndex - downloadAheadChapterCount);
  return chapters.slice(firstIndex, currentIndex + 1).reverse();
}

function chapterSequenceFor(chapterId) {
  const current = state.chapters.find((chapter) => Number(chapter.id) === Number(chapterId));
  const currentScanlator = scanlatorName(current);
  if (current && currentScanlator) {
    const sameScanlator = state.chapters.filter((chapter) => scanlatorName(chapter) === currentScanlator);
    if (sameScanlator.some((chapter) => Number(chapter.id) === Number(chapterId))) return sameScanlator;
  }
  return state.chapterView.length ? state.chapterView : visibleChapters();
}

async function ensureDownloadAhead(chapterId) {
  const candidates = downloadAheadChapters(chapterId);
  const chapters = candidates.filter((chapter) => !chapter.isDownloaded);
  if (!chapters.length) {
    if (el.offlineNote) el.offlineNote.textContent = `Offline buffer: the current and next ${downloadAheadChapterCount} chapters are already downloaded.`;
    return;
  }

  const ids = chapters.map((chapter) => Number(chapter.id));
  if (el.offlineNote) el.offlineNote.textContent = `Offline buffer: sending ${ids.length} chapter${ids.length === 1 ? "" : "s"} to the background queue…`;
  try {
    const status = await postLocalJson("/api/download-buffer", { chapterIds: ids });
    if (el.offlineNote) {
      el.offlineNote.textContent = status.queued
        ? `Offline buffer: ${status.queued} chapter${status.queued === 1 ? "" : "s"} queued on the server with paced retries.`
        : `Offline buffer: the current and next ${downloadAheadChapterCount} chapters are ready.`;
    }
  } catch (error) {
    if (el.offlineNote) el.offlineNote.textContent = `Offline buffer will retry when this title is opened again: ${friendlySourceErrorMessage(error)}`;
  }
}

function clearNextChapterPrefetch() {
  window.clearTimeout(state.nextChapterPrefetchTimer);
  state.nextChapterPrefetchTimer = null;
  state.nextChapterPrefetch = null;
}

function scheduleNextChapterPrefetch(generation = state.prepareGeneration) {
  if (state.activeChapter?.type !== "suwayomi") return;
  const fromChapterId = Number(state.activeChapter.chapterId);
  const chapter = nextSuwayomiChapterAfter(fromChapterId);
  if (!chapter) return;

  const record = {
    generation,
    fromChapterId,
    chapterId: Number(chapter.id),
    chapter,
    promise: null,
  };
  state.nextChapterPrefetch = record;
  state.nextChapterPrefetchTimer = window.setTimeout(() => {
    if (state.nextChapterPrefetch !== record || generation !== state.prepareGeneration) return;
    record.promise = prefetchSuwayomiChapter(record).catch(() => null);
  }, 900);
}

async function prefetchSuwayomiChapter(record) {
  const data = await fetchChapterPagePayload(record.chapterId);
  if (state.nextChapterPrefetch !== record || record.generation !== state.prepareGeneration) return null;
  const chapterPayload = data.fetchChapterPages?.chapter;
  const sourcePages = await resolveChapterPages(data.fetchChapterPages, { quiet: true });
  if (!sourcePages.length) throw new Error("Source returned no readable page URLs.");
  const pageUrls = sourcePages.map(normalizeSuwayomiPageUrl);
  const entries = makeChapterPageEntries(pageUrls);
  const firstImage = await loadImage(pageUrls[0]);
  if (state.nextChapterPrefetch !== record || record.generation !== state.prepareGeneration) return null;
  const mode = detectPanelModeFromImage(firstImage, activeChapterSourceLabel()) || state.panelMode;

  if (mode !== "webtoon") {
    await preparePageEntry(entries[0], 0, entries.length, {
      mode,
      direction: state.readingDirection,
      quiet: true,
      image: firstImage,
    });
    const rest = entries.slice(1, nextChapterPreparedPageCount);
    rest.forEach((page) => {
      const preparation = preparePageEntry(page, page.index, entries.length, {
        mode,
        direction: state.readingDirection,
        quiet: true,
      }).catch(() => null);
      page.preparePromise = preparation;
      page.preparePromiseMode = mode;
      page.preparePromiseDirection = state.readingDirection;
      void preparation.finally(() => {
        if (page.preparePromise === preparation) {
          page.preparePromise = null;
          page.preparePromiseMode = "";
          page.preparePromiseDirection = "";
        }
      });
    });
  }

  return {
    chapter: record.chapter,
    chapterPayload,
    pageUrls,
    preparedPages: entries,
    firstImage,
    mode,
  };
}

function libraryItemKey(item) {
  const mangaId = item?.mangaId ?? item?.id;
  if (!mangaId) return "";
  return `${item.sourceId || "source"}:${mangaId}`;
}

async function fetchChapters() {
  const mangaId = Number(el.mangaId.value);
  if (!Number.isInteger(mangaId) || mangaId < 1) {
    setConnection(state.connected, "Enter a Suwayomi manga ID first.", "bad");
    return;
  }

  setBusy(el.fetchChapters, true, "Fetching");
  renderChapterSkeletons();
  try {
    const data = await graphQL(queries.fetchChapters, { input: { mangaId } });
    setChapterList(data.fetchChapters?.chapters || []);
    updateScanlatorOptions();
    renderChapters();
    setConnection(true, `Loaded ${state.chapters.length} chapters.`, "good");
  } catch (error) {
    const message = chapterFetchErrorMessage(error);
    try {
      const cached = await graphQL(queries.storedChapters, { mangaId }, { timeoutMs: 15000 });
      setChapterList(cached.chapters?.nodes || []);
      if (!state.chapters.length) throw error;
      updateScanlatorOptions();
      renderChapters();
      setConnection(true, `Source refresh paused; using ${state.chapters.length} saved chapters.`, "");
    } catch {
      setConnection(false, `Could not fetch chapters: ${message}`, "bad");
      renderChapterError(message);
    }
  } finally {
    setBusy(el.fetchChapters, false);
  }
}

function setChapterList(chapters) {
  state.chapters = chapters.slice().sort((a, b) => {
    const aOrder = Number(a.sourceOrder ?? a.chapterNumber ?? 0);
    const bOrder = Number(b.sourceOrder ?? b.chapterNumber ?? 0);
    return bOrder - aOrder;
  });
}

function renderChapterSkeletons() {
  if (!el.chapterList) return;
  el.chapterCount.textContent = "Loading chapters…";
  el.chapterList.replaceChildren();
  for (let index = 0; index < 5; index += 1) {
    const row = document.createElement("div");
    row.className = "chapter-skeleton";
    row.setAttribute("aria-hidden", "true");
    row.append(document.createElement("span"), document.createElement("span"));
    el.chapterList.append(row);
  }
}

function renderChapterError(message) {
  if (!el.chapterList) return;
  el.chapterCount.textContent = "Chapters unavailable";
  el.chapterList.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "chapter-error";
  const heading = document.createElement("strong");
  heading.textContent = "Chapters unavailable";
  const copy = document.createElement("span");
  copy.textContent = message;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Try again";
  retry.addEventListener("click", fetchChapters);
  empty.append(heading, copy, retry);
  el.chapterList.append(empty);
}

function updateScanlatorOptions() {
  if (!el.scanlatorSelect) return;
  const counts = scanlatorCounts(state.chapters);
  const current = state.scanlatorFilter || "auto";
  el.scanlatorSelect.replaceChildren();
  el.scanlatorSelect.append(makeOption("auto", "Best available"));
  el.scanlatorSelect.append(makeOption("all", "All release groups"));
  counts.forEach(([scanlator, count]) => {
    el.scanlatorSelect.append(makeOption(scanlator, `${scanlator} (${count})`));
  });
  el.scanlatorSelect.value = [...el.scanlatorSelect.options].some((option) => option.value === current)
    ? current
    : "auto";
  state.scanlatorFilter = el.scanlatorSelect.value;
}

function makeOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function scanlatorCounts(chapters) {
  const counts = new Map();
  chapters.forEach((chapter) => {
    const scanlator = scanlatorName(chapter);
    if (!scanlator) return;
    counts.set(scanlator, (counts.get(scanlator) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function scanlatorName(chapter) {
  return String(chapter?.scanlator || "").trim();
}

function chapterGroupKey(chapter) {
  const number = Number(chapter.chapterNumber);
  if (Number.isFinite(number) && number > 0) return `number:${number}`;
  return `name:${normalizeTitle(chapter.name || chapter.sourceOrder || chapter.id)}`;
}

function visibleChapters() {
  const filter = state.scanlatorFilter || "auto";
  if (filter === "all") return state.chapters.slice();
  if (filter !== "auto") {
    return state.chapters.filter((chapter) => scanlatorName(chapter) === filter);
  }

  const counts = new Map(scanlatorCounts(state.chapters));
  const groups = new Map();
  state.chapters.forEach((chapter) => {
    const key = chapterGroupKey(chapter);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(chapter);
  });

  return [...groups.values()]
    .map((items) => chooseChapterVariant(items, counts))
    .filter(Boolean)
    .sort((a, b) => {
      const aOrder = Number(a.sourceOrder ?? a.chapterNumber ?? 0);
      const bOrder = Number(b.sourceOrder ?? b.chapterNumber ?? 0);
      return bOrder - aOrder;
    });
}

function chooseChapterVariant(items, counts) {
  return items.slice().sort((a, b) => {
    const aScanlator = scanlatorName(a);
    const bScanlator = scanlatorName(b);
    const aCount = counts.get(aScanlator) || 0;
    const bCount = counts.get(bScanlator) || 0;
    if (aCount !== bCount) return bCount - aCount;
    const aPages = Number(a.pageCount || 0);
    const bPages = Number(b.pageCount || 0);
    if (aPages !== bPages) return bPages - aPages;
    return Number(a.id || 0) - Number(b.id || 0);
  })[0];
}

function chapterFetchErrorMessage(error) {
  const message = friendlySourceErrorMessage(error);
  if (/no chapters found/i.test(message)) {
    return "No chapters found in this source/language. MangaDex often lists licensed titles even when English chapters are unavailable; try another result, language, or source.";
  }
  return message;
}

function renderChapters() {
  el.chapterList.replaceChildren();
  state.chapterView = visibleChapters();
  el.chapterCount.textContent =
    state.chapterView.length === state.chapters.length
      ? `${state.chapters.length} chapters`
      : `${state.chapterView.length} of ${state.chapters.length}`;

  if (!state.chapterView.length) {
    el.chapterList.append(emptyLine("No chapters loaded."));
    return;
  }

  state.chapterView.forEach((chapter) => {
    const item = document.createElement("div");
    item.className = "result-item";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = chapter.name || `Chapter ${chapter.chapterNumber || chapter.sourceOrder || chapter.id}`;
    const meta = document.createElement("span");
    const scanlator = scanlatorName(chapter);
    const progress = chapter.isRead
      ? "Read"
      : Number(chapter.lastPageRead) > 0
        ? `Page ${Number(chapter.lastPageRead) + 1}`
        : "";
    meta.textContent = [
      scanlator,
      chapter.pageCount ? `${chapter.pageCount} pages` : "",
      progress,
    ].filter(Boolean).join(" · ") || "Ready to read";
    copy.append(title, meta);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Read";
    button.addEventListener("click", () => {
      el.chapterId.value = chapter.id;
      el.chapterTitle.textContent = title.textContent;
      loadChapterPages();
    });

    item.append(copy, button);
    el.chapterList.append(item);
  });
}

async function loadChapterPages() {
  const chapterId = Number(el.chapterId.value);
  if (!Number.isInteger(chapterId) || chapterId < 1) {
    setConnection(state.connected, "Enter a Suwayomi chapter ID first.", "bad");
    return;
  }

  setActiveView("reader");
  hideReaderError();
  setReaderChromeVisible(true);
  setBusy(el.loadChapterPages, true, "Loading");
  setReaderLoading(true, "Fetching chapter pages...", 12);
  try {
    await ensureCurrentMangaInSuwayomiLibrary().catch(() => false);
    const data = await fetchChapterPagePayload(chapterId);
    const chapter = data.fetchChapterPages?.chapter;
    const pages = await resolveChapterPages(data.fetchChapterPages);
    if (!pages.length) throw new Error("Source returned no readable page URLs.");
    const listedChapter = state.chapters.find((item) => Number(item.id) === chapterId);
    if (!state.pendingResume && listedChapter && !listedChapter.isRead && Number(listedChapter.lastPageRead) > 0) {
      state.pendingResume = {
        pageIndex: Number(listedChapter.lastPageRead),
        panelIndex: 0,
        panelMode: state.panelMode,
        readingDirection: state.readingDirection,
      };
    }
    state.activeChapter = {
      type: "suwayomi",
      chapterId,
      chapter: listedChapter || chapter || null,
    };
    await loadChapter(
      pages.map(normalizeSuwayomiPageUrl),
      el.chapterTitle.textContent || listedChapter?.name || chapter?.name || `Chapter ${chapterId}`
    );
    rememberReadingProgress();
    void ensureDownloadAhead(chapterId);
    setConnection(true, `Loaded ${pages.length} pages. Panel detection is running locally.`, "good");
  } catch (error) {
    const message = friendlySourceErrorMessage(error);
    setConnection(false, `Could not load chapter pages: ${message}`, "bad");
    showReaderError("Could not open this chapter", message);
    setReaderLoading(false);
  } finally {
    setBusy(el.loadChapterPages, false);
  }
}

function fetchChapterPagePayload(chapterId, { retries = true } = {}) {
  const delays = retries ? chapterFetchRetryDelaysMs : [0];
  return withRetry(
    () => graphQL(queries.fetchPages, { input: { chapterId } }, { timeoutMs: 45000 }),
    delays
  );
}

async function resolveChapterPages(fetchPayload, { quiet = false } = {}) {
  const pages = fetchPayload?.pages || [];
  if (pages.length) return pages;

  const chapter = fetchPayload?.chapter;
  const sourceName = `${chapter?.manga?.source?.name || ""} ${chapter?.manga?.source?.displayName || ""}`;
  if (/readcomiconline/i.test(sourceName) && chapter?.realUrl) {
    if (!quiet) setReaderLoading(true, "ReadComicOnline needs a local page fallback...", 18);
    const payload = await localJson(`/api/readcomiconline/chapter?url=${encodeURIComponent(chapter.realUrl)}`);
    if (payload.pages?.length) {
      return payload.pages;
    }
  }

  return [];
}

async function loadChapter(pageUrls, title, options = {}) {
  cancelReaderNavigation();
  clearNextChapterPrefetch();
  hideReaderError();
  setActiveView("reader");
  setReaderLoading(true, "Preparing chapter...", 28);
  const generation = state.prepareGeneration + 1;
  state.prepareGeneration = generation;
  state.backgroundPreparing = false;
  state.chapterPageUrls = pageUrls.slice();
  state.pageIndex = 0;
  state.panelIndex = 0;
  state.fullPage = false;
  el.toggleFit.textContent = "Full page";
  el.chapterTitle.textContent = title;
  el.stage.classList.add("has-image");

  try {
    setReaderLoading(true, "Checking page shape...", 24);
    const preparedPages = Array.isArray(options.preparedPages) ? options.preparedPages : null;
    const firstImage = options.firstImage || preparedPages?.[0]?.image || await loadImage(pageUrls[0]);
    if (generation !== state.prepareGeneration) return;
    autoSelectPanelMode(firstImage);
    if (
      state.pendingResume &&
      Number(state.pendingResume.chapterId) === Number(state.activeChapter?.chapterId) &&
      isPanelMode(normalizedResumePanelMode(state.pendingResume))
    ) {
      state.panelMode = normalizedResumePanelMode(state.pendingResume);
      updatePanelModeControls();
    }
    const reusablePreparedPages =
      state.panelMode !== "webtoon" &&
      preparedPages?.length === pageUrls.length &&
      preparedPages.every((page, index) => (
        page.url === pageUrls[index] &&
        (!page.detected || (page.panelMode === state.panelMode && page.readingDirection === state.readingDirection))
      ));
    state.pages = state.panelMode === "webtoon"
      ? []
      : reusablePreparedPages
        ? preparedPages
        : makeChapterPageEntries(pageUrls);

    if (state.panelMode === "webtoon") {
      state.pages = [
        await prepareContinuousWebtoonChapter(pageUrls, generation, {
          initialCount: 2,
          initialImages: [{ url: pageUrls[0], image: firstImage }],
        }),
      ];
    } else {
      setReaderLoading(true, `Preparing page 1 of ${state.pages.length}...`, 44);
      await preparePage(0, { generation, image: firstImage });
    }
    await applyPendingResume(generation);
    setReaderLoading(true, "Rendering reader...", 92);
    renderCurrentPage();
    renderPanelStrip();
    updateStats();
    if (state.panelMode === "webtoon") {
      prepareWebtoonChapterInBackground(generation);
    } else {
      prepareChapterInBackground(generation);
    }
    scheduleNextChapterPrefetch(generation);
    if (isReaderFocusAvailable()) {
      setReaderFocus(true);
      setReaderChromeVisible(false);
    }
  } finally {
    setReaderLoading(false);
  }
}

async function applyPendingResume(generation) {
  const resume = state.pendingResume;
  if (!resume || Number(resume.chapterId) !== Number(state.activeChapter?.chapterId)) return;
  state.pendingResume = null;
  const resumeMode = normalizedResumePanelMode(resume);
  if (isPanelMode(resumeMode)) {
    state.panelMode = resumeMode;
    updatePanelModeControls();
  }
  if (resume.readingDirection === "rtl" || resume.readingDirection === "ltr") {
    setReadingDirection(resume.readingDirection);
  }
  const pageIndex = clamp(Number(resume.pageIndex) || 0, 0, Math.max(0, state.pages.length - 1));
  state.pageIndex = pageIndex;
  if (state.panelMode !== "webtoon") {
    await preparePage(pageIndex, { generation });
  }
  const page = state.pages[state.pageIndex];
  state.panelIndex = clamp(Number(resume.panelIndex) || 0, 0, Math.max(0, (page?.panels.length || 1) - 1));
  state.fullPage = false;
}

function autoSelectPanelMode(image) {
  const detectedMode = detectPanelModeFromImage(image, activeChapterSourceLabel());
  if (!detectedMode || detectedMode === state.panelMode) {
    updatePanelModeControls();
    return;
  }

  state.panelMode = detectedMode;
  updatePanelModeControls();
  saveSettings();
}

function detectPanelModeFromImage(image, sourceLabelText = "") {
  const width = image?.naturalWidth || image?.width || 0;
  const height = image?.naturalHeight || image?.height || 0;
  if (!width || !height) return "";
  if (height / width >= 2.6) return "webtoon";
  return /readcomiconline/i.test(sourceLabelText) ? "comic" : "manga";
}

function activeChapterSourceLabel() {
  const chapterSource = state.activeChapter?.chapter?.manga?.source;
  return [
    state.currentManga?.sourceLabel,
    chapterSource?.name,
    chapterSource?.displayName,
    state.activeChapter?.chapter?.realUrl,
  ]
    .filter(Boolean)
    .join(" ");
}

function isPanelMode(mode) {
  return mode === "manga" || mode === "comic" || mode === "webtoon";
}

function normalizedResumePanelMode(resume) {
  if (!resume) return "";
  const label = `${resume.sourceLabel || ""} ${resume.mangaTitle || ""}`.toLowerCase();
  if (resume.panelMode === "manga" && label.includes("readcomiconline")) return "comic";
  return resume.panelMode;
}

function makeChapterPageEntries(pageUrls) {
  return pageUrls.map((url, index) => ({
    url,
    index,
    panels: [],
    image: null,
    naturalWidth: 0,
    naturalHeight: 0,
    detected: false,
    panelMode: "",
    readingDirection: "",
    preparePromise: null,
    preparePromiseMode: "",
    preparePromiseDirection: "",
    renderUrl: "",
    loadAttempts: 0,
  }));
}

async function preparePage(index, options = {}) {
  const force = typeof options === "boolean" ? options : Boolean(options.force);
  const quiet = typeof options === "object" && Boolean(options.quiet);
  const generation = typeof options === "object" ? options.generation : state.prepareGeneration;
  const preloadedImage = typeof options === "object" ? options.image : null;
  if (generation !== state.prepareGeneration) return null;
  const page = state.pages[index];
  if (!page || (page.detected && page.panelMode === state.panelMode && page.readingDirection === state.readingDirection && !force)) return page;
  if (
    page.preparePromise &&
    page.preparePromiseMode === state.panelMode &&
    page.preparePromiseDirection === state.readingDirection &&
    !force
  ) return page.preparePromise;

  const preparation = preparePageEntry(page, index, state.pages.length, {
    mode: state.panelMode,
    direction: state.readingDirection,
    quiet,
    image: preloadedImage,
  }).then((preparedPage) => generation === state.prepareGeneration ? preparedPage : null);
  page.preparePromise = preparation;
  page.preparePromiseMode = state.panelMode;
  page.preparePromiseDirection = state.readingDirection;
  try {
    return await preparation;
  } finally {
    if (page.preparePromise === preparation) {
      page.preparePromise = null;
      page.preparePromiseMode = "";
      page.preparePromiseDirection = "";
    }
  }
}

async function preparePageEntry(page, index, totalPages, options = {}) {
  const mode = options.mode || "manga";
  const direction = options.direction || "rtl";
  const quiet = Boolean(options.quiet);
  const pageLabel = `page ${index + 1} of ${totalPages}`;
  const baseProgress = index === 0 ? 46 : 18;
  if (!quiet) setReaderLoading(true, `Loading image for ${pageLabel}...`, baseProgress);
  const image = options.image || page.image || await loadImage(page.url);
  page.loadAttempts = image.panelPilotLoadAttempts || 1;
  page.image = image;
  page.renderUrl = image.currentSrc || image.src || page.url;
  page.naturalWidth = image.naturalWidth;
  page.naturalHeight = image.naturalHeight;
  const modeLabel = mode === "webtoon" ? "Detecting webtoon panels" : mode === "comic" ? "Detecting comic regions" : "Detecting panels";
  if (!quiet) setReaderLoading(true, `${modeLabel} on ${pageLabel}...`, Math.max(baseProgress + 28, 58));
  const detectedPanels =
    mode === "webtoon"
      ? makeWebtoonPanels(image)
      : mode === "comic"
        ? await detectComicPanels(image, direction).catch(() => [fullPagePanel(page.naturalWidth, page.naturalHeight)])
        : await detectPanels(image, direction).catch(() => [fullPagePanel(page.naturalWidth, page.naturalHeight)]);
  page.panels = sanitizePanels(detectedPanels, page.naturalWidth, page.naturalHeight);
  if (!quiet) setReaderLoading(true, `Finishing ${pageLabel}...`, 88);
  page.detected = true;
  page.panelMode = mode;
  page.readingDirection = direction;
  return page;
}

async function prepareChapterInBackground(generation = state.prepareGeneration) {
  if (state.backgroundPreparing) return;
  state.backgroundPreparing = true;
  try {
    const indexes = state.pages
      .map((_, index) => index)
      .filter((index) => index !== state.pageIndex)
      .sort((a, b) => {
        const aBehind = a < state.pageIndex ? 1 : 0;
        const bBehind = b < state.pageIndex ? 1 : 0;
        return aBehind - bBehind || Math.abs(a - state.pageIndex) - Math.abs(b - state.pageIndex);
      });
    for (let offset = 0; offset < indexes.length; offset += backgroundPageConcurrency) {
      if (generation !== state.prepareGeneration) return;
      const batch = indexes.slice(offset, offset + backgroundPageConcurrency);
      await Promise.all(batch.map((index) => preparePage(index, { quiet: true, generation }).catch(() => null)));
      if (generation === state.prepareGeneration) renderPanelStrip();
      await yieldToBrowser();
    }
  } finally {
    if (generation === state.prepareGeneration) state.backgroundPreparing = false;
  }
}

async function prepareWebtoonChapterInBackground(generation = state.prepareGeneration) {
  if (state.backgroundPreparing) return;
  const page = state.pages[0];
  if (!page?.sourceImages || page.complete) return;

  state.backgroundPreparing = true;
  try {
    for (let index = page.sourceImages.length; index < state.chapterPageUrls.length; index += 1) {
      if (generation !== state.prepareGeneration) return;
      const image = await loadImage(state.chapterPageUrls[index]).catch(() => null);
      if (!image || generation !== state.prepareGeneration) continue;

      const current = currentPanel();
      const currentCenterY = current ? (current.y + current.h / 2) * page.naturalHeight : 0;
      page.sourceImages.push({ url: state.chapterPageUrls[index], image });
      Object.assign(page, buildContinuousWebtoonPage(state.chapterPageUrls, page.sourceImages));
      if (currentCenterY) state.panelIndex = nearestPanelIndexByY(page, currentCenterY);
      renderStripPage(page, { refit: false });
      renderPanelStrip();
      updateStats();
      await yieldToBrowser();
    }
  } finally {
    if (generation === state.prepareGeneration) state.backgroundPreparing = false;
  }
}

function nearestPanelIndexByY(page, absoluteY) {
  if (!page?.panels?.length) return 0;
  let bestIndex = 0;
  let bestDistance = Infinity;
  page.panels.forEach((panel, index) => {
    const centerY = (panel.y + panel.h / 2) * page.naturalHeight;
    const distance = Math.abs(centerY - absoluteY);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  });
  return bestIndex;
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadImage(src, options = {}) {
  const delays = options.retry === false ? [0] : pageImageRetryDelaysMs;
  return withRetry(async (attempt) => {
    const image = await loadImageAttempt(retryImageUrl(src, attempt), src);
    image.panelPilotLoadAttempts = attempt + 1;
    return image;
  }, delays);
}

function retryImageUrl(src, attempt) {
  if (!attempt) return src;
  try {
    const url = new URL(src, location.href);
    if (url.origin !== location.origin) return src;
    url.searchParams.set("pp_retry", `${Date.now()}-${attempt}`);
    return url.toString();
  } catch {
    return src;
  }
}

function loadImageAttempt(src, originalSrc) {
  return new Promise((resolve, reject) => {
    const needsCors = /^https?:/i.test(src) && !src.startsWith(location.origin);
    const candidates = needsCors ? ["anonymous", ""] : [""];
    let candidateIndex = 0;

    const tryCandidate = () => {
      const image = new Image();
      if (candidates[candidateIndex]) image.crossOrigin = candidates[candidateIndex];
      const timeout = window.setTimeout(() => {
        image.onload = null;
        image.onerror = null;
        image.src = "";
        tryNext(new Error(`Timed out loading image: ${originalSrc}`));
      }, 25000);
      const finish = (callback) => {
        window.clearTimeout(timeout);
        image.onload = null;
        image.onerror = null;
        callback();
      };
      image.onload = () => finish(() => resolve(image));
      image.onerror = () => finish(() => tryNext(new Error(`Could not load image: ${originalSrc}`)));
      image.src = src;
    };

    const tryNext = (error) => {
      candidateIndex += 1;
      if (candidateIndex < candidates.length) {
        tryCandidate();
        return;
      }
      reject(error);
    };

    tryCandidate();
  });
}

function fullPagePanel(width, height) {
  return {
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    label: "Full page",
    pageWidth: width,
    pageHeight: height,
  };
}

function sanitizePanels(panels, width, height) {
  const fallback = [fullPagePanel(width, height)];
  if (!Array.isArray(panels)) return fallback;

  const cleaned = panels
    .filter((panel) =>
      panel &&
      Number.isFinite(panel.x) &&
      Number.isFinite(panel.y) &&
      Number.isFinite(panel.w) &&
      Number.isFinite(panel.h) &&
      panel.w > 0 &&
      panel.h > 0
    )
    .map((panel) => {
      const x = clamp(panel.x, 0, 0.999);
      const y = clamp(panel.y, 0, 0.999);
      return {
        ...panel,
        x,
        y,
        w: clamp(panel.w, 0.001, 1 - x),
        h: clamp(panel.h, 0.001, 1 - y),
        pageWidth: panel.pageWidth || width,
        pageHeight: panel.pageHeight || height,
      };
    });

  if (!cleaned.length) return fallback;

  const sparseTinyPage = cleaned.length <= 2 && panelCoverage(cleaned) < 0.18;
  return sparseTinyPage ? fallback : cleaned;
}

function makeWebtoonPanels(image) {
  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  if (!imageWidth || !imageHeight) return [fullPagePanel(imageWidth, imageHeight)];

  const analysis = analyzeWebtoonRows([image]);
  return makeWebtoonPanelsFromRows(
    analysis.quietRows,
    analysis.activeRows,
    analysis.height,
    imageWidth,
    imageHeight
  );
}

async function prepareContinuousWebtoonChapter(
  pageUrls,
  generation,
  { initialCount = pageUrls.length, initialImages = [] } = {}
) {
  const images = initialImages.slice();
  const count = Math.min(pageUrls.length, Math.max(1, initialCount));
  for (let index = images.length; index < count; index += 1) {
    if (generation !== state.prepareGeneration) throw new Error("Chapter load was replaced.");
    const progress = 18 + Math.round((index / Math.max(1, count)) * 48);
    setReaderLoading(true, `Loading webtoon page ${index + 1} of ${pageUrls.length}...`, progress);
    const image = await loadImage(pageUrls[index]);
    images.push({ url: pageUrls[index], image });
    await yieldToBrowser();
  }

  if (generation !== state.prepareGeneration) throw new Error("Chapter load was replaced.");
  setReaderLoading(true, "Detecting continuous webtoon panels...", 72);
  return buildContinuousWebtoonPage(pageUrls, images);
}

function buildContinuousWebtoonPage(pageUrls, images) {
  const stripWidth = Math.max(...images.map((item) => item.image.naturalWidth || item.image.width || 1));
  let stripY = 0;
  const stripImages = images.map((item, index) => {
    const width = item.image.naturalWidth || item.image.width || stripWidth;
    const height = item.image.naturalHeight || item.image.height || 1;
    const scaledHeight = height * (stripWidth / width);
    const segment = {
      url: item.url,
      index,
      width: stripWidth,
      height: scaledHeight,
      y: stripY,
      naturalWidth: width,
      naturalHeight: height,
    };
    stripY += scaledHeight;
    return segment;
  });

  const analysis = analyzeWebtoonRows(images.map((item) => item.image));
  const panels = makeWebtoonPanelsFromRows(analysis.quietRows, analysis.activeRows, analysis.height, stripWidth, stripY);

  return {
    url: pageUrls[0] || "",
    index: 0,
    panels,
    image: null,
    naturalWidth: stripWidth,
    naturalHeight: stripY,
    detected: true,
    panelMode: "webtoon",
    stripImages,
    sourceImages: images,
    loadedCount: images.length,
    complete: images.length >= pageUrls.length,
  };
}

function analyzeWebtoonRows(images) {
  const ratios = images.map((image) => {
    const width = image.naturalWidth || image.width || 1;
    const height = image.naturalHeight || image.height || 1;
    return height / width;
  });
  const totalRatio = ratios.reduce((sum, ratio) => sum + ratio, 0);
  const analysisWidth = Math.max(140, Math.min(360, Math.floor(9000 / Math.max(1, totalRatio))));
  const rowChunks = [];
  let totalHeight = 0;

  images.forEach((image, index) => {
    const width = analysisWidth;
    const height = Math.max(1, Math.round(ratios[index] * analysisWidth));
    rowChunks.push(analyzeWebtoonImageRows(image, width, height));
    totalHeight += height;
  });

  const quietRows = new Uint8Array(totalHeight);
  const activeRows = new Uint8Array(totalHeight);
  let offset = 0;
  rowChunks.forEach((chunk) => {
    quietRows.set(chunk.quietRows, offset);
    activeRows.set(chunk.activeRows, offset);
    offset += chunk.height;
  });

  return { quietRows, activeRows, height: totalHeight };
}

function analyzeWebtoonImageRows(image, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);

  const { data } = context.getImageData(0, 0, width, height);
  const quietRows = new Uint8Array(height);
  const activeRows = new Uint8Array(height);

  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    let sumSq = 0;
    let ink = 0;
    let edges = 0;
    let previousLum = null;

    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3];
      const lum = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
      sum += lum;
      sumSq += lum * lum;
      if (alpha > 16 && lum < 244) ink += 1;
      if (previousLum !== null && Math.abs(lum - previousLum) > 18) edges += 1;
      previousLum = lum;
    }

    const mean = sum / width;
    const variance = Math.max(0, sumSq / width - mean * mean);
    const inkRatio = ink / width;
    const edgeRatio = edges / Math.max(1, width - 1);
    const veryPlain = variance < 70 && edgeRatio < 0.028;
    const plainWhite = mean > 247 && variance < 120;
    const plainBlack = mean < 14 && variance < 70;
    const quiet = plainWhite || plainBlack || veryPlain;

    quietRows[y] = quiet ? 1 : 0;
    activeRows[y] = !quiet && (variance > 55 || edgeRatio > 0.018 || inkRatio > 0.018) ? 1 : 0;
  }

  return { quietRows, activeRows, height };
}

function makeWebtoonPanelsFromRows(quietRows, activeRows, height, pageWidth, pageHeight) {
  const cuts = findWebtoonHorizontalCuts(quietRows, height);
  const panels = [];
  const minPanelHeight = Math.max(0.025, 18 / height);
  const pad = Math.max(4, Math.round(height * 0.003));

  for (let index = 0; index < cuts.length - 1; index += 1) {
    const start = cuts[index];
    const end = cuts[index + 1];
    const bounds = activeRowBounds(activeRows, start, end);
    if (!bounds) continue;

    const y0 = clamp((bounds.start - pad) / height, 0, 1);
    const y1 = clamp((bounds.end + pad) / height, 0, 1);
    if (y1 - y0 < minPanelHeight) continue;
    panels.push({
      x: 0,
      y: y0,
      w: 1,
      h: y1 - y0,
      pageWidth,
      pageHeight,
    });
  }

  const merged = mergeShortWebtoonPanels(panels, minPanelHeight * 1.8);
  const normalized = splitTallWebtoonPanels(merged, pageWidth, pageHeight, quietRows);
  let readable = normalized.length
    ? normalized
    : makeReadableWebtoonFallbackPanels(pageWidth, pageHeight);
  readable = ensureReadableWebtoonPanels(readable, pageWidth, pageHeight);
  return readable.map((panel, index) => ({ ...panel, label: `Panel ${index + 1}` }));
}

function findWebtoonHorizontalCuts(quietRows, height) {
  const minGap = Math.max(10, Math.round(height * 0.004));
  const cuts = [0];
  let runStart = -1;

  for (let y = 0; y < height; y += 1) {
    if (quietRows[y] && runStart === -1) runStart = y;
    if ((!quietRows[y] || y === height - 1) && runStart !== -1) {
      const runEnd = quietRows[y] && y === height - 1 ? y : y - 1;
      const length = runEnd - runStart + 1;
      const center = Math.round((runStart + runEnd) / 2);
      if (length >= minGap && center > height * 0.01 && center < height * 0.99) {
        cuts.push(center);
      }
      runStart = -1;
    }
  }

  cuts.push(height);
  return [...new Set(cuts)].sort((a, b) => a - b);
}

function activeRowBounds(activeRows, start, end) {
  let first = -1;
  let last = -1;
  for (let y = start; y < end; y += 1) {
    if (!activeRows[y]) continue;
    if (first === -1) first = y;
    last = y;
  }
  return first === -1 ? null : { start: first, end: last + 1 };
}

function mergeShortWebtoonPanels(panels, minHeight) {
  const merged = [];
  panels.forEach((panel) => {
    const previous = merged[merged.length - 1];
    if (previous && panel.h < minHeight) {
      const y0 = Math.min(previous.y, panel.y);
      const y1 = Math.max(previous.y + previous.h, panel.y + panel.h);
      previous.y = y0;
      previous.h = y1 - y0;
      return;
    }
    merged.push({ ...panel });
  });
  return merged;
}

function splitTallWebtoonPanels(panels, imageWidth, imageHeight, quietRows = null) {
  const aspect = readerViewportAspect();
  const viewportHeightPx = Math.max(imageWidth * (aspect.height / aspect.width), imageWidth * 0.65);
  const maxPanelHeightPx = Math.max(imageWidth * 0.55, viewportHeightPx * 0.78);
  const overlapPx = Math.max(imageWidth * 0.08, viewportHeightPx * 0.16);
  const output = [];

  panels.forEach((panel) => {
    const panelStartPx = panel.y * imageHeight;
    const panelEndPx = (panel.y + panel.h) * imageHeight;
    const panelHeightPx = panelEndPx - panelStartPx;
    if (panelHeightPx <= maxPanelHeightPx * 1.08) {
      output.push(panel);
      return;
    }

    let yPx = panelStartPx;
    while (yPx < panelEndPx - 1) {
      const targetEndPx = Math.min(yPx + maxPanelHeightPx, panelEndPx);
      const endPx =
        targetEndPx >= panelEndPx
          ? panelEndPx
          : nearestQuietSplitPx(targetEndPx, yPx, panelEndPx, imageWidth, imageHeight, overlapPx, quietRows);
      const hPx = endPx - yPx;
      if (hPx < imageWidth * 0.22 && output.length) {
        const previous = output[output.length - 1];
        previous.h = Math.min(1 - previous.y, previous.h + hPx / imageHeight);
        break;
      }
      output.push({ ...panel, y: yPx / imageHeight, h: hPx / imageHeight });
      if (endPx >= panelEndPx) break;
      yPx = Math.max(yPx + imageWidth * 0.2, endPx - overlapPx);
    }
  });

  return output.sort((a, b) => a.y - b.y);
}

function makeReadableWebtoonFallbackPanels(imageWidth, imageHeight) {
  const aspect = readerViewportAspect();
  const viewportHeightPx = Math.max(imageWidth * (aspect.height / aspect.width), imageWidth * 0.65);
  const chunkHeightPx = Math.max(imageWidth * 0.55, viewportHeightPx * 0.78);
  const overlapPx = Math.max(imageWidth * 0.08, viewportHeightPx * 0.16);
  const stepPx = Math.max(imageWidth * 0.2, chunkHeightPx - overlapPx);
  const panels = [];

  for (let yPx = 0; yPx < imageHeight - 1; yPx += stepPx) {
    const hPx = Math.min(chunkHeightPx, imageHeight - yPx);
    if (hPx < imageWidth * 0.22 && panels.length) {
      const previous = panels[panels.length - 1];
      previous.h = Math.min(1 - previous.y, previous.h + hPx / imageHeight);
      break;
    }
    panels.push({
      x: 0,
      y: yPx / imageHeight,
      w: 1,
      h: hPx / imageHeight,
      pageWidth: imageWidth,
      pageHeight: imageHeight,
    });
    if (yPx + chunkHeightPx >= imageHeight) break;
  }

  return panels.length ? panels : [fullPagePanel(imageWidth, imageHeight)];
}

function nearestQuietSplitPx(targetPx, startPx, endPx, imageWidth, imageHeight, searchPx, quietRows) {
  if (!quietRows?.length) return targetPx;

  const toRow = (px) => clamp(Math.round((px / imageHeight) * quietRows.length), 0, quietRows.length - 1);
  const toPx = (row) => (row / quietRows.length) * imageHeight;
  const targetRow = toRow(targetPx);
  const searchRows = Math.max(2, toRow(searchPx) - toRow(0));
  const minBeforePx = imageWidth * 0.35;
  const minAfterPx = imageWidth * 0.22;
  let bestRow = -1;
  let bestDistance = Infinity;

  for (let offset = 0; offset <= searchRows; offset += 1) {
    const candidates = offset ? [targetRow - offset, targetRow + offset] : [targetRow];
    for (const row of candidates) {
      if (row < 0 || row >= quietRows.length || !quietRows[row]) continue;
      const px = toPx(row);
      if (px - startPx < minBeforePx || endPx - px < minAfterPx) continue;
      const distance = Math.abs(px - targetPx);
      if (distance < bestDistance) {
        bestRow = row;
        bestDistance = distance;
      }
    }
    if (bestRow !== -1) break;
  }

  return bestRow === -1 ? targetPx : toPx(bestRow);
}

function ensureReadableWebtoonPanels(panels, imageWidth, imageHeight) {
  if (panels.length > 1) return panels;
  const aspect = readerViewportAspect();
  const viewportHeightPx = Math.max(imageWidth * (aspect.height / aspect.width), imageWidth * 0.65);
  const panelHeightPx = (panels[0]?.h || 1) * imageHeight;
  if (panelHeightPx <= viewportHeightPx * 1.08) return panels;
  return makeReadableWebtoonFallbackPanels(imageWidth, imageHeight);
}

function readerViewportAspect() {
  if (isReaderFocusAvailable()) {
    return {
      width: Math.max(1, window.visualViewport?.width || window.innerWidth || 1),
      height: Math.max(1, window.visualViewport?.height || window.innerHeight || 1),
    };
  }

  const rect = el.stage?.getBoundingClientRect();
  return {
    width: Math.max(1, rect?.width || window.innerWidth || 1),
    height: Math.max(1, rect?.height || window.innerHeight || 1),
  };
}

async function detectPanels(image, direction) {
  const modelPanels = await detectMangaPanelsWithModel(image, direction).catch(() => null);
  if (modelPanels) return modelPanels;
  return detectPanelsHeuristic(image, direction);
}

async function detectMangaPanelsWithModel(image, direction) {
  if (state.mangaModelAvailable === false) return null;
  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not encode manga page")), "image/jpeg", 0.9);
  });
  const response = await fetch("/api/detect/manga", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: blob,
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 502 || response.status === 503) {
      state.mangaModelAvailable = false;
    }
    throw new Error(`Manga model returned ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.panels)) throw new Error("Manga model returned an invalid response");
  state.mangaModelAvailable = true;
  if (!payload.panels.length) return [fullPagePanel(image.naturalWidth, image.naturalHeight)];
  const panels = payload.panels.map((panel) => ({
    ...panel,
    pageWidth: image.naturalWidth,
    pageHeight: image.naturalHeight,
  }));
  const consolidated = consolidateMangaPanels(panels);
  const sorted = repairReadingOrder(sortPanels(consolidated, direction), direction);
  return sorted.length ? sorted.map((panel, index) => ({ ...panel, label: `Panel ${index + 1}` })) : [
    fullPagePanel(image.naturalWidth, image.naturalHeight),
  ];
}

async function detectPanelsHeuristic(image, direction) {
  const maxSide = 900;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);

  const { data } = context.getImageData(0, 0, width, height);
  const colStats = makeAxisStats(width);
  const rowStats = makeAxisStats(height);
  const lumData = new Float32Array(width * height);
  const darkMask = new Uint8Array(width * height);
  const blackMask = new Uint8Array(width * height);
  const lightMask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3];
      const lum = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
      const pos = y * width + x;
      lumData[pos] = lum;
      colStats.sum[x] += lum;
      colStats.sumSq[x] += lum * lum;
      rowStats.sum[y] += lum;
      rowStats.sumSq[y] += lum * lum;
      const dark = alpha > 16 && lum < 236;
      if (dark) {
        darkMask[pos] = 1;
        colStats.dark[x] += 1;
        rowStats.dark[y] += 1;
      }
      if (alpha > 16 && lum < 80) {
        blackMask[pos] = 1;
      }
      if (alpha > 16 && lum > 190) {
        lightMask[pos] = 1;
      }
    }
  }

  measureDarkRuns(darkMask, width, height, rowStats, colStats);
  const recursivePanels = detectRecursivePanels(lumData, darkMask, blackMask, width, height, image);
  const connectedPanels = detectConnectedLightPanels(lightMask, width, height, image);
  const slantedPanels = detectSlantedMangaPanels(lumData, darkMask, blackMask, width, height, image);
  const verticalCuts = findGutterCuts(colStats, height, width);
  const horizontalCuts = findGutterCuts(rowStats, width, height);
  const splitPanels = [];

  for (let r = 0; r < horizontalCuts.length - 1; r += 1) {
    const y0 = horizontalCuts[r];
    const y1 = horizontalCuts[r + 1];
    for (let c = 0; c < verticalCuts.length - 1; c += 1) {
      const x0 = verticalCuts[c];
      const x1 = verticalCuts[c + 1];
      const bounds = contentBounds(darkMask, width, height, x0, y0, x1, y1);
      if (!bounds) continue;

      const bw = bounds.x1 - bounds.x0;
      const bh = bounds.y1 - bounds.y0;
      const area = bw * bh;
      const pageArea = width * height;
      if (bw < width * 0.12 || bh < height * 0.06 || area < pageArea * 0.012) continue;

      const pad = Math.max(6, Math.round(Math.min(width, height) * 0.008));
      splitPanels.push({
        x: clamp((bounds.x0 - pad) / width, 0, 1),
        y: clamp((bounds.y0 - pad) / height, 0, 1),
        w: clamp((bw + pad * 2) / width, 0.03, 1),
        h: clamp((bh + pad * 2) / height, 0.03, 1),
        pageWidth: image.naturalWidth,
        pageHeight: image.naturalHeight,
      });
    }
  }

  const panels = choosePanelSet(recursivePanels, connectedPanels, splitPanels, slantedPanels, direction);
  const consolidated = consolidateMangaPanels(panels);
  const sorted = repairReadingOrder(sortPanels(consolidated, direction), direction);
  return sorted.length ? sorted.map((panel, index) => ({ ...panel, label: `Panel ${index + 1}` })) : [
    fullPagePanel(image.naturalWidth, image.naturalHeight),
  ];
}

async function detectComicPanels(image, direction) {
  const maxSide = 900;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);

  const { data } = context.getImageData(0, 0, width, height);
  const colStats = makeAxisStats(width);
  const rowStats = makeAxisStats(height);
  const lumData = new Float32Array(width * height);
  const darkMask = new Uint8Array(width * height);
  const blackMask = new Uint8Array(width * height);
  const lightMask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3];
      const lum = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
      const pos = y * width + x;
      lumData[pos] = lum;
      colStats.sum[x] += lum;
      colStats.sumSq[x] += lum * lum;
      rowStats.sum[y] += lum;
      rowStats.sumSq[y] += lum * lum;
      const dark = alpha > 16 && lum < 236;
      if (dark) {
        darkMask[pos] = 1;
        colStats.dark[x] += 1;
        rowStats.dark[y] += 1;
      }
      if (alpha > 16 && lum < 80) blackMask[pos] = 1;
      if (alpha > 16 && lum > 190) lightMask[pos] = 1;
    }
  }

  measureDarkRuns(darkMask, width, height, rowStats, colStats);
  const recursivePanels = detectRecursivePanels(lumData, darkMask, blackMask, width, height, image);
  const connectedPanels = detectConnectedLightPanels(lightMask, width, height, image);
  const verticalCuts = findGutterCuts(colStats, height, width);
  const horizontalCuts = findGutterCuts(rowStats, width, height);
  const splitPanels = [];

  for (let r = 0; r < horizontalCuts.length - 1; r += 1) {
    const y0 = horizontalCuts[r];
    const y1 = horizontalCuts[r + 1];
    for (let c = 0; c < verticalCuts.length - 1; c += 1) {
      const x0 = verticalCuts[c];
      const x1 = verticalCuts[c + 1];
      const bounds = contentBounds(darkMask, width, height, x0, y0, x1, y1);
      if (!bounds) continue;

      const bw = bounds.x1 - bounds.x0;
      const bh = bounds.y1 - bounds.y0;
      const area = bw * bh;
      const pageArea = width * height;
      if (bw < width * 0.12 || bh < height * 0.06 || area < pageArea * 0.012) continue;

      const pad = Math.max(6, Math.round(Math.min(width, height) * 0.008));
      splitPanels.push({
        x: clamp((bounds.x0 - pad) / width, 0, 1),
        y: clamp((bounds.y0 - pad) / height, 0, 1),
        w: clamp((bw + pad * 2) / width, 0.03, 1),
        h: clamp((bh + pad * 2) / height, 0.03, 1),
        pageWidth: image.naturalWidth,
        pageHeight: image.naturalHeight,
      });
    }
  }

  const textComponents = detectTextLikeComponents(lumData, darkMask, width, height, image);
  const panels = chooseComicPanelSet(recursivePanels, connectedPanels, splitPanels, direction, image, {
    lumData,
    darkMask,
    width,
    height,
    rowStats,
    textComponents,
  });
  const sorted = panels.every((panel) => panel.comicFocus || panel.comicFlow)
    ? sortPanelFallback(panels, direction)
    : repairReadingOrder(sortPanels(mergeDuplicatePanels(panels), direction), direction);
  return sorted.length ? sorted.map((panel, index) => ({ ...panel, label: `Region ${index + 1}` })) : [
    fullPagePanel(image.naturalWidth, image.naturalHeight),
  ];
}

function chooseComicPanelSet(recursivePanels, connectedPanels, splitPanels, direction, image, analysis) {
  const recursive = mergeDuplicatePanels(recursivePanels).filter(isPlausibleRecursivePanel);
  const connected = mergeDuplicatePanels(connectedPanels).filter(isPlausiblePanel);
  const split = mergeDuplicatePanels(splitPanels).filter(isPlausiblePanel);
  const recursiveTiny = recursive.some((panel) => panel.w * panel.h < 0.014);
  const recursiveSingleLarge = recursive.length === 1 && recursive[0].w * recursive[0].h > 0.72;
  const textComponents = analysis?.textComponents || [];

  if (likelyComicCoverOrBackmatter(recursive, connected, split, textComponents)) {
    return [{ ...fullPagePanel(image.naturalWidth, image.naturalHeight), comicFlow: true }];
  }

  if (looksLikeCaptionStripPage(recursive, connected, split, textComponents)) {
    return makeCaptionStripFlowWindows(image.naturalWidth, image.naturalHeight);
  }

  const readableText = makeReadableComicTextWindows(textComponents, image.naturalWidth, image.naturalHeight);
  if (readableText.length >= 3) {
    return readableText;
  }

  if (needsComicStoryFlow(recursive, connected, split, textComponents)) {
    const storyRegions = makeComicStoryFlowRegions(analysis, image);
    if (storyRegions.length) return storyRegions;
  }

  if (
    recursive.length >= 2 &&
    recursive.length <= 9 &&
    !recursiveTiny &&
    !hasReadingOrderViolation(recursive, direction) &&
    !recursiveSingleLarge
  ) {
    return mergeCaptionStripsWithNeighbors(recursive);
  }

  if (
    split.length >= 2 &&
    split.length <= 7 &&
    panelCoverage(split) >= 0.36 &&
    !hasReadingOrderViolation(split, direction) &&
    !splitLooksLikeMontageSlices(split)
  ) {
    return split;
  }

  const storyRegions = makeComicStoryFlowRegions(analysis, image);
  if (storyRegions.length) return storyRegions;

  const focus = makeComicFocusRegions(connected, image);
  if ((recursiveSingleLarge || recursiveTiny || split.length > 8) && focus.length >= 2) {
    return focus;
  }

  if (split.length >= 2 && split.length <= 14) return split;
  if (focus.length >= 2) return focus;
  if (connected.length >= 2) return connected;
  if (recursive.length) return recursive;
  return split;
}

function likelyComicCoverOrBackmatter(recursive, connected, split, textComponents) {
  if (connected.length <= 1 && (recursive.length >= 12 || split.length >= 9)) return true;
  if (connected.length === 0 && textComponents.length === 0) return true;
  if (connected.length <= 3 && split.length >= 5 && textComponents.length >= 14) return true;
  if (connected.length <= 3 && split.length >= 4 && split.length <= 7 && textComponents.length <= 20) {
    const skinny = split.filter((panel) => panel.w < 0.18 && panel.h > 0.45).length;
    if (skinny >= 2) return true;
  }
  return false;
}

function needsComicStoryFlow(recursive, connected, split, textComponents) {
  if (splitLooksLikeMontageSlices(split)) return true;
  if (textComponents.length > 20 && (recursive.length <= 3 || split.length > 8 || connected.length >= 4)) return true;
  if (recursive.length >= 6 && connected.length <= 3 && textComponents.length <= 12) return true;
  return false;
}

function looksLikeCaptionStripPage(recursive, connected, split, textComponents) {
  if (recursive.length >= 6 && connected.length <= 3 && textComponents.length <= 12) return true;
  if (split.length <= 4 && connected.length <= 1 && textComponents.length <= 4) return true;
  return false;
}

function splitLooksLikeMontageSlices(split) {
  if (split.length < 4) return false;
  const tallColumns = split.filter((panel) => panel.h > 0.28 && panel.w < 0.38).length;
  const sharedMidline = split.filter((panel) => panel.x < 0.52 && panel.x + panel.w > 0.52).length;
  return tallColumns >= 4 || sharedMidline >= 4;
}

function makeComicStoryFlowRegions(analysis, image) {
  if (!analysis) return [];
  let windows = makeComicRowWindows(analysis.darkMask, analysis.width, analysis.height, analysis.rowStats, image, analysis.textComponents || []);
  if (windows.length < 3) {
    windows = makeTextGuidedCameraWindows(analysis.textComponents || [], image.naturalWidth, image.naturalHeight);
  }
  if (windows.length < 3) {
    windows = makeDefaultFlowWindows(image.naturalWidth, image.naturalHeight);
  }
  return smoothComicCameraWindows(windows, image.naturalWidth, image.naturalHeight).slice(0, 9);
}

function makeComicRowWindows(darkMask, width, height, rowStats, image, textComponents) {
  const horizontalCuts = findGutterCuts(rowStats, width, height);
  const pageArea = width * height;
  const rows = [];
  for (let index = 0; index < horizontalCuts.length - 1; index += 1) {
    const y0 = horizontalCuts[index];
    const y1 = horizontalCuts[index + 1];
    if (y1 - y0 < height * 0.035) continue;
    const bounds = contentBounds(darkMask, width, height, 0, y0, width, y1);
    if (!bounds) continue;
    const area = (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0);
    if (area < pageArea * 0.012) continue;
    const rowY = clamp((bounds.y0 - height * 0.012) / height, 0, 1);
    const rowH = clamp((bounds.y1 - bounds.y0 + height * 0.024) / height, 0.05, 1);
    rows.push(focusedComicRowWindow(bounds, rowY, rowH, width, height, image, textComponents));
  }

  return mergeShortCameraRows(rows, 0.145).flatMap((row) => splitTallCameraWindow(row, 0.42, 0.06));
}

function focusedComicRowWindow(bounds, rowY, rowH, width, height, image, textComponents) {
  const rowY1 = rowY + rowH;
  const overlappingText = textComponents.filter((component) => (
    oneDimensionalOverlap(rowY, rowY1, component.y, component.y + component.h) > Math.min(rowH, component.h) * 0.18
  ));
  let centerX;
  let desiredW;

  if (overlappingText.length) {
    const minX = Math.min(...overlappingText.map((component) => component.x));
    const maxX = Math.max(...overlappingText.map((component) => component.x + component.w));
    centerX = overlappingText.reduce((sum, component) => sum + component.x + component.w / 2, 0) / overlappingText.length;
    desiredW = clamp((maxX - minX) * 1.9 + 0.22, 0.62, 0.88);
  } else {
    const contentX0 = bounds.x0 / width;
    const contentX1 = bounds.x1 / width;
    centerX = (contentX0 + contentX1) / 2;
    desiredW = clamp((contentX1 - contentX0) * 1.08 + 0.08, 0.68, 0.9);
    if (contentX1 - contentX0 > 0.86) desiredW = 0.82;
  }

  return {
    x: clamp(centerX - desiredW / 2, 0, Math.max(0, 1 - desiredW)),
    y: rowY,
    w: desiredW,
    h: rowH,
    pageWidth: image.naturalWidth,
    pageHeight: image.naturalHeight,
    comicFlow: true,
  };
}

function mergeShortCameraRows(rows, minHeight) {
  const merged = [];
  sortPanelFallback(rows, "ltr").forEach((row) => {
    const previous = merged[merged.length - 1];
    if (previous && (row.h < minHeight || previous.h < minHeight)) {
      const y0 = Math.min(previous.y, row.y);
      const y1 = Math.max(previous.y + previous.h, row.y + row.h);
      previous.y = y0;
      previous.h = y1 - y0;
      return;
    }
    merged.push({ ...row });
  });
  return merged;
}

function splitTallCameraWindow(panel, maxHeight, overlap) {
  if (panel.h <= maxHeight) return [panel];
  const windows = [];
  const end = panel.y + panel.h;
  let y = panel.y;
  while (y < end - 0.02) {
    const h = Math.min(maxHeight, end - y);
    if (h < 0.16 && windows.length) {
      const previous = windows[windows.length - 1];
      previous.h = Math.min(1 - previous.y, end - previous.y);
      break;
    }
    windows.push({ ...panel, y, h, comicFlow: true });
    if (y + h >= end) break;
    y += Math.max(0.12, h - overlap);
  }
  return windows;
}

function makeTextGuidedCameraWindows(textComponents, pageWidth, pageHeight) {
  if (!textComponents.length) return [];
  const centers = textComponents
    .map((component) => component.y + component.h / 2)
    .sort((a, b) => a - b);
  const clusters = [];
  centers.forEach((centerY) => {
    const previous = clusters[clusters.length - 1];
    if (!previous || centerY - previous[previous.length - 1] > 0.16) {
      clusters.push([centerY]);
      return;
    }
    previous.push(centerY);
  });

  return clusters.slice(0, 7).map((cluster) => {
    const centerY = cluster.reduce((sum, value) => sum + value, 0) / cluster.length;
    const h = cluster.length <= 2 ? 0.34 : 0.4;
    return {
      x: 0,
      y: clamp(centerY - h / 2, 0, Math.max(0, 1 - h)),
      w: 1,
      h,
      pageWidth,
      pageHeight,
      comicFlow: true,
    };
  });
}

function makeDefaultFlowWindows(pageWidth, pageHeight) {
  return [
    { x: 0, y: 0, w: 1, h: 0.38, pageWidth, pageHeight, comicFlow: true },
    { x: 0, y: 0.31, w: 1, h: 0.38, pageWidth, pageHeight, comicFlow: true },
    { x: 0, y: 0.62, w: 1, h: 0.38, pageWidth, pageHeight, comicFlow: true },
  ];
}

function smoothComicCameraWindows(windows, pageWidth, pageHeight) {
  const smoothed = [];
  sortPanelFallback(windows, "ltr").forEach((window) => {
    const candidate = {
      x: clamp(window.x, 0, 1),
      y: clamp(window.y, 0, 1),
      w: clamp(window.w, 0.52, 1),
      h: clamp(window.h, 0.2, 0.52),
      pageWidth,
      pageHeight,
      comicFlow: true,
    };
    candidate.x = clamp(candidate.x, 0, Math.max(0, 1 - candidate.w));
    candidate.y = clamp(candidate.y, 0, Math.max(0, 1 - candidate.h));
    const previous = smoothed[smoothed.length - 1];
    if (previous && intersectionOverUnion(candidate, previous) > 0.72) return;
    if (previous && candidate.y < previous.y + previous.h * 0.18) {
      candidate.y = clamp(previous.y + previous.h * 0.18, 0, Math.max(0, 1 - candidate.h));
    }
    smoothed.push(candidate);
  });
  return smoothed;
}

function mergeCaptionStripsWithNeighbors(panels) {
  const output = [];
  sortPanelFallback(panels, "ltr").forEach((panel) => {
    const shallowCaption = panel.w > 0.62 && panel.h < 0.085;
    const narrowCaption = panel.w < 0.12 && panel.h > 0.16;
    const previous = output[output.length - 1];
    if ((shallowCaption || narrowCaption) && previous) {
      const x0 = Math.min(previous.x, panel.x);
      const y0 = Math.min(previous.y, panel.y);
      const x1 = Math.max(previous.x + previous.w, panel.x + panel.w);
      const y1 = Math.max(previous.y + previous.h, panel.y + panel.h);
      previous.x = x0;
      previous.y = y0;
      previous.w = x1 - x0;
      previous.h = y1 - y0;
      return;
    }
    output.push({ ...panel });
  });
  return output;
}

function makeCaptionStripFlowWindows(pageWidth, pageHeight) {
  return [
    { x: 0.18, y: 0, w: 0.64, h: 0.38, pageWidth, pageHeight, comicFlow: true },
    { x: 0.18, y: 0.31, w: 0.64, h: 0.38, pageWidth, pageHeight, comicFlow: true },
    { x: 0.18, y: 0.62, w: 0.64, h: 0.38, pageWidth, pageHeight, comicFlow: true },
  ];
}

function makeReadableComicTextWindows(textComponents, pageWidth, pageHeight) {
  const components = textComponents.filter((item) => {
    const area = item.w * item.h;
    return area >= 0.0008 && area <= 0.06 && item.w <= 0.42 && item.h <= 0.2;
  });
  if (components.length < 3) return [];

  const groups = [];
  sortPanelFallback(components, "ltr").forEach((component) => {
    let best = null;
    let bestGap = Infinity;
    groups.forEach((group) => {
      const yGap = Math.max(0, Math.max(group.y, component.y) - Math.min(group.y + group.h, component.y + component.h));
      const xGap = Math.max(0, Math.max(group.x, component.x) - Math.min(group.x + group.w, component.x + component.w));
      const verticalOverlap = oneDimensionalOverlap(group.y, group.y + group.h, component.y, component.y + component.h);
      const sameRow = verticalOverlap > Math.min(group.h, component.h) * 0.25 || yGap < 0.055;
      if (sameRow && xGap < 0.16 && yGap < bestGap) {
        best = group;
        bestGap = yGap;
      }
    });

    if (best) {
      const x0 = Math.min(best.x, component.x);
      const y0 = Math.min(best.y, component.y);
      const x1 = Math.max(best.x + best.w, component.x + component.w);
      const y1 = Math.max(best.y + best.h, component.y + component.h);
      best.x = x0;
      best.y = y0;
      best.w = x1 - x0;
      best.h = y1 - y0;
      best.count = (best.count || 1) + 1;
      return;
    }
    groups.push({ ...component, count: 1 });
  });

  const windows = sortPanelFallback(groups, "ltr").slice(0, 12).map((group) => {
    const centerX = group.x + group.w / 2;
    const centerY = group.y + group.h / 2;
    let w = clamp(group.w * 1.75 + 0.18, 0.42, 0.68);
    let h = clamp(group.h * 2.35 + 0.12, 0.2, 0.42);
    if ((group.count || 1) >= 2) {
      w = Math.min(0.74, w + 0.08);
      h = Math.min(0.46, h + 0.04);
    }
    return {
      x: clamp(centerX - w / 2, 0, Math.max(0, 1 - w)),
      y: clamp(centerY - h / 2, 0, Math.max(0, 1 - h)),
      w,
      h,
      pageWidth,
      pageHeight,
      comicFlow: true,
    };
  });

  return suppressNearDuplicateWindows(windows);
}

function suppressNearDuplicateWindows(windows) {
  const kept = [];
  sortPanelFallback(windows, "ltr").forEach((window) => {
    const previous = kept[kept.length - 1];
    if (previous && intersectionOverUnion(window, previous) > 0.55) {
      const x0 = Math.min(previous.x, window.x);
      const y0 = Math.min(previous.y, window.y);
      const x1 = Math.max(previous.x + previous.w, window.x + window.w);
      const y1 = Math.max(previous.y + previous.h, window.y + window.h);
      previous.x = clamp(x0, 0, 1);
      previous.y = clamp(y0, 0, 1);
      previous.w = clamp(x1 - x0, 0.42, 0.74);
      previous.h = clamp(y1 - y0, 0.2, 0.46);
      previous.x = clamp(previous.x, 0, Math.max(0, 1 - previous.w));
      previous.y = clamp(previous.y, 0, Math.max(0, 1 - previous.h));
      return;
    }
    kept.push({ ...window });
  });
  return kept;
}

function detectTextLikeComponents(lumData, darkMask, width, height, image) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const components = [];
  const pageArea = width * height;

  for (let start = 0; start < lumData.length; start += 1) {
    if (lumData[start] <= 213 || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    visited[start] = 1;
    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let touchesEdge = false;

    while (head < tail) {
      const pos = queue[head];
      head += 1;
      const x = pos % width;
      const y = Math.floor(pos / width);
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      touchesEdge = touchesEdge || x === 0 || x === width - 1 || y === 0 || y === height - 1;

      if (x > 0) tail = enqueueLightNeighbor(pos - 1, lumData, visited, queue, tail);
      if (x < width - 1) tail = enqueueLightNeighbor(pos + 1, lumData, visited, queue, tail);
      if (y > 0) tail = enqueueLightNeighbor(pos - width, lumData, visited, queue, tail);
      if (y < height - 1) tail = enqueueLightNeighbor(pos + width, lumData, visited, queue, tail);
    }

    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    const boxArea = boxW * boxH;
    if (boxW < width * 0.035 || boxH < height * 0.012) continue;
    if (boxArea < pageArea * 0.0006 || boxArea > pageArea * 0.09) continue;
    if (touchesEdge && (boxW > width * 0.55 || boxH > height * 0.18)) continue;

    let darkCount = 0;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (darkMask[y * width + x]) darkCount += 1;
      }
    }
    const fill = count / Math.max(1, boxArea);
    const darkDensity = darkCount / Math.max(1, boxArea);
    if (fill < 0.2 || darkDensity < 0.004) continue;

    const padX = Math.max(5, Math.round(width * 0.01));
    const padY = Math.max(5, Math.round(height * 0.006));
    components.push({
      x: clamp((minX - padX) / width, 0, 1),
      y: clamp((minY - padY) / height, 0, 1),
      w: clamp((boxW + padX * 2) / width, 0.02, 1),
      h: clamp((boxH + padY * 2) / height, 0.02, 1),
      pageWidth: image.naturalWidth,
      pageHeight: image.naturalHeight,
    });
  }

  return components;
}

function enqueueLightNeighbor(pos, lumData, visited, queue, tail) {
  if (visited[pos] || lumData[pos] <= 213) return tail;
  visited[pos] = 1;
  queue[tail] = pos;
  return tail + 1;
}

function makeComicFocusRegions(connectedPanels, image) {
  const pageWidth = image.naturalWidth || image.width;
  const pageHeight = image.naturalHeight || image.height;
  const candidates = mergeDuplicatePanels(connectedPanels)
    .filter((panel) => {
      const area = panel.w * panel.h;
      return isPlausiblePanel(panel) && area < 0.42;
    })
    .map((panel) => expandComicFocusRegion(panel, pageWidth, pageHeight));

  return sortPanelFallback(candidates, "ltr").slice(0, 16).map((panel) => ({ ...panel, pageWidth, pageHeight, comicFocus: true }));
}

function expandComicFocusRegion(panel, pageWidth, pageHeight) {
  const centerX = panel.x + panel.w / 2;
  const centerY = panel.y + panel.h / 2;
  const pageRatio = pageHeight / Math.max(1, pageWidth);
  let w = Math.max(panel.w * 2.55, 0.5);
  let h = Math.max(panel.h * 3.15, 0.24);
  if (pageRatio > 1.35) h = Math.max(h, w * 0.58);
  if (panel.w > 0.45 || panel.h > 0.25) {
    w = Math.max(panel.w * 1.45, 0.55);
    h = Math.max(panel.h * 1.65, 0.28);
  }
  w = Math.min(1, w);
  h = Math.min(0.72, h);
  const x = clamp(centerX - w / 2, 0, Math.max(0, 1 - w));
  const y = clamp(centerY - h / 2, 0, Math.max(0, 1 - h));
  return { x, y, w, h, pageWidth, pageHeight };
}

function mergeComicFocusRegions(panels) {
  const sorted = sortPanelFallback(panels, "ltr");
  const merged = [];
  sorted.forEach((panel) => {
    const previous = merged[merged.length - 1];
    if (previous && shouldMergeComicFocus(previous, panel)) {
      const x0 = Math.min(previous.x, panel.x);
      const y0 = Math.min(previous.y, panel.y);
      const x1 = Math.max(previous.x + previous.w, panel.x + panel.w);
      const y1 = Math.max(previous.y + previous.h, panel.y + panel.h);
      previous.x = x0;
      previous.y = y0;
      previous.w = x1 - x0;
      previous.h = y1 - y0;
      return;
    }
    merged.push({ ...panel });
  });
  return merged;
}

function shouldMergeComicFocus(a, b) {
  const overlapX = oneDimensionalOverlap(a.x, a.x + a.w, b.x, b.x + b.w);
  const overlapY = oneDimensionalOverlap(a.y, a.y + a.h, b.y, b.y + b.h);
  const smallerX = Math.min(a.w, b.w);
  const smallerY = Math.min(a.h, b.h);
  if (intersectionOverUnion(a, b) > 0.42) return true;
  if (overlapX > smallerX * 0.7 && overlapY > smallerY * 0.68) return true;
  return false;
}

function detectRecursivePanels(lumData, darkMask, blackMask, width, height, image) {
  const regions = splitPanelRegion(lumData, darkMask, blackMask, width, height, [0, 0, width, height], 0);
  const pageArea = width * height;
  const pad = Math.max(4, Math.round(Math.min(width, height) * 0.006));
  const panels = [];

  regions.forEach((region) => {
    const bounds = contentBounds(darkMask, width, height, region[0], region[1], region[2], region[3]);
    if (!bounds) return;

    const bw = bounds.x1 - bounds.x0;
    const bh = bounds.y1 - bounds.y0;
    const area = bw * bh;
    if (bw < width * 0.08 || bh < height * 0.04 || area < pageArea * 0.006) return;

    if (area > pageArea * 0.975) {
      panels.push(fullPagePanel(image.naturalWidth, image.naturalHeight));
      return;
    }

    panels.push({
      x: clamp((bounds.x0 - pad) / width, 0, 1),
      y: clamp((bounds.y0 - pad) / height, 0, 1),
      w: clamp((bw + pad * 2) / width, 0.03, 1),
      h: clamp((bh + pad * 2) / height, 0.03, 1),
      pageWidth: image.naturalWidth,
      pageHeight: image.naturalHeight,
    });
  });

  return filterEdgeTitleStrips(mergeDuplicatePanels(panels));
}

function detectSlantedMangaPanels(lumData, darkMask, blackMask, width, height, image) {
  const separators = findSlantedHorizontalSeparators(blackMask, width, height);
  if (!separators.length) return [];

  const pageArea = width * height;
  const pad = Math.max(6, Math.round(Math.min(width, height) * 0.009));
  const overlap = Math.max(8, Math.round(height * 0.012));
  const rows = [];
  let yStart = 0;

  separators.forEach((line) => {
    const lineMin = Math.min(line.yLeft, line.yRight);
    const lineMax = Math.max(line.yLeft, line.yRight);
    rows.push([0, Math.max(0, Math.floor(yStart)), width, Math.min(height, Math.ceil(lineMax + overlap))]);
    yStart = Math.max(0, lineMin - overlap);
  });
  rows.push([0, Math.max(0, Math.floor(yStart)), width, height]);

  const panels = [];
  rows.forEach((row) => {
    const rowBounds = contentBounds(darkMask, width, height, row[0], row[1], row[2], row[3]);
    if (!rowBounds) return;
    const rowRegion = [
      Math.max(0, rowBounds.x0 - 1),
      Math.max(0, rowBounds.y0 - 1),
      Math.min(width, rowBounds.x1 + 1),
      Math.min(height, rowBounds.y1 + 1),
    ];
    const leaves = splitPanelRegion(lumData, darkMask, blackMask, width, height, rowRegion, 1);

    leaves.forEach((leaf) => {
      const bounds = contentBounds(darkMask, width, height, leaf[0], leaf[1], leaf[2], leaf[3]);
      if (!bounds) return;

      const bw = bounds.x1 - bounds.x0;
      const bh = bounds.y1 - bounds.y0;
      const area = bw * bh;
      if (bw < width * 0.1 || bh < height * 0.045 || area < pageArea * 0.008) return;

      panels.push({
        x: clamp((bounds.x0 - pad) / width, 0, 1),
        y: clamp((bounds.y0 - pad) / height, 0, 1),
        w: clamp((bw + pad * 2) / width, 0.03, 1),
        h: clamp((bh + pad * 2) / height, 0.03, 1),
        pageWidth: image.naturalWidth,
        pageHeight: image.naturalHeight,
        slantedManga: true,
      });
    });
  });

  return filterEdgeTitleStrips(mergeDuplicatePanels(panels)).filter(isPlausiblePanel).slice(0, 14);
}

function findSlantedHorizontalSeparators(blackMask, width, height) {
  const candidates = [];
  const yStep = Math.max(5, Math.round(height * 0.008));
  const deltaStep = Math.max(8, Math.round(height * 0.016));
  const minDelta = Math.max(12, Math.round(height * 0.025));
  const maxDelta = Math.max(minDelta, Math.round(height * 0.18));

  for (let center = Math.round(height * 0.08); center <= height * 0.92; center += yStep) {
    for (let delta = -maxDelta; delta <= maxDelta; delta += deltaStep) {
      if (Math.abs(delta) < minDelta) continue;
      const yLeft = center - delta / 2;
      const yRight = center + delta / 2;
      if (yLeft < height * 0.04 || yLeft > height * 0.96 || yRight < height * 0.04 || yRight > height * 0.96) {
        continue;
      }
      const score = slantedLineScore(blackMask, width, height, yLeft, yRight);
      if (score.coverage >= 0.58 && score.longestGap <= 0.24 && score.hitDensity >= 0.06) {
        candidates.push({ yLeft, yRight, center, score: score.coverage + score.hitDensity * 1.6 - score.longestGap });
      }
    }
  }

  const kept = [];
  candidates
    .sort((a, b) => b.score - a.score)
    .forEach((line) => {
      const tooClose = kept.some((item) => Math.abs(item.center - line.center) < height * 0.075);
      if (!tooClose) kept.push(line);
    });

  return kept.sort((a, b) => a.center - b.center).slice(0, 5);
}

function slantedLineScore(blackMask, width, height, yLeft, yRight) {
  const samples = 72;
  const band = Math.max(2, Math.round(height * 0.003));
  let hitBins = 0;
  let hitPixels = 0;
  let longestMiss = 0;
  let missRun = 0;

  for (let i = 0; i < samples; i += 1) {
    const ratio = samples === 1 ? 0 : i / (samples - 1);
    const x = clamp(Math.round(ratio * (width - 1)), 0, width - 1);
    const y = yLeft + (yRight - yLeft) * ratio;
    let binHit = false;

    for (let dy = -band; dy <= band; dy += 1) {
      const yy = clamp(Math.round(y + dy), 0, height - 1);
      if (blackMask[yy * width + x]) {
        hitPixels += 1;
        binHit = true;
      }
    }

    if (binHit) {
      hitBins += 1;
      missRun = 0;
    } else {
      missRun += 1;
      longestMiss = Math.max(longestMiss, missRun);
    }
  }

  return {
    coverage: hitBins / samples,
    hitDensity: hitPixels / (samples * (band * 2 + 1)),
    longestGap: longestMiss / samples,
  };
}

function splitPanelRegion(lumData, darkMask, blackMask, width, height, region, depth) {
  const bounds = contentBounds(darkMask, width, height, region[0], region[1], region[2], region[3]);
  if (!bounds) return [];

  const padded = [
    Math.max(0, bounds.x0 - 1),
    Math.max(0, bounds.y0 - 1),
    Math.min(width, bounds.x1 + 1),
    Math.min(height, bounds.y1 + 1),
  ];
  const regionWidth = padded[2] - padded[0];
  const regionHeight = padded[3] - padded[1];
  const pageArea = width * height;

  if (
    depth >= 6 ||
    regionWidth < 70 ||
    regionHeight < 70 ||
    regionWidth * regionHeight < pageArea * 0.01
  ) {
    return [padded];
  }

  const verticalCuts = findLocalGutterCuts(lumData, darkMask, blackMask, width, height, padded, "x");
  const horizontalCuts = findLocalGutterCuts(lumData, darkMask, blackMask, width, height, padded, "y");
  if (!verticalCuts.length && !horizontalCuts.length) return [padded];

  const verticalScore = averageCutScore(verticalCuts);
  const horizontalScore = averageCutScore(horizontalCuts);
  const splitAxis =
    horizontalCuts.length &&
    (!verticalCuts.length ||
      horizontalScore > verticalScore * 0.92 ||
      horizontalCuts.length > verticalCuts.length)
      ? "y"
      : "x";
  const cuts = splitAxis === "x" ? verticalCuts : horizontalCuts;
  const start = splitAxis === "x" ? padded[0] : padded[1];
  const end = splitAxis === "x" ? padded[2] : padded[3];
  const coords = [start, ...cuts.map((cut) => cut.center), end];
  const leaves = [];

  for (let i = 0; i < coords.length - 1; i += 1) {
    const a = coords[i];
    const b = coords[i + 1];
    if (b - a < 35) continue;

    const nextRegion =
      splitAxis === "x" ? [a, padded[1], b, padded[3]] : [padded[0], a, padded[2], b];
    leaves.push(...splitPanelRegion(lumData, darkMask, blackMask, width, height, nextRegion, depth + 1));
  }

  return leaves.length ? leaves : [padded];
}

function findLocalGutterCuts(lumData, darkMask, blackMask, width, height, region, axis) {
  const [x0, y0, x1, y1] = region;
  const size = axis === "x" ? x1 - x0 : y1 - y0;
  const crossSize = axis === "x" ? y1 - y0 : x1 - x0;
  if (size < 80 || crossSize < 80) return [];

  const candidates = [];
  for (let primary = axis === "x" ? x0 : y0; primary < (axis === "x" ? x1 : y1); primary += 1) {
    const metrics = localLineMetrics(lumData, darkMask, blackMask, width, region, axis, primary);
    const whiteGutter = (metrics.mean > 242 && metrics.variance < 520 && metrics.darkDensity < 0.1) ||
      metrics.darkDensity < 0.006;
    const blackDivider = metrics.blackRun > 0.58 && metrics.blackDensity > 0.18;

    if (!whiteGutter && !blackDivider) continue;

    const score =
      (whiteGutter ? 1.1 : 0) +
      (blackDivider ? 1.7 * metrics.blackRun : 0) +
      Math.min(0.8, metrics.blackDensity * 1.5) +
      (whiteGutter ? Math.min(0.4, Math.max(0, (metrics.mean - 242) / 20)) : 0);
    candidates.push({ pos: primary, score });
  }

  const minRun = Math.max(3, Math.round(size * 0.004));
  const edge = Math.max(8, Math.round(size * 0.03));
  const groups = [];
  let index = 0;

  while (index < candidates.length) {
    const start = index;
    let end = index;
    while (end + 1 < candidates.length && candidates[end + 1].pos <= candidates[end].pos + 1) {
      end += 1;
    }

    const p0 = candidates[start].pos;
    const p1 = candidates[end].pos;
    const length = p1 - p0 + 1;
    const center = Math.round((p0 + p1) / 2);
    const localCenter = center - (axis === "x" ? x0 : y0);
    const baseScore =
      candidates.slice(start, end + 1).reduce((sum, candidate) => sum + candidate.score, 0) / length;
    const score = baseScore + Math.min(1, length / 18) * 0.3;

    if (length >= minRun && localCenter > edge && localCenter < size - edge) {
      groups.push({ center, score, length });
    }
    index = end + 1;
  }

  const kept = [];
  groups
    .sort((a, b) => b.score - a.score)
    .forEach((group) => {
      if (!validLocalCut(darkMask, width, height, region, axis, group.center)) return;
      const tooClose = kept.some((item) => Math.abs(item.center - group.center) <= Math.max(7, size * 0.022));
      if (!tooClose) kept.push(group);
    });

  return kept.sort((a, b) => a.center - b.center).slice(0, 7);
}

function localLineMetrics(lumData, darkMask, blackMask, width, region, axis, primary) {
  const [x0, y0, x1, y1] = region;
  const crossStart = axis === "x" ? y0 : x0;
  const crossEnd = axis === "x" ? y1 : x1;
  const crossSize = Math.max(1, crossEnd - crossStart);
  let sum = 0;
  let sumSq = 0;
  let dark = 0;
  let black = 0;
  let blackRun = 0;
  let longestBlackRun = 0;

  for (let cross = crossStart; cross < crossEnd; cross += 1) {
    const x = axis === "x" ? primary : cross;
    const y = axis === "x" ? cross : primary;
    const pos = y * width + x;
    const lum = lumData[pos];
    sum += lum;
    sumSq += lum * lum;
    if (darkMask[pos]) dark += 1;
    if (blackMask[pos]) {
      black += 1;
      blackRun += 1;
      if (blackRun > longestBlackRun) longestBlackRun = blackRun;
    } else {
      blackRun = 0;
    }
  }

  const mean = sum / crossSize;
  return {
    mean,
    variance: Math.max(0, sumSq / crossSize - mean * mean),
    darkDensity: dark / crossSize,
    blackDensity: black / crossSize,
    blackRun: longestBlackRun / crossSize,
  };
}

function validLocalCut(mask, width, height, region, axis, center) {
  const [x0, y0, x1, y1] = region;
  const first = axis === "x" ? [x0, y0, center, y1] : [x0, y0, x1, center];
  const second = axis === "x" ? [center, y0, x1, y1] : [x0, center, x1, y1];
  const firstBounds = contentBounds(mask, width, height, first[0], first[1], first[2], first[3]);
  const secondBounds = contentBounds(mask, width, height, second[0], second[1], second[2], second[3]);
  if (!firstBounds || !secondBounds) return false;

  const firstArea = (firstBounds.x1 - firstBounds.x0) * (firstBounds.y1 - firstBounds.y0);
  const secondArea = (secondBounds.x1 - secondBounds.x0) * (secondBounds.y1 - secondBounds.y0);
  const pageArea = width * height;
  return firstArea >= pageArea * 0.005 && secondArea >= pageArea * 0.005;
}

function averageCutScore(cuts) {
  if (!cuts.length) return 0;
  return cuts.reduce((sum, cut) => sum + cut.score, 0) / cuts.length;
}

function filterEdgeTitleStrips(panels) {
  return panels.filter((panel) => {
    const topEdge = panel.y < 0.025;
    const bottomEdge = panel.y + panel.h > 0.975;
    const shallow = panel.h < 0.13;
    const narrowTitleSlice = panel.w < 0.28 && panel.h < 0.16;
    const edgeTitle = (topEdge || bottomEdge) && (shallow || narrowTitleSlice);
    return !edgeTitle;
  });
}

function detectConnectedLightPanels(mask, width, height, image) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const panels = [];
  const minWidth = Math.max(24, width * 0.12);
  const minHeight = Math.max(24, height * 0.055);
  const minArea = width * height * 0.008;
  const pad = Math.max(6, Math.round(Math.min(width, height) * 0.012));

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let touchesEdge = false;
    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const pos = queue[head++];
      const x = pos % width;
      const y = Math.floor(pos / width);
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;

      if (x > 0) tail = enqueueLight(mask, visited, queue, tail, pos - 1);
      if (x < width - 1) tail = enqueueLight(mask, visited, queue, tail, pos + 1);
      if (y > 0) tail = enqueueLight(mask, visited, queue, tail, pos - width);
      if (y < height - 1) tail = enqueueLight(mask, visited, queue, tail, pos + width);
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const boxArea = boxWidth * boxHeight;
    const fillRatio = count / Math.max(1, boxArea);
    const tooSmall = boxWidth < minWidth || boxHeight < minHeight || boxArea < minArea;
    const wholePage = boxWidth > width * 0.82 && boxHeight > height * 0.82;
    const pageBackground = touchesEdge && (boxWidth > width * 0.5 || boxHeight > height * 0.5);
    const likelyBubble = fillRatio > 0.72 && boxWidth < width * 0.28 && boxHeight < height * 0.14;
    if (tooSmall || wholePage || pageBackground || likelyBubble) continue;

    panels.push({
      x: clamp((minX - pad) / width, 0, 1),
      y: clamp((minY - pad) / height, 0, 1),
      w: clamp((boxWidth + pad * 2) / width, 0.03, 1),
      h: clamp((boxHeight + pad * 2) / height, 0.03, 1),
      pageWidth: image.naturalWidth,
      pageHeight: image.naturalHeight,
    });
  }

  return panels;
}

function enqueueLight(mask, visited, queue, tail, pos) {
  if (mask[pos] && !visited[pos]) {
    visited[pos] = 1;
    queue[tail] = pos;
    return tail + 1;
  }
  return tail;
}

function choosePanelSet(recursivePanels, connectedPanels, splitPanels, slantedPanels = [], direction) {
  const recursive = mergeDuplicatePanels(recursivePanels).filter(isPlausibleRecursivePanel);
  const connected = mergeDuplicatePanels(connectedPanels).filter(isPlausiblePanel);
  const split = mergeDuplicatePanels(splitPanels).filter(isPlausiblePanel);
  const slanted = mergeDuplicatePanels(slantedPanels).filter(isPlausiblePanel);
  const recursiveMaxArea = maxPanelArea(recursive);
  const slantedMaxArea = maxPanelArea(slanted);
  if (
    slanted.length >= 3 &&
    slanted.length <= 14 &&
    (slanted.length >= Math.max(recursive.length, split.length) + 1 ||
      (slanted.length >= recursive.length && slantedMaxArea < recursiveMaxArea * 0.78)) &&
    !hasReadingOrderViolation(slanted, direction)
  ) {
    return slanted;
  }
  if (recursive.length >= 1 && recursive.length <= 12) {
    return recursive;
  }
  if ((connected.length >= 16 || connectedPanels.length > 16) && recursivePanels.length) {
    return mergeDuplicatePanels(recursivePanels);
  }
  if (
    split.length >= 2 &&
    (connected.length > 12 || (connected.length >= 8 && panelCoverage(connected) < 0.45 && split.length < connected.length))
  ) {
    return split;
  }
  if (split.length >= 2 && connected.length >= 8 && hasReadingOrderViolation(connected, direction)) {
    return split;
  }
  if (connected.length >= 2 && hasReadingOrderViolation(connected, direction) && recursivePanels.length) {
    return mergeDuplicatePanels(recursivePanels);
  }
  if (connected.length >= 2 && connected.length <= 16 && connected.length >= split.length) {
    return connected;
  }
  if (split.length >= 2 && split.length <= 16) {
    return split;
  }
  if (connected.length) return connected;
  return split;
}

function isPlausibleRecursivePanel(panel) {
  if (panel.label === "Full page" || (panel.x === 0 && panel.y === 0 && panel.w === 1 && panel.h === 1)) {
    return true;
  }
  return isPlausiblePanel(panel);
}

function maxPanelArea(panels) {
  return panels.reduce((max, panel) => Math.max(max, panel.w * panel.h), 0);
}

function isPlausiblePanel(panel) {
  const area = panel.w * panel.h;
  return panel.w > 0.08 && panel.h > 0.045 && area > 0.006 && area < 0.92;
}

function panelCoverage(panels) {
  return panels.reduce((sum, panel) => sum + panel.w * panel.h, 0);
}

function makeAxisStats(size) {
  return {
    dark: new Uint16Array(size),
    run: new Uint16Array(size),
    sum: new Float64Array(size),
    sumSq: new Float64Array(size),
  };
}

function measureDarkRuns(mask, width, height, rowStats, colStats) {
  for (let y = 0; y < height; y += 1) {
    let run = 0;
    let longest = 0;
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) {
        run += 1;
        if (run > longest) longest = run;
      } else {
        run = 0;
      }
    }
    rowStats.run[y] = longest;
  }

  for (let x = 0; x < width; x += 1) {
    let run = 0;
    let longest = 0;
    for (let y = 0; y < height; y += 1) {
      if (mask[y * width + x]) {
        run += 1;
        if (run > longest) longest = run;
      } else {
        run = 0;
      }
    }
    colStats.run[x] = longest;
  }
}

function findGutterCuts(stats, crossSize, size) {
  const threshold = Math.max(2, Math.round(crossSize * 0.012));
  const minRun = Math.max(7, Math.round(size * 0.012));
  const cuts = [0];
  let runStart = -1;

  for (let i = 0; i < size; i += 1) {
    const mean = stats.sum[i] / crossSize;
    const variance = Math.max(0, stats.sumSq[i] / crossSize - mean * mean);
    const isQuietLight = variance < 80 && mean > 238;
    const isQuietDark = variance < 80 && mean < 38;
    const isDarkDivider = stats.run[i] >= crossSize * 0.62;
    const isGutter = stats.dark[i] <= threshold || isQuietLight || isQuietDark || isDarkDivider;
    if (isGutter && runStart === -1) runStart = i;
    if ((!isGutter || i === size - 1) && runStart !== -1) {
      const runEnd = isGutter && i === size - 1 ? i : i - 1;
      const length = runEnd - runStart + 1;
      const center = Math.round((runStart + runEnd) / 2);
      const awayFromEdge = center > size * 0.06 && center < size * 0.94;
      if (length >= minRun && awayFromEdge) cuts.push(center);
      runStart = -1;
    }
  }

  cuts.push(size);
  return [...new Set(cuts)].sort((a, b) => a - b);
}

function contentBounds(mask, width, height, x0, y0, x1, y1) {
  let minX = x1;
  let minY = y1;
  let maxX = x0;
  let maxY = y0;
  let count = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (!mask[y * width + x]) continue;
      count += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  if (count / area < 0.004) return null;
  return { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
}

function mergeDuplicatePanels(panels) {
  const kept = [];
  panels.forEach((panel) => {
    const duplicate = kept.some((item) => intersectionOverUnion(panel, item) > 0.82);
    if (!duplicate) kept.push(panel);
  });
  return kept;
}

function intersectionOverUnion(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union ? intersection / union : 0;
}

function sortPanels(panels, direction) {
  return sortPanelLayout(panels, direction, 0);
}

function repairReadingOrder(panels, direction) {
  const ordered = panels.slice();
  const maxPasses = ordered.length * ordered.length;
  let passes = 0;
  let changed = true;

  while (changed && passes < maxPasses) {
    changed = false;
    passes += 1;
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const current = ordered[index];
      const next = ordered[index + 1];
      if (!readingTransitionViolation(current, next, direction)) continue;
      if (readingTransitionViolation(next, current, direction)) continue;
      ordered[index] = next;
      ordered[index + 1] = current;
      changed = true;
    }
  }

  return ordered;
}

function hasReadingOrderViolation(panels, direction) {
  const ordered = repairReadingOrder(sortPanels(mergeDuplicatePanels(panels), direction), direction);
  for (let index = 0; index < ordered.length - 1; index += 1) {
    if (readingTransitionViolation(ordered[index], ordered[index + 1], direction)) return true;
  }
  return false;
}

function readingTransitionViolation(current, next, direction) {
  const tolerance = 0.035;
  const currentCenterX = current.x + current.w / 2;
  const nextCenterX = next.x + next.w / 2;
  const currentCenterY = current.y + current.h / 2;
  const nextCenterY = next.y + next.h / 2;
  const verticalOverlap = oneDimensionalOverlap(current.y, current.y + current.h, next.y, next.y + next.h);
  const horizontalOverlap = oneDimensionalOverlap(current.x, current.x + current.w, next.x, next.x + next.w);
  const sameRow = verticalOverlap >= Math.min(current.h, next.h) * 0.42;
  const sameColumn = horizontalOverlap >= Math.min(current.w, next.w) * 0.42;

  if (direction === "rtl" && sameRow && nextCenterX > currentCenterX + tolerance) return true;
  if (direction === "ltr" && sameRow && nextCenterX < currentCenterX - tolerance) return true;
  if (sameColumn && nextCenterY < currentCenterY - tolerance) return true;
  return false;
}

function oneDimensionalOverlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function sortPanelLayout(panels, direction, depth) {
  if (panels.length <= 1) return panels.slice();
  if (depth > 8) return sortPanelFallback(panels, direction);

  const rows = splitPanelBands(panels, "y");
  if (rows.length > 1) {
    return rows.flatMap((row) => sortPanelColumns(row.panels, direction, depth + 1));
  }

  return sortPanelColumns(panels, direction, depth + 1);
}

function sortPanelColumns(panels, direction, depth) {
  const columns = splitPanelBands(panels, "x");
  if (columns.length <= 1) return sortPanelFallback(panels, direction);

  const ordered = direction === "rtl" ? columns.slice().reverse() : columns;
  return ordered.flatMap((column) => sortPanelLayout(column.panels, direction, depth + 1));
}

function splitPanelBands(panels, axis) {
  const startKey = axis;
  const sizeKey = axis === "x" ? "w" : "h";
  const tolerance = 0.012;
  const bands = [];

  panels
    .slice()
    .sort((a, b) => a[startKey] - b[startKey])
    .forEach((panel) => {
      const start = panel[startKey];
      const end = panel[startKey] + panel[sizeKey];
      const band = bands[bands.length - 1];
      if (!band || start >= band.end - tolerance) {
        bands.push({ start, end, panels: [panel] });
        return;
      }

      band.end = Math.max(band.end, end);
      band.panels.push(panel);
    });

  return bands;
}

function sortPanelFallback(panels, direction) {
  return panels
    .slice()
    .sort((a, b) => a.y - b.y || (direction === "rtl" ? b.x - a.x : a.x - b.x));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function renderCurrentPage() {
  const page = state.pages[state.pageIndex];
  if (!page) {
    el.stage.classList.remove("has-image");
    return;
  }

  if (page.stripImages) {
    renderStripPage(page);
    return;
  }

  if (el.stageStrip) {
    el.stageStrip.hidden = true;
    el.stageStrip.replaceChildren();
    el.stageStrip.dataset.signature = "";
  }
  el.stageImage.hidden = false;
  el.stageImage.src = page.renderUrl || page.image?.currentSrc || page.image?.src || page.url;
  el.stageImage.alt = `${el.chapterTitle.textContent}, page ${state.pageIndex + 1}`;
  el.stageImage.onload = () => fitStage();
  el.stageImage.onerror = () => recoverRenderedPageImage(page, state.pageIndex);
  if (el.stageImage.complete) fitStage();
}

async function recoverRenderedPageImage(page, pageIndex) {
  if (!page || page.renderRecoveryPromise) return page?.renderRecoveryPromise;
  const recovery = loadImage(page.url)
    .then((image) => {
      page.image = image;
      page.renderUrl = image.currentSrc || image.src || page.url;
      page.loadAttempts = image.panelPilotLoadAttempts || page.loadAttempts;
      if (state.pages[pageIndex] === page && state.pageIndex === pageIndex) {
        el.stageImage.src = page.renderUrl;
      }
      return image;
    })
    .catch((error) => {
      if (state.pages[pageIndex] === page && state.pageIndex === pageIndex) {
        showReaderError("Could not load this page", friendlySourceErrorMessage(error));
      }
      return null;
    })
    .finally(() => {
      if (page.renderRecoveryPromise === recovery) page.renderRecoveryPromise = null;
    });
  page.renderRecoveryPromise = recovery;
  return recovery;
}

function ensureStageStrip() {
  if (!el.stageStrip) {
    el.stageStrip = document.createElement("div");
    el.stageStrip.className = "stage-strip";
    el.stageImageWrap.append(el.stageStrip);
  }
  return el.stageStrip;
}

function renderStripPage(page, { refit = true } = {}) {
  const strip = ensureStageStrip();
  const signature = page.stripImages.map((item) => `${item.url}:${Math.round(item.height)}`).join("|");
  el.stageImage.hidden = true;
  strip.hidden = false;

  if (strip.dataset.signature !== signature) {
    strip.replaceChildren();
    page.stripImages.forEach((item) => {
      const image = document.createElement("img");
      image.src = item.url;
      image.alt = "";
      image.draggable = false;
      strip.append(image);
    });
    strip.dataset.signature = signature;
  }

  if (refit) {
    requestAnimationFrame(fitStage);
    return;
  }

  const renderedWidth = parseFloat(strip.style.width);
  if (Number.isFinite(renderedWidth) && renderedWidth > 0 && page.naturalWidth > 0) {
    const preservedScale = renderedWidth / page.naturalWidth;
    strip.style.height = `${page.naturalHeight * preservedScale}px`;
  }
}

function fitStage() {
  const page = state.pages[state.pageIndex];
  if (!page?.naturalWidth || !page?.naturalHeight) return;

  const rect = state.fullPage ? fullPagePanel(page.naturalWidth, page.naturalHeight) : currentPanel();
  const stageRect = el.stage.getBoundingClientRect();
  const imageWidth = page.naturalWidth;
  const imageHeight = page.naturalHeight;
  const target = state.fullPage
    ? fullPagePanel(imageWidth, imageHeight)
    : expandPanelRect(rect || fullPagePanel(imageWidth, imageHeight), state.panelPadding / 100);
  const margin = state.fullPage ? 0.94 : 1;
  let scale = Math.min(
    stageRect.width / (imageWidth * target.w),
    stageRect.height / (imageHeight * target.h)
  ) * margin;
  if (state.panelMode === "webtoon" && !state.fullPage) {
    const widthFitScale = stageRect.width / imageWidth;
    scale = Math.max(scale, widthFitScale * 0.5);
  }

  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;
  const centerX = (target.x + target.w / 2) * renderedWidth;
  const centerY = (target.y + target.h / 2) * renderedHeight;
  const left = stageRect.width / 2 - centerX;
  const top = stageRect.height / 2 - centerY;

  const targetElement = page.stripImages ? ensureStageStrip() : el.stageImage;
  targetElement.style.width = `${renderedWidth}px`;
  targetElement.style.height = `${renderedHeight}px`;
  targetElement.style.transform = `translate(${left}px, ${top}px)`;
}

function expandPanelRect(panel, padding) {
  const extraX = panel.w * padding;
  const extraY = panel.h * padding;
  const x0 = clamp(panel.x - extraX, 0, 1);
  const y0 = clamp(panel.y - extraY, 0, 1);
  const x1 = clamp(panel.x + panel.w + extraX, 0, 1);
  const y1 = clamp(panel.y + panel.h + extraY, 0, 1);
  return {
    ...panel,
    x: x0,
    y: y0,
    w: Math.max(0.001, x1 - x0),
    h: Math.max(0.001, y1 - y0),
  };
}

function currentPanel() {
  const page = state.pages[state.pageIndex];
  return page?.panels?.[state.panelIndex] || null;
}

function updatePaddingControl() {
  if (!el.panelPaddingValue) return;
  el.panelPaddingValue.textContent = `${Math.round(state.panelPadding)}%`;
}

function updatePanelModeControls() {
  el.mangaMode?.classList.toggle("active", state.panelMode === "manga");
  el.comicMode?.classList.toggle("active", state.panelMode === "comic");
  el.webtoonMode?.classList.toggle("active", state.panelMode === "webtoon");
  el.mangaMode?.setAttribute("aria-pressed", state.panelMode === "manga" ? "true" : "false");
  el.comicMode?.setAttribute("aria-pressed", state.panelMode === "comic" ? "true" : "false");
  el.webtoonMode?.setAttribute("aria-pressed", state.panelMode === "webtoon" ? "true" : "false");
  if (el.redetect) el.redetect.textContent = "Detect panels";
}

function renderVersionNote() {
  if (!el.versionNote) return;
  el.versionNote.textContent = `${appVersion} | ${appBuildTime} | ${detectorVersion}`;
}

async function setPanelMode(mode) {
  if (!isPanelMode(mode)) return;
  if (state.panelMode === mode) return;

  cancelReaderNavigation();
  state.panelMode = mode;
  updatePanelModeControls();
  saveSettings();
  if (!state.pages.length) return;

  const generation = state.prepareGeneration + 1;
  state.prepareGeneration = generation;
  state.backgroundPreparing = false;

  const loadingLabel =
    mode === "webtoon"
      ? "Detecting webtoon panels..."
      : mode === "comic"
        ? "Detecting comic regions..."
        : "Detecting manga panels...";
  setReaderLoading(true, loadingLabel, 34);
  try {
    if (mode === "webtoon") {
      state.pages = [await prepareContinuousWebtoonChapter(state.chapterPageUrls, generation, { initialCount: 2 })];
      prepareWebtoonChapterInBackground(generation);
    } else {
      state.pages = makeChapterPageEntries(state.chapterPageUrls);
      await preparePage(0, { force: true, generation });
      prepareChapterInBackground(generation);
    }
    state.pageIndex = 0;
    state.panelIndex = 0;
    state.fullPage = false;
    renderCurrentPage();
    updateAfterNavigation();
  } finally {
    setReaderLoading(false);
  }
}

function setPanelPadding(value) {
  const next = clamp(Number(value), 0, 25);
  if (!Number.isFinite(next)) return;
  state.panelPadding = next;
  updatePaddingControl();
  saveSettings();
  if (!state.fullPage) fitStage();
}

function consolidateMangaPanels(panels) {
  const consolidated = mergeDuplicatePanels(panels).map((panel) => ({ ...panel }));
  let changed = true;
  let passes = 0;

  while (changed && passes < 12) {
    changed = false;
    passes += 1;
    for (let index = 0; index < consolidated.length; index += 1) {
      for (let other = index + 1; other < consolidated.length; other += 1) {
        const first = consolidated[index];
        const second = consolidated[other];
        if (!shouldConsolidateMangaPanels(first, second)) continue;
        consolidated[index] = unionPanel(first, second);
        consolidated.splice(other, 1);
        changed = true;
        break;
      }
      if (changed) break;
    }
  }

  return mergeDuplicatePanels(consolidated);
}

function shouldConsolidateMangaPanels(a, b) {
  const overlapX = oneDimensionalOverlap(a.x, a.x + a.w, b.x, b.x + b.w);
  const overlapY = oneDimensionalOverlap(a.y, a.y + a.h, b.y, b.y + b.h);
  const xContainment = overlapX / Math.max(0.000001, Math.min(a.w, b.w));
  const yContainment = overlapY / Math.max(0.000001, Math.min(a.h, b.h));
  const areaA = Math.max(0.000001, a.w * a.h);
  const areaB = Math.max(0.000001, b.w * b.h);
  const intersection = overlapX * overlapY;
  const containment = intersection / Math.min(areaA, areaB);
  const iou = intersection / Math.max(0.000001, areaA + areaB - intersection);
  const areaRatio = Math.min(areaA, areaB) / Math.max(areaA, areaB);

  // Slanted layouts can produce several shifted crops for the same visual band.
  // Keep consolidating aligned overlaps until the reader cannot immediately
  // revisit the same artwork; a broader crop is the safer fallback.
  const repeatedHorizontalBand = xContainment >= 0.94 && yContainment >= 0.28;
  const repeatedVerticalBand = yContainment >= 0.94 && xContainment >= 0.28;
  const nearDuplicate = iou >= 0.68 || (containment >= 0.86 && areaRatio >= 0.42);
  return repeatedHorizontalBand || repeatedVerticalBand || nearDuplicate;
}

function unionPanel(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return {
    ...a,
    x,
    y,
    w: x1 - x,
    h: y1 - y,
    mangaConsolidated: true,
  };
}

function setReaderNavigationPending(pending) {
  state.navigationPending = Boolean(pending);
  el.stage?.setAttribute("aria-busy", state.navigationPending ? "true" : "false");
  if (el.prevPanel) el.prevPanel.disabled = state.navigationPending;
  if (el.nextPanel) el.nextPanel.disabled = state.navigationPending;
}

function cancelReaderNavigation() {
  state.navigationRequestId += 1;
  state.navigationCooldownUntil = 0;
  setReaderNavigationPending(false);
}

function movePanel(delta) {
  if (!state.pages.length) return;
  if (state.navigationPending) return;
  if (performance.now() < state.navigationCooldownUntil) return;
  const page = state.pages[state.pageIndex];
  if (!Array.isArray(page?.panels) || !page.panels.length) {
    page.panels = sanitizePanels(page?.panels, page?.naturalWidth || 1, page?.naturalHeight || 1);
    state.panelIndex = 0;
  }
  const nextPanel = state.panelIndex + delta;

  if (nextPanel >= 0 && nextPanel < page.panels.length) {
    state.panelIndex = nextPanel;
    state.fullPage = false;
    updateAfterNavigation();
    return;
  }

  void moveToAdjacentPage(delta);
}

async function moveToAdjacentPage(delta) {
  if (state.navigationPending || !state.pages.length) return;

  const fromPageIndex = state.pageIndex;
  const nextPage = fromPageIndex + delta;

  if (nextPage < 0) return;
  if (nextPage >= state.pages.length) {
    if (delta > 0 && state.panelMode === "webtoon" && !state.pages[0]?.complete) {
      setConnection(state.connected, "Still preparing the rest of this webtoon chapter.", "");
      return;
    }
    if (delta > 0) {
      const requestId = state.navigationRequestId + 1;
      state.navigationRequestId = requestId;
      setReaderNavigationPending(true);
      setReaderLoading(true, "Loading next chapter...", 24);
      try {
        await finishChapterAndLoadNext();
      } catch (error) {
        setConnection(state.connected, `Could not load the next chapter: ${error.message}`, "bad");
      } finally {
        if (requestId === state.navigationRequestId) {
          setReaderNavigationPending(false);
          setReaderLoading(false);
        }
      }
    }
    return;
  }

  const requestId = state.navigationRequestId + 1;
  state.navigationRequestId = requestId;
  const generation = state.prepareGeneration;
  setReaderNavigationPending(true);
  setReaderLoading(true, `Preparing page ${nextPage + 1}...`, 58);

  try {
    const preparedPage = await preparePage(nextPage, { generation });
    if (!preparedPage) return;
    if (requestId !== state.navigationRequestId || generation !== state.prepareGeneration) return;
    if (state.pageIndex !== fromPageIndex) return;

    const panels = state.pages[nextPage].panels;
    state.pageIndex = nextPage;
    state.panelIndex = delta > 0 ? 0 : Math.max(0, panels.length - 1);
    state.navigationCooldownUntil = performance.now() + 280;
    state.fullPage = false;
    renderCurrentPage();
    updateAfterNavigation();
  } catch (error) {
    setConnection(state.connected, `Could not prepare page: ${error.message}`, "bad");
    showReaderError("Could not prepare this page", friendlySourceErrorMessage(error));
  } finally {
    if (requestId === state.navigationRequestId) {
      setReaderNavigationPending(false);
      setReaderLoading(false);
    }
  }
}

async function loadNextChapter() {
  if (!state.activeChapter) {
    setConnection(state.connected, "No next chapter source is active yet.", "bad");
    return;
  }

  if (state.activeChapter.type === "comick") {
    await loadNextComickChapter();
    return;
  }

  if (state.activeChapter.type === "suwayomi") {
    await loadNextSuwayomiChapter();
  }
}

async function loadNextComickChapter() {
  const current = Number.parseFloat(state.activeChapter.chapter?.chap);
  if (!Number.isFinite(current)) {
    setConnection(state.connected, "Could not infer the current Comick chapter number.", "bad");
    return;
  }

  const nextChapterNumber = String(current + 1).replace(/\.0$/, "");
  const comicUrl = state.activeChapter.comicUrl || el.comickUrl.value.trim();
  setConnection(state.connected, `Loading chapter ${nextChapterNumber}...`, "");
  try {
    const payload = await localJson(
      `/api/comick/chapters?lang=en&chap=${encodeURIComponent(nextChapterNumber)}&url=${encodeURIComponent(comicUrl)}`
    );
    const chapter = chooseComickChapter(payload.chapters || []);
    if (!chapter) {
      setConnection(state.connected, `No Comick chapter ${nextChapterNumber} found.`, "bad");
      return;
    }
    await loadComickChapter(chapter);
  } catch (error) {
    setConnection(state.connected, `Could not auto-load next chapter: ${error.message}`, "bad");
  }
}

async function loadNextSuwayomiChapter() {
  const currentChapterId = Number(state.activeChapter.chapterId);
  const chapter = nextSuwayomiChapterAfter(currentChapterId);
  if (!chapter) {
    setConnection(state.connected, "No next Suwayomi chapter is loaded in the chapter list.", "bad");
    return;
  }

  const prefetch = state.nextChapterPrefetch;
  if (prefetch?.fromChapterId === currentChapterId && prefetch.chapterId === Number(chapter.id)) {
    window.clearTimeout(state.nextChapterPrefetchTimer);
    if (!prefetch.promise) prefetch.promise = prefetchSuwayomiChapter(prefetch).catch(() => null);
    const prepared = await prefetch.promise;
    if (prepared) {
      el.chapterId.value = chapter.id;
      el.chapterTitle.textContent = chapter.name || `Chapter ${chapter.chapterNumber || chapter.sourceOrder || chapter.id}`;
      state.pendingResume = null;
      state.activeChapter = { type: "suwayomi", chapterId: Number(chapter.id), chapter };
      if (isPanelMode(prepared.mode)) {
        state.panelMode = prepared.mode;
        updatePanelModeControls();
      }
      await loadChapter(prepared.pageUrls, el.chapterTitle.textContent, {
        preparedPages: prepared.preparedPages,
        firstImage: prepared.firstImage,
      });
      rememberReadingProgress();
      void ensureDownloadAhead(chapter.id);
      setConnection(true, `Loaded ${prepared.pageUrls.length} pages. The next pages are preparing in the background.`, "good");
      return;
    }
  }

  el.chapterId.value = chapter.id;
  el.chapterTitle.textContent = chapter.name || `Chapter ${chapter.chapterNumber || chapter.sourceOrder || chapter.id}`;
  await loadChapterPages();
}

function updateAfterNavigation() {
  el.toggleFit.textContent = state.fullPage ? "Panel view" : "Full page";
  fitStage();
  renderPanelStrip();
  updateStats();
  rememberReadingProgress();
}

function updateStats() {
  const page = state.pages[state.pageIndex];
  const totalPages = state.pages.length;
  const totalPanels = page?.panels.length || 0;
  const unit = "Panel";
  el.pageStat.textContent = totalPages ? `Page ${state.pageIndex + 1} / ${totalPages}` : "Page 0";
  el.panelStat.textContent = totalPanels ? `${unit} ${state.panelIndex + 1} / ${totalPanels}` : `${unit} 0`;
  const detectedPages = state.pages.filter((item) => item.detected).length;
  const detectedPanels = state.pages.reduce((sum, item) => sum + item.panels.length, 0);
  el.panelCount.textContent = `${detectedPanels} ${unit.toLowerCase()}s on ${detectedPages} pages`;
}

function renderPanelStrip() {
  el.panelStrip.replaceChildren();
  const page = state.pages[state.pageIndex];
  if (!page?.panels.length) return;

  page.panels.forEach((panel, index) => {
    const button = document.createElement("button");
    button.className = `panel-thumb${index === state.panelIndex && !state.fullPage ? " active" : ""}`;
    button.type = "button";
    button.title = `${panel.label || "Panel"}, page ${state.pageIndex + 1}`;
    button.style.aspectRatio = `${Math.max(0.25, panel.w)} / ${Math.max(0.25, panel.h)}`;
    button.addEventListener("click", () => {
      if (state.navigationPending) return;
      state.panelIndex = index;
      state.fullPage = false;
      updateAfterNavigation();
    });

    const badge = document.createElement("span");
    badge.textContent = index + 1;
    const image = document.createElement("img");
    image.alt = "";
    const thumb = page.stripImages ? stripThumbnailForPanel(page, panel) : null;
    image.src = thumb?.url || page.url;
    image.style.objectPosition = thumb
      ? `50% ${thumb.y * 100}%`
      : `${panel.x * 100}% ${panel.y * 100}%`;
    button.append(badge, image);
    el.panelStrip.append(button);
  });

  updateStats();
}

function stripThumbnailForPanel(page, panel) {
  const centerY = (panel.y + panel.h / 2) * page.naturalHeight;
  const segment = page.stripImages.find((item) => centerY >= item.y && centerY <= item.y + item.height);
  if (!segment) return null;
  return {
    url: segment.url,
    y: clamp((centerY - segment.y) / segment.height, 0, 1),
  };
}

async function redetectCurrentPage() {
  if (!state.pages.length) return;
  if (state.panelMode === "webtoon") {
    await redetectChapterPanels();
    return;
  }
  cancelReaderNavigation();
  setBusy(el.redetect, true, "Detecting");
  try {
    await preparePage(state.pageIndex, { force: true });
    state.panelIndex = 0;
    state.fullPage = false;
    updateAfterNavigation();
  } finally {
    setReaderLoading(false);
    setBusy(el.redetect, false);
  }
}

async function redetectChapterPanels() {
  if (!state.chapterPageUrls.length) return;
  cancelReaderNavigation();
  setBusy(el.redetect, true, "Detecting");
  setBusy(el.redetectChapter, true, "Detecting");
  setReaderLoading(true, "Redetecting chapter panels...", 18);

  const generation = state.prepareGeneration + 1;
  state.prepareGeneration = generation;
  state.backgroundPreparing = false;
  state.pageIndex = 0;
  state.panelIndex = 0;
  state.fullPage = false;

  try {
    if (state.panelMode === "webtoon") {
      state.pages = [await prepareContinuousWebtoonChapter(state.chapterPageUrls, generation, { initialCount: 2 })];
      renderCurrentPage();
      updateAfterNavigation();
      prepareWebtoonChapterInBackground(generation);
    } else {
      state.pages = makeChapterPageEntries(state.chapterPageUrls);
      await preparePage(0, { force: true, generation });
      renderCurrentPage();
      updateAfterNavigation();
      prepareChapterInBackground(generation);
    }
    setConnection(state.connected, "Redetected panels for this chapter.", "good");
  } finally {
    setReaderLoading(false);
    setBusy(el.redetect, false);
    setBusy(el.redetectChapter, false);
  }
}

async function reportBadPanels() {
  const page = state.pages[state.pageIndex];
  if (!page) {
    setConnection(state.connected, "Load a page before reporting bad panels.", "bad");
    return;
  }

  setBusy(el.reportBadPanels, true, "Reporting");
  try {
    const payload = {
      appVersion,
      detectorVersion,
      mangaId: Number(state.currentManga?.id) || undefined,
      mangaTitle: state.currentManga?.title || "",
      sourceId: state.currentManga?.sourceId || "",
      sourceLabel: state.currentManga?.sourceLabel || "",
      chapterId: Number(state.activeChapter?.chapterId) || Number(state.activeChapter?.chapter?.id) || undefined,
      chapterTitle: el.chapterTitle.textContent || "",
      activeChapterType: state.activeChapter?.type || "",
      pageIndex: state.pageIndex,
      panelIndex: state.panelIndex,
      panelMode: state.panelMode,
      readingDirection: state.readingDirection,
      pageUrl: page.url || "",
      naturalWidth: page.naturalWidth || 0,
      naturalHeight: page.naturalHeight || 0,
      selectedPanel: currentPanel(),
      panels: page.panels || [],
      snapshotDataUrl: await makePanelReportSnapshot(page).catch(() => ""),
    };
    const response = await postLocalJson("/api/panel-report", payload);
    setConnection(state.connected, `Saved panel report ${response.id}.`, "good");
  } catch (error) {
    setConnection(state.connected, `Could not save panel report: ${error.message}`, "bad");
  } finally {
    setBusy(el.reportBadPanels, false);
  }
}

async function makePanelReportSnapshot(page) {
  const width = page.naturalWidth || page.image?.naturalWidth || page.image?.width || 1;
  const height = page.naturalHeight || page.image?.naturalHeight || page.image?.height || 1;
  const maxWidth = 760;
  const maxHeight = 1600;
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#111";
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (page.stripImages?.length) {
    page.stripImages.forEach((segment, index) => {
      const source = page.sourceImages?.[index]?.image;
      if (!source) return;
      context.drawImage(
        source,
        0,
        Math.round(segment.y * scale),
        Math.round(segment.width * scale),
        Math.round(segment.height * scale)
      );
    });
  } else {
    const image = page.image || await loadImage(page.url);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  }

  drawPanelReportOverlay(context, page, scale);
  return canvas.toDataURL("image/jpeg", 0.82);
}

function drawPanelReportOverlay(context, page, scale) {
  const panels = page.panels || [];
  const selected = state.panelIndex;
  context.font = "bold 18px sans-serif";
  panels.forEach((panel, index) => {
    const selectedPanel = index === selected;
    const x = Math.round(panel.x * page.naturalWidth * scale);
    const y = Math.round(panel.y * page.naturalHeight * scale);
    const w = Math.round(panel.w * page.naturalWidth * scale);
    const h = Math.round(panel.h * page.naturalHeight * scale);
    context.lineWidth = selectedPanel ? 6 : 3;
    context.strokeStyle = selectedPanel ? "#ffd95a" : "#2ee6d6";
    context.strokeRect(x, y, w, h);
    context.fillStyle = selectedPanel ? "#ffd95a" : "#111";
    context.fillRect(x, y, 34, 24);
    context.fillStyle = selectedPanel ? "#111" : "#fff";
    context.fillText(String(index + 1), x + 8, y + 18);
  });
}

async function clearAppCache() {
  setBusy(el.clearAppCache, true, "Clearing");
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    setConnection(state.connected, "App cache cleared. Reloading latest version...", "good");
    const url = new URL(location.href);
    url.searchParams.set("v", String(Date.now()));
    window.setTimeout(() => location.replace(url.toString()), 250);
  } catch (error) {
    setConnection(state.connected, `Could not clear app cache: ${error.message}`, "bad");
  } finally {
    setBusy(el.clearAppCache, false);
  }
}

function setReadingDirection(direction) {
  state.readingDirection = direction;
  el.rtlOrder.classList.toggle("active", direction === "rtl");
  el.ltrOrder.classList.toggle("active", direction === "ltr");
  el.rtlOrder.setAttribute("aria-pressed", direction === "rtl" ? "true" : "false");
  el.ltrOrder.setAttribute("aria-pressed", direction === "ltr" ? "true" : "false");
  const previousGlyph = el.prevPanel?.querySelector("span");
  const nextGlyph = el.nextPanel?.querySelector("span");
  if (previousGlyph) previousGlyph.textContent = "←";
  if (nextGlyph) nextGlyph.textContent = "→";
  saveSettings();
}

async function resortAndDetect(direction) {
  cancelReaderNavigation();
  setReadingDirection(direction);
  const generation = state.prepareGeneration + 1;
  state.prepareGeneration = generation;
  state.backgroundPreparing = false;
  try {
    await Promise.all(
      state.pages.map((_, index) => preparePage(index, { force: true, quiet: index !== state.pageIndex, generation }).catch(() => null))
    );
    state.panelIndex = 0;
    updateAfterNavigation();
  } finally {
    setReaderLoading(false);
  }
}

function toggleFullPage() {
  if (!state.pages.length) return;
  state.fullPage = !state.fullPage;
  updateAfterNavigation();
}

function makeDemoPage(layout) {
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 1500;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fffdf6";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#161616";
  ctx.fillRect(30, 30, 940, 1440);

  const panels = layout === 1
    ? [
        [70, 70, 410, 410],
        [520, 70, 410, 410],
        [70, 530, 860, 350],
        [70, 930, 410, 470],
        [520, 930, 410, 470],
      ]
    : [
        [70, 70, 860, 280],
        [70, 400, 520, 470],
        [630, 400, 300, 470],
        [70, 920, 350, 480],
        [460, 920, 470, 480],
      ];

  panels.forEach((panel, index) => drawDemoPanel(ctx, panel, index));
  return canvas.toDataURL("image/png");
}

function drawDemoPanel(ctx, [x, y, w, h], index) {
  ctx.fillStyle = "#fffdf6";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#171717";
  ctx.lineWidth = 10;
  ctx.strokeRect(x, y, w, h);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 8, y + 8, w - 16, h - 16);
  ctx.clip();

  const horizon = y + h * (0.48 + (index % 2) * 0.12);
  ctx.fillStyle = index % 2 ? "#d8dde0" : "#e9e4d8";
  ctx.fillRect(x + 8, y + 8, w - 16, h - 16);
  ctx.fillStyle = index % 2 ? "#c2c9cb" : "#d9d0bf";
  ctx.fillRect(x + 8, horizon, w - 16, y + h - horizon - 8);

  ctx.strokeStyle = "#2f2f2f";
  ctx.lineWidth = 5;
  for (let i = 0; i < 5; i += 1) {
    const yy = y + 42 + i * 44 + (index % 3) * 9;
    ctx.beginPath();
    ctx.moveTo(x + 28, yy);
    ctx.bezierCurveTo(x + w * 0.3, yy - 26, x + w * 0.68, yy + 24, x + w - 28, yy - 8);
    ctx.stroke();
  }

  ctx.fillStyle = "#111";
  const cx = x + w * (index % 2 ? 0.36 : 0.64);
  const cy = y + h * 0.58;
  ctx.beginPath();
  ctx.ellipse(cx, cy, w * 0.13, h * 0.19, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(cx - w * 0.07, cy + h * 0.14, w * 0.14, h * 0.24);

  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.ellipse(x + w * 0.34, y + h * 0.25, w * 0.22, h * 0.11, -0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = "#111";
  ctx.lineWidth = 4;
  for (let i = 0; i < 3; i += 1) {
    const lineY = y + h * 0.23 + i * 17;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.22, lineY);
    ctx.lineTo(x + w * 0.46, lineY);
    ctx.stroke();
  }

  ctx.restore();
}

async function loadDemo() {
  await loadChapter([makeDemoPage(1), makeDemoPage(2)], "Demo chapter");
  setConnection(state.connected, "Demo chapter loaded. This uses the same local detector as Suwayomi pages.", "good");
}

async function initializeSuwayomi() {
  setConnection(false, "Connecting to Suwayomi…", "");
  const connected = await testConnection();
  if (connected) {
    await loadSources();
    await syncSuwayomiLibrary().catch(() => 0);
    await hydrateLibraryCovers();
  }
}

function handleStageTap(event) {
  if (el.readerOptions?.open) {
    el.readerOptions.open = false;
    el.readerOptions.querySelector("summary")?.focus();
    return;
  }
  const bounds = el.stage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;

  const xRatio = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
  const yRatio = clamp((event.clientY - bounds.top) / bounds.height, 0, 1);

  const action = readerTapAction(xRatio, yRatio);
  if (action === "forward") {
    movePanel(1);
    if (state.readerFocus && state.readerChromeVisible) setReaderChromeVisible(false);
    return;
  }
  if (action === "back") {
    movePanel(-1);
    if (state.readerFocus && state.readerChromeVisible) setReaderChromeVisible(false);
    return;
  }
  toggleReaderChrome();
}

function readerTapAction(xRatio, yRatio) {
  const sideZone = xRatio < 0.34 || xRatio > 0.66;
  if (sideZone) return "forward";
  if (yRatio > 0.72) return "back";
  return "controls";
}

function wireEvents() {
  el.appNavButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.targetView === "reader") {
        openReaderFromNav();
        return;
      }
      setActiveView(button.dataset.targetView);
    });
  });
  el.navReader?.addEventListener("click", openReaderFromNav);
  el.readerBack?.addEventListener("click", leaveReaderView);
  el.readerErrorRetry?.addEventListener("click", loadChapterPages);
  el.readerErrorBack?.addEventListener("click", leaveReaderView);
  el.testConnection.addEventListener("click", testConnection);
  el.loadSources.addEventListener("click", loadSources);
  el.clearAppCache?.addEventListener("click", clearAppCache);
  el.syncProgress?.addEventListener("click", syncLibraryAndProgress);
  el.showNsfwSources?.addEventListener("change", (event) => setShowNsfwSources(event.target.checked));
  el.toggleSuwayomiPanel?.addEventListener("click", toggleSuwayomiSetupPanel);
  el.toggleLibraryPanel?.addEventListener("click", toggleLibraryPanel);
  el.toggleHiddenLibrary?.addEventListener("click", () => setShowHiddenLibrary(!state.showHiddenLibrary));
  el.toggleBrowsePanel?.addEventListener("click", toggleBrowsePanel);
  el.closeMangaDetail?.addEventListener("click", closeMangaDetail);
  el.browseOpenSettings?.addEventListener("click", () => setActiveView("settings"));
  el.serverUrl?.addEventListener("input", updateSuwayomiLink);
  el.searchSource.addEventListener("click", searchSource);
  el.searchQuery?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchSource();
  });
  el.fetchChapters.addEventListener("click", fetchChapters);
  el.scanlatorSelect?.addEventListener("change", (event) => {
    state.scanlatorFilter = event.target.value;
    saveSettings();
    renderChapters();
  });
  el.loadChapterPages.addEventListener("click", loadChapterPages);
  el.loadDemo.addEventListener("click", loadDemo);
  el.loadComickChapters?.addEventListener("click", loadComickChapters);
  el.loadComickLatest?.addEventListener("click", loadComickLatest);
  el.loadComickDefault?.addEventListener("click", loadComickDefault);
  el.loadComickNumber?.addEventListener("click", loadComickNumber);
  el.loadComickMore?.addEventListener("click", loadComickMore);
  el.prevPanel.addEventListener("click", () => movePanel(-1));
  el.nextPanel.addEventListener("click", () => movePanel(1));
  el.panelPadding.addEventListener("input", (event) => setPanelPadding(event.target.value));
  el.toggleFit.addEventListener("click", toggleFullPage);
  el.hideReaderControls?.addEventListener("click", hideReaderControls);
  el.toggleReaderMode?.addEventListener("click", toggleReaderFocus);
  el.redetect.addEventListener("click", redetectCurrentPage);
  el.reportBadPanels?.addEventListener("click", reportBadPanels);
  el.redetectChapter?.addEventListener("click", redetectChapterPanels);
  el.mangaMode?.addEventListener("click", () => setPanelMode("manga"));
  el.comicMode?.addEventListener("click", () => setPanelMode("comic"));
  el.webtoonMode?.addEventListener("click", () => setPanelMode("webtoon"));
  el.rtlOrder.addEventListener("click", () => resortAndDetect("rtl"));
  el.ltrOrder.addEventListener("click", () => resortAndDetect("ltr"));
  window.addEventListener("resize", () => {
    if (state.readerFocus && !isReaderFocusAvailable()) setReaderFocus(false);
    if (state.panelMode === "webtoon" && state.pages.length) {
      state.pages.forEach((page, index) => {
        if (page.stripImages) {
          page.detected = true;
          page.panelMode = state.panelMode;
          return;
        }
        if (page.image) {
          page.panels = makeWebtoonPanels(page.image);
          page.detected = true;
          page.panelMode = state.panelMode;
        }
        if (index === state.pageIndex) {
          state.panelIndex = Math.min(state.panelIndex, Math.max(0, page.panels.length - 1));
        }
      });
      renderPanelStrip();
      updateStats();
    }
    fitStage();
  });

  el.stage.addEventListener("click", handleStageTap);

  el.readerOptions?.addEventListener("toggle", () => {
    if (!el.readerOptions.open) return;
    requestAnimationFrame(() => {
      el.readerOptions.querySelector(".reader-options-sheet input, .reader-options-sheet button")?.focus();
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && el.readerOptions?.open) {
      el.readerOptions.open = false;
      el.readerOptions.querySelector("summary")?.focus();
      return;
    }
    if (event.key === "Tab" && el.readerOptions?.open) {
      const focusable = [...el.readerOptions.querySelectorAll(".reader-options-sheet input, .reader-options-sheet button")]
        .filter((item) => !item.disabled && item.getClientRects().length);
      if (focusable.length) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    if (isTextEntryTarget(event.target)) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      movePanel(1);
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      movePanel(-1);
    }
    if (event.key === " ") {
      event.preventDefault();
      movePanel(1);
    }
    if (event.key.toLowerCase() === "f") toggleFullPage();
  });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

window.PanelPilot = {
  detectorVersion,
  consolidateMangaPanels,
  detectPanels,
  fullPagePanel,
  loadImage,
  readerTapAction,
  sortPanels,
};

if (el.stage) {
  renderVersionNote();
  loadSettings();
  loadLibraryItems();
  wireEvents();
  setActiveView(state.activeView);
  setTimeout(() => {
    initializeSuwayomi().catch((error) => {
      setConnection(false, `Could not initialize Suwayomi: ${error.message}`, "bad");
    });
  }, 250);
}
