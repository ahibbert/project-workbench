import {
  deviceChapterKey,
  deviceChapterPageUrls,
  deviceChapterStoredBytes,
  downloadDeviceChapter,
  getDeviceChapterStorageSnapshot,
  initializeDeviceChapters,
  listDeviceChapters,
  listDeviceChaptersForManga,
  removeDeviceChapter,
  removeDeviceChapters,
  requestDeviceChapterPersistence,
} from "./device-chapters.js";

const storeKey = "panel-pilot-settings";
const panelModeStoreKey = "panel-pilot-panel-mode";
const libraryStoreKey = "panel-pilot-library";
const sourceIndexStoreKey = "panel-pilot-source-index";
const sourceIndexTtlMs = 24 * 60 * 60 * 1000;
const sourceIndexPageLimit = 6;
const sourceIndexRequestTimeoutMs = 12000;
const packageAppVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
const appVersion = packageAppVersion ? `v${packageAppVersion}` : "source";
const buildId = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "source";
const detectorVersion = "detector v18-ml-manga";
const pageImageRetryDelaysMs = [0, 350];
const chapterFetchRetryDelaysMs = [0, 400];
const readerLoadingGraceMs = 180;
const nextChapterPreparedPageCount = 3;
const webtoonLiveImageCap = 8;
const downloadAheadChapterCount = 10;
const progressOutboxStoreKey = "panel-pilot-progress-outbox";
const mangabakaOutboxStoreKey = "panel-pilot-mangabaka-outbox";
const tapHintStoreKey = "panel-pilot-tap-hint-seen";
const reconnectIntervalMs = 45 * 1000;
const downloadStatusPollMs = 15 * 1000;
const allSourcesValue = "__all__";
const libraryStatuses = ["reading", "plan_to_read", "paused", "completed", "dropped", "rereading", "considering"];
const libraryFilterValues = ["reading", "plan_to_read", "paused", "completed", "other", "all"];
const libraryStatusLabels = {
  reading: "Reading",
  plan_to_read: "Plan to read",
  paused: "Paused",
  completed: "Completed",
  dropped: "Dropped",
  rereading: "Rereading",
  considering: "Considering",
};
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
  downloadStatusButton: document.querySelector("#download-status-button"),
  downloadStatusLabel: document.querySelector("#download-status-label"),
  downloadStatusCount: document.querySelector("#download-status-count"),
  downloadStatusSheet: document.querySelector("#download-status-sheet"),
  downloadStatusBackdrop: document.querySelector("#download-status-backdrop"),
  downloadStatusClose: document.querySelector("#download-status-close"),
  downloadStatusTitle: document.querySelector("#download-status-title"),
  downloadStatusSummary: document.querySelector("#download-status-summary"),
  downloadProgressTrack: document.querySelector("#download-progress-track"),
  downloadProgressBar: document.querySelector("#download-progress-bar"),
  downloadStatDownloaded: document.querySelector("#download-stat-downloaded"),
  downloadStatQueued: document.querySelector("#download-stat-queued"),
  downloadStatRetrying: document.querySelector("#download-stat-retrying"),
  downloadStatFailed: document.querySelector("#download-stat-failed"),
  downloadChapterList: document.querySelector("#download-chapter-list"),
  downloadStatusIssue: document.querySelector("#download-status-issue"),
  downloadStatusRetry: document.querySelector("#download-status-retry"),
  readerBack: document.querySelector("#reader-back"),
  readerView: document.querySelector("#reader-view"),
  stageImage: document.querySelector("#stage-image"),
  stageImageWrap: document.querySelector("#stage-image-wrap"),
  readerLoading: document.querySelector("#reader-loading"),
  readerLoadingBar: document.querySelector("#reader-loading-bar"),
  readerLoadingText: document.querySelector("#reader-loading-text"),
  readerLoadingCancel: document.querySelector("#reader-loading-cancel"),
  readerError: document.querySelector("#reader-error"),
  readerErrorTitle: document.querySelector("#reader-error-title"),
  readerErrorMessage: document.querySelector("#reader-error-message"),
  readerErrorRetry: document.querySelector("#reader-error-retry"),
  readerErrorBack: document.querySelector("#reader-error-back"),
  readerComplete: document.querySelector("#reader-complete"),
  readerCompleteTitle: document.querySelector("#reader-complete-title"),
  readerCompleteMessage: document.querySelector("#reader-complete-message"),
  readerCompleteNext: document.querySelector("#reader-complete-next"),
  readerCompleteRefresh: document.querySelector("#reader-complete-refresh"),
  readerCompleteChapters: document.querySelector("#reader-complete-chapters"),
  readerCompleteLibrary: document.querySelector("#reader-complete-library"),
  readerTapHint: document.querySelector("#reader-tap-hint"),
  readerTapHintClose: document.querySelector("#reader-tap-hint-close"),
  chapterTitle: document.querySelector("#chapter-title"),
  pageStat: document.querySelector("#page-stat"),
  panelStat: document.querySelector("#panel-stat"),
  panelCount: document.querySelector("#panel-count"),
  panelStrip: document.querySelector("#panel-strip"),
  prevPanel: document.querySelector("#prev-panel"),
  nextPanel: document.querySelector("#next-panel"),
  keepScreenAwake: document.querySelector("#keep-screen-awake"),
  wakeLockStatus: document.querySelector("#wake-lock-status"),
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
  motionSmooth: document.querySelector("#motion-smooth"),
  motionQuick: document.querySelector("#motion-quick"),
  motionInstant: document.querySelector("#motion-instant"),
  serverUrl: document.querySelector("#server-url"),
  testConnection: document.querySelector("#test-connection"),
  loadSources: document.querySelector("#load-sources"),
  loadDemo: document.querySelector("#load-demo"),
  finishSuwayomiSetup: document.querySelector("#finish-suwayomi-setup"),
  setupStepUrl: document.querySelector("#setup-step-url"),
  setupStepConnection: document.querySelector("#setup-step-connection"),
  setupStepSources: document.querySelector("#setup-step-sources"),
  setupStepBrowse: document.querySelector("#setup-step-browse"),
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
  libraryFilters: [...document.querySelectorAll("[data-library-filter]")],
  libraryFilterCounts: [...document.querySelectorAll("[data-library-count]")],
  toggleBrowsePanel: document.querySelector("#toggle-browse-panel"),
  browseBody: document.querySelector("#browse-body"),
  browseView: document.querySelector("#browse-view"),
  browsePrompt: document.querySelector("#browse-prompt"),
  browseOpenSettings: document.querySelector("#browse-open-settings"),
  sourceSelect: document.querySelector("#source-select"),
  sourceCount: document.querySelector("#source-count"),
  searchQuery: document.querySelector("#search-query"),
  searchSource: document.querySelector("#search-source"),
  mangaResults: document.querySelector("#manga-results"),
  mangabakaRecommendations: document.querySelector("#mangabaka-recommendations"),
  mangabakaResults: document.querySelector("#mangabaka-results"),
  mangabakaRecommendationsNote: document.querySelector("#mangabaka-recommendations-note"),
  refreshMangabaka: document.querySelector("#refresh-mangabaka"),
  recommendationContext: document.querySelector("#recommendation-context"),
  recommendationContextTitle: document.querySelector("#recommendation-context-title"),
  recommendationContextNote: document.querySelector("#recommendation-context-note"),
  clearRecommendationContext: document.querySelector("#clear-recommendation-context"),
  mangaDetail: document.querySelector("#manga-detail"),
  closeMangaDetail: document.querySelector("#close-manga-detail"),
  detailCover: document.querySelector("#detail-cover"),
  detailCoverFallback: document.querySelector("#detail-cover-fallback"),
  detailCoverImage: document.querySelector("#detail-cover-image"),
  detailSource: document.querySelector("#detail-source"),
  detailTitle: document.querySelector("#detail-title"),
  detailPrimary: document.querySelector("#detail-primary"),
  detailLibrary: document.querySelector("#detail-library"),
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
  retryDownloads: document.querySelector("#retry-downloads"),
  mangabakaToken: document.querySelector("#mangabaka-token"),
  saveMangabaka: document.querySelector("#save-mangabaka"),
  disconnectMangabaka: document.querySelector("#disconnect-mangabaka"),
  mangabakaState: document.querySelector("#mangabaka-state"),
  mangabakaNote: document.querySelector("#mangabaka-note"),
  syncState: document.querySelector("#sync-state"),
  syncNote: document.querySelector("#sync-note"),
  offlineNote: document.querySelector("#offline-note"),
  appToast: document.querySelector("#app-toast"),
  appUpdate: document.querySelector("#app-update"),
  appInstallState: document.querySelector("#app-install-state"),
  appInstallNote: document.querySelector("#app-install-note"),
  installApp: document.querySelector("#install-app"),
  iosInstallSteps: document.querySelector("#ios-install-steps"),
  appUpdateNote: document.querySelector("#app-update-note"),
  checkAppUpdate: document.querySelector("#check-app-update"),
  applyAppUpdate: document.querySelector("#apply-app-update"),
  deviceStoragePanel: document.querySelector("#device-storage-panel"),
  deviceStorageState: document.querySelector("#device-storage-state"),
  deviceStorageSummary: document.querySelector("#device-storage-summary"),
  deviceStorageProgress: document.querySelector("#device-storage-progress"),
  deviceStorageOriginNote: document.querySelector("#device-storage-origin-note"),
  deviceStorageRetentionNote: document.querySelector("#device-storage-retention-note"),
  deviceStoragePersist: document.querySelector("#device-storage-persist"),
  deviceStorageRefresh: document.querySelector("#device-storage-refresh"),
  deviceStorageManager: document.querySelector("#device-storage-manager"),
  deviceStorageSelectAll: document.querySelector("#device-storage-select-all"),
  deviceStorageSelectedCount: document.querySelector("#device-storage-selected-count"),
  deviceStorageList: document.querySelector("#device-storage-list"),
  deviceStorageRemoveSelected: document.querySelector("#device-storage-remove-selected"),
  deviceStorageResult: document.querySelector("#device-storage-result"),
  deviceStorageDialog: document.querySelector("#device-storage-dialog"),
  deviceStorageDialogDescription: document.querySelector("#device-storage-dialog-description"),
  deviceStorageCancel: document.querySelector("#device-storage-cancel"),
  deviceStorageConfirm: document.querySelector("#device-storage-confirm"),
  networkStatusBanner: document.querySelector("#network-status-banner"),
  networkStatusTitle: document.querySelector("#network-status-title"),
  networkStatusNote: document.querySelector("#network-status-note"),
  retryNetwork: document.querySelector("#retry-network"),
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

const readerIsolationPrevious = new Map();

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
  librarySavePromise: null,
  librarySavePending: false,
  pendingResume: null,
  readerErrorRetryAction: null,
  readerLoadingCancelAction: null,
  readerLoadRequestId: 0,
  readerLoadController: null,
  libraryFilter: "reading",
  chapterPageUrls: [],
  pages: [],
  pageIndex: 0,
  panelIndex: 0,
  fullPage: false,
  panelMode: "manga",
  panelPadding: 8,
  readingDirection: "rtl",
  readerMotion: "smooth",
  connected: false,
  comickChapters: [],
  comickPage: 0,
  comickHasMore: false,
  activeChapter: null,
  prepareGeneration: 0,
  backgroundPreparing: false,
  backgroundPreparationId: 0,
  backgroundPreparationTimer: 0,
  nextChapterPrefetch: null,
  nextChapterPrefetchTimer: null,
  mangaModelAvailable: null,
  navigationPending: false,
  navigationRequestId: 0,
  navigationController: null,
  navigationCooldownUntil: 0,
  panelMoveQueue: [],
  panelMoveQueueRunning: false,
  cameraFitFrame: 0,
  viewportFitTimer: 0,
  keepScreenAwake: true,
  wakeLockSentinel: null,
  wakeLockRequest: null,
  wakeLockEpoch: 0,
  wakeLockBlocked: false,
  readerVisibleController: null,
  readerVisibilityEpoch: 0,
  backgroundWorkController: null,
  backgroundPreparationPromise: null,
  readerResumePromise: null,
  readerLifecyclePaused: false,
  renderValidationPromise: null,
  progressPersistTimer: 0,
  progressPersistIdleCallback: 0,
  pagePreparationDurations: [],
  performanceStats: {
    cameraFits: 0,
    transformWrites: 0,
    panelStripRebuilds: 0,
    queuedPanelMoves: 0,
    maxPanelMoveQueue: 0,
    lastPreparationMs: 0,
    detectorRuns: 0,
  },
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
  suwayomiProgressOutbox: [],
  reconnectTimer: null,
  downloadStatusTimer: null,
  downloadStatus: null,
  downloadStatusSheetOpen: false,
  libraryOfflineWindows: new Map(),
  libraryOfflineReadiness: new Map(),
  deviceChapters: new Map(),
  deviceChaptersReady: false,
  deviceChapterError: "",
  deviceDownloadControllers: new Map(),
  deviceChapterWorkerChecked: false,
  deviceChapterWorkerReady: false,
  deviceChapterWorkerController: null,
  deviceChapterWorkerGeneration: 0,
  deviceStorageSnapshot: null,
  deviceStorageError: "",
  deviceStorageRefreshPromise: null,
  deviceStorageRefreshRequested: false,
  deviceStorageRefreshAnnounce: false,
  deviceStorageReconcileRequested: false,
  deviceStorageSelection: new Set(),
  deviceStoragePendingRemoval: [],
  deviceStorageReturnFocus: null,
  deviceStorageRemoving: false,
  historyApplying: false,
  viewScrollPositions: { library: 0, browse: 0, settings: 0 },
  browseDiscoveryScroll: 0,
  mangaDetailOrigin: "browse",
  mangabakaRecommendations: [],
  mangabakaConnected: false,
  mangabakaConfigured: false,
  mangabakaOutbox: [],
  mangabakaAccountKey: "",
  mangabakaOutboxRevision: 0,
  mangabakaSyncPromise: null,
  mangabakaSyncTimer: null,
  pendingMangaBakaRecommendation: null,
  setupReturnToBrowse: false,
  cameraPageChanged: false,
  readerModalReturnFocus: null,
  readerModalReturnFocusSelector: "",
  initialRoute: null,
};

let networkReconnectPromise = null;
let suwayomiRecoveryPromise = null;
let networkStatusHideTimer = 0;

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
    if (["smooth", "quick", "instant"].includes(saved.readerMotion)) state.readerMotion = saved.readerMotion;
    if (libraryFilterValues.includes(saved.libraryFilter)) state.libraryFilter = saved.libraryFilter;
    if (Number.isFinite(saved.panelPadding)) state.panelPadding = clamp(saved.panelPadding, 0, 25);
    if (typeof saved.keepScreenAwake === "boolean") state.keepScreenAwake = saved.keepScreenAwake;
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
  if (el.keepScreenAwake) el.keepScreenAwake.checked = state.keepScreenAwake;
  updatePaddingControl();
  updatePanelModeControls();
  applyReaderMotion();
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
      readerMotion: state.readerMotion,
      libraryFilter: state.libraryFilter,
      panelPadding: state.panelPadding,
      keepScreenAwake: state.keepScreenAwake,
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

function navigationHash(view, detail = false) {
  if (view === "browse" && detail && state.currentManga) {
    const params = new URLSearchParams({
      mangaId: String(state.currentManga.id || ""),
      sourceId: String(state.currentManga.sourceId || ""),
      title: String(state.currentManga.title || ""),
      source: String(state.currentManga.sourceLabel || ""),
      origin: String(state.mangaDetailOrigin || "browse"),
    });
    return `#browse-detail?${params}`;
  }
  return `#${view}`;
}

function routeFromLocation() {
  const raw = location.hash.replace(/^#/, "");
  const [route = "", query = ""] = raw.split("?", 2);
  if (route === "browse-detail") {
    const params = new URLSearchParams(query);
    const mangaId = Number(params.get("mangaId"));
    return {
      view: "browse",
      detail: Number.isInteger(mangaId) && mangaId > 0,
      manga: Number.isInteger(mangaId) && mangaId > 0 ? {
        id: mangaId,
        title: params.get("title") || `Manga ${mangaId}`,
        sourceId: params.get("sourceId") || "",
        sourceLabel: params.get("source") || "Suwayomi source",
      } : null,
      origin: params.get("origin") === "library" ? "library" : "browse",
    };
  }
  return { view: isAppView(route) ? route : null, detail: false, manga: null, origin: "browse" };
}

function applyReaderMotion() {
  const durations = { smooth: "220ms", quick: "120ms", instant: "0ms" };
  const motion = durations[state.readerMotion] ? state.readerMotion : "smooth";
  state.readerMotion = motion;
  document.documentElement.style.setProperty("--reader-motion-duration", durations[motion]);
  [[el.motionSmooth, "smooth"], [el.motionQuick, "quick"], [el.motionInstant, "instant"]].forEach(([button, value]) => {
    button?.classList.toggle("active", motion === value);
    button?.setAttribute("aria-pressed", motion === value ? "true" : "false");
  });
}

function readerMotionDurationMs() {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return 0;
  return state.readerMotion === "instant" ? 0 : state.readerMotion === "quick" ? 120 : 220;
}

function setReaderMotion(motion) {
  if (!["smooth", "quick", "instant"].includes(motion)) return;
  state.readerMotion = motion;
  applyReaderMotion();
  saveSettings();
}

function recordNavigationState(mode = "push", detail = false) {
  if (state.historyApplying || !window.history?.[`${mode}State`]) return;
  window.history[`${mode}State`]({
    panelPilot: true,
    view: state.activeView,
    detail,
    manga: detail ? state.currentManga : null,
    origin: detail ? state.mangaDetailOrigin : null,
  }, "", navigationHash(state.activeView, detail));
}

function setActiveView(view, options = {}) {
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
  updateSuwayomiSetupState();
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
  if (view === "reader") setDownloadStatusSheet(false);
  if (view === "settings") void refreshDeviceStorage();

  if (view === "reader") {
    setReaderFocus(isReaderFocusAvailable());
    void resumeReaderLifecycle();
  } else {
    setReaderFocus(false);
    pauseReaderBackgroundWork();
    trimReaderMemory({ aggressive: true });
    void releaseReaderWakeLock();
  }
  requestAnimationFrame(() => {
    if (view !== "reader") window.scrollTo({ top: state.viewScrollPositions[view] || 0 });
    scheduleCameraFit();
    if (view !== "reader") restoreReaderModalFocus();
  });
  saveSettings();
  if (options.history !== false) {
    recordNavigationState(previous === view ? "replace" : "push", false);
  }
}

function leaveReaderView() {
  abortActiveReaderLoad();
  cancelReaderNavigation();
  closeReaderOverlaysForExit();
  if (!state.historyApplying && window.history.state?.panelPilot && window.history.state.view === "reader") {
    window.history.back();
    return;
  }
  setActiveView(state.previousView && state.previousView !== "reader" ? state.previousView : "library");
}

function abortActiveReaderLoad() {
  if (!state.readerLoadController) return false;
  state.readerLoadRequestId += 1;
  state.readerLoadController.abort();
  state.readerLoadController = null;
  state.prepareGeneration += 1;
  setReaderLoading(false);
  setBusy(el.loadChapterPages, false);
  return true;
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
  updateSuwayomiSetupState();
}

function updateSuwayomiSetupState() {
  const hasUrl = Boolean((el.serverUrl?.value || state.baseUrl || "").trim());
  const hasSources = state.connected && state.visibleSources.length > 0;
  setSetupStepComplete(el.setupStepUrl, hasUrl, 1);
  setSetupStepComplete(el.setupStepConnection, state.connected, 2);
  setSetupStepComplete(el.setupStepSources, hasSources, 3);
  setSetupStepComplete(el.setupStepBrowse, hasSources && state.activeView === "browse", 4);
  if (el.loadSources) el.loadSources.disabled = !state.connected;
  if (el.syncProgress) el.syncProgress.disabled = !state.connected;
  if (el.retryDownloads) el.retryDownloads.disabled = !state.connected;
  if (el.finishSuwayomiSetup) el.finishSuwayomiSetup.hidden = !hasSources;
  if (!state.connected) {
    if (el.offlineNote) el.offlineNote.textContent = "Chapter buffering starts after Suwayomi is connected.";
    if (el.retryDownloads) el.retryDownloads.hidden = true;
    renderDownloadStatus(null);
  }
}

function setSetupStepComplete(step, complete, number) {
  if (!step) return;
  step.classList.toggle("complete", complete);
  const marker = step.querySelector("span");
  if (marker) marker.textContent = complete ? "✓" : String(number);
}

function openSuwayomiSetup({ recommendation = null } = {}) {
  if (recommendation) {
    state.pendingMangaBakaRecommendation = recommendation;
    state.setupReturnToBrowse = true;
    updateRecommendationContext();
  }
  state.suwayomiSetupOpen = true;
  updateSuwayomiSetupPanel();
  setActiveView("settings");
  requestAnimationFrame(() => el.serverUrl?.focus({ preventScroll: true }));
}

async function finishSuwayomiSetup() {
  if (!state.connected || !state.visibleSources.length) {
    showToast("Test the connection and load a source first.", "bad");
    return;
  }
  state.setupReturnToBrowse = false;
  setActiveView("browse");
  updateSuwayomiSetupState();
  if (state.pendingMangaBakaRecommendation) {
    await continuePendingRecommendationSearch();
  } else {
    requestAnimationFrame(() => el.searchQuery?.focus({ preventScroll: true }));
  }
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
  const connectionChanged = state.connected !== connected;
  state.connected = connected;
  el.connectionDot.classList.toggle("connected", connected);
  el.connectionNote.textContent = message;
  el.connectionNote.className = `note ${tone}`;
  updateSuwayomiSetupState();
  updateBrowseAvailability();
  if (connectionChanged) renderMangaBakaRecommendations();
  if (!connected) {
    const checking = /connecting|checking/i.test(message);
    setSyncStatus(
      checking ? "Checking" : "Not connected",
      checking ? "Checking the Suwayomi connection…" : "Test the Suwayomi connection before syncing progress.",
      checking ? "" : "bad"
    );
  } else {
    setSyncStatus("Ready", "Suwayomi is connected and ready to sync.", "good");
  }
}

function hideNetworkStatus() {
  window.clearTimeout(networkStatusHideTimer);
  networkStatusHideTimer = 0;
  if (el.networkStatusBanner) el.networkStatusBanner.hidden = true;
  document.body.classList.remove("has-network-status");
}

function setNetworkStatus(status, title, note, { retry = false, hideAfterMs = 0 } = {}) {
  if (!el.networkStatusBanner) return;
  window.clearTimeout(networkStatusHideTimer);
  networkStatusHideTimer = 0;
  el.networkStatusBanner.dataset.state = status;
  el.networkStatusTitle.textContent = title;
  el.networkStatusNote.textContent = note;
  el.retryNetwork.hidden = !retry;
  el.retryNetwork.disabled = status === "reconnecting";
  el.networkStatusBanner.hidden = false;
  document.body.classList.add("has-network-status");
  if (hideAfterMs > 0) {
    networkStatusHideTimer = window.setTimeout(hideNetworkStatus, hideAfterMs);
  }
}

function showOfflineNetworkStatus() {
  setNetworkStatus(
    "offline",
    "You’re offline",
    "The app shell and local library are available. Browsing, sync, and new chapter loads will resume after reconnection.",
    { retry: true }
  );
}

function readerIsVisible() {
  return !state.readerLifecyclePaused && document.visibilityState !== "hidden";
}

function wakeLockShouldBeActive() {
  return state.keepScreenAwake && readerIsVisible() && state.activeView === "reader" && state.pages.length > 0;
}

function renderWakeLockState(message = "") {
  if (el.keepScreenAwake) el.keepScreenAwake.checked = state.keepScreenAwake;
  if (!el.wakeLockStatus) return;
  if (message) {
    el.wakeLockStatus.textContent = message;
  } else if (!state.keepScreenAwake) {
    el.wakeLockStatus.textContent = "Screen wake lock is off.";
  } else if (!("wakeLock" in navigator)) {
    el.wakeLockStatus.textContent = "Screen wake lock is unavailable in this browser.";
  } else if (state.wakeLockSentinel) {
    el.wakeLockStatus.textContent = "Screen will stay awake while reading.";
  } else if (state.wakeLockBlocked) {
    el.wakeLockStatus.textContent = "Screen wake lock was released by the device. It will retry when reading resumes.";
  } else {
    el.wakeLockStatus.textContent = "Screen wake lock is ready while reading.";
  }
}

async function releaseReaderWakeLock() {
  const sentinel = state.wakeLockSentinel;
  state.wakeLockEpoch += 1;
  state.wakeLockSentinel = null;
  state.wakeLockRequest = null;
  if (sentinel && !sentinel.released) {
    try {
      await sentinel.release();
    } catch {
      // The platform may already have released it during page suspension.
    }
  }
  renderWakeLockState();
}

async function syncReaderWakeLock({ userInitiated = false } = {}) {
  if (!wakeLockShouldBeActive()) {
    await releaseReaderWakeLock();
    return null;
  }
  if (userInitiated) state.wakeLockBlocked = false;
  if (state.wakeLockSentinel && !state.wakeLockSentinel.released) return state.wakeLockSentinel;
  if (state.wakeLockRequest) return state.wakeLockRequest;
  if (!navigator.wakeLock?.request || state.wakeLockBlocked) {
    renderWakeLockState();
    return null;
  }

  const epoch = state.wakeLockEpoch + 1;
  state.wakeLockEpoch = epoch;
  const request = navigator.wakeLock.request("screen")
    .then((sentinel) => {
      if (epoch !== state.wakeLockEpoch || !wakeLockShouldBeActive()) {
        void sentinel.release().catch(() => null);
        return null;
      }
      state.wakeLockSentinel = sentinel;
      sentinel.addEventListener("release", () => {
        if (state.wakeLockSentinel !== sentinel) return;
        state.wakeLockSentinel = null;
        if (wakeLockShouldBeActive()) state.wakeLockBlocked = true;
        renderWakeLockState();
      }, { once: true });
      renderWakeLockState();
      return sentinel;
    })
    .catch((error) => {
      if (epoch === state.wakeLockEpoch) state.wakeLockBlocked = true;
      renderWakeLockState(`Screen wake lock could not start: ${friendlySourceErrorMessage(error)}`);
      return null;
    })
    .finally(() => {
      if (state.wakeLockRequest === request) state.wakeLockRequest = null;
    });
  state.wakeLockRequest = request;
  return request;
}

function setKeepScreenAwake(enabled) {
  state.keepScreenAwake = Boolean(enabled);
  state.wakeLockBlocked = false;
  saveSettings();
  renderWakeLockState();
  void syncReaderWakeLock({ userInitiated: true });
}

function showReconnectingNetworkStatus() {
  setNetworkStatus(
    "reconnecting",
    "Back online",
    "Reconnecting to Suwayomi and sending queued progress…"
  );
}

function showRestoredNetworkStatus() {
  setNetworkStatus(
    "restored",
    "Connection restored",
    "Panels is connected and queued progress can sync again.",
    { hideAfterMs: 3500 }
  );
}

function showServerUnavailableStatus() {
  setNetworkStatus(
    "server-unavailable",
    "Network available · Suwayomi unavailable",
    "The app is online, but the configured Suwayomi server did not respond.",
    { retry: true }
  );
}

function handleBrowserOffline() {
  showOfflineNetworkStatus();
  setConnection(false, "Device offline. Suwayomi will reconnect when the network returns.", "bad");
}

async function reconnectPanelPilot() {
  if (!navigator.onLine) {
    handleBrowserOffline();
    return false;
  }
  if (networkReconnectPromise) return networkReconnectPromise;

  showReconnectingNetworkStatus();
  networkReconnectPromise = (async () => {
    const appRecovery = Promise.allSettled([
      loadLibraryItems(),
      state.librarySavePending ? flushLibraryItems() : Promise.resolve(),
      refreshMangaBakaStatus(),
      loadMangaBakaRecommendations(),
      flushMangaBakaOutbox(),
    ]);
    const connected = await recoverSuwayomiConnection();
    await appRecovery;
    if (!navigator.onLine) {
      handleBrowserOffline();
      return false;
    }
    if (!connected) {
      showServerUnavailableStatus();
      return false;
    }
    showRestoredNetworkStatus();
    return true;
  })().finally(() => {
    networkReconnectPromise = null;
  });
  return networkReconnectPromise;
}

function updateBrowseAvailability() {
  const usableSourceCount = state.connected ? state.visibleSources.length : 0;
  if (el.sourceCount) {
    el.sourceCount.textContent = state.connected
      ? `${usableSourceCount} source${usableSourceCount === 1 ? "" : "s"} available`
      : "Suwayomi setup required";
  }
  if (el.sourceSelect) el.sourceSelect.disabled = !usableSourceCount;
  if (el.searchSource) el.searchSource.disabled = !usableSourceCount;
  if (el.browseOpenSettings) el.browseOpenSettings.hidden = usableSourceCount > 0;
}

async function graphQL(query, variables = {}, options = {}) {
  const baseUrl = options.baseUrl
    ? String(options.baseUrl).trim().replace(/\/+$/, "")
    : cleanBaseUrl();
  const controller = (options.timeoutMs || options.signal) ? new AbortController() : null;
  const cancelFromExternalSignal = () => controller?.abort();
  if (options.signal?.aborted) controller?.abort();
  else options.signal?.addEventListener("abort", cancelFromExternalSignal, { once: true });
  const timeout = controller && options.timeoutMs
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
      throw new Error(payload?.error || `GraphQL request failed with HTTP ${response.status}`);
    }
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((item) => item.message).join(" / "));
    }
    return payload.data;
  } catch (error) {
    if (error?.name === "AbortError" && options.signal?.aborted) {
      const cancelled = new Error("Reader request cancelled");
      cancelled.name = "ReaderLoadCancelled";
      throw cancelled;
    }
    if (error?.name === "AbortError") throw new Error("GraphQL request timed out");
    throw error;
  } finally {
    if (timeout) window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancelFromExternalSignal);
  }
}

