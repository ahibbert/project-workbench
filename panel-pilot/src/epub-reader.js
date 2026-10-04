import ePub from "epubjs";

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

export function textMatchOffsets(text, query, limit = 4) {
  const haystack = String(text || "");
  const needle = String(query || "").trim();
  if (needle.length < 2 || !haystack) return [];
  const lower = haystack.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  const matches = [];
  let offset = 0;
  while (matches.length < Math.max(1, limit)) {
    const index = lower.indexOf(target, offset);
    if (index < 0) break;
    matches.push({ index, length: needle.length });
    offset = index + Math.max(1, needle.length);
  }
  return matches;
}

export function renderEpubToc(entries, parent, onSelect, depth = 0) {
  if (!entries?.length) return;
  const list = node("ol", depth ? "epub-toc-children" : "epub-toc-root");
  for (const entry of entries) {
    const item = node("li", "epub-toc-item");
    const link = node("button", "epub-toc-link", entry.label?.trim() || "Untitled section");
    link.type = "button";
    link.addEventListener("click", () => onSelect(entry.href));
    item.append(link);
    renderEpubToc(entry.subitems || entry.children, item, onSelect, depth + 1);
    list.append(item);
  }
  parent.append(list);
}

async function fetchEpubResponse(epubUrl) {
  let response = null;
  let failure = null;
  try {
    response = await fetch(epubUrl, { headers: { Accept: "application/epub+zip" }, cache: "default" });
    if (response.ok) return response;
  } catch (error) {
    failure = error;
  }
  if ("caches" in window) {
    try {
      const cached = await caches.match(epubUrl);
      if (cached) return cached;
    } catch {
      // Continue to the normalized network error below.
    }
  }
  if (response) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `EPUB could not be loaded (${response.status})`);
  }
  throw failure || new Error("EPUB could not be loaded while offline.");
}

function publicNavigationEntries(entries = []) {
  return entries.map((entry) => ({
    label: String(entry?.label || "").trim() || "Untitled section",
    href: String(entry?.href || ""),
    subitems: publicNavigationEntries(entry?.subitems || entry?.children || []),
  })).filter((entry) => entry.href || entry.subitems.length);
}

export async function loadEpubNavigation(epubUrl) {
  const response = await fetchEpubResponse(epubUrl);
  const publication = ePub(await response.arrayBuffer());
  try {
    const navigation = await publication.loaded.navigation;
    return publicNavigationEntries(navigation?.toc || []);
  } finally {
    publication.destroy();
  }
}

