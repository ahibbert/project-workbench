import ePub from "epubjs";

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
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
      if (["src", "href", "poster", "action", "formaction"].includes(name) && /^(?:https?:)?\/\//i.test(value)) {
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

export async function createEpubReader({ root, book, progress, preferences, onExit }) {
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

  root.replaceChildren();
  const reader = node("section", "epub-reader");
  reader.dataset.theme = preferences.theme;
  reader.dataset.flow = preferences.readingFlow;
  const toolbar = node("header", "epub-toolbar");
  const back = node("button", "epub-tool epub-back", "‹ Books library");
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
  tocHeader.append(node("strong", "", "Contents"));
  const tocClose = node("button", "epub-tool", "Close");
  tocClose.type = "button";
  tocHeader.append(tocClose);
  const tocList = node("nav", "epub-toc-list");
  toc.append(tocHeader, tocList);
  reader.append(toolbar, stage, footer, toc);
  root.append(reader);

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
  settingsPanel.append(node("p", "epub-settings-note", "Panels keeps the screen awake while this reader is open when your browser permits it."));

  function themePalette(theme) {
    const palettes = {
      light: { background: "#fff", color: "#232620", link: "#236c6e" },
      sepia: { background: "#f4ecd8", color: "#40382b", link: "#72552e" },
      dark: { background: "#171918", color: "#e4e5df", link: "#83c8c5" },
    };
    return palettes[theme] || palettes.light;
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

  function applyPreferences() {
    reader.dataset.theme = preferences.theme;
    reader.dataset.flow = preferences.readingFlow;
    stage.style.setProperty("--book-content-width", `${preferences.contentWidth}px`);
    rendition?.getContents?.().forEach((contents) => applyDocumentPreferences(contents.document));
  }

  function setControlsVisible(visible, linger = true) {
    window.clearTimeout(controlsTimer);
    reader.classList.toggle("epub-chrome-hidden", !visible);
    reader.dataset.controlsVisible = visible ? "true" : "false";
    if (visible && linger && !settings.open && !toc.open) {
      controlsTimer = window.setTimeout(() => {
        reader.classList.add("epub-chrome-hidden");
        reader.dataset.controlsVisible = "false";
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
        if (!enter) throw new Error("Full screen is not available in this iOS browser. Adding Panel Pilot to the Home Screen provides the cleanest supported view.");
        await enter.call(reader);
      }
    } catch (error) {
      timeRemaining.textContent = error?.message || "Full screen could not be opened.";
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
    location.textContent = percentage == null ? "Exact position saved" : `${percentage}%`;
    if (progression != null) scrubber.value = String(Math.round(progression * 1000));
    if (locationsReady && progression != null) {
      const remainingLocations = Math.max(0, publication.locations.length() * (1 - progression));
      timeRemaining.textContent = humanReadingTime((remainingLocations * 265) / 240);
    } else {
      timeRemaining.textContent = "Generating book locations…";
    }
    return progression;
  }

  function makeRendition() {
    return publication.renderTo(viewport, {
      width: "100%",
      height: "100%",
      flow: preferences.readingFlow === "scrolled" ? "scrolled-doc" : "paginated",
      manager: preferences.readingFlow === "scrolled" ? "continuous" : "default",
      allowScriptedContent: false,
    });
  }

  async function persistPreferences(changedKey) {
    const payload = await jsonRequest("/api/books/preferences", { method: "POST", body: JSON.stringify(preferences) });
    Object.assign(preferences, payload.preferences);
    if (changedKey === "readingFlow") {
      const locator = pendingPosition?.cfi || currentProgress?.locator;
      rendition?.destroy();
      viewport.replaceChildren();
      rendition = makeRendition();
      bindRendition();
      applyPreferences();
      await rendition.display(locator || undefined);
    } else {
      applyPreferences();
      const locator = pendingPosition?.cfi || currentProgress?.locator;
      rendition?.resize?.();
      if (locator) await rendition?.display?.(locator).catch(() => {});
    }
  }

  async function savePosition(cfi, href, progression, retry = true) {
    if (destroyed || !cfi?.startsWith("epubcfi(")) return;
    try {
      const payload = await jsonRequest(`/api/books/${book.id}/progress`, {
        method: "POST",
        body: JSON.stringify({ locatorType: "cfi", locator: cfi, resourceHref: href || "", progression, revision: currentProgress?.revision || 0 }),
      });
      currentProgress = payload.progress;
    } catch (error) {
      if (retry && error.status === 409 && error.payload?.current) {
        currentProgress = error.payload.current;
        await savePosition(cfi, href, progression, false);
      } else {
        timeRemaining.textContent = "Position not saved — retrying as you read";
      }
    }
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
      void rendition?.prev();
      setControlsVisible(false);
    } else if (xRatio > 0.76) {
      void rendition?.next();
      setControlsVisible(false);
    } else {
      setControlsVisible(reader.classList.contains("epub-chrome-hidden"), false);
    }
  }

  function bindContentInteractions(contents) {
    const document = contents.document;
    sanitizeRenderedDocument(document);
    applyDocumentPreferences(document);
    let contentGesture = null;
    document.addEventListener("pointerdown", (event) => { contentGesture = { x: event.clientX, y: event.clientY }; }, { passive: true });
    document.addEventListener("pointerup", (event) => {
      if (!contentGesture || event.target.closest?.("a")) return;
      const deltaX = event.clientX - contentGesture.x;
      const deltaY = event.clientY - contentGesture.y;
      const moved = Math.hypot(deltaX, deltaY) > 12;
      if (!navigateFromGesture(deltaX, deltaY)) handleReaderTap(event.clientX / Math.max(1, contents.window.innerWidth), moved);
      contentGesture = null;
    }, { passive: true });
    document.addEventListener("click", (event) => {
      const link = event.target.closest?.("a[href]");
      if (!link) return;
      const href = link.getAttribute("href") || "";
      if (/^(?:https?:)?\/\//i.test(href) || /^mailto:/i.test(href)) {
        event.preventDefault();
        return;
      }
      if (href && !href.toLowerCase().startsWith("javascript:")) {
        event.preventDefault();
        void rendition?.display(href);
      }
    });
  }

  function bindRendition() {
    rendition.hooks.content.register(bindContentInteractions);
    rendition.on("relocated", (relocation) => {
      const start = relocation?.start || {};
      const progression = updateProgressDisplay(start.cfi, start.percentage ?? relocation?.percentage);
      pendingPosition = { cfi: start.cfi, href: start.href, progression };
      const navigationItem = publication?.navigation?.get?.(start.href);
      chapterTitle.textContent = navigationItem?.label?.trim() || (start.displayed?.page && start.displayed?.total
        ? `Page ${start.displayed.page} of ${start.displayed.total}`
        : "Reading");
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
      const response = await fetch(book.epubUrl, { headers: { Accept: "application/epub+zip" }, cache: "default" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `EPUB could not be loaded (${response.status})`);
      }
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
      for (const entry of navigation.toc || []) {
        const link = node("button", "epub-toc-link", entry.label?.trim() || "Untitled section");
        link.type = "button";
        link.addEventListener("click", () => { toc.close(); void rendition.display(entry.href); });
        tocList.append(link);
      }
      if (!tocList.children.length) tocList.append(node("p", "epub-toc-empty", "This EPUB does not include a table of contents."));
      await rendition.display(currentProgress?.locator || undefined);
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

  settingsPanel.addEventListener("change", (event) => {
    const control = event.target.closest("[data-preference]");
    if (!control) return;
    const key = control.dataset.preference;
    preferences[key] = ["fontSize", "lineHeight", "contentWidth"].includes(key) ? Number(control.value) : control.value;
    void persistPreferences(key).catch((error) => { loading.hidden = false; loading.textContent = error.message; });
  });
  settings.addEventListener("toggle", () => setControlsVisible(true, !settings.open));
  back.addEventListener("click", onExit);
  previous.addEventListener("click", () => rendition?.prev());
  next.addEventListener("click", () => rendition?.next());
  tocButton.addEventListener("click", () => { toc.showModal(); setControlsVisible(true, false); });
  fullscreenButton.addEventListener("click", () => { void toggleFullscreen(); });
  tocClose.addEventListener("click", () => toc.close());
  toc.addEventListener("click", (event) => { if (event.target === toc) toc.close(); });
  toc.addEventListener("close", () => setControlsVisible(true));
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
  stage.addEventListener("pointerdown", (event) => { gestureStart = { x: event.clientX, y: event.clientY }; }, { passive: true });
  stage.addEventListener("pointerup", (event) => {
    if (!gestureStart || event.target.closest("button")) return;
    const deltaX = event.clientX - gestureStart.x;
    const deltaY = event.clientY - gestureStart.y;
    const moved = Math.hypot(deltaX, deltaY) > 12;
    if (!navigateFromGesture(deltaX, deltaY)) handleReaderTap(event.clientX / Math.max(1, stage.clientWidth), moved);
    gestureStart = null;
  }, { passive: true });

  const keyHandler = (event) => {
    if (event.target.closest("input, select, button, summary") || toc.open) return;
    if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
      event.preventDefault();
      void rendition?.next();
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      void rendition?.prev();
    } else if (event.key === "Escape") {
      if (settings.open) settings.open = false;
      else onExit();
    }
  };
  const visibilityHandler = () => {
    if (document.visibilityState === "visible") void requestWakeLock();
    else if (pendingPosition) void savePosition(pendingPosition.cfi, pendingPosition.href, pendingPosition.progression);
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
  window.addEventListener("keydown", keyHandler);
  window.addEventListener("resize", resizeHandler);
  document.addEventListener("visibilitychange", visibilityHandler);

  void requestWakeLock();
  await openPublication();

  return {
    destroy() {
      window.clearTimeout(saveTimer);
      window.clearTimeout(resizeTimer);
      window.clearTimeout(controlsTimer);
      window.removeEventListener("keydown", keyHandler);
      window.removeEventListener("resize", resizeHandler);
      document.removeEventListener("visibilitychange", visibilityHandler);
      if (pendingPosition) void savePosition(pendingPosition.cfi, pendingPosition.href, pendingPosition.progression);
      wakeLock?.release?.().catch(() => {});
      rendition?.destroy();
      publication?.destroy();
      if (toc.open) toc.close();
      destroyed = true;
    },
  };
}