function friendlySourceErrorMessage(error) {
  const message = error?.message || "Unknown error";
  if (/urlopen error|winerror\s*10061|connection refused|actively refused|failed to fetch/i.test(message)) {
    return "The reading server is unavailable right now. Check the connection and try again.";
  }
  if (/api rate limit exceeded|rate limit|mangahub\.io/i.test(message)) {
    return "This source has temporarily rate-limited chapter pages. Try again later or switch this title to another source.";
  }
  if (
    /cloudflare|403|502|unexpected json token|json input:\s*<|had '<'|<html|graphQL request failed with HTTP 200/i.test(message)
  ) {
    return "Source not responding, try again in a few minutes.";
  }
  if (/could not load image|timed out loading image|\/api\/suwayomi\/asset|https?:\/\//i.test(message)) {
    return "This page could not be loaded from the source. Your reading position is safe; try again shortly.";
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

function mangaBakaTitles(series) {
  return (Array.isArray(series?.titles) ? series.titles : [])
    .map((entry) => typeof entry === "string" ? entry : entry?.title)
    .filter(Boolean);
}

function mangaBakaTitle(series) {
  const titles = Array.isArray(series?.titles) ? series.titles : [];
  const english = titles.find((entry) => entry?.language === "en" && entry?.is_primary)
    || titles.find((entry) => entry?.language === "en")
    || titles.find((entry) => entry?.is_primary);
  return english?.title || mangaBakaTitles(series)[0] || series?.title || "Untitled manga";
}

function mangaBakaImageUrl(candidate) {
  if (typeof candidate === "string") return candidate.trim();
  if (!candidate || typeof candidate !== "object") return "";
  for (const key of ["x1", "x2", "x3", "url", "src"]) {
    const url = mangaBakaImageUrl(candidate[key]);
    if (url) return url;
  }
  return "";
}

function mangaBakaCover(series) {
  for (const cover of [series?.cover_image, series?.cover]) {
    for (const candidate of [cover?.x250, cover?.x350, cover?.x150, cover?.raw, cover]) {
      const url = mangaBakaImageUrl(candidate);
      if (url) return url;
    }
  }
  return mangaBakaImageUrl(series?.cover_url) || mangaBakaImageUrl(series?.thumbnail_url);
}

function mangaBakaReason(series) {
  const reason = series?.reason || {};
  const seed = reason.reason_seeds?.[0];
  if (reason.reason_type === "similar_to" && seed) return `Because you read ${mangaBakaTitle(seed)}`;
  const tags = (reason.top_tags || []).slice(0, 2).map((tag) => tag.name).filter(Boolean);
  if (tags.length) return `Matches your interest in ${tags.join(" and ")}`;
  if (reason.reason_type === "hidden_gem") return "A highly rated hidden gem";
  if (reason.reason_type === "rising") return "Popular with readers right now";
  return "Selected from MangaBaka discovery";
}

function renderMangaBakaRecommendations() {
  if (!el.mangabakaResults) return;
  el.mangabakaResults.replaceChildren();
  if (!state.mangabakaRecommendations.length) {
    el.mangabakaResults.append(emptyLine("No recommendations are ready yet."));
    return;
  }
  state.mangabakaRecommendations.forEach((series) => {
    const title = mangaBakaTitle(series);
    const card = document.createElement("article");
    card.className = "recommendation-card";
    const cover = createCoverButton({ title, thumbnailUrl: mangaBakaCover(series) }, {
      title,
      eyebrow: String(series.media_type || series.type || "Manga").replaceAll("_", " "),
      meta: "View reading options",
    });
    cover.addEventListener("click", () => findMangaBakaSource(series));
    card.append(cover);
    const reason = document.createElement("p");
    reason.className = "recommendation-reason";
    reason.textContent = mangaBakaReason(series);
    const find = document.createElement("button");
    find.type = "button";
    find.textContent = state.connected && state.visibleSources.length ? "Read this" : "Set up to read";
    find.addEventListener("click", () => findMangaBakaSource(series));
    card.append(reason, find);
    el.mangabakaResults.append(card);
  });
}

async function loadMangaBakaRecommendations({ announce = false } = {}) {
  if (!el.mangabakaResults) return;
  if (el.mangabakaRecommendationsNote) el.mangabakaRecommendationsNote.textContent = "Loading MangaBaka discovery…";
  setBusy(el.refreshMangabaka, true, "Loading");
  try {
    const payload = await localJson("/api/mangabaka/recommendations?limit=12");
    state.mangabakaRecommendations = (payload.results || payload.data || []).filter((series) =>
      ["manga", "manhwa", "manhua", "oel"].includes(String(series.media_type || series.type || "manga").toLowerCase())
    );
    renderMangaBakaRecommendations();
    if (el.mangabakaRecommendationsNote) {
      el.mangabakaRecommendationsNote.textContent = payload.mode === "personalized"
        ? "Personalized from your MangaBaka library"
        : "Rising titles and hidden gems from MangaBaka";
    }
    if (announce) showToast("Recommendations refreshed.", "good");
  } catch (error) {
    if (el.mangabakaRecommendationsNote) el.mangabakaRecommendationsNote.textContent = friendlySourceErrorMessage(error);
    el.mangabakaResults.replaceChildren(emptyLine("MangaBaka discovery is temporarily unavailable."));
  } finally {
    setBusy(el.refreshMangabaka, false);
  }
}

function findMangaBakaSource(series) {
  state.pendingMangaBakaRecommendation = series;
  el.searchQuery.value = mangaBakaTitle(series);
  updateRecommendationContext();
  if (!state.connected || !state.visibleSources.length) {
    openSuwayomiSetup({ recommendation: series });
    showToast("Connect Suwayomi and load a source to read this title.");
    return;
  }
  void continuePendingRecommendationSearch();
}

function updateRecommendationContext() {
  if (!el.recommendationContext) return;
  const series = state.pendingMangaBakaRecommendation;
  el.recommendationContext.hidden = !series;
  if (!series) return;
  const title = mangaBakaTitle(series);
  if (el.recommendationContextTitle) el.recommendationContextTitle.textContent = `Finding ${title}`;
  if (el.recommendationContextNote) {
    el.recommendationContextNote.textContent = `${mangaBakaReason(series)} · Exact matches are shown first.`;
  }
}

function clearRecommendationContext() {
  state.pendingMangaBakaRecommendation = null;
  state.setupReturnToBrowse = false;
  updateRecommendationContext();
}

async function continuePendingRecommendationSearch() {
  const series = state.pendingMangaBakaRecommendation;
  if (!series) return;
  el.searchQuery.value = mangaBakaTitle(series);
  el.searchQuery.scrollIntoView({ behavior: "smooth", block: "center" });
  await searchSource();
}

function mangaBakaMatchForManga(manga) {
  const pending = state.pendingMangaBakaRecommendation;
  if (!pending) return null;
  const title = normalizeTitle(manga?.title);
  return mangaBakaTitles(pending).some((candidate) => normalizeTitle(candidate) === title) ? pending : null;
}

function loadMangaBakaOutbox() {
  try {
    const saved = JSON.parse(localStorage.getItem(mangabakaOutboxStoreKey) || "{}");
    const sanitized = sanitizeMangaBakaOutbox(saved);
    state.mangabakaAccountKey = sanitized.accountKey;
    state.mangabakaOutbox = sanitized.entries;
    state.mangabakaOutboxRevision = sanitized.revision;
    persistMangaBakaOutbox();
  } catch {
    state.mangabakaOutbox = [];
    state.mangabakaAccountKey = "";
    state.mangabakaOutboxRevision = 0;
  }
}

function sanitizeMangaBakaOutbox(saved) {
  const rawAccountKey = !Array.isArray(saved) && typeof saved?.accountKey === "string"
    ? saved.accountKey.trim()
    : "";
  const accountKey = rawAccountKey.length <= 200 ? rawAccountKey : "";
  const sourceEntries = !Array.isArray(saved) && Array.isArray(saved?.entries) ? saved.entries : [];
  if (!accountKey) return { accountKey: "", entries: [], revision: 0 };

  const candidates = sourceEntries.filter((entry) => {
    const seriesId = Number(entry?.series_id);
    const entryAccountKey = typeof entry?.accountKey === "string" ? entry.accountKey.trim() : "";
    return Number.isSafeInteger(seriesId) && seriesId > 0 &&
      entryAccountKey.length <= 200 && entryAccountKey === accountKey &&
      libraryStatuses.includes(entry?.state);
  });
  let revision = candidates.reduce((highest, entry) => {
    const value = Number(entry?.revision);
    const upperBound = Number.MAX_SAFE_INTEGER - candidates.length - 1;
    return Number.isSafeInteger(value) && value > 0 && value <= upperBound ? Math.max(highest, value) : highest;
  }, 0);
  const bySeries = new Map();
  candidates.forEach((entry) => {
    const seriesId = Number(entry?.series_id);
    let entryRevision = Number(entry?.revision);
    const upperBound = Number.MAX_SAFE_INTEGER - candidates.length - 1;
    if (!Number.isSafeInteger(entryRevision) || entryRevision < 1 || entryRevision > upperBound) {
      revision += 1;
      entryRevision = revision;
    }
    revision = Math.max(revision, entryRevision);
    const progress = Number(entry?.progress_chapter);
    const candidate = {
      series_id: seriesId,
      state: entry.state,
      accountKey,
      revision: entryRevision,
    };
    if (Number.isFinite(progress) && progress >= 0 && progress <= 10000) {
      candidate.progress_chapter = progress;
    }
    const existing = bySeries.get(seriesId);
    if (!existing) {
      bySeries.set(seriesId, candidate);
      return;
    }
    const newest = candidate.revision >= existing.revision ? candidate : existing;
    const merged = { ...newest, revision: Math.max(candidate.revision, existing.revision) };
    const maxProgress = Math.max(
      Number.isFinite(Number(candidate.progress_chapter)) ? Number(candidate.progress_chapter) : -1,
      Number.isFinite(Number(existing.progress_chapter)) ? Number(existing.progress_chapter) : -1
    );
    if (maxProgress >= 0) merged.progress_chapter = maxProgress;
    bySeries.set(seriesId, merged);
  });
  return { accountKey, entries: [...bySeries.values()], revision };
}

function persistMangaBakaOutbox() {
  try {
    localStorage.setItem(mangabakaOutboxStoreKey, JSON.stringify({
      accountKey: state.mangabakaAccountKey,
      entries: state.mangabakaOutbox,
    }));
  } catch {
    // The Panels library still retains the last known state.
  }
}

function enqueueMangaBakaLibraryItem(item, completedChapter = null) {
  const seriesId = Number(item?.mangabakaId);
  if (!seriesId || !state.mangabakaAccountKey) return;
  const existing = state.mangabakaOutbox.find((entry) => Number(entry.series_id) === seriesId) || {};
  const chapter = Number.isFinite(Number(completedChapter))
    ? Number(completedChapter)
    : Number(item?.completedChapter);
  const entry = {
    ...existing,
    series_id: seriesId,
    state: normalizedLibraryStatus(item),
    accountKey: state.mangabakaAccountKey,
    revision: state.mangabakaOutboxRevision + 1,
  };
  state.mangabakaOutboxRevision = entry.revision;
  if (Number.isFinite(chapter) && chapter >= 0) {
    entry.progress_chapter = Math.max(Number(existing.progress_chapter) || 0, chapter);
  }
  state.mangabakaOutbox = [entry, ...state.mangabakaOutbox.filter((candidate) => Number(candidate.series_id) !== seriesId)];
  persistMangaBakaOutbox();
  window.clearTimeout(state.mangabakaSyncTimer);
  state.mangabakaSyncTimer = window.setTimeout(() => void flushMangaBakaOutbox(), 2500);
}

async function flushMangaBakaOutbox({ manual = false } = {}) {
  if (!state.mangabakaConfigured || !state.mangabakaAccountKey || !state.mangabakaOutbox.length) return false;
  if (state.mangabakaSyncPromise) return state.mangabakaSyncPromise;
  const entries = state.mangabakaOutbox
    .filter((entry) => entry.accountKey === state.mangabakaAccountKey)
    .slice(0, 100)
    .map((entry) => ({ ...entry }));
  if (!entries.length) return false;
  const apiEntries = entries.map((entry) => {
    const output = { series_id: entry.series_id, state: entry.state };
    if (Number.isFinite(Number(entry.progress_chapter))) output.progress_chapter = Number(entry.progress_chapter);
    return output;
  });
  const request = postLocalJson("/api/mangabaka/library", {
    accountKey: state.mangabakaAccountKey,
    entries: apiEntries,
  });
  let sentSuccessfully = false;
  state.mangabakaSyncPromise = request;
  try {
    await request;
    sentSuccessfully = true;
    state.mangabakaOutbox = retainUnacknowledgedMangaBakaEntries(state.mangabakaOutbox, entries);
    persistMangaBakaOutbox();
    if (manual) showToast("MangaBaka library synced.", "good");
    return true;
  } catch (error) {
    persistMangaBakaOutbox();
    if (manual) throw error;
    return false;
  } finally {
    if (state.mangabakaSyncPromise === request) state.mangabakaSyncPromise = null;
    if (sentSuccessfully && state.mangabakaOutbox.some((entry) => entry.accountKey === state.mangabakaAccountKey)) {
      window.setTimeout(() => void flushMangaBakaOutbox(), 50);
    }
  }
}

function retainUnacknowledgedMangaBakaEntries(currentEntries, sentEntries) {
  const sentRevisions = new Map(sentEntries.map((entry) => [
    `${entry.accountKey}:${Number(entry.series_id)}`,
    Number(entry.revision),
  ]));
  return currentEntries.filter((entry) => {
    const sentRevision = sentRevisions.get(`${entry.accountKey}:${Number(entry.series_id)}`);
    return sentRevision === undefined || Number(entry.revision) !== sentRevision;
  });
}

function mangaBakaProfileKey(profile) {
  const identifier = profile?.id ?? profile?.uuid ?? profile?.preferred_username;
  return identifier === undefined || identifier === null ? "" : String(identifier);
}

function adoptMangaBakaAccount(profile) {
  const accountKey = mangaBakaProfileKey(profile);
  if (!accountKey) return;
  if (state.mangabakaAccountKey && state.mangabakaAccountKey !== accountKey) {
    state.mangabakaOutbox = [];
  }
  let mappingsChanged = false;
  state.libraryItems = state.libraryItems.map((item) => {
    if (!item.mangabakaId || item.mangabakaAccountKey === accountKey) return item;
    const cleaned = { ...item };
    delete cleaned.mangabakaId;
    delete cleaned.mangabakaTitle;
    delete cleaned.mangabakaMatchSource;
    delete cleaned.mangabakaAccountKey;
    mappingsChanged = true;
    return cleaned;
  });
  state.mangabakaAccountKey = accountKey;
  state.mangabakaOutbox = state.mangabakaOutbox.filter((entry) => entry.accountKey === accountKey);
  persistMangaBakaOutbox();
  if (mappingsChanged) {
    saveLibraryItems();
    renderLibrary();
  }
}

function clearMangaBakaLocalState() {
  state.mangabakaOutbox = [];
  state.mangabakaAccountKey = "";
  state.libraryItems = state.libraryItems.map((item) => {
    const cleaned = { ...item };
    delete cleaned.mangabakaId;
    delete cleaned.mangabakaTitle;
    delete cleaned.mangabakaMatchSource;
    delete cleaned.mangabakaAccountKey;
    return cleaned;
  });
  persistMangaBakaOutbox();
  saveLibraryItems();
  renderLibrary();
}

async function refreshMangaBakaStatus() {
  try {
    const payload = await localJson("/api/mangabaka/status");
    state.mangabakaConfigured = Boolean(payload.configured);
    state.mangabakaConnected = Boolean(payload.connected);
    if (payload.connected) adoptMangaBakaAccount(payload.profile);
    if (el.mangabakaState) el.mangabakaState.textContent = payload.connected ? "Connected" : "Not connected";
    if (el.disconnectMangabaka) el.disconnectMangabaka.hidden = !payload.configured;
    if (el.mangabakaNote) {
      const readiness = payload.recommendations?.data || payload.recommendations || {};
      el.mangabakaNote.textContent = payload.connected
        ? (readiness.ready === false ? "Connected. Personalized recommendations are still being prepared." : "Connected. Recommendations and completed chapters will sync automatically.")
        : (payload.error || "Public recommendations remain available without an account.");
    }
    if (payload.connected) void flushMangaBakaOutbox();
    return payload;
  } catch (error) {
    state.mangabakaConnected = false;
    if (el.mangabakaState) el.mangabakaState.textContent = "Needs attention";
    if (el.mangabakaNote) el.mangabakaNote.textContent = friendlySourceErrorMessage(error);
    return null;
  }
}

async function connectMangaBaka() {
  const token = el.mangabakaToken?.value.trim() || "";
  if (!token) return showToast("Paste your MangaBaka token first.", "bad");
  setBusy(el.saveMangabaka, true, "Connecting");
  try {
    const connected = await postLocalJson("/api/mangabaka/config", { token });
    adoptMangaBakaAccount(connected.profile);
    el.mangabakaToken.value = "";
    await refreshMangaBakaStatus();
    await matchMangaBakaLibrary();
    await loadMangaBakaRecommendations();
    showToast("MangaBaka connected.", "good");
  } catch (error) {
    showToast(`Could not connect MangaBaka: ${friendlySourceErrorMessage(error)}`, "bad");
  } finally {
    setBusy(el.saveMangabaka, false);
  }
}

async function disconnectMangaBaka() {
  try {
    await postLocalJson("/api/mangabaka/config", { clear: true });
    clearMangaBakaLocalState();
    state.mangabakaConfigured = false;
    state.mangabakaConnected = false;
    await refreshMangaBakaStatus();
    await loadMangaBakaRecommendations();
    showToast("MangaBaka disconnected.");
  } catch (error) {
    showToast(`Could not disconnect MangaBaka: ${friendlySourceErrorMessage(error)}`, "bad");
  }
}

async function matchMangaBakaLibrary() {
  if (!state.mangabakaConnected || !state.mangabakaAccountKey) return 0;
  const candidates = state.libraryItems.filter((item) => !item.mangabakaId).slice(0, 20);
  let matched = 0;
  for (const item of candidates) {
    try {
      const payload = await localJson(`/api/mangabaka/search?q=${encodeURIComponent(item.mangaTitle || "")}`);
      const exactMatches = (payload.data || payload.results || []).filter((series) =>
        mangaBakaTitles(series).some((title) => normalizeTitle(title) === normalizeTitle(item.mangaTitle))
      );
      const exact = exactMatches.length === 1 ? exactMatches[0] : null;
      if (exact) {
        item.mangabakaId = Number(exact.id);
        item.mangabakaTitle = mangaBakaTitle(exact);
        item.mangabakaMatchSource = "exact-title";
        item.mangabakaAccountKey = state.mangabakaAccountKey;
        enqueueMangaBakaLibraryItem(item);
        matched += 1;
      }
      await waitFor(220);
    } catch {
      // Keep unmatched titles local; they can be retried on the next manual sync.
    }
  }
  if (matched) {
    saveLibraryItems();
    renderLibrary();
  }
  await flushMangaBakaOutbox().catch(() => false);
  return matched;
}

function completeMangaBakaChapter() {
  if (state.activeChapter?.type !== "suwayomi") return;
  const chapter = state.activeChapter.chapter || state.chapters.find((entry) => Number(entry.id) === Number(state.activeChapter.chapterId));
  const chapterNumber = Number(chapter?.chapterNumber);
  if (!Number.isFinite(chapterNumber) || chapterNumber < 0) return;
  const key = libraryItemKey(state.currentManga);
  state.libraryItems = state.libraryItems.map((item) => libraryItemKey(item) === key
    ? { ...item, completedChapter: Math.max(Number(item.completedChapter) || 0, chapterNumber) }
    : item);
  const item = state.libraryItems.find((entry) => libraryItemKey(entry) === key);
  saveLibraryItems();
  enqueueMangaBakaLibraryItem(item, chapterNumber);
}

function handleAuthenticationResponse(response, payload) {
  if (response.status !== 401) return;
  const login = payload?.login || "/login";
  const next = `${location.pathname}${location.search}${location.hash}`;
  location.assign(`${login}?next=${encodeURIComponent(next)}`);
  throw new Error("Your Panels session expired. Redirecting to sign in.");
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

function normalizeSuwayomiPageUrl(url, baseUrlOverride = "") {
  if (!url) return "";
  if (url.startsWith("/api/image")) return appUrl(url);
  const base = baseUrlOverride || cleanBaseUrl();
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
  const wasActive = el.readerLoading.classList.contains("active");
  if (active && !wasActive) {
    rememberReaderModalFocus();
    hideReaderModalsExcept();
  }
  const normalizedProgress = Math.round(clamp(progress, 0, 100));
  el.readerLoading.classList.toggle("active", active);
  el.readerLoading.setAttribute("aria-hidden", active ? "false" : "true");
  el.stage?.setAttribute("aria-busy", active || state.navigationPending ? "true" : "false");
  if (el.readerLoadingText) el.readerLoadingText.textContent = text;
  if (el.readerLoadingBar) {
    el.readerLoadingBar.style.setProperty("--reader-loading-progress", `${normalizedProgress}%`);
    const track = el.readerLoadingBar.closest(".reader-loading-bar-track") || el.readerLoadingBar.parentElement;
    track?.setAttribute("role", "progressbar");
    track?.setAttribute("aria-valuemin", "0");
    track?.setAttribute("aria-valuemax", "100");
    track?.setAttribute("aria-valuenow", String(normalizedProgress));
    track?.setAttribute("aria-valuetext", active ? `${text} ${normalizedProgress}%` : "Reader loading complete");
  }
  syncReaderInteractionIsolation();
  if (active && !wasActive) {
    requestAnimationFrame(() => {
      if (activeReaderOverlay() !== el.readerLoading) return;
      const target = el.readerLoadingCancel?.hidden ? el.readerLoading : el.readerLoadingCancel;
      target?.focus({ preventScroll: true });
    });
  } else if (!active && wasActive && !activeReaderOverlay()) {
    restoreReaderModalFocus();
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

function setReaderChromeVisible(visible, { refit = true } = {}) {
  state.readerChromeVisible = Boolean(visible);
  document.body.classList.toggle("reader-chrome-hidden", state.readerFocus && !state.readerChromeVisible);
  if (refit) requestAnimationFrame(fitStage);
}

function isInteractiveTarget(target) {
  if (!target) return false;
  return Boolean(target.closest?.("button, a, input, textarea, select, summary, [contenteditable='true'], [role='button']"));
}

function activeReaderModal() {
  if (el.readerError && !el.readerError.hidden) return el.readerError;
  if (el.readerTapHint && !el.readerTapHint.hidden) return el.readerTapHint;
  if (el.readerComplete && !el.readerComplete.hidden) return el.readerComplete;
  return null;
}

function readerModalElements() {
  return [el.readerError, el.readerComplete, el.readerTapHint].filter(Boolean);
}

function hideReaderModalsExcept(modal = null) {
  readerModalElements().forEach((item) => {
    if (item !== modal) item.hidden = true;
  });
  if (modal !== el.readerError) state.readerErrorRetryAction = null;
}

function activeReaderOverlay() {
  if (el.readerLoading?.classList.contains("active")) return el.readerLoading;
  return activeReaderModal();
}

function syncReaderInteractionIsolation() {
  const surface = activeReaderOverlay();
  if (!surface) {
    readerIsolationPrevious.forEach((wasInert, item) => {
      item.inert = wasInert;
    });
    readerIsolationPrevious.clear();
    return;
  }

  const appShell = el.readerView?.parentElement;
  const readerChildren = [...(el.readerView?.children || [])];
  const externalSurfaces = [
    ...(appShell ? [...appShell.children].filter((item) => item !== el.readerView) : []),
    ...[...document.body.children].filter((item) => item !== appShell && item.tagName !== "SCRIPT"),
  ];
  [...readerChildren, ...externalSurfaces].forEach((item) => {
    if (!readerIsolationPrevious.has(item)) readerIsolationPrevious.set(item, item.inert);
    item.inert = readerChildren.includes(item) ? item !== surface : true;
  });
}

function closeReaderOverlaysForExit() {
  if (el.readerLoading) {
    el.readerLoading.classList.remove("active");
    el.readerLoading.setAttribute("aria-hidden", "true");
  }
  hideReaderModalsExcept();
  state.readerLoadingCancelAction = null;
  el.stage?.setAttribute("aria-busy", "false");
  syncReaderInteractionIsolation();
}

function openReaderModal(modal) {
  if (!modal) return;
  rememberReaderModalFocus();
  if (el.readerLoading?.classList.contains("active")) {
    el.readerLoading.classList.remove("active");
    el.readerLoading.setAttribute("aria-hidden", "true");
    el.stage?.setAttribute("aria-busy", state.navigationPending ? "true" : "false");
  }
  hideReaderModalsExcept(modal);
  modal.hidden = false;
  syncReaderInteractionIsolation();
}

function rememberReaderModalFocus() {
  if (state.readerModalReturnFocus) return;
  state.readerModalReturnFocus = document.activeElement;
  const target = state.readerModalReturnFocus;
  const chapterAction = target?.dataset?.chapterAction;
  const chapterId = target?.closest?.("[data-chapter-id]")?.dataset?.chapterId;
  if (chapterAction && chapterId) {
    state.readerModalReturnFocusSelector = `[data-chapter-id="${CSS.escape(chapterId)}"] [data-chapter-action="${CSS.escape(chapterAction)}"]`;
  } else if (target?.id) {
    state.readerModalReturnFocusSelector = `#${CSS.escape(target.id)}`;
  } else {
    state.readerModalReturnFocusSelector = "";
  }
}

function restoreReaderModalFocus() {
  if (activeReaderOverlay()) return;
  let target = state.readerModalReturnFocus;
  if ((!target?.isConnected || !target.getClientRects?.().length) && state.readerModalReturnFocusSelector) {
    target = document.querySelector(state.readerModalReturnFocusSelector) || target;
  }
  const targetIsVisible = Boolean(
    target?.isConnected &&
    !target.closest?.("[hidden], [inert]") &&
    target.getClientRects?.().length
  );
  if (targetIsVisible) {
    state.readerModalReturnFocus = null;
    state.readerModalReturnFocusSelector = "";
    target.focus({ preventScroll: true });
    return;
  }
  // A cancelled chapter load can reveal its initiating view asynchronously via
  // history navigation. Keep the original target until setActiveView makes it
  // visible, while ensuring the current reader never loses keyboard focus.
  if (state.activeView === "reader") el.stage?.focus({ preventScroll: true });
  else if (!state.readerModalReturnFocusSelector) {
    state.readerModalReturnFocus = null;
    state.readerModalReturnFocusSelector = "";
  }
}

function trapReaderModalFocus(event, modal) {
  if (event.key !== "Tab" || !modal) return false;
  const focusable = [...modal.querySelectorAll("button:not([disabled]):not([hidden]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])")]
    .filter((item) => item.getClientRects().length);
  if (!focusable.length) {
    event.preventDefault();
    modal.focus?.({ preventScroll: true });
    return true;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
  return true;
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
  if (!navigator.onLine) {
    showOfflineNetworkStatus();
    setConnection(false, "Device offline. Suwayomi will reconnect when the network returns.", "bad");
    return false;
  }
  setBusy(el.testConnection, true, "Testing");
  try {
    const data = await graphQL(queries.health);
    if (!data.__schema?.queryType?.name) throw new Error("Suwayomi did not return a valid response.");
    setConnection(true, "Suwayomi connected.", "good");
    if (!networkReconnectPromise && el.networkStatusBanner && !el.networkStatusBanner.hidden) {
      showRestoredNetworkStatus();
    }
    if (!state.suwayomiSyncing) {
      setSyncStatus(
        state.suwayomiProgressOutbox.length ? "Queued" : "Ready",
        state.suwayomiProgressOutbox.length
          ? `${state.suwayomiProgressOutbox.length} progress update${state.suwayomiProgressOutbox.length === 1 ? "" : "s"} waiting to sync.`
          : "Suwayomi is connected and ready to sync.",
        state.suwayomiProgressOutbox.length ? "" : "good"
      );
    }
    return true;
  } catch (error) {
    setConnection(false, `Could not connect to Suwayomi: ${friendlySourceErrorMessage(error)}`, "bad");
    setSyncStatus("Not connected", "Test the Suwayomi connection before syncing progress.", "bad");
    if (navigator.onLine && !networkReconnectPromise) showServerUnavailableStatus();
    return false;
  } finally {
    setBusy(el.testConnection, false);
  }
}

async function loadSources() {
  if (!state.connected) {
    showToast("Test the Suwayomi connection first.", "bad");
    return false;
  }
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
    if (state.setupReturnToBrowse && state.pendingMangaBakaRecommendation && state.visibleSources.length) {
      await finishSuwayomiSetup();
    }
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
  updateBrowseAvailability();
  renderMangaBakaRecommendations();
  updateSuwayomiSetupState();
}

async function searchSource() {
  const selectedSource = el.sourceSelect.value;
  const query = el.searchQuery.value.trim();
  if (!state.connected || !state.visibleSources.length || !selectedSource) {
    setConnection(false, "Connect Suwayomi and load at least one source before searching.", "bad");
    openSuwayomiSetup({ recommendation: state.pendingMangaBakaRecommendation });
    showToast("Set up a Suwayomi source to continue.", "bad");
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
    let searched = 0;
    await mapWithConcurrency(sources, 3, async (source) => {
      try {
        const data = await graphQL(queries.searchSource, {
          input: { source: source.id, query, page: 1, type: "SEARCH" },
        }, { timeoutMs: 12000 });
        (data.fetchSourceManga?.mangas || []).forEach((manga) => {
          results.push({ ...manga, sourceId: manga.sourceId || source.id });
        });
      } catch (error) {
        failures.push(sourceLabel(source));
      } finally {
        searched += 1;
        setConnection(true, `Searched ${searched} of ${sources.length} sources…`, "");
      }
    });
    addMangasToSourceIndex(results);
    const liveResults = uniqueMangaResults(results);
    state.mangas = sortMangaResults(
      liveResults.length ? uniqueMangaResults([...liveResults, ...indexedResults]) : indexedResults,
      query
    );
    renderMangaResults();
    if (failures.length === sources.length) {
      setConnection(
        state.connected,
        state.mangas.length
          ? `Showing ${state.mangas.length} saved result${state.mangas.length === 1 ? "" : "s"}; live sources are unavailable.`
          : "Sources are unavailable right now. This was not an empty search result.",
        "bad"
      );
    } else {
      const suffix = failures.length ? ` ${failures.length} source${failures.length === 1 ? "" : "s"} did not respond.` : "";
      setConnection(true, `Found ${state.mangas.length} manga results across ${sources.length} source${sources.length === 1 ? "" : "s"}.${suffix}`, failures.length ? "" : "good");
    }
  } catch (error) {
    if (hadIndexedResults) {
      setConnection(true, `Showing indexed results. Live search failed: ${friendlySourceErrorMessage(error)}`, "good");
    } else {
      setConnection(state.connected, `Search failed: ${friendlySourceErrorMessage(error)}`, "bad");
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

async function mapWithConcurrency(items, concurrency, task) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await task(item);
    }
  });
  await Promise.all(workers);
}

function renderMangaResults() {
  el.mangaResults.replaceChildren();
  if (!state.mangas.length) {
    const recommendation = state.pendingMangaBakaRecommendation;
    const empty = document.createElement("div");
    empty.className = "app-empty-state compact-empty";
    const art = document.createElement("span");
    art.className = "empty-illustration";
    art.setAttribute("aria-hidden", "true");
    art.textContent = "⌕";
    const heading = document.createElement("strong");
    heading.textContent = recommendation ? `No source match for ${mangaBakaTitle(recommendation)}` : "No matching manga";
    const copy = document.createElement("span");
    copy.textContent = recommendation
      ? "Try a shorter title, choose another source, or clear this recommendation."
      : "Try a shorter title or choose another source.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Change search";
    retry.addEventListener("click", () => el.searchQuery?.focus());
    empty.append(art, heading, copy, retry);
    el.mangaResults.append(empty);
    return;
  }

  state.mangas.forEach((manga) => {
    const card = document.createElement("article");
    card.className = "manga-card browse-card";
    const source = state.sources.find((item) => String(item.id) === String(manga.sourceId));
    const sourceText = source ? sourceLabel(source) : manga.sourceId;
    const exactRecommendationMatch = Boolean(mangaBakaMatchForManga(manga));
    const button = createCoverButton(manga, {
      title: manga.title,
      eyebrow: sourceText || "Source",
      meta: exactRecommendationMatch
        ? "Exact title match"
        : state.pendingMangaBakaRecommendation
          ? "Alternative source result"
          : "View chapters",
    });
    button.addEventListener("click", async () => {
      const mangabaka = mangaBakaMatchForManga(manga);
      const accountScopedMangaBaka = mangabaka && state.mangabakaConnected && state.mangabakaAccountKey
        ? mangabaka
        : null;
      el.mangaId.value = manga.id;
      el.chapterTitle.textContent = manga.title;
      state.currentManga = {
        id: manga.id,
        title: manga.title,
        sourceId: manga.sourceId,
        sourceLabel: sourceText,
        thumbnailUrl: manga.thumbnailUrl,
        mangabakaId: accountScopedMangaBaka?.id,
        mangabakaTitle: accountScopedMangaBaka ? mangaBakaTitle(accountScopedMangaBaka) : undefined,
        mangabakaMatchSource: accountScopedMangaBaka ? "recommendation" : undefined,
        mangabakaAccountKey: accountScopedMangaBaka ? state.mangabakaAccountKey : undefined,
        serverUrl: currentDeviceServerUrl(),
      };
      if (mangabaka) {
        state.pendingMangaBakaRecommendation = null;
        updateRecommendationContext();
      }
      state.mangaDetailOrigin = "browse";
      showMangaDetail(manga, sourceText, { origin: "browse" });
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

function showMangaDetail(manga, sourceText = "", options = {}) {
  if (!el.mangaDetail || !el.browseBody) return;
  const title = manga?.title || manga?.mangaTitle || "Selected manga";
  const source = sourceText || manga?.sourceLabel || "Suwayomi source";
  state.mangaDetailOrigin = options.origin || state.mangaDetailOrigin || "browse";
  el.browseView?.setAttribute("aria-label", `Manga details: ${title}`);
  state.browseDiscoveryScroll = window.scrollY;
  el.mangaDetail.closest(".browse-view")?.classList.add("detail-open");
  el.browseBody.hidden = true;
  el.mangaDetail.hidden = false;
  if (el.closeMangaDetail) {
    el.closeMangaDetail.textContent = state.mangaDetailOrigin === "library" ? "‹ Library" : "‹ Browse";
  }
  if (state.mangaDetailOrigin === "library") {
    el.appNavButtons.forEach((button) => {
      const active = button.dataset.targetView === "library";
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
  }
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
  updateMangaDetailActions();
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (options.history !== false) recordNavigationState("push", true);
}

function currentMangaLibraryItem() {
  if (!state.currentManga) return null;
  const key = libraryItemKey(state.currentManga);
  return state.libraryItems.find((item) => libraryItemKey(item) === key) || null;
}

function updateMangaDetailActions() {
  const item = currentMangaLibraryItem();
  if (el.detailPrimary) {
    el.detailPrimary.textContent = item?.chapterId
      ? `Continue ${item.chapterTitle || "reading"}`
      : "Start reading";
  }
  if (el.detailLibrary) {
    el.detailLibrary.textContent = item ? "In library" : "Add to library";
    el.detailLibrary.disabled = Boolean(item);
  }
}

async function startOrContinueCurrentManga() {
  const item = currentMangaLibraryItem();
  if (item?.chapterId) {
    await selectLibraryManga(item, true);
    return;
  }
  const chapters = state.chapterView.length ? state.chapterView : visibleChapters();
  const unread = chapters
    .filter((chapter) => !chapter.isRead)
    .sort((a, b) => Number(a.sourceOrder ?? a.chapterNumber ?? 0) - Number(b.sourceOrder ?? b.chapterNumber ?? 0));
  const chapter = unread[0] || chapters[chapters.length - 1];
  if (!chapter) {
    showToast("No readable chapter is available yet.", "bad");
    return;
  }
  el.chapterId.value = chapter.id;
  el.chapterTitle.textContent = chapter.name || `Chapter ${chapter.chapterNumber || chapter.sourceOrder || chapter.id}`;
  await loadChapterPages({ chapter });
}

async function addCurrentMangaToLibrary() {
  if (!state.currentManga || currentMangaLibraryItem()) return;
  setBusy(el.detailLibrary, true, "Adding");
  try {
    await ensureCurrentMangaInSuwayomiLibrary();
    state.libraryItems = [{
      mangaId: Number(state.currentManga.id),
      mangaTitle: state.currentManga.title,
      sourceId: state.currentManga.sourceId,
      sourceLabel: state.currentManga.sourceLabel,
      thumbnailUrl: state.currentManga.thumbnailUrl,
      mangabakaId: state.currentManga.mangabakaId,
      mangabakaTitle: state.currentManga.mangabakaTitle,
      mangabakaMatchSource: state.currentManga.mangabakaMatchSource,
      mangabakaAccountKey: state.currentManga.mangabakaAccountKey,
      libraryStatus: "plan_to_read",
      statusExplicit: true,
      started: false,
      hidden: false,
      pinned: false,
      updatedAt: new Date().toISOString(),
    }, ...state.libraryItems];
    saveLibraryItems();
    renderLibrary();
    updateMangaDetailActions();
    showToast("Added to Plan to read.", "good");
  } catch (error) {
    showToast(`Could not add this title: ${friendlySourceErrorMessage(error)}`, "bad");
  } finally {
    setBusy(el.detailLibrary, false);
    updateMangaDetailActions();
  }
}

function closeMangaDetail(options = {}) {
  if (!el.mangaDetail || !el.browseBody) return;
  el.browseView?.setAttribute("aria-label", "Browse");
  if (!state.historyApplying && options.history !== false && window.history.state?.detail) {
    window.history.back();
    return;
  }
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
  const words = String(title || "Panels").trim().split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((word) => word[0]).join("") || "PP").toUpperCase();
}

function coverHue(title) {
  return [...String(title || "Panels")].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) % 360, 204);
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
  eyebrow.textContent = content.eyebrow || "Panels";
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

  if (!navigator.onLine) return;

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
  state.librarySavePending = true;
  if (!navigator.onLine) return Promise.resolve(null);
  if (!state.librarySavePromise) {
    state.librarySavePromise = flushLibraryItems().finally(() => {
      state.librarySavePromise = null;
      if (state.librarySavePending) saveLibraryItems();
    });
  }
  return state.librarySavePromise;
}

async function flushLibraryItems() {
  while (state.librarySavePending) {
    state.librarySavePending = false;
    const snapshot = state.libraryItems.map((item) => ({ ...item }));
    try {
      const payload = await postLocalJson("/api/library", { items: snapshot });
      if (Array.isArray(payload.items)) {
        state.libraryItems = mergeLibraryItems(state.libraryItems, payload.items);
        persistLibraryItemsLocally();
      }
    } catch {
      state.librarySavePending = true;
      if (navigator.onLine) {
        window.setTimeout(() => saveLibraryItems(), 5000);
      }
      break;
    }
  }
}

function persistLibraryItemsLocally() {
  try {
    localStorage.setItem(libraryStoreKey, JSON.stringify(state.libraryItems));
  } catch {
    // The server copy is authoritative; local storage is only a convenience cache.
  }
}

function normalizedLibraryStatus(item) {
  if (libraryStatuses.includes(item?.libraryStatus)) return item.libraryStatus;
  const hasStarted = Boolean(
    item?.started ||
    Number(item?.pageIndex) > 0 ||
    Number(item?.panelIndex) > 0 ||
    /page\s+[2-9]|page\s+\d{2,}/i.test(String(item?.progressLabel || ""))
  );
  return hasStarted ? "reading" : "plan_to_read";
}

function normalizeLibraryItem(item) {
  return item ? { ...item, libraryStatus: normalizedLibraryStatus(item) } : item;
}

function setLibraryFilter(filter) {
  if (!libraryFilterValues.includes(filter)) return;
  state.libraryFilter = filter;
  saveSettings();
  renderLibrary();
}

function mergeLibraryItems(...lists) {
  const merged = [];
  const seen = new Map();
  lists
    .flat()
    .filter(Boolean)
    .map(normalizeLibraryItem)
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

function offlineWindowForStoredChapters(chapters, resumeChapterId) {
  const ordered = chapters
    .filter((chapter) => Number.isInteger(Number(chapter?.id)) && Number(chapter.id) > 0)
    .slice()
    .sort((a, b) => Number(b.sourceOrder ?? b.chapterNumber ?? 0) - Number(a.sourceOrder ?? a.chapterNumber ?? 0));
  if (!ordered.length) return [];

  const resumeIndex = ordered.findIndex((chapter) => Number(chapter.id) === Number(resumeChapterId));
  let candidates;
  if (resumeIndex >= 0) {
    const resumeScanlator = scanlatorName(ordered[resumeIndex]);
    const sameReleaseStream = resumeScanlator
      ? ordered.filter((chapter) => scanlatorName(chapter) === resumeScanlator)
      : ordered;
    const streamIndex = sameReleaseStream.findIndex((chapter) => Number(chapter.id) === Number(resumeChapterId));
    candidates = sameReleaseStream.slice(Math.max(0, streamIndex - downloadAheadChapterCount), streamIndex).reverse();
  } else {
    const unread = ordered.filter((chapter) => !chapter.isRead);
    candidates = (unread.length ? unread : ordered).slice(-downloadAheadChapterCount).reverse();
  }
  return candidates.slice(0, downloadAheadChapterCount).map((chapter) => ({
    chapterId: Number(chapter.id),
    isDownloaded: Boolean(chapter.isDownloaded),
  }));
}

function updateLibraryOfflineReadiness(status = state.downloadStatus) {
  const preparedIds = new Set(
    (Array.isArray(status?.preparedChapterIds) ? status.preparedChapterIds : [])
      .map(Number)
      .filter((chapterId) => Number.isInteger(chapterId) && chapterId > 0)
  );
  const readiness = new Map();
  state.libraryOfflineWindows.forEach((chapters, key) => {
    const total = chapters.length;
    const downloaded = chapters.filter((chapter) => chapter.isDownloaded).length;
    const panelReady = chapters.filter((chapter) => chapter.isDownloaded && preparedIds.has(chapter.chapterId)).length;
    if (total) readiness.set(key, { total, downloaded, panelReady });
  });

  const activeChapters = Array.isArray(status?.windowChapters) ? status.windowChapters : [];
  const activeIdentity = activeChapters.find((chapter) => chapter?.mangaId && chapter?.sourceId);
  const activeKey = activeIdentity ? libraryItemKey(activeIdentity) : "";
  if (activeKey && activeChapters.length) {
    readiness.set(activeKey, {
      total: activeChapters.length,
      downloaded: activeChapters.filter((chapter) => chapter.isDownloaded).length,
      panelReady: activeChapters.filter((chapter) => chapter.isDownloaded && chapter.panelReady).length,
      failed: activeChapters.filter((chapter) => chapter.state === "failed").length,
      working: activeChapters.some((chapter) => ["downloading", "retrying", "queued", "pending"].includes(chapter.state)),
    });
  }
  state.libraryOfflineReadiness = readiness;
}

function createLibraryOfflineBadge(item) {
  const readiness = state.libraryOfflineReadiness.get(libraryItemKey(item));
  if (!readiness?.total) return null;
  const complete = readiness.downloaded === readiness.total && readiness.panelReady === readiness.total;
  const badge = document.createElement("span");
  badge.className = `manga-card-badge offline-readiness-badge${complete ? " ready" : readiness.failed ? " failed" : " pending"}`;
  badge.textContent = `${complete ? "✓" : "↓"} ${readiness.panelReady}/${readiness.total}`;
  const title = item.mangaTitle || "This title";
  badge.setAttribute("aria-label", complete
    ? `${title}: ${readiness.total} of ${readiness.total} buffered chapters are downloaded to the server and panel-ready.`
    : `${title}: ${readiness.downloaded} of ${readiness.total} buffered chapters downloaded to the server; ${readiness.panelReady} panel-ready.`);
  badge.title = badge.getAttribute("aria-label");
  return badge;
}

function renderLibrary() {
  if (!el.libraryList || !el.libraryCount) return;
  el.libraryList.replaceChildren();
  const allowedItems = libraryItemsAllowedByNsfw();
  const visibleItems = visibleLibraryItems();
  const hiddenCount = allowedItems.filter((item) => item.hidden).length;
  const statusCounts = Object.fromEntries(libraryStatuses.map((status) => [status, 0]));
  allowedItems.filter((item) => !item.hidden).forEach((item) => {
    const status = normalizedLibraryStatus(item);
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  });
  el.libraryFilters.forEach((button) => {
    const active = button.dataset.libraryFilter === state.libraryFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  el.libraryFilterCounts.forEach((count) => {
    const filter = count.dataset.libraryCount;
    const value = filter === "all"
      ? allowedItems.filter((item) => !item.hidden).length
      : filter === "reading"
        ? (statusCounts.reading || 0) + (statusCounts.rereading || 0)
        : filter === "other"
          ? (statusCounts.dropped || 0) + (statusCounts.considering || 0)
          : (statusCounts[filter] || 0);
    count.textContent = String(value);
  });
  if (el.toggleHiddenLibrary) el.toggleHiddenLibrary.hidden = hiddenCount === 0 && !state.showHiddenLibrary;
  el.libraryCount.textContent = `${visibleItems.length} title${visibleItems.length === 1 ? "" : "s"}${hiddenCount ? ` · ${hiddenCount} hidden` : ""}`;
  updateReaderNav();
  if (!visibleItems.length) {
    const showHiddenAction = !state.showHiddenLibrary && hiddenCount > 0 && state.libraryFilter === "all";
    const message = showHiddenAction
      ? "Your current titles are hidden. Show hidden titles to bring them back."
      : `No titles are currently marked ${state.libraryFilter === "all" ? "for this view" : state.libraryFilter === "other" ? "dropped or considering" : (libraryStatusLabels[state.libraryFilter] || state.libraryFilter).toLowerCase()}.`;
    const empty = document.createElement("div");
    empty.className = "app-empty-state";
    const art = document.createElement("span");
    art.className = "empty-illustration";
    art.setAttribute("aria-hidden", "true");
    art.textContent = "▤";
    const heading = document.createElement("strong");
    heading.textContent = "Nothing in this view";
    const copy = document.createElement("span");
    copy.textContent = message;
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = showHiddenAction ? "Show hidden titles" : "Browse manga";
    action.addEventListener("click", () => showHiddenAction ? setShowHiddenLibrary(true) : setActiveView("browse"));
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
    cover.addEventListener("click", () => void selectLibraryManga(item, resumable).catch((error) => {
      const message = friendlySourceErrorMessage(error);
      if (resumable) {
        setActiveView("reader");
        showReaderError(`Could not resume ${item.mangaTitle}`, message, () => selectLibraryManga(item, true));
      } else {
        showToast(`Could not open chapters: ${message}`, "bad");
      }
    }));

    const badges = document.createElement("div");
    badges.className = "manga-card-badges";
    const offlineBadge = createLibraryOfflineBadge(item);
    if (offlineBadge) badges.append(offlineBadge);
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
    const statusBadge = document.createElement("span");
    statusBadge.className = "manga-card-badge muted-badge";
    statusBadge.textContent = libraryStatusLabels[normalizedLibraryStatus(item)] || "Library";
    badges.append(statusBadge);

    const actions = document.createElement("div");
    actions.className = "manga-card-actions";
    const chapters = document.createElement("button");
    chapters.type = "button";
    chapters.textContent = "Chapters";
    chapters.addEventListener("click", () => void selectLibraryManga(item, false).catch((error) => {
      showToast(`Could not open chapters: ${friendlySourceErrorMessage(error)}`, "bad");
    }));
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
    const statusSelect = document.createElement("select");
    statusSelect.className = "library-status-select";
    statusSelect.setAttribute("aria-label", `Reading status for ${item.mangaTitle || "manga"}`);
    libraryStatuses.forEach((status) => {
      const option = document.createElement("option");
      option.value = status;
      option.textContent = libraryStatusLabels[status];
      statusSelect.append(option);
    });
    statusSelect.value = normalizedLibraryStatus(item);
    statusSelect.addEventListener("change", () => setLibraryItemStatus(item, statusSelect.value));
    menu.append(statusSelect, pin, hide);
    more.append(moreLabel, menu);
    actions.append(chapters, more);

    card.append(cover, badges, actions);
    el.libraryList.append(card);
  });
}

function readerResumeItem() {
  const available = state.libraryItems
    .filter((item) => !item.hidden)
    .filter((item) => ["reading", "rereading"].includes(normalizedLibraryStatus(item)))
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
  el.navReaderFallback.textContent = coverInitials(item?.mangaTitle || "Panels");
  el.navReaderCover.style.setProperty("--cover-hue", String(coverHue(item?.mangaTitle || "Panels")));
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
  const activeServerUrl = String(state.activeChapter?.serverUrl || currentDeviceServerUrl()).trim().replace(/\/+$/, "");
  const itemServerUrl = String(item.serverUrl || currentDeviceServerUrl()).trim().replace(/\/+$/, "");
  const activeMatchesItem =
    state.activeChapter?.type === "suwayomi" &&
    Number(state.activeChapter.chapterId) === Number(item.chapterId) &&
    String(state.currentManga?.id) === String(item.mangaId) &&
    activeServerUrl === itemServerUrl;
  if (activeMatchesItem && state.pages.length) {
    setActiveView("reader");
    return;
  }
  el.navReader.setAttribute("aria-busy", "true");
  try {
    await selectLibraryManga(item, true);
    if (!state.activeChapter || !state.pages.length) {
      setActiveView("reader");
      if (el.readerError?.hidden) {
        showReaderError(`Could not resume ${item.mangaTitle}`, "The saved chapter did not finish loading.", openReaderFromNav);
      }
    }
  } catch (error) {
    const message = friendlySourceErrorMessage(error);
    setConnection(state.connected, `Could not resume ${item.mangaTitle}: ${message}`, "bad");
    setActiveView("reader");
    showReaderError(`Could not resume ${item.mangaTitle}`, message, openReaderFromNav);
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
    libraryItemsAllowedByNsfw()
      .filter((item) => state.showHiddenLibrary || !item.hidden)
      .filter((item) => {
        const status = normalizedLibraryStatus(item);
        if (state.libraryFilter === "all") return true;
        if (state.libraryFilter === "reading") return status === "reading" || status === "rereading";
        if (state.libraryFilter === "other") return status === "dropped" || status === "considering";
        return status === state.libraryFilter;
      })
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

async function withRetry(task, delays = [0], options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await waitFor(delays[attempt]);
    try {
      return await task(attempt);
    } catch (error) {
      if (error?.name === "ReaderLoadCancelled") throw error;
      if (typeof options.shouldRetry === "function" && !options.shouldRetry(error)) throw error;
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
    libraryItemKey(existing) === key ? { ...existing, [field]: value, updatedAt: new Date().toISOString() } : existing
  );
  saveLibraryItems();
  renderLibrary();
  showToast(field === "pinned" ? (value ? "Pinned to the top." : "Unpinned.") : (value ? "Hidden from Library." : "Restored to Library."));
}

function setLibraryItemStatus(item, status, { sync = true } = {}) {
  if (!libraryStatuses.includes(status)) return;
  const key = libraryItemKey(item);
  state.libraryItems = state.libraryItems.map((existing) =>
    libraryItemKey(existing) === key
      ? { ...existing, libraryStatus: status, statusExplicit: true, updatedAt: new Date().toISOString() }
      : existing
  );
  const updated = state.libraryItems.find((entry) => libraryItemKey(entry) === key);
  saveLibraryItems();
  renderLibrary();
  if (sync) enqueueMangaBakaLibraryItem(updated);
  showToast(`Moved to ${libraryStatusLabels[status]}.`, "good");
}

function isNsfwLibraryItem(item) {
  const source = state.sources.find((entry) => String(entry.id) === String(item?.sourceId));
  if (source && isNsfwSource(source)) return true;
  const label = `${item?.sourceLabel || ""} ${item?.mangaTitle || item?.title || ""}`.toLowerCase();
  return label.includes("manhwa18") || label.includes("manhwa18.cc");
}

async function selectLibraryManga(item, resume) {
  const serverUrl = String(item.serverUrl || currentDeviceServerUrl()).trim().replace(/\/+$/, "");
  state.currentManga = {
    id: item.mangaId,
    title: item.mangaTitle,
    sourceId: item.sourceId,
    sourceLabel: item.sourceLabel,
    thumbnailUrl: item.thumbnailUrl,
    mangabakaId: item.mangabakaId,
    mangabakaTitle: item.mangabakaTitle,
    mangabakaMatchSource: item.mangabakaMatchSource,
    mangabakaAccountKey: item.mangabakaAccountKey,
    serverUrl,
  };
  if (!resume) {
    state.mangaDetailOrigin = "library";
    setActiveView("browse", { history: false });
    showMangaDetail(state.currentManga, item.sourceLabel, { origin: "library" });
  }
  updateReaderNav();
  el.mangaId.value = item.mangaId;
  el.chapterId.value = item.chapterId || "";
  el.chapterTitle.textContent = item.chapterTitle || item.mangaTitle || "Selected manga";
  state.pendingResume = resume ? item : null;
  if (resume) {
    setActiveView("reader");
    const findReadyDevicePackage = async () => {
      const direct = devicePackageForChapter(item.chapterId, serverUrl);
      if (direct?.status === "ready") return direct;
      return (await devicePackagesForManga(item.mangaId, serverUrl)).find((entry) => (
        Number(entry.chapterId) === Number(item.chapterId) && entry.status === "ready"
      ));
    };
    if (!navigator.onLine) {
      const chapterPackage = await findReadyDevicePackage();
      if (!chapterPackage || chapterPackage.status !== "ready") {
        throw new Error("This chapter has not been saved on this device. Reconnect to download it.");
      }
      await openDeviceChapter(chapterPackage, item);
      return;
    }
    await loadChapterPages({ chapter: item, serverUrl, skipLibraryEnsure: true, fastResume: true });
    const liveChapterLoaded = state.activeChapter?.type === "suwayomi"
      && Number(state.activeChapter.chapterId) === Number(item.chapterId)
      && String(state.activeChapter.serverUrl || currentDeviceServerUrl()).trim().replace(/\/+$/, "") === serverUrl
      && state.pages.length > 0;
    if (!liveChapterLoaded) {
      const chapterPackage = await findReadyDevicePackage();
      if (chapterPackage) await openDeviceChapter(chapterPackage, item);
    }
    void fetchChapters({ background: true, serverUrl });
    return;
  }
  if (!navigator.onLine) {
    handleBrowserOffline();
    await fetchChapters({ serverUrl });
    return;
  }
  await fetchChapters({ serverUrl });
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
  await hydrateImportedReadingProgress(mangas);
  saveLibraryItems();
  renderLibrary();
  if (announce) {
    setSyncStatus("Synced", `${mangas.length} Suwayomi library title${mangas.length === 1 ? "" : "s"} available in Panels.`, "good");
    showToast("Library refreshed from Suwayomi.");
  }
  return mangas.length;
}

async function hydrateImportedReadingProgress(mangas) {
  const candidates = mangas.slice(0, 60);
  const updates = new Map();
  const existingItems = new Map(state.libraryItems.map((item) => [libraryItemKey(item), item]));
  const offlineWindows = new Map();
  await mapWithConcurrency(candidates, 3, async (manga) => {
    try {
      const data = await graphQL(queries.storedChapters, { mangaId: Number(manga.id) }, { timeoutMs: 10000 });
      const nodes = data.chapters?.nodes || [];
      let active = nodes
        .filter((chapter) => !chapter.isRead && Number(chapter.lastPageRead) > 0)
        .sort((a, b) => Number(b.chapterNumber ?? b.sourceOrder ?? 0) - Number(a.chapterNumber ?? a.sourceOrder ?? 0))[0];
      if (!active) {
        const highestRead = nodes
          .filter((chapter) => chapter.isRead)
          .sort((a, b) => Number(b.chapterNumber ?? b.sourceOrder ?? 0) - Number(a.chapterNumber ?? a.sourceOrder ?? 0))[0];
        if (highestRead) {
          const readOrder = Number(highestRead.chapterNumber ?? highestRead.sourceOrder ?? -Infinity);
          active = nodes
            .filter((chapter) => !chapter.isRead && Number(chapter.chapterNumber ?? chapter.sourceOrder ?? Infinity) > readOrder)
            .sort((a, b) => Number(a.chapterNumber ?? a.sourceOrder ?? 0) - Number(b.chapterNumber ?? b.sourceOrder ?? 0))[0];
        }
      }
      const started = nodes.some((chapter) => chapter.isRead || Number(chapter.lastPageRead) > 0);
      const key = libraryItemKey({ mangaId: manga.id, sourceId: manga.sourceId });
      const existing = existingItems.get(key);
      const resumeChapterId = existing?.chapterId || active?.id;
      offlineWindows.set(key, offlineWindowForStoredChapters(nodes, resumeChapterId));
      updates.set(key, { chapter: active, started });
    } catch {
      // One title should not block the rest of the library reconciliation.
    }
  });
  state.libraryOfflineWindows = offlineWindows;
  updateLibraryOfflineReadiness();
  if (!updates.size) return;
  state.libraryItems = state.libraryItems.map((item) => {
    const update = updates.get(libraryItemKey(item));
    if (!update) return item;
    const inferredStatus = item.statusExplicit
      ? normalizedLibraryStatus(item)
      : (update.started ? "reading" : "plan_to_read");
    if ((item.chapterId && Date.parse(item.updatedAt || 0) > 0) || !update.chapter) {
      return { ...item, started: update.started, libraryStatus: inferredStatus };
    }
    const chapter = update.chapter;
    return {
      ...item,
      started: update.started,
      libraryStatus: inferredStatus,
      chapterId: Number(chapter.id),
      chapterTitle: chapter.name || `Chapter ${chapter.chapterNumber || chapter.sourceOrder || chapter.id}`,
      pageIndex: Math.max(0, Number(chapter.lastPageRead) || 0),
      panelIndex: 0,
      progressLabel: `Page ${Math.max(0, Number(chapter.lastPageRead) || 0) + 1}`,
      updatedAt: new Date().toISOString(),
    };
  });
}

async function syncLibraryAndProgress() {
  setBusy(el.syncProgress, true, "Syncing");
  try {
    const count = await syncSuwayomiLibrary();
    const progressSynced = await syncSuwayomiProgress({ manual: true }).catch(() => false);
    const mangabakaMatched = await matchMangaBakaLibrary().catch(() => 0);
    setSyncStatus(
      progressSynced ? "Synced" : "Partial",
      `${count} Suwayomi title${count === 1 ? "" : "s"} refreshed${progressSynced ? " and current progress sent" : ""}${mangabakaMatched ? `; ${mangabakaMatched} linked to MangaBaka` : ""}.`,
      progressSynced ? "good" : "bad"
    );
    showToast(progressSynced ? "Suwayomi library and progress synced." : "Library synced, but progress is still queued.", progressSynced ? "good" : "bad");
  } catch (error) {
    setSyncStatus("Sync failed", friendlySourceErrorMessage(error), "bad");
  } finally {
    setBusy(el.syncProgress, false);
  }
}

function hideReaderError({ restoreFocus = true } = {}) {
  if (el.readerError) el.readerError.hidden = true;
  state.readerErrorRetryAction = null;
  syncReaderInteractionIsolation();
  if (restoreFocus) restoreReaderModalFocus();
}

function hideReaderComplete({ restoreFocus = true } = {}) {
  if (el.readerComplete) el.readerComplete.hidden = true;
  syncReaderInteractionIsolation();
  if (restoreFocus) restoreReaderModalFocus();
}

function showReaderError(title, message, retryAction = null) {
  if (!el.readerError) return;
  el.readerErrorTitle.textContent = title;
  el.readerErrorMessage.textContent = message;
  state.readerErrorRetryAction = typeof retryAction === "function" ? retryAction : null;
  if (el.readerErrorBack) {
    const destination = state.previousView === "browse" ? "Browse" : state.previousView === "settings" ? "Settings" : "Library";
    el.readerErrorBack.textContent = `Back to ${destination}`;
  }
  openReaderModal(el.readerError);
  setReaderChromeVisible(true);
  requestAnimationFrame(() => el.readerErrorRetry?.focus({ preventScroll: true }));
}

async function retryReaderError() {
  const retryAction = state.readerErrorRetryAction;
  const previousTitle = el.readerErrorTitle?.textContent || "Could not continue reading";
  hideReaderError();
  setBusy(el.readerErrorRetry, true, "Retrying");
  try {
    if (retryAction) {
      await retryAction();
    } else {
      await loadChapterPages();
    }
  } catch (error) {
    showReaderError(previousTitle, friendlySourceErrorMessage(error), retryAction);
  } finally {
    setBusy(el.readerErrorRetry, false);
  }
}

function showReaderComplete(message = "There isn’t another chapter ready from this release group.") {
  if (!el.readerComplete) return;
  el.readerCompleteMessage.textContent = message;
  const isSuwayomi = state.activeChapter?.type === "suwayomi";
  const hasNextChapter = isSuwayomi && Boolean(nextSuwayomiChapterAfter(state.activeChapter.chapterId));
  el.readerCompleteNext.hidden = !hasNextChapter;
  if (el.readerCompleteRefresh) el.readerCompleteRefresh.hidden = !isSuwayomi || hasNextChapter;
  openReaderModal(el.readerComplete);
  setReaderChromeVisible(true);
  el.readerCompleteChapters?.focus({ preventScroll: true });
}

function showReaderTapHintOnce() {
  if (!el.readerTapHint || !isReaderFocusAvailable()) return;
  try {
    if (localStorage.getItem(tapHintStoreKey)) return;
  } catch {
    return;
  }
  openReaderModal(el.readerTapHint);
  setReaderChromeVisible(true);
  el.readerTapHintClose?.focus({ preventScroll: true });
}

function dismissReaderTapHint() {
  if (el.readerTapHint) el.readerTapHint.hidden = true;
  syncReaderInteractionIsolation();
  restoreReaderModalFocus();
  try {
    localStorage.setItem(tapHintStoreKey, "1");
  } catch {
    // The hint may reappear if storage is unavailable.
  }
}

function cancelReaderLoading() {
  const cancelAction = state.readerLoadingCancelAction;
  if (cancelAction) {
    state.readerLoadingCancelAction = null;
    cancelAction();
    return;
  }
  abortActiveReaderLoad();
  cancelReaderNavigation();
  setReaderLoading(false);
  leaveReaderView();
}

async function refreshCompletedChapterList() {
  setBusy(el.readerCompleteRefresh, true, "Refreshing");
  try {
    await fetchChapters({
      background: true,
      liveOnly: true,
      serverUrl: state.activeChapter?.serverUrl || state.currentManga?.serverUrl || currentDeviceServerUrl(),
    });
    const hasNext = state.activeChapter?.type === "suwayomi" && Boolean(nextSuwayomiChapterAfter(state.activeChapter.chapterId));
    showReaderComplete(hasNext
      ? "A new chapter is ready."
      : "You’re caught up. No later chapter is available from this release group yet.");
  } finally {
    setBusy(el.readerCompleteRefresh, false);
  }
}

function openCurrentChapterList() {
  hideReaderComplete();
  setActiveView("browse");
  if (state.currentManga) {
    showMangaDetail(state.currentManga, state.currentManga.sourceLabel);
    renderChapters();
    void fetchChapters({ background: true, serverUrl: state.currentManga.serverUrl || currentDeviceServerUrl() });
  }
}

function scheduleReadingProgressPersistence({ delayMs = 420 } = {}) {
  window.clearTimeout(state.progressPersistTimer);
  if (state.progressPersistIdleCallback && "cancelIdleCallback" in window) {
    window.cancelIdleCallback(state.progressPersistIdleCallback);
    state.progressPersistIdleCallback = 0;
  }
  state.progressPersistTimer = window.setTimeout(() => {
    state.progressPersistTimer = 0;
    const persist = () => {
      state.progressPersistIdleCallback = 0;
      rememberReadingProgress();
    };
    if ("requestIdleCallback" in window) {
      state.progressPersistIdleCallback = window.requestIdleCallback(persist, { timeout: 800 });
    } else {
      persist();
    }
  }, Math.max(0, delayMs));
}

function flushScheduledReadingProgress() {
  if (!state.progressPersistTimer && !state.progressPersistIdleCallback) return;
  window.clearTimeout(state.progressPersistTimer);
  state.progressPersistTimer = 0;
  if (state.progressPersistIdleCallback && "cancelIdleCallback" in window) {
    window.cancelIdleCallback(state.progressPersistIdleCallback);
    state.progressPersistIdleCallback = 0;
  }
  rememberReadingProgress();
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
    mangabakaId: state.currentManga.mangabakaId || existing?.mangabakaId,
    mangabakaTitle: state.currentManga.mangabakaTitle || existing?.mangabakaTitle,
    mangabakaMatchSource: state.currentManga.mangabakaMatchSource || existing?.mangabakaMatchSource,
    mangabakaAccountKey: state.currentManga.mangabakaAccountKey || existing?.mangabakaAccountKey,
    started: true,
    libraryStatus: existing?.libraryStatus === "completed" ? "rereading" : "reading",
    statusExplicit: Boolean(existing?.statusExplicit),
    isNsfw: isNsfwSource(source) || isNsfwLibraryItem(state.currentManga),
    hidden: false,
    pinned: Boolean(existing?.pinned),
    chapterId: Number(state.activeChapter.chapterId),
    chapterTitle: el.chapterTitle.textContent,
    pageIndex: state.pageIndex,
    panelIndex: state.panelIndex,
    panelMode: state.panelMode,
    readingDirection: state.readingDirection,
    serverUrl: state.activeChapter.serverUrl || currentDeviceServerUrl(),
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
  enqueueMangaBakaLibraryItem(item);
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
  enqueueCurrentSuwayomiProgress();
  window.clearTimeout(state.suwayomiSyncTimer);
  state.suwayomiSyncTimer = window.setTimeout(() => {
    flushSuwayomiProgressOutbox().catch(() => {});
  }, 700);
}

async function syncSuwayomiProgress({ completed = false, manual = false } = {}) {
  const chapterId = Number(state.activeChapter?.chapterId);
  if (state.activeChapter?.type !== "suwayomi" || !Number.isInteger(chapterId)) {
    if (!state.suwayomiProgressOutbox.length) {
      if (manual) setSyncStatus("Not reading", "Open a Suwayomi chapter before syncing.", "bad");
      return false;
    }
  } else {
    enqueueCurrentSuwayomiProgress({ completed });
  }
  return flushSuwayomiProgressOutbox({ manual });
}

function enqueueCurrentSuwayomiProgress({ completed = false } = {}) {
  const chapterId = Number(state.activeChapter?.chapterId);
  if (state.activeChapter?.type !== "suwayomi" || !Number.isInteger(chapterId)) return false;
  const serverUrl = String(state.activeChapter.serverUrl || currentDeviceServerUrl()).trim().replace(/\/+$/, "");
  const chapter = state.activeChapter.chapter
    || state.chapters.find((item) => Number(item.id) === chapterId);
  const localPage = completed
    ? Math.max(0, state.chapterPageUrls.length - 1)
    : currentSuwayomiPageIndex();
  const lastPageRead = Math.max(localPage, Number(chapter?.lastPageRead) || 0);
  const existing = state.suwayomiProgressOutbox.find((item) => (
    item.chapterId === chapterId && item.serverUrl === serverUrl
  ));
  if (existing) {
    existing.lastPageRead = Math.max(existing.lastPageRead, lastPageRead);
    existing.completed = existing.completed || completed;
    existing.updatedAt = Date.now();
  } else {
    state.suwayomiProgressOutbox.push({ serverUrl, chapterId, lastPageRead, completed, updatedAt: Date.now() });
  }
  persistSuwayomiProgressOutbox();
  return true;
}

function loadSuwayomiProgressOutbox() {
  try {
    const stored = JSON.parse(localStorage.getItem(progressOutboxStoreKey) || "[]");
    state.suwayomiProgressOutbox = Array.isArray(stored)
      ? stored.filter((item) => Number.isInteger(Number(item.chapterId))).map((item) => ({
          chapterId: Number(item.chapterId),
          serverUrl: String(item.serverUrl || currentDeviceServerUrl()).trim().replace(/\/+$/, ""),
          lastPageRead: Math.max(0, Number(item.lastPageRead) || 0),
          completed: Boolean(item.completed),
          updatedAt: Number(item.updatedAt) || Date.now(),
        }))
      : [];
  } catch {
    state.suwayomiProgressOutbox = [];
  }
}

function persistSuwayomiProgressOutbox() {
  try {
    localStorage.setItem(progressOutboxStoreKey, JSON.stringify(state.suwayomiProgressOutbox));
  } catch {
    // The queue remains in memory if storage is unavailable.
  }
}

async function flushSuwayomiProgressOutbox({ manual = false } = {}) {
  if (state.suwayomiSyncPromise) {
    if (!manual) return false;
    await state.suwayomiSyncPromise.catch(() => false);
    if (!state.suwayomiProgressOutbox.length) return true;
  }
  if (!state.suwayomiProgressOutbox.length) return true;

  state.suwayomiSyncing = true;
  setSyncStatus("Syncing", `Sending ${state.suwayomiProgressOutbox.length} queued progress update${state.suwayomiProgressOutbox.length === 1 ? "" : "s"}…`);
  const request = (async () => {
    const queued = state.suwayomiProgressOutbox.map((entry) => ({ ...entry }));
    const failures = [];
    const failedKeys = new Set();
    for (const sent of queued) {
      const patch = sent.completed ? { lastPageRead: sent.lastPageRead, isRead: true } : { lastPageRead: sent.lastPageRead };
      let data;
      try {
        data = await graphQL(
          queries.updateChapter,
          { input: { id: sent.chapterId, patch } },
          { timeoutMs: 10000, baseUrl: sent.serverUrl },
        );
      } catch (error) {
        failures.push(error);
        failedKeys.add(`${sent.serverUrl}:${sent.chapterId}`);
        continue;
      }
      const updated = data.updateChapter?.chapter;
      const chapter = sent.serverUrl === currentDeviceServerUrl()
        ? state.chapters.find((item) => Number(item.id) === sent.chapterId)
        : null;
      if (chapter && updated) Object.assign(chapter, updated);
      const current = state.suwayomiProgressOutbox.find((item) => (
        item.chapterId === sent.chapterId && item.serverUrl === sent.serverUrl
      ));
      if (current && current.lastPageRead <= sent.lastPageRead && (!current.completed || sent.completed)) {
        state.suwayomiProgressOutbox = state.suwayomiProgressOutbox.filter((item) => item !== current);
      }
      state.lastSuwayomiSyncKey = `${sent.serverUrl}:${sent.chapterId}:${sent.lastPageRead}:${sent.completed ? "read" : "progress"}`;
      persistSuwayomiProgressOutbox();
    }
    const followupNeeded = state.suwayomiProgressOutbox.some((entry) => (
      !failedKeys.has(`${entry.serverUrl}:${entry.chapterId}`)
    ));
    if (followupNeeded) {
      window.clearTimeout(state.suwayomiSyncTimer);
      state.suwayomiSyncTimer = window.setTimeout(() => {
        void flushSuwayomiProgressOutbox().catch(() => false);
      }, 0);
    }
    if (failures.length) throw failures[0];
    return true;
  })();
  state.suwayomiSyncPromise = request;
  try {
    await request;
    setSyncStatus("Synced", "Latest reading progress sent to Suwayomi.", "good");
    return true;
  } catch (error) {
    persistSuwayomiProgressOutbox();
    setSyncStatus("Queued", `Progress is saved and will retry: ${friendlySourceErrorMessage(error)}`, "bad");
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
    enqueueCurrentSuwayomiProgress({ completed: true });
    void flushSuwayomiProgressOutbox().catch(() => false);
    completeMangaBakaChapter();
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

function downloadBufferStatusText(status) {
  const active = Number(status?.activeChapterId) || 0;
  const queued = Number(status?.queued) || 0;
  const failed = Number(status?.failedInWindow ?? status?.failed) || 0;
  const retrying = Number(status?.retrying) || 0;
  const queuedFresh = Number(status?.queuedFresh ?? Math.max(0, queued - retrying));
  const total = Number(status?.windowSize) || 0;
  const downloaded = Number(status?.downloaded) || 0;
  const panelReady = Number(status?.panelReady) || 0;
  const known = Boolean(status?.downloadStateKnown);
  const nextAttemptAt = Number(status?.nextAttemptAt) || 0;
  const waitMs = Math.max(0, nextAttemptAt * 1000 - Date.now());
  const parts = [];

  if (known && total) parts.push(`${downloaded}/${total} downloaded`);
  if (active) parts.push("downloading now");
  if (retrying) parts.push(`${retrying} retrying`);
  if (queuedFresh) parts.push(`${queuedFresh} queued`);
  if (failed) parts.push(`${failed} failed`);
  if (!active && (retrying || queuedFresh) && waitMs > 1000) {
    parts.push(`next retry in about ${Math.max(1, Math.ceil(waitMs / 60000))} min`);
  }
  if (known && total && downloaded === total) {
    parts.length = 0;
    parts.push(`all ${total} chapters downloaded`);
    parts.push(panelReady === total ? "panels prepared" : `${panelReady}/${total} panels prepared`);
  }
  if (!parts.length && queued) parts.push(`${queued} queued`);
  if (!parts.length) return "Server chapter buffer: no chapters are currently queued.";
  return `Server chapter buffer: ${parts.join(" · ")}.`;
}

function setDownloadStatusSheet(open) {
  const nextOpen = Boolean(open && el.downloadStatusButton && !el.downloadStatusButton.hidden);
  state.downloadStatusSheetOpen = nextOpen;
  if (el.downloadStatusSheet) el.downloadStatusSheet.hidden = !nextOpen;
  if (el.downloadStatusBackdrop) el.downloadStatusBackdrop.hidden = !nextOpen;
  if (el.downloadStatusButton) el.downloadStatusButton.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  document.body.classList.toggle("download-sheet-open", nextOpen);
  if (nextOpen) {
    void refreshDownloadStatus().catch(() => null);
    requestAnimationFrame(() => el.downloadStatusClose?.focus({ preventScroll: true }));
  }
}

function downloadChapterLabel(chapter) {
  if (chapter?.name) return chapter.name;
  const number = Number(chapter?.chapterNumber);
  if (Number.isFinite(number)) return `Chapter ${number}`;
  return "Chapter";
}

function downloadChapterStateLabel(chapter) {
  if (chapter?.state === "downloaded") return chapter.panelReady ? "Ready" : "Preparing panels";
  if (chapter?.state === "downloading") return "Downloading";
  if (chapter?.state === "retrying") return "Retrying";
  if (chapter?.state === "failed") return "Failed";
  if (chapter?.state === "queued") return "Queued";
  return "Pending";
}

function renderDownloadStatus(status) {
  state.downloadStatus = status || null;
  updateLibraryOfflineReadiness(status);
  if (state.activeView === "library") renderLibrary();
  if (!el.downloadStatusButton) return;
  const total = Number(status?.windowSize) || 0;
  const downloaded = Number(status?.downloaded) || 0;
  const queued = Number(status?.queuedFresh) || 0;
  const retrying = Number(status?.retrying) || 0;
  const failed = Number(status?.failedInWindow ?? status?.failed) || 0;
  const globalFailed = Number(status?.failed) || 0;
  const active = Number(status?.activeChapterId) || 0;
  const visible = Boolean(status && (total || globalFailed || Number(status?.queued) || active));
  const working = Boolean(active || queued || retrying);
  const tone = failed || globalFailed ? "bad" : (working ? "working" : "good");

  el.downloadStatusButton.hidden = !visible;
  document.body.classList.toggle("has-download-status", visible);
  if (!visible) {
    setDownloadStatusSheet(false);
    return;
  }

  el.downloadStatusButton.dataset.tone = tone;
  el.downloadStatusLabel.textContent = tone === "bad"
    ? "Downloads need attention"
    : (working ? "Preparing server chapters" : "Server chapters ready");
  el.downloadStatusCount.textContent = total ? `${downloaded}/${total} ready` : (globalFailed ? `${globalFailed} failed` : "Checking…");
  el.downloadStatusButton.setAttribute("aria-label", `${el.downloadStatusLabel.textContent}, ${el.downloadStatusCount.textContent}. Open details.`);

  const chapters = Array.isArray(status?.windowChapters) ? status.windowChapters : [];
  const mangaTitle = chapters.find((chapter) => chapter.mangaTitle)?.mangaTitle || "";
  if (el.downloadStatusTitle) el.downloadStatusTitle.textContent = mangaTitle ? `${mangaTitle} downloads` : "Chapter downloads";
  if (el.downloadStatusSummary) {
    el.downloadStatusSummary.textContent = downloadBufferStatusText(status).replace(/^Server chapter buffer:\s*/i, "");
  }
  if (el.downloadProgressTrack) {
    el.downloadProgressTrack.setAttribute("aria-valuemax", String(Math.max(1, total)));
    el.downloadProgressTrack.setAttribute("aria-valuenow", String(downloaded));
  }
  if (el.downloadProgressBar) el.downloadProgressBar.style.width = `${total ? Math.min(100, (downloaded / total) * 100) : 0}%`;
  if (el.downloadStatDownloaded) el.downloadStatDownloaded.textContent = String(downloaded);
  if (el.downloadStatQueued) el.downloadStatQueued.textContent = String(queued + (active ? 1 : 0));
  if (el.downloadStatRetrying) el.downloadStatRetrying.textContent = String(retrying);
  if (el.downloadStatFailed) el.downloadStatFailed.textContent = String(failed || globalFailed);

  if (el.downloadChapterList) {
    el.downloadChapterList.replaceChildren();
    chapters.forEach((chapter) => {
      const row = document.createElement("div");
      row.className = "download-chapter-row";
      row.dataset.state = chapter.state || "pending";
      const marker = document.createElement("span");
      marker.className = "download-chapter-state";
      marker.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "download-chapter-copy";
      const title = document.createElement("strong");
      title.textContent = downloadChapterLabel(chapter);
      const source = document.createElement("small");
      source.textContent = [chapter.mangaTitle, chapter.sourceLabel].filter(Boolean).join(" · ") || "Suwayomi";
      const badge = document.createElement("span");
      badge.className = "download-chapter-badge";
      badge.textContent = downloadChapterStateLabel(chapter);
      copy.append(title, source);
      row.append(marker, copy, badge);
      el.downloadChapterList.append(row);
    });
  }

  const issue = chapters.find((chapter) => chapter.lastError)?.lastError || status?.statusError || "";
  if (el.downloadStatusIssue) {
    el.downloadStatusIssue.hidden = !issue;
    el.downloadStatusIssue.textContent = issue ? `Latest issue: ${friendlySourceErrorMessage(issue)}` : "";
  }
  if (el.downloadStatusRetry) el.downloadStatusRetry.hidden = globalFailed < 1;
}

async function ensureDownloadAhead(chapterId) {
  const candidates = downloadAheadChapters(chapterId);
  const chapters = candidates;
  if (!chapters.length) {
    if (el.offlineNote) el.offlineNote.textContent = "Server chapter buffer: no later chapters are available yet.";
    return;
  }

  const ids = chapters.map((chapter) => Number(chapter.id));
  if (el.offlineNote) el.offlineNote.textContent = `Server chapter buffer: sending ${ids.length} chapter${ids.length === 1 ? "" : "s"} to the background queue…`;
  try {
    const status = await postLocalJson("/api/download-buffer", { chapterIds: ids });
    renderDownloadStatus(status);
    if (el.offlineNote) el.offlineNote.textContent = downloadBufferStatusText(status);
  } catch (error) {
    if (el.offlineNote) el.offlineNote.textContent = `Server chapter buffer will retry when this title is opened again: ${friendlySourceErrorMessage(error)}`;
  }
}

function releaseDecodedImage(image) {
  if (!image) return;
  image.onload = null;
  image.onerror = null;
  try {
    image.src = "";
  } catch {
    // Some test doubles and already-detached images expose a readonly source.
  }
}

function releaseReaderPageImages(pages, { preservePage = null } = {}) {
  (pages || []).forEach((page) => {
    if (!page || page === preservePage) return;
    if (page.image) releaseDecodedImage(page.image);
    page.image = null;
    if (Array.isArray(page.sourceImages)) {
      page.sourceImages.forEach((item) => releaseDecodedImage(item?.image));
      page.sourceImages = [];
    }
    page.renderRecoveryController?.abort(readerAbortError("Chapter image was released."));
    page.renderRecoveryController = null;
    page.renderRecoveryPromise = null;
  });
}

function readerDecodedImageCap() {
  const memory = Number(navigator.deviceMemory || 4);
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (connection?.saveData || memory <= 2) return 2;
  if (memory <= 4) return 3;
  return 5;
}

function trimReaderMemory({ aggressive = false } = {}) {
  const cap = aggressive ? 1 : readerDecodedImageCap();
  const keep = new Set([state.pageIndex]);
  for (let distance = 1; keep.size < cap; distance += 1) {
    const next = state.pageIndex + distance;
    const previous = state.pageIndex - distance;
    if (next < state.pages.length) keep.add(next);
    if (keep.size < cap && previous >= 0) keep.add(previous);
    if (next >= state.pages.length && previous < 0) break;
  }
  state.pages.forEach((page, index) => {
    if (page?.stripImages) {
      trimWebtoonSourceImages(page, { aggressive });
      return;
    }
    if (keep.has(index)) return;
    if (page?.image) releaseDecodedImage(page.image);
    if (page) page.image = null;
  });
  return {
    cap,
    retained: state.pages.reduce((count, page) => count + (page?.image ? 1 : 0), 0),
    metadataPages: state.pages.filter((page) => page?.detected).length,
  };
}

function releasePrefetchedChapter(record) {
  if (!record) return;
  record.controller?.abort(readerAbortError("Chapter prefetch was cancelled."));
  const prepared = record.preparedValue;
  if (prepared?.preparedPages) releaseReaderPageImages(prepared.preparedPages);
  else if (record.preparedPages) releaseReaderPageImages(record.preparedPages);
  if (prepared?.firstImage && !prepared.preparedPages?.some((page) => page.image === prepared.firstImage)) {
    releaseDecodedImage(prepared.firstImage);
  }
}

function clearNextChapterPrefetch({ release = true } = {}) {
  window.clearTimeout(state.nextChapterPrefetchTimer);
  state.nextChapterPrefetchTimer = null;
  if (release) releasePrefetchedChapter(state.nextChapterPrefetch);
  state.nextChapterPrefetch = null;
}

function scheduleNextChapterPrefetch(generation = state.prepareGeneration, delayMs = 900) {
  if (state.activeChapter?.type !== "suwayomi" || state.activeChapter.deviceLocal || !navigator.onLine) return;
  const fromChapterId = Number(state.activeChapter.chapterId);
  const serverUrl = state.activeChapter.serverUrl || currentDeviceServerUrl();
  const chapter = nextSuwayomiChapterAfter(fromChapterId);
  if (!chapter) return;

  const existing = state.nextChapterPrefetch;
  if (
    existing?.generation === generation &&
    existing.fromChapterId === fromChapterId &&
    existing.chapterId === Number(chapter.id) &&
    existing.serverUrl === serverUrl
  ) return existing;

  window.clearTimeout(state.nextChapterPrefetchTimer);

  const record = {
    generation,
    fromChapterId,
    chapterId: Number(chapter.id),
    serverUrl,
    chapter,
    promise: null,
    status: "scheduled",
    attempts: 0,
    error: "",
    urlsReady: false,
    firstImageReady: false,
    firstPanelReady: false,
    controller: new AbortController(),
    preparedValue: null,
    preparedPages: null,
  };
  state.nextChapterPrefetch = record;
  state.nextChapterPrefetchTimer = window.setTimeout(() => {
    if (state.nextChapterPrefetch !== record || generation !== state.prepareGeneration) return;
    startNextChapterPrefetch(record);
  }, Math.max(0, delayMs));
  return record;
}

function startNextChapterPrefetch(record) {
  if (!record || record.promise) return record?.promise || null;
  record.status = "loading";
  record.attempts += 1;
  record.promise = prefetchSuwayomiChapter(record)
    .then((prepared) => {
      record.status = prepared ? "ready" : "stale";
      record.preparedValue = prepared;
      return prepared;
    })
    .catch((error) => {
      record.status = "failed";
      record.error = friendlySourceErrorMessage(error);
      return null;
    });
  return record.promise;
}

async function prefetchSuwayomiChapter(record) {
  const signal = record.controller?.signal;
  const data = await fetchChapterPagePayload(record.chapterId, { baseUrl: record.serverUrl, signal });
  if (state.nextChapterPrefetch !== record || record.generation !== state.prepareGeneration) return null;
  const chapterPayload = data.fetchChapterPages?.chapter;
  const sourcePages = await resolveChapterPages(data.fetchChapterPages, { quiet: true });
  if (!sourcePages.length) throw new Error("Source returned no readable page URLs.");
  const pageUrls = sourcePages.map((pageUrl) => normalizeSuwayomiPageUrl(pageUrl, record.serverUrl));
  record.urlsReady = true;
  const entries = makeChapterPageEntries(pageUrls);
  record.preparedPages = entries;
  const firstImage = await loadImage(pageUrls[0], { signal });
  record.firstImageReady = true;
  const isCurrent = () => (
    state.nextChapterPrefetch === record &&
    record.generation === state.prepareGeneration &&
    !signal?.aborted
  );
  if (!isCurrent()) {
    releaseDecodedImage(firstImage);
    return null;
  }
  const mode = detectPanelModeFromImage(firstImage, activeChapterSourceLabel()) || state.panelMode;

  if (mode !== "webtoon") {
    await preparePageEntry(entries[0], 0, entries.length, {
      mode,
      direction: state.readingDirection,
      quiet: true,
      image: firstImage,
      signal,
      isCurrent,
    });
    record.firstPanelReady = true;
    const rest = entries.slice(1, nextChapterPreparedPageCount);
    rest.forEach((page) => {
      const preparation = preparePageEntry(page, page.index, entries.length, {
        mode,
        direction: state.readingDirection,
        quiet: true,
        signal,
        isCurrent,
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

function currentDeviceServerUrl() {
  return String(el.serverUrl?.value || state.baseUrl || "http://localhost:4567")
    .trim()
    .replace(/\/+$/, "");
}

function currentDeviceChapterKey(chapterId) {
  try {
    return deviceChapterKey(currentDeviceServerUrl(), chapterId);
  } catch {
    return "";
  }
}

function devicePackageForChapter(chapterId, serverUrl = currentDeviceServerUrl()) {
  let key = "";
  try {
    key = deviceChapterKey(serverUrl, chapterId);
  } catch {
    key = "";
  }
  return key ? state.deviceChapters.get(key) || null : null;
}

function rememberDevicePackage(chapterPackage) {
  if (!chapterPackage?.key) return;
  state.deviceChapters.set(chapterPackage.key, chapterPackage);
  if (state.deviceStorageRefreshPromise) state.deviceStorageRefreshRequested = true;
}

async function refreshDeviceChapterWorkerCapability({ render = true } = {}) {
  const controller = navigator.serviceWorker?.controller;
  const generation = state.deviceChapterWorkerGeneration + 1;
  state.deviceChapterWorkerGeneration = generation;
  state.deviceChapterWorkerChecked = false;
  state.deviceChapterWorkerReady = false;
  state.deviceChapterWorkerController = null;
  let supported = false;
  if (controller && typeof MessageChannel === "function") {
    supported = await new Promise((resolveCapability) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => resolveCapability(false), 1500);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        resolveCapability(event.data?.supported === true && Number(event.data?.version) >= 1);
      };
      try {
        controller.postMessage({ type: "DEVICE_CHAPTER_CAPABILITY" }, [channel.port2]);
      } catch {
        window.clearTimeout(timeout);
        resolveCapability(false);
      }
    });
  }
  if (generation !== state.deviceChapterWorkerGeneration || navigator.serviceWorker?.controller !== controller) {
    return false;
  }
  state.deviceChapterWorkerChecked = true;
  state.deviceChapterWorkerReady = supported;
  state.deviceChapterWorkerController = supported ? controller : null;
  if (render && el.chapterList?.children.length) renderChapters();
  return supported;
}

async function requireDeviceChapterWorker() {
  if (state.deviceChapterWorkerReady && state.deviceChapterWorkerController === navigator.serviceWorker?.controller) return true;
  if (await refreshDeviceChapterWorkerCapability()) return true;
  if (panelPilotServiceWorkerRegistration?.waiting) {
    showAppUpdate();
  } else {
    setAppUpdateMessage("Offline chapter support needs a reload after the service worker finishes installing.");
  }
  throw new Error("Apply the waiting Panels update, or reload once after installation, before using device chapters.");
}

async function initializeDeviceChapterState() {
  try {
    await initializeDeviceChapters();
    const chapters = await listDeviceChapters();
    state.deviceChapters = new Map(chapters.map((chapter) => [chapter.key, chapter]));
    state.deviceChaptersReady = true;
    state.deviceChapterError = "";
  } catch (error) {
    state.deviceChaptersReady = false;
    state.deviceChapterError = error?.message || "Device chapter storage is unavailable.";
    console.warn("Panels device chapter storage is unavailable.", error);
  }
  if (el.chapterList?.children.length) renderChapters();
}

function formatStorageBytes(value, fallback = "Size unavailable") {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return fallback;
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const amount = bytes / (1024 ** unitIndex);
  const digits = unitIndex === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

function deviceStoragePackageState(chapterPackage) {
  const completed = Number(chapterPackage.downloadedPages) || 0;
  const total = Number(chapterPackage.totalPages || chapterPackage.pageUrls?.length) || 0;
  if (chapterPackage.status === "ready") return "Ready";
  if (chapterPackage.status === "downloading" || chapterPackage.status === "preparing") return `Saving ${completed}/${total}`;
  if (chapterPackage.status === "paused") return `Partial ${completed}/${total}`;
  if (chapterPackage.status === "failed") return `Failed ${completed}/${total}`;
  if (chapterPackage.status === "removing") return "Removing";
  return chapterPackage.status || "Incomplete";
}

function safeDeviceServerLabel(chapterPackage) {
  const source = String(chapterPackage.sourceLabel || "").trim();
  let host = "Suwayomi server";
  try {
    host = new URL(chapterPackage.serverUrl).host || host;
  } catch {
    // Never show raw, potentially credential-bearing server text.
  }
  return source && source !== host ? `${source} · ${host}` : source || host;
}

function activeDeviceReaderPackageKey() {
  return state.activeView === "reader" && state.activeChapter?.type === "suwayomi" && state.activeChapter.deviceLocal
    ? String(state.activeChapter.devicePackageKey || "")
    : "";
}

function deviceStoragePackageSelectable(chapterPackage) {
  if (!chapterPackage?.key || chapterPackage.status === "removing") return false;
  if (["preparing", "downloading"].includes(chapterPackage.status)) return false;
  if (state.deviceDownloadControllers.has(chapterPackage.key)) return false;
  return chapterPackage.key !== activeDeviceReaderPackageKey();
}

function deviceStoragePackages() {
  return Array.isArray(state.deviceStorageSnapshot?.packages)
    ? state.deviceStorageSnapshot.packages
    : [...state.deviceChapters.values()];
}

function updateDeviceStorageSelectionControls() {
  const packages = deviceStoragePackages();
  const selectable = packages.filter(deviceStoragePackageSelectable);
  const selectableKeys = new Set(selectable.map((chapterPackage) => chapterPackage.key));
  state.deviceStorageSelection = new Set([...state.deviceStorageSelection].filter((key) => selectableKeys.has(key)));
  const selectedCount = state.deviceStorageSelection.size;
  if (el.deviceStorageSelectedCount) {
    el.deviceStorageSelectedCount.textContent = `${selectedCount} selected`;
  }
  if (el.deviceStorageRemoveSelected) {
    el.deviceStorageRemoveSelected.disabled = selectedCount < 1 || state.deviceStorageRemoving;
    el.deviceStorageRemoveSelected.textContent = selectedCount ? `Remove selected (${selectedCount})` : "Remove selected";
  }
  if (el.deviceStorageSelectAll) {
    const allSelected = selectable.length > 0 && selectable.every((chapterPackage) => state.deviceStorageSelection.has(chapterPackage.key));
    if (el.deviceStorageSelectAll instanceof HTMLInputElement) {
      el.deviceStorageSelectAll.checked = allSelected;
      el.deviceStorageSelectAll.indeterminate = selectedCount > 0 && !allSelected;
      el.deviceStorageSelectAll.disabled = selectable.length < 1 || state.deviceStorageRemoving;
    } else {
      el.deviceStorageSelectAll.textContent = allSelected ? "Clear selection" : "Select all";
      el.deviceStorageSelectAll.setAttribute("aria-pressed", allSelected ? "true" : "false");
      el.deviceStorageSelectAll.disabled = selectable.length < 1 || state.deviceStorageRemoving;
    }
  }
}

function renderDeviceStorage() {
  if (!el.deviceStorageList || !el.deviceStorageSummary) return;
  const snapshot = state.deviceStorageSnapshot;
  const packages = deviceStoragePackages();
  el.deviceStorageList.replaceChildren();

  if (state.deviceStorageError) {
    if (el.deviceStorageState) el.deviceStorageState.textContent = "Unavailable";
    el.deviceStorageSummary.textContent = `Device storage could not be inspected: ${state.deviceStorageError}`;
    if (el.deviceStorageProgress) el.deviceStorageProgress.hidden = true;
    if (el.deviceStorageOriginNote) el.deviceStorageOriginNote.textContent = "The online reader remains available.";
    if (el.deviceStorageRetentionNote) el.deviceStorageRetentionNote.textContent = "Storage protection could not be checked.";
    if (el.deviceStoragePersist) el.deviceStoragePersist.hidden = true;
    if (el.deviceStorageManager) el.deviceStorageManager.open = false;
    updateDeviceStorageSelectionControls();
    return;
  }

  if (!snapshot) {
    if (el.deviceStorageState) el.deviceStorageState.textContent = "Checking…";
    el.deviceStorageSummary.textContent = "Checking chapters saved on this device…";
    if (el.deviceStorageProgress) el.deviceStorageProgress.hidden = true;
    if (el.deviceStoragePersist) el.deviceStoragePersist.hidden = true;
    updateDeviceStorageSelectionControls();
    return;
  }

  const packageCount = Number(snapshot.packageCount ?? packages.length) || 0;
  const storedBytes = Number(snapshot.storedBytes);
  const readyCount = Number(snapshot.readyCount) || 0;
  const partialCount = Number(snapshot.partialCount) || 0;
  if (el.deviceStorageState) el.deviceStorageState.textContent = `${packageCount} chapter${packageCount === 1 ? "" : "s"}`;
  el.deviceStorageSummary.dataset.bytes = Number.isFinite(storedBytes) ? String(storedBytes) : "";
  el.deviceStorageSummary.textContent = `${packageCount} chapter${packageCount === 1 ? "" : "s"} saved · ${formatStorageBytes(storedBytes)}`;

  const origin = snapshot.origin || {};
  const usageBytes = Number(origin.usageBytes);
  const quotaBytes = Number(origin.quotaBytes);
  const hasEstimate = origin.supported && Number.isFinite(usageBytes) && usageBytes >= 0 && Number.isFinite(quotaBytes) && quotaBytes > 0;
  if (el.deviceStorageProgress) {
    el.deviceStorageProgress.hidden = !hasEstimate;
    if (hasEstimate) {
      el.deviceStorageProgress.max = quotaBytes;
      el.deviceStorageProgress.value = Math.min(usageBytes, quotaBytes);
      el.deviceStorageProgress.dataset.usageBytes = String(usageBytes);
      el.deviceStorageProgress.dataset.quotaBytes = String(quotaBytes);
    }
  }
  if (el.deviceStorageOriginNote) {
    el.deviceStorageOriginNote.textContent = hasEstimate
      ? `Browser storage: about ${formatStorageBytes(usageBytes)} of ${formatStorageBytes(quotaBytes)} used by this site. Chapter media accounts for ${formatStorageBytes(storedBytes)}.`
      : origin.error
        ? "Browser-wide storage estimate is unavailable. Chapter media totals remain available."
        : "This browser does not expose a whole-site storage estimate.";
  }

  const persistence = snapshot.persistence || {};
  if (el.deviceStorageRetentionNote) {
    el.deviceStorageRetentionNote.textContent = persistence.persisted
      ? "Protected from automatic browser cleanup."
      : persistence.supported
        ? "Your browser may remove downloads when storage is low."
        : "Storage retention is managed by this browser; Panels will detect missing pages and offer repair.";
  }
  if (el.deviceStoragePersist) {
    el.deviceStoragePersist.hidden = !persistence.requestSupported || Boolean(persistence.persisted);
    el.deviceStoragePersist.disabled = state.deviceStorageRemoving;
  }

  if (!packages.length) {
    const empty = document.createElement("p");
    empty.className = "note device-storage-empty";
    empty.textContent = "No chapters are saved on this device yet.";
    el.deviceStorageList.append(empty);
    if (el.deviceStorageManager && !el.deviceStorageManager.dataset.initialized) el.deviceStorageManager.open = false;
  } else {
    const groups = new Map();
    packages.forEach((chapterPackage) => {
      const groupKey = `${chapterPackage.serverUrl || "server"}\u0000${chapterPackage.mangaId || "manga"}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(chapterPackage);
    });
    groups.forEach((groupPackages) => {
      const first = groupPackages[0];
      const group = document.createElement("fieldset");
      group.className = "device-storage-group";
      const legend = document.createElement("legend");
      const groupTitle = document.createElement("strong");
      groupTitle.textContent = first.title || `Manga ${first.mangaId || ""}`.trim();
      const groupMeta = document.createElement("span");
      const groupBytes = groupPackages.reduce((sum, chapterPackage) => sum + deviceChapterStoredBytes(chapterPackage), 0);
      groupMeta.textContent = `${safeDeviceServerLabel(first)} · ${groupPackages.length} chapter${groupPackages.length === 1 ? "" : "s"} · ${formatStorageBytes(groupBytes)}`;
      legend.append(groupTitle, groupMeta);
      group.append(legend);

      groupPackages.forEach((chapterPackage) => {
        const row = document.createElement("div");
        row.className = "device-storage-row";
        row.dataset.deviceStorageRow = "";
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.deviceStorageSelect = "";
        const selectable = deviceStoragePackageSelectable(chapterPackage);
        checkbox.disabled = !selectable || state.deviceStorageRemoving;
        checkbox.checked = state.deviceStorageSelection.has(chapterPackage.key);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) state.deviceStorageSelection.add(chapterPackage.key);
          else state.deviceStorageSelection.delete(chapterPackage.key);
          updateDeviceStorageSelectionControls();
        });
        const copy = document.createElement("span");
        copy.className = "device-storage-row-copy";
        const title = document.createElement("strong");
        title.textContent = chapterPackage.chapterTitle || `Chapter ${chapterPackage.chapterNumber || chapterPackage.chapterId}`;
        const meta = document.createElement("small");
        const bytes = deviceChapterStoredBytes(chapterPackage);
        row.dataset.bytes = String(bytes);
        const restriction = chapterPackage.key === activeDeviceReaderPackageKey()
          ? "Open in reader · close it before removing"
          : state.deviceDownloadControllers.has(chapterPackage.key)
            ? "Pause this download before removing it"
            : "";
        meta.textContent = [deviceStoragePackageState(chapterPackage), formatStorageBytes(bytes), restriction].filter(Boolean).join(" · ");
        copy.append(title, meta);
        label.append(checkbox, copy);
        row.append(label);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "mini-button danger-button";
        remove.dataset.deviceStorageRemove = "";
        remove.textContent = "Remove";
        remove.disabled = !selectable || state.deviceStorageRemoving;
        remove.setAttribute("aria-label", `Remove ${title.textContent} from this device`);
        remove.addEventListener("click", () => openDeviceStorageRemovalDialog([chapterPackage.key], remove));
        row.append(remove);
        group.append(row);
      });
      el.deviceStorageList.append(group);
    });
    if (el.deviceStorageManager && !el.deviceStorageManager.dataset.initialized) el.deviceStorageManager.open = true;
  }
  if (el.deviceStorageManager) el.deviceStorageManager.dataset.initialized = "true";
  if (el.deviceStorageOriginNote && (readyCount || partialCount)) {
    el.deviceStorageOriginNote.dataset.packageBreakdown = `${readyCount} ready, ${partialCount} partial`;
  }
  updateDeviceStorageSelectionControls();
}

function announceDeviceStorage(message, tone = "") {
  if (!el.deviceStorageResult) return;
  el.deviceStorageResult.textContent = message;
  el.deviceStorageResult.dataset.tone = tone;
}

async function refreshDeviceStorage({ announce = false, reconcile = false } = {}) {
  state.deviceStorageRefreshRequested = true;
  state.deviceStorageRefreshAnnounce ||= announce;
  state.deviceStorageReconcileRequested ||= reconcile;
  if (state.deviceStorageRefreshPromise) return state.deviceStorageRefreshPromise;
  if (!state.deviceStorageSnapshot && !state.deviceStorageError) renderDeviceStorage();
  const request = (async () => {
    let latestSnapshot = null;
    while (state.deviceStorageRefreshRequested) {
      const announceThisRefresh = state.deviceStorageRefreshAnnounce;
      const reconcileThisRefresh = state.deviceStorageReconcileRequested;
      state.deviceStorageRefreshRequested = false;
      state.deviceStorageRefreshAnnounce = false;
      state.deviceStorageReconcileRequested = false;
      try {
        const snapshot = await getDeviceChapterStorageSnapshot({ reconcile: reconcileThisRefresh });
        state.deviceStorageSnapshot = snapshot;
        state.deviceStorageError = "";
        const packages = Array.isArray(snapshot.packages) ? snapshot.packages : [];
        state.deviceChapters = new Map(packages.map((chapterPackage) => [chapterPackage.key, chapterPackage]));
        state.deviceChaptersReady = true;
        state.deviceChapterError = "";
        renderDeviceStorage();
        if (el.chapterList?.children.length) renderChapters();
        if (announceThisRefresh) announceDeviceStorage("Device storage refreshed.", "good");
        latestSnapshot = snapshot;
      } catch (error) {
        state.deviceStorageError = error?.message || "Device storage is unavailable.";
        renderDeviceStorage();
        if (announceThisRefresh) announceDeviceStorage(`Could not refresh device storage: ${state.deviceStorageError}`, "bad");
        latestSnapshot = null;
      }
    }
    return latestSnapshot;
  })();
  state.deviceStorageRefreshPromise = request;
  try {
    return await request;
  } finally {
    if (state.deviceStorageRefreshPromise === request) state.deviceStorageRefreshPromise = null;
  }
}

async function refreshDeviceStorageFromControl() {
  if (!el.deviceStorageRefresh) return;
  setBusy(el.deviceStorageRefresh, true, "Refreshing");
  el.deviceStoragePanel?.setAttribute("aria-busy", "true");
  announceDeviceStorage("Refreshing device storage…");
  try {
    await refreshDeviceStorage({ announce: true, reconcile: true });
  } finally {
    setBusy(el.deviceStorageRefresh, false);
    el.deviceStoragePanel?.removeAttribute("aria-busy");
  }
}

async function protectDeviceStorage() {
  if (!el.deviceStoragePersist) return;
  setBusy(el.deviceStoragePersist, true, "Requesting");
  try {
    const result = await requestDeviceChapterPersistence();
    if (result.error) {
      announceDeviceStorage(`Storage protection could not be requested: ${result.error.message}`, "bad");
    } else {
      announceDeviceStorage(result.persisted
        ? "Downloads are protected from automatic browser cleanup."
        : result.requestSupported
          ? "Storage protection was not granted. Panels will keep detecting and repairing missing pages."
          : "Storage protection is managed by this browser.", result.persisted ? "good" : "");
    }
  } catch (error) {
    announceDeviceStorage(`Storage protection could not be requested: ${error.message}`, "bad");
  } finally {
    setBusy(el.deviceStoragePersist, false);
    await refreshDeviceStorage();
  }
}

function deviceStorageSelectionKeys() {
  return [...state.deviceStorageSelection].filter((key) => {
    const chapterPackage = deviceStoragePackages().find((item) => item.key === key);
    return chapterPackage && deviceStoragePackageSelectable(chapterPackage);
  });
}

function setAllDeviceStorageSelection() {
  const selectable = deviceStoragePackages().filter(deviceStoragePackageSelectable);
  const allSelected = selectable.length > 0 && selectable.every((chapterPackage) => state.deviceStorageSelection.has(chapterPackage.key));
  state.deviceStorageSelection = allSelected ? new Set() : new Set(selectable.map((chapterPackage) => chapterPackage.key));
  renderDeviceStorage();
}

function closeDeviceStorageDialog({ force = false } = {}) {
  if (state.deviceStorageRemoving && !force) return;
  if (el.deviceStorageDialog?.open) el.deviceStorageDialog.close();
  const returnFocus = state.deviceStorageReturnFocus;
  state.deviceStorageReturnFocus = null;
  requestAnimationFrame(() => returnFocus?.isConnected
    ? returnFocus.focus({ preventScroll: true })
    : el.deviceStorageManager?.querySelector("input:not(:disabled), summary")?.focus({ preventScroll: true }));
}

function openDeviceStorageRemovalDialog(keys = deviceStorageSelectionKeys(), returnFocus = document.activeElement) {
  const keySet = new Set(keys);
  const packages = deviceStoragePackages().filter((chapterPackage) => keySet.has(chapterPackage.key) && deviceStoragePackageSelectable(chapterPackage));
  if (!packages.length) {
    announceDeviceStorage("Select at least one removable chapter.", "bad");
    return;
  }
  state.deviceStoragePendingRemoval = packages.map((chapterPackage) => chapterPackage.key);
  state.deviceStorageReturnFocus = returnFocus;
  el.deviceStorageDialog?.removeAttribute("aria-busy");
  if (el.deviceStorageCancel) el.deviceStorageCancel.disabled = false;
  const bytes = packages.reduce((sum, chapterPackage) => sum + deviceChapterStoredBytes(chapterPackage), 0);
  if (el.deviceStorageDialogDescription) {
    el.deviceStorageDialogDescription.textContent = `Remove ${packages.length} chapter${packages.length === 1 ? "" : "s"} (${formatStorageBytes(bytes)}) from this device. Reading progress and copies on the Suwayomi server are not affected.`;
  }
  if (el.deviceStorageConfirm) el.deviceStorageConfirm.textContent = `Remove ${packages.length} chapter${packages.length === 1 ? "" : "s"}`;
  if (typeof el.deviceStorageDialog?.showModal === "function") {
    el.deviceStorageDialog.showModal();
    requestAnimationFrame(() => el.deviceStorageCancel?.focus({ preventScroll: true }));
  }
}

function failedDeviceRemovalKey(failure) {
  if (failure?.key) return failure.key;
  const reference = failure?.ref || failure?.reference || failure;
  try {
    return deviceChapterKey(reference.serverUrl, reference.chapterId);
  } catch {
    return "";
  }
}

async function confirmDeviceStorageRemoval() {
  if (state.deviceStorageRemoving) return;
  const keySet = new Set(state.deviceStoragePendingRemoval);
  const packages = deviceStoragePackages().filter((chapterPackage) => keySet.has(chapterPackage.key) && deviceStoragePackageSelectable(chapterPackage));
  if (!packages.length) {
    closeDeviceStorageDialog();
    return;
  }
  state.deviceStorageRemoving = true;
  el.deviceStorageDialog?.setAttribute("aria-busy", "true");
  if (el.deviceStorageCancel) el.deviceStorageCancel.disabled = true;
  renderDeviceStorage();
  setBusy(el.deviceStorageConfirm, true, "Removing");
  try {
    const result = await removeDeviceChapters(packages.map((chapterPackage) => ({
      key: chapterPackage.key,
      serverUrl: chapterPackage.serverUrl,
      chapterId: chapterPackage.chapterId,
    })));
    const failed = Array.isArray(result.failed) ? result.failed : [];
    const failedKeys = new Set(failed.map(failedDeviceRemovalKey).filter(Boolean));
    state.deviceStorageSelection = failedKeys;
    const removedCount = Array.isArray(result.removed) ? result.removed.length : Number(result.removed) || 0;
    announceDeviceStorage(failed.length
      ? `${removedCount} chapter${removedCount === 1 ? "" : "s"} removed. ${failed.length} could not be removed and remain selected.`
      : `${removedCount} chapter${removedCount === 1 ? "" : "s"} removed from this device.`, failed.length ? "bad" : "good");
  } catch (error) {
    announceDeviceStorage(`Chapters could not be removed: ${error.message}`, "bad");
  } finally {
    state.deviceStoragePendingRemoval = [];
    await refreshDeviceStorage();
    state.deviceStorageRemoving = false;
    el.deviceStorageDialog?.removeAttribute("aria-busy");
    if (el.deviceStorageCancel) el.deviceStorageCancel.disabled = false;
    setBusy(el.deviceStorageConfirm, false);
    renderDeviceStorage();
    closeDeviceStorageDialog({ force: true });
  }
}

function devicePackageAsChapter(chapterPackage) {
  return {
    id: Number(chapterPackage.chapterId),
    name: chapterPackage.chapterTitle || `Chapter ${chapterPackage.chapterNumber || chapterPackage.chapterId}`,
    mangaId: Number(chapterPackage.mangaId),
    scanlator: chapterPackage.scanlator || "",
    sourceOrder: Number(chapterPackage.chapterOrder ?? chapterPackage.chapterNumber ?? 0),
    chapterNumber: Number(chapterPackage.chapterNumber ?? chapterPackage.chapterOrder ?? 0),
    pageCount: Number(chapterPackage.totalPages || chapterPackage.pageUrls?.length || 0),
    savedChapter: true,
    deviceLocal: true,
    serverUrl: chapterPackage.serverUrl,
  };
}

async function devicePackagesForManga(mangaId, serverUrl = currentDeviceServerUrl()) {
  if (!state.deviceChaptersReady) await initializeDeviceChapterState();
  if (!state.deviceChaptersReady) {
    throw new Error(state.deviceChapterError || "Device chapter storage is unavailable.");
  }
  const chapters = await listDeviceChaptersForManga(serverUrl, mangaId);
  chapters.forEach(rememberDevicePackage);
  return chapters;
}

async function openDeviceChapter(chapterPackage, resumeItem = null) {
  const pageUrls = deviceChapterPageUrls(chapterPackage);
  if (!pageUrls.length) throw new Error("This device copy is incomplete. Resume its download while online.");
  await requireDeviceChapterWorker();

  const chapter = devicePackageAsChapter(chapterPackage);
  state.currentManga = {
    id: Number(chapterPackage.mangaId),
    title: chapterPackage.title,
    sourceId: chapterPackage.sourceId,
    sourceLabel: chapterPackage.sourceLabel,
    thumbnailUrl: chapterPackage.thumbnailUrl,
    mangabakaId: resumeItem?.mangabakaId,
    mangabakaTitle: resumeItem?.mangabakaTitle,
    mangabakaMatchSource: resumeItem?.mangabakaMatchSource,
    mangabakaAccountKey: resumeItem?.mangabakaAccountKey,
    serverUrl: chapterPackage.serverUrl,
  };
  el.mangaId.value = chapter.mangaId;
  el.chapterId.value = chapter.id;
  el.chapterTitle.textContent = chapter.name;
  state.pendingResume = resumeItem || currentMangaLibraryItem();
  state.activeChapter = {
    type: "suwayomi",
    chapterId: chapter.id,
    chapter,
    deviceLocal: true,
    devicePackageKey: chapterPackage.key,
    serverUrl: chapterPackage.serverUrl,
  };
  await loadChapter(pageUrls.map(appUrl), chapter.name);
  rememberReadingProgress();
  setConnection(state.connected, `Opened ${pageUrls.length} pages saved on this device.`, "good");
}

async function chapterDownloadDescriptor(chapter, signal, serverUrl, manga) {
  const chapterId = Number(chapter.id);
  const data = await fetchChapterPagePayload(chapterId, { timeoutMs: 15000, signal, baseUrl: serverUrl });
  const serverChapter = data.fetchChapterPages?.chapter;
  const pages = await resolveChapterPages(data.fetchChapterPages);
  if (!pages.length) throw new Error("Source returned no readable page URLs.");
  return {
    serverUrl,
    chapterId,
    mangaId: Number(manga?.id || chapter.mangaId),
    title: manga?.title || "",
    sourceId: manga?.sourceId,
    sourceLabel: manga?.sourceLabel || "",
    thumbnailUrl: manga?.thumbnailUrl || "",
    chapterTitle: chapter.name || serverChapter?.name || `Chapter ${chapterId}`,
    chapterNumber: chapter.chapterNumber,
    chapterOrder: chapter.sourceOrder,
    scanlator: chapter.scanlator,
    pageUrls: pages.map((pageUrl) => normalizeSuwayomiPageUrl(pageUrl, serverUrl)),
  };
}

async function downloadChapterToDevice(chapter) {
  if (!navigator.onLine) {
    showToast("Reconnect to save or resume this chapter.", "bad");
    return;
  }
  const serverUrl = chapter.serverUrl || currentDeviceServerUrl();
  const manga = state.currentManga ? { ...state.currentManga } : null;
  const key = deviceChapterKey(serverUrl, chapter.id);
  if (!key || state.deviceDownloadControllers.has(key)) return;
  try {
    await requireDeviceChapterWorker();
  } catch (error) {
    showToast(error.message, "bad");
    return;
  }
  const controller = new AbortController();
  state.deviceDownloadControllers.set(key, controller);
  const existing = state.deviceChapters.get(key);
  rememberDevicePackage({
    ...(existing || {}),
    key,
    chapterId: Number(chapter.id),
    mangaId: Number(manga?.id || chapter.mangaId),
    chapterTitle: chapter.name,
    status: "preparing",
  });
  renderChapters();
  let transientFailure = null;
  try {
    const descriptor = await chapterDownloadDescriptor(chapter, controller.signal, serverUrl, manga);
    const downloaded = await downloadDeviceChapter(descriptor, {
      signal: controller.signal,
      onProgress(progress) {
        rememberDevicePackage(progress.chapter);
        renderChapters();
      },
    });
    rememberDevicePackage(downloaded);
    showToast(`${downloaded.chapterTitle || "Chapter"} is ready offline.`, "good");
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      showToast("Chapter download paused.");
    } else {
      transientFailure = {
        ...(state.deviceChapters.get(key) || existing || {}),
        key,
        chapterId: Number(chapter.id),
        mangaId: Number(manga?.id || chapter.mangaId),
        chapterTitle: chapter.name,
        status: "failed",
        error: {
          code: error?.name === "QuotaExceededError" ? "quota-exceeded" : "download-failed",
          message: error?.message || "Device download failed.",
        },
      };
      showToast(`Could not save chapter: ${friendlySourceErrorMessage(error)}`, "bad");
    }
  } finally {
    state.deviceDownloadControllers.delete(key);
    await initializeDeviceChapterState();
    if (transientFailure && !state.deviceChapters.has(key)) rememberDevicePackage(transientFailure);
    renderChapters();
    await refreshDeviceStorage();
  }
}

function pauseDeviceChapterDownload(chapterId, packageKey = "") {
  const controller = state.deviceDownloadControllers.get(packageKey || currentDeviceChapterKey(chapterId));
  if (controller) controller.abort();
}

async function removeChapterFromDevice(chapter) {
  const serverUrl = chapter.serverUrl || currentDeviceServerUrl();
  const key = deviceChapterKey(serverUrl, chapter.id);
  const chapterPackage = key ? state.deviceChapters.get(key) : null;
  if (!chapterPackage) return;
  if (key === activeDeviceReaderPackageKey()) {
    showToast("Close this offline chapter before removing it from the device.", "bad");
    return;
  }
  rememberDevicePackage({ ...chapterPackage, status: "removing" });
  renderChapters();
  try {
    await removeDeviceChapter(chapterPackage.serverUrl, chapter.id);
    state.deviceChapters.delete(key);
    showToast(`${chapterPackage.chapterTitle || "Chapter"} removed from this device.`);
  } catch (error) {
    showToast(`Could not remove chapter: ${error.message}`, "bad");
    await initializeDeviceChapterState();
  }
  renderChapters();
  await refreshDeviceStorage();
}

async function fetchChapters(options = {}) {
  const background = Boolean(options.background);
  const liveOnly = Boolean(options.liveOnly);
  const serverUrl = options.serverUrl || "";
  const sourceServerUrl = serverUrl || currentDeviceServerUrl();
  const requestOptions = (timeoutMs) => ({ timeoutMs, ...(serverUrl ? { baseUrl: serverUrl } : {}) });
  const mangaId = Number(el.mangaId.value);
  if (!Number.isInteger(mangaId) || mangaId < 1) {
    setConnection(state.connected, "Enter a Suwayomi manga ID first.", "bad");
    return;
  }

  if (!navigator.onLine) {
    try {
      const devicePackages = await devicePackagesForManga(mangaId, serverUrl || currentDeviceServerUrl());
      setChapterList(devicePackages.map(devicePackageAsChapter), sourceServerUrl);
      updateScanlatorOptions();
      renderChapters();
      if (devicePackages.length) {
        setConnection(false, `${devicePackages.length} chapter${devicePackages.length === 1 ? "" : "s"} available from this device.`, "good");
      } else {
        renderChapterError("No chapters for this title have been saved on this device yet.");
      }
    } catch (error) {
      renderChapterError(`Device chapters could not be opened: ${error.message}`);
    }
    return;
  }

  if (!background) {
    setBusy(el.fetchChapters, true, "Fetching");
    renderChapterSkeletons();
  }
  if (!liveOnly) {
    const cached = await graphQL(queries.storedChapters, { mangaId }, requestOptions(10000)).catch(() => null);
    const savedChapters = cached?.chapters?.nodes || [];
    if (savedChapters.length) {
      setChapterList(savedChapters.map((chapter) => ({ ...chapter, savedChapter: true })), sourceServerUrl);
      updateScanlatorOptions();
      renderChapters();
      resumeBackgroundChapterWork();
      setConnection(true, `Opened ${state.chapters.length} saved chapters; refreshing quietly.`, "good");
      if (!background) setBusy(el.fetchChapters, false);
      void fetchChapters({ background: true, liveOnly: true, serverUrl: sourceServerUrl });
      return;
    }
  }
  try {
    const data = await graphQL(queries.fetchChapters, { input: { mangaId } }, requestOptions(undefined));
    const liveChapters = data.fetchChapters?.chapters || [];
    const cached = await graphQL(queries.storedChapters, { mangaId }, requestOptions(10000)).catch(() => null);
    setChapterList(mergeChapterLists(liveChapters, cached?.chapters?.nodes || []), sourceServerUrl);
    updateScanlatorOptions();
    renderChapters();
    resumeBackgroundChapterWork();
    setConnection(true, `Loaded ${state.chapters.length} chapters.`, "good");
  } catch (error) {
    const message = chapterFetchErrorMessage(error);
    try {
      const cached = await graphQL(queries.storedChapters, { mangaId }, requestOptions(15000));
      setChapterList(cached.chapters?.nodes || [], sourceServerUrl);
      if (!state.chapters.length) throw error;
      updateScanlatorOptions();
      renderChapters();
      resumeBackgroundChapterWork();
      setConnection(true, `Source refresh paused; using ${state.chapters.length} saved chapters.`, "");
    } catch {
      if (!background) {
        try {
          const devicePackages = await devicePackagesForManga(mangaId, serverUrl || currentDeviceServerUrl());
          if (devicePackages.length) {
            setChapterList(devicePackages.map(devicePackageAsChapter), sourceServerUrl);
            updateScanlatorOptions();
            renderChapters();
            setConnection(false, `Suwayomi is unavailable; showing ${devicePackages.length} chapter${devicePackages.length === 1 ? "" : "s"} saved on this device.`, "good");
            return;
          }
        } catch (storageError) {
          console.warn("Panels could not inspect device chapters after a server failure.", storageError);
        }
      }
      setConnection(state.connected, `Could not fetch chapters: ${message}`, "bad");
      if (!background) renderChapterError(message);
    }
  } finally {
    if (!background) setBusy(el.fetchChapters, false);
  }
}

function resumeBackgroundChapterWork() {
  if (state.activeChapter?.type !== "suwayomi" || state.activeChapter.deviceLocal || !navigator.onLine) return;
  if ((state.activeChapter.serverUrl || currentDeviceServerUrl()) === currentDeviceServerUrl()) {
    void ensureDownloadAhead(state.activeChapter.chapterId);
  }
  if (!state.nextChapterPrefetch) scheduleNextChapterPrefetch(state.prepareGeneration, 250);
}

function setChapterList(chapters, serverUrl = currentDeviceServerUrl()) {
  state.chapters = chapters.map((chapter) => ({
    ...chapter,
    serverUrl: chapter.serverUrl || serverUrl,
  })).sort((a, b) => {
    const aOrder = Number(a.sourceOrder ?? a.chapterNumber ?? 0);
    const bOrder = Number(b.sourceOrder ?? b.chapterNumber ?? 0);
    return bOrder - aOrder;
  });
}

function mergeChapterLists(primary, fallback) {
  const merged = new Map();
  fallback.forEach((chapter) => merged.set(Number(chapter.id), { ...chapter, savedChapter: true }));
  primary.forEach((chapter) => merged.set(Number(chapter.id), { ...merged.get(Number(chapter.id)), ...chapter, savedChapter: false }));
  return [...merged.values()];
}

function applyNavigationHistory(event) {
  const fromHash = routeFromLocation();
  const target = event.state?.panelPilot ? event.state : {
    view: fromHash.view || "library",
    detail: fromHash.detail,
    manga: fromHash.manga,
    origin: fromHash.origin,
  };
  state.historyApplying = true;
  try {
    setActiveView(isAppView(target.view) ? target.view : "library", { history: false });
    if (target.view === "browse" && target.detail && (target.manga || state.currentManga)) {
      if (target.manga) {
        state.currentManga = { ...target.manga };
        state.mangaDetailOrigin = target.origin || "browse";
        el.mangaId.value = target.manga.id;
      }
      showMangaDetail(state.currentManga, state.currentManga.sourceLabel, { history: false });
      void fetchChapters();
    } else if (!el.mangaDetail?.hidden) {
      closeMangaDetail({ history: false });
    }
  } finally {
    state.historyApplying = false;
  }
}

async function restoreInitialRoute() {
  const route = state.initialRoute;
  if (!route) return;
  if (route.view === "reader") {
    await openReaderFromNav();
    return;
  }
  if (route.detail && route.manga) {
    state.currentManga = { ...route.manga };
    state.mangaDetailOrigin = route.origin || "browse";
    el.mangaId.value = route.manga.id;
    showMangaDetail(route.manga, route.manga.sourceLabel, { history: false });
    await fetchChapters();
  }
}

async function restoreInitialRouteOffline() {
  const route = state.initialRoute;
  if (!route) return;
  if (route.view === "reader") {
    setActiveView("reader", { history: false });
    await openReaderFromNav();
    if ((!state.activeChapter || !state.pages.length) && el.readerError?.hidden) {
      showReaderError(
        "This chapter is not available offline",
        "Reconnect to Panels, then download the chapter to this device for offline reading.",
        reconnectPanelPilot
      );
    }
  } else if (route.detail && route.manga) {
    await fetchChapters();
  }
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

function deviceChapterStatus(chapterPackage) {
  if (!chapterPackage && state.deviceChapterError) return { state: "unavailable", label: "Device storage unavailable" };
  if (!chapterPackage && !state.deviceChaptersReady) return { state: "preparing", label: "Preparing device storage…" };
  if (!chapterPackage && !state.deviceChapterWorkerChecked) return { state: "none", label: "Preparing offline support…" };
  if (!chapterPackage && !state.deviceChapterWorkerReady) return { state: "none", label: "Apply app update for device downloads" };
  if (!chapterPackage) return { state: "none", label: "Not saved to device" };
  const completed = Number(chapterPackage.downloadedPages) || 0;
  const total = Number(chapterPackage.totalPages || chapterPackage.pageUrls?.length) || 0;
  const size = deviceChapterStoredBytes(chapterPackage);
  const sizeLabel = size > 0 ? ` · ${formatStorageBytes(size)}` : "";
  if (chapterPackage.status === "preparing") return { state: "preparing", label: "Preparing download…" };
  if (chapterPackage.status === "downloading") return { state: "downloading", label: `Saving ${completed}/${total}${sizeLabel}` };
  if (chapterPackage.status === "paused") return { state: "paused", label: `Partial ${completed}/${total}${sizeLabel}` };
  if (chapterPackage.status === "failed") {
    const quota = chapterPackage.error?.code === "quota-exceeded";
    return { state: "failed", label: quota ? `Storage full${sizeLabel} · retry` : `Incomplete ${completed}/${total}${sizeLabel} · retry` };
  }
  if (chapterPackage.status === "ready") return { state: "ready", label: `On this device${sizeLabel}` };
  if (chapterPackage.status === "removing") return { state: "removing", label: "Removing…" };
  return { state: "none", label: "Not saved to device" };
}

function renderChapters() {
  const focusedControl = document.activeElement?.closest?.("#chapter-list [data-chapter-id] button");
  const focusedChapterId = focusedControl?.closest("[data-chapter-id]")?.dataset.chapterId || "";
  const focusedAction = focusedControl?.dataset.deviceAction || focusedControl?.dataset.chapterAction || "";
  el.chapterList.replaceChildren();
  state.chapterView = visibleChapters();
  updateMangaDetailActions();
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
    item.dataset.chapterId = String(chapter.id);
    const copy = document.createElement("div");
    copy.className = "chapter-device-copy";
    const title = document.createElement("strong");
    title.textContent = chapter.name || `Chapter ${chapter.chapterNumber || chapter.sourceOrder || chapter.id}`;
    title.id = `chapter-title-${chapter.id}`;
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
      chapter.isDownloaded ? "On Suwayomi server" : "",
      chapter.savedChapter && !chapter.isDownloaded ? "Saved metadata" : "",
      progress,
    ].filter(Boolean).join(" · ") || "Ready to read";
    copy.append(title, meta);

    const chapterServerUrl = chapter.serverUrl || currentDeviceServerUrl();
    const chapterPackage = devicePackageForChapter(chapter.id, chapterServerUrl);
    const deviceStatus = deviceChapterStatus(chapterPackage);
    const actions = document.createElement("div");
    actions.className = "chapter-actions";
    const status = document.createElement("span");
    status.className = "device-chapter-status";
    status.dataset.deviceChapterState = deviceStatus.state;
    status.textContent = deviceStatus.label;
    status.id = `device-chapter-status-${chapter.id}`;
    actions.append(status);

    const button = document.createElement("button");
    button.type = "button";
    const deviceReady = chapterPackage?.status === "ready";
    const deviceReadable = deviceReady && state.deviceChapterWorkerReady;
    button.dataset.chapterAction = "read";
    if (deviceReadable) button.dataset.deviceAction = "open";
    button.textContent = deviceReadable
      ? "Read offline"
      : chapter.isRead
        ? "Read again"
        : Number(chapter.lastPageRead) > 0
          ? "Resume"
          : "Read";
    button.setAttribute("aria-label", `${button.textContent} ${title.textContent}`);
    button.setAttribute("aria-describedby", status.id);
    button.disabled = !navigator.onLine && !deviceReadable;
    button.addEventListener("click", async () => {
      el.chapterId.value = chapter.id;
      el.chapterTitle.textContent = title.textContent;
      if (chapterPackage?.status === "ready" && state.deviceChapterWorkerReady) {
        await openDeviceChapter(chapterPackage, currentMangaLibraryItem()).catch((error) => {
          showToast(`Could not open device chapter: ${error.message}`, "bad");
        });
      } else if (navigator.onLine) {
        await loadChapterPages({
          serverUrl: chapterServerUrl,
          skipLibraryEnsure: chapterServerUrl !== currentDeviceServerUrl(),
        });
      } else {
        showToast("This chapter has not been saved on this device.", "bad");
      }
    });
    actions.append(button);

    if (["none", "paused", "failed"].includes(deviceStatus.state)) {
      const download = document.createElement("button");
      download.type = "button";
      download.dataset.deviceAction = "download";
      download.textContent = !state.deviceChapterWorkerChecked
        ? "Preparing…"
        : !state.deviceChapterWorkerReady
          ? "Update app first"
          : deviceStatus.state === "none"
            ? "Download"
            : "Resume download";
      download.setAttribute("aria-label", `${download.textContent} ${title.textContent}`);
      download.setAttribute("aria-describedby", status.id);
      download.disabled = !navigator.onLine || !state.deviceChaptersReady || !state.deviceChapterWorkerReady;
      download.addEventListener("click", () => void downloadChapterToDevice(chapter));
      actions.append(download);
    } else if (["preparing", "downloading"].includes(deviceStatus.state)) {
      const pause = document.createElement("button");
      pause.type = "button";
      pause.dataset.deviceAction = "pause";
      pause.textContent = "Pause";
      pause.setAttribute("aria-label", `Pause download ${title.textContent}`);
      pause.setAttribute("aria-describedby", status.id);
      pause.addEventListener("click", () => pauseDeviceChapterDownload(chapter.id, chapterPackage?.key));
      actions.append(pause);
    }

    if (deviceStatus.state === "ready") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.deviceAction = "remove";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${title.textContent} from this device`);
      remove.setAttribute("aria-describedby", status.id);
      remove.addEventListener("click", () => {
        if (window.confirm(`Remove ${title.textContent} from this device?`)) {
          void removeChapterFromDevice(chapter);
        }
      });
      actions.append(remove);
    }

    item.append(copy, actions);
    el.chapterList.append(item);
  });

  if (focusedChapterId && focusedAction) {
    const row = [...el.chapterList.querySelectorAll("[data-chapter-id]")]
      .find((candidate) => candidate.dataset.chapterId === focusedChapterId);
    let replacement = row?.querySelector(`[data-device-action="${focusedAction}"], [data-chapter-action="${focusedAction}"]`);
    if (!replacement && focusedAction === "download") replacement = row?.querySelector('[data-device-action="pause"]');
    if (!replacement && focusedAction === "pause") replacement = row?.querySelector('[data-device-action="download"]');
    replacement?.focus({ preventScroll: true });
  }
  if (state.readerModalReturnFocusSelector) requestAnimationFrame(restoreReaderModalFocus);
}

async function loadChapterPages(options = {}) {
  const chapterId = Number(el.chapterId.value);
  const serverUrl = options.serverUrl || currentDeviceServerUrl();
  if (!Number.isInteger(chapterId) || chapterId < 1) {
    setConnection(state.connected, "Enter a Suwayomi chapter ID first.", "bad");
    return;
  }

  state.readerLoadController?.abort();
  state.prepareGeneration += 1;
  const loadController = new AbortController();
  const loadRequestId = state.readerLoadRequestId + 1;
  state.readerLoadRequestId = loadRequestId;
  state.readerLoadController = loadController;
  const loadIsCurrent = () => loadRequestId === state.readerLoadRequestId && !loadController.signal.aborted;

  rememberReaderModalFocus();
  setActiveView("reader");
  hideReaderError();
  setReaderChromeVisible(true);
  setBusy(el.loadChapterPages, true, "Loading");
  setReaderLoading(true, "Fetching chapter pages...", 12);
  try {
    if (!options.skipLibraryEnsure) {
      await ensureCurrentMangaInSuwayomiLibrary().catch(() => false);
    }
    const data = await fetchChapterPagePayload(chapterId, {
      ...(options.fastResume ? { retries: false, timeoutMs: 12000 } : {}),
      signal: loadController.signal,
      baseUrl: serverUrl,
    });
    if (!loadIsCurrent()) return;
    const chapter = data.fetchChapterPages?.chapter;
    const pages = await resolveChapterPages(data.fetchChapterPages, { isCurrent: loadIsCurrent });
    if (!loadIsCurrent()) return;
    if (!pages.length) throw new Error("Source returned no readable page URLs.");
    const listedChapter = state.chapters.find((item) => Number(item.id) === chapterId) || options.chapter || null;
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
      serverUrl,
    };
    await loadChapter(
      pages.map((pageUrl) => normalizeSuwayomiPageUrl(pageUrl, serverUrl)),
      el.chapterTitle.textContent || listedChapter?.name || chapter?.name || `Chapter ${chapterId}`,
      { requestIsCurrent: loadIsCurrent, signal: loadController.signal }
    );
    if (!loadIsCurrent()) return;
    rememberReadingProgress();
    if (serverUrl === currentDeviceServerUrl()) void ensureDownloadAhead(chapterId);
    setConnection(true, `Loaded ${pages.length} pages. Panel detection is running locally.`, "good");
  } catch (error) {
    if (error?.name === "ReaderLoadCancelled" || !loadIsCurrent()) return;
    const message = friendlySourceErrorMessage(error);
    setConnection(state.connected, `Could not load chapter pages: ${message}`, "bad");
    showReaderError("Could not open this chapter", message, () => loadChapterPages(options));
    setReaderLoading(false);
  } finally {
    if (loadRequestId === state.readerLoadRequestId) {
      state.readerLoadController = null;
      setBusy(el.loadChapterPages, false);
    }
  }
}

function fetchChapterPagePayload(chapterId, { retries = true, timeoutMs = 6000, signal = null, baseUrl = "" } = {}) {
  const delays = retries ? chapterFetchRetryDelaysMs : [0];
  return withRetry(
    () => graphQL(queries.fetchPages, { input: { chapterId } }, { timeoutMs, signal, ...(baseUrl ? { baseUrl } : {}) }),
    delays,
    { shouldRetry: isRetryableReaderError }
  );
}

function isRetryableReaderError(error) {
  const message = `${error?.message || error || ""}`.toLowerCase();
  if (/cancel|abort|unauthor|forbidden|rate limit|not found|no readable|\b4\d\d\b/.test(message)) return false;
  return /timeout|timed out|network|fetch|connection|\b5\d\d\b|temporar/.test(message) || !message;
}

async function resolveChapterPages(fetchPayload, { quiet = false, isCurrent = () => true } = {}) {
  const pages = fetchPayload?.pages || [];
  if (pages.length) return pages;

  const chapter = fetchPayload?.chapter;
  const sourceName = `${chapter?.manga?.source?.name || ""} ${chapter?.manga?.source?.displayName || ""}`;
  if (/readcomiconline/i.test(sourceName) && chapter?.realUrl) {
    if (!quiet && isCurrent()) setReaderLoading(true, "ReadComicOnline needs a local page fallback...", 18);
    const payload = await localJson(`/api/readcomiconline/chapter?url=${encodeURIComponent(chapter.realUrl)}`);
    if (isCurrent() && payload.pages?.length) {
      return payload.pages;
    }
  }

  return [];
}

async function loadChapter(pageUrls, title, options = {}) {
  const requestIsCurrent = typeof options.requestIsCurrent === "function" ? options.requestIsCurrent : () => true;
  if (!requestIsCurrent()) return;
  const generation = state.prepareGeneration + 1;
  state.prepareGeneration = generation;
  const loadIsCurrent = () => generation === state.prepareGeneration && requestIsCurrent();
  cancelReaderNavigation();
  clearNextChapterPrefetch({ release: !Array.isArray(options.preparedPages) });
  pauseReaderBackgroundWork();
  hideReaderError();
  hideReaderComplete();
  setActiveView("reader");
  setReaderLoading(true, "Preparing chapter...", 28);
  state.backgroundPreparing = false;
  state.chapterPageUrls = pageUrls.slice();
  state.pageIndex = 0;
  state.panelIndex = 0;
  state.fullPage = false;
  el.toggleFit.textContent = "Page overview";
  el.chapterTitle.textContent = title;
  el.stage.classList.add("has-image");

  try {
    setReaderLoading(true, "Checking page shape...", 24);
    const preparedPages = Array.isArray(options.preparedPages) ? options.preparedPages : null;
    const resumeMatches = state.pendingResume && Number(state.pendingResume.chapterId) === Number(state.activeChapter?.chapterId);
    const initialPageIndex = resumeMatches
      ? clamp(Number(state.pendingResume.pageIndex) || 0, 0, Math.max(0, pageUrls.length - 1))
      : 0;
    const initialImage = preparedPages?.[initialPageIndex]?.image ||
      (initialPageIndex === 0 ? options.firstImage : null) ||
      await loadImage(pageUrls[initialPageIndex], { signal: options.signal });
    if (!loadIsCurrent()) return;
    autoSelectPanelMode(initialImage);
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
    const previousPages = state.pages;
    state.pages = state.panelMode === "webtoon"
      ? []
      : reusablePreparedPages
        ? preparedPages
        : makeChapterPageEntries(pageUrls);
    if (previousPages !== state.pages) releaseReaderPageImages(previousPages);

    if (state.panelMode === "webtoon") {
      state.pages = [
        await prepareContinuousWebtoonChapter(pageUrls, generation, {
          initialCount: 2,
          initialImages: initialPageIndex === 0 ? [{ url: pageUrls[0], image: initialImage }] : [],
          signal: options.signal,
        }),
      ];
      if (!loadIsCurrent()) return;
    } else {
      setReaderLoading(true, `Preparing page ${initialPageIndex + 1} of ${state.pages.length}...`, 44);
      await preparePage(initialPageIndex, { generation, image: initialImage, isCurrent: requestIsCurrent, signal: options.signal });
      if (!loadIsCurrent()) return;
    }
    await applyPendingResume(generation, requestIsCurrent);
    if (!loadIsCurrent()) return;
    setReaderLoading(true, "Rendering reader...", 92);
    if (!loadIsCurrent()) return;
    renderCurrentPage();
    renderPanelStrip();
    updateStats();
    if (state.panelMode === "webtoon") {
      startReaderBackgroundPreparation(generation);
    } else {
      startReaderBackgroundPreparation(generation);
    }
    void syncReaderWakeLock();
    if (isReaderFocusAvailable()) {
      setReaderFocus(true);
      setReaderChromeVisible(false);
    }
    window.setTimeout(() => {
      if (loadIsCurrent()) showReaderTapHintOnce();
    }, 350);
  } finally {
    if (loadIsCurrent()) setReaderLoading(false);
  }
}

async function applyPendingResume(generation, requestIsCurrent = () => true) {
  if (generation !== state.prepareGeneration || !requestIsCurrent()) return;
  const resume = state.pendingResume;
  if (!resume || Number(resume.chapterId) !== Number(state.activeChapter?.chapterId)) return;
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
    await preparePage(pageIndex, { generation, isCurrent: requestIsCurrent });
    if (generation !== state.prepareGeneration || !requestIsCurrent()) return;
  }
  const page = state.pages[state.pageIndex];
  state.panelIndex = clamp(Number(resume.panelIndex) || 0, 0, Math.max(0, (page?.panels.length || 1) - 1));
  state.fullPage = false;
  state.pendingResume = null;
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
    backgroundAttempts: 0,
    backgroundRetryAt: 0,
    backgroundFailed: false,
  }));
}

async function preparePage(index, options = {}) {
  const force = typeof options === "boolean" ? options : Boolean(options.force);
  const quiet = typeof options === "object" && Boolean(options.quiet);
  const generation = typeof options === "object" ? options.generation : state.prepareGeneration;
  const foreground = typeof options === "object" && Boolean(options.foreground);
  const preloadedImage = typeof options === "object" ? options.image : null;
  const signal = typeof options === "object" ? options.signal || null : null;
  const requestIsCurrent = typeof options === "object" && typeof options.isCurrent === "function"
    ? options.isCurrent
    : () => true;
  const preparationIsCurrent = () => generation === state.prepareGeneration && requestIsCurrent();
  if (!preparationIsCurrent()) return null;
  const page = state.pages[index];
  const metadataReady = page?.detected && page.panelMode === state.panelMode && page.readingDirection === state.readingDirection;
  if (!page) return null;
  if (metadataReady && page.image && !force) return page;
  if (metadataReady && !page.image && !force) {
    const image = preloadedImage || await loadImage(page.url, { signal });
    if (!preparationIsCurrent()) {
      releaseDecodedImage(image);
      return null;
    }
    page.image = image;
    page.renderUrl = image.currentSrc || image.src || page.url;
    page.loadAttempts = image.panelPilotLoadAttempts || page.loadAttempts || 1;
    return page;
  }
  if (foreground && !page.preparePromise) {
    page.backgroundAttempts = 0;
    page.backgroundRetryAt = 0;
    page.backgroundFailed = false;
  }
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
    signal,
    isCurrent: preparationIsCurrent,
  }).then((preparedPage) => preparationIsCurrent() ? preparedPage : null);
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
  const preparationStarted = performance.now();
  const mode = options.mode || "manga";
  const direction = options.direction || "rtl";
  const quiet = Boolean(options.quiet);
  const isCurrent = typeof options.isCurrent === "function" ? options.isCurrent : () => true;
  const pageLabel = `page ${index + 1} of ${totalPages}`;
  const baseProgress = index === 0 ? 46 : 18;
  if (!isCurrent()) return null;
  if (!quiet) setReaderLoading(true, `Loading image for ${pageLabel}...`, baseProgress);
  const image = options.image || page.image || await loadImage(page.url, { signal: options.signal });
  if (!isCurrent()) {
    releaseDecodedImage(image);
    return null;
  }
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  const modeLabel = mode === "webtoon" ? "Detecting webtoon panels" : mode === "comic" ? "Detecting comic regions" : "Detecting panels";
  if (!quiet) setReaderLoading(true, `${modeLabel} on ${pageLabel}...`, Math.max(baseProgress + 28, 58));
  const detectedPanels =
    mode === "webtoon"
      ? makeWebtoonPanels(image)
      : mode === "comic"
        ? await detectComicPanels(image, direction).catch(() => [fullPagePanel(naturalWidth, naturalHeight)])
        : await detectPanels(image, direction, page.url).catch(() => [fullPagePanel(naturalWidth, naturalHeight)]);
  state.performanceStats.detectorRuns += 1;
  if (!isCurrent()) {
    releaseDecodedImage(image);
    return null;
  }
  if (!quiet) setReaderLoading(true, `Finishing ${pageLabel}...`, 88);
  page.loadAttempts = image.panelPilotLoadAttempts || 1;
  page.image = image;
  page.renderUrl = image.currentSrc || image.src || page.url;
  page.naturalWidth = naturalWidth;
  page.naturalHeight = naturalHeight;
  page.panels = sanitizePanels(detectedPanels, naturalWidth, naturalHeight);
  page.detected = true;
  page.panelMode = mode;
  page.readingDirection = direction;
  const elapsed = Math.max(0, performance.now() - preparationStarted);
  state.performanceStats.lastPreparationMs = Math.round(elapsed);
  state.pagePreparationDurations.push(elapsed);
  if (state.pagePreparationDurations.length > 20) state.pagePreparationDurations.shift();
  return page;
}

function pauseReaderBackgroundWork() {
  window.clearTimeout(state.backgroundPreparationTimer);
  state.backgroundPreparationTimer = 0;
  state.backgroundPreparationId += 1;
  state.backgroundWorkController?.abort(readerAbortError("Reader background work paused."));
  state.backgroundWorkController = null;
  state.backgroundPreparing = false;
}

function resetReaderVisibilityController() {
  if (state.readerVisibleController && !state.readerVisibleController.signal.aborted) return state.readerVisibleController;
  state.readerVisibleController = new AbortController();
  state.readerVisibilityEpoch += 1;
  return state.readerVisibleController;
}

function ensureActiveReaderModalFocus() {
  const modal = activeReaderOverlay();
  if (!modal || modal.contains(document.activeElement)) return;
  const target = modal.querySelector("button:not([disabled]):not([hidden]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])");
  (target || modal).focus?.({ preventScroll: true });
}

function pauseReaderLifecycle({ pageHiding = false } = {}) {
  state.readerLifecyclePaused = true;
  state.readerVisibilityEpoch += 1;
  if (state.readerVisibleController && !state.readerVisibleController.signal.aborted) {
    state.readerVisibleController.abort(visibilityInterruptedError());
  }
  state.readerVisibleController = null;
  pauseReaderBackgroundWork();
  clearNextChapterPrefetch();
  trimReaderMemory({ aggressive: true });
  flushScheduledReadingProgress();
  persistSuwayomiProgressOutbox();
  persistMangaBakaOutbox();
  void releaseReaderWakeLock();
  if (pageHiding) state.readerResumePromise = null;
}

function resumeReaderLifecycle() {
  if (!readerIsVisible()) return Promise.resolve(false);
  resetReaderVisibilityController();
  const visibilityEpoch = state.readerVisibilityEpoch;
  state.wakeLockBlocked = false;
  scheduleViewportFit();
  ensureActiveReaderModalFocus();
  void syncReaderWakeLock();
  if (state.readerResumePromise) return state.readerResumePromise;
  const previous = state.backgroundPreparationPromise;
  const resume = Promise.resolve(previous)
    .catch(() => null)
    .then(async () => {
      if (visibilityEpoch !== state.readerVisibilityEpoch || !readerIsVisible() || state.activeView !== "reader" || !state.pages.length) return false;
      await validateCurrentReaderRender();
      if (visibilityEpoch !== state.readerVisibilityEpoch || !readerIsVisible() || state.activeView !== "reader") return false;
      startReaderBackgroundPreparation(state.prepareGeneration);
      return true;
    })
    .finally(() => {
      if (state.readerResumePromise === resume) state.readerResumePromise = null;
    });
  state.readerResumePromise = resume;
  return resume;
}

function handleReaderVisibilityChange() {
  if (document.visibilityState === "hidden") {
    pauseReaderLifecycle();
    return;
  }
  state.readerLifecyclePaused = false;
  void resumeReaderLifecycle();
}

function startReaderBackgroundPreparation(generation = state.prepareGeneration) {
  if (!readerIsVisible() || state.activeView !== "reader" || generation !== state.prepareGeneration || !state.pages.length) {
    return null;
  }
  if (state.backgroundPreparing && state.backgroundPreparationPromise) return state.backgroundPreparationPromise;
  const controller = new AbortController();
  state.backgroundWorkController = controller;
  const task = state.panelMode === "webtoon"
    ? prepareWebtoonChapterInBackground(generation, controller.signal)
    : prepareChapterInBackground(generation, controller.signal);
  state.backgroundPreparationPromise = Promise.resolve(task)
    .catch((error) => {
      if (!isAbortLike(error) && error?.name !== "ReaderVisibilityInterrupted") console.warn("Reader background preparation failed", error);
      return null;
    })
    .finally(() => {
      if (state.backgroundPreparationPromise === task || state.backgroundWorkController === controller) {
        if (state.backgroundWorkController === controller) state.backgroundWorkController = null;
        state.backgroundPreparationPromise = null;
      }
    });
  return state.backgroundPreparationPromise;
}

async function prepareChapterInBackground(generation = state.prepareGeneration, signal = null) {
  window.clearTimeout(state.backgroundPreparationTimer);
  state.backgroundPreparationTimer = 0;
  const preparationId = state.backgroundPreparationId + 1;
  state.backgroundPreparationId = preparationId;
  state.backgroundPreparing = true;
  try {
    let nextChapterScheduled = false;
    while (generation === state.prepareGeneration && preparationId === state.backgroundPreparationId && !signal?.aborted) {
      if (document.visibilityState === "hidden") return;
      const currentIndex = state.pageIndex;
      const lookahead = adaptiveLookaheadPageCount();
      const indexes = state.pages
        .map((page, index) => ({ page, index }))
        .filter(({ page, index }) => (
          index > currentIndex &&
          index <= currentIndex + lookahead &&
          !isAnalyzedReaderPage(page) &&
          !page.backgroundFailed &&
          Number(page.backgroundRetryAt || 0) <= Date.now()
        ))
        .map(({ index }) => index);
      if (!indexes.length) {
        const nextRetryAt = state.pages
          .slice(currentIndex + 1, currentIndex + lookahead + 1)
          .filter((page) => !isAnalyzedReaderPage(page) && !page.backgroundFailed && Number(page.backgroundRetryAt || 0) > Date.now())
          .reduce((earliest, page) => Math.min(earliest, Number(page.backgroundRetryAt)), Infinity);
        if (Number.isFinite(nextRetryAt)) {
          state.backgroundPreparationTimer = window.setTimeout(() => {
            state.backgroundPreparationTimer = 0;
            if (generation === state.prepareGeneration && document.visibilityState !== "hidden") {
              void startReaderBackgroundPreparation(generation);
            }
          }, Math.max(50, nextRetryAt - Date.now()));
        }
        break;
      }
      const batch = indexes.slice(0, adaptivePreparationConcurrency());
      await Promise.all(batch.map(async (index) => {
        const page = state.pages[index];
        try {
          await preparePage(index, { quiet: true, generation, signal });
          page.backgroundAttempts = 0;
          page.backgroundRetryAt = 0;
          page.backgroundFailed = false;
        } catch (error) {
          if (signal?.aborted || isAbortLike(error) || error?.name === "ReaderVisibilityInterrupted") return;
          page.backgroundAttempts = Number(page.backgroundAttempts || 0) + 1;
          page.backgroundFailed = page.backgroundAttempts >= 2;
          page.backgroundRetryAt = Date.now() + (page.backgroundFailed ? 0 : 2000);
        }
      }));
      if (generation !== state.prepareGeneration || preparationId !== state.backgroundPreparationId) return;
      renderPanelStrip();
      trimReaderMemory();
      if (!nextChapterScheduled && state.pages.slice(currentIndex + 1, currentIndex + 3).every(isAnalyzedReaderPage)) {
        nextChapterScheduled = true;
        scheduleNextChapterPrefetch(generation, 250);
      }
      await yieldToBrowser();
    }
    if (!nextChapterScheduled) scheduleNextChapterPrefetch(generation, 250);
  } finally {
    if (generation === state.prepareGeneration && preparationId === state.backgroundPreparationId) state.backgroundPreparing = false;
  }
}

function averagePreparationMs() {
  if (!state.pagePreparationDurations.length) return 0;
  return state.pagePreparationDurations.reduce((sum, duration) => sum + duration, 0) / state.pagePreparationDurations.length;
}

function adaptiveLookaheadPageCount() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (connection?.saveData) return 2;
  const average = averagePreparationMs();
  if (average > 1500) return 3;
  if (average && average < 450 && (navigator.deviceMemory || 4) >= 6) return 8;
  return 5;
}

function adaptivePreparationConcurrency() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (connection?.saveData || (navigator.deviceMemory || 8) <= 4 || averagePreparationMs() > 1200) return 1;
  return 2;
}

async function prepareWebtoonChapterInBackground(generation = state.prepareGeneration, signal = null) {
  if (state.backgroundPreparing) return;
  const page = state.pages[0];
  if (!page?.sourceImages) return;
  if (Number.isInteger(page.webtoonFailedIndex)) return;
  window.clearTimeout(state.backgroundPreparationTimer);
  state.backgroundPreparationTimer = 0;
  if (page.complete) {
    scheduleNextChapterPrefetch(generation, 500);
    return;
  }

  state.backgroundPreparing = true;
  scheduleNextChapterPrefetch(generation, 500);
  try {
    for (let index = Number(page.webtoonNextSourceIndex ?? page.sourceImages.length); index < state.chapterPageUrls.length; index += 1) {
      if (generation !== state.prepareGeneration || signal?.aborted || document.visibilityState === "hidden") return;
      let image = null;
      try {
        image = await loadImage(state.chapterPageUrls[index], { signal, retry: false });
      } catch (error) {
        if (signal?.aborted || isAbortLike(error) || error?.name === "ReaderVisibilityInterrupted") return;
        page.webtoonBackgroundAttempts[index] = Number(page.webtoonBackgroundAttempts[index] || 0) + 1;
        if (page.webtoonBackgroundAttempts[index] >= 2) {
          page.webtoonFailedIndex = index;
          page.webtoonFailureMessage = friendlySourceErrorMessage(error);
          return;
        }
        state.backgroundPreparationTimer = window.setTimeout(() => {
          state.backgroundPreparationTimer = 0;
          if (generation === state.prepareGeneration && document.visibilityState !== "hidden") {
            void startReaderBackgroundPreparation(generation);
          }
        }, 2000);
        return;
      }
      if (!image || generation !== state.prepareGeneration) return;

      const current = currentPanel();
      const currentCenterY = current ? (current.y + current.h / 2) * page.naturalHeight : 0;
      page.sourceImages.push({ url: state.chapterPageUrls[index], image, sourceIndex: index });
      page.webtoonNextSourceIndex = index + 1;
      delete page.webtoonBackgroundAttempts[index];
      page.webtoonFailedIndex = null;
      page.webtoonFailureMessage = "";
      Object.assign(page, buildContinuousWebtoonPage(state.chapterPageUrls, page.sourceImages));
      trimWebtoonSourceImages(page);
      if (currentCenterY) state.panelIndex = nearestPanelIndexByY(page, currentCenterY);
      renderStripPage(page, { refit: false, contentExtended: true });
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
  const lifecycleAware = options.lifecycle !== false;
  let lastError = null;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (attempt > 0 && delays[attempt] > 0) await abortableDelay(delays[attempt], options.signal);
    // A suspended iOS page can stop image events and timers. Wait for a visible
    // lifecycle before each attempt, then repeat the same attempt if suspension
    // interrupted it rather than counting that as a network failure.
    while (true) {
      if (lifecycleAware) await waitForReaderVisibility(options.signal);
      const lifecycleSignal = lifecycleAware ? state.readerVisibleController?.signal : null;
      try {
        const image = await loadImageAttempt(
          retryImageUrl(src, attempt),
          src,
          options.timeoutMs || 10000,
          { signal: options.signal, lifecycleSignal }
        );
        image.panelPilotLoadAttempts = attempt + 1;
        return image;
      } catch (error) {
        if (error?.name === "ReaderVisibilityInterrupted") {
          await waitForReaderVisibility(options.signal);
          continue;
        }
        if (isAbortLike(error)) throw error;
        lastError = error;
        break;
      }
    }
  }
  throw lastError || new Error(`Could not load image: ${src}`);
}

function isAbortLike(error) {
  return error?.name === "AbortError" || error?.name === "ReaderLoadCancelled";
}

function readerAbortError(message = "Reader load was cancelled.") {
  try {
    return new DOMException(message, "AbortError");
  } catch {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  }
}

function visibilityInterruptedError() {
  const error = new Error("Reader image loading paused while the page was hidden.");
  error.name = "ReaderVisibilityInterrupted";
  return error;
}

function abortableDelay(delayMs, signal = null) {
  if (signal?.aborted) return Promise.reject(signal.reason || readerAbortError());
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(finish, delayMs);
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason || readerAbortError());
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function waitForReaderVisibility(signal = null) {
  if (signal?.aborted) return Promise.reject(signal.reason || readerAbortError());
  if (document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", check);
      signal?.removeEventListener("abort", abort);
    };
    const check = () => {
      if (document.visibilityState === "hidden") return;
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason || readerAbortError());
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", check);
    signal?.addEventListener("abort", abort, { once: true });
  });
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

function loadImageAttempt(src, originalSrc, timeoutMs = 10000, { signal = null, lifecycleSignal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || readerAbortError());
      return;
    }
    if (lifecycleSignal?.aborted) {
      reject(visibilityInterruptedError());
      return;
    }
    const needsCors = /^https?:/i.test(src) && !src.startsWith(location.origin);
    const candidates = needsCors ? ["anonymous", ""] : [""];
    let candidateIndex = 0;
    let activeImage = null;
    let timeout = 0;
    let settled = false;

    const cleanup = () => {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      lifecycleSignal?.removeEventListener("abort", onLifecycleAbort);
      if (activeImage) {
        activeImage.onload = null;
        activeImage.onerror = null;
      }
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const stopImage = () => {
      if (!activeImage) return;
      activeImage.onload = null;
      activeImage.onerror = null;
      activeImage.src = "";
    };
    const onAbort = () => {
      stopImage();
      settle(() => reject(signal?.reason || readerAbortError()));
    };
    const onLifecycleAbort = () => {
      stopImage();
      settle(() => reject(visibilityInterruptedError()));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    lifecycleSignal?.addEventListener("abort", onLifecycleAbort, { once: true });

    const tryCandidate = () => {
      if (settled) return;
      const image = new Image();
      activeImage = image;
      if (candidates[candidateIndex]) image.crossOrigin = candidates[candidateIndex];
      timeout = window.setTimeout(() => {
        image.onload = null;
        image.onerror = null;
        image.src = "";
        tryNext(new Error(`Timed out loading image: ${originalSrc}`));
      }, timeoutMs);
      const finish = (callback) => {
        window.clearTimeout(timeout);
        image.onload = null;
        image.onerror = null;
        callback();
      };
      image.onload = () => finish(async () => {
        try {
          if (typeof image.decode === "function") await image.decode();
        } catch {
          // Safari can reject decode() even after a usable onload. Natural
          // dimensions are the authoritative fallback in that case.
        }
        if (!image.naturalWidth || !image.naturalHeight) {
          tryNext(new Error(`Image decoded without dimensions: ${originalSrc}`));
          return;
        }
        settle(() => resolve(image));
      });
      image.onerror = () => finish(() => tryNext(new Error(`Could not load image: ${originalSrc}`)));
      image.src = src;
    };

    const tryNext = (error) => {
      if (settled) return;
      candidateIndex += 1;
      if (candidateIndex < candidates.length) {
        tryCandidate();
        return;
      }
      settle(() => reject(error));
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
  { initialCount = pageUrls.length, initialImages = [], signal = null } = {}
) {
  const images = initialImages.slice();
  const count = Math.min(pageUrls.length, Math.max(1, initialCount));
  for (let index = images.length; index < count; index += 1) {
    if (generation !== state.prepareGeneration) throw new Error("Chapter load was replaced.");
    const progress = 18 + Math.round((index / Math.max(1, count)) * 48);
    setReaderLoading(true, `Loading webtoon page ${index + 1} of ${pageUrls.length}...`, progress);
    const image = await loadImage(pageUrls[index], { signal });
    images.push({ url: pageUrls[index], image });
    await yieldToBrowser();
  }

  if (generation !== state.prepareGeneration) throw new Error("Chapter load was replaced.");
  setReaderLoading(true, "Detecting continuous webtoon panels...", 72);
  const page = buildContinuousWebtoonPage(pageUrls, images);
  trimWebtoonSourceImages(page);
  return page;
}

function buildContinuousWebtoonPage(pageUrls, images) {
  images.forEach((item) => {
    item.naturalWidth ||= item.image?.naturalWidth || item.image?.width || 1;
    item.naturalHeight ||= item.image?.naturalHeight || item.image?.height || 1;
  });
  const stripWidth = Math.max(...images.map((item) => item.naturalWidth || 1));
  let stripY = 0;
  const stripImages = images.map((item, index) => {
    const width = item.naturalWidth || stripWidth;
    const height = item.naturalHeight || 1;
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

  const analysis = analyzeWebtoonSourceRows(images);
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
    webtoonNextSourceIndex: images.length,
    webtoonBackgroundAttempts: {},
    webtoonFailedIndex: null,
    webtoonFailureMessage: "",
  };
}

function analyzeWebtoonSourceRows(items) {
  const analysisWidth = 240;
  const chunks = items.map((item) => {
    if (item.analysisRows) return item.analysisRows;
    if (!item.image) throw new Error("A released webtoon source is missing its row analysis.");
    const width = item.naturalWidth || item.image.naturalWidth || item.image.width || 1;
    const height = item.naturalHeight || item.image.naturalHeight || item.image.height || 1;
    item.analysisRows = analyzeWebtoonImageRows(
      item.image,
      analysisWidth,
      Math.max(1, Math.round((height / width) * analysisWidth))
    );
    return item.analysisRows;
  });
  const totalHeight = chunks.reduce((sum, chunk) => sum + chunk.height, 0);
  const quietRows = new Uint8Array(totalHeight);
  const activeRows = new Uint8Array(totalHeight);
  let offset = 0;
  chunks.forEach((chunk) => {
    quietRows.set(chunk.quietRows, offset);
    activeRows.set(chunk.activeRows, offset);
    offset += chunk.height;
  });
  return { quietRows, activeRows, height: totalHeight };
}

function trimWebtoonSourceImages(page, { aggressive = false } = {}) {
  if (!Array.isArray(page?.sourceImages)) return;
  const cap = aggressive ? 1 : readerDecodedImageCap();
  const resident = page.sourceImages.filter((item) => item?.image);
  resident.slice(0, Math.max(0, resident.length - cap)).forEach((item) => {
    releaseDecodedImage(item.image);
    item.image = null;
  });
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

async function detectPanels(image, direction, pageUrl = "") {
  const modelPanels = await detectMangaPanelsWithModel(image, direction, pageUrl).catch(() => null);
  if (modelPanels) return modelPanels;
  return detectPanelsHeuristic(image, direction);
}

async function detectMangaPanelsWithModel(image, direction, pageUrl = "") {
  if (state.mangaModelAvailable === false) return null;
  let body;
  let contentType;
  try {
    const parsed = new URL(pageUrl, location.origin);
    if (parsed.origin === location.origin && parsed.pathname === "/api/suwayomi/asset") {
      body = JSON.stringify({ url: `${parsed.pathname}${parsed.search}` });
      contentType = "application/json";
    }
  } catch {
    // Fall through to a compact image upload for non-Suwayomi pages.
  }
  if (!body) {
    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    body = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not encode manga page")), "image/jpeg", 0.82);
    });
    contentType = "image/jpeg";
  }
  const response = await fetch("/api/detect/manga", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
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
    el.stageStrip.dataset.windowSignature = "";
  }
  const pageKey = `${state.pageIndex}:${page.url || page.renderUrl || "page"}`;
  const pageChanged = el.stageImage.dataset.pageKey !== pageKey;
  el.stageImage.dataset.pageKey = pageKey;
  state.cameraPageChanged = pageChanged;
  el.stageImage.hidden = false;
  el.stageImage.src = page.renderUrl || page.image?.currentSrc || page.image?.src || page.url;
  el.stageImage.alt = `${el.chapterTitle.textContent}, page ${state.pageIndex + 1}`;
  el.stageImage.onload = null;
  el.stageImage.onerror = () => recoverRenderedPageImage(page, state.pageIndex);
  scheduleCameraFit();
}

async function recoverRenderedPageImage(page, pageIndex) {
  if (!page || page.renderRecoveryPromise) return page?.renderRecoveryPromise;
  const generation = state.prepareGeneration;
  const controller = new AbortController();
  page.renderRecoveryController?.abort(readerAbortError("Image recovery was replaced."));
  page.renderRecoveryController = controller;
  const recovery = loadImage(page.url, { signal: controller.signal })
    .then((image) => {
      if (generation !== state.prepareGeneration || state.pages[pageIndex] !== page) {
        releaseDecodedImage(image);
        return null;
      }
      page.image = image;
      page.renderUrl = image.currentSrc || image.src || page.url;
      page.loadAttempts = image.panelPilotLoadAttempts || page.loadAttempts;
      if (state.pages[pageIndex] === page && state.pageIndex === pageIndex) {
        el.stageImage.src = page.renderUrl;
      }
      return image;
    })
    .catch((error) => {
      if (isAbortLike(error) || error?.name === "ReaderVisibilityInterrupted") return null;
      if (state.pages[pageIndex] === page && state.pageIndex === pageIndex) {
        showReaderError(
          "Could not load this page",
          friendlySourceErrorMessage(error),
          () => recoverRenderedPageImage(page, pageIndex)
        );
      }
      return null;
    })
    .finally(() => {
      if (page.renderRecoveryPromise === recovery) page.renderRecoveryPromise = null;
      if (page.renderRecoveryController === controller) page.renderRecoveryController = null;
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

function renderStripPage(page, { refit = true, contentExtended = false } = {}) {
  const strip = ensureStageStrip();
  const signature = page.stripImages.map((item) => `${item.url}:${Math.round(item.height)}`).join("|");
  const current = currentPanel();
  const currentY = current ? (current.y + current.h / 2) * page.naturalHeight : 0;
  const activeSegment = Math.max(0, page.stripImages.findIndex((item) => currentY >= item.y && currentY <= item.y + item.height));
  const liveCount = Math.min(webtoonLiveImageCap, page.stripImages.length);
  const liveStart = clamp(activeSegment - Math.floor(liveCount / 2), 0, Math.max(0, page.stripImages.length - liveCount));
  const liveEnd = liveStart + liveCount;
  const windowSignature = `${liveStart}:${liveEnd}`;
  // Keep the first source visible to assistive/testing consumers while the
  // continuous strip remains the actual rendered surface.
  if (page.url && el.stageImage.getAttribute("src") !== page.url) el.stageImage.src = page.url;
  el.stageImage.hidden = true;
  strip.hidden = false;

  if (strip.dataset.signature !== signature || strip.dataset.windowSignature !== windowSignature) {
    state.cameraPageChanged = !contentExtended;
    const fragment = document.createDocumentFragment();
    page.stripImages.forEach((item, index) => {
      if (index >= liveStart && index < liveEnd) {
        const image = document.createElement("img");
        image.src = item.url;
        image.dataset.url = item.url;
        image.dataset.segmentIndex = String(index);
        image.alt = "";
        image.draggable = false;
        image.onerror = () => { void recoverStripImageNode(page, image, item); };
        fragment.append(image);
        return;
      }
      const placeholder = document.createElement("div");
      placeholder.dataset.segmentPlaceholder = String(index);
      placeholder.setAttribute("aria-hidden", "true");
      placeholder.style.width = "100%";
      placeholder.style.height = `${item.height}px`;
      fragment.append(placeholder);
    });
    strip.replaceChildren(fragment);
    state.performanceStats.panelStripRebuilds += 1;
    strip.dataset.signature = signature;
    strip.dataset.windowSignature = windowSignature;
  }

  if (refit) {
    scheduleCameraFit();
    return;
  }

  const renderedWidth = parseFloat(strip.style.width);
  if (Number.isFinite(renderedWidth) && renderedWidth > 0 && page.naturalWidth > 0) {
    const preservedScale = renderedWidth / page.naturalWidth;
    strip.style.height = `${page.naturalHeight * preservedScale}px`;
  }
}

function scheduleCameraFit() {
  if (state.cameraFitFrame) return;
  state.cameraFitFrame = window.requestAnimationFrame(() => {
    state.cameraFitFrame = 0;
    fitStage();
  });
}

function scheduleViewportFit() {
  scheduleCameraFit();
  window.clearTimeout(state.viewportFitTimer);
  state.viewportFitTimer = window.setTimeout(() => {
    state.viewportFitTimer = 0;
    if (readerIsVisible() && state.activeView === "reader") scheduleCameraFit();
  }, 140);
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
  const pageChanged = state.cameraPageChanged;
  state.cameraPageChanged = false;
  const motionDuration = readerMotionDurationMs();
  if (pageChanged) targetElement.classList.add("camera-jump");
  if (pageChanged && motionDuration > 0) targetElement.classList.add("page-fade");
  targetElement.style.width = `${imageWidth}px`;
  targetElement.style.height = `${imageHeight}px`;
  targetElement.style.transformOrigin = "0 0";
  targetElement.style.transform = `matrix3d(${scale}, 0, 0, 0, 0, ${scale}, 0, 0, 0, 0, 1, 0, ${left}, ${top}, 0, 1)`;
  state.performanceStats.cameraFits += 1;
  state.performanceStats.transformWrites += 1;
  if (pageChanged) {
    window.setTimeout(() => targetElement.classList.remove("camera-jump"), 0);
    window.setTimeout(() => targetElement.classList.remove("page-fade"), Math.max(140, motionDuration));
  }
}

async function recoverStripImageNode(page, node, segment) {
  if (!node?.isConnected || node.dataset.recovering === "true") return null;
  const generation = state.prepareGeneration;
  const completedAttempts = Number(node.dataset.recoveryAttempts || 0);
  const retryFromDialog = () => {
    node.dataset.recoveryAttempts = "0";
    node.dataset.recoveryExhausted = "false";
    return recoverStripImageNode(page, node, segment);
  };
  if (completedAttempts >= 2) {
    if (node.dataset.recoveryExhausted !== "true" && state.pages[state.pageIndex] === page) {
      node.dataset.recoveryExhausted = "true";
      showReaderError(
        `Could not load webtoon segment ${Number(node.dataset.segmentIndex || 0) + 1}`,
        "The image remained unavailable after two recovery attempts.",
        retryFromDialog
      );
    }
    return null;
  }
  const attempts = completedAttempts + 1;
  node.dataset.recoveryAttempts = String(attempts);
  node.dataset.recovering = "true";
  try {
    const image = await loadImage(segment.url, { retry: attempts < 2 });
    if (
      generation !== state.prepareGeneration ||
      state.pages[state.pageIndex] !== page ||
      !node.isConnected ||
      node.dataset.url !== segment.url
    ) {
      releaseDecodedImage(image);
      return null;
    }
    node.src = image.currentSrc || image.src || segment.url;
    releaseDecodedImage(image);
    node.dataset.recovering = "false";
    return node;
  } catch (error) {
    node.dataset.recovering = "false";
    if (isAbortLike(error) || error?.name === "ReaderVisibilityInterrupted") return null;
    if (attempts < 2 && readerIsVisible()) return recoverStripImageNode(page, node, segment);
    if (state.pages[state.pageIndex] === page && node.isConnected) {
      node.dataset.recoveryExhausted = "true";
      showReaderError(
        `Could not load webtoon segment ${Number(node.dataset.segmentIndex || 0) + 1}`,
        friendlySourceErrorMessage(error),
        retryFromDialog
      );
    }
    return null;
  }
}

function validateCurrentReaderRender() {
  if (state.renderValidationPromise) return state.renderValidationPromise;
  const page = state.pages[state.pageIndex];
  if (!page || state.activeView !== "reader") return Promise.resolve(false);
  const generation = state.prepareGeneration;
  const validation = (async () => {
    if (page.stripImages) {
      renderStripPage(page, { refit: false });
      const strip = ensureStageStrip();
      const images = [...strip.querySelectorAll("img[data-segment-index]")];
      await Promise.all(images.map((image) => {
        if (image.complete && image.naturalWidth > 0) return null;
        const segment = page.stripImages[Number(image.dataset.segmentIndex)];
        return segment ? recoverStripImageNode(page, image, segment) : null;
      }));
      return generation === state.prepareGeneration;
    }
    const expectedKey = `${state.pageIndex}:${page.url || page.renderUrl || "page"}`;
    if (el.stageImage.dataset.pageKey === expectedKey && el.stageImage.complete && el.stageImage.naturalWidth > 0) return true;
    await recoverRenderedPageImage(page, state.pageIndex);
    return generation === state.prepareGeneration;
  })().finally(() => {
    if (state.renderValidationPromise === validation) state.renderValidationPromise = null;
  });
  state.renderValidationPromise = validation;
  return validation;
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
  el.versionNote.textContent = `${appVersion} | ${buildId} | ${detectorVersion}`;
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
  pauseReaderBackgroundWork();
  const previousPages = state.pages;

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
      startReaderBackgroundPreparation(generation);
    } else {
      state.pages = makeChapterPageEntries(state.chapterPageUrls);
      await preparePage(0, { force: true, generation });
      startReaderBackgroundPreparation(generation);
    }
    state.pageIndex = 0;
    state.panelIndex = 0;
    state.fullPage = false;
    renderCurrentPage();
    updateAfterNavigation();
    if (previousPages !== state.pages) releaseReaderPageImages(previousPages);
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
  if (!state.fullPage) scheduleCameraFit();
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
  state.navigationController?.abort(readerAbortError("Reader navigation was cancelled."));
  state.navigationController = null;
  state.navigationCooldownUntil = 0;
  state.panelMoveQueue = [];
  setReaderNavigationPending(false);
}

function movePanel(delta) {
  if (activeReaderModal() || !state.pages.length || !Number.isFinite(Number(delta)) || Number(delta) === 0) return;
  state.panelMoveQueue.push(Number(delta) > 0 ? 1 : -1);
  state.performanceStats.queuedPanelMoves += 1;
  state.performanceStats.maxPanelMoveQueue = Math.max(
    state.performanceStats.maxPanelMoveQueue,
    state.panelMoveQueue.length
  );
  void drainPanelMoveQueue();
}

async function drainPanelMoveQueue() {
  if (state.panelMoveQueueRunning) return;
  state.panelMoveQueueRunning = true;
  try {
    while (state.panelMoveQueue.length && state.pages.length) {
      const delta = state.panelMoveQueue.shift();
      const moved = await performPanelMove(delta);
      const delay = moved ? readerMotionDurationMs() : 0;
      if (delay > 0 && state.panelMoveQueue.length) await waitFor(delay);
    }
  } finally {
    state.panelMoveQueueRunning = false;
    if (state.panelMoveQueue.length) void drainPanelMoveQueue();
  }
}

async function performPanelMove(delta) {
  if (state.navigationPending || !state.pages.length) return false;
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
    return true;
  }

  return moveToAdjacentPage(delta);
}

async function moveToAdjacentPage(delta) {
  if (state.navigationPending || !state.pages.length) return false;

  const fromPageIndex = state.pageIndex;
  const nextPage = fromPageIndex + delta;

  if (nextPage < 0) return false;
  if (nextPage >= state.pages.length) {
    if (delta > 0 && state.panelMode === "webtoon" && !state.pages[0]?.complete) {
      const webtoonPage = state.pages[0];
      if (Number.isInteger(webtoonPage?.webtoonFailedIndex)) {
        const failedIndex = webtoonPage.webtoonFailedIndex;
        showReaderError(
          `Could not prepare webtoon page ${failedIndex + 1}`,
          webtoonPage.webtoonFailureMessage || "The page could not be loaded after two background attempts.",
          () => {
            webtoonPage.webtoonBackgroundAttempts[failedIndex] = 0;
            webtoonPage.webtoonFailedIndex = null;
            webtoonPage.webtoonFailureMessage = "";
            hideReaderError();
            void startReaderBackgroundPreparation(state.prepareGeneration);
          }
        );
        return false;
      }
      setConnection(state.connected, "Still preparing the rest of this webtoon chapter.", "");
      return false;
    }
    if (delta > 0) {
      const hasNextChapter = state.activeChapter?.type === "suwayomi"
        ? Boolean(nextSuwayomiChapterAfter(state.activeChapter.chapterId))
        : state.activeChapter?.type === "comick";
      if (!hasNextChapter) {
        if (state.activeChapter?.type === "suwayomi") {
          enqueueCurrentSuwayomiProgress({ completed: true });
          void flushSuwayomiProgressOutbox().catch(() => false);
          completeMangaBakaChapter();
        }
        showReaderComplete();
        return false;
      }
      const requestId = state.navigationRequestId + 1;
      state.navigationRequestId = requestId;
      setReaderNavigationPending(true);
      const loadingTimer = window.setTimeout(() => {
        if (requestId === state.navigationRequestId) {
          setReaderLoading(true, "Loading next chapter...", 24);
          if (el.readerLoadingCancel) el.readerLoadingCancel.hidden = true;
        }
      }, readerLoadingGraceMs);
      try {
        await finishChapterAndLoadNext();
        return true;
      } catch (error) {
        setConnection(state.connected, `Could not load the next chapter: ${error.message}`, "bad");
        showReaderComplete(`The next chapter could not be opened yet: ${friendlySourceErrorMessage(error)}`);
      } finally {
        window.clearTimeout(loadingTimer);
        if (el.readerLoadingCancel) el.readerLoadingCancel.hidden = false;
        if (requestId === state.navigationRequestId) {
          setReaderNavigationPending(false);
          setReaderLoading(false);
        }
      }
    }
    return false;
  }

  const requestId = state.navigationRequestId + 1;
  state.navigationRequestId = requestId;
  const generation = state.prepareGeneration;
  const navigationController = new AbortController();
  state.navigationController?.abort(readerAbortError("Reader navigation was replaced."));
  state.navigationController = navigationController;
  setReaderNavigationPending(true);
  const pageWasReady = isPreparedReaderPage(state.pages[nextPage]);
  let cancelWait = null;
  const cancelled = new Promise((resolve) => { cancelWait = () => resolve(null); });
  const loadingTimer = pageWasReady ? 0 : window.setTimeout(() => {
    if (requestId === state.navigationRequestId) {
      setReaderLoading(true, `Preparing page ${nextPage + 1}...`, 58);
    }
  }, readerLoadingGraceMs);
  const cancelAction = () => {
    cancelReaderNavigation();
    setReaderLoading(false);
    cancelWait?.();
    showReaderError(
      `Page ${nextPage + 1} is still preparing`,
      "Your current panel is unchanged. Try again when you are ready.",
      () => moveToAdjacentPage(delta)
    );
  };
  state.readerLoadingCancelAction = cancelAction;

  try {
    const preparedPage = await Promise.race([
      preparePage(nextPage, { generation, foreground: true, signal: navigationController.signal }),
      cancelled,
    ]);
    if (!preparedPage) return false;
    if (requestId !== state.navigationRequestId || generation !== state.prepareGeneration) return false;
    if (state.pageIndex !== fromPageIndex) return false;

    const panels = state.pages[nextPage].panels;
    state.pageIndex = nextPage;
    state.panelIndex = delta > 0 ? 0 : Math.max(0, panels.length - 1);
    state.fullPage = false;
    renderCurrentPage();
    updateAfterNavigation();
    trimReaderMemory();
    void startReaderBackgroundPreparation(generation);
    return true;
  } catch (error) {
    if (isAbortLike(error) || error?.name === "ReaderVisibilityInterrupted") return false;
    setConnection(state.connected, `Could not prepare page: ${error.message}`, "bad");
    showReaderError(
      "Could not prepare this page",
      friendlySourceErrorMessage(error),
      () => moveToAdjacentPage(delta)
    );
  } finally {
    if (loadingTimer) window.clearTimeout(loadingTimer);
    if (state.readerLoadingCancelAction === cancelAction) state.readerLoadingCancelAction = null;
    if (state.navigationController === navigationController) state.navigationController = null;
    if (requestId === state.navigationRequestId) {
      setReaderNavigationPending(false);
      setReaderLoading(false);
    }
  }
  return false;
}

function isPreparedReaderPage(page) {
  return Boolean(
    page?.detected &&
    page.panelMode === state.panelMode &&
    page.readingDirection === state.readingDirection &&
    page.image
  );
}

function isAnalyzedReaderPage(page) {
  return Boolean(
    page?.detected &&
    page.panelMode === state.panelMode &&
    page.readingDirection === state.readingDirection
  );
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
  const sourceServerUrl = state.activeChapter.serverUrl || currentDeviceServerUrl();
  let chapter = nextSuwayomiChapterAfter(currentChapterId);
  if (!chapter && navigator.onLine) {
    await fetchChapters({ background: true, liveOnly: true, serverUrl: sourceServerUrl });
    chapter = nextSuwayomiChapterAfter(currentChapterId);
  }
  if (!chapter) {
    setConnection(state.connected, "No next Suwayomi chapter is loaded in the chapter list.", "bad");
    return;
  }

  if (state.activeChapter.deviceLocal) {
    const chapterPackage = devicePackageForChapter(chapter.id, sourceServerUrl);
    if (chapterPackage?.status === "ready") {
      await openDeviceChapter(chapterPackage, null);
      return;
    }
    if (!navigator.onLine) {
      setConnection(state.connected, "The next chapter is not saved on this device.", "bad");
      return;
    }
  } else if (!navigator.onLine) {
    setConnection(state.connected, "The next chapter is not saved on this device.", "bad");
    return;
  }

  const prefetch = state.nextChapterPrefetch;
  if (!state.activeChapter.deviceLocal && prefetch?.fromChapterId === currentChapterId && prefetch.chapterId === Number(chapter.id)) {
    window.clearTimeout(state.nextChapterPrefetchTimer);
    if (prefetch.status === "failed" || prefetch.status === "stale") prefetch.promise = null;
    const prepared = await startNextChapterPrefetch(prefetch);
    if (prepared) {
      el.chapterId.value = chapter.id;
      el.chapterTitle.textContent = chapter.name || `Chapter ${chapter.chapterNumber || chapter.sourceOrder || chapter.id}`;
      state.pendingResume = null;
      state.activeChapter = {
        type: "suwayomi",
        chapterId: Number(chapter.id),
        chapter,
        serverUrl: sourceServerUrl,
      };
      if (isPanelMode(prepared.mode)) {
        state.panelMode = prepared.mode;
        updatePanelModeControls();
      }
      await loadChapter(prepared.pageUrls, el.chapterTitle.textContent, {
        preparedPages: prepared.preparedPages,
        firstImage: prepared.firstImage,
      });
      rememberReadingProgress();
      if (sourceServerUrl === currentDeviceServerUrl()) void ensureDownloadAhead(chapter.id);
      setConnection(true, `Loaded ${prepared.pageUrls.length} pages. The next pages are preparing in the background.`, "good");
      return;
    }
  }

  el.chapterId.value = chapter.id;
  el.chapterTitle.textContent = chapter.name || `Chapter ${chapter.chapterNumber || chapter.sourceOrder || chapter.id}`;
  await loadChapterPages({
    serverUrl: sourceServerUrl,
    skipLibraryEnsure: state.activeChapter.deviceLocal || sourceServerUrl !== currentDeviceServerUrl(),
  });
}

function updateAfterNavigation() {
  el.toggleFit.textContent = state.fullPage ? "Panel view" : "Page overview";
  const page = state.pages[state.pageIndex];
  if (page?.stripImages) renderStripPage(page, { refit: false });
  scheduleCameraFit();
  renderPanelStrip();
  updateStats();
  scheduleReadingProgressPersistence();
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
  if (el.nextPanel) {
    el.nextPanel.setAttribute("aria-label", totalPanels
      ? `Next panel. Current panel ${state.panelIndex + 1} of ${totalPanels}`
      : "Next panel");
  }
  if (el.prevPanel) {
    el.prevPanel.setAttribute("aria-label", totalPanels
      ? `Previous panel. Current panel ${state.panelIndex + 1} of ${totalPanels}`
      : "Previous panel");
  }
}

function renderPanelStrip() {
  const page = state.pages[state.pageIndex];
  if (!page?.panels.length) {
    el.panelStrip.replaceChildren();
    el.panelStrip.dataset.signature = "";
    return;
  }

  const signature = `${state.pageIndex}:${page.panels.map((panel) => [panel.x, panel.y, panel.w, panel.h].map((value) => Number(value).toFixed(4)).join(",")).join("|")}`;
  if (el.panelStrip.dataset.signature === signature) {
    [...el.panelStrip.children].forEach((button, index) => {
      button.classList.toggle("active", index === state.panelIndex && !state.fullPage);
    });
    updateStats();
    return;
  }

  el.panelStrip.replaceChildren();
  el.panelStrip.dataset.signature = signature;
  state.performanceStats.panelStripRebuilds += 1;

  page.panels.forEach((panel, index) => {
    const button = document.createElement("button");
    button.className = `panel-thumb${index === state.panelIndex && !state.fullPage ? " active" : ""}`;
    button.type = "button";
    button.dataset.panelIndex = String(index);
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
  pauseReaderBackgroundWork();
  const previousPages = state.pages;
  state.pageIndex = 0;
  state.panelIndex = 0;
  state.fullPage = false;

  try {
    if (state.panelMode === "webtoon") {
      state.pages = [await prepareContinuousWebtoonChapter(state.chapterPageUrls, generation, { initialCount: 2 })];
      renderCurrentPage();
      updateAfterNavigation();
      startReaderBackgroundPreparation(generation);
    } else {
      state.pages = makeChapterPageEntries(state.chapterPageUrls);
      await preparePage(0, { force: true, generation });
      renderCurrentPage();
      updateAfterNavigation();
      startReaderBackgroundPreparation(generation);
    }
    if (previousPages !== state.pages) releaseReaderPageImages(previousPages);
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
    for (let index = 0; index < page.stripImages.length; index += 1) {
      const segment = page.stripImages[index];
      const residentSource = page.sourceImages?.[index]?.image || null;
      const source = residentSource || await loadImage(segment.url);
      context.drawImage(
        source,
        0,
        Math.round(segment.y * scale),
        Math.round(segment.width * scale),
        Math.round(segment.height * scale)
      );
      if (!residentSource) releaseDecodedImage(source);
    }
  } else {
    const residentImage = page.image || null;
    const image = residentImage || await loadImage(page.url);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (!residentImage) releaseDecodedImage(image);
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
      const appCacheKeys = keys.filter((key) => (
        /^panel-pilot-v\d+$/.test(key)
        || key.startsWith("workbox-precache-")
      ));
      await Promise.all(appCacheKeys.map((key) => caches.delete(key)));
    }
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration("/");
      await registration?.update();
    }
    setConnection(state.connected, "App cache cleared. Reloading latest version...", "good");
    window.setTimeout(() => location.reload(), 250);
  } catch (error) {
    setConnection(state.connected, `Could not clear app cache: ${error.message}`, "bad");
  } finally {
    setBusy(el.clearAppCache, false);
  }
}

let activateWaitingServiceWorker = null;
let panelPilotServiceWorkerRegistration = null;
let serviceWorkerReloadPending = false;
let serviceWorkerReloaded = false;
let appUpdateReady = false;
let deferredInstallPrompt = null;
let installRequestPending = false;
let appInstallConfirmed = false;
const observedServiceWorkerRegistrations = new WeakSet();

function isInstalledApp() {
  return appInstallConfirmed
    || navigator.standalone === true
    || window.matchMedia?.("(display-mode: standalone)").matches === true
    || window.matchMedia?.("(display-mode: fullscreen)").matches === true;
}

function isIosDevice() {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isIosSafari() {
  return isIosDevice()
    && /Safari/i.test(navigator.userAgent)
    && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(navigator.userAgent);
}

function renderInstallExperience(message = "") {
  if (!el.appInstallState || !el.appInstallNote) return;

  el.installApp.hidden = true;
  el.installApp.disabled = false;
  el.iosInstallSteps.hidden = true;

  if (isInstalledApp()) {
    el.appInstallState.textContent = "Installed";
    el.appInstallNote.textContent = "Panels is running as an installed app on this device.";
    return;
  }

  if (installRequestPending) {
    el.appInstallState.textContent = "Installing…";
    el.appInstallNote.textContent = message || "Finish the browser installation to add Panels to this device.";
    return;
  }

  if (deferredInstallPrompt) {
    el.appInstallState.textContent = "Ready to install";
    el.appInstallNote.textContent = message || "Install Panels for a full-screen launcher and app-like experience.";
    el.installApp.hidden = false;
    return;
  }

  if (isIosDevice()) {
    el.appInstallState.textContent = "Home Screen install";
    el.appInstallNote.textContent = message || (isIosSafari()
      ? "In Safari, use Share and Add to Home Screen."
      : "Open this page in Safari, then use Share and Add to Home Screen.");
    el.iosInstallSteps.hidden = false;
    return;
  }

  if (!window.isSecureContext) {
    el.appInstallState.textContent = "HTTPS required";
    el.appInstallNote.textContent = "Open Panels over HTTPS before installing it on this device.";
    return;
  }

  el.appInstallState.textContent = "Browser menu";
  el.appInstallNote.textContent = message || "If your browser supports installation, choose Install app from its menu.";
}

function initializeInstallExperience() {
  const displayMode = window.matchMedia?.("(display-mode: standalone)");
  const refresh = () => renderInstallExperience();

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    if (isInstalledApp()) return;
    deferredInstallPrompt = event;
    installRequestPending = false;
    renderInstallExperience();
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    installRequestPending = false;
    appInstallConfirmed = true;
    renderInstallExperience();
  });
  window.addEventListener("pageshow", refresh);
  window.addEventListener("focus", refresh);
  if (displayMode?.addEventListener) displayMode.addEventListener("change", refresh);
  else displayMode?.addListener?.(refresh);
  renderInstallExperience();
}

async function promptAppInstall() {
  const installPrompt = deferredInstallPrompt;
  if (!installPrompt || isInstalledApp()) {
    renderInstallExperience("Installation is not currently being offered by this browser.");
    return;
  }

  // Browser install events are single-use, so remove the action before awaiting
  // the browser-owned prompt. A later event will reveal it again.
  deferredInstallPrompt = null;
  installRequestPending = true;
  renderInstallExperience();

  try {
    const promptResult = await installPrompt.prompt();
    const choice = promptResult?.outcome ? promptResult : await installPrompt.userChoice;
    if (choice?.outcome === "accepted") {
      renderInstallExperience("Panels is being added to this device.");
      return;
    }
    installRequestPending = false;
    renderInstallExperience("Installation was dismissed. You can try again when your browser offers it.");
  } catch (error) {
    installRequestPending = false;
    renderInstallExperience(`The install prompt could not open: ${error.message}`);
  }
}

function setAppUpdateMessage(message) {
  if (el.appUpdateNote) el.appUpdateNote.textContent = message;
}

function showAppUpdate() {
  appUpdateReady = true;
  setAppUpdateMessage(`Update ready for Panels ${appVersion}. Apply it when you are ready.`);
  if (el.appUpdate) {
    el.appUpdate.hidden = false;
    el.appUpdate.disabled = false;
    el.appUpdate.textContent = "Update ready · Restart app";
  }
  if (el.applyAppUpdate) {
    el.applyAppUpdate.hidden = false;
    el.applyAppUpdate.disabled = false;
    el.applyAppUpdate.textContent = "Apply update";
  }
}

function preserveReaderStateForUpdate() {
  flushScheduledReadingProgress();
  persistSuwayomiProgressOutbox();
  persistMangaBakaOutbox();
}

async function activateAppUpdate() {
  const waitingWorker = panelPilotServiceWorkerRegistration?.waiting;
  if (!waitingWorker && !activateWaitingServiceWorker) {
    setAppUpdateMessage("The update is no longer waiting. Check for updates again.");
    return;
  }

  preserveReaderStateForUpdate();
  serviceWorkerReloadPending = true;
  if (el.appUpdate) {
    el.appUpdate.disabled = true;
    el.appUpdate.textContent = "Updating…";
  }
  if (el.applyAppUpdate) {
    el.applyAppUpdate.disabled = true;
    el.applyAppUpdate.textContent = "Applying…";
  }
  setAppUpdateMessage("Applying the update and preserving your reading position…");

  try {
    if (waitingWorker) waitingWorker.postMessage({ type: "SKIP_WAITING" });
    else await activateWaitingServiceWorker(false);
  } catch (error) {
    serviceWorkerReloadPending = false;
    showAppUpdate();
    setAppUpdateMessage(`Could not activate the app update: ${error.message}`);
    setConnection(state.connected, `Could not activate the app update: ${error.message}`, "bad");
  }
}

function observeServiceWorkerRegistration(registration) {
  if (!registration) return;
  panelPilotServiceWorkerRegistration = registration;
  if (registration.waiting) showAppUpdate();
  if (observedServiceWorkerRegistrations.has(registration)) return;
  observedServiceWorkerRegistrations.add(registration);

  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    if (!worker) return;
    setAppUpdateMessage("Downloading an app update…");
    worker.addEventListener("statechange", () => {
      if (registration.waiting || (worker.state === "installed" && navigator.serviceWorker.controller)) {
        showAppUpdate();
      } else if (worker.state === "redundant" && !appUpdateReady) {
        setAppUpdateMessage("The update could not be installed. Online reading is still available.");
      }
    });
  });
}

async function checkForAppUpdate() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") {
    setAppUpdateMessage("Update checks are unavailable in this browser. Online reading still works.");
    return;
  }

  setBusy(el.checkAppUpdate, true, "Checking…");
  setAppUpdateMessage("Checking for an app update…");
  try {
    const registration = panelPilotServiceWorkerRegistration
      || await navigator.serviceWorker.getRegistration("/");
    if (!registration) throw new Error("No service worker registration is available");
    observeServiceWorkerRegistration(registration);
    await registration.update();
    await new Promise((resolveCheck) => window.setTimeout(resolveCheck, 250));
    if (registration.waiting) {
      showAppUpdate();
    } else if (registration.installing) {
      setAppUpdateMessage("Downloading an app update…");
    } else if (!appUpdateReady) {
      setAppUpdateMessage(`Panels ${appVersion} is up to date.`);
    }
  } catch (error) {
    setAppUpdateMessage(`Update check failed: ${error.message}. Online reading still works.`);
  } finally {
    setBusy(el.checkAppUpdate, false);
  }
}

async function registerPanelPilotServiceWorker() {
  const isProductionBuild = Boolean(packageAppVersion);
  if (!isProductionBuild) {
    setAppUpdateMessage("Update checks are available in production builds.");
    if (el.checkAppUpdate) el.checkAppUpdate.disabled = true;
    return;
  }
  if (!("serviceWorker" in navigator) || location.protocol === "file:") {
    setAppUpdateMessage("Update checks are unavailable in this browser. Online reading still works.");
    if (el.checkAppUpdate) el.checkAppUpdate.disabled = true;
    return;
  }

  setAppUpdateMessage(`Preparing update checks for Panels ${appVersion}…`);

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    state.deviceChapterWorkerGeneration += 1;
    state.deviceChapterWorkerChecked = false;
    state.deviceChapterWorkerReady = false;
    state.deviceChapterWorkerController = null;
    if (el.chapterList?.children.length) renderChapters();
    void refreshDeviceChapterWorkerCapability();
    if (!serviceWorkerReloadPending || serviceWorkerReloaded) return;
    serviceWorkerReloaded = true;
    location.reload();
  });

  try {
    const { registerSW } = await import("virtual:pwa-register");
    activateWaitingServiceWorker = registerSW({
      immediate: true,
      onNeedRefresh() {
        showAppUpdate();
      },
      // The generated helper otherwise reloads on its own. The controllerchange
      // listener above owns the single, state-preserving reload.
      onNeedReload() {},
      onRegisteredSW(_workerUrl, registration) {
        if (!registration) return;
        observeServiceWorkerRegistration(registration);
        if (!registration.waiting && !registration.installing) {
          setAppUpdateMessage(`Panels ${appVersion} is up to date.`);
        }
        registration.update().catch((error) => {
          setAppUpdateMessage(`Automatic update check failed: ${error.message}. Online reading still works.`);
        });
      },
      onRegisterError(error) {
        console.warn("Panels service worker registration failed; continuing online.", error);
        setAppUpdateMessage("Update checks are unavailable because registration failed. Online reading still works.");
      },
    });

    const registration = await navigator.serviceWorker.getRegistration("/");
    if (registration) observeServiceWorkerRegistration(registration);
    await refreshDeviceChapterWorkerCapability();
  } catch (error) {
    state.deviceChapterWorkerGeneration += 1;
    state.deviceChapterWorkerChecked = true;
    state.deviceChapterWorkerReady = false;
    state.deviceChapterWorkerController = null;
    if (el.chapterList?.children.length) renderChapters();
    console.warn("Panels service worker registration failed; continuing online.", error);
    setAppUpdateMessage(`Update checks are unavailable: ${error.message}. Online reading still works.`);
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
  state.activeChapter = { type: "demo" };
  state.pendingResume = null;
  await loadChapter([makeDemoPage(1), makeDemoPage(2)], "Demo chapter");
  setConnection(state.connected, "Demo chapter loaded. This uses the same local detector as Suwayomi pages.", "good");
}

async function initializeSuwayomi() {
  if (!navigator.onLine) {
    handleBrowserOffline();
    return false;
  }
  setConnection(false, "Connecting to Suwayomi…", "");
  const connected = await testConnection();
  if (connected) {
    await loadSources();
    await syncSuwayomiLibrary().catch(() => 0);
    await hydrateLibraryCovers();
    await flushSuwayomiProgressOutbox().catch(() => false);
  }
  await refreshDownloadStatus().catch(() => null);
  return connected;
}

async function recoverSuwayomiConnection() {
  if (document.hidden || !navigator.onLine) return false;
  if (suwayomiRecoveryPromise) return suwayomiRecoveryPromise;
  suwayomiRecoveryPromise = (async () => {
    const wasConnected = state.connected;
    const connected = await testConnection();
    if (!connected || !navigator.onLine) return false;
    if (!wasConnected || !state.sources.length) {
      await loadSources();
      await syncSuwayomiLibrary().catch(() => 0);
    }
    if (state.activeChapter?.type === "suwayomi" && state.activeChapter.deviceLocal && state.currentManga?.id) {
      await fetchChapters({
        background: true,
        liveOnly: true,
        serverUrl: state.activeChapter.serverUrl || currentDeviceServerUrl(),
      }).catch(() => {});
    }
    await flushSuwayomiProgressOutbox().catch(() => false);
    await refreshDownloadStatus().catch(() => null);
    return true;
  })().finally(() => {
    suwayomiRecoveryPromise = null;
  });
  return suwayomiRecoveryPromise;
}

async function refreshDownloadStatus() {
  if (!el.offlineNote) return null;
  if (!state.connected) {
    el.offlineNote.textContent = "Chapter buffering starts after Suwayomi is connected.";
    if (el.retryDownloads) el.retryDownloads.hidden = true;
    renderDownloadStatus(null);
    return null;
  }
  const status = await localJson("/api/download-buffer/status");
  const failed = Number(status.failed) || 0;
  if (el.retryDownloads) el.retryDownloads.hidden = failed < 1;
  el.offlineNote.textContent = downloadBufferStatusText(status);
  renderDownloadStatus(status);
  return status;
}

async function retryFailedDownloads() {
  setBusy(el.retryDownloads, true, "Retrying");
  setBusy(el.downloadStatusRetry, true, "Retrying");
  try {
    const status = await postLocalJson("/api/download-buffer", { retryFailed: true });
    renderDownloadStatus(status);
    showToast(`${status.restored || 0} failed chapter${status.restored === 1 ? "" : "s"} returned to the queue.`, "good");
    await refreshDownloadStatus();
  } catch (error) {
    showToast(`Could not retry downloads: ${friendlySourceErrorMessage(error)}`, "bad");
  } finally {
    setBusy(el.retryDownloads, false);
    setBusy(el.downloadStatusRetry, false);
  }
}

function startBackgroundHealthChecks() {
  window.clearInterval(state.reconnectTimer);
  window.clearInterval(state.downloadStatusTimer);
  state.reconnectTimer = window.setInterval(() => {
    if (!state.connected) void recoverSuwayomiConnection();
  }, reconnectIntervalMs);
  state.downloadStatusTimer = window.setInterval(() => {
    if (!document.hidden && state.connected) void refreshDownloadStatus().catch(() => null);
  }, downloadStatusPollMs);
}

function handleStageTap(event) {
  if (activeReaderModal()) return;
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
    if (state.readerFocus && state.readerChromeVisible) {
      setReaderChromeVisible(false, { refit: false });
      requestAnimationFrame(() => movePanel(1));
    } else {
      movePanel(1);
    }
    return;
  }
  if (action === "back") {
    if (state.readerFocus && state.readerChromeVisible) {
      setReaderChromeVisible(false, { refit: false });
      requestAnimationFrame(() => movePanel(-1));
    } else {
      movePanel(-1);
    }
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
      setDownloadStatusSheet(false);
      const targetView = button.dataset.targetView;
      if (targetView === "reader") {
        openReaderFromNav();
        return;
      }
      if (targetView === "browse" && el.mangaDetail && !el.mangaDetail.hidden) {
        closeMangaDetail({ history: false });
        setActiveView("browse");
        state.viewScrollPositions.browse = state.browseDiscoveryScroll || 0;
        return;
      }
      setActiveView(targetView);
    });
  });
  el.navReader?.addEventListener("click", openReaderFromNav);
  el.downloadStatusButton?.addEventListener("click", () => setDownloadStatusSheet(!state.downloadStatusSheetOpen));
  el.downloadStatusBackdrop?.addEventListener("click", () => setDownloadStatusSheet(false));
  el.downloadStatusClose?.addEventListener("click", () => setDownloadStatusSheet(false));
  el.downloadStatusRetry?.addEventListener("click", retryFailedDownloads);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.downloadStatusSheetOpen) setDownloadStatusSheet(false);
  });
  el.readerBack?.addEventListener("click", leaveReaderView);
  el.readerLoadingCancel?.addEventListener("click", cancelReaderLoading);
  el.readerErrorRetry?.addEventListener("click", retryReaderError);
  el.readerErrorBack?.addEventListener("click", leaveReaderView);
  el.readerCompleteNext?.addEventListener("click", () => {
    hideReaderComplete();
    finishChapterAndLoadNext().catch((error) => {
      showReaderComplete(`The next chapter could not be opened yet: ${friendlySourceErrorMessage(error)}`);
    });
  });
  el.readerCompleteRefresh?.addEventListener("click", refreshCompletedChapterList);
  el.readerCompleteChapters?.addEventListener("click", openCurrentChapterList);
  el.readerCompleteLibrary?.addEventListener("click", () => {
    hideReaderComplete();
    setActiveView("library");
  });
  el.readerTapHintClose?.addEventListener("click", dismissReaderTapHint);
  el.appUpdate?.addEventListener("click", () => { void activateAppUpdate(); });
  el.installApp?.addEventListener("click", () => { void promptAppInstall(); });
  el.checkAppUpdate?.addEventListener("click", () => { void checkForAppUpdate(); });
  el.applyAppUpdate?.addEventListener("click", () => { void activateAppUpdate(); });
  el.deviceStorageRefresh?.addEventListener("click", () => { void refreshDeviceStorageFromControl(); });
  el.deviceStoragePersist?.addEventListener("click", () => { void protectDeviceStorage(); });
  el.deviceStorageSelectAll?.addEventListener("click", setAllDeviceStorageSelection);
  el.deviceStorageRemoveSelected?.addEventListener("click", () => openDeviceStorageRemovalDialog());
  el.deviceStorageCancel?.addEventListener("click", (event) => {
    event.preventDefault();
    closeDeviceStorageDialog();
  });
  el.deviceStorageConfirm?.addEventListener("click", () => { void confirmDeviceStorageRemoval(); });
  el.deviceStorageDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDeviceStorageDialog();
  });
  el.retryNetwork?.addEventListener("click", () => { void reconnectPanelPilot(); });
  el.testConnection.addEventListener("click", testConnection);
  el.loadSources.addEventListener("click", loadSources);
  el.finishSuwayomiSetup?.addEventListener("click", () => { void finishSuwayomiSetup(); });
  el.clearAppCache?.addEventListener("click", clearAppCache);
  el.syncProgress?.addEventListener("click", syncLibraryAndProgress);
  el.refreshMangabaka?.addEventListener("click", () => loadMangaBakaRecommendations({ announce: true }));
  el.clearRecommendationContext?.addEventListener("click", clearRecommendationContext);
  el.saveMangabaka?.addEventListener("click", connectMangaBaka);
  el.disconnectMangabaka?.addEventListener("click", disconnectMangaBaka);
  el.retryDownloads?.addEventListener("click", retryFailedDownloads);
  el.showNsfwSources?.addEventListener("change", (event) => setShowNsfwSources(event.target.checked));
  el.toggleSuwayomiPanel?.addEventListener("click", toggleSuwayomiSetupPanel);
  el.toggleLibraryPanel?.addEventListener("click", toggleLibraryPanel);
  el.toggleHiddenLibrary?.addEventListener("click", () => setShowHiddenLibrary(!state.showHiddenLibrary));
  el.libraryFilters.forEach((button) => button.addEventListener("click", () => setLibraryFilter(button.dataset.libraryFilter)));
  el.toggleBrowsePanel?.addEventListener("click", toggleBrowsePanel);
  el.closeMangaDetail?.addEventListener("click", closeMangaDetail);
  el.detailPrimary?.addEventListener("click", () => { void startOrContinueCurrentManga(); });
  el.detailLibrary?.addEventListener("click", () => { void addCurrentMangaToLibrary(); });
  el.browseOpenSettings?.addEventListener("click", () => {
    openSuwayomiSetup();
  });
  el.serverUrl?.addEventListener("input", () => {
    updateSuwayomiLink();
    updateSuwayomiSetupState();
  });
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
  el.keepScreenAwake?.addEventListener("change", (event) => setKeepScreenAwake(event.target.checked));
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
  el.motionSmooth?.addEventListener("click", () => setReaderMotion("smooth"));
  el.motionQuick?.addEventListener("click", () => setReaderMotion("quick"));
  el.motionInstant?.addEventListener("click", () => setReaderMotion("instant"));
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
    scheduleViewportFit();
  });
  window.visualViewport?.addEventListener("resize", scheduleViewportFit);
  window.visualViewport?.addEventListener("scroll", scheduleViewportFit);
  window.addEventListener("orientationchange", scheduleViewportFit);
  window.addEventListener("popstate", applyNavigationHistory);
  window.addEventListener("online", () => { void reconnectPanelPilot(); });
  window.addEventListener("offline", handleBrowserOffline);
  document.addEventListener("visibilitychange", () => {
    handleReaderVisibilityChange();
    if (document.hidden) return;
    if (state.activeView === "settings") void refreshDeviceStorage();
    if (!navigator.onLine) {
      handleBrowserOffline();
      return;
    }
    if (state.connected) {
      void flushSuwayomiProgressOutbox().catch(() => false);
      void refreshDownloadStatus().catch(() => null);
      void flushMangaBakaOutbox().catch(() => false);
    } else {
      void recoverSuwayomiConnection();
    }
  });
  window.addEventListener("pagehide", () => {
    pauseReaderLifecycle({ pageHiding: true });
  });
  window.addEventListener("pageshow", () => {
    state.readerLifecyclePaused = false;
    void resumeReaderLifecycle();
  });

  el.stage.addEventListener("click", handleStageTap);

  el.readerOptions?.addEventListener("toggle", () => {
    if (!el.readerOptions.open) return;
    requestAnimationFrame(() => {
      el.readerOptions.querySelector(".reader-options-sheet input, .reader-options-sheet button")?.focus();
    });
  });

  document.addEventListener("focusin", (event) => {
    const modal = activeReaderOverlay();
    if (!modal || modal.contains(event.target) || !readerIsVisible()) return;
    ensureActiveReaderModalFocus();
  });

  document.addEventListener("keydown", (event) => {
    const readerModal = activeReaderOverlay();
    if (readerModal) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (readerModal === el.readerLoading) cancelReaderLoading();
        else if (readerModal === el.readerTapHint) dismissReaderTapHint();
        else if (readerModal === el.readerComplete) hideReaderComplete();
        else leaveReaderView();
        return;
      }
      trapReaderModalFocus(event, readerModal);
      return;
    }
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
    if (state.activeView !== "reader" || isTextEntryTarget(event.target) || isInteractiveTarget(event.target)) return;
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

  void registerPanelPilotServiceWorker();
}

