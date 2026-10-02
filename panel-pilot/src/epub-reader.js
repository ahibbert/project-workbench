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
  let saveTimer = 0;
  let destroyed = false;

  root.replaceChildren();
  const reader = node("section", "epub-reader");
  reader.dataset.theme = preferences.theme;
  const toolbar = node("header", "epub-toolbar");
  const back = node("button", "epub-tool", "‹ Books");
  back.type = "button";
  const title = node("strong", "epub-reader-title", book.title);
  const tocButton = node("button", "epub-tool", "Contents");
  tocButton.type = "button";
  const settings = node("details", "epub-settings");
  const settingsSummary = node("summary", "epub-tool", "Aa");
  const settingsPanel = node("div", "epub-settings-panel");
  settings.append(settingsSummary, settingsPanel);
  toolbar.append(back, title, tocButton, settings);

  const stage = node("div", "epub-stage");
  stage.style.setProperty("--book-content-width", `${preferences.contentWidth}px`);
  const loading = node("div", "epub-reader-state", "Opening EPUB…");
  const viewport = node("div", "epub-viewport");
  const previous = node("button", "epub-page-control epub-previous", "‹");
  previous.type = "button";
  previous.setAttribute("aria-label", "Previous page");
  const next = node("button", "epub-page-control epub-next", "›");
  next.type = "button";
  next.setAttribute("aria-label", "Next page");
  stage.append(viewport, loading, previous, next);

  const footer = node("footer", "epub-footer");
  const location = node("span", "", progress?.progression != null ? `${Math.round(progress.progression * 100)}%` : "Saving exact position");
  footer.append(location);

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
  select("Typeface", "fontFamily", [["publisher", "Publisher"], ["serif", "Serif"], ["sans", "Sans serif"]]);
  select("Text size", "fontSize", [["85", "Small"], ["100", "Default"], ["115", "Large"], ["130", "Larger"], ["150", "Largest"]]);
  select("Line spacing", "lineHeight", [["1.3", "Compact"], ["1.5", "Default"], ["1.8", "Relaxed"], ["2", "Open"]]);
  select("Reading flow", "readingFlow", [["paginated", "Pages"], ["scrolled", "Scroll"]]);
  select("Alignment", "textAlignment", [["start", "Publisher"], ["left", "Left"], ["justify", "Justified"]]);

  function themeRules(theme) {
    const palettes = {
      light: { background: "#fff", color: "#232620", link: "#236c6e" },
      sepia: { background: "#f4ecd8", color: "#40382b", link: "#72552e" },
      dark: { background: "#171918", color: "#e4e5df", link: "#83c8c5" },
    };
    const palette = palettes[theme] || palettes.light;
    return {
      body: {
        "background": `${palette.background} !important`,
        "color": `${palette.color} !important`,
        "font-family": preferences.fontFamily === "publisher" ? "inherit" : preferences.fontFamily === "serif" ? "Georgia, serif !important" : "system-ui, sans-serif !important",
        "line-height": `${preferences.lineHeight} !important`,
        "text-align": `${preferences.textAlignment} !important`,
      },
      "a": { "color": `${palette.link} !important` },
      "img, svg": { "max-width": "100% !important", "height": "auto !important" },
    };
  }

  function applyPreferences() {
    if (!rendition) return;
    reader.dataset.theme = preferences.theme;
    rendition.themes.register("panels-book", themeRules(preferences.theme));
    rendition.themes.select("panels-book");
    rendition.themes.fontSize(`${preferences.fontSize}%`);
    stage.style.setProperty("--book-content-width", `${preferences.contentWidth}px`);
  }

  async function persistPreferences(changedKey) {
    const payload = await jsonRequest("/api/books/preferences", {
      method: "POST",
      body: JSON.stringify(preferences),
    });
    Object.assign(preferences, payload.preferences);
    if (changedKey === "readingFlow") {
      const locator = currentProgress?.locator;
      rendition?.destroy();
      rendition = publication.renderTo(viewport, {
        width: "100%",
        height: "100%",
        flow: preferences.readingFlow === "scrolled" ? "scrolled-doc" : "paginated",
        manager: preferences.readingFlow === "scrolled" ? "continuous" : "default",
        allowScriptedContent: false,
      });
      bindRendition();
      applyPreferences();
      await rendition.display(locator || undefined);
    } else {
      applyPreferences();
    }
  }

  async function savePosition(cfi, href, progression, retry = true) {
    if (destroyed || !cfi?.startsWith("epubcfi(")) return;
    try {
      const payload = await jsonRequest(`/api/books/${book.id}/progress`, {
        method: "POST",
        body: JSON.stringify({
          locatorType: "cfi",
          locator: cfi,
          resourceHref: href || "",
          progression,
          revision: currentProgress?.revision || 0,
        }),
      });
      currentProgress = payload.progress;
    } catch (error) {
      if (retry && error.status === 409 && error.payload?.current) {
        currentProgress = error.payload.current;
        await savePosition(cfi, href, progression, false);
      } else {
        location.textContent = "Position not saved";
      }
    }
  }

  function bindRendition() {
    rendition.hooks.content.register((contents) => sanitizeRenderedDocument(contents.document));
    rendition.on("relocated", (relocation) => {
      const start = relocation?.start || {};
      const progression = safeProgression(start.percentage ?? relocation?.percentage);
      location.textContent = progression == null ? "Exact position saved" : `${Math.round(progression * 100)}%`;
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        void savePosition(start.cfi, start.href, progression);
      }, 650);
    });
  }

  settingsPanel.addEventListener("change", (event) => {
    const control = event.target.closest("[data-preference]");
    if (!control) return;
    const key = control.dataset.preference;
    preferences[key] = ["fontSize", "lineHeight", "contentWidth"].includes(key) ? Number(control.value) : control.value;
    void persistPreferences(key).catch((error) => {
      loading.hidden = false;
      loading.textContent = error.message;
    });
  });

  back.addEventListener("click", onExit);
  previous.addEventListener("click", () => rendition?.prev());
  next.addEventListener("click", () => rendition?.next());
  tocButton.addEventListener("click", () => toc.showModal());
  tocClose.addEventListener("click", () => toc.close());
  toc.addEventListener("click", (event) => {
    if (event.target === toc) toc.close();
  });
  const keyHandler = (event) => {
    if (event.target.closest("input, select, button, summary") || toc.open) return;
    if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
      event.preventDefault();
      void rendition?.next();
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      void rendition?.prev();
    } else if (event.key === "Escape") {
      onExit();
    }
  };
  window.addEventListener("keydown", keyHandler);

  try {
    const response = await fetch(book.epubUrl, { headers: { Accept: "application/epub+zip" }, cache: "default" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `EPUB could not be loaded (${response.status})`);
    }
    const buffer = await response.arrayBuffer();
    if (destroyed) return { destroy() {} };
    publication = ePub(buffer);
    rendition = publication.renderTo(viewport, {
      width: "100%",
      height: "100%",
      flow: preferences.readingFlow === "scrolled" ? "scrolled-doc" : "paginated",
      manager: preferences.readingFlow === "scrolled" ? "continuous" : "default",
      allowScriptedContent: false,
    });
    bindRendition();
    applyPreferences();
    const navigation = await publication.loaded.navigation;
    for (const entry of navigation.toc || []) {
      const link = node("button", "epub-toc-link", entry.label?.trim() || "Untitled section");
      link.type = "button";
      link.addEventListener("click", () => {
        toc.close();
        void rendition.display(entry.href);
      });
      tocList.append(link);
    }
    await rendition.display(progress?.locator || undefined);
    loading.hidden = true;
  } catch (error) {
    loading.hidden = false;
    loading.replaceChildren(node("strong", "", "Could not open this EPUB"), node("span", "", error.message));
    previous.hidden = true;
    next.hidden = true;
  }

  return {
    destroy() {
      destroyed = true;
      window.clearTimeout(saveTimer);
      window.removeEventListener("keydown", keyHandler);
      rendition?.destroy();
      publication?.destroy();
      if (toc.open) toc.close();
    },
  };
}
