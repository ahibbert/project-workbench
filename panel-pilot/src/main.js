import {
  deviceChapterKey,
  deviceChapterIsIncomplete,
  deviceChapterPageUrls,
  deviceChapterStoredBytes,
  downloadDeviceChapter,
  getDeviceChapterStorageSnapshot,
  initializeDeviceChapters,
  listDeviceChapters,
  listDeviceChaptersForManga,
  markDeviceChapterOpened,
  markDeviceChapterRead,
  removeDeviceChapter,
  removeDeviceChapters,
  requestDeviceChapterPersistence,
  retryIncompleteDeviceChapter,
} from "./device-chapters.js";
import { reconcileReadingProgress } from "./progress-reconciliation.js";
import { createReadingStatsClient } from "./reading-stats.js";
import { createReadingSession, restoreReadingSession } from "./reading-session.js";
import { choosePanelDetectionFallback } from "./detection-policy.js";
import {
  chooseMomentForRediscovery,
  normalizeMomentRediscoveryState,
} from "./moments-rediscovery.js";
import {
  applyPanelCalibration,
  framePanelForBubbles,
  learnPanelCalibration,
  makePanelCalibrationSeriesId,
  normalizePanelCalibration,
} from "./panel-calibration.js";
import { classifyPageSpread, orderSpreadPanels } from "./page-spread.js";
import {
  clarityAwarePanelRect,
  normalizeHighZoomClarity,
} from "./reader-clarity.js";

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
const detectorVersion = "detector v19-ml-manga-comic";
const pageImageRetryDelaysMs = [0, 350];
const chapterFetchRetryDelaysMs = [0, 400];
const readerLoadingGraceMs = 180;
const nextChapterPreparedPageCount = 3;
const webtoonLiveImageCap = 8;
const highZoomEnhancementMaxPixels = 3_200_000;
const highZoomEnhancementMaxCanvasPixels = 4_200_000;
const highZoomEnhancementTrigger = 1.12;
const downloadAheadChapterCount = 10;
const planBufferRetryDelaysMs = [1000, 4000, 15000];
const progressOutboxStoreKey = "panel-pilot-progress-outbox";
const mangabakaOutboxStoreKey = "panel-pilot-mangabaka-outbox";
const tapHintStoreKey = "panel-pilot-tap-hint-seen";
const readingSessionStoreKey = "panel-pilot-reading-session-v1";
const momentRediscoveryStoreKey = "panel-pilot-moment-rediscovery-v1";
const panelCalibrationStoreKey = "panel-pilot-panel-calibration-v1";
const readingSessionTickMs = 15 * 1000;
const readingSessionMaxActiveGapMs = 30 * 1000;
const reconnectIntervalMs = 45 * 1000;
const downloadStatusPollMs = 15 * 1000;
const allSourcesValue = "__all__";
const defaultSuwayomiUrl = "http://localhost:4567";
const suwayomiCredentialsError = "Suwayomi URL must not include a username or password. Configure credentials on the server instead.";
const libraryStatuses = ["reading", "plan_to_read", "paused", "completed", "dropped", "rereading", "considering"];
const libraryFilterValues = ["reading", "plan_to_read", "paused", "completed", "other", "all"];
const mediaFormats = ["manga", "comic", "webtoon"];
const libraryFormatFilterValues = ["all", ...mediaFormats, "book"];
const mediaFormatLabels = { manga: "Manga", comic: "Comic", webtoon: "Webtoon", book: "Book" };
const libraryStatusLabels = {
  reading: "Reading",
  plan_to_read: "Plan to read",
  paused: "Paused",
  completed: "Completed",
  dropped: "Dropped",
  rereading: "Rereading",
  considering: "Considering",
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
  chapterProgress: `query GET_CHAPTER_PROGRESS($id: Int!) {
    chapter(id: $id) {
      id
      mangaId
      sourceOrder
      chapterNumber
      pageCount
      isRead
      lastPageRead
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
  navLibrary: document.querySelector("#nav-library"),
  navBooks: document.querySelector("#nav-books"),
  booksRoot: document.querySelector("#books-root"),
  libraryFormatBooks: document.querySelector("#library-format-books"),
  browseBooks: document.querySelector("#browse-books"),
  browseMediaSwitch: document.querySelector("#browse-media-switch"),
  bookServicesPanel: document.querySelector("#book-services-panel"),
  bookServicesState: document.querySelector("#book-services-state"),
  bookServicesNote: document.querySelector("#book-services-note"),
  testShelfmark: document.querySelector("#test-shelfmark"),
  testCwa: document.querySelector("#test-cwa"),
  syncBooks: document.querySelector("#sync-books"),
  settingsFindBooks: document.querySelector("#settings-find-books"),
  bookStatsPanel: document.querySelector("#book-stats-panel"),
  bookStatsCount: document.querySelector("#book-stats-count"),
  bookStatsSummary: document.querySelector("#book-stats-summary"),
  navStats: document.querySelector("#nav-stats"),
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
  downloadStatFailedFilter: document.querySelector("#download-stat-failed-filter"),
  downloadChapterList: document.querySelector("#download-chapter-list"),
  downloadStatusIssue: document.querySelector("#download-status-issue"),
  downloadStatusRetry: document.querySelector("#download-status-retry"),
  serverBufferRetention: document.querySelector("#server-buffer-retention"),
  serverBufferRetentionSummary: document.querySelector("#server-buffer-retention-summary"),
  serverBufferRetentionDays: document.querySelector("#server-buffer-retention-days"),
  serverBufferRetentionKeep: document.querySelector("#server-buffer-retention-keep"),
  serverBufferRetentionPreview: document.querySelector("#server-buffer-retention-preview"),
  serverBufferRetentionApply: document.querySelector("#server-buffer-retention-apply"),
  serverBufferRetentionResult: document.querySelector("#server-buffer-retention-result"),
  readerBack: document.querySelector("#reader-back"),
  readerView: document.querySelector("#reader-view"),
  stageImage: document.querySelector("#stage-image"),
  stageEnhancement: document.querySelector("#stage-enhancement"),
  stageImageWrap: document.querySelector("#stage-image-wrap"),
  readerOverviewHint: document.querySelector("#reader-overview-hint"),
  readerLoading: document.querySelector("#reader-loading"),
  readerLoadingBar: document.querySelector("#reader-loading-bar"),
  readerLoadingText: document.querySelector("#reader-loading-text"),
  readerLoadingCancel: document.querySelector("#reader-loading-cancel"),
  readerError: document.querySelector("#reader-error"),
  readerErrorTitle: document.querySelector("#reader-error-title"),
  readerErrorMessage: document.querySelector("#reader-error-message"),
  readerErrorRetry: document.querySelector("#reader-error-retry"),
  readerErrorBack: document.querySelector("#reader-error-back"),
  readerErrorSource: document.querySelector("#reader-error-source"),
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
  readerSessionStat: document.querySelector("#reader-session-stat"),
  panelCount: document.querySelector("#panel-count"),
  panelStrip: document.querySelector("#panel-strip"),
  sourceIntelligenceState: document.querySelector("#source-intelligence-state"),
  sourceIntelligenceList: document.querySelector("#source-intelligence-list"),
  sourceIntelligenceNote: document.querySelector("#source-intelligence-note"),
  sourceIntelligenceFilters: [...document.querySelectorAll("[data-source-intelligence-format]")],
  refreshSourceIntelligence: document.querySelector("#refresh-source-intelligence"),
  prevPanel: document.querySelector("#prev-panel"),
  nextPanel: document.querySelector("#next-panel"),
  keepScreenAwake: document.querySelector("#keep-screen-awake"),
  wakeLockStatus: document.querySelector("#wake-lock-status"),
  panelPadding: document.querySelector("#panel-padding"),
  panelPaddingValue: document.querySelector("#panel-padding-value"),
  bubbleAwareFraming: document.querySelector("#bubble-aware-framing"),
  bubbleAwareFramingReader: document.querySelector("#bubble-aware-framing-reader"),
  highZoomClarity: document.querySelector("#high-zoom-clarity"),
  highZoomClarityReader: document.querySelector("#high-zoom-clarity-reader"),
  highZoomEnhancement: document.querySelector("#high-zoom-enhancement"),
  highZoomEnhancementReader: document.querySelector("#high-zoom-enhancement-reader"),
  pageReveal: document.querySelector("#page-reveal"),
  pageRevealReader: document.querySelector("#page-reveal-reader"),
  cinematicMotion: document.querySelector("#cinematic-motion"),
  cinematicMotionReader: document.querySelector("#cinematic-motion-reader"),
  toggleFit: document.querySelector("#toggle-fit"),
  hideReaderControls: document.querySelector("#hide-reader-controls"),
  toggleReaderMode: document.querySelector("#toggle-reader-mode"),
  readerOptions: document.querySelector(".reader-options"),
  redetect: document.querySelector("#redetect"),
  redetectChapter: document.querySelector("#redetect-chapter"),
  reportBadPanels: document.querySelector("#report-bad-panels"),
  saveMoment: document.querySelector("#save-moment"),
  finishReadingSession: document.querySelector("#finish-reading-session"),
  momentsGrid: document.querySelector("#moments-grid"),
  momentsCount: document.querySelector("#moments-count"),
  momentRediscovery: document.querySelector("#moment-rediscovery"),
  momentRediscoveryCard: document.querySelector("#moment-rediscovery-card"),
  momentRediscoveryNext: document.querySelector("#moment-rediscovery-next"),
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
  librarySyncStatus: document.querySelector("#library-sync-status"),
  librarySyncStatusLabel: document.querySelector("#library-sync-status-label"),
  libraryBody: document.querySelector("#library-body"),
  libraryList: document.querySelector("#library-list"),
  libraryCount: document.querySelector("#library-count"),
  libraryFilters: [...document.querySelectorAll("[data-library-filter]")],
  libraryFilterCounts: [...document.querySelectorAll("[data-library-count]")],
  libraryFormatFilters: [...document.querySelectorAll("[data-library-format-filter]")],
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
  comicRecommendations: document.querySelector("#comic-recommendations"),
  comicRecommendationResults: document.querySelector("#comic-recommendation-results"),
  comicRecommendationsNote: document.querySelector("#comic-recommendations-note"),
  refreshComicRecommendations: document.querySelector("#refresh-comic-recommendations"),
  libraryThingApiKey: document.querySelector("#librarything-api-key"),
  openLibraryContact: document.querySelector("#open-library-contact"),
  saveComicRecommendationsConfig: document.querySelector("#save-comic-recommendations-config"),
  disconnectComicRecommendations: document.querySelector("#disconnect-comic-recommendations"),
  comicRecommendationsConfigState: document.querySelector("#comic-recommendations-config-state"),
  comicRecommendationsConfigNote: document.querySelector("#comic-recommendations-config-note"),
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
  detailChangeSource: document.querySelector("#detail-change-source"),
  detailLibraryStatus: document.querySelector("#detail-library-status"),
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
  statsWelcome: document.querySelector("#stats-welcome"),
  statsEnable: document.querySelector("#stats-enable"),
  statsDashboard: document.querySelector("#stats-dashboard"),
  statsSince: document.querySelector("#stats-since"),
  statsRangeSelect: document.querySelector("#stats-range-select"),
  statsActiveTime: document.querySelector("#stats-active-time"),
  statsChapters: document.querySelector("#stats-chapters"),
  statsRereads: document.querySelector("#stats-rereads"),
  statsPages: document.querySelector("#stats-pages"),
  statsDays: document.querySelector("#stats-days"),
  statsTitles: document.querySelector("#stats-titles"),
  statsCompletedTitles: document.querySelector("#stats-completed-titles"),
  statsSummaryGrid: document.querySelector(".stats-summary-grid"),
  statsRhythm: document.querySelector("#stats-rhythm"),
  statsCurrentRhythm: document.querySelector("#stats-current-rhythm"),
  statsLongestRhythm: document.querySelector("#stats-longest-rhythm"),
  statsCalendar: document.querySelector("#stats-calendar"),
  statsAchievementsPanel: document.querySelector(".stats-achievements"),
  statsAchievementCount: document.querySelector("#stats-achievement-count"),
  statsAchievementList: document.querySelector("#stats-achievement-list"),
  statsEnabled: document.querySelector("#stats-enabled"),
  statsShowSummary: document.querySelector("#stats-show-summary"),
  statsShowRhythm: document.querySelector("#stats-show-rhythm"),
  statsCelebrations: document.querySelector("#stats-celebrations"),
  statsExport: document.querySelector("#stats-export"),
  statsReset: document.querySelector("#stats-reset"),
  statsStatus: document.querySelector("#stats-status"),
  statsResetDialog: document.querySelector("#stats-reset-dialog"),
  statsResetCancel: document.querySelector("#stats-reset-cancel"),
  statsResetConfirm: document.querySelector("#stats-reset-confirm"),
  statsResetConfirmation: document.querySelector("#stats-reset-confirmation"),
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
  deviceStorageFilters: [...document.querySelectorAll("[data-device-storage-filter]")],
  deviceStorageRetryIncomplete: document.querySelector("#device-storage-retry-incomplete"),
  deviceStorageClearIncomplete: document.querySelector("#device-storage-clear-incomplete"),
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
  comickChapterNumber: document.querySelector("#comick-chapter-number"),
  loadComickNumber: document.querySelector("#load-comick-number"),
  loadComickMore: document.querySelector("#load-comick-more"),
  comickList: document.querySelector("#comick-list"),
  comickCount: document.querySelector("#comick-count"),
};

const readerIsolationPrevious = new Map();
const downloadSheetIsolationPrevious = new Map();

const state = {
  baseUrl: defaultSuwayomiUrl,
  sources: [],
  visibleSources: [],
  sourceProfiles: new Map(),
  sourceProfilesPromise: null,
  sourceIndex: { entries: [], updatedAt: "", sourceIds: [] },
  sourceIndexing: false,
  mangas: [],
  chapters: [],
  chapterView: [],
  scanlatorFilter: "auto",
  currentManga: null,
  libraryItems: [],
  moments: [],
  momentsLoaded: false,
  momentRediscoveryState: normalizeMomentRediscoveryState(),
  momentRediscoveryMomentId: "",
  panelCalibration: normalizePanelCalibration(),
  librarySavePromise: null,
  librarySavePending: false,
  pendingResume: null,
  readerErrorRetryAction: null,
  readerLoadingCancelAction: null,
  readerLoadRequestId: 0,
  readerLoadController: null,
  libraryFilter: "reading",
  libraryFormatFilter: "all",
  chapterPageUrls: [],
  pages: [],
  pageIndex: 0,
  panelIndex: 0,
  fullPage: false,
  readerFullscreenOwned: false,
  panelMode: "manga",
  panelModeUserOverride: false,
  panelPadding: 8,
  bubbleAwareFraming: true,
  highZoomClarity: "balanced",
  highZoomEnhancement: true,
  pageReveal: "off",
  pageRevealActive: false,
  readingDirection: "rtl",
  readerMotion: "smooth",
  cinematicMotion: false,
  readerCamera: null,
  readerCameraAnimation: null,
  readerCameraSettleTimer: 0,
  highZoomEnhancementTimer: 0,
  highZoomEnhancementRequestId: 0,
  highZoomEnhancementWorker: null,
  highZoomEnhancementCancel: null,
  readerOverview: null,
  readerOverviewRestoreTimer: 0,
  readerHoldTimer: 0,
  readerHoldPointer: null,
  readerPinch: null,
  suppressReaderTapUntil: 0,
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
  comicModelAvailable: null,
  navigationPending: false,
  navigationRequestId: 0,
  navigationController: null,
  navigationCooldownUntil: 0,
  panelMoveQueue: [],
  panelMoveQueueRunning: false,
  cameraFitFrame: 0,
  viewportFitTimer: 0,
  // Do not suppress the first viewport event during a fast startup.
  viewportFitAt: Number.NEGATIVE_INFINITY,
  viewportFitSignature: "",
  webtoonScrollFrame: 0,
  webtoonAutoAdvanceTimer: 0,
  webtoonScrollIntent: false,
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
    viewportFits: 0,
    backgroundStarts: 0,
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
  booksEnabled: false,
  booksController: null,
  booksControllerPromise: null,
  booksIntegration: null,
  bookServicesController: null,
  bookLibraryItems: [],
  booksLibraryLoading: false,
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
  suwayomiForegroundSyncPromise: null,
  suwayomiProgressOutbox: [],
  planBufferSignatures: new Map(),
  planBufferRequests: new Map(),
  planBufferRetryTimers: new Map(),
  reconnectTimer: null,
  downloadStatusTimer: null,
  downloadStatus: null,
  downloadStatusSheetOpen: false,
  downloadStatusReturnFocus: null,
  downloadStatusFilter: "all",
  serverBufferRetentionPreview: null,
  libraryOfflineWindows: new Map(),
  libraryOfflineReadiness: new Map(),
  libraryDeferredRenderPending: false,
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
  deviceStorageFilter: "all",
  deviceStorageRepairing: false,
  historyApplying: false,
  viewScrollPositions: { library: 0, books: 0, browse: 0, settings: 0 },
  browseDiscoveryScroll: 0,
  mangaDetailOrigin: "browse",
  mangaDetailReturnFocus: null,
  searchRequestGeneration: 0,
  searchAbortController: null,
  mangabakaRecommendations: [],
  comicRecommendations: [],
  comicRecommendationsLoaded: false,
  comicRecommendationsConfigured: false,
  comicRecommendationsManagedByEnvironment: false,
  mangabakaConnected: false,
  mangabakaConfigured: false,
  mangabakaOutbox: [],
  mangabakaAccountKey: "",
  mangabakaOutboxRevision: 0,
  mangabakaSyncPromise: null,
  mangabakaSyncTimer: null,
  pendingMangaBakaRecommendation: null,
  sourceMigration: null,
  sourceIntelligence: null,
  sourceIntelligenceFormat: "all",
  sourceIntelligenceLoading: false,
  setupReturnToBrowse: false,
  cameraPageChanged: false,
  readerModalReturnFocus: null,
  readerModalReturnFocusSelector: "",
  initialRoute: null,
  readingStatsSettings: null,
  readingStatsSummary: null,
  readingStatsRange: "30d",
  readingStatsTracker: null,
  readingStatsAttemptId: "",
  readingStatsFinishedAttempt: "",
  readingStatsPageViews: new Set(),
  readingStatsRefreshTimer: 0,
  readingSession: null,
  readingSessionActiveAt: 0,
  readingSessionTimer: 0,
};

const readingStatsClient = createReadingStatsClient();

function readingSessionTitleKey() {
  return String(state.currentManga?.id || state.currentManga?.mangaId || "demo");
}

function readingSessionEligible() {
  return Boolean(
    state.activeView === "reader" &&
    state.pages.length &&
    !state.readerLifecyclePaused &&
    !state.navigationPending &&
    !activeReaderOverlay()
  );
}

function ensureReadingSession() {
  if (state.readingSession && !state.readingSession.finished && !state.readingSession.isExpired()) return state.readingSession;
  state.readingSession = createReadingSession();
  persistReadingSession();
  return state.readingSession;
}

function persistReadingSession() {
  try {
    if (state.readingSession?.finished) localStorage.removeItem(readingSessionStoreKey);
    else if (state.readingSession) localStorage.setItem(readingSessionStoreKey, state.readingSession.serialize());
  } catch {
    // Session polish remains usable when browser storage is unavailable.
  }
}

function formatReadingSessionDuration(activeMs) {
  const minutes = Math.max(0, Math.floor(Number(activeMs || 0) / 60_000));
  if (minutes < 1) return "just started";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function renderReadingSession() {
  if (!el.readerSessionStat) return;
  const snapshot = state.readingSession?.snapshot();
  el.readerSessionStat.hidden = !snapshot;
  if (!snapshot) return;
  const chapterText = snapshot.chaptersFinished
    ? ` · ${snapshot.chaptersFinished} ch`
    : "";
  el.readerSessionStat.textContent = `Session · ${formatReadingSessionDuration(snapshot.activeMs)}${chapterText}`;
  el.readerSessionStat.title = `${snapshot.pagesViewed} page${snapshot.pagesViewed === 1 ? "" : "s"} viewed in this private, device-local session`;
}

function checkpointReadingSession(at = Date.now()) {
  if (!state.readingSession || !state.readingSessionActiveAt) return;
  const elapsed = Math.max(0, Math.min(readingSessionMaxActiveGapMs, at - state.readingSessionActiveAt));
  state.readingSessionActiveAt = at;
  if (elapsed) state.readingSession.addActiveTime(Math.round(elapsed), { at, titleKey: readingSessionTitleKey() });
  persistReadingSession();
  renderReadingSession();
}

function syncReadingSessionActivity() {
  window.clearInterval(state.readingSessionTimer);
  state.readingSessionTimer = 0;
  if (!readingSessionEligible()) {
    checkpointReadingSession();
    state.readingSessionActiveAt = 0;
    return;
  }
  ensureReadingSession();
  state.readingSessionActiveAt = Date.now();
  state.readingSessionTimer = window.setInterval(() => checkpointReadingSession(), readingSessionTickMs);
  renderReadingSession();
}

function recordCurrentReadingSessionPage() {
  if (!state.pages.length) return;
  const session = ensureReadingSession();
  session.recordPage({
    pageKey: `${state.activeChapter?.type || "reader"}:${state.activeChapter?.chapterId || readingSessionTitleKey()}:${state.pageIndex}`,
    titleKey: readingSessionTitleKey(),
  });
  persistReadingSession();
  renderReadingSession();
  if (readingSessionEligible() && !state.readingSessionActiveAt) syncReadingSessionActivity();
}

function showReadingSessionCheckIn() {
  const status = state.readingSession?.claimCheckIn();
  if (!status?.pending) return;
  const reason = status.reasons.includes("chapters")
    ? `${status.chaptersSinceCheckIn} chapters down`
    : `${formatReadingSessionDuration(status.activeMsSinceCheckIn)} of reading`;
  showToast(`${reason} · nice session. Stretch, grab water, or keep going.`, "good");
  state.readingSession.acknowledgeCheckIn();
  persistReadingSession();
}

function recordCurrentReadingSessionFinish() {
  const attemptId = state.readingStatsAttemptId || `${state.activeChapter?.chapterId || readingSessionTitleKey()}:${Date.now()}`;
  const recorded = ensureReadingSession().recordChapterFinish({ attemptId, titleKey: readingSessionTitleKey() });
  persistReadingSession();
  renderReadingSession();
  if (recorded) showReadingSessionCheckIn();
  if (state.activeChapter?.type === "suwayomi") {
    void markDeviceChapterRead(
      state.activeChapter.serverUrl || currentDeviceServerUrl(),
      state.activeChapter.chapterId
    ).then((chapterPackage) => {
      if (chapterPackage) rememberDevicePackage(chapterPackage);
    }).catch(() => null);
  }
}

function finishReadingSession() {
  if (!state.readingSession) {
    showToast("Start reading a chapter to begin a session.");
    return;
  }
  checkpointReadingSession();
  const recap = state.readingSession.finish({ reason: "reader-finished" });
  const parts = [formatReadingSessionDuration(recap.activeMs)];
  if (recap.chaptersFinished) parts.push(`${recap.chaptersFinished} chapter${recap.chaptersFinished === 1 ? "" : "s"}`);
  if (recap.pagesViewed) parts.push(`${recap.pagesViewed} page${recap.pagesViewed === 1 ? "" : "s"}`);
  persistReadingSession();
  state.readingSession = null;
  state.readingSessionActiveAt = 0;
  window.clearInterval(state.readingSessionTimer);
  state.readingSessionTimer = 0;
  renderReadingSession();
  if (el.readerOptions) el.readerOptions.open = false;
  showToast(`Session complete · ${parts.join(" · ")}`, "good");
}

function restoreLocalReadingSession() {
  try {
    const serialized = localStorage.getItem(readingSessionStoreKey);
    if (!serialized) return;
    const restored = restoreReadingSession(serialized);
    if (restored.status === "active") state.readingSession = restored.session;
    else localStorage.removeItem(readingSessionStoreKey);
  } catch {
    // Invalid or unavailable local storage starts a clean session.
  }
  renderReadingSession();
}

function restorePrivateReaderModels() {
  try {
    state.momentRediscoveryState = normalizeMomentRediscoveryState(
      JSON.parse(localStorage.getItem(momentRediscoveryStoreKey) || "{}")
    );
  } catch {
    state.momentRediscoveryState = normalizeMomentRediscoveryState();
  }
  try {
    state.panelCalibration = normalizePanelCalibration(
      JSON.parse(localStorage.getItem(panelCalibrationStoreKey) || "{}")
    );
  } catch {
    state.panelCalibration = normalizePanelCalibration();
  }
}

function persistMomentRediscoveryState() {
  try {
    localStorage.setItem(momentRediscoveryStoreKey, JSON.stringify(state.momentRediscoveryState));
  } catch {
    // Rediscovery remains optional when device storage is unavailable.
  }
}

function persistPanelCalibration() {
  try {
    localStorage.setItem(panelCalibrationStoreKey, JSON.stringify(state.panelCalibration));
  } catch {
    // Calibration is a private convenience and never blocks reading.
  }
}

let networkReconnectPromise = null;
let suwayomiRecoveryPromise = null;
let networkStatusHideTimer = 0;

function loadSettings() {
  let savedSuwayomiUrlError = "";
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) || "{}");
    if (saved.baseUrl) {
      const migration = migratePersistedSuwayomiUrl(saved.baseUrl);
      state.baseUrl = migration.url;
      if (migration.changed) {
        saved.baseUrl = migration.url;
        localStorage.setItem(storeKey, JSON.stringify(saved));
        savedSuwayomiUrlError = migration.message;
      }
    }
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
    if (libraryFormatFilterValues.includes(saved.libraryFormatFilter)) state.libraryFormatFilter = saved.libraryFormatFilter;
    if (Number.isFinite(saved.panelPadding)) state.panelPadding = clamp(saved.panelPadding, 0, 25);
    if (typeof saved.bubbleAwareFraming === "boolean") state.bubbleAwareFraming = saved.bubbleAwareFraming;
    state.highZoomClarity = normalizeHighZoomClarity(saved.highZoomClarity);
    if (typeof saved.highZoomEnhancement === "boolean") state.highZoomEnhancement = saved.highZoomEnhancement;
    if (["off", "before", "after"].includes(saved.pageReveal)) state.pageReveal = saved.pageReveal;
    if (typeof saved.cinematicMotion === "boolean") state.cinematicMotion = saved.cinematicMotion;
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
  updateBubbleAwareFramingControls();
  updateReaderInteractionControls();
  if (el.keepScreenAwake) el.keepScreenAwake.checked = state.keepScreenAwake;
  updatePaddingControl();
  updatePanelModeControls();
  applyReaderMotion();
  setReadingDirection(state.readingDirection);
  if (savedSuwayomiUrlError) {
    setConnection(false, savedSuwayomiUrlError, "bad");
  }
}

function saveSettings() {
  let persistedBaseUrl = defaultSuwayomiUrl;
  try {
    persistedBaseUrl = normalizeSuwayomiBaseUrl(state.baseUrl);
  } catch {
    state.baseUrl = defaultSuwayomiUrl;
  }
  localStorage.setItem(panelModeStoreKey, state.panelMode);
  localStorage.setItem(
    storeKey,
    JSON.stringify({
      baseUrl: persistedBaseUrl,
      panelMode: state.panelMode,
      readingDirection: state.readingDirection,
      readerMotion: state.readerMotion,
      libraryFilter: state.libraryFilter,
      libraryFormatFilter: state.libraryFormatFilter,
      panelPadding: state.panelPadding,
      bubbleAwareFraming: state.bubbleAwareFraming,
      highZoomClarity: state.highZoomClarity,
      highZoomEnhancement: state.highZoomEnhancement,
      pageReveal: state.pageReveal,
      cinematicMotion: state.cinematicMotion,
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

const achievementPalettes = {
  chapter: { accent: "#236c6e", soft: "#d9eeec" },
  pages: { accent: "#3b6f9c", soft: "#e0edf8" },
  time: { accent: "#6f5c9f", soft: "#eee9f8" },
  explore: { accent: "#a9602d", soft: "#faeadc" },
  complete: { accent: "#9b7118", soft: "#fff1c7" },
  days: { accent: "#3f7d51", soft: "#e2f1e5" },
  rhythm: { accent: "#b64d43", soft: "#f9dfdb" },
  reread: { accent: "#9b4f78", soft: "#f4dfeb" },
  daily: { accent: "#4b5fa7", soft: "#e6e9f7" },
  star: { accent: "#77672f", soft: "#f4edcf" },
};

const readingAchievementDefinitions = [
  { id: "first-finish", name: "First finish", description: "Finish your first chapter", icon: "chapter" },
  { id: "ten-finishes", name: "Chapter scout", description: "Finish 10 unique chapters", icon: "chapter" },
  { id: "twenty-five-finishes", name: "Turning pages", description: "Finish 25 unique chapters", icon: "chapter" },
  { id: "fifty-finishes", name: "Shelf momentum", description: "Finish 50 unique chapters", icon: "chapter" },
  { id: "hundred-finishes", name: "Century reader", description: "Finish 100 unique chapters", icon: "chapter" },
  { id: "two-fifty-finishes", name: "Chapter titan", description: "Finish 250 unique chapters", icon: "chapter" },
  { id: "hundred-pages", name: "Page turner", description: "Read 100 pages", icon: "pages" },
  { id: "five-hundred-pages", name: "Paper trail", description: "Read 500 pages", icon: "pages" },
  { id: "thousand-pages", name: "Thousand-page stare", description: "Read 1,000 pages", icon: "pages" },
  { id: "five-thousand-pages", name: "Ink ocean", description: "Read 5,000 pages", icon: "pages" },
  { id: "one-reading-hour", name: "Settling in", description: "Spend an hour reading", icon: "time" },
  { id: "ten-reading-hours", name: "Lost in the panels", description: "Spend 10 hours reading", icon: "time" },
  { id: "fifty-reading-hours", name: "Long-form legend", description: "Spend 50 hours reading", icon: "time" },
  { id: "hundred-reading-hours", name: "Time well read", description: "Spend 100 hours reading", icon: "time" },
  { id: "three-titles", name: "Curious reader", description: "Explore 3 titles", icon: "explore" },
  { id: "ten-titles", name: "Genre hopper", description: "Explore 10 titles", icon: "explore" },
  { id: "twenty-five-titles", name: "Library wanderer", description: "Explore 25 titles", icon: "explore" },
  { id: "first-title-complete", name: "The end", description: "Complete your first series", icon: "complete" },
  { id: "five-titles-complete", name: "Series finisher", description: "Complete 5 series", icon: "complete" },
  { id: "ten-titles-complete", name: "Closing credits", description: "Complete 10 series", icon: "complete" },
  { id: "seven-reading-days", name: "A week of reading", description: "Read on 7 different days", icon: "days" },
  { id: "thirty-reading-days", name: "Regular visitor", description: "Read on 30 different days", icon: "days" },
  { id: "hundred-reading-days", name: "Well-worn bookmark", description: "Read on 100 different days", icon: "days" },
  { id: "three-day-rhythm", name: "Finding a rhythm", description: "Read 3 days in a row", icon: "rhythm" },
  { id: "seven-day-rhythm", name: "Seven-day rhythm", description: "Read 7 days in a row", icon: "rhythm" },
  { id: "fourteen-day-rhythm", name: "Fortnight flow", description: "Read 14 days in a row", icon: "rhythm" },
  { id: "thirty-day-rhythm", name: "Month in motion", description: "Read 30 days in a row", icon: "rhythm" },
  { id: "first-reread", name: "Worth another look", description: "Reread a chapter", icon: "reread" },
  { id: "five-rereads", name: "Second-pass scholar", description: "Reread 5 chapters", icon: "reread" },
  { id: "twenty-five-rereads", name: "Comfort chapters", description: "Reread 25 chapters", icon: "reread" },
  { id: "ten-chapter-day", name: "Chapter sprint", description: "Finish 10 chapters in one reading day", icon: "daily" },
  { id: "hundred-page-day", name: "Page storm", description: "Read 100 pages in one reading day", icon: "daily" },
  { id: "two-hour-day", name: "Deep dive", description: "Read for 2 hours in one reading day", icon: "daily" },
].map((definition) => ({
  ...achievementPalettes[definition.icon],
  ...definition,
}));

const achievementArtPaths = {
  chapter: '<path d="M10 12.5c6-2 11-.8 14 3.2v21c-3-4-8-5.2-14-3.2Z"/><path d="M38 12.5c-6-2-11-.8-14 3.2v21c3-4 8-5.2 14-3.2Z"/><path d="M24 15.7v21"/>',
  pages: '<path d="M13 10h22v27H13z"/><path d="M9 14v27h22"/><path d="M18 17h12M18 23h12M18 29h8"/>',
  time: '<circle cx="24" cy="24" r="15"/><path d="M24 15v10l7 4"/><path d="M19 7h10"/>',
  explore: '<circle cx="24" cy="24" r="16"/><path d="m29 19-3.5 6.5L19 29l3.5-6.5Z"/><circle cx="24" cy="24" r="2"/>',
  complete: '<path d="M15 10h18v8c0 8-3.8 13-9 15-5.2-2-9-7-9-15Z"/><path d="M15 15H9c0 6 3 9 8 9M33 15h6c0 6-3 9-8 9M20 38h8M24 33v5"/><path d="m24 16 1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6Z"/>',
  days: '<rect x="9" y="12" width="30" height="27" rx="4"/><path d="M9 20h30M17 8v8M31 8v8"/><path d="m17 29 4 4 10-10"/>',
  rhythm: '<path d="M26 7c2 8-5 9-2 15 1.5-3 5-5 8-7 2 4 6 8 6 15 0 8-6 13-14 13S10 38 10 29c0-7 4-13 10-18-1 7 1 9 3 11 0-6 5-9 3-15Z"/>',
  reread: '<path d="M11 20a14 14 0 0 1 24-6l3 3M37 10v7h-7M37 28a14 14 0 0 1-24 6l-3-3M11 38v-7h7"/><path d="M19 18h10v12H19z"/>',
  daily: '<path d="M27 6 13 27h10l-2 15 14-22H25Z"/><path d="M9 38h7M32 10h7"/>',
  star: '<path d="m24 8 4.7 9.5 10.5 1.5-7.6 7.4 1.8 10.4-9.4-5-9.4 5 1.8-10.4L8.8 19l10.5-1.5Z"/>',
};

function achievementDefinition(achievement = {}) {
  const id = achievement.id || achievement.key;
  return readingAchievementDefinitions.find((item) => item.id === id) || {
    id,
    name: achievement.name || achievement.title || "Reading milestone",
    description: achievement.description || "A personal reading milestone",
    icon: "star",
    ...achievementPalettes.star,
  };
}

function createAchievementArt(definition, unlocked = false) {
  const mark = document.createElement("span");
  mark.className = "achievement-mark";
  mark.dataset.unlocked = unlocked ? "true" : "false";
  mark.style.setProperty("--achievement-accent", definition.accent || achievementPalettes.star.accent);
  mark.style.setProperty("--achievement-soft", definition.soft || achievementPalettes.star.soft);
  mark.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("achievement-art");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = achievementArtPaths[definition.icon] || achievementArtPaths.star;
  mark.append(svg);
  return mark;
}

function defaultReadingStatsSettings() {
  return {
    enabled: false,
    showStats: true,
    showRhythm: true,
    celebrations: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    dayStartHour: 4,
  };
}

function normalizedReadingStatsSummary(summary = {}) {
  const totals = summary.totals || summary;
  const rhythm = summary.rhythm || summary;
  return {
    ...summary,
    since: summary.since || summary.prospectiveSince || null,
    activeSeconds: Number(totals.activeSeconds) || 0,
    pages: Number(totals.pages ?? totals.pageViews) || 0,
    chapterFinishes: Number(totals.chapterFinishes) || 0,
    uniqueChapters: Number(totals.uniqueChapters) || 0,
    rereads: Number(totals.rereads) || 0,
    completedTitles: Number(totals.completedTitles) || 0,
    readingDays: Number(totals.readingDays) || 0,
    titlesExplored: Number(totals.titlesExplored) || 0,
    currentRhythm: Number(rhythm.currentRhythm ?? rhythm.current ?? rhythm.currentDays) || 0,
    longestRhythm: Number(rhythm.longestRhythm ?? rhythm.longest ?? rhythm.longestDays) || 0,
    calendar: Array.isArray(summary.calendar) ? summary.calendar : (Array.isArray(summary.days) ? summary.days : []),
    achievements: Array.isArray(summary.achievements) ? summary.achievements : [],
  };
}

function formatReadingDuration(seconds) {
  const totalMinutes = Math.max(0, Math.round((Number(seconds) || 0) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}

function formatStatsSince(value) {
  if (!value) return "Not started";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Since you enabled it";
  return `Since ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date)}`;
}

function renderReadingStats() {
  const settings = { ...defaultReadingStatsSettings(), ...(state.readingStatsSettings || {}) };
  const summary = normalizedReadingStatsSummary(state.readingStatsSummary || {});
  const since = summary.since || settings.since || settings.startedAt || null;
  const hasStarted = Boolean(since || settings.enabled);
  if (el.statsWelcome) el.statsWelcome.hidden = hasStarted;
  if (el.statsDashboard) el.statsDashboard.hidden = !hasStarted;
  if (el.statsSince) el.statsSince.textContent = formatStatsSince(since);
  if (el.statsEnabled) el.statsEnabled.checked = Boolean(settings.enabled);
  if (el.statsShowSummary) el.statsShowSummary.checked = settings.showStats !== false;
  if (el.statsShowRhythm) el.statsShowRhythm.checked = settings.showRhythm !== false;
  if (el.statsCelebrations) el.statsCelebrations.checked = settings.celebrations !== false;
  if (el.statsRangeSelect) el.statsRangeSelect.value = state.readingStatsRange;
  if (el.statsSummaryGrid) el.statsSummaryGrid.hidden = settings.showStats === false;
  if (el.statsAchievementsPanel) el.statsAchievementsPanel.hidden = settings.showStats === false;
  if (el.statsRhythm) el.statsRhythm.hidden = settings.showRhythm === false;

  if (el.statsActiveTime) el.statsActiveTime.textContent = formatReadingDuration(summary.activeSeconds);
  if (el.statsChapters) el.statsChapters.textContent = String(summary.chapterFinishes);
  if (el.statsRereads) el.statsRereads.textContent = `${summary.uniqueChapters} unique · ${summary.rereads} reread${summary.rereads === 1 ? "" : "s"}`;
  if (el.statsPages) el.statsPages.textContent = String(summary.pages);
  if (el.statsDays) el.statsDays.textContent = String(summary.readingDays);
  if (el.statsTitles) el.statsTitles.textContent = `${summary.titlesExplored} title${summary.titlesExplored === 1 ? "" : "s"} explored`;
  if (el.statsCompletedTitles) el.statsCompletedTitles.textContent = String(summary.completedTitles);
  if (el.statsCurrentRhythm) el.statsCurrentRhythm.textContent = `Current: ${summary.currentRhythm} day${summary.currentRhythm === 1 ? "" : "s"}`;
  if (el.statsLongestRhythm) el.statsLongestRhythm.textContent = `Longest rhythm: ${summary.longestRhythm} day${summary.longestRhythm === 1 ? "" : "s"}`;
  if (state.booksEnabled && state.booksIntegration) {
    state.booksIntegration.renderBookStats({
      panel: el.bookStatsPanel,
      count: el.bookStatsCount,
      summary: el.bookStatsSummary,
    }, state.bookLibraryItems);
  }

  if (el.statsCalendar) {
    el.statsCalendar.replaceChildren();
    const days = summary.calendar.slice(-28);
    days.forEach((day) => {
      const activeSeconds = Number(day.activeSeconds) || 0;
      const finishes = Number(day.chapterFinishes) || 0;
      const cell = document.createElement("span");
      cell.className = "stats-calendar-day";
      cell.dataset.level = activeSeconds >= 3600 || finishes >= 4 ? "3" : activeSeconds >= 1200 || finishes >= 2 ? "2" : (day.readingDay || activeSeconds || finishes) ? "1" : "0";
      cell.setAttribute("aria-label", `${day.date}: ${formatReadingDuration(activeSeconds)}, ${finishes} chapter${finishes === 1 ? "" : "s"} finished`);
      cell.title = cell.getAttribute("aria-label");
      el.statsCalendar.append(cell);
    });
    el.statsCalendar.setAttribute("aria-label", days.length
      ? `Reading activity across ${days.length} recorded day${days.length === 1 ? "" : "s"}`
      : "No reading activity recorded yet");
  }

  if (el.statsAchievementList) {
    el.statsAchievementList.replaceChildren();
    const unlockedById = new Map(summary.achievements.map((achievement) => [achievement.id || achievement.key, achievement]));
    const definitions = [...readingAchievementDefinitions];
    summary.achievements.forEach((achievement) => {
      const id = achievement.id || achievement.key;
      if (id && !definitions.some((item) => item.id === id)) {
        definitions.push(achievementDefinition(achievement));
      }
    });
    definitions.forEach((definition) => {
      const unlocked = unlockedById.get(definition.id);
      const card = document.createElement("article");
      card.className = "achievement-card";
      card.dataset.unlocked = unlocked ? "true" : "false";
      const mark = createAchievementArt(definition, Boolean(unlocked));
      const copy = document.createElement("span");
      copy.className = "achievement-copy";
      const title = document.createElement("strong");
      title.textContent = unlocked?.name || unlocked?.title || definition.name;
      const note = document.createElement("small");
      note.textContent = unlocked?.description || definition.description;
      const status = document.createElement("span");
      status.className = "achievement-status";
      status.textContent = unlocked ? "Unlocked" : "Still to discover";
      copy.append(title, note, status);
      card.append(mark, copy);
      el.statsAchievementList.append(card);
    });
  }
  if (el.statsAchievementCount) {
    const unlockedCount = summary.achievements.length;
    el.statsAchievementCount.textContent = `${unlockedCount} of ${readingAchievementDefinitions.length} unlocked`;
  }
}

async function flushReadingStats({ celebrate = true } = {}) {
  const result = await readingStatsClient.flush();
  const unlocked = Array.isArray(result.newAchievements) ? result.newAchievements : [];
  if (celebrate && state.readingStatsSettings?.celebrations !== false && unlocked.length) {
    showAchievementToast(unlocked[0], Math.max(0, unlocked.length - 1));
  }
  return result;
}

async function refreshReadingStats({ flush = true } = {}) {
  if (flush && state.readingStatsSettings?.enabled) await flushReadingStats();
  const result = await readingStatsClient.getSummary(state.readingStatsRange);
  if (result.summary) {
    state.readingStatsSummary = result.summary;
    if (result.summary.settings) {
      state.readingStatsSettings = { ...defaultReadingStatsSettings(), ...state.readingStatsSettings, ...result.summary.settings };
    }
  }
  if (el.statsStatus) {
    el.statsStatus.textContent = result.status === "unsupported"
      ? "Reading stats are unavailable until this Panels server is updated. Everything else still works."
      : result.status === "fresh"
        ? (state.readingStatsSettings?.enabled ? "Reading activity is private and synced." : "Tracking is paused. Your existing history is still private.")
        : "Reading activity is available from this device and will sync when the server reconnects.";
  }
  renderReadingStats();
  return result;
}

async function initializeReadingStats() {
  try {
    await readingStatsClient.initialize();
    state.readingStatsSettings = { ...defaultReadingStatsSettings(), ...(await readingStatsClient.getSettings()) };
    await refreshReadingStats({ flush: false });
    syncReadingStatsTracker();
    window.clearInterval(state.readingStatsRefreshTimer);
    state.readingStatsRefreshTimer = window.setInterval(() => {
      if (state.readingStatsTracker) void state.readingStatsTracker.checkpoint();
      if (navigator.onLine && state.readingStatsSettings?.enabled) void flushReadingStats();
    }, 15_000);
  } catch (error) {
    if (el.statsStatus) el.statsStatus.textContent = `Reading stats are unavailable on this device: ${error.message}`;
    renderReadingStats();
  }
}

async function updateReadingStatsSettings(patch) {
  const wasEnabled = Boolean(state.readingStatsSettings?.enabled);
  const next = { ...defaultReadingStatsSettings(), ...state.readingStatsSettings, ...patch };
  if (next.enabled && !wasEnabled && !next.since && !next.startedAt) next.startedAt = new Date().toISOString();
  state.readingStatsSettings = await readingStatsClient.setSettings(next);
  renderReadingStats();
  syncReadingStatsTracker();
  await refreshReadingStats({ flush: next.enabled });
}

function readingStatsContext() {
  const chapterId = Number(state.activeChapter?.chapterId);
  const mangaId = Number(state.currentManga?.id || state.currentManga?.mangaId);
  if (
    state.activeChapter?.type !== "suwayomi" ||
    !Number.isInteger(chapterId) ||
    !Number.isInteger(mangaId) ||
    isNsfwLibraryItem(state.currentManga)
  ) return null;
  return {
    serverUrl: state.activeChapter.serverUrl || currentDeviceServerUrl(),
    mangaId,
    chapterId,
    offline: Boolean(state.activeChapter.deviceLocal || !navigator.onLine),
  };
}

function readingStatsEligible() {
  return Boolean(
    state.readingStatsSettings?.enabled &&
    state.activeView === "reader" &&
    state.pages.length &&
    readingStatsContext() &&
    !state.readerLifecyclePaused &&
    !state.navigationPending &&
    !activeReaderOverlay()
  );
}

function syncReadingStatsTracker() {
  if (!readingStatsEligible()) {
    const tracker = state.readingStatsTracker;
    state.readingStatsTracker = null;
    if (tracker) void tracker.stop().then(() => flushReadingStats());
    return;
  }
  if (state.readingStatsTracker?.running) return;
  state.readingStatsTracker = readingStatsClient.createActivityTracker();
  state.readingStatsTracker.start(readingStatsContext());
}

function prepareReadingStatsChapterAttempt() {
  state.readingStatsAttemptId = readingStatsClient.createAttemptId();
  state.readingStatsFinishedAttempt = "";
  state.readingStatsPageViews = new Set();
}

function recordCurrentReadingStatsPage() {
  if (!state.readingStatsSettings?.enabled) return;
  const context = readingStatsContext();
  if (!context) return;
  const viewKey = `${context.chapterId}:${state.pageIndex}`;
  if (state.readingStatsPageViews.has(viewKey)) return;
  state.readingStatsPageViews.add(viewKey);
  void readingStatsClient.recordPageView({ ...context, pageIndex: state.pageIndex }).then(() => flushReadingStats());
}

function recordCurrentReadingStatsFinish() {
  recordCurrentReadingSessionFinish();
  const context = readingStatsContext();
  const attemptId = state.readingStatsAttemptId;
  if (!state.readingStatsSettings?.enabled || !context || !attemptId || state.readingStatsFinishedAttempt === attemptId) return;
  state.readingStatsFinishedAttempt = attemptId;
  void readingStatsClient.recordChapterFinish({ ...context, attemptId }).then(() => flushReadingStats());
}

async function exportReadingStats() {
  const payload = await readingStatsClient.exportData();
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "panels-reading-stats.json";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function resetReadingStats() {
  if (el.statsResetConfirmation?.value !== "ERASE") {
    el.statsResetConfirmation?.setCustomValidity("Type ERASE to confirm.");
    el.statsResetConfirmation?.reportValidity();
    return;
  }
  await readingStatsClient.reset({ confirm: "ERASE" });
  state.readingStatsSettings = defaultReadingStatsSettings();
  state.readingStatsSummary = null;
  state.readingStatsAttemptId = "";
  state.readingStatsPageViews.clear();
  syncReadingStatsTracker();
  el.statsResetDialog?.close();
  if (el.statsResetConfirmation) el.statsResetConfirmation.value = "";
  if (el.statsStatus) el.statsStatus.textContent = "Reading activity was reset. Suwayomi progress was not changed.";
  renderReadingStats();
}

function isAppView(view) {
  return view === "library" || view === "books" || view === "browse" || view === "moments" || view === "stats" || view === "reader" || view === "settings";
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
  if (route === "book-detail" || route === "book-read" || route === "books-search") {
    return { view: "books", bookRoute: route, bookQuery: query, detail: false, manga: null, origin: "books" };
  }
  return { view: isAppView(route) ? route : null, bookRoute: route === "books" ? "books" : "", bookQuery: query, detail: false, manga: null, origin: "browse" };
}

async function ensureBooksApp() {
  if (state.booksController) return state.booksController;
  if (!state.booksControllerPromise) {
    state.booksControllerPromise = import("./books-app.js").then(({ createBooksApp }) => {
      state.booksController = createBooksApp({
        root: el.booksRoot,
        navigate: navigateBookRoute,
        onLibraryChange: refreshIntegratedBookLibrary,
      });
      return state.booksController;
    });
  }
  return state.booksControllerPromise;
}

function navigateBookRoute(route, parameters = {}) {
  if (!state.booksEnabled) return;
  if (route === "library") {
    setActiveView("library");
    return;
  }
  if (route === "browse") {
    setActiveView("browse");
    return;
  }
  const query = new URLSearchParams(parameters).toString();
  const hash = `#${route}${query ? `?${query}` : ""}`;
  window.history.pushState({ panelPilot: true, view: "books", bookRoute: route }, "", hash);
  setActiveView("books", { history: false });
}