function getReaderLifecycleDiagnostics() {
  const residentNormalImages = state.pages.reduce((count, page) => count + (page?.image ? 1 : 0), 0);
  const residentWebtoonImages = state.pages.reduce(
    (count, page) => count + (Array.isArray(page?.sourceImages) ? page.sourceImages.filter((item) => item?.image).length : 0),
    0
  );
  return {
    visibilityState: document.visibilityState,
    visibilityEpoch: state.readerVisibilityEpoch,
    activeView: state.activeView,
    backgroundPreparing: state.backgroundPreparing,
    backgroundPaused: !state.backgroundWorkController || state.backgroundWorkController.signal.aborted,
    prefetchStatus: state.nextChapterPrefetch?.status || "idle",
    wakeLockSupported: Boolean(navigator.wakeLock?.request),
    keepScreenAwake: state.keepScreenAwake,
    wakeLockActive: Boolean(state.wakeLockSentinel && !state.wakeLockSentinel.released),
    wakeLockBlocked: state.wakeLockBlocked,
    residentDecodedImages: residentNormalImages + residentWebtoonImages,
    residentNormalImages,
    residentWebtoonImages,
    decodedImageCap: readerDecodedImageCap(),
    liveWebtoonImageNodes: el.stageStrip?.querySelectorAll("img[data-segment-index]").length || 0,
    liveWebtoonImageCap: webtoonLiveImageCap,
    metadataPages: state.pages.filter((page) => page?.detected).length,
    detectorRuns: state.performanceStats.detectorRuns,
    webtoonFailedIndex: state.pages[0]?.webtoonFailedIndex ?? null,
  };
}