function safeProgression(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

function humanReadingTime(minutes) {
  if (!Number.isFinite(minutes) || minutes < 1) return "Less than a minute left";
  if (minutes < 60) return `About ${Math.max(1, Math.round(minutes))} min left`;
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return `About ${hours} hr${hours === 1 ? "" : "s"}${remainder ? ` ${remainder} min` : ""} left`;
}

function sanitizeRenderedDocument(document) {
  document.querySelectorAll("script, iframe, object, embed, form, base").forEach((item) => item.remove());
  document.querySelectorAll("*").forEach((item) => {
    for (const attribute of [...item.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on") || value.startsWith("javascript:")) item.removeAttribute(attribute.name);
      if (name === "href" && item.matches?.("a") && (/^(?:https?:)?\/\//i.test(value) || value.startsWith("mailto:"))) {
        item.dataset.externalHref = attribute.value.trim();
        item.setAttribute("role", "link");
        item.setAttribute("tabindex", "0");
        item.removeAttribute(attribute.name);
      } else if (["src", "href", "poster", "action", "formaction"].includes(name) && /^(?:https?:)?\/\//i.test(value)) {
        item.removeAttribute(attribute.name);
      }
    }
  });
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Book request failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function createEpubReader({ root, book, progress, preferences, preferenceScope = {}, initialHref = "", accountId = "", onExit }) {
  let rendition = null;
  let publication = null;
  let currentProgress = progress;
  let pendingPosition = null;
  let saveTimer = 0;
  let resizeTimer = 0;
  let controlsTimer = 0;
  let destroyed = false;
  let locationsReady = false;
  let wakeLock = null;
  let gestureStart = null;
  let preferenceRequest = 0;
  let noticeTimer = 0;
  let selectionTimer = 0;
  let renditionFlow = "";
  let currentSectionProgress = null;
  let selectionSnapshot = null;
  let bookMoments = [];
  const renderedMomentLocators = new Set();
  const emergencyPositionKey = `panel-pilot:book-position:${accountId ? `${accountId}:` : ""}${book.id}`;

  function readEmergencyPosition() {
    try {
      const cached = JSON.parse(localStorage.getItem(emergencyPositionKey) || "null");
      if (!cached?.locator?.startsWith("epubcfi(") || Number(cached.baseRevision || 0) !== Number(progress?.revision || 0)) {
        localStorage.removeItem(emergencyPositionKey);
        return null;
      }
      const serverUpdated = Date.parse(progress?.updatedAt || "") || 0;
      if (Number(cached.savedAt || 0) > serverUpdated) return cached;
      localStorage.removeItem(emergencyPositionKey);
      return null;
    } catch {
      return null;
    }
  }

  function cacheEmergencyPosition(position = pendingPosition) {
    if (!position?.cfi?.startsWith("epubcfi(")) return;
    try {
      localStorage.setItem(emergencyPositionKey, JSON.stringify({
        locator: position.cfi,
        resourceHref: position.href || "",
        progression: safeProgression(position.progression),
        baseRevision: Number(currentProgress?.revision || 0),
        savedAt: Date.now(),
      }));
    } catch {
      // Storage can be unavailable in private browsing; the keepalive save remains canonical.
    }
  }

  function clearEmergencyPosition(cfi) {
    try {
      const cached = JSON.parse(localStorage.getItem(emergencyPositionKey) || "null");
      if (!cached || cached.locator === cfi) localStorage.removeItem(emergencyPositionKey);
    } catch {
      try { localStorage.removeItem(emergencyPositionKey); } catch { /* Ignore unavailable storage. */ }
    }
  }

  const emergencyPosition = readEmergencyPosition();

  root.replaceChildren();
  const reader = node("section", "epub-reader");
  reader.dataset.theme = preferences.theme;
  reader.dataset.flow = preferences.readingFlow;
  const toolbar = node("header", "epub-toolbar");
  const back = node("button", "epub-tool epub-back", "‹ Book details");
  back.type = "button";
  const titleGroup = node("div", "epub-title-group");
  const title = node("strong", "epub-reader-title", book.title);
  const chapterTitle = node("span", "epub-chapter-title", "Opening book…");
  titleGroup.append(title, chapterTitle);
  const tocButton = node("button", "epub-tool", "Contents");
  tocButton.type = "button";
  const fullscreenButton = node("button", "epub-tool epub-fullscreen", "⛶");
  fullscreenButton.type = "button";
  fullscreenButton.setAttribute("aria-label", "Toggle full screen");
  const settings = node("details", "epub-settings");
  const settingsSummary = node("summary", "epub-tool", "Aa");
  settingsSummary.setAttribute("aria-label", "Reading appearance");
  const settingsPanel = node("div", "epub-settings-panel");
  settings.append(settingsSummary, settingsPanel);
  toolbar.append(back, titleGroup, tocButton, fullscreenButton, settings);

  const stage = node("div", "epub-stage");
  stage.style.setProperty("--book-content-width", `${preferences.contentWidth}px`);
  const loading = node("div", "epub-reader-state", "Opening EPUB…");
  loading.setAttribute("role", "status");
  const viewport = node("div", "epub-viewport");
  const previous = node("button", "epub-page-control epub-previous");
  previous.type = "button";
  previous.setAttribute("aria-label", "Previous page");
  const next = node("button", "epub-page-control epub-next");
  next.type = "button";
  next.setAttribute("aria-label", "Next page");
  stage.append(viewport, loading, previous, next);

  const footer = node("footer", "epub-footer");
  const progressCopy = node("div", "epub-progress-copy");
  const location = node("strong", "epub-progress-location", progress?.progression != null ? `${Math.round(progress.progression * 100)}%` : "Locating…");
  const timeRemaining = node("span", "epub-time-remaining", "Generating book locations…");
  progressCopy.append(location, timeRemaining);
  const scrubber = document.createElement("input");
  scrubber.className = "epub-progress-slider";
  scrubber.type = "range";
  scrubber.min = "0";
  scrubber.max = "1000";
  scrubber.step = "1";
  scrubber.value = String(Math.round((progress?.progression || 0) * 1000));
  scrubber.disabled = true;
  scrubber.setAttribute("aria-label", "Book progress");
  footer.append(progressCopy, scrubber);

  const toc = node("dialog", "epub-toc");
  const tocHeader = node("header");
  tocHeader.append(node("strong", "", "Book menu"));
  const tocClose = node("button", "epub-tool", "Close");
  tocClose.type = "button";
  tocHeader.append(tocClose);
  const tocTabs = node("div", "epub-menu-tabs");
  const contentsTab = node("button", "epub-menu-tab active", "Contents");
  const searchTab = node("button", "epub-menu-tab", "Search");
  const highlightsTab = node("button", "epub-menu-tab", "Highlights");
  [contentsTab, searchTab, highlightsTab].forEach((button) => { button.type = "button"; });
  tocTabs.append(contentsTab, searchTab, highlightsTab);
  const tocList = node("nav", "epub-toc-list epub-menu-panel");
  tocList.setAttribute("aria-label", "Book contents");
  const searchPanel = node("section", "epub-search-panel epub-menu-panel");
  searchPanel.hidden = true;
  const searchForm = node("form", "epub-search-form");
  const searchInput = node("input", "epub-search-input");
  searchInput.type = "search";
  searchInput.placeholder = "Search this book";
  searchInput.setAttribute("aria-label", "Search this book");
  const searchButton = node("button", "primary-button", "Search");
  searchButton.type = "submit";
  searchForm.append(searchInput, searchButton);
  const searchStatus = node("p", "epub-search-status", "Search the complete EPUB text.");
  searchStatus.setAttribute("role", "status");
  const searchResults = node("div", "epub-search-results");
  searchPanel.append(searchForm, searchStatus, searchResults);
  const highlightsPanel = node("section", "epub-highlights-panel epub-menu-panel");
  highlightsPanel.hidden = true;
  toc.append(tocHeader, tocTabs, tocList, searchPanel, highlightsPanel);
  const externalDialog = node("dialog", "epub-external-link");
  const externalTitle = node("strong", "", "Open external link?");
  const externalCopy = node("p", "epub-external-copy");
  const externalActions = node("div", "epub-external-actions");
  const externalCancel = node("button", "epub-tool", "Cancel");
  const externalOpen = node("button", "primary-button", "Open in browser");
  externalCancel.type = externalOpen.type = "button";
  externalActions.append(externalCancel, externalOpen);
  externalDialog.append(externalTitle, externalCopy, externalActions);
  const footnoteDialog = node("dialog", "epub-footnote-dialog");
  const footnoteTitle = node("strong", "", "Note");
  const footnoteCopy = node("div", "epub-footnote-copy");
  const footnoteActions = node("div", "epub-external-actions");
  const footnoteClose = node("button", "epub-tool", "Close");
  const footnoteGo = node("button", "primary-button", "Go to note");
  footnoteClose.type = footnoteGo.type = "button";
  footnoteActions.append(footnoteClose, footnoteGo);
  footnoteDialog.append(footnoteTitle, footnoteCopy, footnoteActions);
  const lookupDialog = node("dialog", "epub-lookup-dialog");
  const lookupTitle = node("strong", "", "Look up selection");
  const lookupCopy = node("p", "epub-lookup-copy");
  const lookupActions = node("div", "epub-external-actions");
  const lookupClose = node("button", "epub-tool", "Close");
  const lookupDictionary = node("button", "epub-tool", "Dictionary");
  const lookupWikipedia = node("button", "primary-button", "Wikipedia");
  [lookupClose, lookupDictionary, lookupWikipedia].forEach((button) => { button.type = "button"; });
  lookupActions.append(lookupClose, lookupDictionary, lookupWikipedia);
  lookupDialog.append(lookupTitle, lookupCopy, lookupActions);
  const notice = node("div", "epub-reader-notice");
  notice.hidden = true;
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  const selectionBar = node("div", "epub-selection-bar");
  selectionBar.hidden = true;
  selectionBar.setAttribute("role", "toolbar");
  selectionBar.setAttribute("aria-label", "Selected passage");
  const selectionCopy = node("span", "epub-selection-copy", "Save this passage to Moments?");
  const saveHighlight = node("button", "primary-button", "Save highlight");
  saveHighlight.type = "button";
  const copySelection = node("button", "epub-tool", "Copy");
  copySelection.type = "button";
  const lookupSelection = node("button", "epub-tool", "Look up");
  lookupSelection.type = "button";
  const cancelHighlight = node("button", "epub-tool", "Cancel");
  cancelHighlight.type = "button";
  selectionBar.append(selectionCopy, saveHighlight, copySelection, lookupSelection, cancelHighlight);
  reader.append(toolbar, stage, footer, toc, externalDialog, footnoteDialog, lookupDialog, notice, selectionBar);
  root.append(reader);

  const nativeFullscreenAvailable = typeof reader.requestFullscreen === "function"
    || typeof reader.webkitRequestFullscreen === "function";
  if (!nativeFullscreenAvailable) {
    setDistractionFreeButton();
  }

  function setDistractionFreeButton() {
    fullscreenButton.textContent = "Focus";
    fullscreenButton.setAttribute("aria-label", "Enter distraction-free reading");
    fullscreenButton.title = "Enter distraction-free reading";
  }

  function select(label, key, values) {
    const wrapper = node("label");
    wrapper.append(node("span", "", label));
    const control = node("select");
    control.dataset.preference = key;
    control.setAttribute("aria-label", label);
    for (const [value, text] of values) {
      const option = node("option", "", text);
      option.value = value;
      option.selected = String(preferences[key]) === String(value);
      control.append(option);
    }
    wrapper.append(control);
    settingsPanel.append(wrapper);
  }
  select("Theme", "theme", [["light", "Light"], ["sepia", "Sepia"], ["dark", "Dark"]]);
  select("Typeface", "fontFamily", [["publisher", "Publisher"], ["serif", "Literary serif"], ["sans", "Clean sans serif"]]);
  select("Text size", "fontSize", [["85", "Small"], ["100", "Default"], ["115", "Large"], ["130", "Larger"], ["150", "Largest"]]);
  select("Line spacing", "lineHeight", [["1.3", "Compact"], ["1.5", "Default"], ["1.8", "Relaxed"], ["2", "Open"]]);
  select("Page width", "contentWidth", [["560", "Narrow"], ["720", "Default"], ["900", "Wide"], ["1200", "Full"]]);
  select("Reading flow", "readingFlow", [["paginated", "Pages"], ["scrolled", "Continuous scroll"]]);
  select("Alignment", "textAlignment", [["start", "Publisher"], ["left", "Left"], ["justify", "Justified"]]);
  settingsPanel.append(node(
    "p",
    "epub-settings-note",
    `Appearance changes are remembered for ${preferenceScope.scope === "series" ? `the ${preferenceScope.scopeLabel} series` : "this book"}. Panels also keeps the screen awake when permitted.`,
  ));

  function themePalette(theme) {
    const palettes = {
      light: { background: "#fff", color: "#232620", link: "#236c6e" },
      sepia: { background: "#f4ecd8", color: "#40382b", link: "#72552e" },
      dark: { background: "#171918", color: "#e4e5df", link: "#83c8c5" },
    };
    return palettes[theme] || palettes.light;
  }

  function pageWidthInset(width) {
    return width < 600 ? "3rem" : width < 800 ? "2rem" : width < 1e3 ? "1rem" : "0px";
  }

  function setImportant(style, property, value) {
    if (value) style.setProperty(property, value, "important");
    else style.removeProperty(property);
  }

  function applyDocumentPreferences(document) {
    const html = document?.documentElement;
    const body = document?.body;
    if (!html || !body) return;
    const palette = themePalette(preferences.theme);
    const font = preferences.fontFamily === "serif"
      ? "Georgia, 'Times New Roman', serif"
      : preferences.fontFamily === "sans" ? "system-ui, sans-serif" : "";
    [html, body].forEach((element) => {
      setImportant(element.style, "background", palette.background);
      setImportant(element.style, "color", palette.color);
      setImportant(element.style, "min-height", "100%");
    });
    setImportant(body.style, "margin-block-start", "0");
    setImportant(body.style, "margin-block-end", "0");
    setImportant(body.style, "padding-block-start", "0");
    setImportant(body.style, "padding-block-end", "0");
    setImportant(body.style, "font-family", font);
    setImportant(body.style, "font-size", `${preferences.fontSize}%`);
    setImportant(body.style, "line-height", String(preferences.lineHeight));
    setImportant(body.style, "text-align", preferences.textAlignment === "start" ? "" : preferences.textAlignment);
    body.style.setProperty("text-rendering", "optimizeLegibility");
    body.style.setProperty("-webkit-font-smoothing", "antialiased");
    document.querySelectorAll("a").forEach((link) => setImportant(link.style, "color", palette.link));
    document.querySelectorAll("img, svg").forEach((image) => {
      setImportant(image.style, "max-width", "100%");
      setImportant(image.style, "height", "auto");
    });
  }

  function applySectionStructure(document, label = "") {
    if (!document?.body) return;
    const headingStyles = {
      display: "block",
      marginBlockStart: "0.7em",
      marginBlockEnd: "0.8em",
      lineHeight: "1.2",
      textAlign: "start",
      breakAfter: "avoid",
    };
    document.querySelectorAll("h1, h2, h3, h4, h5, h6, [epub\\:type~='title'], [role='heading']").forEach((heading) => {
      Object.entries(headingStyles).forEach(([property, value]) => setImportant(heading.style, property.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`), value));
    });
    const normalizedLabel = String(label || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    if (!normalizedLabel) return;
    const candidates = [...document.body.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading'], p, div, span")].slice(0, 40);
    const applyHeadingStyles = (heading) => {
      heading.setAttribute("data-panels-section-heading", "true");
      Object.entries(headingStyles).forEach(([property, value]) => setImportant(heading.style, property.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`), value));
      setImportant(heading.style, "font-size", "1.35em");
      setImportant(heading.style, "font-weight", "700");
    };
    const matching = candidates.find((candidate) => (
      String(candidate.textContent || "").replace(/\s+/g, " ").trim().toLocaleLowerCase() === normalizedLabel
    ));
    if (matching) {
      applyHeadingStyles(matching);
      return;
    }
    if (document.body.querySelector("[data-panels-section-heading]") || document.body.querySelector("h1, h2, h3, h4, h5, h6")) return;
    // Some EPUBs flatten the book title, TOC label and opening prose into one
    // unstyled paragraph. Promote the known TOC label and remove that metadata
    // prefix from the prose rather than making a reader encounter it as text.
    const escapedLabel = String(label).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const embeddedLabel = new RegExp(escapedLabel, "i");
    const flattened = candidates.find((candidate) => {
      if (candidate.children.length) return false;
      const text = String(candidate.textContent || "").replace(/\s+/g, " ").trim();
      const match = embeddedLabel.exec(text);
      return match && match.index <= 160 && text.slice(match.index + match[0].length).trim().length >= 24;
    });
    const heading = document.createElement("h2");
    heading.textContent = label;
    document.body.prepend(heading);
    applyHeadingStyles(heading);
    if (flattened) {
      const text = String(flattened.textContent || "").replace(/\s+/g, " ").trim();
      const match = embeddedLabel.exec(text);
      flattened.textContent = text.slice(match.index + match[0].length).trimStart();
    }
  }

  function applyPreferences() {
    reader.dataset.theme = preferences.theme;
    reader.dataset.flow = preferences.readingFlow;
    stage.style.setProperty("--book-content-width", `${preferences.contentWidth}px`);
    stage.style.setProperty("--book-inline-inset", pageWidthInset(preferences.contentWidth));
    rendition?.getContents?.().forEach((contents) => applyDocumentPreferences(contents.document));
  }

  function showNotice(message) {
    window.clearTimeout(noticeTimer);
    notice.textContent = message;
    notice.hidden = false;
    noticeTimer = window.setTimeout(() => { notice.hidden = true; }, 4500);
  }

  function clearSelectionSnapshot({ collapse = false } = {}) {
    selectionSnapshot = null;
    selectionBar.hidden = true;
    saveHighlight.disabled = false;
    saveHighlight.textContent = "Save highlight";
    if (collapse) {
      rendition?.getContents?.().forEach((contents) => {
        try { contents.document?.getSelection?.()?.removeAllRanges?.(); } catch { /* Ignore inaccessible selection state. */ }
      });
    }
  }

  function addMomentHighlight(moment) {
    const locator = String(moment?.locator || "");
    if (!rendition || !locator.startsWith("epubcfi(") || renderedMomentLocators.has(locator)) return;
    try {
      rendition.annotations.highlight(locator, { momentId: moment.id }, null, "book-moment-highlight", {
        "background-color": "rgba(239, 190, 73, 0.42)",
        "mix-blend-mode": preferences.theme === "dark" ? "screen" : "multiply",
      });
      renderedMomentLocators.add(locator);
    } catch {
      // A malformed locator should not prevent the book itself from opening.
    }
  }

  async function loadBookMomentHighlights() {
    try {
      const payload = await jsonRequest("/api/moments");
      bookMoments = (Array.isArray(payload.moments) ? payload.moments : []).filter((moment) => (
        moment.momentType === "text" && Number(moment.bookId) === Number(book.id)
      ));
      bookMoments.forEach(addMomentHighlight);
      renderHighlightsPanel();
    } catch {
      // Reading remains available if Moments cannot be loaded.
    }
  }

  function showBookMenuPanel(name) {
    const entries = [
      ["contents", contentsTab, tocList],
      ["search", searchTab, searchPanel],
      ["highlights", highlightsTab, highlightsPanel],
    ];
    entries.forEach(([key, tab, panel]) => {
      const active = key === name;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-pressed", active ? "true" : "false");
      panel.hidden = !active;
    });
    if (name === "highlights") renderHighlightsPanel();
    if (name === "search") window.setTimeout(() => searchInput.focus(), 0);
  }

  function renderHighlightsPanel() {
    highlightsPanel.replaceChildren();
    if (!bookMoments.length) {
      highlightsPanel.append(node("p", "epub-toc-empty", "Select text in the reader to save your first highlight."));
      return;
    }
    const groups = new Map();
    [...bookMoments]
      .sort((left, right) => Number(left.progression ?? 2) - Number(right.progression ?? 2))
      .forEach((moment) => {
        const label = String(moment.chapterTitle || "Other passages").trim() || "Other passages";
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(moment);
      });
    groups.forEach((moments, label) => {
      const group = node("section", "epub-highlight-group");
      group.append(node("h3", "", label));
      moments.forEach((moment) => {
        const button = node("button", "epub-highlight-link", `“${String(moment.quote || "Saved passage").slice(0, 220)}”`);
        button.type = "button";
        button.addEventListener("click", () => {
          toc.close();
          if (String(moment.locator || "").startsWith("epubcfi(")) void rendition?.display(moment.locator);
        });
        group.append(button);
      });
      highlightsPanel.append(group);
    });
  }

  async function searchPublication(query) {
    const term = String(query || "").replace(/\s+/g, " ").trim();
    if (term.length < 2) throw new Error("Enter at least two characters.");
    const results = [];
    const sections = publication?.spine?.spineItems || [];
    for (let sectionIndex = 0; sectionIndex < sections.length && results.length < 60; sectionIndex += 1) {
      const section = sections[sectionIndex];
      const alreadyLoaded = Boolean(section.document);
      try {
        await section.load(publication.load.bind(publication));
        const document = section.document;
        if (!document?.body) continue;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let textNode;
        while ((textNode = walker.nextNode()) && results.length < 60) {
          const text = String(textNode.nodeValue || "");
          for (const match of textMatchOffsets(text, term, 3)) {
            const range = document.createRange();
            range.setStart(textNode, match.index);
            range.setEnd(textNode, match.index + match.length);
            let cfi = "";
            try { cfi = section.cfiFromRange(range); } catch { /* Skip malformed ranges. */ }
            if (!String(cfi).startsWith("epubcfi(")) continue;
            const before = text.slice(Math.max(0, match.index - 70), match.index).replace(/\s+/g, " ").trimStart();
            const found = text.slice(match.index, match.index + match.length);
            const after = text.slice(match.index + match.length, match.index + match.length + 110).replace(/\s+/g, " ").trimEnd();
            results.push({
              cfi,
              excerpt: `${before ? `…${before}` : ""}${found}${after ? `${after}…` : ""}`,
              chapter: navigationEntryForHref(section.href)?.label?.trim() || `Section ${sectionIndex + 1}`,
            });
            if (results.length >= 60) break;
          }
        }
      } finally {
        if (!alreadyLoaded) section.unload?.();
      }
      searchStatus.textContent = `Searching… ${sectionIndex + 1} of ${sections.length} sections`;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    return results;
  }

  function renderSearchResults(results, query) {
    searchResults.replaceChildren();
    searchStatus.textContent = results.length
      ? `${results.length}${results.length >= 60 ? "+" : ""} match${results.length === 1 ? "" : "es"} for “${query}”`
      : `No matches for “${query}”`;
    results.forEach((result) => {
      const button = node("button", "epub-search-result");
      button.type = "button";
      button.append(node("strong", "", result.chapter), node("span", "", result.excerpt));
      button.addEventListener("click", () => {
        toc.close();
        void rendition?.display(result.cfi);
      });
      searchResults.append(button);
    });
  }

  async function showFootnote(contents, href, label = "") {
    const [pathPart, fragment = ""] = String(href || "").split("#", 2);
    if (!fragment) return false;
    let document = contents.document;
    let section = null;
    let unload = false;
    if (pathPart) {
      const targetName = pathPart.split("/").pop();
      section = (publication?.spine?.spineItems || []).find((item) => String(item.href || "").split("#")[0].split("/").pop() === targetName);
      if (!section) return false;
      unload = !section.document;
      await section.load(publication.load.bind(publication));
      document = section.document;
    }
    try {
      const target = document?.getElementById?.(decodeURIComponent(fragment));
      const text = String(target?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 5000);
      if (!text) return false;
      footnoteTitle.textContent = label || "Note";
      footnoteCopy.textContent = text;
      footnoteDialog.dataset.href = href;
      footnoteDialog.showModal();
      return true;
    } finally {
      if (unload) section?.unload?.();
    }
  }

  function captureTextSelection(contents) {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => {
      try {
        const selection = contents.document?.getSelection?.();
        if (!selection || selection.isCollapsed || selection.rangeCount < 1) return;
        const quote = selection.toString().replace(/\s+/g, " ").trim().slice(0, 8000);
        if (!quote) return;
        const locator = contents.cfiFromRange(selection.getRangeAt(0));
        if (!String(locator || "").startsWith("epubcfi(")) return;
        let progression = safeProgression(pendingPosition?.progression ?? currentProgress?.progression);
        if (locationsReady) {
          try { progression = safeProgression(publication.locations.percentageFromCfi(locator)); } catch { /* Use page progression. */ }
        }
        const resourceHref = contents.section?.href || pendingPosition?.href || "";
        selectionSnapshot = {
          quote,
          locator,
          resourceHref,
          progression,
          chapterTitle: navigationEntryForHref(resourceHref)?.label?.trim() || chapterTitle.textContent || "",
        };
        selectionCopy.textContent = quote.length > 90 ? `${quote.slice(0, 87)}…` : quote;
        selectionBar.hidden = false;
      } catch {
        // Some malformed EPUB ranges cannot be converted to a CFI; leave them selectable for copy.
      }
    }, 80);
  }

  async function saveSelectedHighlight() {
    if (!selectionSnapshot) return;
    saveHighlight.disabled = true;
    saveHighlight.textContent = "Saving…";
    try {
      const payload = await jsonRequest("/api/moments", {
        method: "POST",
        body: JSON.stringify({
          momentType: "text",
          bookId: book.id,
          title: book.title,
          chapterTitle: selectionSnapshot.chapterTitle,
          sourceLabel: Array.isArray(book.authors) ? book.authors.join(", ") : String(book.authors || ""),
          quote: selectionSnapshot.quote,
          locator: selectionSnapshot.locator,
          resourceHref: selectionSnapshot.resourceHref,
          progression: selectionSnapshot.progression,
        }),
      });
      if (payload.moment) {
        bookMoments = [payload.moment, ...bookMoments.filter((moment) => moment.id !== payload.moment.id)];
        addMomentHighlight(payload.moment);
        renderHighlightsPanel();
      }
      clearSelectionSnapshot({ collapse: true });
      showNotice("Highlight saved to Moments.");
    } catch (error) {
      saveHighlight.disabled = false;
      saveHighlight.textContent = "Save highlight";
      showNotice(error.message || "This highlight could not be saved.");
    }
  }

  function setControlsVisible(visible, linger = true) {
    window.clearTimeout(controlsTimer);
    if (!visible && settings.open) settings.open = false;
    reader.classList.toggle("epub-chrome-hidden", !visible);
    reader.dataset.controlsVisible = visible ? "true" : "false";
    // Opacity alone leaves invisible reader chrome in the tab order on iOS.
    // The reading surface itself remains the single way to restore chrome.
    [toolbar, footer].forEach((surface) => {
      surface.inert = !visible;
      surface.setAttribute("aria-hidden", String(!visible));
    });
    if (visible && linger && !settings.open && !toc.open) {
      controlsTimer = window.setTimeout(() => {
        setControlsVisible(false, false);
      }, 5000);
    }
  }

  async function toggleFullscreen() {
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    try {
      if (active) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
      } else {
        const enter = reader.requestFullscreen || reader.webkitRequestFullscreen;
        if (!enter) {
          setDistractionFreeButton();
          setControlsVisible(false, false);
          return;
        }
        await enter.call(reader);
      }
    } catch {
      // iOS does not expose element fullscreen for normal web content. Falling
      // back to distraction-free mode is more useful than replacing progress
      // information with a persistent browser capability error.
      setDistractionFreeButton();
      setControlsVisible(false, false);
    }
  }

  async function requestWakeLock() {
    if (destroyed || document.visibilityState !== "visible" || !navigator.wakeLock?.request) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; }, { once: true });
    } catch {
      wakeLock = null;
    }
  }

  function updateProgressDisplay(cfi, fallbackProgression = null) {
    let progression = safeProgression(fallbackProgression);
    if (locationsReady && cfi) {
      try {
        progression = safeProgression(publication.locations.percentageFromCfi(cfi));
      } catch {
        // Keep the EPUB.js fallback when a malformed navigation document cannot map a CFI.
      }
    }
    const percentage = progression == null ? null : Math.round(progression * 100);
    let locationCount = "";
    if (locationsReady && cfi) {
      try {
        const index = publication.locations.locationFromCfi(cfi);
        const total = publication.locations.length();
        if (Number.isInteger(index) && index >= 0 && total > 0) locationCount = ` (${Math.min(total, index + 1)}/${total})`;
      } catch {
        // Percentage remains useful when a malformed CFI cannot map to the generated index.
      }
    }
    location.textContent = percentage == null ? "Exact position saved" : `${percentage}%${locationCount}`;
    if (progression != null) scrubber.value = String(Math.round(progression * 1000));
    if (currentSectionProgress?.total > 0) {
      const pagesLeft = Math.max(0, currentSectionProgress.total - currentSectionProgress.page);
      if (pagesLeft === 0) {
        timeRemaining.textContent = `End of ${currentSectionProgress.label || "section"}`;
      } else {
        const duration = humanReadingTime(pagesLeft * 1.2).replace(/^About /, "about ");
        timeRemaining.textContent = `${pagesLeft} page${pagesLeft === 1 ? "" : "s"} · ${duration} in ${currentSectionProgress.label || "this section"}`;
      }
    } else if (locationsReady && progression != null) {
      const remainingLocations = Math.max(0, publication.locations.length() * (1 - progression));
      timeRemaining.textContent = humanReadingTime((remainingLocations * 265) / 240);
    } else {
      timeRemaining.textContent = "Generating book locations…";
    }
    return progression;
  }

  function makeRendition() {
    renditionFlow = preferences.readingFlow;
    return publication.renderTo(viewport, {
      width: "100%",
      height: "100%",
      flow: preferences.readingFlow === "scrolled" ? "scrolled-doc" : "paginated",
      manager: preferences.readingFlow === "scrolled" ? "continuous" : "default",
      allowScriptedContent: false,
    });
  }

  async function refreshPreferences(changedKey) {
    if (changedKey === "readingFlow" || renditionFlow !== preferences.readingFlow) {
      const locator = pendingPosition?.cfi || currentProgress?.locator;
      rendition?.destroy();
      viewport.replaceChildren();
      rendition = makeRendition();
      bindRendition();
      applyPreferences();
      await rendition.display(locator || undefined);
      renderedMomentLocators.clear();
      bookMoments.forEach(addMomentHighlight);
    } else {
      applyPreferences();
      const locator = pendingPosition?.cfi || currentProgress?.locator;
      rendition?.resize?.();
      if (locator) await rendition?.display?.(locator).catch(() => {});
    }
  }

  async function persistPreferences(changedKey, previousValue, control) {
    const request = ++preferenceRequest;
    const payload = { ...preferences };
    try {
      const response = await jsonRequest(`/api/books/${book.id}/preferences`, { method: "POST", body: JSON.stringify(payload) });
      if (destroyed || request !== preferenceRequest) return;
      Object.assign(preferences, response.preferences);
      await refreshPreferences(changedKey);
    } catch {
      if (destroyed || request !== preferenceRequest) return;
      preferences[changedKey] = previousValue;
      control.value = String(previousValue);
      await refreshPreferences(changedKey).catch(() => {});
      showNotice("That reading option could not be saved. Your previous setting has been restored.");
    }
  }

  async function savePosition(cfi, href, progression, retry = true, keepalive = false) {
    if (destroyed || !cfi?.startsWith("epubcfi(")) return;
    try {
      const payload = await jsonRequest(`/api/books/${book.id}/progress`, {
        method: "POST",
        keepalive,
        body: JSON.stringify({ locatorType: "cfi", locator: cfi, resourceHref: href || "", progression, revision: currentProgress?.revision || 0 }),
      });
      currentProgress = payload.progress;
      clearEmergencyPosition(cfi);
    } catch (error) {
      if (retry && error.status === 409 && error.payload?.current) {
        currentProgress = error.payload.current;
        await savePosition(cfi, href, progression, false, keepalive);
      } else {
        timeRemaining.textContent = "Position not saved — retrying as you read";
      }
    }
  }

  function scrollCurrentSection(direction) {
    if (preferences.readingFlow !== "scrolled") return false;
    const contents = rendition?.getContents?.() || [];
    const href = String(pendingPosition?.href || "").split("#")[0].split("/").pop();
    const content = contents.find((item) => String(item.section?.href || "").split("#")[0].split("/").pop() === href)
      || contents.find((item) => {
        const rect = item.document?.defaultView?.frameElement?.getBoundingClientRect?.();
        return rect && rect.top <= window.innerHeight / 2 && rect.bottom >= window.innerHeight / 2;
      }) || contents[0];
    if (!content?.document) return false;

    const scrollingElement = content.document.scrollingElement;
    const contentWindow = content.window;
    const innerTop = scrollingElement?.scrollTop || contentWindow?.scrollY || 0;
    const innerHeight = contentWindow?.innerHeight || scrollingElement?.clientHeight || 0;
    const innerLimit = Math.max(0, (scrollingElement?.scrollHeight || 0) - innerHeight);
    if ((direction > 0 && innerTop < innerLimit - 2) || (direction < 0 && innerTop > 2)) {
      const nextTop = Math.max(0, Math.min(innerLimit, innerTop + direction * innerHeight * 0.88));
      contentWindow.scrollTo({ top: nextTop, behavior: "auto" });
      return true;
    }

    const container = viewport.querySelector(".epub-container");
    const view = contentWindow?.frameElement?.closest?.(".epub-view");
    if (!container || !view) return false;
    const containerRect = container.getBoundingClientRect();
    const viewRect = view.getBoundingClientRect();
    const viewTop = container.scrollTop + viewRect.top - containerRect.top;
    const viewLimit = Math.max(viewTop, viewTop + viewRect.height - container.clientHeight);
    const currentTop = container.scrollTop;
    if ((direction > 0 && currentTop < viewLimit - 2) || (direction < 0 && currentTop > viewTop + 2)) {
      container.scrollTo({
        top: Math.max(viewTop, Math.min(viewLimit, currentTop + direction * container.clientHeight * 0.88)),
        behavior: "auto",
      });
      return true;
    }
    return false;
  }

  function navigateReadingStep(direction) {
    if (!scrollCurrentSection(direction)) void (direction > 0 ? rendition?.next() : rendition?.prev());
  }

  function navigateFromGesture(deltaX, deltaY) {
    if (Math.abs(deltaX) < 52 || Math.abs(deltaX) < Math.abs(deltaY) * 1.35) return false;
    void (deltaX < 0 ? rendition?.next() : rendition?.prev());
    setControlsVisible(false);
    return true;
  }

  function handleReaderTap(xRatio, moved = false) {
    if (moved) return;
    if (xRatio < 0.24) {
      navigateReadingStep(-1);
      setControlsVisible(false);
    } else if (xRatio > 0.76) {
      navigateReadingStep(1);
      setControlsVisible(false);
    } else {
      setControlsVisible(reader.classList.contains("epub-chrome-hidden"), false);
    }
  }

  function hasTextSelection(document) {
    try {
      const selection = document?.getSelection?.();
      return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
    } catch {
      return false;
    }
  }

  function navigationEntryForHref(href, entries = publication?.navigation?.toc || []) {
    const direct = publication?.navigation?.get?.(href);
    if (direct) return direct;
    const target = String(href || "").split("#")[0].split("/").pop();
    for (const entry of entries) {
      if (String(entry?.href || "").split("#")[0].split("/").pop() === target) return entry;
      const child = navigationEntryForHref(href, entry?.subitems || entry?.children || []);
      if (child) return child;
    }
    return null;
  }

  function bindContentInteractions(contents) {
    const document = contents.document;
    sanitizeRenderedDocument(document);
    applyDocumentPreferences(document);
    const sectionHref = contents.section?.href || "";
    applySectionStructure(document, navigationEntryForHref(sectionHref)?.label || document.title);
    let contentGesture = null;
    let contentTouch = null;
    let lastHandledGesture = 0;
    let suppressTapUntil = 0;
    const finishGesture = (start, clientX, clientY, target) => {
      if (!start || target?.closest?.("a") || Date.now() - lastHandledGesture < 350) return;
      if (Date.now() - start.at >= 500 || hasTextSelection(document)) {
        lastHandledGesture = Date.now();
        suppressTapUntil = lastHandledGesture + 1000;
        return;
      }
      const deltaX = clientX - start.x;
      const deltaY = clientY - start.y;
      const moved = Math.hypot(deltaX, deltaY) > 12;
      if (!navigateFromGesture(deltaX, deltaY)) {
        handleReaderTap(clientX / Math.max(1, contents.window.innerWidth), moved);
      }
      lastHandledGesture = Date.now();
    };
    const clearGesture = () => { contentGesture = null; contentTouch = null; };
    const captureOptions = { passive: true, capture: true };
    document.addEventListener("selectionchange", () => captureTextSelection(contents), { passive: true });
    contents.window.addEventListener("pointerdown", (event) => {
      // iOS emits both Pointer and Touch events for one physical tap. Let the
      // Touch path own it, otherwise a zero/early pointer coordinate can be
      // handled first and suppress the actual centre tap.
      if (event.pointerType === "touch" || contentTouch) return;
      contentGesture = { x: event.clientX, y: event.clientY, at: Date.now() };
    }, captureOptions);
    contents.window.addEventListener("pointerup", (event) => {
      if (event.pointerType === "touch" || contentTouch) return;
      finishGesture(contentGesture, event.clientX, event.clientY, event.target);
      contentGesture = null;
    }, captureOptions);
    contents.window.addEventListener("pointercancel", clearGesture, captureOptions);
    contents.window.addEventListener("touchstart", (event) => {
      const touch = event.touches?.length === 1 ? event.touches[0] : null;
      contentTouch = touch ? { x: touch.clientX, y: touch.clientY, at: Date.now() } : null;
    }, captureOptions);
    contents.window.addEventListener("touchend", (event) => {
      const touch = event.changedTouches?.[0];
      if (touch) finishGesture(contentTouch, touch.clientX, touch.clientY, event.target);
      contentTouch = null;
    }, captureOptions);
    contents.window.addEventListener("touchcancel", clearGesture, captureOptions);
    contents.window.addEventListener("blur", clearGesture, { passive: true });
    document.addEventListener("click", (event) => {
      const link = event.target.closest?.("a[href], a[data-external-href]");
      if (link) {
        const externalHref = link.dataset.externalHref;
        if (externalHref) {
          event.preventDefault();
          try {
            const url = new URL(externalHref, window.location.href);
            if (!["http:", "https:", "mailto:"].includes(url.protocol)) return;
            externalDialog.dataset.href = url.href;
            externalCopy.textContent = url.protocol === "mailto:"
              ? "This book contains an email link. Leave Panels to open it?"
              : `This book links to ${url.hostname}. Leave Panels to open it in your browser?`;
            externalDialog.showModal();
          } catch {
            showNotice("This external link is not valid and cannot be opened.");
          }
          return;
        }
        const href = link.getAttribute("href") || "";
        const epubType = `${link.getAttribute("epub:type") || ""} ${link.getAttribute("role") || ""}`.toLocaleLowerCase();
        if (href && /(?:^|\s)(?:noteref|doc-noteref)(?:\s|$)/.test(epubType)) {
          event.preventDefault();
          void showFootnote(contents, href, link.textContent?.trim() || "Note").then((shown) => {
            if (!shown) void rendition?.display(href);
          }).catch(() => { void rendition?.display(href); });
          return;
        }
        if (/^(?:https?:)?\/\//i.test(href) || /^mailto:/i.test(href)) {
          event.preventDefault();
          return;
        }
        if (href && !href.toLowerCase().startsWith("javascript:")) {
          event.preventDefault();
          void rendition?.display(href);
        }
        return;
      }
      // Some iOS WebKit builds do not deliver pointerup reliably inside the
      // EPUB iframe. The click path keeps the centre control toggle available
      // without double-handling browsers that delivered both events.
      // Ignore the synthetic click from the same touch, but keep a deliberate
      // second centre tap responsive instead of making recovery feel stuck.
      if (Date.now() < suppressTapUntil || Date.now() - lastHandledGesture < 220 || hasTextSelection(document)) return;
      handleReaderTap(event.clientX / Math.max(1, contents.window.innerWidth));
      lastHandledGesture = Date.now();
    });
    document.addEventListener("keydown", (event) => {
      const externalLink = event.target.closest?.("a[data-external-href]");
      if (externalLink && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        externalLink.click();
        return;
      }
      keyHandler(event);
    });
  }

  function bindRendition() {
    rendition.hooks.content.register(bindContentInteractions);
    rendition.on("relocated", (relocation) => {
      clearSelectionSnapshot();
      const start = relocation?.start || {};
      const navigationItem = navigationEntryForHref(start.href);
      currentSectionProgress = Number(start.displayed?.total) > 0 ? {
        page: Math.max(1, Number(start.displayed.page) || 1),
        total: Number(start.displayed.total),
        label: navigationItem?.label?.trim() || "this section",
      } : null;
      const progression = updateProgressDisplay(start.cfi, start.percentage ?? relocation?.percentage);
      pendingPosition = { cfi: start.cfi, href: start.href, progression };
      chapterTitle.textContent = navigationItem?.label?.trim() || (start.displayed?.page && start.displayed?.total
        ? `Page ${start.displayed.page} of ${start.displayed.total}`
        : "Reading");
      rendition?.getContents?.().forEach((contents) => {
        const href = String(contents.section?.href || "").split("#")[0];
        const activeHref = String(start.href || "").split("#")[0];
        if (!activeHref || href === activeHref || href.split("/").pop() === activeHref.split("/").pop()) {
          applySectionStructure(contents.document, navigationItem?.label);
        }
      });
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => { void savePosition(start.cfi, start.href, progression); }, 650);
    });
  }

  async function generateLocations() {
    try {
      await publication.ready;
      await publication.locations.generate(1600);
      if (destroyed) return;
      locationsReady = publication.locations.length() > 0;
      scrubber.disabled = !locationsReady;
      updateProgressDisplay(pendingPosition?.cfi, pendingPosition?.progression ?? currentProgress?.progression);
    } catch {
      timeRemaining.textContent = "Exact position saved";
    }
  }

  async function openPublication() {
    loading.hidden = false;
    loading.replaceChildren(node("span", "", "Opening EPUB…"));
    previous.hidden = false;
    next.hidden = false;
    try {
      const response = await fetchEpubResponse(book.epubUrl);
      const buffer = await response.arrayBuffer();
      if (destroyed) return;
      publication?.destroy();
      viewport.replaceChildren();
      publication = ePub(buffer);
      rendition = makeRendition();
      bindRendition();
      applyPreferences();
      const navigation = await publication.loaded.navigation;
      tocList.replaceChildren();
      renderEpubToc(navigation.toc || [], tocList, (href) => { toc.close(); void rendition.display(href); });
      if (!tocList.children.length) tocList.append(node("p", "epub-toc-empty", "This EPUB does not include a table of contents."));
      await rendition.display(initialHref || emergencyPosition?.locator || currentProgress?.locator || undefined);
      renderedMomentLocators.clear();
      await loadBookMomentHighlights();
      loading.hidden = true;
      setControlsVisible(true, false);
      void generateLocations();
    } catch (error) {
      loading.hidden = false;
      const retry = node("button", "primary-button", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => { void openPublication(); });
      loading.replaceChildren(node("strong", "", "Could not open this EPUB"), node("span", "", error.message), retry);
      previous.hidden = true;
      next.hidden = true;
    }
  }

  function bindSettingsSwipe() {
    let startY;
    settingsPanel.addEventListener("touchstart", (event) => { startY = event.touches[0]?.clientY; });
    settingsPanel.addEventListener("touchend", (event) => {
      const endY = event.changedTouches[0]?.clientY;
      if (startY < settingsPanel.getBoundingClientRect().top + 64 && endY - startY >= 64) settings.open = false;
      startY = undefined;
    });
  }

  bindSettingsSwipe();

  settingsPanel.addEventListener("change", (event) => {
    const control = event.target.closest("[data-preference]");
    if (!control) return;
    const key = control.dataset.preference;
    const previousValue = preferences[key];
    preferences[key] = ["fontSize", "lineHeight", "contentWidth"].includes(key) ? Number(control.value) : control.value;
    applyPreferences();
    void persistPreferences(key, previousValue, control);
  });
  settings.addEventListener("toggle", () => {
    if (settings.open) setControlsVisible(true, false);
  });
  back.addEventListener("click", onExit);
  previous.addEventListener("click", () => navigateReadingStep(-1));
  next.addEventListener("click", () => navigateReadingStep(1));
  tocButton.addEventListener("click", () => { showBookMenuPanel("contents"); toc.showModal(); setControlsVisible(true, false); });
  fullscreenButton.addEventListener("click", () => { void toggleFullscreen(); });
  contentsTab.addEventListener("click", () => showBookMenuPanel("contents"));
  searchTab.addEventListener("click", () => showBookMenuPanel("search"));
  highlightsTab.addEventListener("click", () => showBookMenuPanel("highlights"));
  searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    searchButton.disabled = true;
    searchResults.replaceChildren();
    searchStatus.textContent = "Searching this EPUB…";
    try {
      renderSearchResults(await searchPublication(query), query);
    } catch (error) {
      searchStatus.textContent = error.message || "This EPUB could not be searched.";
    } finally {
      searchButton.disabled = false;
    }
  });
  tocClose.addEventListener("click", () => toc.close());
  toc.addEventListener("click", (event) => { if (event.target === toc) toc.close(); });
  toc.addEventListener("close", () => setControlsVisible(true));
  externalCancel.addEventListener("click", () => externalDialog.close());
  externalOpen.addEventListener("click", () => {
    const href = externalDialog.dataset.href;
    externalDialog.close();
    if (href) window.open(href, "_blank", "noopener,noreferrer");
  });
  externalDialog.addEventListener("click", (event) => { if (event.target === externalDialog) externalDialog.close(); });
  footnoteClose.addEventListener("click", () => footnoteDialog.close());
  footnoteGo.addEventListener("click", () => {
    const href = footnoteDialog.dataset.href;
    footnoteDialog.close();
    if (href) void rendition?.display(href);
  });
  footnoteDialog.addEventListener("click", (event) => { if (event.target === footnoteDialog) footnoteDialog.close(); });
  lookupClose.addEventListener("click", () => lookupDialog.close());
  lookupDictionary.addEventListener("click", () => {
    const query = lookupDialog.dataset.query;
    if (query) window.open(`https://en.wiktionary.org/w/index.php?search=${encodeURIComponent(query)}`, "_blank", "noopener,noreferrer");
  });
  lookupWikipedia.addEventListener("click", () => {
    const query = lookupDialog.dataset.query;
    if (query) window.open(`https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`, "_blank", "noopener,noreferrer");
  });
  lookupDialog.addEventListener("click", (event) => { if (event.target === lookupDialog) lookupDialog.close(); });
  saveHighlight.addEventListener("click", () => { void saveSelectedHighlight(); });
  copySelection.addEventListener("click", async () => {
    if (!selectionSnapshot?.quote) return;
    try {
      await navigator.clipboard.writeText(selectionSnapshot.quote);
      showNotice("Passage copied.");
    } catch {
      showNotice("Copy is unavailable here; use the browser selection menu instead.");
    }
  });
  lookupSelection.addEventListener("click", () => {
    if (!selectionSnapshot?.quote) return;
    const query = selectionSnapshot.quote.slice(0, 500);
    lookupDialog.dataset.query = query;
    lookupCopy.textContent = query;
    lookupDialog.showModal();
  });
  cancelHighlight.addEventListener("click", () => clearSelectionSnapshot({ collapse: true }));
  scrubber.addEventListener("input", () => { location.textContent = `${Math.round(Number(scrubber.value) / 10)}%`; });
  scrubber.addEventListener("change", () => {
    if (!locationsReady) return;
    try {
      const cfi = publication.locations.cfiFromPercentage(Number(scrubber.value) / 1000);
      if (cfi) void rendition?.display(cfi);
    } catch {
      // Leave the reader at its current exact location when the EPUB index is malformed.
    }
  });
  stage.addEventListener("pointerdown", (event) => { gestureStart = { x: event.clientX, y: event.clientY, at: Date.now() }; }, { passive: true });
  stage.addEventListener("pointerup", (event) => {
    if (!gestureStart || event.target.closest("button")) { gestureStart = null; return; }
    if (Date.now() - gestureStart.at >= 500 || hasTextSelection(document)) { gestureStart = null; return; }
    const deltaX = event.clientX - gestureStart.x;
    const deltaY = event.clientY - gestureStart.y;
    const moved = Math.hypot(deltaX, deltaY) > 12;
    if (!navigateFromGesture(deltaX, deltaY)) handleReaderTap(event.clientX / Math.max(1, stage.clientWidth), moved);
    gestureStart = null;
  }, { passive: true });
  stage.addEventListener("pointercancel", () => { gestureStart = null; }, { passive: true });
  stage.addEventListener("lostpointercapture", () => { gestureStart = null; }, { passive: true });

  const keyHandler = (event) => {
    if (event.key === "Escape") {
      if (settings.open) {
        event.preventDefault();
        settings.open = false;
        settingsSummary.focus();
      } else if (externalDialog.open) externalDialog.close();
      else if (footnoteDialog.open) footnoteDialog.close();
      else if (lookupDialog.open) lookupDialog.close();
      else if (toc.open) toc.close();
      else onExit();
      return;
    }
    if (event.target?.closest?.("input, select, button, summary, a") || toc.open || externalDialog.open) return;
    if (event.key === "PageDown" || event.key === " ") {
      event.preventDefault();
      navigateReadingStep(1);
    } else if (event.key === "PageUp") {
      event.preventDefault();
      navigateReadingStep(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      void rendition?.next();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      void rendition?.prev();
    }
  };
  const flushPendingPosition = () => {
    window.clearTimeout(saveTimer);
    if (pendingPosition) {
      cacheEmergencyPosition();
      void savePosition(pendingPosition.cfi, pendingPosition.href, pendingPosition.progression, true, true);
    }
  };
  const visibilityHandler = () => {
    if (document.visibilityState === "visible") void requestWakeLock();
    else flushPendingPosition();
  };
  const resizeHandler = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(async () => {
      if (destroyed || !rendition) return;
      const locator = pendingPosition?.cfi || currentProgress?.locator;
      rendition.resize();
      if (locator) await rendition.display(locator).catch(() => {});
    }, 180);
  };
  const visualViewport = window.visualViewport;
  window.addEventListener("keydown", keyHandler);
  window.addEventListener("resize", resizeHandler);
  window.addEventListener("orientationchange", resizeHandler);
  visualViewport?.addEventListener("resize", resizeHandler);
  window.addEventListener("pagehide", flushPendingPosition);
  document.addEventListener("visibilitychange", visibilityHandler);
  document.addEventListener("freeze", flushPendingPosition);

  void requestWakeLock();
  await openPublication();

  return {
    destroy() {
      window.clearTimeout(saveTimer);
      window.clearTimeout(resizeTimer);
      window.clearTimeout(controlsTimer);
      window.clearTimeout(noticeTimer);
      window.clearTimeout(selectionTimer);
      window.removeEventListener("keydown", keyHandler);
      window.removeEventListener("resize", resizeHandler);
      window.removeEventListener("orientationchange", resizeHandler);
      visualViewport?.removeEventListener("resize", resizeHandler);
      window.removeEventListener("pagehide", flushPendingPosition);
      document.removeEventListener("visibilitychange", visibilityHandler);
      document.removeEventListener("freeze", flushPendingPosition);
      flushPendingPosition();
      wakeLock?.release?.().catch(() => {});
      rendition?.destroy();
      publication?.destroy();
      if (toc.open) toc.close();
      if (externalDialog.open) externalDialog.close();
      if (footnoteDialog.open) footnoteDialog.close();
      if (lookupDialog.open) lookupDialog.close();
      destroyed = true;
    },
  };
}