async function refreshIntegratedBookLibrary({ render = true } = {}) {
  if (!state.booksEnabled || state.booksLibraryLoading) return state.bookLibraryItems;
  state.booksLibraryLoading = true;
  try {
    const response = await fetch("/api/books?limit=200", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Book library request failed (${response.status})`);
    const payload = await response.json();
    state.bookLibraryItems = Array.isArray(payload.books) ? payload.books : [];
    if (render) renderLibrary({ preserveInteractions: false });
    else updateReaderNav();
    if (state.activeView === "stats") renderReadingStats();
    return state.bookLibraryItems;
  } catch {
    // CWA/Shelfmark outages must not disturb the existing manga library. Retain the
    // last successful book snapshot and allow the dedicated Books view to explain errors.
    return state.bookLibraryItems;
  } finally {
    state.booksLibraryLoading = false;
  }
}

async function showBooksRoute() {
  if (!state.booksEnabled) return;
  const controller = await ensureBooksApp();
  await controller.show(routeFromLocation());
}

async function initializeBooksFeature() {
  try {
    const response = await fetch("/api/books/status", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return;
    const status = await response.json();
    state.booksEnabled = status.enabled === true;
    el.navBooks?.setAttribute("hidden", "");
    el.libraryFormatBooks?.toggleAttribute("hidden", !state.booksEnabled);
    el.browseBooks?.toggleAttribute("hidden", !state.booksEnabled);
    el.browseMediaSwitch?.toggleAttribute("hidden", !state.booksEnabled);
    el.bookServicesPanel?.toggleAttribute("hidden", !state.booksEnabled);
    if (!state.booksEnabled && state.libraryFormatFilter === "book") state.libraryFormatFilter = "all";
    if (!state.booksEnabled && state.activeView === "books") {
      setActiveView("library", { history: false });
      recordNavigationState("replace", false);
      return;
    }
    if (state.booksEnabled) {
      state.booksIntegration ||= await import("./books-integration.js");
      state.bookServicesController ||= state.booksIntegration.createBookServicesController({
        elements: {
          panel: el.bookServicesPanel,
          state: el.bookServicesState,
          note: el.bookServicesNote,
          testShelfmark: el.testShelfmark,
          testCwa: el.testCwa,
          sync: el.syncBooks,
          findBooks: el.settingsFindBooks,
        },
        navigate: navigateBookRoute,
        onLibraryChange: refreshIntegratedBookLibrary,
      });
      await refreshIntegratedBookLibrary({ render: true });
      if (state.activeView === "books") void showBooksRoute();
    }
  } catch {
    state.booksEnabled = false;
    el.libraryFormatBooks?.setAttribute("hidden", "");
    el.browseBooks?.setAttribute("hidden", "");
    el.browseMediaSwitch?.setAttribute("hidden", "");
    el.bookServicesPanel?.setAttribute("hidden", "");
    if (state.libraryFormatFilter === "book") state.libraryFormatFilter = "all";
  }
}

function applyReaderMotion() {
  const durations = { smooth: "220ms", quick: "120ms", instant: "0ms" };
  const motion = durations[state.readerMotion] ? state.readerMotion : "smooth";
  state.readerMotion = motion;
  document.documentElement.style.setProperty("--reader-motion-duration", durations[motion]);
  document.documentElement.style.setProperty("--reader-motion-easing", "cubic-bezier(0.25, 0.1, 0.25, 1)");
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
  if (previous === "books" && view !== "books") state.booksController?.hide?.();
  if (previous && previous !== "reader") state.viewScrollPositions[previous] = window.scrollY;
  if (view === "reader" && previous !== "reader") {
    state.previousView = previous;
  }
  if (view !== "reader") {
    clearWebtoonAutoAdvance();
    clearReaderHoldGesture();
    state.readerPinch = null;
    if (state.readerOverview) endReaderOverview({ cancelled: true });
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
    const bookRoute = view === "books" ? routeFromLocation().bookRoute : "";
    const navigationView = view === "books" ? (bookRoute === "books-search" ? "browse" : "library") : view;
    const isActive = button.dataset.targetView === navigationView;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  });
  document.body.classList.toggle("reader-active", view === "reader");
  syncReaderPresentationClasses();
  if (view === "reader") setDownloadStatusSheet(false);
  if (view === "settings") {
    void refreshDeviceStorage();
    if (state.connected || state.sourceIntelligence) void refreshSourceIntelligence();
  }
  if (view === "browse" && (!state.comicRecommendationsLoaded || (!state.comicRecommendations.length && state.libraryItems.some((item) => inferredMediaFormat(item) === "comic" && !isNsfwLibraryItem(item))))) {
    void loadComicRecommendations();
  }
  if (view === "stats") void refreshReadingStats();
  if (view === "moments") void loadMoments();
  if (view === "books") void showBooksRoute();
  if (view === "library" && state.booksEnabled) void refreshIntegratedBookLibrary();

  if (view === "reader") {
    setReaderFocus(isReaderFocusAvailable());
    void resumeReaderLifecycle();
  } else {
    exitReaderFullscreen();
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
  syncReadingStatsTracker();
  syncReadingSessionActivity();
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
  const rawUrl = el.serverUrl?.value || state.baseUrl || defaultSuwayomiUrl;
  let normalizedUrl = "";
  try {
    normalizedUrl = normalizeSuwayomiBaseUrl(rawUrl);
  } catch (error) {
    setConnection(false, error.message, "bad");
    throw error;
  }
  state.baseUrl = normalizedUrl;
  if (el.serverUrl) el.serverUrl.value = state.baseUrl;
  updateSuwayomiLink();
  saveSettings();
  return state.baseUrl;
}

function updateSuwayomiLink() {
  if (!el.openSuwayomi) return;
  const rawUrl = el.serverUrl?.value || state.baseUrl || defaultSuwayomiUrl;
  try {
    const url = normalizeSuwayomiBaseUrl(rawUrl);
    el.openSuwayomi.href = externalSuwayomiUrl(url);
  } catch (error) {
    el.openSuwayomi.removeAttribute("href");
    setConnection(false, error.message, "bad");
  }
}

function normalizeSuwayomiBaseUrl(value) {
  const raw = String(value || defaultSuwayomiUrl).trim() || defaultSuwayomiUrl;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Suwayomi URL must be an absolute http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Suwayomi URL must start with http:// or https://.");
  }
  if (parsed.username || parsed.password) {
    throw new Error(suwayomiCredentialsError);
  }
  parsed.hash = "";
  if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  else parsed.pathname = "";
  return parsed.href.replace(/\/$/, "");
}

function migratePersistedSuwayomiUrl(value) {
  const raw = String(value || "").trim();
  try {
    const url = normalizeSuwayomiBaseUrl(raw);
    return { url, changed: url !== raw, message: "" };
  } catch (error) {
    try {
      const parsed = new URL(raw);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:")
        && (parsed.username || parsed.password)
      ) {
        parsed.username = "";
        parsed.password = "";
        const url = normalizeSuwayomiBaseUrl(parsed.href);
        return {
          url,
          changed: true,
          message: `Saved credentials were removed from the Suwayomi URL. Reconnect to ${url}.`,
        };
      }
    } catch {
      // Fall through to the safe local default for malformed persisted values.
    }
    return {
      url: defaultSuwayomiUrl,
      changed: true,
      message: `${error?.message || "The saved Suwayomi URL was invalid."} The saved URL was reset to ${defaultSuwayomiUrl}.`,
    };
  }
}

function sanitizePersistedSuwayomiUrl(value) {
  return migratePersistedSuwayomiUrl(value).url;
}

function sanitizeLibraryServerUrls(items) {
  return items.map((item) => {
    if (!item?.serverUrl) return item;
    const serverUrl = sanitizePersistedSuwayomiUrl(item.serverUrl);
    return serverUrl === item.serverUrl ? item : { ...item, serverUrl };
  });
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
  if (state.sourceMigration) {
    await continueSourceMigrationSearch();
  } else if (state.pendingMangaBakaRecommendation) {
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
  renderMoments();
  syncReadingStatsTracker();
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
  } else if (connectionChanged) {
    setSyncStatus("Connected", "Connected to Suwayomi; checking reading progress next.");
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
      loadSourceProfiles(),
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
    ? normalizeSuwayomiBaseUrl(options.baseUrl)
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
  const message = typeof error === "string" ? error : (error?.message || "Unknown error");
  if (/^Suwayomi URL\b/i.test(message)) return message;
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

function applySourceProfiles(payload) {
  const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
  state.sourceProfiles = new Map(profiles.map((profile) => [String(profile.sourceId), profile]));
  return state.sourceProfiles;
}

async function loadSourceProfiles() {
  try {
    return applySourceProfiles(await localJson("/api/source-profiles"));
  } catch {
    return state.sourceProfiles;
  }
}

function sourceIntelligenceVariant(source) {
  const detected = detectedMediaFormatFromMetadata(source);
  const mediaFormat = detected || "manga";
  const safeToken = (value, fallback) => String(value || fallback)
    .replace(/[^A-Za-z0-9._+:-]/g, "_")
    .slice(0, 200) || fallback;
  return {
    sourceId: String(source?.id || "unknown_source").replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 100),
    packageName: safeToken(source?.extension?.pkgName, `source-${source?.id || "unknown"}`),
    displayName: String(source?.displayName || source?.name || source?.id || "Unknown source").slice(0, 240),
    language: String(source?.lang || "und").slice(0, 35),
    storeIdentity: safeToken(source?.extension?.repo, "suwayomi"),
    extensionVersion: "unknown",
    installed: true,
    obsolete: false,
    formats: [mediaFormat],
    formatProvenance: "automatic",
    formatConfidence: detected ? 0.85 : 0.55,
  };
}

async function syncSourceIntelligenceInventory() {
  if (!state.sources.length) return null;
  try {
    const payload = await postLocalJson("/api/source-intelligence/inventory", {
      schemaVersion: 1,
      sources: state.sources.map(sourceIntelligenceVariant),
    });
    if (state.sourceIntelligence) state.sourceIntelligence.inventory = payload.inventory || [];
    return payload;
  } catch {
    return null;
  }
}

function hasFiniteSourceScore(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

function sourceScoreText(value) {
  return hasFiniteSourceScore(value) ? `${Math.round(Number(value))}` : "—";
}

function renderSourceIntelligence() {
  if (!el.sourceIntelligenceList) return;
  const payload = state.sourceIntelligence;
  const scores = Array.isArray(payload?.scores) ? payload.scores : [];
  const inventory = Array.isArray(payload?.inventory) ? payload.inventory : [];
  const visibleScores = scores
    .filter((score) => state.sourceIntelligenceFormat === "all" || score.mediaFormat === state.sourceIntelligenceFormat)
    .sort((left, right) => Number(right.suitability ?? -1) - Number(left.suitability ?? -1));
  el.sourceIntelligenceFilters.forEach((button) => {
    const active = button.dataset.sourceIntelligenceFormat === state.sourceIntelligenceFormat;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  el.sourceIntelligenceList.replaceChildren();
  if (!payload) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = state.sourceIntelligenceLoading ? "Loading source evidence…" : "Source evidence is not available yet.";
    el.sourceIntelligenceList.append(note);
    return;
  }
  if (!visibleScores.length) {
    const note = document.createElement("p");
    note.className = "note source-intelligence-empty";
    note.textContent = inventory.length
      ? `Tracking ${inventory.length} installed source variant${inventory.length === 1 ? "" : "s"}. Rankings will appear after successful and failed source requests are observed.`
      : "Load your Suwayomi sources to begin private reliability tracking.";
    el.sourceIntelligenceList.append(note);
  } else {
    visibleScores.forEach((score, index) => {
      const row = document.createElement("article");
      row.className = "source-intelligence-row";
      const rank = document.createElement("span");
      rank.className = "source-intelligence-rank";
      rank.textContent = String(index + 1);
      const copy = document.createElement("span");
      copy.className = "source-intelligence-copy";
      const title = document.createElement("strong");
      title.textContent = score.displayName || score.packageName || score.sourceId;
      const meta = document.createElement("small");
      const flags = [score.mediaFormat, score.confidence, score.stale ? "version changed" : "", score.obsolete ? "obsolete" : ""].filter(Boolean);
      meta.textContent = flags.join(" · ");
      copy.append(title, meta);
      const metrics = document.createElement("span");
      metrics.className = "source-intelligence-metrics";
      metrics.innerHTML = `<strong>${sourceScoreText(score.suitability)}</strong><small>overall</small><span>R ${sourceScoreText(score.reliability)}</span><span>Q ${sourceScoreText(score.quality)}</span><span>C ${sourceScoreText(score.coverage)}</span>`;
      row.append(rank, copy, metrics);
      el.sourceIntelligenceList.append(row);
    });
  }
  if (el.sourceIntelligenceState) {
    const counts = payload.counts || {};
    el.sourceIntelligenceState.textContent = visibleScores.length
      ? `${visibleScores.length} ranked`
      : `${Number(counts.installed ?? inventory.filter((item) => item.installed).length) || 0} tracked`;
  }
}

async function refreshSourceIntelligence({ announce = false } = {}) {
  if (state.sourceIntelligenceLoading) return state.sourceIntelligence;
  state.sourceIntelligenceLoading = true;
  renderSourceIntelligence();
  setBusy(el.refreshSourceIntelligence, true, "Refreshing");
  try {
    state.sourceIntelligence = await localJson("/api/source-intelligence");
    if (el.sourceIntelligenceNote) {
      el.sourceIntelligenceNote.textContent = announce ? "Source health refreshed." : "Rankings improve as Panels observes more source requests.";
    }
  } catch (error) {
    if (el.sourceIntelligenceNote) el.sourceIntelligenceNote.textContent = `Source health is unavailable: ${friendlySourceErrorMessage(error)}`;
  } finally {
    state.sourceIntelligenceLoading = false;
    setBusy(el.refreshSourceIntelligence, false);
    renderSourceIntelligence();
  }
  return state.sourceIntelligence;
}

function setSourceIntelligenceFormat(format) {
  state.sourceIntelligenceFormat = mediaFormats.includes(format) ? format : "all";
  renderSourceIntelligence();
}

function makeSourceObservation(source, operation, outcome, startedAt, mediaFormat = "") {
  return {
    sourceId: String(source?.id ?? source?.sourceId ?? ""),
    sourceLabel: sourceLabel(source || {}),
    operation,
    outcome,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    mediaFormat: mediaFormats.includes(mediaFormat) ? mediaFormat : (detectedMediaFormatFromMetadata(source) || "manga"),
  };
}

async function recordSourceObservations(observations) {
  const valid = observations.filter((observation) => observation.sourceId);
  if (!valid.length || !navigator.onLine) return;
  try {
    applySourceProfiles(await postLocalJson("/api/source-profiles", {
      observations: valid.map((observation) => ({
        ...observation,
        operation: observation.operation === "image_fetch" ? "download" : observation.operation === "page_list" ? "pages" : observation.operation,
      })),
    }));
  } catch {
    // Source history is advisory and must never interrupt browsing or reading.
  }
  try {
    await postLocalJson("/api/source-intelligence/observations", {
      schemaVersion: 1,
      observations: valid.map((observation) => ({
        sourceId: String(observation.sourceId).replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 100),
        operation: observation.operation === "pages" ? "page_list" : observation.operation,
        outcome: observation.outcome,
        errorClass: observation.outcome === "success" ? "" : "unknown",
        latencyMs: observation.latencyMs,
        byteCount: Math.max(0, Math.round(Number(observation.byteCount) || 0)),
        width: Math.max(0, Math.round(Number(observation.width) || 0)),
        height: Math.max(0, Math.round(Number(observation.height) || 0)),
        codec: String(observation.codec || "").toLowerCase(),
        clarity: Number.isFinite(Number(observation.clarity)) ? clamp(Number(observation.clarity), 0, 1) : null,
        placeholder: Boolean(observation.placeholder),
        mediaFormat: observation.mediaFormat,
        origin: "passive",
        occurredAt: new Date().toISOString(),
      })),
    });
  } catch {
    // New source intelligence is advisory and must never interrupt reading.
  }
}

async function deleteLocalJson(path) {
  const response = await fetch(appUrl(path), { method: "DELETE" });
  const payload = await response.json().catch(() => null);
  handleAuthenticationResponse(response, payload);
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `Local request failed with HTTP ${response.status}`);
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

function comicRecommendationReason(recommendation) {
  const seed = recommendation?.reason?.seedTitles?.[0];
  if (seed) return `Because you read ${seed}`;
  return "Selected from your Western comics library";
}

function comicRecommendationSearchItem(recommendation) {
  const searchTitles = [recommendation?.title, ...(recommendation?.searchTitles || [])].filter(Boolean);
  return {
    ...recommendation,
    recommendationSource: "comic",
    media_type: "comic",
    titles: [...new Set(searchTitles)].map((title, index) => ({ title, language: "en", is_primary: index === 0 })),
    cover_url: recommendation?.coverUrl || "",
  };
}

function applyComicRecommendationsConfigStatus(payload = {}) {
  state.comicRecommendationsConfigured = Boolean(payload.configured);
  state.comicRecommendationsManagedByEnvironment = Boolean(payload.managedByEnvironment);
  if (el.comicRecommendationsConfigState) {
    el.comicRecommendationsConfigState.textContent = state.comicRecommendationsConfigured ? "Configured" : "Not configured";
  }
  if (el.disconnectComicRecommendations) {
    el.disconnectComicRecommendations.hidden = !state.comicRecommendationsConfigured || state.comicRecommendationsManagedByEnvironment;
  }
  if (el.saveComicRecommendationsConfig) {
    el.saveComicRecommendationsConfig.disabled = state.comicRecommendationsManagedByEnvironment;
  }
  if (el.libraryThingApiKey) {
    el.libraryThingApiKey.disabled = state.comicRecommendationsManagedByEnvironment;
    el.libraryThingApiKey.placeholder = state.comicRecommendationsConfigured ? "Key stored on server" : "Paste developer key";
  }
  if (el.openLibraryContact) el.openLibraryContact.disabled = state.comicRecommendationsManagedByEnvironment;
  if (el.comicRecommendationsConfigNote) {
    el.comicRecommendationsConfigNote.textContent = state.comicRecommendationsManagedByEnvironment
      ? "Configured by the server environment. The key is not available to this browser."
      : state.comicRecommendationsConfigured
        ? "Configured. The key is stored on this server and is not returned to the browser."
        : "The comic and book feeds remain off until a key is configured.";
  }
}

async function refreshComicRecommendationsConfig() {
  try {
    const payload = await localJson("/api/comic-recommendations/config");
    applyComicRecommendationsConfigStatus(payload);
    return payload;
  } catch (error) {
    if (el.comicRecommendationsConfigState) el.comicRecommendationsConfigState.textContent = "Unavailable";
    if (el.comicRecommendationsConfigNote) el.comicRecommendationsConfigNote.textContent = friendlySourceErrorMessage(error);
    return null;
  }
}

async function saveComicRecommendationsConfig() {
  const apiKey = el.libraryThingApiKey?.value.trim() || "";
  const contact = el.openLibraryContact?.value.trim() || "";
  if (!apiKey) return showToast("Paste your LibraryThing developer key first.", "bad");
  setBusy(el.saveComicRecommendationsConfig, true, "Saving");
  try {
    const payload = await postLocalJson("/api/comic-recommendations/config", { apiKey, contact });
    if (el.libraryThingApiKey) el.libraryThingApiKey.value = "";
    if (el.openLibraryContact) el.openLibraryContact.value = "";
    applyComicRecommendationsConfigStatus(payload);
    state.comicRecommendationsLoaded = false;
    await loadComicRecommendations({ force: true });
    showToast("LibraryThing key saved on your Panels server.", "good");
  } catch (error) {
    showToast(`Could not save the LibraryThing key: ${friendlySourceErrorMessage(error)}`, "bad");
  } finally {
    setBusy(el.saveComicRecommendationsConfig, false);
  }
}

async function disconnectComicRecommendations() {
  setBusy(el.disconnectComicRecommendations, true, "Removing");
  try {
    const payload = await postLocalJson("/api/comic-recommendations/config", { clear: true });
    applyComicRecommendationsConfigStatus(payload);
    state.comicRecommendations = [];
    state.comicRecommendationsLoaded = true;
    renderComicRecommendations("unconfigured");
    showToast("LibraryThing key removed.");
  } catch (error) {
    showToast(`Could not remove the LibraryThing key: ${friendlySourceErrorMessage(error)}`, "bad");
  } finally {
    setBusy(el.disconnectComicRecommendations, false);
  }
}

function renderComicRecommendations(status = "") {
  if (!el.comicRecommendationResults) return;
  el.comicRecommendationResults.replaceChildren();
  if (!state.comicRecommendations.length) {
    const message = status === "unconfigured"
      ? "Add a LibraryThing API key on the Panels server to enable this feed."
      : status === "needs-library"
        ? "Add a Western comic to your library to start this feed."
        : status === "unavailable"
          ? "Comic recommendations are temporarily unavailable."
          : "No comic recommendations are ready yet.";
    el.comicRecommendationResults.append(emptyLine(message));
    return;
  }
  state.comicRecommendations.forEach((recommendation) => {
    const pending = comicRecommendationSearchItem(recommendation);
    const card = document.createElement("article");
    card.className = "recommendation-card";
    const cover = createCoverButton({ title: recommendation.title, thumbnailUrl: recommendation.coverUrl }, {
      title: recommendation.title,
      eyebrow: [recommendation.year, ...(recommendation.creators || []).slice(0, 1)].filter(Boolean).join(" · ") || "Western comic",
      meta: "Find a readable source",
    });
    cover.addEventListener("click", () => findMangaBakaSource(pending));
    const reason = document.createElement("p");
    reason.className = "recommendation-reason";
    reason.textContent = comicRecommendationReason(recommendation);
    const find = document.createElement("button");
    find.type = "button";
    find.textContent = state.connected && state.visibleSources.length ? "Read this" : "Set up to read";
    find.addEventListener("click", () => findMangaBakaSource(pending));
    card.append(cover, reason, find);
    el.comicRecommendationResults.append(card);
  });
}

async function loadComicRecommendations({ announce = false, force = false } = {}) {
  if (!el.comicRecommendationResults) return;
  const hasComicLibrary = state.libraryItems.some((item) => !isNsfwLibraryItem(item) && inferredMediaFormat(item) === "comic" && !["dropped", "considering"].includes(item.libraryStatus));
  if (!force && !hasComicLibrary) {
    state.comicRecommendations = [];
    state.comicRecommendationsLoaded = true;
    if (el.comicRecommendationsNote) el.comicRecommendationsNote.textContent = "Add a Western comic to your library to personalize this feed";
    renderComicRecommendations("needs-library");
    return;
  }
  if (el.comicRecommendationsNote) el.comicRecommendationsNote.textContent = "Loading Western comic recommendations…";
  setBusy(el.refreshComicRecommendations, true, "Loading");
  try {
    const payload = await localJson("/api/comic-recommendations?limit=12");
    applyComicRecommendationsConfigStatus(payload);
    state.comicRecommendations = Array.isArray(payload.results) ? payload.results : [];
    state.comicRecommendationsLoaded = true;
    renderComicRecommendations(payload.status);
    if (el.comicRecommendationsNote) {
      el.comicRecommendationsNote.textContent = payload.status === "ready"
        ? `Based on ${payload.seedTitles?.length || 0} comic${payload.seedTitles?.length === 1 ? "" : "s"} in your library${payload.cacheStatus === "stale" ? " · showing the last good feed" : ""}`
        : payload.status === "unconfigured"
          ? "LibraryThing is not configured on this Panels server yet"
          : payload.status === "needs-library"
            ? "Add a Western comic to your library to personalize this feed"
            : "The recommendation providers are temporarily unavailable";
    }
    if (announce) showToast(payload.status === "ready" ? "Comic recommendations refreshed." : "Comic recommendations are not ready yet.", payload.status === "ready" ? "good" : "");
  } catch (error) {
    state.comicRecommendations = [];
    state.comicRecommendationsLoaded = true;
    if (el.comicRecommendationsNote) el.comicRecommendationsNote.textContent = friendlySourceErrorMessage(error);
    renderComicRecommendations("unavailable");
  } finally {
    setBusy(el.refreshComicRecommendations, false);
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
  const migration = state.sourceMigration;
  el.recommendationContext.hidden = !series && !migration;
  if (migration) {
    const sourceName = migration.fromManga?.sourceLabel || migration.fromLibraryItem?.sourceLabel || "current source";
    if (el.recommendationContextTitle) el.recommendationContextTitle.textContent = `Move ${migration.title} to another source`;
    if (el.recommendationContextNote) {
      el.recommendationContextNote.textContent = `Currently using ${sourceName}. Choose a matching result below; your Panels status and reading position will be retained.`;
    }
    if (el.clearRecommendationContext) el.clearRecommendationContext.textContent = "Cancel";
    return;
  }
  if (el.clearRecommendationContext) el.clearRecommendationContext.textContent = "Clear";
  if (!series) return;
  const title = mangaBakaTitle(series);
  if (el.recommendationContextTitle) el.recommendationContextTitle.textContent = `Choose a source for ${title}`;
  if (el.recommendationContextNote) {
    const reason = series.recommendationSource === "comic" ? comicRecommendationReason(series) : mangaBakaReason(series);
    el.recommendationContextNote.textContent = `${reason} · Exact matches are ranked by format, image quality, and reliability.`;
  }
}

function clearRecommendationContext() {
  state.pendingMangaBakaRecommendation = null;
  state.sourceMigration = null;
  state.setupReturnToBrowse = false;
  updateRecommendationContext();
  updateMangaDetailActions();
}

async function continuePendingRecommendationSearch() {
  const series = state.pendingMangaBakaRecommendation;
  if (!series) return;
  el.searchQuery.value = mangaBakaTitle(series);
  el.sourceSelect.value = allSourcesValue;
  el.searchQuery.scrollIntoView({ behavior: "smooth", block: "center" });
  await searchSource();
}

async function continueSourceMigrationSearch() {
  const migration = state.sourceMigration;
  if (!migration) return;
  el.searchQuery.value = migration.title;
  el.sourceSelect.value = allSourcesValue;
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

function mangaBakaEligibleLibraryItem(item) {
  return inferredMediaFormat(item) === "manga" && !isNsfwLibraryItem(item);
}

function enqueueMangaBakaLibraryItem(item, completedChapter = null) {
  if (!mangaBakaEligibleLibraryItem(item)) return;
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
  const privateSeriesIds = new Set(
    state.libraryItems
      .filter(isNsfwLibraryItem)
      .map((item) => Number(item.mangabakaId))
      .filter(Boolean)
  );
  const prunedOutbox = state.mangabakaOutbox.filter((entry) => !privateSeriesIds.has(Number(entry.series_id)));
  if (prunedOutbox.length !== state.mangabakaOutbox.length) {
    state.mangabakaOutbox = prunedOutbox;
    persistMangaBakaOutbox();
  }
  const entries = state.mangabakaOutbox
    .filter((entry) => entry.accountKey === state.mangabakaAccountKey)
    .filter((entry) => !privateSeriesIds.has(Number(entry.series_id)))
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
  const candidates = state.libraryItems
    .filter(mangaBakaEligibleLibraryItem)
    .filter((item) => !item.mangabakaId)
    .slice(0, 20);
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
  const base = baseUrlOverride ? normalizeSuwayomiBaseUrl(baseUrlOverride) : cleanBaseUrl();
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
    syncReadingStatsTracker();
    syncReadingSessionActivity();
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
  syncReadingStatsTracker();
  syncReadingSessionActivity();
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

function rememberReaderModalFocus(trigger = document.activeElement) {
  if (state.readerModalReturnFocus) return;
  // Safari pointer activation does not consistently move focus to a button,
  // so callers pass the control that initiated reader loading explicitly.
  state.readerModalReturnFocus = trigger?.isConnected && typeof trigger.focus === "function"
    ? trigger
    : document.activeElement;
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
  const focusable = [...modal.querySelectorAll("button:not([disabled]):not([hidden]), a[href], input:not([disabled]), summary, [tabindex]:not([tabindex='-1'])")]
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
  return chapters.find((chapter) => chapter.title) || chapters[0];
}

async function loadComickChapter(chapter) {
  setBusy(el.loadComickLatest, true, "Loading");
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
        state.suwayomiProgressOutbox.length ? "Queued" : "Connected",
        state.suwayomiProgressOutbox.length
          ? `${state.suwayomiProgressOutbox.length} progress update${state.suwayomiProgressOutbox.length === 1 ? "" : "s"} waiting to sync.`
          : "Connected to Suwayomi; checking reading progress next.",
        ""
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
    await syncSourceIntelligenceInventory();
    void refreshSourceIntelligence();
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
    if (state.setupReturnToBrowse && (state.pendingMangaBakaRecommendation || state.sourceMigration) && state.visibleSources.length) {
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
  if (source.isNsfw === true) return true;
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
  renderComicRecommendations(state.comicRecommendationsLoaded ? "" : "needs-library");
  updateSuwayomiSetupState();
}

async function searchSource() {
  state.searchRequestGeneration += 1;
  const requestGeneration = state.searchRequestGeneration;
  state.searchAbortController?.abort();
  state.searchAbortController = null;
  setBusy(el.searchSource, false);
  const selectedSource = el.sourceSelect.value;
  const query = el.searchQuery.value.trim();
  if (!state.connected || !state.visibleSources.length || !selectedSource) {
    renderMangaResults();
    setConnection(false, "Connect Suwayomi and load at least one source before searching.", "bad");
    openSuwayomiSetup({ recommendation: state.pendingMangaBakaRecommendation });
    showToast("Set up a Suwayomi source to continue.", "bad");
    return;
  }
  if (!query) {
    renderMangaResults();
    showToast("Enter a manga title first.", "bad");
    return;
  }
  await Promise.all([
    state.sourceProfilesPromise?.catch(() => null),
    state.sourceIntelligence ? Promise.resolve(state.sourceIntelligence) : refreshSourceIntelligence().catch(() => null),
  ]);

  const searchController = new AbortController();
  state.searchAbortController = searchController;
  const isCurrentSearch = () => (
    requestGeneration === state.searchRequestGeneration &&
    state.searchAbortController === searchController &&
    !searchController.signal.aborted
  );

  if (el.browsePrompt) el.browsePrompt.hidden = true;
  renderMangaSkeletons();
  setBusy(el.searchSource, true, "Searching");
  let hadIndexedResults = false;
  try {
    let sources =
      selectedSource === allSourcesValue
        ? state.visibleSources
        : state.visibleSources.filter((source) => String(source.id) === String(selectedSource));
    if (state.sourceMigration) {
      sources = sources.filter((source) => String(source.id) !== String(state.sourceMigration.fromManga?.sourceId));
      if (!sources.length) {
        state.mangas = [];
        renderMangaResults();
        setConnection(state.connected, "No other enabled source is available for this title.", "bad");
        return;
      }
    }
    const indexedResults = searchIndexedMangas(query, sources);
    hadIndexedResults = indexedResults.length > 0;
    if (hadIndexedResults && isCurrentSearch()) {
      state.mangas = sortMangaResults(indexedResults, query);
      renderMangaResults();
      setConnection(true, `Showing ${state.mangas.length} indexed result${state.mangas.length === 1 ? "" : "s"}. Refreshing live search...`, "good");
    }

    const results = [];
    const failures = [];
    const observations = [];
    let searched = 0;
    await mapWithConcurrency(sources, 3, async (source) => {
      const startedAt = performance.now();
      try {
        const data = await graphQL(queries.searchSource, {
          input: { source: source.id, query, page: 1, type: "SEARCH" },
        }, { timeoutMs: 12000, signal: searchController.signal });
        (data.fetchSourceManga?.mangas || []).forEach((manga) => {
          results.push({ ...manga, sourceId: manga.sourceId || source.id });
        });
        observations.push(makeSourceObservation(source, "search", "success", startedAt, sourceChoiceMediaFormat()));
      } catch (error) {
        if (!isCurrentSearch() || error?.name === "ReaderLoadCancelled") return;
        failures.push(sourceLabel(source));
        observations.push(makeSourceObservation(source, "search", "failure", startedAt, sourceChoiceMediaFormat()));
      } finally {
        searched += 1;
        if (isCurrentSearch()) {
          setConnection(true, `Searched ${searched} of ${sources.length} sources…`, "");
        }
      }
    });
    if (!isCurrentSearch()) return;
    await recordSourceObservations(observations);
    if (!isCurrentSearch()) return;
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
    if (!isCurrentSearch() || error?.name === "ReaderLoadCancelled") return;
    if (hadIndexedResults) {
      setConnection(true, `Showing indexed results. Live search failed: ${friendlySourceErrorMessage(error)}`, "good");
    } else {
      setConnection(state.connected, `Search failed: ${friendlySourceErrorMessage(error)}`, "bad");
    }
  } finally {
    if (requestGeneration === state.searchRequestGeneration && state.searchAbortController === searchController) {
      state.searchAbortController = null;
      setBusy(el.searchSource, false);
    }
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
  const desiredFormat = sourceChoiceMediaFormat();
  return results.sort((a, b) => {
    const aTitle = normalizeTitle(a.title);
    const bTitle = normalizeTitle(b.title);
    const aExact = aTitle === normalizedQuery ? 0 : 1;
    const bExact = bTitle === normalizedQuery ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    if (desiredFormat) {
      const aFormat = resultSourceMediaFormat(a) === desiredFormat ? 0 : 1;
      const bFormat = resultSourceMediaFormat(b) === desiredFormat ? 0 : 1;
      if (aFormat !== bFormat) return aFormat - bFormat;
    }
    const aIntelligence = sourceIntelligenceFor(a.sourceId, desiredFormat);
    const bIntelligence = sourceIntelligenceFor(b.sourceId, desiredFormat);
    const aSuitability = Number(aIntelligence?.suitability);
    const bSuitability = Number(bIntelligence?.suitability);
    if (Number.isFinite(aSuitability) || Number.isFinite(bSuitability)) {
      const suitabilityDifference = (Number.isFinite(bSuitability) ? bSuitability : -1) - (Number.isFinite(aSuitability) ? aSuitability : -1);
      if (suitabilityDifference) return suitabilityDifference;
      const qualityDifference = Number(bIntelligence?.quality ?? -1) - Number(aIntelligence?.quality ?? -1);
      if (qualityDifference) return qualityDifference;
      const reliabilityDifference = Number(bIntelligence?.reliability ?? -1) - Number(aIntelligence?.reliability ?? -1);
      if (reliabilityDifference) return reliabilityDifference;
    }
    return sourceReliabilityScore(b.sourceId) - sourceReliabilityScore(a.sourceId)
      || sourceRank(a.sourceId) - sourceRank(b.sourceId)
      || aTitle.localeCompare(bTitle);
  });
}

function sourceChoiceMediaFormat() {
  if (state.sourceMigration) {
    return inferredMediaFormat(state.sourceMigration.fromLibraryItem || state.sourceMigration.fromManga);
  }
  if (state.pendingMangaBakaRecommendation?.recommendationSource === "comic") return "comic";
  if (state.pendingMangaBakaRecommendation) return state.pendingMangaBakaRecommendation.mediaFormat || "manga";
  return "";
}

function sourceIntelligenceFor(sourceId, mediaFormat = "") {
  const scores = Array.isArray(state.sourceIntelligence?.scores) ? state.sourceIntelligence.scores : [];
  const matches = scores.filter((score) => (
    String(score.sourceId) === String(sourceId) &&
    (!mediaFormats.includes(mediaFormat) || score.mediaFormat === mediaFormat) &&
    score.installed !== false &&
    !score.obsolete &&
    !score.stale &&
    hasFiniteSourceScore(score.suitability)
  ));
  if (!matches.length) return null;
  return matches.sort((left, right) => (
    Number(right.evidenceCount ?? 0) - Number(left.evidenceCount ?? 0) ||
    Number(right.suitability) - Number(left.suitability)
  ))[0] || null;
}

function resultSourceMediaFormat(manga) {
  const source = state.sources.find((item) => String(item.id) === String(manga.sourceId));
  return automaticMediaFormat({ ...manga, sourceLabel: source ? sourceLabel(source) : "" });
}

function sourceReliabilityScore(sourceId) {
  const rawScore = state.sourceProfiles.get(String(sourceId))?.score;
  return hasFiniteSourceScore(rawScore) ? Number(rawScore) : 75;
}

function sourceProfileResultMeta(manga, resultIndex, fallback) {
  const profile = state.sourceProfiles.get(String(manga.sourceId));
  if (!profile?.attempts) return fallback;
  const signal = profile.confidence === "early" ? "early signal" : profile.confidence;
  if (resultIndex === 0) return `Recommended · ${profile.score}/100 · ${signal}`;
  if (profile.consecutiveFailures) return `Recent failures · ${profile.score}/100`;
  return `${profile.score}/100 reliability · ${signal}`;
}

function sourceChoiceResultMeta(manga, resultIndex, fallback) {
  const score = sourceIntelligenceFor(manga.sourceId, sourceChoiceMediaFormat());
  if (!score) return sourceProfileResultMeta(manga, resultIndex, fallback);
  const prefix = resultIndex === 0 ? "Recommended · " : "";
  const confidence = score.stale ? "version changed" : score.confidence;
  return `${prefix}${sourceScoreText(score.suitability)}/100 overall · Q ${sourceScoreText(score.quality)} · R ${sourceScoreText(score.reliability)}${confidence ? ` · ${confidence}` : ""}`;
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
    const migration = state.sourceMigration;
    const empty = document.createElement("div");
    empty.className = "app-empty-state compact-empty";
    const art = document.createElement("span");
    art.className = "empty-illustration";
    art.setAttribute("aria-hidden", "true");
    art.textContent = "⌕";
    const heading = document.createElement("strong");
    heading.textContent = migration
      ? `No alternative source match for ${migration.title}`
      : recommendation ? `No source match for ${mangaBakaTitle(recommendation)}` : "No matching manga";
    const copy = document.createElement("span");
    copy.textContent = migration
      ? "Try a shorter title or enable another Suwayomi source, then search again."
      : recommendation
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

  state.mangas.forEach((manga, resultIndex) => {
    const card = document.createElement("article");
    card.className = "manga-card browse-card";
    const source = state.sources.find((item) => String(item.id) === String(manga.sourceId));
    const sourceText = source ? sourceLabel(source) : manga.sourceId;
    const exactRecommendationMatch = Boolean(mangaBakaMatchForManga(manga));
    const button = createCoverButton(manga, {
      title: manga.title,
      eyebrow: sourceText || "Source",
      meta: state.sourceMigration
        ? sourceChoiceResultMeta(manga, resultIndex, "Use this source")
        : state.pendingMangaBakaRecommendation
          ? sourceChoiceResultMeta(manga, resultIndex, exactRecommendationMatch ? "Exact title match" : "Alternative source result")
          : sourceProfileResultMeta(manga, resultIndex, "View chapters"),
    });
    button.addEventListener("click", async (event) => {
      const recommendation = state.pendingMangaBakaRecommendation;
      const mangabaka = mangaBakaMatchForManga(manga);
      const accountScopedMangaBaka = mangabaka && mangabaka.recommendationSource !== "comic" && state.mangabakaConnected && state.mangabakaAccountKey
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
      const existingLibraryItem = currentMangaLibraryItem();
      const migrationItem = state.sourceMigration?.fromLibraryItem;
      if (state.sourceMigration) {
        state.currentManga = taggedMediaItem({
          ...state.currentManga,
          mangabakaId: migrationItem?.mangabakaId,
          mangabakaTitle: migrationItem?.mangabakaTitle,
          mangabakaMatchSource: migrationItem?.mangabakaMatchSource,
          mangabakaAccountKey: migrationItem?.mangabakaAccountKey,
        }, inferredMediaFormat(migrationItem || state.sourceMigration.fromManga), migrationItem?.mediaFormatSource || "automatic");
      } else {
        const recommendationFormat = recommendation?.recommendationSource === "comic"
          ? "comic"
          : mediaFormats.includes(recommendation?.mediaFormat) ? recommendation.mediaFormat : "";
        state.currentManga = taggedMediaItem(
          { ...state.currentManga, ...existingLibraryItem },
          existingLibraryItem?.mediaFormat || recommendationFormat || automaticMediaFormat(state.currentManga),
          existingLibraryItem?.mediaFormatSource || (existingLibraryItem?.mediaFormat ? "" : recommendationFormat ? "recommendation" : "automatic")
        );
      }
      if (recommendation) {
        state.pendingMangaBakaRecommendation = null;
        updateRecommendationContext();
      }
      state.mangaDetailOrigin = "browse";
      showMangaDetail(manga, sourceText, { origin: "browse", returnFocusTarget: event.currentTarget });
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
  const returnFocusTarget = options.returnFocusTarget;
  if (returnFocusTarget?.isConnected && typeof returnFocusTarget.focus === "function") {
    state.mangaDetailReturnFocus = returnFocusTarget;
  }
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

function ensureSourceQualityButton() {
  if (!el.detailCompareSource && el.detailChangeSource?.parentElement) {
    const button = document.createElement("button");
    button.id = "detail-compare-source";
    button.type = "button";
    button.textContent = "Check source quality";
    el.detailChangeSource.parentElement.insertBefore(button, el.detailChangeSource);
    el.detailCompareSource = button;
  }
}

function updateMangaDetailActions() {
  const item = currentMangaLibraryItem();
  const migrationTarget = Boolean(
    state.sourceMigration &&
    state.currentManga &&
    String(state.currentManga.sourceId) !== String(state.sourceMigration.fromManga?.sourceId)
  );
  if (el.detailPrimary) {
    el.detailPrimary.textContent = migrationTarget
      ? "Switch source to read"
      : item?.chapterId ? `Continue ${item.chapterTitle || "reading"}` : "Start reading";
    el.detailPrimary.disabled = migrationTarget;
  }
  if (el.detailLibrary) {
    el.detailLibrary.textContent = migrationTarget ? "Switch to this source" : item ? "In library" : "Add to library";
    el.detailLibrary.disabled = migrationTarget ? false : Boolean(item);
  }
  if (el.detailChangeSource) {
    el.detailChangeSource.hidden = !item || migrationTarget;
    el.detailChangeSource.disabled = !state.currentManga?.sourceId;
  }
  if (el.detailCompareSource) {
    el.detailCompareSource.hidden = !item || migrationTarget;
    el.detailCompareSource.disabled = !navigator.onLine || !state.currentManga?.sourceId;
  }
  if (el.detailLibraryStatus) {
    el.detailLibraryStatus.value = item ? normalizedLibraryStatus(item) : "";
    el.detailLibraryStatus.disabled = !item || migrationTarget;
    el.detailLibraryStatus.title = item ? "Move this title to another library group" : "Add this title to the library first";
  }
}

async function startOrContinueCurrentManga(returnFocusTarget = null) {
  const item = currentMangaLibraryItem();
  if (item?.chapterId) {
    await selectLibraryManga(item, true, returnFocusTarget);
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
  state.panelMode = inferredMediaFormat(state.currentManga);
  state.panelModeUserOverride = false;
  updatePanelModeControls();
  setReadingDirection(state.panelMode === "comic" ? "ltr" : "rtl");
  el.chapterId.value = chapter.id;
  el.chapterTitle.textContent = chapter.name || `Chapter ${chapter.chapterNumber || chapter.sourceOrder || chapter.id}`;
  await loadChapterPages({ chapter, returnFocusTarget });
}

async function addCurrentMangaToLibrary() {
  if (!state.currentManga || currentMangaLibraryItem()) return;
  setBusy(el.detailLibrary, true, "Adding");
  try {
    await ensureCurrentMangaInSuwayomiLibrary();
    const mediaFormat = inferredMediaFormat(state.currentManga);
    const addedItem = normalizeLibraryItem({
      mangaId: Number(state.currentManga.id),
      mangaTitle: state.currentManga.title,
      sourceId: state.currentManga.sourceId,
      sourceLabel: state.currentManga.sourceLabel,
      thumbnailUrl: state.currentManga.thumbnailUrl,
      mediaFormat,
      mediaFormatSource: state.currentManga.mediaFormatSource || "automatic",
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
    });
    state.libraryItems = [addedItem, ...state.libraryItems];
    saveLibraryItems();
    renderLibrary();
    updateMangaDetailActions();
    const added = state.libraryItems.find((item) => libraryItemKey(item) === libraryItemKey(state.currentManga));
    void enqueuePlanToReadServerBuffer(added);
    showToast("Added to Plan to read.", "good");
  } catch (error) {
    showToast(`Could not add this title: ${friendlySourceErrorMessage(error)}`, "bad");
  } finally {
    setBusy(el.detailLibrary, false);
    updateMangaDetailActions();
  }
}

function migrationChapterNumber(chapter) {
  const rawNumber = chapter?.chapterNumber;
  const direct = rawNumber === null || rawNumber === "" ? Number.NaN : Number(rawNumber);
  if (Number.isFinite(direct)) return direct;
  const nameMatch = String(chapter?.name || chapter?.chapterTitle || "").match(/(?:chapter|ch\.?)[^0-9]*([0-9]+(?:\.[0-9]+)?)/i);
  return nameMatch ? Number(nameMatch[1]) : Number.NaN;
}

function sourceMigrationContext() {
  const fromManga = state.currentManga;
  if (!fromManga?.id || !fromManga?.sourceId) {
    showToast("This title is not linked to a Suwayomi source yet.", "bad");
    return null;
  }
  const chapterId = Number(el.chapterId?.value || state.activeChapter?.chapterId);
  const attemptedChapter = state.chapters.find((chapter) => Number(chapter.id) === chapterId)
    || (Number(state.activeChapter?.chapterId) === chapterId ? state.activeChapter?.chapter : null);
  const libraryItem = currentMangaLibraryItem();
  const sameSavedChapter = Number(libraryItem?.chapterId) === chapterId;
  const pageIndex = sameSavedChapter
    ? Number(libraryItem?.pageIndex) || 0
    : Number(state.activeChapter?.chapterId) === chapterId ? currentSuwayomiPageIndex() : 0;
  const fromLibraryItem = normalizeLibraryItem({
    ...libraryItem,
    mangaId: Number(fromManga.id),
    mangaTitle: fromManga.title,
    sourceId: fromManga.sourceId,
    sourceLabel: fromManga.sourceLabel,
    thumbnailUrl: fromManga.thumbnailUrl || libraryItem?.thumbnailUrl,
    mediaFormat: fromManga.mediaFormat || libraryItem?.mediaFormat || inferredMediaFormat(fromManga),
    mediaFormatSource: fromManga.mediaFormatSource || libraryItem?.mediaFormatSource || "automatic",
    mangabakaId: fromManga.mangabakaId || libraryItem?.mangabakaId,
    mangabakaTitle: fromManga.mangabakaTitle || libraryItem?.mangabakaTitle,
    mangabakaMatchSource: fromManga.mangabakaMatchSource || libraryItem?.mangabakaMatchSource,
    mangabakaAccountKey: fromManga.mangabakaAccountKey || libraryItem?.mangabakaAccountKey,
    chapterId: Number.isInteger(chapterId) && chapterId > 0 ? chapterId : libraryItem?.chapterId,
    chapterTitle: attemptedChapter?.name || libraryItem?.chapterTitle,
    pageIndex,
    panelIndex: 0,
    serverUrl: currentDeviceServerUrl(),
    suwayomiLibrary: true,
    updatedAt: libraryItem?.updatedAt || new Date().toISOString(),
  });
  return {
    title: fromManga.title || fromLibraryItem.mangaTitle,
    fromManga: { ...fromManga },
    fromLibraryItem,
    chapterNumber: migrationChapterNumber(attemptedChapter),
    chapterTitle: attemptedChapter?.name || fromLibraryItem.chapterTitle,
    pageIndex,
  };
}

function beginSourceMigration() {
  const migration = sourceMigrationContext();
  if (!migration) return;
  state.pendingMangaBakaRecommendation = null;
  state.sourceMigration = migration;
  hideReaderError({ restoreFocus: false });
  closeMangaDetail({ history: false });
  setActiveView("browse");
  updateRecommendationContext();
  if (!state.connected || !state.visibleSources.length) {
    state.setupReturnToBrowse = true;
    openSuwayomiSetup();
    showToast("Connect Suwayomi and enable another source to continue.", "bad");
    return;
  }
  void continueSourceMigrationSearch();
}

function equivalentMigrationChapter(migration, chapters) {
  const desiredNumber = Number(migration?.chapterNumber);
  if (Number.isFinite(desiredNumber)) {
    const exact = chapters.find((chapter) => Math.abs(migrationChapterNumber(chapter) - desiredNumber) < 0.0001);
    if (exact) return exact;
  }
  const desiredTitle = normalizeTitle(migration?.chapterTitle);
  return desiredTitle ? chapters.find((chapter) => normalizeTitle(chapter.name) === desiredTitle) || null : null;
}

let sourceQualityControllerPromise = null;

function sourceQualityComparisonController() {
  if (!sourceQualityControllerPromise) {
    sourceQualityControllerPromise = import("./source-quality-comparison.js").then(({ createSourceQualityComparison }) => (
      createSourceQualityComparison({
        sourceLabel,
        friendlyError: friendlySourceErrorMessage,
        showError: showToast,
        matchChapter: equivalentMigrationChapter,
        async searchSource(source, title, signal) {
          const data = await graphQL(queries.searchSource, {
            input: { source: source.id, query: title, page: 1, type: "SEARCH" },
          }, { timeoutMs: 12000, signal });
          return data.fetchSourceManga?.mangas || [];
        },
        async fetchChapters(manga, signal) {
          const data = await graphQL(
            queries.fetchChapters,
            { input: { mangaId: Number(manga.id) } },
            { timeoutMs: 18000, signal },
          );
          return data.fetchChapters?.chapters || [];
        },
        async fetchPages(chapter, signal) {
          const payload = await fetchChapterPagePayload(Number(chapter.id), { retries: false, timeoutMs: 15000, signal });
          const paths = await resolveChapterPages(payload.fetchChapterPages, { quiet: true });
          const urls = paths.map((path) => normalizeSuwayomiPageUrl(path));
          if (!urls.length) throw new Error("This source returned no readable pages for the matching chapter.");
          return urls;
        },
        sourceEvidence(sourceId, mediaFormat) {
          const intelligence = sourceIntelligenceFor(sourceId, mediaFormat);
          return {
            reliability: Number.isFinite(Number(intelligence?.reliability))
              ? Number(intelligence.reliability)
              : sourceReliabilityScore(sourceId),
            evidenceCount: Number(intelligence?.evidenceCount)
              || Number(state.sourceProfiles.get(String(sourceId))?.attempts)
              || 0,
          };
        },
        recordObservations: recordSourceObservations,
        async migrate(candidate, comparison) {
          const oldItem = comparison.migration.fromLibraryItem || {};
          state.pendingMangaBakaRecommendation = null;
          state.sourceMigration = comparison.migration;
          state.currentManga = taggedMediaItem({
            id: candidate.manga.id,
            title: candidate.manga.title,
            sourceId: candidate.manga.sourceId || candidate.source.id,
            sourceLabel: candidate.sourceLabel,
            thumbnailUrl: candidate.manga.thumbnailUrl,
            mangabakaId: oldItem.mangabakaId,
            mangabakaTitle: oldItem.mangabakaTitle,
            mangabakaMatchSource: oldItem.mangabakaMatchSource,
            mangabakaAccountKey: oldItem.mangabakaAccountKey,
            serverUrl: currentDeviceServerUrl(),
          }, comparison.mediaFormat, oldItem.mediaFormatSource || "automatic");
          el.mangaId.value = candidate.manga.id;
          el.chapterTitle.textContent = candidate.manga.title;
          state.scanlatorFilter = "auto";
          state.chapterView = [];
          setChapterList(candidate.chapters);
          updateScanlatorOptions();
          renderChapters();
          showMangaDetail(state.currentManga, candidate.sourceLabel, { history: false });
          await migrateCurrentMangaSource();
        },
      })
    ));
  }
  return sourceQualityControllerPromise;
}

async function openSourceQualityComparison(returnFocusTarget, { force = false } = {}) {
  const migration = sourceMigrationContext();
  if (!migration) return;
  if (!navigator.onLine || !state.connected || !state.visibleSources.length) {
    showToast("Connect Suwayomi before comparing source quality.", "bad");
    return;
  }
  const referenceChapter = state.chapters.find((chapter) => Number(chapter.id) === Number(migration.fromLibraryItem?.chapterId))
    || equivalentMigrationChapter(migration, state.chapters);
  const referencePages = Math.max(1, Number(referenceChapter?.pageCount) || 1);
  const currentSource = state.sources.find((source) => String(source.id) === String(migration.fromManga.sourceId)) || {
    id: migration.fromManga.sourceId,
    displayName: migration.fromManga.sourceLabel || "Current source",
  };
  const controller = await sourceQualityComparisonController();
  await controller.open({
    key: `${currentDeviceServerUrl()}:${migration.fromManga.sourceId || ""}:${migration.fromManga.id || ""}:${migration.chapterNumber || migration.chapterTitle || ""}`,
    migration,
    mediaFormat: inferredMediaFormat(migration.fromLibraryItem || migration.fromManga),
    preferredPageRatio: clamp(Number(migration.pageIndex) / Math.max(1, referencePages - 1), 0, 1),
    referenceChapterCount: state.chapters.length,
    currentManga: { ...migration.fromManga },
    currentSource,
    currentChapters: [...state.chapters],
    sources: [...state.visibleSources],
    returnFocusTarget,
    force,
  });
}

async function migrateCurrentMangaSource() {
  const migration = state.sourceMigration;
  const target = state.currentManga;
  if (!migration || !target || String(target.sourceId) === String(migration.fromManga?.sourceId)) return;
  setBusy(el.detailLibrary, true, "Switching");
  try {
    const targetAdded = await ensureCurrentMangaInSuwayomiLibrary();
    if (!targetAdded) throw new Error("The replacement title could not be added to Suwayomi.");
    const oldItem = migration.fromLibraryItem || {};
    const chapters = state.chapterView.length ? state.chapterView : visibleChapters();
    const matchingChapter = equivalentMigrationChapter(migration, chapters);
    const targetKey = libraryItemKey(target);
    const oldKey = libraryItemKey(migration.fromManga || oldItem);
    const migratedItem = normalizeLibraryItem({
      ...oldItem,
      mangaId: Number(target.id),
      mangaTitle: target.title,
      sourceId: target.sourceId,
      sourceLabel: target.sourceLabel,
      thumbnailUrl: target.thumbnailUrl || oldItem.thumbnailUrl,
      serverUrl: currentDeviceServerUrl(),
      suwayomiLibrary: true,
      ...(matchingChapter ? {
        chapterId: Number(matchingChapter.id),
        chapterTitle: matchingChapter.name,
        pageIndex: Math.min(Number(oldItem.pageIndex) || 0, Math.max(0, Number(matchingChapter.pageCount || 1) - 1)),
        panelIndex: 0,
      } : {
        chapterId: undefined,
        chapterTitle: undefined,
        pageIndex: 0,
        panelIndex: 0,
        progressLabel: undefined,
      }),
      updatedAt: new Date().toISOString(),
    });
    const nextLibraryItems = [
      migratedItem,
      ...state.libraryItems.filter((item) => {
        const key = libraryItemKey(item);
        return key !== oldKey && key !== targetKey;
      }),
    ];
    if (state.librarySavePromise) await state.librarySavePromise;
    const migrationPayload = await postLocalJson("/api/library/migrate", {
      from: {
        sourceId: String(migration.fromManga?.sourceId ?? oldItem.sourceId ?? ""),
        mangaId: Number(migration.fromManga?.id || oldItem.mangaId),
      },
      item: migratedItem,
    });
    state.libraryItems = Array.isArray(migrationPayload.items)
      ? sanitizeLibraryServerUrls(migrationPayload.items).map(normalizeLibraryItem)
      : nextLibraryItems;
    persistLibraryItemsLocally();
    renderLibrary({ preserveInteractions: false });

    let oldSourceDetached = true;
    const oldMangaId = Number(migration.fromManga?.id || oldItem.mangaId);
    if (Number.isInteger(oldMangaId) && oldMangaId > 0 && oldMangaId !== Number(target.id)) {
      try {
        const removed = await graphQL(
          queries.updateManga,
          { input: { id: oldMangaId, patch: { inLibrary: false } } },
          { timeoutMs: 10000 }
        );
        oldSourceDetached = removed.updateManga?.manga?.inLibrary === false;
      } catch {
        oldSourceDetached = false;
      }
    }
    state.sourceMigration = null;
    updateRecommendationContext();
    updateMangaDetailActions();

    if (!matchingChapter) {
      showToast(oldSourceDetached
        ? "Source switched. Choose the closest chapter from this source."
        : "Source switched. The previous Suwayomi entry could not be detached.", oldSourceDetached ? "good" : "");
      return;
    }
    state.pendingResume = {
      chapterId: Number(matchingChapter.id),
      pageIndex: migratedItem.pageIndex,
      panelIndex: 0,
      panelMode: inferredMediaFormat(migratedItem),
      readingDirection: migratedItem.readingDirection || (inferredMediaFormat(migratedItem) === "comic" ? "ltr" : "rtl"),
    };
    state.panelMode = inferredMediaFormat(migratedItem);
    state.panelModeUserOverride = false;
    setReadingDirection(state.pendingResume.readingDirection);
    updatePanelModeControls();
    el.chapterId.value = matchingChapter.id;
    el.chapterTitle.textContent = matchingChapter.name || `Chapter ${matchingChapter.chapterNumber || matchingChapter.id}`;
    showToast(oldSourceDetached
      ? `Switched to ${target.sourceLabel || "the new source"}.`
      : `Switched to ${target.sourceLabel || "the new source"}; the previous Suwayomi entry is still attached.`, oldSourceDetached ? "good" : "");
    await loadChapterPages({ chapter: matchingChapter, returnFocusTarget: el.detailLibrary });
  } catch (error) {
    showToast(`Could not switch source: ${friendlySourceErrorMessage(error)}`, "bad");
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
    const returnFocusTarget = state.mangaDetailReturnFocus;
    state.mangaDetailReturnFocus = null;
    if (
      returnFocusTarget?.isConnected &&
      returnFocusTarget.getClientRects?.().length &&
      !returnFocusTarget.closest?.("[hidden], [inert]")
    ) {
      returnFocusTarget.focus({ preventScroll: true });
    } else if (state.mangaDetailOrigin === "library") {
      el.navLibrary?.focus({ preventScroll: true });
    } else {
      el.searchQuery?.focus({ preventScroll: true });
    }
  });
}

let toastTimer = null;
let toastHideTimer = null;

function revealToast(duration = 2600) {
  window.clearTimeout(toastTimer);
  window.clearTimeout(toastHideTimer);
  el.appToast.hidden = false;
  toastTimer = window.setTimeout(() => {
    el.appToast.classList.remove("visible");
    toastHideTimer = window.setTimeout(() => { el.appToast.hidden = true; }, 180);
  }, duration);
}

function showToast(message, tone = "") {
  if (!el.appToast || !message) return;
  el.appToast.textContent = message;
  el.appToast.className = `app-toast visible ${tone}`;
  revealToast();
}

function showAchievementToast(achievement, additionalCount = 0) {
  if (!el.appToast) return;
  const definition = achievementDefinition(achievement);
  const copy = document.createElement("span");
  copy.className = "achievement-toast-copy";
  const eyebrow = document.createElement("span");
  eyebrow.className = "achievement-toast-eyebrow";
  eyebrow.textContent = "Achievement unlocked";
  const title = document.createElement("strong");
  title.textContent = achievement?.name || achievement?.title || definition.name;
  const note = document.createElement("small");
  note.textContent = additionalCount
    ? `${definition.description} · Plus ${additionalCount} more added to your shelf`
    : definition.description;
  copy.append(eyebrow, title, note);
  el.appToast.replaceChildren(createAchievementArt(definition, true), copy);
  el.appToast.className = "app-toast achievement-toast visible good";
  revealToast(4800);
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
  try {
    const base = normalizeSuwayomiBaseUrl(state.baseUrl || defaultSuwayomiUrl);
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

  const coverUrl = content.directCover
    ? String(item.thumbnailUrl || "").trim()
    : normalizeMangaCoverUrl(item.thumbnailUrl);
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
  let localItemsChanged = false;
  try {
    localItems = JSON.parse(localStorage.getItem(libraryStoreKey) || "[]");
  } catch {
    localItems = [];
  }
  const localItemsBeforeSanitization = Array.isArray(localItems) ? JSON.stringify(localItems) : "[]";
  state.libraryItems = sanitizeLibraryServerUrls(Array.isArray(localItems) ? localItems : []).map(normalizeLibraryItem);
  localItemsChanged = JSON.stringify(state.libraryItems) !== localItemsBeforeSanitization;
  persistLibraryItemsLocally();
  renderLibrary();

  if (!navigator.onLine) return;

  try {
    const payload = await localJson("/api/library");
    const remoteItems = Array.isArray(payload.items) ? payload.items : [];
    const sanitizedRemoteItems = sanitizeLibraryServerUrls(remoteItems);
    const remoteItemsChanged = JSON.stringify(sanitizedRemoteItems) !== JSON.stringify(remoteItems);
    state.libraryItems = sanitizeLibraryServerUrls(mergeLibraryItems(sanitizedRemoteItems, state.libraryItems));
    persistLibraryItemsLocally();
    if (localItemsChanged || remoteItemsChanged || state.libraryItems.length !== remoteItems.length) {
      saveLibraryItems();
    }
    renderLibrary();
  } catch {
    // Local storage remains the fallback when the shared library endpoint is unavailable.
    renderLibrary();
  }
}

function saveLibraryItems() {
  state.libraryItems = sanitizeLibraryServerUrls(mergeLibraryItems(state.libraryItems));
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
        state.libraryItems = sanitizeLibraryServerUrls(mergeLibraryItems(state.libraryItems, payload.items));
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

function inferredMediaFormat(item) {
  if (mediaFormats.includes(item?.mediaFormat)) return item.mediaFormat;
  return detectedMediaFormatFromMetadata(item) || "manga";
}

function detectedMediaFormatFromMetadata(item) {
  if (item?.panelMode === "webtoon") return "webtoon";
  if (item?.panelMode === "comic") return "comic";
  const label = [
    item?.sourceLabel,
    item?.sourceId,
    item?.sourceName,
    item?.source?.name,
    item?.source?.displayName,
    item?.extension?.pkgName,
    item?.source?.extension?.pkgName,
    item?.realUrl,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/\bwebtoons?\b|webtoon\.com|toonily|asura\s*scans?|flame\s*comics?|comivex|mangamob|manhwa18/.test(label)) return "webtoon";
  if (/read\s*comics?\s*online|readcomiconline|xoxo\s*comics?|comic\s*extra|read\s*all\s*comics/.test(label)) return "comic";
  return "";
}

function removeMangaBakaMapping(item) {
  const cleaned = { ...item };
  delete cleaned.mangabakaId;
  delete cleaned.mangabakaTitle;
  delete cleaned.mangabakaMatchSource;
  delete cleaned.mangabakaAccountKey;
  return cleaned;
}

function taggedMediaItem(item, mediaFormat, mediaFormatSource = item?.mediaFormatSource) {
  const tagged = {
    ...item,
    mediaFormat,
    panelMode: mediaFormat,
    readingDirection: mediaFormat === "comic" ? "ltr" : "rtl",
  };
  if (mediaFormatSource) tagged.mediaFormatSource = mediaFormatSource;
  return mediaFormat === "manga" ? tagged : removeMangaBakaMapping(tagged);
}

function removeMangaBakaOutboxEntry(seriesId) {
  if (!Number(seriesId)) return;
  const remaining = state.mangabakaOutbox.filter((entry) => Number(entry.series_id) !== Number(seriesId));
  if (remaining.length === state.mangabakaOutbox.length) return;
  state.mangabakaOutbox = remaining;
  persistMangaBakaOutbox();
}

function persistCurrentMangaMediaFormat(mediaFormat, mediaFormatSource = "automatic") {
  if (!state.currentManga || !mediaFormats.includes(mediaFormat)) return;
  const key = libraryItemKey(state.currentManga);
  const previousCurrent = state.currentManga;
  state.currentManga = taggedMediaItem(previousCurrent, mediaFormat, mediaFormatSource);
  let libraryChanged = false;
  state.libraryItems = state.libraryItems.map((existing) => {
    if (libraryItemKey(existing) !== key) return existing;
    const updated = taggedMediaItem(existing, mediaFormat, mediaFormatSource);
    libraryChanged = JSON.stringify(updated) !== JSON.stringify(existing);
    return libraryChanged ? { ...updated, updatedAt: new Date().toISOString() } : existing;
  });
  if (mediaFormat !== "manga") {
    removeMangaBakaOutboxEntry(previousCurrent.mangabakaId);
  }
  if (libraryChanged) saveLibraryItems();
}

function normalizeLibraryItem(item) {
  if (!item) return item;
  const alreadyTagged = mediaFormats.includes(item.mediaFormat);
  const mediaFormat = inferredMediaFormat(item);
  const tagged = { ...item, mediaFormat };
  const mediaFormatSource = item.mediaFormatSource || (alreadyTagged ? "" : "automatic");
  if (mediaFormatSource) tagged.mediaFormatSource = mediaFormatSource;
  if (mediaFormat !== "manga") removeMangaBakaOutboxEntry(item.mangabakaId);
  const normalized = mediaFormat === "manga" ? tagged : removeMangaBakaMapping(tagged);
  normalized.libraryStatus = normalizedLibraryStatus(normalized);
  return normalized;
}

function automaticMediaFormat(item) {
  return detectedMediaFormatFromMetadata(item) || "manga";
}

function formatCanBeAutomaticallyRefined(item) {
  return !mediaFormats.includes(item?.mediaFormat) || item?.mediaFormatSource === "automatic";
}

function detectedMediaFormatForPage(item, image, sourceLabelText = "") {
  return detectedMediaFormatFromMetadata(item) || detectPanelModeFromImage(image, sourceLabelText);
}

function setLibraryFilter(filter) {
  if (!libraryFilterValues.includes(filter)) return;
  state.libraryFilter = filter;
  saveSettings();
  renderLibrary();
}

function setLibraryFormatFilter(filter) {
  if (!libraryFormatFilterValues.includes(filter)) return;
  state.libraryFormatFilter = filter;
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
  badge.textContent = `Server ${readiness.panelReady}/${readiness.total}`;
  const title = item.mangaTitle || "This title";
  badge.setAttribute("aria-label", complete
    ? `${title}: ${readiness.total} of ${readiness.total} buffered chapters are downloaded to the server and panel-ready.`
    : `${title}: ${readiness.downloaded} of ${readiness.total} buffered chapters downloaded to the server; ${readiness.panelReady} panel-ready.`);
  badge.title = badge.getAttribute("aria-label");
  return badge;
}

function refreshLibraryOfflineBadges() {
  if (!el.libraryList) return;
  el.libraryList.querySelectorAll(".library-card[data-library-key]").forEach((card) => {
    const item = state.libraryItems.find((candidate) => libraryItemKey(candidate) === card.dataset.libraryKey);
    const badges = card.querySelector("[data-library-badges]");
    if (!item || !badges) return;
    const existingBadge = badges.querySelector(".offline-readiness-badge");
    const offlineBadge = createLibraryOfflineBadge(item);
    if (!offlineBadge) {
      existingBadge?.remove();
    } else if (!existingBadge) {
      badges.prepend(offlineBadge);
    } else if (existingBadge.outerHTML !== offlineBadge.outerHTML) {
      existingBadge.replaceWith(offlineBadge);
    }
  });
}

function normalizedBookLibraryStatus(book) {
  return state.booksIntegration?.libraryStatus(book) || (book?.progress?.locator ? "reading" : "plan_to_read");
}

function bookProgressLabel(book) {
  return state.booksIntegration?.progressLabel(book) || "Ready to read";
}

function visibleBookLibraryItems() {
  if (!state.booksEnabled || !["all", "book"].includes(state.libraryFormatFilter)) return [];
  return state.bookLibraryItems
    .filter((book) => {
      const status = normalizedBookLibraryStatus(book);
      if (state.libraryFilter === "all") return true;
      if (state.libraryFilter === "reading") return status === "reading";
      if (state.libraryFilter === "other") return ["dropped", "considering"].includes(status);
      return status === state.libraryFilter;
    })
    .slice()
    .sort((left, right) => {
      const activity = Date.parse(right.progress?.updatedAt || right.dateAdded || 0) - Date.parse(left.progress?.updatedAt || left.dateAdded || 0);
      return activity || String(left.title || "").localeCompare(String(right.title || ""));
    });
}

function bookLibraryCardSignature(book) {
  return state.booksIntegration?.cardSignature(book) || `book:${book.id}`;
}

function createBookLibraryCard(book) {
  return state.booksIntegration.createLibraryCard(book, {
    createCoverButton,
    navigate: navigateBookRoute,
    statusLabels: libraryStatusLabels,
    onUpdate: async () => refreshIntegratedBookLibrary({ render: true }),
  });
}

function renderLibrary({ preserveInteractions = true } = {}) {
  if (!el.libraryList || !el.libraryCount) return;
  const renderSignature = libraryRenderSignature();
  if (el.libraryList.dataset.renderSignature === renderSignature) {
    refreshLibraryOfflineBadges();
    updateReaderNav();
    return;
  }
  const existingCards = new Map(
    [...el.libraryList.querySelectorAll(":scope > .library-card[data-library-key]")]
      .map((card) => [card.dataset.libraryKey, card])
  );
  const allowedItems = libraryItemsAllowedByNsfw();
  const visibleItems = visibleLibraryItems();
  const visibleBooks = visibleBookLibraryItems();
  const hiddenCount = allowedItems.filter((item) => item.hidden).length;
  const statusCounts = Object.fromEntries(libraryStatuses.map((status) => [status, 0]));
  const unhiddenItems = allowedItems.filter((item) => !item.hidden);
  unhiddenItems
    .filter((item) => state.libraryFormatFilter === "all" || inferredMediaFormat(item) === state.libraryFormatFilter)
    .forEach((item) => {
    const status = normalizedLibraryStatus(item);
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  });
  if (["all", "book"].includes(state.libraryFormatFilter)) {
    state.bookLibraryItems.forEach((book) => {
      const status = normalizedBookLibraryStatus(book);
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });
  }
  el.libraryFormatFilters.forEach((button) => {
    const active = button.dataset.libraryFormatFilter === state.libraryFormatFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  el.libraryFilters.forEach((button) => {
    const active = button.dataset.libraryFilter === state.libraryFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  el.libraryFilterCounts.forEach((count) => {
    const filter = count.dataset.libraryCount;
    const value = filter === "all"
      ? unhiddenItems.filter((item) => state.libraryFormatFilter === "all" || inferredMediaFormat(item) === state.libraryFormatFilter).length
        + (["all", "book"].includes(state.libraryFormatFilter) ? state.bookLibraryItems.length : 0)
      : filter === "reading"
        ? (statusCounts.reading || 0) + (statusCounts.rereading || 0)
        : filter === "other"
          ? (statusCounts.dropped || 0) + (statusCounts.considering || 0)
          : (statusCounts[filter] || 0);
    count.textContent = String(value);
  });
  if (el.toggleHiddenLibrary) el.toggleHiddenLibrary.hidden = hiddenCount === 0 && !state.showHiddenLibrary;
  const visibleCount = visibleItems.length + visibleBooks.length;
  el.libraryCount.textContent = `${visibleCount} title${visibleCount === 1 ? "" : "s"}${hiddenCount ? ` · ${hiddenCount} hidden` : ""}`;
  updateReaderNav();
  if (!visibleCount) {
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
    action.textContent = showHiddenAction ? "Show hidden titles" : state.libraryFormatFilter === "book" ? "Find books" : "Browse titles";
    action.addEventListener("click", () => {
      if (showHiddenAction) setShowHiddenLibrary(true);
      else if (state.libraryFormatFilter === "book") navigateBookRoute("books-search");
      else setActiveView("browse");
    });
    empty.append(art, heading, copy, action);
    el.libraryList.replaceChildren(empty);
    el.libraryList.dataset.renderSignature = renderSignature;
    return;
  }

  const renderedCards = [];
  let deferredCardUpdate = false;
  visibleItems.forEach((item) => {
    const itemSignature = libraryCardSignature(item);
    const existingCard = existingCards.get(libraryItemKey(item));
    const cardIsInUse = Boolean(preserveInteractions && existingCard && (
      existingCard.contains(document.activeElement) ||
      existingCard.querySelector("details[open]")
    ));
    if (existingCard && (existingCard.dataset.libraryCardSignature === itemSignature || cardIsInUse)) {
      if (cardIsInUse && existingCard.dataset.libraryCardSignature !== itemSignature) deferredCardUpdate = true;
      renderedCards.push(existingCard);
      return;
    }
    const card = document.createElement("article");
    card.className = `manga-card library-card${item.pinned ? " pinned-item" : ""}${item.hidden ? " hidden-item" : ""}`;
    card.dataset.libraryKey = libraryItemKey(item);
    card.dataset.libraryCardSignature = itemSignature;
    const resumable = Number.isInteger(Number(item.chapterId)) && Number(item.chapterId) > 0;
    const cover = createCoverButton(item, {
      title: item.mangaTitle || "Untitled",
      eyebrow: item.chapterTitle || item.sourceLabel || "Suwayomi library",
      meta: resumable ? (item.progressLabel || "Resume reading") : "View chapters",
    });
    cover.addEventListener("click", (event) => void selectLibraryManga(item, resumable, event.currentTarget).catch((error) => {
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
    badges.dataset.libraryBadges = "";
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
    const formatBadge = document.createElement("span");
    formatBadge.className = "manga-card-badge format-badge";
    formatBadge.textContent = mediaFormatLabels[inferredMediaFormat(item)];
    badges.append(formatBadge, statusBadge);

    const actions = document.createElement("div");
    actions.className = "manga-card-actions";
    const chapters = document.createElement("button");
    chapters.type = "button";
    chapters.textContent = "Chapters";
    chapters.dataset.libraryAction = "chapters";
    chapters.addEventListener("click", (event) => void selectLibraryManga(item, false, event.currentTarget).catch((error) => {
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
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove from library";
    remove.className = "quiet-card-action danger-button";
    remove.addEventListener("click", async () => {
      const { removeLibraryEntry } = await import("./library-removal.js");
      const result = removeLibraryEntry(state.libraryItems, item, libraryItemKey);
      if (!result) return;
      state.libraryItems = result.items;
      if (result.removed?.mangabakaId) removeMangaBakaOutboxEntry(Number(result.removed.mangabakaId));
      saveLibraryItems();
      renderLibrary({ preserveInteractions: false });
      showToast("Removed from your Panel Pilot library.", "good");
    });
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
    const formatSelect = document.createElement("select");
    formatSelect.className = "library-format-select";
    formatSelect.setAttribute("aria-label", `Format for ${item.mangaTitle || "title"}`);
    mediaFormats.forEach((format) => {
      const option = document.createElement("option");
      option.value = format;
      option.textContent = mediaFormatLabels[format];
      formatSelect.append(option);
    });
    formatSelect.value = inferredMediaFormat(item);
    formatSelect.addEventListener("change", () => setLibraryItemFormat(item, formatSelect.value));
    menu.append(formatSelect, statusSelect, pin, hide, remove);
    more.append(moreLabel, menu);
    actions.append(chapters, more);

    card.append(cover, badges, actions);
    renderedCards.push(card);
  });
  visibleBooks.forEach((book) => {
    const key = `book:${book.id}`;
    const signature = bookLibraryCardSignature(book);
    const existingCard = existingCards.get(key);
    if (existingCard && existingCard.dataset.libraryCardSignature === signature) {
      renderedCards.push(existingCard);
    } else {
      renderedCards.push(createBookLibraryCard(book));
    }
  });
  renderedCards.forEach((card, index) => {
    const current = el.libraryList.children[index];
    if (current !== card) el.libraryList.insertBefore(card, current || null);
  });
  const renderedSet = new Set(renderedCards);
  [...el.libraryList.children].forEach((child) => {
    if (!renderedSet.has(child)) child.remove();
  });
  state.libraryDeferredRenderPending = deferredCardUpdate;
  if (!deferredCardUpdate) el.libraryList.dataset.renderSignature = renderSignature;
  refreshLibraryOfflineBadges();
}

function flushDeferredLibraryRender() {
  if (!state.libraryDeferredRenderPending || !el.libraryList) return;
  window.setTimeout(() => {
    if (!state.libraryDeferredRenderPending) return;
    const activeCard = document.activeElement?.closest?.(".library-card");
    if (activeCard || el.libraryList.querySelector("details[open]")) return;
    state.libraryDeferredRenderPending = false;
    renderLibrary({ preserveInteractions: false });
  }, 0);
}

function libraryCardSignature(item) {
  return JSON.stringify({
    key: libraryItemKey(item),
    mangaTitle: item.mangaTitle || "",
    sourceLabel: item.sourceLabel || "",
    thumbnailUrl: item.thumbnailUrl || "",
    chapterId: Number(item.chapterId) || 0,
    chapterTitle: item.chapterTitle || "",
    progressLabel: item.progressLabel || "",
    pinned: Boolean(item.pinned),
    hidden: Boolean(item.hidden),
    status: normalizedLibraryStatus(item),
    mediaFormat: inferredMediaFormat(item),
  });
}

function readerResumeItem() {
  const availableManga = libraryItemsAllowedByNsfw()
    .filter((item) => !item.hidden)
    .filter((item) => ["reading", "rereading"].includes(normalizedLibraryStatus(item)))
    .filter((item) => Number.isInteger(Number(item.chapterId)) && Number(item.chapterId) > 0)
    .map((item) => ({ ...item, resumeKind: "manga" }));
  if (state.activeChapter?.type === "suwayomi" && state.currentManga?.id) {
    const currentKey = libraryItemKey({ mangaId: state.currentManga.id, sourceId: state.currentManga.sourceId });
    const active = availableManga.find((item) => libraryItemKey(item) === currentKey);
    if (active) return active;
  }
  const availableBooks = state.booksEnabled
    ? state.bookLibraryItems
      .filter((book) => book.progress?.locator && normalizedBookLibraryStatus(book) === "reading")
      .map((book) => ({
        resumeKind: "book",
        bookId: Number(book.id),
        mangaTitle: book.title || "Untitled book",
        chapterTitle: Array.isArray(book.authors) && book.authors.length ? book.authors.join(", ") : "EPUB",
        progressLabel: bookProgressLabel(book),
        thumbnailUrl: book.coverUrl || "",
        updatedAt: book.progress?.updatedAt || book.dateAdded || "",
      }))
    : [];
  return [...availableManga, ...availableBooks]
    .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))[0] || null;
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

  const coverUrl = item.resumeKind === "book"
    ? String(item.thumbnailUrl || "").trim()
    : normalizeMangaCoverUrl(item?.thumbnailUrl);
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

async function openReaderFromNav(returnFocusTarget = null) {
  const focusTarget = returnFocusTarget?.currentTarget || returnFocusTarget;
  const item = readerResumeItem();
  if (!item) {
    if (state.activeChapter && state.pages.length) setActiveView("reader");
    return;
  }
  if (item.resumeKind === "book") {
    navigateBookRoute("book-read", { id: item.bookId });
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
    await selectLibraryManga(item, true, focusTarget);
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
      .filter((item) => state.libraryFormatFilter === "all" || inferredMediaFormat(item) === state.libraryFormatFilter)
      .filter((item) => {
        const status = normalizedLibraryStatus(item);
        if (state.libraryFilter === "all") return true;
        if (state.libraryFilter === "reading") return status === "reading" || status === "rereading";
        if (state.libraryFilter === "other") return status === "dropped" || status === "considering";
        return status === state.libraryFilter;
      })
  );
}

function libraryRenderSignature(items = state.libraryItems) {
  return JSON.stringify({
    filter: state.libraryFilter,
    formatFilter: state.libraryFormatFilter,
    showHidden: state.showHiddenLibrary,
    showPrivate: state.showNsfwSources,
    items: sortLibraryItems(items).map((item) => ({
      key: libraryItemKey(item),
      mangaTitle: item.mangaTitle || "",
      sourceLabel: item.sourceLabel || "",
      thumbnailUrl: item.thumbnailUrl || "",
      chapterId: Number(item.chapterId) || 0,
      chapterTitle: item.chapterTitle || "",
      progressLabel: item.progressLabel || "",
      pinned: Boolean(item.pinned),
      hidden: Boolean(item.hidden),
      status: normalizedLibraryStatus(item),
      mediaFormat: inferredMediaFormat(item),
    })),
    books: state.booksEnabled ? state.bookLibraryItems.map((book) => ({
      id: Number(book.id),
      title: book.title || "",
      authors: Array.isArray(book.authors) ? book.authors : [],
      coverUrl: book.coverUrl || "",
      dateAdded: book.dateAdded || "",
      progress: book.progress || null,
    })) : [],
  });
}

function libraryItemsAllowedByNsfw() {
  return state.showNsfwSources
    ? state.libraryItems
    : state.libraryItems.filter((item) => !isNsfwLibraryItem(item));
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
  renderLibrary({ preserveInteractions: false });
  showToast(field === "pinned" ? (value ? "Pinned to the top." : "Unpinned.") : (value ? "Hidden from Library." : "Restored to Library."));
}

function setLibraryItemFormat(item, mediaFormat) {
  if (!mediaFormats.includes(mediaFormat)) return;
  const key = libraryItemKey(item);
  const previous = state.libraryItems.find((entry) => libraryItemKey(entry) === key);
  const previousMangaBakaId = Number(previous?.mangabakaId);
  state.libraryItems = state.libraryItems.map((existing) => {
    if (libraryItemKey(existing) !== key) return existing;
    return {
      ...taggedMediaItem(existing, mediaFormat, "manual"),
      updatedAt: new Date().toISOString(),
    };
  });
  if (mediaFormat !== "manga") removeMangaBakaOutboxEntry(previousMangaBakaId);
  saveLibraryItems();
  renderLibrary({ preserveInteractions: false });
  showToast(`Marked as ${mediaFormatLabels[mediaFormat].toLowerCase()}.`, "good");
}

function setLibraryItemStatus(item, status, { sync = true } = {}) {
  if (!libraryStatuses.includes(status)) return;
  const key = libraryItemKey(item);
  const previousStatus = normalizedLibraryStatus(state.libraryItems.find((entry) => libraryItemKey(entry) === key));
  state.libraryItems = state.libraryItems.map((existing) =>
    libraryItemKey(existing) === key
      ? { ...existing, libraryStatus: status, statusExplicit: true, updatedAt: new Date().toISOString() }
      : existing
  );
  const updated = state.libraryItems.find((entry) => libraryItemKey(entry) === key);
  saveLibraryItems();
  renderLibrary({ preserveInteractions: false });
  if (sync) enqueueMangaBakaLibraryItem(updated);
  if (status === "completed" && updated && state.readingStatsSettings?.enabled && !isNsfwLibraryItem(updated)) {
    void readingStatsClient.recordTitleComplete({
      serverUrl: updated.serverUrl || currentDeviceServerUrl(),
      mangaId: updated.mangaId,
      offline: !navigator.onLine,
    }).then(() => flushReadingStats());
  }
  if (status === "plan_to_read" && previousStatus !== "plan_to_read") {
    void enqueuePlanToReadServerBuffer(updated);
  } else if (status !== "plan_to_read") {
    const bufferKey = planToReadBufferKey(updated);
    clearPlanToReadBufferRetry(bufferKey);
    state.planBufferSignatures.delete(bufferKey);
  }
  showToast(`Moved to ${libraryStatusLabels[status]}.`, "good");
}

function isNsfwLibraryItem(item) {
  if (item?.isNsfw === true || item?.privateSource === true || item?.source?.isNsfw === true) return true;
  const source = state.sources.find((entry) => String(entry.id) === String(item?.sourceId));
  if (source && isNsfwSource(source)) return true;
  const label = `${item?.sourceLabel || ""} ${item?.mangaTitle || item?.title || ""}`.toLowerCase();
  return label.includes("manhwa18") || label.includes("manhwa18.cc");
}

async function selectLibraryManga(item, resume, returnFocusTarget = null) {
  const serverUrl = String(item.serverUrl || currentDeviceServerUrl()).trim().replace(/\/+$/, "");
  state.currentManga = {
    id: item.mangaId,
    title: item.mangaTitle,
    sourceId: item.sourceId,
    sourceLabel: item.sourceLabel,
    isNsfw: Boolean(item.isNsfw),
    thumbnailUrl: item.thumbnailUrl,
    mediaFormat: item.mediaFormat,
    mediaFormatSource: item.mediaFormatSource,
    mangabakaId: item.mangabakaId,
    mangabakaTitle: item.mangabakaTitle,
    mangabakaMatchSource: item.mangabakaMatchSource,
    mangabakaAccountKey: item.mangabakaAccountKey,
    serverUrl,
  };
  const titleFormat = inferredMediaFormat(item);
  const resumeMode = normalizedResumePanelMode(item);
  state.panelMode = resume && isPanelMode(resumeMode) ? resumeMode : titleFormat;
  state.panelModeUserOverride = Boolean(resume && isPanelMode(resumeMode) && resumeMode !== titleFormat);
  updatePanelModeControls();
  setReadingDirection(item.readingDirection || (titleFormat === "comic" ? "ltr" : "rtl"));
  if (!resume) {
    state.mangaDetailOrigin = "library";
    setActiveView("browse", { history: false });
    showMangaDetail(state.currentManga, item.sourceLabel, {
      origin: "library",
      returnFocusTarget,
    });
  }
  updateReaderNav();
  el.mangaId.value = item.mangaId;
  el.chapterId.value = item.chapterId || "";
  el.chapterTitle.textContent = item.chapterTitle || item.mangaTitle || "Selected manga";
  state.pendingResume = resume ? item : null;
  if (resume) {
    rememberReaderModalFocus(returnFocusTarget || document.activeElement);
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

async function syncSuwayomiLibrary({ announce = false, progressMangaIds = null } = {}) {
  const previousRenderSignature = libraryRenderSignature();
  const data = await graphQL(queries.libraryMangas, {}, { timeoutMs: 15000 });
  const mangas = data.mangas?.nodes || [];
  const existingByKey = new Map(state.libraryItems.map((item) => [libraryItemKey(item), item]));
  const serverItems = mangas.map((manga) => {
    const key = libraryItemKey({ id: manga.id, sourceId: manga.sourceId });
    const existing = existingByKey.get(key) || {};
    const source = manga.source || state.sources.find((item) => String(item.id) === String(manga.sourceId));
    const merged = {
      ...existing,
      mangaId: Number(manga.id),
      mangaTitle: manga.title,
      sourceId: manga.sourceId,
      sourceLabel: source ? sourceLabel(source) : (existing.sourceLabel || "Suwayomi"),
      isNsfw: isNsfwSource(source) || isNsfwLibraryItem(existing),
      thumbnailUrl: manga.thumbnailUrl || existing.thumbnailUrl,
      suwayomiLibrary: true,
      updatedAt: existing.updatedAt || "1970-01-01T00:00:00.000Z",
    };
    return normalizeLibraryItem(merged);
  });
  state.libraryItems = mergeLibraryItems(serverItems, state.libraryItems);
  await hydrateImportedReadingProgress(mangas, { mangaIds: progressMangaIds });
  saveLibraryItems();
  if (libraryRenderSignature() === previousRenderSignature) {
    refreshLibraryOfflineBadges();
    updateReaderNav();
  } else {
    renderLibrary();
  }
  if (announce) {
    setSyncStatus("Synced", `${mangas.length} Suwayomi library title${mangas.length === 1 ? "" : "s"} available in Panels.`, "good");
    showToast("Library refreshed from Suwayomi.");
  }
  return mangas.length;
}

async function hydrateImportedReadingProgress(mangas, { mangaIds = null } = {}) {
  const requestedIds = Array.isArray(mangaIds)
    ? new Set(mangaIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))
    : null;
  const requested = requestedIds
    ? mangas.filter((manga) => requestedIds.has(Number(manga.id)))
    : mangas.slice(0, 60);
  const planToRead = requestedIds ? [] : mangas.filter((manga) => {
    const key = libraryItemKey({ mangaId: manga.id, sourceId: manga.sourceId });
    return normalizedLibraryStatus(state.libraryItems.find((item) => libraryItemKey(item) === key)) === "plan_to_read";
  });
  const candidates = [...new Map([...requested, ...planToRead].map((manga) => [Number(manga.id), manga])).values()];
  const updates = new Map();
  const existingItems = new Map(state.libraryItems.map((item) => [libraryItemKey(item), item]));
  const offlineWindows = new Map();
  let outboxChanged = false;
  await mapWithConcurrency(candidates, 3, async (manga) => {
    try {
      const data = await graphQL(queries.storedChapters, { mangaId: Number(manga.id) }, { timeoutMs: 10000 });
      const nodes = data.chapters?.nodes || [];
      const key = libraryItemKey({ mangaId: manga.id, sourceId: manga.sourceId });
      const existing = existingItems.get(key);
      const serverUrl = existing?.serverUrl || currentDeviceServerUrl();
      const reconciliation = reconcileReadingProgress({
        chapters: nodes,
        libraryItem: existing,
        outbox: state.suwayomiProgressOutbox,
        serverUrl,
      });
      const reconciledStatus = existing?.statusExplicit
        ? normalizedLibraryStatus(existing)
        : (reconciliation.started ? "reading" : "plan_to_read");
      if (reconciliation.outbox.length !== state.suwayomiProgressOutbox.length) {
        state.suwayomiProgressOutbox = reconciliation.outbox;
        outboxChanged = true;
      }
      if (reconciliation.push) {
        upsertSuwayomiProgressOutbox({
          serverUrl,
          mangaId: Number(manga.id),
          ...reconciliation.push,
        });
        outboxChanged = true;
      }
      const resumeChapterId = reconciliation.winner?.chapterId || existing?.chapterId;
      offlineWindows.set(key, offlineWindowForStoredChapters(nodes, resumeChapterId));
      updates.set(key, reconciliation);
      // Server buffering is opportunistic and must not delay committing the
      // progress reconciliation shared by every title in this sync pass.
      if (reconciledStatus === "plan_to_read") {
        void enqueuePlanToReadServerBuffer({ ...existing, libraryStatus: reconciledStatus }, nodes);
      }
    } catch {
      // One title should not block the rest of the library reconciliation.
    }
  });
  state.libraryOfflineWindows = offlineWindows;
  updateLibraryOfflineReadiness();
  if (outboxChanged) persistSuwayomiProgressOutbox();
  if (!updates.size) return;
  state.libraryItems = state.libraryItems.map((item) => {
    const update = updates.get(libraryItemKey(item));
    if (!update) return item;
    const inferredStatus = item.statusExplicit
      ? normalizedLibraryStatus(item)
      : (update.started ? "reading" : "plan_to_read");
    if (!update.winner) {
      return { ...item, started: update.started, libraryStatus: inferredStatus };
    }
    const chapter = update.winner.chapter;
    const pageIndex = Math.max(0, Number(update.winner.lastPageRead) || 0);
    const sameLocalPosition = Number(item.chapterId) === Number(chapter.id)
      && Math.max(0, Number(item.pageIndex) || 0) === pageIndex;
    const progressChanged = !sameLocalPosition;
    return {
      ...item,
      started: update.started,
      libraryStatus: inferredStatus,
      chapterId: Number(chapter.id),
      chapterTitle: chapter.name || `Chapter ${chapter.chapterNumber || chapter.sourceOrder || chapter.id}`,
      pageIndex,
      panelIndex: sameLocalPosition ? Math.max(0, Number(item.panelIndex) || 0) : 0,
      progressLabel: sameLocalPosition && item.progressLabel
        ? item.progressLabel
        : `Page ${pageIndex + 1}`,
      updatedAt: progressChanged ? new Date().toISOString() : item.updatedAt,
    };
  });
}

async function syncLibraryAndProgress() {
  setBusy(el.syncProgress, true, "Syncing");
  setSyncStatus("Syncing", "Checking Suwayomi and sending any queued reading progress.");
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

function foregroundProgressMangaIds(limit = 12) {
  const ids = [];
  const add = (value) => {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
  };
  add(state.currentManga?.id);
  state.suwayomiProgressOutbox.forEach((entry) => add(entry.mangaId));
  state.libraryItems
    .slice()
    .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))
    .forEach((item) => add(item.mangaId));
  return ids.slice(0, limit);
}

async function reconcileSuwayomiOnForeground() {
  if (state.suwayomiForegroundSyncPromise) return state.suwayomiForegroundSyncPromise;
  if (!navigator.onLine || !state.connected) return false;
  const request = (async () => {
    // Pull first so a stale local queue can never overwrite progress made on
    // another device while this page was suspended. The bounded recent-title
    // set avoids a full-library chapter fan-out on every foreground event.
    setSyncStatus("Syncing", "Checking Suwayomi for progress from your other devices.");
    await syncSuwayomiLibrary({ progressMangaIds: foregroundProgressMangaIds() });
    await flushSuwayomiProgressOutbox();
    setSyncStatus("Synced", "Reading progress is reconciled with Suwayomi and ready on your other devices.", "good");
    return true;
  })();
  state.suwayomiForegroundSyncPromise = request;
  try {
    return await request;
  } catch (error) {
    setSyncStatus(
      state.suwayomiProgressOutbox.length ? "Queued" : "Sync failed",
      state.suwayomiProgressOutbox.length
        ? `Progress is saved and will retry: ${friendlySourceErrorMessage(error)}`
        : friendlySourceErrorMessage(error),
      state.suwayomiProgressOutbox.length ? "" : "bad"
    );
    throw error;
  } finally {
    if (state.suwayomiForegroundSyncPromise === request) state.suwayomiForegroundSyncPromise = null;
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
  if (el.readerErrorSource) {
    el.readerErrorSource.hidden = !(
      state.currentManga?.id &&
      state.currentManga?.sourceId &&
      (state.activeChapter?.type === "suwayomi" || Number(el.chapterId?.value) > 0)
    );
  }
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
  const item = normalizeLibraryItem({
    ...existing,
    mangaId: Number(state.currentManga.id),
    mangaTitle: state.currentManga.title,
    sourceId: state.currentManga.sourceId,
    sourceLabel: state.currentManga.sourceLabel,
    thumbnailUrl: state.currentManga.thumbnailUrl || existing?.thumbnailUrl,
    mediaFormat: state.currentManga.mediaFormat || existing?.mediaFormat || inferredMediaFormat(state.currentManga || existing),
    mediaFormatSource: state.currentManga.mediaFormatSource || existing?.mediaFormatSource || "automatic",
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
  });
  const key = libraryItemKey(item);
  state.libraryItems = [item, ...state.libraryItems.filter((existing) => libraryItemKey(existing) !== key)];
  saveLibraryItems();
  renderLibrary({ preserveInteractions: false });
  scheduleSuwayomiProgressSync();
  enqueueMangaBakaLibraryItem(item);
}

function currentSuwayomiPageIndex() {
  const pageCount = state.chapterPageUrls.length;
  if (!pageCount) return 0;
  if (state.panelMode !== "webtoon") return clamp(state.pageIndex, 0, pageCount - 1);
  if (continuousWebtoonReading()) {
    const scrollRange = Math.max(1, el.stageImageWrap.scrollHeight - el.stageImageWrap.clientHeight);
    const progress = clamp(el.stageImageWrap.scrollTop / scrollRange, 0, 1);
    return clamp(Math.floor(progress * pageCount), 0, pageCount - 1);
  }
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
  if (el.librarySyncStatus && el.librarySyncStatusLabel) {
    const normalized = String(label || "").toLowerCase();
    const status = /syncing|checking/.test(normalized)
      ? "syncing"
      : /queued|partial/.test(normalized)
        ? "queued"
        : tone === "good" && /synced/.test(normalized)
          ? "synced"
          : tone === "bad"
            ? "error"
            : "idle";
    const shortLabel = status === "synced"
      ? "Synced"
      : status === "syncing"
        ? (/checking/.test(normalized) ? "Checking" : "Syncing")
        : status === "queued"
          ? "Queued"
          : status === "error"
            ? (navigator.onLine ? "Sync issue" : "Offline")
            : "Connected";
    el.librarySyncStatus.dataset.state = status;
    el.librarySyncStatusLabel.textContent = shortLabel;
    el.librarySyncStatus.title = message || `Reading sync: ${shortLabel}`;
    el.librarySyncStatus.setAttribute("aria-label", `Reading sync: ${shortLabel}. ${message || ""}`.trim());
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
  upsertSuwayomiProgressOutbox({
    serverUrl,
    mangaId: Number(state.currentManga?.id || chapter?.mangaId) || null,
    chapterId,
    lastPageRead,
    completed,
  });
  persistSuwayomiProgressOutbox();
  setSyncStatus("Queued", "Latest reading progress is saved and waiting to sync.");
  return true;
}

function upsertSuwayomiProgressOutbox({ serverUrl, mangaId = null, chapterId, lastPageRead, completed = false }) {
  const normalizedServerUrl = normalizeSuwayomiBaseUrl(serverUrl || currentDeviceServerUrl());
  const normalizedChapterId = Number(chapterId);
  if (!Number.isInteger(normalizedChapterId)) return false;
  const existing = state.suwayomiProgressOutbox.find((item) => (
    item.chapterId === normalizedChapterId && item.serverUrl === normalizedServerUrl
  ));
  if (existing) {
    existing.lastPageRead = Math.max(existing.lastPageRead, Math.max(0, Number(lastPageRead) || 0));
    existing.completed = existing.completed || completed;
    if (!existing.mangaId && Number.isInteger(Number(mangaId)) && Number(mangaId) > 0) existing.mangaId = Number(mangaId);
    existing.updatedAt = Date.now();
  } else {
    state.suwayomiProgressOutbox.push({
      serverUrl: normalizedServerUrl,
      ...(Number.isInteger(Number(mangaId)) && Number(mangaId) > 0 ? { mangaId: Number(mangaId) } : {}),
      chapterId: normalizedChapterId,
      lastPageRead: Math.max(0, Number(lastPageRead) || 0),
      completed: Boolean(completed),
      updatedAt: Date.now(),
    });
  }
  return true;
}

function loadSuwayomiProgressOutbox() {
  try {
    const stored = JSON.parse(localStorage.getItem(progressOutboxStoreKey) || "[]");
    let sanitized = false;
    state.suwayomiProgressOutbox = Array.isArray(stored)
      ? stored.filter((item) => Number.isInteger(Number(item.chapterId))).map((item) => {
          const serverUrl = sanitizePersistedSuwayomiUrl(item.serverUrl || currentDeviceServerUrl());
          if (serverUrl !== item.serverUrl) sanitized = true;
          return {
            chapterId: Number(item.chapterId),
            ...(Number.isInteger(Number(item.mangaId)) && Number(item.mangaId) > 0 ? { mangaId: Number(item.mangaId) } : {}),
            serverUrl,
            lastPageRead: Math.max(0, Number(item.lastPageRead) || 0),
            completed: Boolean(item.completed),
            updatedAt: Number(item.updatedAt) || Date.now(),
          };
        })
      : [];
    if (sanitized) persistSuwayomiProgressOutbox();
  } catch {
    state.suwayomiProgressOutbox = [];
  }
}

function persistSuwayomiProgressOutbox() {
  try {
    state.suwayomiProgressOutbox = state.suwayomiProgressOutbox.map((item) => ({
      ...item,
      serverUrl: sanitizePersistedSuwayomiUrl(item.serverUrl),
    }));
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
        const currentData = await graphQL(
          queries.chapterProgress,
          { id: sent.chapterId },
          { timeoutMs: 10000, baseUrl: sent.serverUrl },
        );
        const remote = currentData.chapter;
        const remoteAlreadyWins = Boolean(remote) && (
          remote.isRead
          || (!sent.completed && Number(remote.lastPageRead) >= sent.lastPageRead)
        );
        if (remoteAlreadyWins) {
          const current = state.suwayomiProgressOutbox.find((item) => (
            item.chapterId === sent.chapterId && item.serverUrl === sent.serverUrl
          ));
          if (
            current
            && current.lastPageRead <= Math.max(sent.lastPageRead, Number(remote.lastPageRead) || 0)
            && (!current.completed || remote.isRead)
          ) {
            state.suwayomiProgressOutbox = state.suwayomiProgressOutbox.filter((item) => item !== current);
            persistSuwayomiProgressOutbox();
          }
          continue;
        }
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
  const keepFullPageReading = state.fullPage;
  recordCurrentReadingStatsFinish();
  if (state.activeChapter?.type === "suwayomi") {
    void markServerBufferChaptersRead([state.activeChapter.chapterId]);
    window.clearTimeout(state.suwayomiSyncTimer);
    enqueueCurrentSuwayomiProgress({ completed: true });
    void flushSuwayomiProgressOutbox().catch(() => false);
    completeMangaBakaChapter();
  }
  await loadNextChapter();
  if (keepFullPageReading && state.pages.length) {
    state.fullPage = true;
    state.pageRevealActive = false;
    updateAfterNavigation();
  }
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

function syncDownloadStatusSheetIsolation(open) {
  if (!open) {
    downloadSheetIsolationPrevious.forEach((wasInert, item) => {
      item.inert = wasInert;
    });
    downloadSheetIsolationPrevious.clear();
    return;
  }
  [...document.body.children].forEach((item) => {
    if (
      item === el.downloadStatusSheet ||
      item === el.downloadStatusBackdrop ||
      item.tagName === "SCRIPT"
    ) return;
    if (!downloadSheetIsolationPrevious.has(item)) {
      downloadSheetIsolationPrevious.set(item, item.inert);
    }
    item.inert = true;
  });
}

function setDownloadStatusSheet(open, returnFocusTarget = null) {
  const nextOpen = Boolean(open && el.downloadStatusButton && !el.downloadStatusButton.hidden);
  const wasOpen = state.downloadStatusSheetOpen;
  if (nextOpen && !wasOpen) {
    const activeElement = document.activeElement;
    const trigger = returnFocusTarget || (
      activeElement && activeElement !== document.body && activeElement !== document.documentElement
        ? activeElement
        : el.downloadStatusButton
    );
    state.downloadStatusReturnFocus = trigger?.isConnected && typeof trigger.focus === "function"
      ? trigger
      : el.downloadStatusButton;
  }
  state.downloadStatusSheetOpen = nextOpen;
  if (el.downloadStatusSheet) el.downloadStatusSheet.hidden = !nextOpen;
  if (el.downloadStatusBackdrop) el.downloadStatusBackdrop.hidden = !nextOpen;
  if (el.downloadStatusButton) el.downloadStatusButton.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  document.body.classList.toggle("download-sheet-open", nextOpen);
  syncDownloadStatusSheetIsolation(nextOpen);
  if (nextOpen) {
    void refreshDownloadStatus().catch(() => null);
    requestAnimationFrame(() => el.downloadStatusClose?.focus({ preventScroll: true }));
  } else if (wasOpen) {
    const returnFocusTarget = state.downloadStatusReturnFocus;
    state.downloadStatusReturnFocus = null;
    requestAnimationFrame(() => {
      const target = returnFocusTarget?.isConnected && returnFocusTarget.getClientRects?.().length
        ? returnFocusTarget
        : (!el.downloadStatusButton?.hidden ? el.downloadStatusButton : null);
      target?.focus({ preventScroll: true });
    });
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

function serverBufferScopeId(item = state.currentManga) {
  const mangaId = Number(item?.mangaId ?? item?.id);
  return Number.isInteger(mangaId) && mangaId > 0 ? `manga-${mangaId}` : "";
}

function serverBufferRetentionPolicyFromControls() {
  return {
    readRetentionDays: Math.max(0, Number(el.serverBufferRetentionDays?.value) || 30),
    keepRecentCount: Math.max(0, Number(el.serverBufferRetentionKeep?.value) || 0),
    sourceTestRetentionDays: 1,
  };
}

function activeServerBufferChapterIds() {
  const chapterId = Number(state.activeChapter?.chapterId);
  return state.activeChapter?.type === "suwayomi" && Number.isInteger(chapterId) && chapterId > 0 ? [chapterId] : [];
}

function renderServerBufferRetention(retention) {
  if (!el.serverBufferRetention) return;
  const policy = retention?.policy;
  if (policy && !state.serverBufferRetentionPreview) {
    if (el.serverBufferRetentionDays) el.serverBufferRetentionDays.value = String(policy.readRetentionDays ?? 30);
    if (el.serverBufferRetentionKeep) el.serverBufferRetentionKeep.value = String(policy.keepRecentCount ?? 2);
  }
  const preview = retention?.preview || {};
  const managed = Number(preview.managed ?? preview.uniqueSafeDownloads ?? 0) || 0;
  const eligible = Number(preview.eligible) || 0;
  const protectedCount = Number(preview.protected) || 0;
  if (el.serverBufferRetentionSummary) {
    el.serverBufferRetentionSummary.textContent = managed
      ? `${managed} Panels-managed chapter${managed === 1 ? " is" : "s are"} tracked · ${eligible} eligible now · ${protectedCount} protected. Manual and older downloads stay protected.`
      : "Only chapters downloaded automatically by Panels are eligible. Manual and older downloads stay protected.";
  }
  if (el.serverBufferRetentionApply) {
    el.serverBufferRetentionApply.hidden = !state.serverBufferRetentionPreview || eligible < 1;
    el.serverBufferRetentionApply.textContent = eligible === 1 ? "Remove 1 eligible chapter" : `Remove ${eligible} eligible chapters`;
  }
  if (el.serverBufferRetentionResult && state.serverBufferRetentionPreview) {
    el.serverBufferRetentionResult.textContent = eligible
      ? `${eligible} downloaded chapter${eligible === 1 ? "" : "s"} can be removed. Every manual, active, recent, unread, and pre-existing download remains protected.`
      : "Nothing is eligible under this policy. No downloads will be removed.";
  }
}

async function previewServerBufferRetention() {
  setBusy(el.serverBufferRetentionPreview, true, "Checking");
  try {
    const status = await postLocalJson("/api/download-buffer", {
      retentionPreview: true,
      retentionPolicy: serverBufferRetentionPolicyFromControls(),
      activeReaderChapterIds: activeServerBufferChapterIds(),
    });
    state.serverBufferRetentionPreview = status.retention || { preview: { eligible: 0 } };
    renderDownloadStatus(status);
  } catch (error) {
    showToast(`Could not preview cleanup: ${friendlySourceErrorMessage(error)}`, "bad");
  } finally {
    setBusy(el.serverBufferRetentionPreview, false);
  }
}

async function applyServerBufferRetention() {
  const eligible = Number(state.serverBufferRetentionPreview?.preview?.eligible) || 0;
  if (!eligible) return;
  if (!window.confirm(`Remove ${eligible} eligible server chapter${eligible === 1 ? "" : "s"}?\n\nManual, active, unread, recent, and older unmanaged downloads will stay protected.`)) return;
  setBusy(el.serverBufferRetentionApply, true, "Removing");
  try {
    const status = await postLocalJson("/api/download-buffer", {
      cleanupRetention: true,
      retentionPolicy: serverBufferRetentionPolicyFromControls(),
      activeReaderChapterIds: activeServerBufferChapterIds(),
    });
    const removed = Number(status.retentionCleanup?.removed ?? status.removedDownloads ?? eligible) || 0;
    state.serverBufferRetentionPreview = null;
    renderDownloadStatus(status);
    if (el.serverBufferRetentionResult) {
      el.serverBufferRetentionResult.textContent = `Removed ${removed} temporary server chapter${removed === 1 ? "" : "s"}.`;
    }
    showToast(`Removed ${removed} temporary server chapter${removed === 1 ? "" : "s"}.`, "good");
  } catch (error) {
    showToast(`Could not clean up chapters: ${friendlySourceErrorMessage(error)}`, "bad");
  } finally {
    setBusy(el.serverBufferRetentionApply, false);
  }
}

async function markServerBufferChaptersRead(chapterIds) {
  const ids = [...new Set((chapterIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length || !navigator.onLine) return null;
  return postLocalJson("/api/download-buffer", { markReadChapterIds: ids }).catch(() => null);
}

function setDownloadStatusFilter(filter) {
  const nextFilter = filter === "failed" ? "failed" : "all";
  state.downloadStatusFilter = state.downloadStatusFilter === nextFilter && nextFilter !== "all"
    ? "all"
    : nextFilter;
  renderDownloadStatus(state.downloadStatus);
  requestAnimationFrame(() => el.downloadStatFailedFilter?.focus({ preventScroll: true }));
}

async function retryFailedChapter(chapter, button) {
  const chapterId = Number(chapter?.chapterId ?? chapter?.id);
  if (!Number.isInteger(chapterId) || chapterId < 1) return;
  setBusy(button, true, "Retrying");
  try {
    const status = await postLocalJson("/api/download-buffer", {
      chapterIds: [chapterId],
      priority: "background",
    });
    if ((status.failedChapters || []).some((failedChapter) => Number(failedChapter?.chapterId) === chapterId)) {
      throw new Error("This chapter could not be returned to the queue. It may no longer belong to a library title.");
    }
    renderDownloadStatus(status);
    showToast(`${downloadChapterLabel(chapter)} returned to the download queue.`, "good");
  } catch (error) {
    showToast(`Could not retry ${downloadChapterLabel(chapter)}: ${friendlySourceErrorMessage(error)}`, "bad");
  } finally {
    setBusy(button, false);
  }
}

function renderDownloadStatus(status) {
  state.downloadStatus = status || null;
  updateLibraryOfflineReadiness(status);
  if (state.activeView === "library") refreshLibraryOfflineBadges();
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
  if (globalFailed < 1) state.downloadStatusFilter = "all";
  const failedFilterActive = state.downloadStatusFilter === "failed";

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
  el.downloadStatusButton.setAttribute("aria-label", `Suwayomi server buffer: ${el.downloadStatusLabel.textContent}, ${el.downloadStatusCount.textContent}. Open details.`);

  const chapters = failedFilterActive
    ? (Array.isArray(status?.failedChapters) ? status.failedChapters : [])
    : (Array.isArray(status?.windowChapters) ? status.windowChapters : []);
  const mangaTitle = chapters.find((chapter) => chapter.mangaTitle)?.mangaTitle || "";
  if (el.downloadStatusTitle) {
    el.downloadStatusTitle.textContent = failedFilterActive
      ? "Failed server downloads"
      : (mangaTitle ? `${mangaTitle} · server buffer` : "Server chapter buffer");
  }
  if (el.downloadStatusSummary) {
    el.downloadStatusSummary.textContent = failedFilterActive
      ? `${globalFailed} failed chapter${globalFailed === 1 ? "" : "s"}. Retry one below or return them all to the queue.`
      : downloadBufferStatusText(status).replace(/^Server chapter buffer:\s*/i, "");
  }
  if (el.downloadProgressTrack) {
    el.downloadProgressTrack.setAttribute("aria-valuemax", String(Math.max(1, total)));
    el.downloadProgressTrack.setAttribute("aria-valuenow", String(downloaded));
  }
  if (el.downloadProgressBar) el.downloadProgressBar.style.width = `${total ? Math.min(100, (downloaded / total) * 100) : 0}%`;
  if (el.downloadStatDownloaded) el.downloadStatDownloaded.textContent = String(downloaded);
  if (el.downloadStatQueued) el.downloadStatQueued.textContent = String(queued + (active ? 1 : 0));
  if (el.downloadStatRetrying) el.downloadStatRetrying.textContent = String(retrying);
  if (el.downloadStatFailed) el.downloadStatFailed.textContent = String(globalFailed);
  if (el.downloadStatFailedFilter) {
    el.downloadStatFailedFilter.disabled = globalFailed < 1;
    el.downloadStatFailedFilter.setAttribute("aria-pressed", failedFilterActive ? "true" : "false");
    el.downloadStatFailedFilter.setAttribute(
      "aria-label",
      failedFilterActive ? "Show all server downloads" : `Show ${globalFailed} failed download${globalFailed === 1 ? "" : "s"}`,
    );
  }

  if (el.downloadChapterList) {
    el.downloadChapterList.replaceChildren();
    if (!chapters.length && failedFilterActive) {
      const empty = document.createElement("p");
      empty.className = "download-chapter-empty";
      empty.textContent = "No failed chapters remain.";
      el.downloadChapterList.append(empty);
    }
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
      copy.append(title, source);
      if (failedFilterActive && chapter.lastError) {
        const error = document.createElement("small");
        error.className = "download-chapter-error";
        error.textContent = friendlySourceErrorMessage(chapter.lastError);
        copy.append(error);
      }
      let trailing;
      if (failedFilterActive && chapter.state === "failed") {
        trailing = document.createElement("button");
        trailing.type = "button";
        trailing.className = "download-chapter-retry";
        trailing.textContent = "Retry";
        trailing.setAttribute("aria-label", `Retry ${downloadChapterLabel(chapter)}`);
        trailing.addEventListener("click", () => void retryFailedChapter(chapter, trailing));
      } else {
        trailing = document.createElement("span");
        trailing.className = "download-chapter-badge";
        trailing.textContent = downloadChapterStateLabel(chapter);
      }
      row.append(marker, copy, trailing);
      el.downloadChapterList.append(row);
    });
  }

  const issue = chapters.find((chapter) => chapter.lastError)?.lastError || status?.statusError || "";
  if (el.downloadStatusIssue) {
    el.downloadStatusIssue.hidden = !issue;
    el.downloadStatusIssue.textContent = issue ? `Latest issue: ${friendlySourceErrorMessage(issue)}` : "";
  }
  if (el.downloadStatusRetry) el.downloadStatusRetry.hidden = globalFailed < 1;
  renderServerBufferRetention(status?.retention);
}

function earliestPlanToReadChapterIds(chapters, limit = downloadAheadChapterCount) {
  const readable = chapters.filter((chapter) => Number.isInteger(Number(chapter?.id)) && Number(chapter.id) > 0);
  const counts = new Map(scanlatorCounts(readable));
  const variants = new Map();
  readable.forEach((chapter) => {
    const key = chapterGroupKey(chapter);
    if (!variants.has(key)) variants.set(key, []);
    variants.get(key).push(chapter);
  });
  return [...variants.values()]
    .map((items) => chooseChapterVariant(items, counts))
    .filter(Boolean)
    .sort((left, right) => (
      Number(left.sourceOrder ?? left.chapterNumber ?? 0) - Number(right.sourceOrder ?? right.chapterNumber ?? 0)
      || Number(left.id) - Number(right.id)
    ))
    .slice(0, Math.max(0, limit))
    .map((chapter) => Number(chapter.id));
}

function planToReadBufferKey(item) {
  const mangaId = Number(item?.mangaId ?? item?.id);
  if (!Number.isInteger(mangaId) || mangaId < 1) return "";
  const configuredServerUrl = currentDeviceServerUrl();
  const serverUrl = String(item.serverUrl || configuredServerUrl).trim().replace(/\/+$/, "");
  return `${serverUrl}:${mangaId}`;
}

function clearPlanToReadBufferRetry(key) {
  const timer = state.planBufferRetryTimers.get(key);
  if (timer) window.clearTimeout(timer);
  state.planBufferRetryTimers.delete(key);
}

function schedulePlanToReadBufferRetry(item, knownChapters, attempt) {
  const key = planToReadBufferKey(item);
  const delay = planBufferRetryDelaysMs[attempt - 1];
  if (!key || !Number.isFinite(delay) || state.planBufferRetryTimers.has(key)) return;
  const timer = window.setTimeout(() => {
    state.planBufferRetryTimers.delete(key);
    const current = state.libraryItems.find((entry) => libraryItemKey(entry) === libraryItemKey(item));
    if (normalizedLibraryStatus(current) !== "plan_to_read") return;
    void enqueuePlanToReadServerBuffer(current, knownChapters, { retryAttempt: attempt });
  }, delay);
  state.planBufferRetryTimers.set(key, timer);
}

async function enqueuePlanToReadServerBuffer(item, knownChapters = null, { retryAttempt = 0 } = {}) {
  const mangaId = Number(item?.mangaId ?? item?.id);
  if (!Number.isInteger(mangaId) || mangaId < 1 || normalizedLibraryStatus(item) !== "plan_to_read") return false;
  if (!navigator.onLine || !state.connected) return false;
  const configuredServerUrl = currentDeviceServerUrl();
  const serverUrl = String(item.serverUrl || configuredServerUrl).trim().replace(/\/+$/, "");
  // The server-side buffer is attached to this Panels deployment's configured
  // Suwayomi. Never send chapter IDs belonging to a different server instance.
  if (serverUrl !== configuredServerUrl) return false;
  const key = `${serverUrl}:${mangaId}`;
  if (state.planBufferRequests.has(key)) return state.planBufferRequests.get(key);

  const request = (async () => {
    try {
      let chapters = knownChapters;
      if (!Array.isArray(chapters)) {
        const data = await graphQL(queries.storedChapters, { mangaId }, { timeoutMs: 10000, baseUrl: serverUrl });
        chapters = data.chapters?.nodes || [];
      }
      const chapterIds = earliestPlanToReadChapterIds(chapters);
      const signature = chapterIds.join(",");
      const current = state.libraryItems.find((entry) => libraryItemKey(entry) === libraryItemKey(item));
      if (normalizedLibraryStatus(current) !== "plan_to_read") return false;
      if (state.planBufferSignatures.get(key) === signature) {
        clearPlanToReadBufferRetry(key);
        return true;
      }
      if (!chapterIds.length) {
        state.planBufferSignatures.set(key, signature);
        clearPlanToReadBufferRetry(key);
        return true;
      }
      const status = await postLocalJson("/api/download-buffer", {
        chapterIds,
        priority: "background",
        purpose: "plan-to-read",
        scopeId: serverBufferScopeId(item),
      });
      if (Number(status?.rejected) > 0) {
        throw new Error(`${status.rejected} chapter${Number(status.rejected) === 1 ? " was" : "s were"} not accepted by the server buffer`);
      }
      const stillPlanned = state.libraryItems.find((entry) => libraryItemKey(entry) === libraryItemKey(item));
      if (normalizedLibraryStatus(stillPlanned) === "plan_to_read") {
        state.planBufferSignatures.set(key, signature);
      } else {
        state.planBufferSignatures.delete(key);
      }
      clearPlanToReadBufferRetry(key);
      renderDownloadStatus(status);
      return true;
    } catch {
      // Buffering is opportunistic. The next library sync or status transition
      // retries without interfering with normal online reading.
      schedulePlanToReadBufferRetry(item, knownChapters, retryAttempt + 1);
      return false;
    }
  })();
  state.planBufferRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (state.planBufferRequests.get(key) === request) state.planBufferRequests.delete(key);
  }
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
    const status = await postLocalJson("/api/download-buffer", {
      chapterIds: ids,
      priority: "foreground",
      purpose: "reading-ahead",
      scopeId: serverBufferScopeId(),
    });
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
  if (
    state.activeChapter?.type !== "suwayomi" ||
    state.activeChapter.deviceLocal ||
    state.activeView !== "reader" ||
    !readerIsVisible() ||
    !navigator.onLine
  ) return;
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
    if (
      state.nextChapterPrefetch !== record ||
      generation !== state.prepareGeneration ||
      state.activeView !== "reader" ||
      !readerIsVisible()
    ) return;
    startNextChapterPrefetch(record);
  }, Math.max(0, delayMs));
  return record;
}

function startNextChapterPrefetch(record) {
  if (
    !record ||
    record.promise ||
    state.nextChapterPrefetch !== record ||
    state.activeView !== "reader" ||
    !readerIsVisible()
  ) return record?.promise || null;
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
  return normalizeSuwayomiBaseUrl(state.baseUrl || defaultSuwayomiUrl);
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
  if (state.deviceStorageRepairing) return false;
  if (["preparing", "downloading"].includes(chapterPackage.status)) return false;
  if (state.deviceDownloadControllers.has(chapterPackage.key)) return false;
  return chapterPackage.key !== activeDeviceReaderPackageKey();
}

function deviceStoragePackages() {
  return Array.isArray(state.deviceStorageSnapshot?.packages)
    ? state.deviceStorageSnapshot.packages
    : [...state.deviceChapters.values()];
}

function filteredDeviceStoragePackages() {
  const packages = deviceStoragePackages();
  if (state.deviceStorageFilter === "ready") return packages.filter((chapterPackage) => chapterPackage.status === "ready");
  if (state.deviceStorageFilter === "incomplete") return packages.filter(deviceChapterIsIncomplete);
  return packages;
}

function setDeviceStorageFilter(filter) {
  state.deviceStorageFilter = ["ready", "incomplete"].includes(filter) ? filter : "all";
  state.deviceStorageSelection.clear();
  renderDeviceStorage();
}

function updateDeviceStorageSelectionControls() {
  const packages = filteredDeviceStoragePackages();
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
  const allPackages = deviceStoragePackages();
  const packages = filteredDeviceStoragePackages();
  el.deviceStorageList.replaceChildren();

  el.deviceStorageFilters.forEach((button) => {
    const active = button.dataset.deviceStorageFilter === state.deviceStorageFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const incomplete = allPackages.filter(deviceChapterIsIncomplete);
  const retryable = incomplete.filter((chapterPackage) => Array.isArray(chapterPackage.pageUrls) && chapterPackage.pageUrls.length);
  if (el.deviceStorageRetryIncomplete) {
    el.deviceStorageRetryIncomplete.hidden = incomplete.length < 1;
    el.deviceStorageRetryIncomplete.disabled = state.deviceStorageRepairing || retryable.length < 1;
    el.deviceStorageRetryIncomplete.textContent = state.deviceStorageRepairing
      ? "Retrying…"
      : `Retry incomplete (${retryable.length})`;
  }
  if (el.deviceStorageClearIncomplete) {
    el.deviceStorageClearIncomplete.hidden = incomplete.length < 1;
    el.deviceStorageClearIncomplete.disabled = state.deviceStorageRepairing || state.deviceStorageRemoving;
    el.deviceStorageClearIncomplete.textContent = `Clear incomplete (${incomplete.length})`;
  }

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

  const packageCount = Number(snapshot.packageCount ?? allPackages.length) || 0;
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
    empty.textContent = allPackages.length
      ? `No ${state.deviceStorageFilter} chapters are saved on this device.`
      : "No chapters are saved on this device yet.";
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

async function retryIncompleteDeviceStorage() {
  if (state.deviceStorageRepairing) return;
  const targets = deviceStoragePackages().filter(deviceChapterIsIncomplete);
  if (!targets.length) return;
  state.deviceStorageRepairing = true;
  renderDeviceStorage();
  let completed = 0;
  let failed = 0;
  try {
    for (const chapterPackage of targets) {
      try {
        await retryIncompleteDeviceChapter(chapterPackage.serverUrl, chapterPackage.chapterId);
        completed += 1;
      } catch {
        failed += 1;
      }
      announceDeviceStorage(`Retried ${completed + failed} of ${targets.length} incomplete chapters…`);
    }
    announceDeviceStorage(
      failed
        ? `${completed} chapter${completed === 1 ? "" : "s"} repaired; ${failed} still need attention.`
        : `${completed} incomplete chapter${completed === 1 ? "" : "s"} repaired.`,
      failed ? "bad" : "good"
    );
  } finally {
    state.deviceStorageRepairing = false;
    await refreshDeviceStorage({ reconcile: true });
    renderDeviceStorage();
  }
}

function clearIncompleteDeviceStorage(returnFocus = document.activeElement) {
  const keys = deviceStoragePackages()
    .filter(deviceChapterIsIncomplete)
    .filter(deviceStoragePackageSelectable)
    .map((chapterPackage) => chapterPackage.key);
  if (!keys.length) {
    announceDeviceStorage("There are no removable incomplete chapters.");
    return;
  }
  openDeviceStorageRemovalDialog(keys, returnFocus);
}

function deviceStorageSelectionKeys() {
  return [...state.deviceStorageSelection].filter((key) => {
    const chapterPackage = deviceStoragePackages().find((item) => item.key === key);
    return chapterPackage && deviceStoragePackageSelectable(chapterPackage);
  });
}

function setAllDeviceStorageSelection() {
  const selectable = filteredDeviceStoragePackages().filter(deviceStoragePackageSelectable);
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
    mediaFormat: resumeItem?.mediaFormat || chapterPackage.mediaFormat,
    mediaFormatSource: resumeItem?.mediaFormatSource || chapterPackage.mediaFormatSource || "automatic",
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
  void markDeviceChapterOpened(chapterPackage.serverUrl, chapter.id).then((updatedPackage) => {
    if (updatedPackage) rememberDevicePackage(updatedPackage);
  }).catch(() => null);
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
    mediaFormat: inferredMediaFormat(manga),
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

function chapterPosition(chapter) {
  const chapterNumber = migrationChapterNumber(chapter);
  if (Number.isFinite(chapterNumber)) return chapterNumber;
  const sourceOrder = Number(chapter?.sourceOrder);
  return Number.isFinite(sourceOrder) ? sourceOrder : Number.NaN;
}

function unreadChaptersBefore(chapter) {
  const position = chapterPosition(chapter);
  if (Number.isFinite(position)) {
    return state.chapters.filter((candidate) => (
      Number(candidate.id) !== Number(chapter.id)
      && !candidate.isRead
      && Number.isFinite(chapterPosition(candidate))
      && chapterPosition(candidate) < position
    ));
  }
  const sequence = state.chapters.slice().sort((a, b) => Number(b.sourceOrder || 0) - Number(a.sourceOrder || 0));
  const selectedIndex = sequence.findIndex((candidate) => Number(candidate.id) === Number(chapter.id));
  return selectedIndex < 0 ? [] : sequence.slice(selectedIndex + 1).filter((candidate) => !candidate.isRead);
}

function distinctChapterCount(chapters) {
  return new Set(chapters.map(chapterGroupKey)).size;
}

async function markChaptersBeforeRead(chapter, button) {
  const targets = unreadChaptersBefore(chapter);
  if (!targets.length) {
    showToast("All earlier chapters are already marked as read.", "good");
    return;
  }
  const chapterTitle = chapter.name || `Chapter ${chapter.chapterNumber || chapter.sourceOrder || chapter.id}`;
  const targetChapterCount = distinctChapterCount(targets);
  const noun = targetChapterCount === 1 ? "chapter" : "chapters";
  if (!window.confirm(`Mark ${targetChapterCount} ${noun} before ${chapterTitle} as read?\n\n${chapterTitle} itself will stay unchanged.`)) return;

  setBusy(button, true, "Marking");
  const succeeded = [];
  const failed = [];
  const serverUrl = chapter.serverUrl || currentDeviceServerUrl();
  await mapWithConcurrency(targets, 4, async (target) => {
    try {
      const data = await graphQL(
        queries.updateChapter,
        { input: { id: Number(target.id), patch: { isRead: true, lastPageRead: Math.max(0, Number(target.pageCount || 1) - 1) } } },
        { timeoutMs: 10000, baseUrl: target.serverUrl || serverUrl },
      );
      const updated = data.updateChapter?.chapter;
      if (!updated?.isRead) throw new Error("Suwayomi did not confirm the chapter as read.");
      Object.assign(target, updated);
      succeeded.push(target);
    } catch (error) {
      failed.push({ target, error });
    }
  });

  renderChapters();
  if (succeeded.length && serverUrl === currentDeviceServerUrl()) {
    void markServerBufferChaptersRead(succeeded.map((target) => target.id));
  }
  if (!failed.length) {
    showToast(`Marked ${targetChapterCount} earlier ${noun} as read.`, "good");
  } else if (succeeded.length) {
    showToast(`Marked ${succeeded.length}; ${failed.length} could not be updated. Try again to finish.`, "bad");
  } else {
    showToast(`Could not mark earlier chapters: ${friendlySourceErrorMessage(failed[0].error)}`, "bad");
  }
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
          returnFocusTarget: button,
        });
      } else {
        showToast("This chapter has not been saved on this device.", "bad");
      }
    });
    actions.append(button);

    const earlierUnread = unreadChaptersBefore(chapter);
    if (earlierUnread.length) {
      const earlierChapterCount = distinctChapterCount(earlierUnread);
      const markEarlier = document.createElement("button");
      markEarlier.type = "button";
      markEarlier.dataset.chapterAction = "mark-earlier-read";
      markEarlier.className = "mark-earlier-read";
      markEarlier.textContent = "Mark earlier read";
      markEarlier.setAttribute(
        "aria-label",
        `Mark ${earlierChapterCount} ${earlierChapterCount === 1 ? "chapter" : "chapters"} before ${title.textContent} as read`,
      );
      markEarlier.disabled = !navigator.onLine;
      markEarlier.addEventListener("click", () => void markChaptersBeforeRead(chapter, markEarlier));
      actions.append(markEarlier);
    }

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

  rememberReaderModalFocus(options.returnFocusTarget || document.activeElement);
  setActiveView("reader");
  hideReaderError();
  setReaderChromeVisible(true);
  setBusy(el.loadChapterPages, true, "Loading");
  setReaderLoading(true, "Fetching chapter pages...", 12);
  const observationSource = state.sources.find((source) => String(source.id) === String(state.currentManga?.sourceId))
    || { id: state.currentManga?.sourceId, displayName: state.currentManga?.sourceLabel };
  const observationStartedAt = performance.now();
  const observationFormat = inferredMediaFormat(state.currentManga);
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
    void markDeviceChapterOpened(serverUrl, chapterId).then((chapterPackage) => {
      if (chapterPackage) rememberDevicePackage(chapterPackage);
    }).catch(() => null);
    rememberReadingProgress();
    if (serverUrl === currentDeviceServerUrl()) void ensureDownloadAhead(chapterId);
    setConnection(true, `Loaded ${pages.length} pages. Panel detection is running locally.`, "good");
    void recordSourceObservations([makeSourceObservation(observationSource, "pages", "success", observationStartedAt, observationFormat)]);
  } catch (error) {
    if (error?.name === "ReaderLoadCancelled" || !loadIsCurrent()) return;
    void recordSourceObservations([makeSourceObservation(observationSource, "pages", "failure", observationStartedAt, observationFormat)]);
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
  state.pageRevealActive = false;
  clearWebtoonAutoAdvance();
  state.webtoonScrollIntent = false;
  prepareReadingStatsChapterAttempt();
  updateReaderViewToggle();
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
    if (state.panelMode === "webtoon") state.fullPage = true;
    else if (!resumeMatches && state.pageReveal === "before") state.pageRevealActive = true;
    updateReaderViewToggle();
    setReaderLoading(true, "Rendering reader...", 92);
    if (!loadIsCurrent()) return;
    renderCurrentPage();
    renderPanelStrip();
    updateStats();
    if (continuousWebtoonReading()) {
      requestAnimationFrame(() => scrollContinuousWebtoonToPanel(state.panelIndex));
    }
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
  state.fullPage = resumeMode === "webtoon";
  state.pageRevealActive = false;
  state.pendingResume = null;
}

function autoSelectPanelMode(image) {
  const savedFormat = state.currentManga?.mediaFormat;
  const detectedFormat = detectedMediaFormatForPage(state.currentManga, image, activeChapterSourceLabel());
  const detectedMode = state.panelModeUserOverride
    ? state.panelMode
    : savedFormat && !formatCanBeAutomaticallyRefined(state.currentManga)
      ? savedFormat
      : detectedFormat || savedFormat || automaticMediaFormat(state.currentManga);
  if (detectedMode && state.currentManga && (savedFormat !== detectedMode || formatCanBeAutomaticallyRefined(state.currentManga))) {
    persistCurrentMangaMediaFormat(detectedMode, "automatic");
  }
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
        ? await detectComicPanels(image, direction, page.url).catch(() => [fullPagePanel(naturalWidth, naturalHeight)])
        : await detectPanels(image, direction, page.url).catch(() => [fullPagePanel(naturalWidth, naturalHeight)]);
  const viewport = readerViewportAspect();
  const detectionDecision = mode === "webtoon"
    ? null
    : choosePanelDetectionFallback({
        panels: detectedPanels,
        pageWidth: naturalWidth,
        pageHeight: naturalHeight,
        direction,
        viewportAspect: viewport.width / Math.max(1, viewport.height),
      });
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
  page.detectionStrategy = detectionDecision?.strategy || "panels";
  page.detectionConfidence = detectionDecision?.confidence ?? null;
  page.detectionReasons = detectionDecision?.reasonCodes || [];
  let presentationPanels = detectionDecision?.strategy === "full-width"
    ? makeFullWidthFallbackPanels(naturalWidth, naturalHeight, viewport)
    : detectionDecision?.strategy === "full-page"
      ? [fullPagePanel(naturalWidth, naturalHeight)]
      : sanitizePanels(detectionDecision?.panels || detectedPanels, naturalWidth, naturalHeight);
  page.spread = classifyPageSpread({
    pageWidth: naturalWidth,
    pageHeight: naturalHeight,
    panels: presentationPanels,
  });
  if (page.detectionStrategy === "panels" && page.spread.safeToReorder) {
    presentationPanels = orderSpreadPanels(presentationPanels, {
      classification: page.spread,
      direction,
    });
  }
  page.panels = presentationPanels;
  if (page.spread.isSpread) page.detectionReasons = [...new Set([...page.detectionReasons, "two-page-spread"])];
  page.bubbles = mode === "manga" ? sanitizeDetectionBoxes(detectedPanels?.bubbles) : [];
  page.calibrationSeriesId = currentPanelCalibrationSeriesId();
  page.calibrationBasePanels = page.panels.map((panel) => ({ ...panel }));
  page.calibrationCommitted = false;
  page.calibrationReportedBad = false;
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
  syncReadingStatsTracker();
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
  syncReadingStatsTracker();
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
  state.performanceStats.backgroundStarts += 1;
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

function makeFullWidthFallbackPanels(width, height, viewport = readerViewportAspect()) {
  const pageAspect = Math.max(0.01, Number(width) / Math.max(1, Number(height)));
  const viewportAspect = Math.max(0.01, Number(viewport?.width) / Math.max(1, Number(viewport?.height)));
  const visibleHeight = clamp(pageAspect / viewportAspect, 0.2, 0.82);
  if (visibleHeight >= 0.8) return [fullPagePanel(width, height)];
  const step = visibleHeight * 0.92;
  const panels = [];
  for (let y = 0; y < 1; y += step) {
    const top = Math.min(y, Math.max(0, 1 - visibleHeight));
    if (panels.some((panel) => Math.abs(panel.y - top) < 0.001)) break;
    panels.push({
      x: 0,
      y: top,
      w: 1,
      h: Math.min(visibleHeight, 1 - top),
      label: `Full-width section ${panels.length + 1}`,
      pageWidth: width,
      pageHeight: height,
      confidenceFallback: true,
    });
    if (top + visibleHeight >= 0.999) break;
  }
  return panels.length ? panels : [fullPagePanel(width, height)];
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

function sanitizeDetectionBoxes(boxes) {
  if (!Array.isArray(boxes)) return [];
  return boxes
    .filter((box) => (
      box
      && Number.isFinite(Number(box.x))
      && Number.isFinite(Number(box.y))
      && Number.isFinite(Number(box.w))
      && Number.isFinite(Number(box.h))
      && Number(box.w) > 0
      && Number(box.h) > 0
    ))
    .map((box) => {
      const x = clamp(Number(box.x), 0, 0.999);
      const y = clamp(Number(box.y), 0, 0.999);
      return {
        x,
        y,
        w: clamp(Number(box.w), 0.001, 1 - x),
        h: clamp(Number(box.h), 0.001, 1 - y),
        score: Number.isFinite(Number(box.score)) ? Number(box.score) : 1,
      };
    })
    .filter((box) => box.w * box.h <= 0.72);
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

async function detectPanelsForMode(image, direction, mode = "manga", pageUrl = "") {
  if (mode === "comic") return detectComicPanels(image, direction, pageUrl);
  if (mode === "webtoon") return makeWebtoonPanels(image);
  return detectPanels(image, direction, pageUrl);
}

async function detectMangaPanelsWithModel(image, direction, pageUrl = "") {
  if (state.mangaModelAvailable === false) return null;
  const payload = await requestPanelModel(image, pageUrl, "manga");
  state.mangaModelAvailable = true;
  const bubbles = sanitizeDetectionBoxes(payload.bubbles);
  if (!payload.panels.length) {
    return attachDetectionBubbles([fullPagePanel(image.naturalWidth, image.naturalHeight)], bubbles);
  }
  const panels = payload.panels.map((panel) => ({
    ...panel,
    pageWidth: image.naturalWidth,
    pageHeight: image.naturalHeight,
  }));
  const consolidated = consolidateMangaPanels(panels);
  const sorted = repairReadingOrder(sortPanels(consolidated, direction), direction);
  const detected = sorted.length ? sorted.map((panel, index) => ({ ...panel, label: `Panel ${index + 1}` })) : [
    fullPagePanel(image.naturalWidth, image.naturalHeight),
  ];
  return attachDetectionBubbles(detected, bubbles);
}

async function requestPanelModel(image, pageUrl, mode) {
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
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not encode page")), "image/jpeg", 0.82);
    });
    contentType = "image/jpeg";
  }
  const response = await fetch(`/api/detect/${mode}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 502 || response.status === 503) {
      if (mode === "manga") state.mangaModelAvailable = false;
      else state.comicModelAvailable = false;
    }
    throw new Error(`${mode} model returned ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.panels)) throw new Error(`${mode} model returned an invalid response`);
  return payload;
}

function attachDetectionBubbles(panels, bubbles) {
  panels.bubbles = Array.isArray(bubbles) ? bubbles : [];
  return panels;
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

async function detectComicPanels(image, direction, pageUrl = "") {
  const modelPanels = await detectComicPanelsWithModel(image, direction, pageUrl).catch(() => null);
  if (modelPanels) return modelPanels;
  return detectComicPanelsHeuristic(image, direction);
}

async function detectComicPanelsWithModel(image, direction, pageUrl = "") {
  if (state.comicModelAvailable === false) return null;
  const payload = await requestPanelModel(image, pageUrl, "comic");
  state.comicModelAvailable = true;
  if (!payload.panels.length) return [fullPagePanel(image.naturalWidth, image.naturalHeight)];
  let panels = sanitizeDetectionBoxes(payload.panels).map((panel) => ({
    ...panel,
    pageWidth: image.naturalWidth,
    pageHeight: image.naturalHeight,
  }));
  if (direction === "rtl") panels = repairReadingOrder(sortPanels(panels, direction), direction);
  return panels.length ? panels.map((panel, index) => ({ ...panel, label: `Region ${index + 1}` })) : [
    fullPagePanel(image.naturalWidth, image.naturalHeight),
  ];
}

async function detectComicPanelsHeuristic(image, direction) {
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
  cancelHighZoomEnhancement("page-change");
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
  if (pageChanged) recordCurrentReadingStatsPage();
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

function continuousWebtoonReading() {
  return state.activeView === "reader" && state.panelMode === "webtoon" && state.fullPage;
}

function layoutContinuousWebtoon(page, { scrollTop = null } = {}) {
  if (!continuousWebtoonReading() || !page?.stripImages?.length) return false;
  const strip = ensureStageStrip();
  clearReaderCameraSettle();
  strip.classList.remove("reader-camera-settled", "camera-animating", "cinematic-keyframes");
  delete strip.dataset.cameraSettled;
  const availableWidth = Math.max(1, el.stageImageWrap.clientWidth || el.stage.clientWidth);
  const scale = availableWidth / Math.max(1, page.naturalWidth);
  strip.style.width = `${availableWidth}px`;
  strip.style.height = `${page.naturalHeight * scale}px`;
  strip.style.transform = "none";
  strip.style.transformOrigin = "0 0";
  strip.querySelectorAll("[data-segment-placeholder]").forEach((placeholder) => {
    const segment = page.stripImages[Number(placeholder.dataset.segmentPlaceholder)];
    if (segment) placeholder.style.height = `${segment.height * scale}px`;
  });
  if (Number.isFinite(scrollTop)) el.stageImageWrap.scrollTop = scrollTop;
  return true;
}

function renderStripPage(page, { refit = true, contentExtended = false } = {}) {
  const strip = ensureStageStrip();
  const signature = page.stripImages.map((item) => `${item.url}:${Math.round(item.height)}`).join("|");
  const current = currentPanel();
  const continuous = continuousWebtoonReading();
  const continuousScale = (parseFloat(strip.style.width) || el.stageImageWrap.clientWidth || page.naturalWidth)
    / Math.max(1, page.naturalWidth);
  const currentY = continuous
    ? (el.stageImageWrap.scrollTop + el.stageImageWrap.clientHeight / 2) / Math.max(0.0001, continuousScale)
    : current ? (current.y + current.h / 2) * page.naturalHeight : 0;
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
    const preservedScrollTop = continuous ? el.stageImageWrap.scrollTop : null;
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
    if (continuous) layoutContinuousWebtoon(page, { scrollTop: preservedScrollTop });
  }

  if (continuous) {
    layoutContinuousWebtoon(page);
    return;
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
  const viewportSignature = `${window.innerWidth}x${window.innerHeight}:${window.visualViewport?.width || 0}x${window.visualViewport?.height || 0}`;
  if (
    !state.viewportFitTimer
    && viewportSignature === state.viewportFitSignature
    && performance.now() - state.viewportFitAt < 500
  ) return;
  window.clearTimeout(state.viewportFitTimer);
  state.viewportFitTimer = window.setTimeout(() => {
    state.viewportFitTimer = 0;
    if (readerIsVisible() && state.activeView === "reader") {
      state.viewportFitAt = performance.now();
      state.viewportFitSignature = `${window.innerWidth}x${window.innerHeight}:${window.visualViewport?.width || 0}x${window.visualViewport?.height || 0}`;
      state.performanceStats.viewportFits += 1;
      scheduleCameraFit();
    }
  }, 140);
}

function currentPanelCalibrationSeriesId() {
  const sourceIdentity = state.currentManga?.sourceId
    || state.activeChapter?.chapter?.manga?.source?.id
    || state.activeChapter?.type
    || activeChapterSourceLabel();
  const titleIdentity = state.currentManga?.mangaId
    || state.currentManga?.id
    || state.activeChapter?.chapter?.manga?.id
    || state.activeChapter?.comicUrl
    || "";
  return makePanelCalibrationSeriesId(sourceIdentity, titleIdentity);
}

function enhancedPanelRect(page, panel) {
  if (!panel) return panel;
  let framed = panel;
  if (state.bubbleAwareFraming && state.panelMode === "manga") {
    framed = framePanelForBubbles({
      panel,
      bubbles: page?.bubbles,
      panels: page?.panels,
    }) || panel;
  }
  return applyPanelCalibration(
    framed,
    state.panelCalibration,
    page?.calibrationSeriesId || currentPanelCalibrationSeriesId(),
  );
}

function commitPageCalibration(page) {
  if (!page || page.calibrationCommitted) return false;
  page.calibrationCommitted = true;
  if (
    page.panelMode !== "manga"
    || page.detectionStrategy !== "panels"
    || !page.calibrationSeriesId
    || !Array.isArray(page.calibrationBasePanels)
    || !page.calibrationBasePanels.length
    || !Array.isArray(page.bubbles)
    || !page.bubbles.length
  ) return false;
  const acceptedPanels = page.calibrationBasePanels.map((panel) => framePanelForBubbles({
    panel,
    bubbles: page.bubbles,
    panels: page.calibrationBasePanels,
  }) || panel);
  const changed = acceptedPanels.some((panel, index) => {
    const base = page.calibrationBasePanels[index];
    return ["x", "y", "w", "h"].some((key) => Math.abs(Number(panel[key]) - Number(base[key])) > 0.0005);
  });
  if (!changed) return false;
  const result = learnPanelCalibration(state.panelCalibration, {
    seriesId: page.calibrationSeriesId,
    accepted: true,
    strategy: page.detectionStrategy,
    confidenceFallback: page.detectionStrategy !== "panels",
    reportedBad: page.calibrationReportedBad === true,
    detectorConfidence: page.detectionConfidence,
    detectedPanels: page.calibrationBasePanels,
    acceptedPanels,
  });
  if (!result.learned) return false;
  state.panelCalibration = result.calibration;
  persistPanelCalibration();
  return true;
}

function cameraTransform(camera) {
  return `matrix(${camera.scale}, 0, 0, ${camera.scale}, ${camera.left}, ${camera.top})`;
}

function settledCameraTransform(camera) {
  return `translate(${camera.left}px, ${camera.top}px)`;
}

function clearReaderCameraSettle() {
  window.clearTimeout(state.readerCameraSettleTimer);
  state.readerCameraSettleTimer = 0;
}

function cancelHighZoomEnhancement(status = "idle") {
  window.clearTimeout(state.highZoomEnhancementTimer);
  state.highZoomEnhancementTimer = 0;
  state.highZoomEnhancementRequestId += 1;
  state.highZoomEnhancementCancel?.();
  state.highZoomEnhancementCancel = null;
  state.highZoomEnhancementWorker?.terminate();
  state.highZoomEnhancementWorker = null;
  if (!el.stageEnhancement) return;
  el.stageEnhancement.hidden = true;
  el.stageEnhancement.dataset.status = status;
  const context = el.stageEnhancement.getContext("2d");
  context?.clearRect(0, 0, el.stageEnhancement.width, el.stageEnhancement.height);
}

function highZoomEnhancementEligible(element, camera) {
  if (
    !state.highZoomEnhancement
    || element !== el.stageImage
    || state.fullPage
    || state.pageRevealActive
    || state.panelMode === "webtoon"
    || state.readerOverview
    || continuousWebtoonReading()
  ) return false;
  const deviceScale = camera.scale * Math.max(1, Number(window.devicePixelRatio) || 1);
  return deviceScale >= highZoomEnhancementTrigger;
}

function highZoomEnhancementGeometry(page, camera) {
  const stageRect = el.stage.getBoundingClientRect();
  const target = camera.target;
  if (!target || stageRect.width < 1 || stageRect.height < 1) return null;

  const sourceX = clamp(Math.floor(target.x * page.naturalWidth), 0, page.naturalWidth - 1);
  const sourceY = clamp(Math.floor(target.y * page.naturalHeight), 0, page.naturalHeight - 1);
  const sourceRight = clamp(Math.ceil((target.x + target.w) * page.naturalWidth), sourceX + 1, page.naturalWidth);
  const sourceBottom = clamp(Math.ceil((target.y + target.h) * page.naturalHeight), sourceY + 1, page.naturalHeight);
  const sourceWidth = sourceRight - sourceX;
  const sourceHeight = sourceBottom - sourceY;
  const cropCssWidth = sourceWidth * camera.scale;
  const cropCssHeight = sourceHeight * camera.scale;
  let renderScale = Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1));
  renderScale = Math.min(
    renderScale,
    Math.sqrt(highZoomEnhancementMaxPixels / Math.max(1, cropCssWidth * cropCssHeight)),
    Math.sqrt(highZoomEnhancementMaxCanvasPixels / Math.max(1, stageRect.width * stageRect.height))
  );
  if (!Number.isFinite(renderScale) || renderScale < 0.75) return null;

  const targetWidth = Math.max(1, Math.round(cropCssWidth * renderScale));
  const targetHeight = Math.max(1, Math.round(cropCssHeight * renderScale));
  if (targetWidth <= sourceWidth * 1.03 && targetHeight <= sourceHeight * 1.03) return null;
  return {
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    canvasWidth: Math.max(1, Math.round(stageRect.width * renderScale)),
    canvasHeight: Math.max(1, Math.round(stageRect.height * renderScale)),
    destinationX: Math.round((camera.left + sourceX * camera.scale) * renderScale),
    destinationY: Math.round((camera.top + sourceY * camera.scale) * renderScale),
    renderScale,
  };
}

function scheduleHighZoomEnhancement(element, camera) {
  cancelHighZoomEnhancement(state.highZoomEnhancement ? "waiting" : "off");
  if (!highZoomEnhancementEligible(element, camera)) return;
  const requestId = state.highZoomEnhancementRequestId;
  state.highZoomEnhancementTimer = window.setTimeout(() => {
    state.highZoomEnhancementTimer = 0;
    void renderHighZoomEnhancement(element, camera, requestId);
  }, 45);
}

async function renderHighZoomEnhancement(element, camera, requestId) {
  const page = state.pages[camera.pageIndex];
  const canvas = el.stageEnhancement;
  if (!page || !canvas || requestId !== state.highZoomEnhancementRequestId) return false;
  const geometry = highZoomEnhancementGeometry(page, camera);
  if (!geometry) {
    canvas.dataset.status = "native";
    return false;
  }

  const source = page.image || element;
  const scratch = document.createElement("canvas");
  scratch.width = geometry.sourceWidth;
  scratch.height = geometry.sourceHeight;
  const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
  if (!scratchContext) return false;
  let sourcePixels;
  try {
    scratchContext.drawImage(
      source,
      geometry.sourceX,
      geometry.sourceY,
      geometry.sourceWidth,
      geometry.sourceHeight,
      0,
      0,
      geometry.sourceWidth,
      geometry.sourceHeight
    );
    sourcePixels = scratchContext.getImageData(0, 0, geometry.sourceWidth, geometry.sourceHeight).data;
  } catch {
    canvas.dataset.status = "fallback";
    return false;
  }
  if (requestId !== state.highZoomEnhancementRequestId) return false;

  canvas.dataset.status = "processing";
  let worker;
  try {
    worker = new Worker(new URL("./reader-clarity-worker.js", import.meta.url), { type: "module" });
  } catch {
    canvas.dataset.status = "fallback";
    return false;
  }
  state.highZoomEnhancementWorker = worker;
  const result = await new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      if (state.highZoomEnhancementCancel === cancel) state.highZoomEnhancementCancel = null;
      resolve(value);
    };
    const cancel = () => finish({ error: "cancelled" });
    state.highZoomEnhancementCancel = cancel;
    worker.addEventListener("message", (event) => finish(event.data), { once: true });
    worker.addEventListener("error", () => finish({ error: "worker" }), { once: true });
    worker.postMessage({
      id: requestId,
      source: sourcePixels.buffer,
      width: geometry.sourceWidth,
      height: geometry.sourceHeight,
      targetWidth: geometry.targetWidth,
      targetHeight: geometry.targetHeight,
    }, [sourcePixels.buffer]);
  }).catch(() => ({ error: "worker" }));
  worker.terminate();
  if (state.highZoomEnhancementWorker === worker) state.highZoomEnhancementWorker = null;
  if (
    result?.error
    || result?.id !== requestId
    || requestId !== state.highZoomEnhancementRequestId
    || state.readerCamera?.pageIndex !== camera.pageIndex
    || state.readerCamera?.panelIndex !== camera.panelIndex
  ) {
    if (requestId === state.highZoomEnhancementRequestId) canvas.dataset.status = "fallback";
    return false;
  }

  try {
    const context = canvas.getContext("2d");
    if (!context) return false;
    canvas.width = geometry.canvasWidth;
    canvas.height = geometry.canvasHeight;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.putImageData(
      new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height),
      geometry.destinationX,
      geometry.destinationY
    );
  } catch {
    canvas.dataset.status = "fallback";
    return false;
  }
  canvas.dataset.status = "ready";
  canvas.dataset.renderScale = geometry.renderScale.toFixed(3);
  canvas.dataset.sourceSize = `${geometry.sourceWidth}x${geometry.sourceHeight}`;
  canvas.dataset.outputSize = `${geometry.targetWidth}x${geometry.targetHeight}`;
  canvas.hidden = false;
  return true;
}

function cameraBaseDimension(element, key, fallback = 1) {
  return Math.max(1, Number(element?.dataset?.[key]) || Number(fallback) || 1);
}

function prepareReaderCameraElement(element, camera, { pageChanged = false } = {}) {
  clearReaderCameraSettle();
  cancelHighZoomEnhancement("moving");
  const baseWidth = cameraBaseDimension(element, "cameraBaseWidth");
  const baseHeight = cameraBaseDimension(element, "cameraBaseHeight");
  const previous = state.readerCamera;
  const wasSettled = element.dataset.cameraSettled === "true";
  const canRestorePrevious = wasSettled && previous?.pageIndex === camera.pageIndex;
  const alreadyJumping = element.classList.contains("camera-jump");

  if (canRestorePrevious && !alreadyJumping) element.classList.add("camera-jump");
  element.classList.remove("reader-camera-settled");
  element.style.width = `${baseWidth}px`;
  element.style.height = `${baseHeight}px`;
  if (canRestorePrevious) {
    element.style.transform = cameraTransform(previous);
    // Commit the visually equivalent unscaled layout before starting a new transition.
    void element.offsetWidth;
  }
  delete element.dataset.cameraSettled;
  if (canRestorePrevious && !alreadyJumping && !pageChanged) element.classList.remove("camera-jump");
}

function settleReaderCamera(element, camera) {
  const current = state.readerCamera;
  if (
    !element?.isConnected
    || state.readerOverview
    || continuousWebtoonReading()
    || !current
    || current.pageIndex !== camera.pageIndex
    || current.panelIndex !== camera.panelIndex
  ) return false;
  const baseWidth = cameraBaseDimension(element, "cameraBaseWidth");
  const baseHeight = cameraBaseDimension(element, "cameraBaseHeight");
  element.classList.remove("camera-animating", "cinematic-keyframes");
  element.classList.add("reader-camera-settled");
  element.style.width = `${baseWidth * camera.scale}px`;
  element.style.height = `${baseHeight * camera.scale}px`;
  element.style.transform = settledCameraTransform(camera);
  element.dataset.cameraSettled = "true";
  scheduleHighZoomEnhancement(element, camera);
  return true;
}

function scheduleReaderCameraSettle(element, camera, delay = 0) {
  clearReaderCameraSettle();
  state.readerCameraSettleTimer = window.setTimeout(() => {
    state.readerCameraSettleTimer = 0;
    settleReaderCamera(element, camera);
  }, Math.max(0, Number(delay) || 0));
}

function cameraForTarget(page, target, stageRect) {
  const imageWidth = page.naturalWidth;
  const imageHeight = page.naturalHeight;
  let scale = Math.min(
    stageRect.width / (imageWidth * target.w),
    stageRect.height / (imageHeight * target.h)
  );
  if (state.panelMode === "webtoon" && !state.fullPage && !state.pageRevealActive) {
    const widthFitScale = stageRect.width / imageWidth;
    scale = Math.max(scale, widthFitScale * 0.5);
  }
  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;
  const centerX = (target.x + target.w / 2) * renderedWidth;
  const centerY = (target.y + target.h / 2) * renderedHeight;
  return {
    pageIndex: state.pageIndex,
    panelIndex: state.panelIndex,
    scale,
    left: stageRect.width / 2 - centerX,
    top: stageRect.height / 2 - centerY,
    centerX: target.x + target.w / 2,
    centerY: target.y + target.h / 2,
    aspect: (imageWidth * target.w) / Math.max(1, imageHeight * target.h),
    target,
  };
}

function cinematicTransitionForCameras(previous, next, options = {}) {
  const baseDuration = Number.isFinite(options.baseDuration) ? options.baseDuration : readerMotionDurationMs();
  const enabled = options.enabled === undefined ? state.cinematicMotion : Boolean(options.enabled);
  if (!enabled || baseDuration <= 0 || !previous || !next || previous.pageIndex !== next.pageIndex) {
    return {
      duration: Math.max(0, baseDuration),
      easing: "cubic-bezier(0.25, 0.1, 0.25, 1)",
      pan: baseDuration <= 0 ? "instant" : "standard",
      distance: 0,
      aspectChange: 0,
    };
  }
  const distance = Math.hypot(next.centerX - previous.centerX, next.centerY - previous.centerY);
  const aspectChange = Math.abs(Math.log(Math.max(0.001, next.aspect) / Math.max(0.001, previous.aspect)));
  const zoomChange = Math.abs(Math.log(Math.max(0.001, next.scale) / Math.max(0.001, previous.scale)));
  const pan = distance > 0.38 ? "sweep" : aspectChange > 0.42 || zoomChange > 0.48 ? "reframe" : "glide";
  const duration = Math.round(clamp(
    baseDuration * (0.82 + Math.min(0.85, distance) * 0.9 + Math.min(0.8, aspectChange) * 0.32 + Math.min(0.8, zoomChange) * 0.24),
    Math.min(100, baseDuration),
    state.readerMotion === "quick" ? 300 : 520
  ));
  const easing = pan === "sweep"
    ? "cubic-bezier(0.22, 1, 0.36, 1)"
    : pan === "reframe"
      ? "cubic-bezier(0.16, 1, 0.3, 1)"
      : "cubic-bezier(0.33, 1, 0.68, 1)";
  return { duration, easing, pan, distance, aspectChange };
}

function finishReaderCameraAnimation(animation, element, camera) {
  if (state.readerCameraAnimation !== animation) return;
  state.readerCameraAnimation = null;
  element.classList.remove("cinematic-keyframes");
  settleReaderCamera(element, camera);
}

function applyReaderCamera(element, camera, { pageChanged = false } = {}) {
  const previous = state.readerCamera;
  const transition = cinematicTransitionForCameras(previous, camera, {
    baseDuration: readerMotionDurationMs(),
    enabled: state.cinematicMotion && !pageChanged && !state.readerOverview,
  });
  const targetTransform = cameraTransform(camera);
  state.readerCameraAnimation?.cancel();
  state.readerCameraAnimation = null;
  prepareReaderCameraElement(element, camera, { pageChanged });
  element.classList.remove("cinematic-keyframes");
  element.classList.toggle("camera-animating", transition.duration > 0);
  element.style.setProperty("--reader-motion-duration", `${transition.duration}ms`);
  element.style.setProperty("--reader-motion-easing", transition.easing);
  element.dataset.cinematicPan = transition.pan;
  element.dataset.cinematicDuration = String(transition.duration);

  if (
    !pageChanged
    && (transition.pan === "sweep" || transition.pan === "reframe")
    && typeof element.animate === "function"
    && previous?.pageIndex === camera.pageIndex
  ) {
    const startTransform = getComputedStyle(element).transform === "none"
      ? element.style.transform
      : getComputedStyle(element).transform;
    const zoomOut = transition.pan === "sweep" ? 0.1 : 0.065;
    const middle = {
      scale: Math.min(previous.scale, camera.scale) * (1 - zoomOut),
      left: (previous.left + camera.left) / 2,
      top: (previous.top + camera.top) / 2,
    };
    element.style.transform = targetTransform;
    element.classList.add("cinematic-keyframes");
    const animation = element.animate([
      { transform: startTransform, offset: 0, easing: "cubic-bezier(0.3, 0, 0.5, 1)" },
      { transform: cameraTransform(middle), offset: 0.42, easing: transition.easing },
      { transform: targetTransform, offset: 1 },
    ], { duration: transition.duration, fill: "none" });
    state.readerCameraAnimation = animation;
    animation.finished.then(
      () => finishReaderCameraAnimation(animation, element, camera),
      () => finishReaderCameraAnimation(animation, element, camera)
    );
  } else {
    element.style.transform = targetTransform;
  }
  state.readerCamera = camera;
  if (!state.readerCameraAnimation) scheduleReaderCameraSettle(element, camera, transition.duration + 34);
}

function fitStage() {
  const page = state.pages[state.pageIndex];
  if (!page?.naturalWidth || !page?.naturalHeight) return;

  const wholePage = state.fullPage || state.pageRevealActive;
  const rect = wholePage ? fullPagePanel(page.naturalWidth, page.naturalHeight) : currentPanel();
  const stageRect = el.stage.getBoundingClientRect();
  if (continuousWebtoonReading()) {
    layoutContinuousWebtoon(page);
    return;
  }
  const imageWidth = page.naturalWidth;
  const imageHeight = page.naturalHeight;
  const framedRect = wholePage ? rect : enhancedPanelRect(page, rect);
  const paddedTarget = wholePage
    ? fullPagePanel(imageWidth, imageHeight)
    : expandPanelRect(framedRect || fullPagePanel(imageWidth, imageHeight), state.panelPadding / 100);
  const clarity = wholePage
    ? {
      rect: paddedTarget,
      applied: false,
      mode: state.highZoomClarity,
      expansionFactor: 1,
      deviceScaleBefore: 0,
      deviceScaleAfter: 0,
    }
    : clarityAwarePanelRect(paddedTarget, {
      pageWidth: imageWidth,
      pageHeight: imageHeight,
      stageWidth: stageRect.width,
      stageHeight: stageRect.height,
      devicePixelRatio: window.devicePixelRatio || 1,
    }, state.highZoomClarity);
  const target = clarity.rect;
  const camera = cameraForTarget(page, target, stageRect);
  camera.clarity = clarity;

  const targetElement = page.stripImages ? ensureStageStrip() : el.stageImage;
  targetElement.dataset.clarityMode = clarity.mode;
  targetElement.dataset.clarityApplied = clarity.applied ? "true" : "false";
  targetElement.dataset.clarityExpansion = clarity.expansionFactor.toFixed(3);
  targetElement.dataset.clarityDeviceScale = (clarity.deviceScaleAfter || camera.scale * (window.devicePixelRatio || 1)).toFixed(3);
  const pageChanged = state.cameraPageChanged;
  state.cameraPageChanged = false;
  const motionDuration = readerMotionDurationMs();
  if (pageChanged) targetElement.classList.add("camera-jump");
  if (pageChanged && motionDuration > 0) targetElement.classList.add("page-fade");
  targetElement.dataset.cameraBaseWidth = String(imageWidth);
  targetElement.dataset.cameraBaseHeight = String(imageHeight);
  targetElement.style.transformOrigin = "0 0";
  applyReaderCamera(targetElement, camera, { pageChanged });
  state.performanceStats.cameraFits += 1;
  state.performanceStats.transformWrites += 1;
  if (pageChanged) {
    window.setTimeout(() => targetElement.classList.remove("camera-jump"), 0);
    window.setTimeout(() => targetElement.classList.remove("page-fade"), Math.max(140, motionDuration));
  }
}

function readerCameraElement(page = state.pages[state.pageIndex]) {
  return page?.stripImages ? ensureStageStrip() : el.stageImage;
}

function readerOverviewAvailable() {
  return Boolean(
    state.activeView === "reader"
    && state.pages[state.pageIndex]?.naturalWidth
    && !activeReaderModal()
    && !state.navigationPending
    && !continuousWebtoonReading()
    && !state.fullPage
    && !state.pageRevealActive
  );
}

function applyReaderOverviewProgress(progress = 1) {
  const overview = state.readerOverview;
  if (!overview?.element?.isConnected) return false;
  const amount = clamp(Number(progress) || 0, 0, 1);
  const start = overview.camera;
  const end = overview.overviewCamera;
  overview.element.style.transform = cameraTransform({
    scale: start.scale + (end.scale - start.scale) * amount,
    left: start.left + (end.left - start.left) * amount,
    top: start.top + (end.top - start.top) * amount,
  });
  overview.progress = amount;
  return true;
}

function beginReaderOverview(kind = "hold") {
  if (state.readerOverview || !readerOverviewAvailable()) return false;
  const page = state.pages[state.pageIndex];
  const element = readerCameraElement(page);
  const stageRect = el.stage.getBoundingClientRect();
  const camera = state.readerCamera?.pageIndex === state.pageIndex
    ? { ...state.readerCamera }
    : cameraForTarget(page, expandPanelRect(currentPanel(), state.panelPadding / 100), stageRect);
  const overviewCamera = cameraForTarget(page, fullPagePanel(page.naturalWidth, page.naturalHeight), stageRect);
  clearReaderCameraSettle();
  cancelHighZoomEnhancement("overview");
  state.readerCameraAnimation?.cancel();
  state.readerCameraAnimation = null;
  prepareReaderCameraElement(element, camera);
  element.classList.remove("camera-animating");
  element.classList.remove("cinematic-keyframes");
  window.clearTimeout(state.readerOverviewRestoreTimer);
  document.body.classList.remove("reader-overview-restoring");
  state.readerOverview = {
    kind,
    pageIndex: state.pageIndex,
    panelIndex: state.panelIndex,
    element,
    camera,
    overviewCamera,
    transform: element.style.transform,
    width: element.style.width,
    height: element.style.height,
    progress: 0,
  };
  document.body.classList.add("reader-overview-active");
  if (el.readerOverviewHint) {
    el.readerOverviewHint.textContent = kind === "pinch"
      ? "Release both fingers to return to the panel"
      : "Release to return to the panel";
    el.readerOverviewHint.hidden = false;
  }
  applyReaderOverviewProgress(kind === "pinch" ? 0.45 : 1);
  return true;
}

function endReaderOverview({ cancelled = false } = {}) {
  const overview = state.readerOverview;
  if (!overview) return false;
  state.readerOverview = null;
  document.body.classList.remove("reader-overview-active");
  if (el.readerOverviewHint) el.readerOverviewHint.hidden = true;
  const sameCrop = (
    overview.element?.isConnected
    && overview.pageIndex === state.pageIndex
    && overview.panelIndex === state.panelIndex
    && !state.fullPage
    && !state.pageRevealActive
  );
  if (sameCrop) {
    document.body.classList.add("reader-overview-restoring");
    overview.element.style.width = overview.width;
    overview.element.style.height = overview.height;
    overview.element.style.transform = overview.transform;
    const restoreDuration = readerMotionDurationMs() > 0 ? 240 : 0;
    window.clearTimeout(state.readerOverviewRestoreTimer);
    state.readerOverviewRestoreTimer = window.setTimeout(() => {
      state.readerOverviewRestoreTimer = 0;
      document.body.classList.remove("reader-overview-restoring");
      settleReaderCamera(overview.element, overview.camera);
    }, restoreDuration);
  } else {
    document.body.classList.remove("reader-overview-restoring");
    scheduleCameraFit();
  }
  state.suppressReaderTapUntil = performance.now() + (cancelled ? 120 : 420);
  return true;
}

function clearReaderHoldGesture() {
  window.clearTimeout(state.readerHoldTimer);
  state.readerHoldTimer = 0;
  state.readerHoldPointer = null;
}

function handleReaderPointerDown(event) {
  if (!event.isPrimary || event.button > 0 || !readerOverviewAvailable() || isInteractiveTarget(event.target)) return;
  clearReaderHoldGesture();
  state.readerHoldPointer = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
  };
  state.readerHoldTimer = window.setTimeout(() => {
    state.readerHoldTimer = 0;
    if (!state.readerHoldPointer || state.readerPinch || !beginReaderOverview("hold")) return;
    try { el.stage.setPointerCapture?.(state.readerHoldPointer.pointerId); } catch { /* Capture is best-effort on iPad Safari. */ }
  }, 360);
}

function handleReaderPointerMove(event) {
  const hold = state.readerHoldPointer;
  if (!hold || hold.pointerId !== event.pointerId || state.readerOverview?.kind === "hold") return;
  if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 12) clearReaderHoldGesture();
}

function handleReaderPointerEnd(event) {
  const hold = state.readerHoldPointer;
  if (!hold || hold.pointerId !== event.pointerId) return;
  clearReaderHoldGesture();
  if (state.readerOverview?.kind === "hold") endReaderOverview({ cancelled: event.type === "pointercancel" });
}

function touchDistance(touches) {
  if (!touches || touches.length < 2) return 0;
  return Math.hypot(
    Number(touches[0].clientX) - Number(touches[1].clientX),
    Number(touches[0].clientY) - Number(touches[1].clientY)
  );
}

function handleReaderTouchStart(event) {
  if (continuousWebtoonReading() || event.touches.length < 2 || !readerOverviewAvailable()) return;
  clearReaderHoldGesture();
  const distance = Math.max(1, touchDistance(event.touches));
  if (!beginReaderOverview("pinch")) return;
  state.readerPinch = { startDistance: distance };
  event.preventDefault();
}

function handleReaderTouchMove(event) {
  if (!state.readerPinch || state.readerOverview?.kind !== "pinch") return;
  if (event.touches.length < 2) return;
  const ratio = touchDistance(event.touches) / state.readerPinch.startDistance;
  applyReaderOverviewProgress(clamp(0.45 + (1 - ratio) * 1.8, 0.3, 1));
  event.preventDefault();
}

function handleReaderTouchEnd(event) {
  if (!state.readerPinch || event.touches.length >= 2) return;
  state.readerPinch = null;
  endReaderOverview({ cancelled: event.type === "touchcancel" });
  event.preventDefault();
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

function detectionBoxIntersectionArea(one, two) {
  const x0 = Math.max(one.x, two.x);
  const y0 = Math.max(one.y, two.y);
  const x1 = Math.min(one.x + one.w, two.x + two.w);
  const y1 = Math.min(one.y + one.h, two.y + two.h);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

function bubblePanelIndex(bubble, panels) {
  if (!bubble || !Array.isArray(panels) || !panels.length) return -1;
  const centerX = bubble.x + bubble.w / 2;
  const centerY = bubble.y + bubble.h / 2;
  const bubbleArea = Math.max(0.000001, bubble.w * bubble.h);
  let bestIndex = -1;
  let bestScore = 0;

  panels.forEach((panel, index) => {
    const containsCenter = centerX >= panel.x && centerX <= panel.x + panel.w
      && centerY >= panel.y && centerY <= panel.y + panel.h;
    const nearX = Math.max(0.018, Math.min(0.04, panel.w * 0.12));
    const nearY = Math.max(0.014, Math.min(0.035, panel.h * 0.12));
    const nearCenter = centerX >= panel.x - nearX && centerX <= panel.x + panel.w + nearX
      && centerY >= panel.y - nearY && centerY <= panel.y + panel.h + nearY;
    const overlap = detectionBoxIntersectionArea(bubble, panel) / bubbleArea;
    if (!containsCenter && !(nearCenter && overlap >= 0.08) && overlap < 0.22) return;
    const score = (containsCenter ? 4 : nearCenter ? 2 : 0) + overlap - Math.min(0.5, panel.w * panel.h) * 0.01;
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  });
  return bestIndex;
}

function bubbleAwarePanelRect(panel, bubbles = [], panels = [panel]) {
  if (!panel || !Array.isArray(bubbles) || !bubbles.length) return panel;
  const panelIndex = panels.indexOf(panel);
  if (panelIndex < 0) return panel;
  const horizontalLimit = Math.min(0.1, Math.max(0.025, panel.w * 0.22));
  const verticalLimit = Math.min(0.08, Math.max(0.02, panel.h * 0.22));
  let x0 = panel.x;
  let y0 = panel.y;
  let x1 = panel.x + panel.w;
  let y1 = panel.y + panel.h;
  let includedBubbles = 0;

  bubbles.forEach((bubble) => {
    if (bubblePanelIndex(bubble, panels) !== panelIndex) return;
    const marginX = Math.min(0.012, Math.max(0.003, bubble.w * 0.08));
    const marginY = Math.min(0.01, Math.max(0.002, bubble.h * 0.08));
    x0 = Math.min(x0, Math.max(panel.x - horizontalLimit, bubble.x - marginX));
    y0 = Math.min(y0, Math.max(panel.y - verticalLimit, bubble.y - marginY));
    x1 = Math.max(x1, Math.min(panel.x + panel.w + horizontalLimit, bubble.x + bubble.w + marginX));
    y1 = Math.max(y1, Math.min(panel.y + panel.h + verticalLimit, bubble.y + bubble.h + marginY));
    includedBubbles += 1;
  });

  const boundedX0 = clamp(x0, 0, 1);
  const boundedY0 = clamp(y0, 0, 1);
  const boundedX1 = clamp(x1, boundedX0 + 0.001, 1);
  const boundedY1 = clamp(y1, boundedY0 + 0.001, 1);
  return {
    ...panel,
    x: boundedX0,
    y: boundedY0,
    w: boundedX1 - boundedX0,
    h: boundedY1 - boundedY0,
    bubbleCount: includedBubbles,
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

function updateBubbleAwareFramingControls() {
  [el.bubbleAwareFraming, el.bubbleAwareFramingReader].forEach((control) => {
    if (control) control.checked = state.bubbleAwareFraming;
  });
}

function setBubbleAwareFraming(enabled) {
  state.bubbleAwareFraming = Boolean(enabled);
  updateBubbleAwareFramingControls();
  saveSettings();
  if (state.activeView === "reader") scheduleCameraFit();
}

function updateHighZoomClarityControls() {
  [el.highZoomClarity, el.highZoomClarityReader].forEach((control) => {
    if (control) control.value = state.highZoomClarity;
  });
}

function updateHighZoomEnhancementControls() {
  [el.highZoomEnhancement, el.highZoomEnhancementReader].forEach((control) => {
    if (control) control.checked = state.highZoomEnhancement;
  });
}

function setHighZoomEnhancement(enabled) {
  state.highZoomEnhancement = Boolean(enabled);
  updateHighZoomEnhancementControls();
  saveSettings();
  if (!state.highZoomEnhancement) {
    cancelHighZoomEnhancement("off");
    return;
  }
  const element = readerCameraElement();
  if (state.activeView === "reader" && state.readerCamera && element?.dataset.cameraSettled === "true") {
    scheduleHighZoomEnhancement(element, state.readerCamera);
  }
}

function setHighZoomClarity(value) {
  state.highZoomClarity = normalizeHighZoomClarity(value);
  updateHighZoomClarityControls();
  saveSettings();
  if (state.activeView === "reader" && !state.fullPage) scheduleCameraFit();
}

function updateReaderInteractionControls() {
  [el.pageReveal, el.pageRevealReader].forEach((control) => {
    if (control) control.value = state.pageReveal;
  });
  [el.cinematicMotion, el.cinematicMotionReader].forEach((control) => {
    if (control) control.checked = state.cinematicMotion;
  });
  updateHighZoomClarityControls();
  updateHighZoomEnhancementControls();
}

function setPageReveal(value) {
  if (!["off", "before", "after"].includes(value)) return;
  state.pageReveal = value;
  if (value === "off" && state.pageRevealActive) {
    state.pageRevealActive = false;
    updateAfterNavigation();
  }
  updateReaderInteractionControls();
  saveSettings();
}

function setCinematicMotion(enabled) {
  state.cinematicMotion = Boolean(enabled);
  updateReaderInteractionControls();
  saveSettings();
}

function updatePanelModeControls() {
  el.mangaMode?.classList.toggle("active", state.panelMode === "manga");
  el.comicMode?.classList.toggle("active", state.panelMode === "comic");
  el.webtoonMode?.classList.toggle("active", state.panelMode === "webtoon");
  el.mangaMode?.setAttribute("aria-pressed", state.panelMode === "manga" ? "true" : "false");
  el.comicMode?.setAttribute("aria-pressed", state.panelMode === "comic" ? "true" : "false");
  el.webtoonMode?.setAttribute("aria-pressed", state.panelMode === "webtoon" ? "true" : "false");
  if (el.redetect) el.redetect.textContent = "Detect panels";
  updateReaderViewToggle();
}

function renderVersionNote() {
  if (!el.versionNote) return;
  el.versionNote.textContent = `${appVersion} | ${buildId} | ${detectorVersion}`;
}

async function setPanelMode(mode) {
  if (!isPanelMode(mode)) return;
  if (state.currentManga) {
    state.panelModeUserOverride = true;
    persistCurrentMangaMediaFormat(mode, "manual");
  }
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
    state.fullPage = mode === "webtoon";
    state.pageRevealActive = mode !== "webtoon" && state.pageReveal === "before";
    if (mode === "webtoon") exitReaderFullscreen();
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
  syncReadingStatsTracker();
  syncReadingSessionActivity();
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
  if (activeReaderModal() || state.readerOverview || !state.pages.length || !Number.isFinite(Number(delta)) || Number(delta) === 0) return;
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
  if (continuousWebtoonReading()) return scrollContinuousWebtoon(delta);
  if (state.fullPage) return moveToAdjacentPage(delta);
  const page = state.pages[state.pageIndex];
  if (!Array.isArray(page?.panels) || !page.panels.length) {
    page.panels = sanitizePanels(page?.panels, page?.naturalWidth || 1, page?.naturalHeight || 1);
    state.panelIndex = 0;
  }
  if (state.pageRevealActive) {
    if ((state.pageReveal === "before" && delta > 0) || (state.pageReveal === "after" && delta < 0)) {
      state.pageRevealActive = false;
      state.panelIndex = delta > 0 ? 0 : Math.max(0, page.panels.length - 1);
      updateAfterNavigation();
      return true;
    }
    return moveToAdjacentPage(delta);
  }
  const nextPanel = state.panelIndex + delta;

  if (nextPanel >= 0 && nextPanel < page.panels.length) {
    state.panelIndex = nextPanel;
    state.fullPage = false;
    updateAfterNavigation();
    return true;
  }

  if (
    (delta > 0 && state.pageReveal === "after" && state.panelIndex === page.panels.length - 1)
    || (delta < 0 && state.pageReveal === "before" && state.panelIndex === 0)
  ) {
    state.pageRevealActive = true;
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
  commitPageCalibration(state.pages[fromPageIndex]);
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
          recordCurrentReadingStatsFinish();
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
    state.pageRevealActive = (
      (delta > 0 && state.pageReveal === "before")
      || (delta < 0 && state.pageReveal === "after")
    );
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
  updateReaderViewToggle();
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
  const continuousWebtoon = continuousWebtoonReading();
  el.panelStat.textContent = continuousWebtoon
    ? "Continuous scroll"
    : state.pageRevealActive ? `Full page reveal · ${state.pageReveal}`
    : state.fullPage ? "Full page"
    : page?.detectionStrategy === "full-page" ? "Full page fallback"
    : page?.detectionStrategy === "full-width" ? `Full width ${state.panelIndex + 1} / ${totalPanels}`
    : totalPanels ? `${unit} ${state.panelIndex + 1} / ${totalPanels}` : `${unit} 0`;
  if (!continuousWebtoon && page?.spread?.isSpread) el.panelStat.textContent += " · spread";
  const detectedPages = state.pages.filter((item) => item.detected).length;
  const detectedPanels = state.pages.reduce((sum, item) => sum + item.panels.length, 0);
  el.panelCount.textContent = `${detectedPanels} ${unit.toLowerCase()}s on ${detectedPages} pages`;
  if (el.nextPanel) {
    const label = continuousWebtoon
      ? "Scroll down through the webtoon"
      : state.pageRevealActive ? `Continue from the full-page reveal on page ${state.pageIndex + 1}`
      : state.fullPage ? `Next page. Current page ${state.pageIndex + 1} of ${totalPages}`
      : totalPanels
        ? `Next panel. Current panel ${state.panelIndex + 1} of ${totalPanels}`
        : "Next panel";
    el.nextPanel.setAttribute("aria-label", label);
    el.nextPanel.title = continuousWebtoon ? "Scroll down" : state.pageRevealActive ? "Continue reading" : state.fullPage ? "Next page" : "Next panel";
  }
  if (el.prevPanel) {
    const label = continuousWebtoon
      ? "Scroll up through the webtoon"
      : state.pageRevealActive ? `Go back from the full-page reveal on page ${state.pageIndex + 1}`
      : state.fullPage ? `Previous page. Current page ${state.pageIndex + 1} of ${totalPages}`
      : totalPanels
        ? `Previous panel. Current panel ${state.panelIndex + 1} of ${totalPanels}`
        : "Previous panel";
    el.prevPanel.setAttribute("aria-label", label);
    el.prevPanel.title = continuousWebtoon ? "Scroll up" : state.pageRevealActive ? "Go back" : state.fullPage ? "Previous page" : "Previous panel";
  }
  recordCurrentReadingSessionPage();
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
      button.classList.toggle("active", index === state.panelIndex && !state.fullPage && !state.pageRevealActive);
    });
    updateStats();
    return;
  }

  el.panelStrip.replaceChildren();
  el.panelStrip.dataset.signature = signature;
  state.performanceStats.panelStripRebuilds += 1;

  page.panels.forEach((panel, index) => {
    const button = document.createElement("button");
    button.className = `panel-thumb${index === state.panelIndex && !state.fullPage && !state.pageRevealActive ? " active" : ""}`;
    button.type = "button";
    button.dataset.panelIndex = String(index);
    button.title = `${panel.label || "Panel"}, page ${state.pageIndex + 1}`;
    button.style.aspectRatio = `${Math.max(0.25, panel.w)} / ${Math.max(0.25, panel.h)}`;
    button.addEventListener("click", () => {
      if (state.navigationPending) return;
      state.panelIndex = index;
      state.fullPage = false;
      state.pageRevealActive = false;
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
    state.pageRevealActive = state.pageReveal === "before";
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
  state.fullPage = state.panelMode === "webtoon";
  state.pageRevealActive = state.panelMode !== "webtoon" && state.pageReveal === "before";

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

function momentCaptureRect(page) {
  const panel = currentPanel() || fullPagePanel(page.naturalWidth, page.naturalHeight);
  return expandPanelRect(enhancedPanelRect(page, panel), Math.min(0.08, state.panelPadding / 100));
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
    reader.addEventListener("error", () => reject(reader.error || new Error("Could not encode moment image.")), { once: true });
    reader.readAsDataURL(blob);
  });
}

async function makeMomentCapture(page) {
  const rect = momentCaptureRect(page);
  const sourceWidth = Math.max(1, page.naturalWidth || page.image?.naturalWidth || page.image?.width || 1);
  const sourceHeight = Math.max(1, page.naturalHeight || page.image?.naturalHeight || page.image?.height || 1);
  const x = clamp(Math.floor(rect.x * sourceWidth), 0, sourceWidth - 1);
  const y = clamp(Math.floor(rect.y * sourceHeight), 0, sourceHeight - 1);
  const width = Math.max(1, Math.min(sourceWidth - x, Math.ceil(rect.w * sourceWidth)));
  const height = Math.max(1, Math.min(sourceHeight - y, Math.ceil(rect.h * sourceHeight)));
  const maxPixels = 24_000_000;
  const scale = Math.min(1, 6000 / width, 6000 / height, Math.sqrt(maxPixels / (width * height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (page.stripImages?.length) {
    const cropEnd = y + height;
    for (let index = 0; index < page.stripImages.length; index += 1) {
      const segment = page.stripImages[index];
      const intersectionStart = Math.max(y, segment.y);
      const intersectionEnd = Math.min(cropEnd, segment.y + segment.height);
      if (intersectionEnd <= intersectionStart) continue;
      const residentSource = page.sourceImages?.[index]?.image || null;
      const image = residentSource || await loadImage(segment.url);
      const naturalWidth = image.naturalWidth || segment.naturalWidth || sourceWidth;
      const naturalHeight = image.naturalHeight || segment.naturalHeight || segment.height;
      const sourceX = (x / sourceWidth) * naturalWidth;
      const sourceY = ((intersectionStart - segment.y) / segment.height) * naturalHeight;
      const sourceCropWidth = (width / sourceWidth) * naturalWidth;
      const sourceCropHeight = ((intersectionEnd - intersectionStart) / segment.height) * naturalHeight;
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceCropWidth,
        sourceCropHeight,
        0,
        (intersectionStart - y) * scale,
        canvas.width,
        (intersectionEnd - intersectionStart) * scale
      );
      if (!residentSource) releaseDecodedImage(image);
    }
  } else {
    const residentImage = page.image || null;
    const image = residentImage || await loadImage(page.url);
    context.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
    if (!residentImage) releaseDecodedImage(image);
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.94));
  if (!blob) throw new Error("This browser could not create the moment image.");
  return {
    imageDataUrl: await blobDataUrl(blob),
    width: canvas.width,
    height: canvas.height,
  };
}

async function saveCurrentMoment() {
  const page = state.pages[state.pageIndex];
  if (!page || !currentPanel()) {
    showToast("Open a detected panel before saving a moment.", "bad");
    return;
  }
  if (el.readerOptions?.open) el.readerOptions.open = false;
  setBusy(el.saveMoment, true, "Saving");
  try {
    const capture = await makeMomentCapture(page);
    const payload = await postLocalJson("/api/moments", {
      ...capture,
      title: state.currentManga?.title || "Saved moment",
      chapterTitle: el.chapterTitle?.textContent || "",
      sourceLabel: state.currentManga?.sourceLabel || activeChapterSourceLabel(),
      isNsfw: isNsfwLibraryItem(state.currentManga),
      mediaFormat: state.panelMode,
      pageIndex: currentSuwayomiPageIndex(),
      panelIndex: state.panelIndex,
    });
    state.moments = [payload.moment, ...state.moments.filter((moment) => moment.id !== payload.moment.id)];
    state.momentsLoaded = true;
    renderMoments();
    showToast("Moment saved in high resolution.", "good");
  } catch (error) {
    showToast(`Could not save this moment: ${friendlySourceErrorMessage(error)}`, "bad");
  } finally {
    setBusy(el.saveMoment, false);
  }
}

async function loadMoments() {
  if (!el.momentsGrid) return;
  try {
    const payload = await localJson("/api/moments");
    state.moments = Array.isArray(payload.moments) ? payload.moments : [];
    state.momentsLoaded = true;
    renderMoments();
  } catch (error) {
    if (!state.momentsLoaded) {
      el.momentsGrid.replaceChildren(createMomentsEmptyState("Moments could not be loaded", friendlySourceErrorMessage(error)));
    }
  }
}

function createMomentsEmptyState(title, copy) {
  const empty = document.createElement("div");
  empty.className = "app-empty-state moments-empty";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const note = document.createElement("p");
  note.textContent = copy;
  empty.append(heading, note);
  return empty;
}

function renderMoments() {
  if (!el.momentsGrid) return;
  const visibleMoments = state.showNsfwSources
    ? state.moments
    : state.moments.filter((moment) => !isNsfwLibraryItem(moment));
  if (el.momentsCount) el.momentsCount.textContent = `${visibleMoments.length} saved`;
  el.momentsGrid.replaceChildren();
  if (!visibleMoments.length) {
    renderMomentRediscovery([]);
    el.momentsGrid.append(createMomentsEmptyState(
      "No saved moments yet",
      "While reading, open the reader controls and choose “Save this moment.” Panels keeps a high-resolution crop here."
    ));
    return;
  }
  renderMomentRediscovery(visibleMoments);
  const fragment = document.createDocumentFragment();
  visibleMoments.forEach((moment) => {
    fragment.append(createMomentCard(moment));
  });
  el.momentsGrid.append(fragment);
}

function createMomentCard(moment, { featured = false } = {}) {
  const card = document.createElement("article");
  card.className = featured ? "moment-card moment-card-featured" : "moment-card";
  const imageLink = document.createElement("a");
  imageLink.className = "moment-image-link";
  imageLink.href = appUrl(moment.imageUrl);
  imageLink.target = "_blank";
  imageLink.rel = "noopener";
  imageLink.setAttribute("aria-label", `Open ${moment.title || "saved moment"} image`);
  const image = document.createElement("img");
  image.src = appUrl(moment.imageUrl);
  image.alt = `Saved panel from ${moment.title || "Untitled"}`;
  image.loading = featured ? "eager" : "lazy";
  image.decoding = "async";
  imageLink.append(image);
  const copy = document.createElement("div");
  copy.className = "moment-copy";
  const title = document.createElement("strong");
  title.textContent = moment.title || "Untitled";
  const chapter = document.createElement("span");
  chapter.textContent = moment.chapterTitle || `Page ${Number(moment.pageIndex || 0) + 1}`;
  const details = document.createElement("small");
  const savedAt = moment.createdAt ? new Date(moment.createdAt).toLocaleDateString() : "Saved";
  details.textContent = `${savedAt} · ${moment.width || 0}×${moment.height || 0} · ${formatStorageBytes(moment.byteSize, "Image")}`;
  const actions = document.createElement("div");
  actions.className = "moment-actions";
  const download = document.createElement("a");
  download.className = "text-button moment-download";
  download.href = appUrl(moment.imageUrl);
  download.download = `${String(moment.title || "panels-moment").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "panels-moment"}.jpg`;
  download.textContent = "Download";
  const remove = document.createElement("button");
  remove.className = "text-button danger-button";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => { void removeMoment(moment, remove); });
  actions.append(download, remove);
  copy.append(title, chapter, details, actions);
  card.append(imageLink, copy);
  return card;
}

function renderMomentRediscovery(visibleMoments, { advance = false } = {}) {
  if (!el.momentRediscovery || !el.momentRediscoveryCard) return;
  if (!visibleMoments.length) {
    state.momentRediscoveryMomentId = "";
    el.momentRediscovery.hidden = true;
    el.momentRediscoveryCard.replaceChildren();
    return;
  }
  let moment = !advance
    ? visibleMoments.find((candidate) => candidate.id === state.momentRediscoveryMomentId)
    : null;
  if (!moment) {
    const selection = chooseMomentForRediscovery(visibleMoments, {
      state: state.momentRediscoveryState,
    });
    moment = selection?.moment || null;
    if (selection && state.activeView === "moments") {
      state.momentRediscoveryState = selection.nextState;
      persistMomentRediscoveryState();
    }
  }
  if (!moment) {
    el.momentRediscovery.hidden = true;
    return;
  }
  state.momentRediscoveryMomentId = moment.id;
  el.momentRediscovery.hidden = false;
  el.momentRediscoveryCard.replaceChildren(createMomentCard(moment, { featured: true }));
  if (el.momentRediscoveryNext) el.momentRediscoveryNext.disabled = visibleMoments.length < 2;
}

function showAnotherMoment() {
  const visibleMoments = state.showNsfwSources
    ? state.moments
    : state.moments.filter((moment) => !isNsfwLibraryItem(moment));
  state.momentRediscoveryMomentId = "";
  renderMomentRediscovery(visibleMoments, { advance: true });
}

async function removeMoment(moment, button) {
  if (!window.confirm(`Remove this moment from ${moment.title || "this title"}?`)) return;
  setBusy(button, true, "Removing");
  try {
    await deleteLocalJson(`/api/moments/${encodeURIComponent(moment.id)}`);
    state.moments = state.moments.filter((candidate) => candidate.id !== moment.id);
    renderMoments();
    showToast("Moment removed.");
  } catch (error) {
    setBusy(button, false);
    showToast(`Could not remove this moment: ${friendlySourceErrorMessage(error)}`, "bad");
  }
}

async function reportBadPanels() {
  const page = state.pages[state.pageIndex];
  if (!page) {
    setConnection(state.connected, "Load a page before reporting bad panels.", "bad");
    return;
  }
  page.calibrationReportedBad = true;

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
      bubbles: page.bubbles || [],
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
  await state.readingStatsTracker?.checkpoint().catch(() => null);
  await flushReadingStats({ celebrate: false }).catch(() => null);
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

function updateReaderViewToggle() {
  syncReaderPresentationClasses();
  if (!el.toggleFit) return;
  const webtoon = state.panelMode === "webtoon";
  el.toggleFit.textContent = webtoon
    ? state.fullPage ? "Guided taps" : "Continuous scroll"
    : state.fullPage ? "Panel view" : "Full page";
  el.toggleFit.setAttribute("aria-pressed", state.fullPage ? "true" : "false");
  el.toggleFit.title = webtoon
    ? state.fullPage ? "Switch to tap-through webtoon panels" : "Switch to continuous webtoon scrolling"
    : state.fullPage ? "Switch to panel-by-panel reading" : "Switch to full-page reading";
}

function syncReaderPresentationClasses() {
  const readerActive = state.activeView === "reader";
  const webtoonScroll = readerActive && state.panelMode === "webtoon" && state.fullPage;
  document.body.classList.toggle("webtoon-scroll", webtoonScroll);
  document.body.classList.toggle("reader-full-page", readerActive && state.fullPage && !webtoonScroll);
  document.body.classList.toggle("reader-page-reveal", readerActive && state.pageRevealActive);
}

function scrollContinuousWebtoonToPanel(index = state.panelIndex, behavior = "auto") {
  if (!continuousWebtoonReading()) return false;
  const page = state.pages[0];
  const panel = page?.panels?.[clamp(Number(index) || 0, 0, Math.max(0, (page?.panels?.length || 1) - 1))];
  if (!panel || !layoutContinuousWebtoon(page)) return false;
  const scale = (parseFloat(ensureStageStrip().style.width) || page.naturalWidth) / Math.max(1, page.naturalWidth);
  const panelCenter = (panel.y + panel.h / 2) * page.naturalHeight * scale;
  const top = clamp(
    panelCenter - el.stageImageWrap.clientHeight / 2,
    0,
    Math.max(0, el.stageImageWrap.scrollHeight - el.stageImageWrap.clientHeight)
  );
  el.stageImageWrap.scrollTo({ top, behavior });
  return true;
}

function scrollContinuousWebtoon(delta) {
  if (!continuousWebtoonReading()) return false;
  state.webtoonScrollIntent = true;
  const direction = Number(delta) >= 0 ? 1 : -1;
  const atEnd = el.stageImageWrap.scrollTop + el.stageImageWrap.clientHeight >= el.stageImageWrap.scrollHeight - 2;
  if (direction > 0 && atEnd) return moveToAdjacentPage(1);
  el.stageImageWrap.scrollBy({
    top: direction * el.stageImageWrap.clientHeight * 0.86,
    behavior: state.readerMotion === "instant" ? "auto" : "smooth",
  });
  return true;
}

function clearWebtoonAutoAdvance() {
  window.clearTimeout(state.webtoonAutoAdvanceTimer);
  state.webtoonAutoAdvanceTimer = 0;
}

function markWebtoonScrollIntent() {
  if (continuousWebtoonReading()) state.webtoonScrollIntent = true;
}

function scheduleWebtoonAutoAdvance(page) {
  const atEnd = el.stageImageWrap.scrollTop + el.stageImageWrap.clientHeight >= el.stageImageWrap.scrollHeight - 2;
  if (!atEnd || !page?.complete || !state.webtoonScrollIntent || state.navigationPending) {
    if (!atEnd) clearWebtoonAutoAdvance();
    return;
  }
  if (state.webtoonAutoAdvanceTimer) return;
  const generation = state.prepareGeneration;
  const chapterId = state.activeChapter?.chapterId;
  state.webtoonAutoAdvanceTimer = window.setTimeout(() => {
    state.webtoonAutoAdvanceTimer = 0;
    const activePage = state.pages[0];
    const stillAtEnd = el.stageImageWrap.scrollTop + el.stageImageWrap.clientHeight >= el.stageImageWrap.scrollHeight - 2;
    if (
      generation !== state.prepareGeneration ||
      chapterId !== state.activeChapter?.chapterId ||
      !continuousWebtoonReading() ||
      !activePage?.complete ||
      !stillAtEnd ||
      state.navigationPending
    ) return;
    state.webtoonScrollIntent = false;
    void moveToAdjacentPage(1);
  }, 420);
}

function handleWebtoonScroll() {
  if (!continuousWebtoonReading() || state.webtoonScrollFrame) return;
  state.webtoonScrollFrame = requestAnimationFrame(() => {
    state.webtoonScrollFrame = 0;
    const page = state.pages[0];
    if (!page?.stripImages?.length || !continuousWebtoonReading()) return;
    const strip = ensureStageStrip();
    const scale = (parseFloat(strip.style.width) || page.naturalWidth) / Math.max(1, page.naturalWidth);
    const centerY = (el.stageImageWrap.scrollTop + el.stageImageWrap.clientHeight / 2) / Math.max(0.0001, scale);
    const nextPanelIndex = nearestPanelIndexByY(page, centerY);
    const panelChanged = nextPanelIndex !== state.panelIndex;
    state.panelIndex = nextPanelIndex;
    renderStripPage(page, { refit: false, contentExtended: true });
    scheduleWebtoonAutoAdvance(page);
    if (panelChanged) {
      updateStats();
      scheduleReadingProgressPersistence();
    }
  });
}

function readerFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function requestReaderFullscreen() {
  const request = el.readerView?.requestFullscreen || el.readerView?.webkitRequestFullscreen;
  if (!request || readerFullscreenElement()) return;
  state.readerFullscreenOwned = true;
  try {
    Promise.resolve(request.call(el.readerView)).then(() => {
      state.readerFullscreenOwned = readerFullscreenElement() === el.readerView;
      scheduleViewportFit();
    }).catch(() => {
      state.readerFullscreenOwned = false;
    });
  } catch {
    state.readerFullscreenOwned = false;
  }
}

function exitReaderFullscreen() {
  if (!state.readerFullscreenOwned) return;
  state.readerFullscreenOwned = false;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit || !readerFullscreenElement()) return;
  try {
    Promise.resolve(exit.call(document)).catch(() => {});
  } catch {
    // The system may already be completing its own fullscreen exit gesture.
  }
}

function handleReaderFullscreenChange() {
  state.readerFullscreenOwned = readerFullscreenElement() === el.readerView;
  scheduleViewportFit();
}

function toggleFullPage() {
  if (!state.pages.length) return;
  const webtoon = state.panelMode === "webtoon";
  const selectedPanel = state.panelIndex;
  state.fullPage = !state.fullPage;
  state.pageRevealActive = false;
  if (el.readerOptions?.open) el.readerOptions.open = false;
  if (webtoon) {
    exitReaderFullscreen();
    updateAfterNavigation();
    if (state.fullPage) requestAnimationFrame(() => scrollContinuousWebtoonToPanel(selectedPanel));
    return;
  }
  if (state.fullPage) {
    setReaderChromeVisible(false, { refit: false });
    requestReaderFullscreen();
  } else {
    exitReaderFullscreen();
  }
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
    const librarySynced = await syncSuwayomiLibrary().then(() => true).catch(() => false);
    await hydrateLibraryCovers();
    const progressSynced = await flushSuwayomiProgressOutbox().catch(() => false);
    if (librarySynced && progressSynced) {
      setSyncStatus("Synced", "Reading progress is reconciled with Suwayomi and ready on your other devices.", "good");
    } else if (!librarySynced) {
      setSyncStatus("Sync failed", "Connected, but reading progress could not be checked yet.", "bad");
    }
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
    let librarySynced = true;
    if (!wasConnected || !state.sources.length) {
      await loadSources();
      librarySynced = await syncSuwayomiLibrary().then(() => true).catch(() => false);
    }
    if (state.activeChapter?.type === "suwayomi" && state.activeChapter.deviceLocal && state.currentManga?.id) {
      await fetchChapters({
        background: true,
        liveOnly: true,
        serverUrl: state.activeChapter.serverUrl || currentDeviceServerUrl(),
      }).catch(() => {});
    }
    const progressSynced = await flushSuwayomiProgressOutbox().catch(() => false);
    if (librarySynced && progressSynced) {
      setSyncStatus("Synced", "Reading progress is reconciled with Suwayomi and ready on your other devices.", "good");
    }
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
  if (performance.now() < state.suppressReaderTapUntil || state.readerOverview || state.readerPinch) return;
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
  ensureSourceQualityButton();
  el.appNavButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setDownloadStatusSheet(false);
      const targetView = button.dataset.targetView;
      if (targetView === "reader") {
        openReaderFromNav(button);
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
  el.downloadStatusButton?.addEventListener("click", (event) => setDownloadStatusSheet(!state.downloadStatusSheetOpen, event.currentTarget));
  el.downloadStatusBackdrop?.addEventListener("click", () => setDownloadStatusSheet(false));
  el.downloadStatusClose?.addEventListener("click", () => setDownloadStatusSheet(false));
  el.downloadStatFailedFilter?.addEventListener("click", () => setDownloadStatusFilter("failed"));
  el.downloadStatusRetry?.addEventListener("click", retryFailedDownloads);
  el.serverBufferRetentionPreview?.addEventListener("click", () => { void previewServerBufferRetention(); });
  el.serverBufferRetentionApply?.addEventListener("click", () => { void applyServerBufferRetention(); });
  el.serverBufferRetentionDays?.addEventListener("change", () => {
    state.serverBufferRetentionPreview = null;
    if (el.serverBufferRetentionApply) el.serverBufferRetentionApply.hidden = true;
    if (el.serverBufferRetentionResult) el.serverBufferRetentionResult.textContent = "Preview the updated policy before removing anything.";
  });
  el.serverBufferRetentionKeep?.addEventListener("change", () => {
    state.serverBufferRetentionPreview = null;
    if (el.serverBufferRetentionApply) el.serverBufferRetentionApply.hidden = true;
    if (el.serverBufferRetentionResult) el.serverBufferRetentionResult.textContent = "Preview the updated policy before removing anything.";
  });
  window.addEventListener("keydown", (event) => {
    if (!state.downloadStatusSheetOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setDownloadStatusSheet(false);
      return;
    }
    trapReaderModalFocus(event, el.downloadStatusSheet);
  });
  el.readerBack?.addEventListener("click", leaveReaderView);
  el.readerLoadingCancel?.addEventListener("click", cancelReaderLoading);
  el.readerErrorRetry?.addEventListener("click", retryReaderError);
  el.readerErrorBack?.addEventListener("click", leaveReaderView);
  el.readerErrorSource?.addEventListener("click", beginSourceMigration);
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
  el.statsEnable?.addEventListener("click", () => { void updateReadingStatsSettings({ enabled: true }); });
  el.statsRangeSelect?.addEventListener("change", (event) => {
    state.readingStatsRange = event.target.value;
    void refreshReadingStats();
  });
  el.statsEnabled?.addEventListener("change", (event) => { void updateReadingStatsSettings({ enabled: event.target.checked }); });
  el.statsShowSummary?.addEventListener("change", (event) => { void updateReadingStatsSettings({ showStats: event.target.checked }); });
  el.statsShowRhythm?.addEventListener("change", (event) => { void updateReadingStatsSettings({ showRhythm: event.target.checked }); });
  el.statsCelebrations?.addEventListener("change", (event) => { void updateReadingStatsSettings({ celebrations: event.target.checked }); });
  el.statsExport?.addEventListener("click", () => { void exportReadingStats(); });
  el.statsReset?.addEventListener("click", () => {
    if (el.statsResetConfirmation) {
      el.statsResetConfirmation.value = "";
      el.statsResetConfirmation.setCustomValidity("");
    }
    el.statsResetDialog?.showModal();
  });
  el.statsResetConfirmation?.addEventListener("input", () => el.statsResetConfirmation.setCustomValidity(""));
  el.statsResetConfirm?.addEventListener("click", () => { void resetReadingStats(); });
  el.installApp?.addEventListener("click", () => { void promptAppInstall(); });
  el.checkAppUpdate?.addEventListener("click", () => { void checkForAppUpdate(); });
  el.applyAppUpdate?.addEventListener("click", () => { void activateAppUpdate(); });
  el.deviceStorageRefresh?.addEventListener("click", () => { void refreshDeviceStorageFromControl(); });
  el.deviceStoragePersist?.addEventListener("click", () => { void protectDeviceStorage(); });
  el.deviceStorageFilters.forEach((button) => button.addEventListener("click", () => setDeviceStorageFilter(button.dataset.deviceStorageFilter)));
  el.deviceStorageRetryIncomplete?.addEventListener("click", () => { void retryIncompleteDeviceStorage(); });
  el.deviceStorageClearIncomplete?.addEventListener("click", (event) => clearIncompleteDeviceStorage(event.currentTarget));
  el.sourceIntelligenceFilters.forEach((button) => button.addEventListener("click", () => setSourceIntelligenceFormat(button.dataset.sourceIntelligenceFormat)));
  el.refreshSourceIntelligence?.addEventListener("click", () => { void refreshSourceIntelligence({ announce: true }); });
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
  el.refreshComicRecommendations?.addEventListener("click", () => loadComicRecommendations({ announce: true, force: true }));
  el.saveComicRecommendationsConfig?.addEventListener("click", () => { void saveComicRecommendationsConfig(); });
  el.disconnectComicRecommendations?.addEventListener("click", () => { void disconnectComicRecommendations(); });
  el.clearRecommendationContext?.addEventListener("click", clearRecommendationContext);
  el.saveMangabaka?.addEventListener("click", connectMangaBaka);
  el.disconnectMangabaka?.addEventListener("click", disconnectMangaBaka);
  el.retryDownloads?.addEventListener("click", retryFailedDownloads);
  el.showNsfwSources?.addEventListener("change", (event) => setShowNsfwSources(event.target.checked));
  el.toggleSuwayomiPanel?.addEventListener("click", toggleSuwayomiSetupPanel);
  el.toggleLibraryPanel?.addEventListener("click", toggleLibraryPanel);
  el.toggleHiddenLibrary?.addEventListener("click", () => setShowHiddenLibrary(!state.showHiddenLibrary));
  el.libraryFilters.forEach((button) => button.addEventListener("click", () => setLibraryFilter(button.dataset.libraryFilter)));
  el.libraryFormatFilters.forEach((button) => button.addEventListener("click", () => setLibraryFormatFilter(button.dataset.libraryFormatFilter)));
  el.libraryList?.addEventListener("focusout", flushDeferredLibraryRender);
  el.libraryList?.addEventListener("toggle", flushDeferredLibraryRender, true);
  el.toggleBrowsePanel?.addEventListener("click", toggleBrowsePanel);
  el.closeMangaDetail?.addEventListener("click", closeMangaDetail);
  el.detailPrimary?.addEventListener("click", (event) => { void startOrContinueCurrentManga(event.currentTarget); });
  el.detailLibrary?.addEventListener("click", () => {
    if (state.sourceMigration) void migrateCurrentMangaSource();
    else void addCurrentMangaToLibrary();
  });
  el.detailChangeSource?.addEventListener("click", beginSourceMigration);
  el.detailCompareSource?.addEventListener("click", (event) => { void openSourceQualityComparison(event.currentTarget); });
  el.detailLibraryStatus?.addEventListener("change", (event) => {
    const item = currentMangaLibraryItem();
    if (!item) {
      updateMangaDetailActions();
      showToast("Add this title to the library before choosing a group.", "bad");
      return;
    }
    setLibraryItemStatus(item, event.target.value);
    updateMangaDetailActions();
  });
  el.browseOpenSettings?.addEventListener("click", () => {
    openSuwayomiSetup();
  });
  el.browseBooks?.addEventListener("click", () => navigateBookRoute("books-search"));
  el.serverUrl?.addEventListener("input", () => {
    updateSuwayomiLink();
    updateSuwayomiSetupState();
  });
  el.searchSource.addEventListener("click", searchSource);
  el.searchQuery?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.repeat) {
      event.preventDefault();
      void searchSource();
    }
  });
  el.fetchChapters.addEventListener("click", fetchChapters);
  el.scanlatorSelect?.addEventListener("change", (event) => {
    state.scanlatorFilter = event.target.value;
    saveSettings();
    renderChapters();
  });
  el.loadChapterPages.addEventListener("click", (event) => {
    void loadChapterPages({ returnFocusTarget: event.currentTarget });
  });
  el.loadDemo.addEventListener("click", loadDemo);
  el.loadComickChapters?.addEventListener("click", loadComickChapters);
  el.loadComickLatest?.addEventListener("click", loadComickLatest);
  el.loadComickNumber?.addEventListener("click", loadComickNumber);
  el.loadComickMore?.addEventListener("click", loadComickMore);
  el.prevPanel.addEventListener("click", () => movePanel(-1));
  el.nextPanel.addEventListener("click", () => movePanel(1));
  el.keepScreenAwake?.addEventListener("change", (event) => setKeepScreenAwake(event.target.checked));
  el.panelPadding.addEventListener("input", (event) => setPanelPadding(event.target.value));
  el.bubbleAwareFraming?.addEventListener("change", (event) => setBubbleAwareFraming(event.target.checked));
  el.bubbleAwareFramingReader?.addEventListener("change", (event) => setBubbleAwareFraming(event.target.checked));
  el.highZoomClarity?.addEventListener("change", (event) => setHighZoomClarity(event.target.value));
  el.highZoomClarityReader?.addEventListener("change", (event) => setHighZoomClarity(event.target.value));
  el.highZoomEnhancement?.addEventListener("change", (event) => setHighZoomEnhancement(event.target.checked));
  el.highZoomEnhancementReader?.addEventListener("change", (event) => setHighZoomEnhancement(event.target.checked));
  el.pageReveal?.addEventListener("change", (event) => setPageReveal(event.target.value));
  el.pageRevealReader?.addEventListener("change", (event) => setPageReveal(event.target.value));
  el.cinematicMotion?.addEventListener("change", (event) => setCinematicMotion(event.target.checked));
  el.cinematicMotionReader?.addEventListener("change", (event) => setCinematicMotion(event.target.checked));
  el.toggleFit.addEventListener("click", toggleFullPage);
  el.hideReaderControls?.addEventListener("click", hideReaderControls);
  el.toggleReaderMode?.addEventListener("click", toggleReaderFocus);
  el.redetect.addEventListener("click", redetectCurrentPage);
  el.saveMoment?.addEventListener("click", () => { void saveCurrentMoment(); });
  el.momentRediscoveryNext?.addEventListener("click", showAnotherMoment);
  el.finishReadingSession?.addEventListener("click", finishReadingSession);
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
  window.addEventListener("online", () => {
    void reconnectPanelPilot();
    if (state.readingStatsSettings?.enabled) {
      void flushReadingStats().then(() => refreshReadingStats({ flush: false }));
    }
  });
  window.addEventListener("offline", handleBrowserOffline);
  document.addEventListener("visibilitychange", () => {
    handleReaderVisibilityChange();
    syncReadingSessionActivity();
    if (document.hidden) return;
    if (state.activeView === "settings") void refreshDeviceStorage();
    if (!navigator.onLine) {
      handleBrowserOffline();
      return;
    }
    if (state.connected) {
      void reconcileSuwayomiOnForeground().catch(() => false);
      void refreshDownloadStatus().catch(() => null);
      void flushMangaBakaOutbox().catch(() => false);
    } else {
      void recoverSuwayomiConnection();
    }
  });
  document.addEventListener("fullscreenchange", handleReaderFullscreenChange);
  document.addEventListener("webkitfullscreenchange", handleReaderFullscreenChange);
  window.addEventListener("pagehide", () => {
    pauseReaderLifecycle({ pageHiding: true });
    void state.readingStatsTracker?.checkpoint().then(() => flushReadingStats({ celebrate: false }));
  });
  window.addEventListener("pageshow", (event) => {
    state.readerLifecyclePaused = false;
    void resumeReaderLifecycle();
    if (event.persisted && navigator.onLine && state.connected) {
      void reconcileSuwayomiOnForeground().catch(() => false);
    }
  });

  el.stage.addEventListener("click", handleStageTap);
  el.stage.addEventListener("pointerdown", handleReaderPointerDown, { passive: true });
  el.stage.addEventListener("pointermove", handleReaderPointerMove, { passive: true });
  el.stage.addEventListener("pointerup", handleReaderPointerEnd, { passive: true });
  el.stage.addEventListener("pointercancel", handleReaderPointerEnd, { passive: true });
  el.stage.addEventListener("touchstart", handleReaderTouchStart, { passive: false });
  el.stage.addEventListener("touchmove", handleReaderTouchMove, { passive: false });
  el.stage.addEventListener("touchend", handleReaderTouchEnd, { passive: false });
  el.stage.addEventListener("touchcancel", handleReaderTouchEnd, { passive: false });
  el.stageImageWrap?.addEventListener("scroll", handleWebtoonScroll, { passive: true });
  el.stageImageWrap?.addEventListener("pointerdown", markWebtoonScrollIntent, { passive: true });
  el.stageImageWrap?.addEventListener("touchstart", markWebtoonScrollIntent, { passive: true });
  el.stageImageWrap?.addEventListener("wheel", markWebtoonScrollIntent, { passive: true });

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
      const focusable = [...el.readerOptions.querySelectorAll(".reader-options-sheet input, .reader-options-sheet select, .reader-options-sheet button")]
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
  bubbleAwarePanelRect,
  bubblePanelIndex,
  cinematicTransitionForCameras,
  clarityAwarePanelRect,
  consolidateMangaPanels,
  detectComicPanels,
  detectComicPanelsWithModel,
  detectPanels,
  detectPanelsForMode,
  fullPagePanel,
  choosePanelDetectionFallback,
  classifyPageSpread,
  orderSpreadPanels,
  makeFullWidthFallbackPanels,
  inferredMediaFormat,
  loadImage,
  mangaBakaEligibleLibraryItem,
  readerTapAction,
  retainUnacknowledgedMangaBakaEntries,
  sanitizeMangaBakaOutbox,
  sortPanels,
  getReaderLifecycleDiagnostics,
  getReaderInteractionDiagnostics: () => ({
    overviewActive: Boolean(state.readerOverview),
    overviewKind: state.readerOverview?.kind || null,
    pageReveal: state.pageReveal,
    pageRevealActive: state.pageRevealActive,
    cinematicMotion: state.cinematicMotion,
    highZoomClarity: state.highZoomClarity,
    highZoomEnhancement: state.highZoomEnhancement,
    highZoomEnhancementStatus: el.stageEnhancement?.dataset?.status || "idle",
    highZoomEnhancementOutput: el.stageEnhancement?.dataset?.outputSize || "",
    camera: state.readerCamera ? {
      pageIndex: state.readerCamera.pageIndex,
      panelIndex: state.readerCamera.panelIndex,
      scale: state.readerCamera.scale,
      left: state.readerCamera.left,
      top: state.readerCamera.top,
    } : null,
    cinematicPan: readerCameraElement()?.dataset?.cinematicPan || "",
    cinematicDuration: Number(readerCameraElement()?.dataset?.cinematicDuration || 0),
    cameraSettled: readerCameraElement()?.dataset?.cameraSettled === "true",
    clarityApplied: readerCameraElement()?.dataset?.clarityApplied === "true",
    clarityExpansion: Number(readerCameraElement()?.dataset?.clarityExpansion || 1),
    clarityDeviceScale: Number(readerCameraElement()?.dataset?.clarityDeviceScale || 0),
  }),
  handleReaderVisibilityChange,
  pauseReaderLifecycle,
  resumeReaderLifecycle,
  readingStats: readingStatsClient,
  isPrivateSourceItem: isNsfwLibraryItem,
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
  restorePrivateReaderModels();
  restoreLocalReadingSession();
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
  state.sourceProfilesPromise = loadSourceProfiles();
  wireEvents();
  void initializeBooksFeature();
  startBackgroundHealthChecks();
  setActiveView(state.activeView, { history: false });
  void initializeReadingStats();
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
    void refreshComicRecommendationsConfig();
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