window.PanelPilot = {
  detectorVersion,
  consolidateMangaPanels,
  detectPanels,
  fullPagePanel,
  loadImage,
  readerTapAction,
  retainUnacknowledgedMangaBakaEntries,
  sanitizeMangaBakaOutbox,
  sortPanels,
  getReaderLifecycleDiagnostics,
  handleReaderVisibilityChange,
  pauseReaderLifecycle,
  resumeReaderLifecycle,
  trimReaderMemory,
  getPerformanceStats: () => ({
    ...state.performanceStats,
    averagePreparationMs: Math.round(averagePreparationMs()),
    adaptiveLookaheadPages: adaptiveLookaheadPageCount(),
    adaptiveConcurrency: adaptivePreparationConcurrency(),
    queuedMoves: state.panelMoveQueue.length,
    backgroundPageAttempts: state.pages.map((page, index) => ({
      index,
      attempts: Number(page.backgroundAttempts || 0),
      failed: Boolean(page.backgroundFailed),
      retryAt: Number(page.backgroundRetryAt || 0),
    })),
    webtoonPreparation: state.pages[0]?.sourceImages ? {
      nextSourceIndex: Number(state.pages[0].webtoonNextSourceIndex || 0),
      failedIndex: state.pages[0].webtoonFailedIndex,
      attempts: { ...state.pages[0].webtoonBackgroundAttempts },
    } : null,
    nextChapterPrefetch: state.nextChapterPrefetch ? {
      status: state.nextChapterPrefetch.status,
      attempts: state.nextChapterPrefetch.attempts,
      urlsReady: state.nextChapterPrefetch.urlsReady,
      firstImageReady: state.nextChapterPrefetch.firstImageReady,
      firstPanelReady: state.nextChapterPrefetch.firstPanelReady,
      error: state.nextChapterPrefetch.error,
    } : null,
  }),
};

