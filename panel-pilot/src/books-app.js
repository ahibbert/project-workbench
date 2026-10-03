import "./books.css";
import { BOOK_LIBRARY_GROUPS, libraryStatus } from "./books-integration.js";

const BOOK_LIBRARY_GROUP_LABELS = {
  reading: "Reading",
  plan_to_read: "Plan to read",
  paused: "Paused",
  completed: "Completed",
  dropped: "Dropped",
  rereading: "Rereading",
  considering: "Considering",
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Books request failed (${response.status})`);
  return payload;
}

function bookByline(book) {
  return book.authors?.length ? book.authors.join(", ") : "Unknown author";
}

export function createBooksApp({ root, navigate, onLibraryChange = () => {} }) {
  let initialized = false;
  let status = null;
  let searchResults = [];
  let selectedBook = null;
  let releaseResults = [];
  let alternativeTitle = "";
  let downloadPoll = 0;
  let readerController = null;
  let readerGeneration = 0;
  const accountId = () => document.body.dataset.accountNamespace || "";

  function shell() {
    if (initialized) return;
    root.replaceChildren();
    const header = element("header", "view-header books-header");
    const heading = element("div");
    const headingTitle = element("h1", "", "Books");
    headingTitle.id = "books-heading-title";
    const headingSubtitle = element("p", "view-subtitle", "Your EPUB library from Calibre-Web Automated");
    headingSubtitle.id = "books-heading-subtitle";
    heading.append(headingTitle, headingSubtitle);
    const actions = element("div", "books-header-actions");
    actions.id = "books-header-actions";
    const search = element("button", "header-action", "Search");
    search.type = "button";
    search.dataset.booksAction = "search";
    const sync = element("button", "header-action", "Sync");
    sync.type = "button";
    sync.dataset.booksAction = "sync";
    actions.append(search, sync);
    header.append(heading, actions);
    const content = element("main", "books-content");
    content.id = "books-content";
    root.append(header, content);
    root.addEventListener("click", (event) => {
      const action = event.target.closest("[data-books-action]")?.dataset.booksAction;
      if (action === "sync") void syncLibrary(event.target.closest("button"));
      if (action === "select-book") void loadReleases(Number(event.target.closest("button").dataset.resultIndex));
      if (action === "queue-release") void queueRelease(Number(event.target.closest("button").dataset.releaseIndex), event.target.closest("button"));
      if (action === "search") navigate("books-search");
      if (action === "settings") navigate("settings");
      const card = event.target.closest("[data-book-id]");
      if (card) navigate("book-detail", { id: card.dataset.bookId });
      if (action === "back") navigate("library");
      if (action === "back-browse") navigate("browse");
    });
    initialized = true;
  }

  async function loadStatus() {
    status = await request("/api/books/status");
  }

  function renderEmpty(content) {
    const empty = element("section", "app-empty-state books-empty");
    empty.append(
      element("strong", "", "No EPUBs in your book library yet"),
      element("span", "", status?.cwaConfigured
        ? "Sync CWA, or search Shelfmark for your first book."
        : "Configure CWA and Shelfmark, then test them under Book services in Settings."),
    );
    const action = element("button", "primary-button", status?.cwaConfigured ? "Find a book" : "Open Book services");
    action.type = "button";
    action.dataset.booksAction = status?.cwaConfigured ? "search" : "settings";
    empty.append(action);
    content.append(empty);
  }

  async function renderLibrary() {
    const content = root.querySelector("#books-content");
    content.replaceChildren(element("p", "books-loading", "Loading books…"));
    try {
      const payload = await request("/api/books?limit=200");
      content.replaceChildren();
      if (!payload.books.length) {
        renderEmpty(content);
        return;
      }
      const continuing = payload.books
        .filter((book) => book.progress?.locator)
        .sort((left, right) => String(right.progress.updatedAt).localeCompare(String(left.progress.updatedAt)));
      if (continuing.length) {
        const section = element("section", "books-continue");
        section.append(element("h2", "", "Continue Reading"));
        const recent = continuing[0];
        const resume = element("button", "book-continue-card");
        resume.type = "button";
        resume.addEventListener("click", () => navigate("book-read", { id: recent.id }));
        const copy = element("span");
        copy.append(element("strong", "", recent.title), element("small", "", recent.progress.progression == null ? "Return to your exact position" : `${Math.round(recent.progress.progression * 100)}% read`));
        resume.append(copy, element("span", "", "Continue ›"));
        section.append(resume);
        content.append(section);
      }
      const summary = element("p", "books-summary", `${payload.total} book${payload.total === 1 ? "" : "s"}`);
      const grid = element("div", "books-grid");
      for (const book of payload.books) {
        const button = element("button", "book-card");
        button.type = "button";
        button.dataset.bookId = book.id;
        if (book.coverUrl) {
          const image = element("img", "book-cover");
          image.src = book.coverUrl;
          image.alt = "";
          image.loading = "lazy";
          button.append(image);
        } else {
          button.append(element("span", "book-cover book-cover-fallback", book.title.slice(0, 1).toUpperCase()));
        }
        const copy = element("span", "book-card-copy");
        copy.append(element("strong", "", book.title), element("small", "", bookByline(book)));
        if (book.progress?.locator) {
          copy.append(element("small", "book-card-progress", book.progress.progression == null ? "In progress" : `${Math.round(book.progress.progression * 100)}% read`));
        }
        button.append(copy);
        grid.append(button);
      }
      content.append(summary, grid);
    } catch (error) {
      const { listOfflineBooks } = await import("./book-offline.js");
      const offline = listOfflineBooks(accountId()).map((record) => ({
        ...record.book, progress: record.progress, offlineAvailable: true,
      }));
      if (!offline.length) {
        content.replaceChildren(element("p", "books-error", error.message));
        return;
      }
      content.replaceChildren(element("p", "books-offline-note", "Offline library · showing books downloaded on this device"));
      const grid = element("div", "books-grid");
      offline.forEach((book) => {
        const button = element("button", "book-card");
        button.type = "button";
        button.dataset.bookId = book.id;
        button.append(element("span", "book-cover book-cover-fallback", book.title.slice(0, 1).toUpperCase()));
        const copy = element("span", "book-card-copy");
        copy.append(element("strong", "", book.title), element("small", "", `${bookByline(book)} · Offline`));
        button.append(copy);
        grid.append(button);
      });
      content.append(grid);
    }
  }

  async function renderDetail(id) {
    const content = root.querySelector("#books-content");
    content.replaceChildren(element("p", "books-loading", "Loading book…"));
    try {
      const offlineModule = await import("./book-offline.js");
      let detailPayload;
      try {
        detailPayload = await request(`/api/books/${encodeURIComponent(id)}`);
      } catch (error) {
        const record = offlineModule.offlineBookRecord(id, accountId());
        if (!record) throw error;
        detailPayload = { book: record.book, progress: record.progress, series: null };
      }
      const { book, progress, series } = detailPayload;
      const back = element("button", "text-button books-back", "‹ Library");
      back.type = "button";
      back.dataset.booksAction = "back";
      const detail = element("article", "book-detail media-detail");
      const cover = element("div", "book-detail-cover detail-cover");
      cover.style.setProperty("--cover-hue", String([...book.title].reduce((total, character) => total + character.codePointAt(0), 0) % 360));
      if (book.coverUrl) {
        const image = element("img");
        image.src = book.coverUrl;
        image.alt = `Cover of ${book.title}`;
        cover.append(image);
      } else {
        cover.append(element("span", "", book.title.slice(0, 2).toUpperCase()));
      }
      const copy = element("div", "book-detail-copy");
      const progressLabel = progress?.progression == null ? "EPUB" : `EPUB · ${Math.round(progress.progression * 100)}% read`;
      copy.append(element("p", "book-kicker detail-source", progressLabel), element("h2", "", book.title));
      if (book.subtitle) copy.append(element("p", "book-subtitle", book.subtitle));
      copy.append(element("p", "book-authors", bookByline(book)));
      const read = element("button", "primary-button", progress?.locator ? "Continue reading" : "Read book");
      read.type = "button";
      read.disabled = !book.hasEpub;
      read.addEventListener("click", () => navigate("book-read", { id: book.id }));
      const group = element("label", "book-library-group");
      group.append(element("span", "", "Library group"));
      const groupSelect = element("select", "library-status-select");
      groupSelect.setAttribute("aria-label", "Library group");
      BOOK_LIBRARY_GROUPS.forEach((status) => {
        const option = element("option", "", BOOK_LIBRARY_GROUP_LABELS[status]);
        option.value = status;
        groupSelect.append(option);
      });
      groupSelect.value = libraryStatus(book);
      groupSelect.addEventListener("change", async () => {
        const previous = libraryStatus(book);
        groupSelect.disabled = true;
        groupSelect.setCustomValidity("");
        try {
          const payload = await request(`/api/books/${encodeURIComponent(book.id)}/library-status`, {
            method: "POST",
            body: JSON.stringify({ status: groupSelect.value }),
          });
          Object.assign(book, payload.book);
          groupSelect.value = libraryStatus(book);
          await Promise.resolve(onLibraryChange());
        } catch (error) {
          groupSelect.value = previous;
          groupSelect.setCustomValidity(error.message);
          groupSelect.reportValidity();
        } finally {
          groupSelect.disabled = false;
        }
      });
      group.append(groupSelect);
      const remove = element("button", "danger-button book-remove-button", "Remove from library");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Remove “${book.title}” from Panels?\n\nThe CWA copy will be kept, but reading progress and the local EPUB cache will be removed.`)) return;
        remove.disabled = true;
        try {
          await request(`/api/books/${encodeURIComponent(book.id)}`, { method: "DELETE" });
          await offlineModule.removeOfflineBook(book, accountId()).catch(() => null);
          await Promise.resolve(onLibraryChange());
          navigate("library");
        } catch (error) {
          remove.disabled = false;
          remove.setCustomValidity(error.message);
          remove.reportValidity();
        }
      });
      const moreLike = element("button", "", "More like this");
      moreLike.type = "button";
      moreLike.addEventListener("click", async () => {
        moreLike.disabled = true;
        try {
          const { openMoreLikeThis } = await import("./more-like-this.js");
          await openMoreLikeThis({
            seed: { mediaFormat: "book", bookId: book.id, title: book.title },
            onSelect: (recommendation) => navigate("books-search", {
              query: recommendation.title,
              isbn: recommendation.identifiers?.isbn?.[0] || "",
            }),
          });
        } finally {
          moreLike.disabled = false;
        }
      });
      const offline = element("button", "", "Checking offline copy…");
      offline.type = "button";
      offline.disabled = true;
      let offlineState = await offlineModule.offlineBookStatus(book, accountId()).catch(() => ({ available: false }));
      const renderOfflineAction = () => {
        offline.disabled = false;
        offline.textContent = offlineState.available ? "Remove offline copy" : "Download for offline";
      };
      renderOfflineAction();
      offline.addEventListener("click", async () => {
        offline.disabled = true;
        offline.textContent = offlineState.available ? "Removing…" : "Downloading…";
        try {
          if (offlineState.available) {
            offlineState = await offlineModule.removeOfflineBook(book, accountId());
          } else {
            const preferenceProfile = await request(`/api/books/${encodeURIComponent(book.id)}/preferences`);
            offlineState = await offlineModule.saveOfflineBook({
              book, progress, preferences: preferenceProfile.preferences, accountId: accountId(),
            });
          }
          renderOfflineAction();
          await Promise.resolve(onLibraryChange());
        } catch (error) {
          renderOfflineAction();
          offline.setCustomValidity(error.message);
          offline.reportValidity();
        }
      });
      const actions = element("div", "book-detail-actions detail-actions");
      actions.append(read, offline, moreLike, remove);
      copy.append(actions);
      detail.append(cover, copy);

      const about = element("section", "media-about book-about");
      const aboutHeading = element("div", "media-about-heading");
      aboutHeading.append(element("h3", "", "About this book"));
      const metadata = [
        book.seriesName ? `${book.seriesName}${book.seriesPosition == null ? "" : ` #${book.seriesPosition}`}` : "",
        book.publisher,
        book.publishedDate,
        book.language ? String(book.language).toUpperCase() : "",
      ].filter(Boolean);
      aboutHeading.append(element("span", "media-about-meta", metadata.join(" · ")));
      about.append(aboutHeading);
      if (book.description) about.append(element("p", "media-description book-description", book.description));
      const controls = element("div", "chapter-controls book-detail-controls");
      controls.append(group);

      let seriesPanel = null;
      if (series?.items?.length > 1 || series?.missingPositions?.length) {
        seriesPanel = element("section", "book-series-panel");
        const heading = element("div", "book-series-heading");
        heading.append(
          element("h3", "", series.name),
          element("span", "", `${series.items.length} known volume${series.items.length === 1 ? "" : "s"}`),
        );
        seriesPanel.append(heading);
        if (series.missingPositions?.length) {
          seriesPanel.append(element("p", "book-series-gaps", `Missing from the shared catalogue: volume ${series.missingPositions.join(", ")}`));
        }
        const list = element("div", "book-series-list");
        series.items.forEach((item) => {
          const row = element("div", `book-series-item${item.id === book.id ? " current" : ""}`);
          const label = element("div");
          label.append(
            element("strong", "", `${item.seriesPosition == null ? "" : `${item.seriesPosition}. `}${item.title}`),
            element("small", "", item.id === book.id ? "Current book" : item.inLibrary ? BOOK_LIBRARY_GROUP_LABELS[item.libraryStatus] || "In library" : "In the household catalogue"),
          );
          const action = element("button", "mini-button", item.id === book.id ? "Current" : item.inLibrary ? "Open" : "Add");
          action.type = "button";
          action.disabled = item.id === book.id;
          action.addEventListener("click", async () => {
            action.disabled = true;
            try {
              if (!item.inLibrary) await request(`/api/books/${encodeURIComponent(item.id)}/library`, { method: "POST", body: "{}" });
              await Promise.resolve(onLibraryChange());
              navigate("book-detail", { id: item.id });
            } catch (error) {
              action.disabled = false;
              action.setCustomValidity(error.message);
              action.reportValidity();
            }
          });
          row.append(label, action);
          list.append(row);
        });
        seriesPanel.append(list);
      }

      const contents = element("section", "book-contents");
      const contentsHeading = element("div", "book-contents-heading");
      contentsHeading.append(
        element("h3", "", "Contents"),
        element("span", "", progress?.locator ? "Choose a section or continue from your saved place" : "Choose where to begin"),
      );
      const contentsList = element("nav", "book-contents-list");
      contentsList.setAttribute("aria-label", `Contents of ${book.title}`);
      contentsList.append(element("p", "books-loading", "Loading book contents…"));
      contents.append(contentsHeading, contentsList);
      content.replaceChildren(back, detail, about, controls, ...(seriesPanel ? [seriesPanel] : []), contents);
      if (!book.description && !metadata.length) about.hidden = true;
      if (!book.hasEpub) {
        contentsList.replaceChildren(element("p", "books-empty-result", "This book does not currently have a readable EPUB."));
        return;
      }
      try {
        const module = await import("./epub-reader.js");
        const navigationUrl = offlineState.available
          ? offlineModule.offlineEpubUrl(book.epubUrl, accountId())
          : book.epubUrl;
        const navigation = await module.loadEpubNavigation(navigationUrl);
        contentsList.replaceChildren();
        module.renderEpubToc(navigation, contentsList, (href) => navigate("book-read", { id: book.id, href }));
        if (!contentsList.children.length) {
          contentsList.append(element("p", "books-empty-result", "This EPUB does not include a table of contents. You can still read it from the beginning."));
        }
      } catch (error) {
        contentsList.replaceChildren(element("p", "books-error", error.message));
      }
    } catch (error) {
      content.replaceChildren(element("p", "books-error", error.message));
    }
  }

  async function renderReader(id, initialHref = "") {
    const generation = ++readerGeneration;
    document.body.classList.add("book-reader-active");
    const content = root.querySelector("#books-content");
    content.replaceChildren(element("div", "epub-reader-state books-reader-loading", "Preparing reader…"));
    try {
      const [module, offlineModule] = await Promise.all([import("./epub-reader.js"), import("./book-offline.js")]);
      let detailPayload;
      let preferenceProfile;
      try {
        [detailPayload, preferenceProfile] = await Promise.all([
          request(`/api/books/${encodeURIComponent(id)}`),
          request(`/api/books/${encodeURIComponent(id)}/preferences`),
        ]);
      } catch (error) {
        const offlineRecord = offlineModule.offlineBookRecord(id, accountId());
        if (!offlineRecord) throw error;
        detailPayload = { book: offlineRecord.book, progress: offlineRecord.progress };
        preferenceProfile = {
          preferences: offlineRecord.preferences,
          scope: "book",
          scopeLabel: offlineRecord.book.title,
        };
      }
      const { progress } = detailPayload;
      const offlineRecord = offlineModule.offlineBookRecord(id, accountId());
      const book = offlineRecord
        ? { ...detailPayload.book, epubUrl: offlineRecord.epubUrl }
        : detailPayload.book;
      offlineModule.updateOfflineBookRecord({
        book, progress, preferences: preferenceProfile.preferences, accountId: accountId(),
      });
      if (generation !== readerGeneration) return;
      readerController?.destroy?.();
      const createdReader = await module.createEpubReader({
        root: content,
        book,
        progress,
        preferences: preferenceProfile.preferences,
        preferenceScope: preferenceProfile,
        initialHref,
        accountId: accountId(),
        onExit: () => navigate("book-detail", { id: book.id }),
      });
      if (generation !== readerGeneration) {
        createdReader?.destroy?.();
        return;
      }
      readerController = createdReader;
    } catch (error) {
      if (generation !== readerGeneration) return;
      const back = element("button", "text-button books-back", "‹ Book details");
      back.type = "button";
      back.addEventListener("click", () => navigate("book-detail", { id }));
      content.replaceChildren(back, element("p", "books-error", error.message));
    }
  }

  function leaveReader() {
    const hadReader = Boolean(readerController);
    readerGeneration += 1;
    readerController?.destroy?.();
    readerController = null;
    document.body.classList.remove("book-reader-active");
    if (hadReader) void onLibraryChange();
  }

  function humanSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "Size unknown";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  function downloadLabel(download) {
    return {
      queued: "Queued",
      downloading: "Downloading",
      importing: "Adding to your library",
      ready: "In library",
      failed: "Failed",
      cancelled: "Cancelled",
    }[download.status] || download.status;
  }

  function isRecentReady(download, now = Date.now()) {
    if (download.status !== "ready") return false;
    const updated = Date.parse(download.updatedAt || "");
    return Number.isFinite(updated) && now - updated >= 0 && now - updated <= 60 * 60 * 1000;
  }

  function acquisitionDetail(download) {
    if (download.error) return [download.error, download.errorAction].filter(Boolean).join(" ");
    if (download.status === "ready") return "Added recently";
    if (download.status === "downloading" && Number.isFinite(Number(download.progress))) {
      const percent = Math.round(Math.max(0, Math.min(1, Number(download.progress))) * 100);
      return `${downloadLabel(download)} · ${percent}%`;
    }
    return downloadLabel(download);
  }

  async function renderDownloads(container) {
    try {
      const { downloads } = await request("/api/books/downloads");
      container.replaceChildren();
      const visibleDownloads = (downloads || []).filter((download) => (
        ["queued", "downloading", "importing", "failed"].includes(download.status)
        || isRecentReady(download)
      )).slice(0, 8);
      if (!visibleDownloads.length) return;
      const section = element("section", "books-downloads");
      // This is deliberately a reader-facing summary rather than a Shelfmark/CWA
      // dashboard. Individual states still describe the actual work in progress.
      section.append(element("h2", "", "Book activity"));
      for (const download of visibleDownloads) {
        const row = element("div", "books-download-row");
        row.dataset.state = download.status;
        const copy = element("span");
        copy.append(element("strong", "", download.title), element("small", "", acquisitionDetail(download)));
        row.append(copy);
        if (download.status === "ready" && download.bookId) {
          const read = element("button", "mini-button", "Open");
          read.type = "button";
          read.addEventListener("click", () => navigate("book-detail", { id: download.bookId }));
          row.append(read);
        } else if (download.status === "failed") {
          const findAnother = element("button", "mini-button", "Find another release");
          findAnother.type = "button";
          findAnother.addEventListener("click", () => {
            const searchInput = root.querySelector(".books-search-form input");
            if (!searchInput) return;
            searchInput.value = download.title;
            alternativeTitle = download.title;
            searchInput.form?.requestSubmit();
            searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
          });
          row.append(findAnother);
        } else {
          row.append(element("span", "book-status-pill", downloadLabel(download)));
        }
        section.append(row);
      }
      container.append(section);
    } catch {
      // A Shelfmark outage is reflected in connection state and must not hide search.
    }
  }

  function renderSearch(bookQuery = "") {
    const content = root.querySelector("#books-content");
    const mediaSwitch = element("div", "browse-media-switch");
    mediaSwitch.setAttribute("role", "group");
    mediaSwitch.setAttribute("aria-label", "What do you want to find?");
    const mangaMode = element("button", "", "Manga & comics");
    mangaMode.type = "button";
    mangaMode.setAttribute("aria-pressed", "false");
    mangaMode.dataset.booksAction = "back-browse";
    const bookMode = element("button", "", "Books");
    bookMode.type = "button";
    bookMode.setAttribute("aria-pressed", "true");
    mediaSwitch.append(mangaMode, bookMode);
    const recommendations = element("section", "book-recommendations");
    const recommendationHeading = element("div", "book-recommendations-heading");
    recommendationHeading.append(
      element("div", "", "Books for you"),
      element("small", "", "Personalized from books you have read"),
    );
    const recommendationRail = element("div", "recommendation-rail book-recommendation-rail");
    recommendationRail.append(element("p", "books-loading", "Finding book recommendations…"));
    recommendations.append(recommendationHeading, recommendationRail);
    const panel = element("section", "panel books-search-panel");
    panel.append(element("h2", "", "Find a book"), element("p", "books-search-help", "Search by title or author, then choose the EPUB edition you want to read."));
    const form = element("form", "books-search-form");
    const input = element("input");
    input.type = "search";
    input.name = "query";
    input.placeholder = "The Mercy of Gods";
    input.autocomplete = "off";
    input.minLength = 2;
    input.required = true;
    input.setAttribute("aria-label", "Book title or author");
    const submit = element("button", "primary-button", "Search");
    submit.type = "submit";
    form.append(input, submit);
    const results = element("div", "books-search-results");
    results.id = "books-search-results";
    let recommendedQuery = "";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      results.replaceChildren(element("p", "books-loading", "Finding editions…"));
      try {
        const query = recommendedQuery || input.value.trim();
        recommendedQuery = "";
        const payload = await request(`/api/books/search?query=${encodeURIComponent(query)}`);
        searchResults = payload.books || [];
        selectedBook = null;
        releaseResults = [];
        results.replaceChildren();
        if (!searchResults.length) {
          results.append(element("p", "books-empty-result", "No matching metadata was found."));
        }
        searchResults.forEach((book, index) => {
          const result = element("button", "book-search-result");
          result.type = "button";
          const copy = element("span");
          copy.append(element("strong", "", book.title), element("small", "", [bookByline(book), book.publishedDate, book.language].filter(Boolean).join(" · ")));
          const existing = Number(book.catalogBookId || 0);
          result.append(copy, element("span", "", book.inLibrary ? "In library" : existing ? "Add to library ›" : "Choose an edition ›"));
          result.disabled = Boolean(book.inLibrary);
          if (existing && !book.inLibrary) {
            result.addEventListener("click", async () => {
              result.disabled = true;
              try {
                const added = await request(`/api/books/${encodeURIComponent(existing)}/library`, { method: "POST", body: "{}" });
                await Promise.resolve(onLibraryChange());
                navigate("book-detail", { id: added.book.id });
              } catch (error) {
                result.disabled = false;
                results.prepend(element("p", "books-error", error.message));
              }
            });
          } else if (!book.inLibrary) {
            result.dataset.booksAction = "select-book";
            result.dataset.resultIndex = index;
          }
          results.append(result);
        });
        if (alternativeTitle && searchResults.length) {
          const wanted = alternativeTitle.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          const exactIndex = searchResults.findIndex((book) => (
            String(book.title || "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === wanted
          ));
          alternativeTitle = "";
          await loadReleases(exactIndex >= 0 ? exactIndex : 0);
        }
      } catch (error) {
        alternativeTitle = "";
        results.replaceChildren(element("p", "books-error", error.message));
      } finally {
        submit.disabled = false;
      }
    });
    panel.append(form, results);
    const downloadHost = element("div");
    downloadHost.id = "books-downloads-container";
    // Choosing a book is the primary Browse task. Recommendations remain close
    // by, but never force a mobile reader to scroll past a horizontal rail before
    // they can search for a title they already have in mind.
    content.replaceChildren(mediaSwitch, panel, recommendations, downloadHost);
    void renderDownloads(downloadHost);
    void request("/api/book-recommendations?limit=12").then((payload) => {
      recommendationRail.replaceChildren();
      if (payload.status === "unconfigured") {
        recommendationRail.append(element("p", "books-empty-result", "Add your LibraryThing key in Settings to enable book recommendations."));
        return;
      }
      if (payload.status === "needs-library") {
        recommendationRail.append(element("p", "books-empty-result", "Finish or start a book to personalize this list."));
        return;
      }
      if (!payload.results?.length) {
        recommendationRail.append(element("p", "books-empty-result", "No new matches right now. Try refreshing after reading another book."));
        return;
      }
      payload.results.forEach((recommendation) => {
        const card = element("article", "recommendation-card book-recommendation-card");
        if (recommendation.coverUrl) {
          const cover = element("img");
          cover.src = recommendation.coverUrl;
          cover.alt = "";
          cover.loading = "lazy";
          card.append(cover);
        } else {
          card.append(element("span", "book-recommendation-fallback", recommendation.title.slice(0, 1).toUpperCase()));
        }
        const copy = element("div", "book-recommendation-copy");
        copy.append(element("strong", "", recommendation.title));
        copy.append(element("small", "", recommendation.authors?.join(", ") || "Unknown author"));
        const reason = recommendation.reason?.type === "next_in_series"
          ? `Next in ${recommendation.series?.name || "your series"}`
          : recommendation.reason?.seedTitles?.length ? `Because you read ${recommendation.reason.seedTitles[0]}` : "Selected for your library";
        copy.append(element("small", "book-recommendation-reason", reason));
        const findEdition = element("button", "mini-button", "Find this book");
        findEdition.type = "button";
        findEdition.addEventListener("click", () => {
          input.value = recommendation.title;
          recommendedQuery = recommendation.identifiers?.isbn?.[0]
            || [recommendation.title, recommendation.authors?.[0]].filter(Boolean).join(" ");
          form.requestSubmit();
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        card.append(copy, findEdition);
        recommendationRail.append(card);
      });
    }).catch((error) => {
      recommendationRail.replaceChildren(element("p", "books-error", error.message));
    });
    // Do not focus on entry: focusing a search input immediately opens the iOS
    // keyboard and hides the recommendations before the reader has chosen to search.
    const initial = new URLSearchParams(bookQuery);
    const initialQuery = initial.get("query")?.trim() || "";
    if (initialQuery) {
      input.value = initialQuery;
      recommendedQuery = initial.get("isbn")?.trim() || initialQuery;
      queueMicrotask(() => form.requestSubmit());
    }
  }

  function scheduleDownloadPoll() {
    downloadPoll = window.setTimeout(async () => {
      const container = root.querySelector("#books-downloads-container");
      if (!container || !location.hash.startsWith("#books-search")) return;
      await renderDownloads(container);
      scheduleDownloadPoll();
    }, 10_000);
  }

  async function loadReleases(index) {
    selectedBook = searchResults[index];
    if (!selectedBook) return;
    const results = root.querySelector("#books-search-results");
    results.replaceChildren(element("p", "books-loading", `Finding EPUB releases for ${selectedBook.title}…`));
    try {
      const releaseQuery = new URLSearchParams({
        provider: selectedBook.provider,
        bookId: selectedBook.providerBookId,
        title: selectedBook.title || "",
      });
      (selectedBook.authors || []).slice(0, 3).forEach((author) => releaseQuery.append("author", author));
      const payload = await request(`/api/books/releases?${releaseQuery}`);
      releaseResults = payload.releases || [];
      results.replaceChildren();
      const heading = element("div", "books-release-heading");
      const untriedCount = releaseResults.filter((release) => !release.attemptStatus).length;
      const countCopy = `${releaseResults.length} EPUB record${releaseResults.length === 1 ? "" : "s"}`
        + (untriedCount ? ` · ${untriedCount} untried` : releaseResults.length ? " · all previously tried" : "");
      heading.append(element("strong", "", selectedBook.title), element("span", "", countCopy));
      results.append(heading);
      if (!releaseResults.length) {
        results.append(element("p", "books-empty-result", "Shelfmark found no EPUB releases for this edition. Try another metadata result."));
        return;
      }
      if (!untriedCount) {
        results.append(element(
          "p",
          "books-empty-result books-release-note",
          releaseResults.length === 1
            ? "Shelfmark currently indexes only this EPUB record, and its configured mirrors could not retrieve it. You can retry later or search for another edition."
            : "Every indexed EPUB record has already been tried. You can retry a specific record or search for another edition.",
        ));
      } else if (untriedCount < releaseResults.length) {
        results.append(element("p", "books-release-note", "Untried EPUB records are shown first. Failed records remain available for a later retry."));
      }
      releaseResults.forEach((release, releaseIndex) => {
        const row = element("div", "book-release-row");
        if (release.attemptStatus) row.dataset.attemptStatus = release.attemptStatus;
        const copy = element("span", "book-release-copy");
        const titleLine = element("span", "book-release-title");
        titleLine.append(
          element("strong", "", release.title || `${selectedBook.title} EPUB`),
          element("span", `book-release-rank${release.recommendation === "Recommended" ? " is-recommended" : ""}`, release.recommendation || "Alternative"),
        );
        const edition = [release.publisher, release.publishedYear].filter(Boolean).join(", ");
        const attempt = release.attemptStatus === "failed"
          ? (release.attemptError || "A previous download attempt failed")
          : release.attemptStatus ? `Already ${downloadLabel({ status: release.attemptStatus }).toLocaleLowerCase()}` : "Untried";
        const reliability = release.sourceReliability || {};
        const sourceHistory = Number(reliability.attempts) > 0
          ? `${reliability.successes}/${reliability.attempts} successful here`
          : "not yet tested here";
        copy.append(
          titleLine,
          element("small", "", [
            release.catalogSource || release.source, edition, release.language || "Language unknown",
            humanSize(release.sizeBytes), Number.isFinite(release.downloads) ? `${release.downloads.toLocaleString()} downloads` : "",
            `${release.score ?? "–"}/100`, sourceHistory, attempt,
          ].filter(Boolean).join(" · ")),
        );
        if (Array.isArray(release.scoreReasons) && release.scoreReasons.length) {
          copy.append(element("small", "book-release-reasons", release.scoreReasons.join(" · ")));
        }
        if (release.attemptStatus === "failed" && release.attemptErrorAction) {
          copy.append(element("small", "book-release-action", release.attemptErrorAction));
        }
        const add = element("button", release.attemptStatus ? "mini-button" : "primary-button", release.attemptStatus === "failed" ? "Try this EPUB again" : "Get this EPUB");
        add.type = "button";
        add.dataset.booksAction = "queue-release";
        add.dataset.releaseIndex = releaseIndex;
        add.disabled = ["queued", "downloading", "importing", "ready"].includes(release.attemptStatus);
        row.append(copy, add);
        results.append(row);
      });
    } catch (error) {
      results.replaceChildren(element("p", "books-error", error.message));
    }
  }

  async function queueRelease(index, button) {
    const release = releaseResults[index];
    if (!release || !selectedBook) return;
    button.disabled = true;
    button.textContent = "Queueing…";
    try {
      await request("/api/books/downloads", {
        method: "POST",
        body: JSON.stringify({ releaseToken: release.token, bookToken: selectedBook.token }),
      });
      renderSearch();
    } catch (error) {
      button.disabled = false;
      button.textContent = "Try again";
      const failure = element("p", "books-error", error.message);
      button.parentElement.append(failure);
    }
  }

  async function syncLibrary(button) {
    if (button) button.disabled = true;
    try {
      await request("/api/books/sync", { method: "POST", body: "{}" });
      await loadStatus();
      await renderLibrary();
      void onLibraryChange();
    } catch (error) {
      root.querySelector("#books-content")?.prepend(element("p", "books-error", error.message));
    } finally {
      if (button) button.disabled = false;
    }
  }

  return {
    async show(route) {
      window.clearTimeout(downloadPoll);
      shell();
      const heading = root.querySelector("#books-heading-title");
      const subtitle = root.querySelector("#books-heading-subtitle");
      const actions = root.querySelector("#books-header-actions");
      const searching = route.bookRoute === "books-search";
      const detail = route.bookRoute === "book-detail";
      heading.textContent = searching ? "Browse books" : detail ? "Book details" : "Books";
      subtitle.textContent = searching
        ? "Find an EPUB edition to add to your library"
        : detail ? "Your text library" : "Your EPUB library from Calibre-Web Automated";
      actions.hidden = searching || detail || route.bookRoute === "book-read";
      if (route.bookRoute !== "book-read") leaveReader();
      await loadStatus().catch(() => { status = null; });
      const id = new URLSearchParams(route.bookQuery || "").get("id");
      const initialHref = new URLSearchParams(route.bookQuery || "").get("href") || "";
      if (route.bookRoute === "book-detail" && id) return renderDetail(id);
      if (route.bookRoute === "books-search") {
        renderSearch(route.bookQuery || "");
        scheduleDownloadPoll();
        return;
      }
      if (route.bookRoute === "book-read" && id) return renderReader(id, initialHref);
      return renderLibrary();
    },
    hide() {
      window.clearTimeout(downloadPoll);
      leaveReader();
    },
  };
}