if (el.stage) {
  el.stage.dataset.readerBuild = appVersion;
  renderVersionNote();
  initializeInstallExperience();
  loadSettings();
  resetReaderVisibilityController();
  renderWakeLockState();
  const deviceChapterInitialization = initializeDeviceChapterState();
  void deviceChapterInitialization.then(() => refreshDeviceStorage()).catch(() => null);
  state.initialRoute = routeFromLocation();
  if (state.initialRoute.detail && state.initialRoute.manga) {
    state.currentManga = { ...state.initialRoute.manga };
    state.mangaDetailOrigin = state.initialRoute.origin || "browse";
  }
  if (state.initialRoute.view && state.initialRoute.view !== "reader") {
    state.activeView = state.initialRoute.view;
  }
  loadSuwayomiProgressOutbox();
  loadMangaBakaOutbox();
  loadLibraryItems();
  wireEvents();
  startBackgroundHealthChecks();
  setActiveView(state.activeView, { history: false });
  if (state.initialRoute.detail && state.initialRoute.manga) {
    el.mangaId.value = state.initialRoute.manga.id;
    showMangaDetail(state.initialRoute.manga, state.initialRoute.manga.sourceLabel, { history: false });
  }
  if (state.initialRoute.view === "reader") {
    window.history.replaceState({ panelPilot: true, view: "reader", detail: false }, "", "#reader");
  } else {
    recordNavigationState("replace", Boolean(state.initialRoute.detail));
  }
  if (navigator.onLine) {
    void refreshMangaBakaStatus();
    void loadMangaBakaRecommendations();
    setTimeout(() => {
      initializeSuwayomi().then(async () => {
        await deviceChapterInitialization;
        return restoreInitialRoute();
      }).catch((error) => {
        setConnection(false, `Could not initialize Suwayomi: ${error.message}`, "bad");
        showServerUnavailableStatus();
        void deviceChapterInitialization.then(() => restoreInitialRoute());
      });
    }, 250);
  } else {
    handleBrowserOffline();
    void deviceChapterInitialization.then(() => restoreInitialRouteOffline());
  }
}
