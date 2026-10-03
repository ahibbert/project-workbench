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
  let downloadPoll = 0;
  let readerController = null;
  let readerGeneration = 0;

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
      content.replaceChildren(element("p", "books-error", error.message));
    }
  }

  async function renderDetail(id) {
    const content = root.querySelector("#books-content");
    content.replaceChildren(element("p", "books-loading", "Loading book…"));
    try {
      const { book, progress } = await request(`/api/books/${encodeURIComponent(id)}`);
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
          await Promise.resolve(onLibraryChange());
          navigate("library");
        } catch (error) {
          remove.disabled = false;
          remove.setCustomValidity(error.message);
          remove.reportValidity();
        }
      });
      const actions = element("div", "book-detail-actions detail-actions");
      actions.append(read, remove);
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
      content.replaceChildren(back, detail, about, controls, contents);
      if (!book.description && !metadata.length) about.hidden = true;
      if (!book.hasEpub) {
        contentsList.replaceChildren(element("p", "books-empty-result", "This book does not currently have a readable EPUB."));
        return;
      }
      try {
        const module = await import("./epub-reader.js");
        const navigation = await module.loadEpubNavigation(book.epubUrl);
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
      const [{ book, progress }, { preferences }, module] = await Promise.all([
        request(`/api/books/${encodeURIComponent(id)}`),
        request("/api/books/preferences"),
        import("./epub-reader.js"),
      ]);
      if (generation !== readerGeneration) return;
      readerController?.destroy?.();
      const createdReader = await module.createEpubReader({
        root: content,
        book,
        progress,
        preferences,
        initialHref,
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
      queued: "Queued in Shelfmark",
      downloading: "Downloading",
      importing: "Waiting for CWA import",
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
    if (download.error) return download.error;
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
      section.append(element("h2", "", "Acquisition activity"));
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

  function renderSearch() {
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
    panel.append(element("h2", "", "Find a book"), element("p", "books-search-help", "Search for a title or author, then choose the EPUB edition you want to add."));
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
      results.replaceChildren(element("p", "books-loading", "Searching Shelfmark…"));
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
          result.dataset.booksAction = "select-book";
          result.dataset.resultIndex = index;
          const copy = element("span");
          copy.append(element("strong", "", book.title), element("small", "", [bookByline(book), book.publishedDate, book.language].filter(Boolean).join(" · ")));
          result.append(copy, element("span", "", "Choose ›"));
          results.append(result);
        });
      } catch (error) {
        results.replaceChildren(element("p", "books-error", error.message));
      } finally {
        submit.disabled = false;
      }
    });
    panel.append(form, results);
    const downloadHost = element("div");
    downloadHost.id = "books-downloads-container";
    content.replaceChildren(mediaSwitch, recommendations, panel, downloadHost);
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
        const readThis = element("button", "mini-button", "Read this");
        readThis.type = "button";
        readThis.addEventListener("click", () => {
          input.value = recommendation.title;
          recommendedQuery = recommendation.identifiers?.isbn?.[0]
            || [recommendation.title, recommendation.authors?.[0]].filter(Boolean).join(" ");
          form.requestSubmit();
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        card.append(copy, readThis);
        recommendationRail.append(card);
      });
    }).catch((error) => {
      recommendationRail.replaceChildren(element("p", "books-error", error.message));
    });
    input.focus({ preventScroll: true });
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
      const payload = await request(`/api/books/releases?provider=${encodeURIComponent(selectedBook.provider)}&bookId=${encodeURIComponent(selectedBook.providerBookId)}`);
      releaseResults = payload.releases || [];
      results.replaceChildren();
      const heading = element("div", "books-release-heading");
      heading.append(element("strong", "", selectedBook.title), element("span", "", `${releaseResults.length} EPUB release${releaseResults.length === 1 ? "" : "s"}`));
      results.append(heading);
      if (!releaseResults.length) {
        results.append(element("p", "books-empty-result", "Shelfmark found no EPUB releases for this edition. Try another metadata result."));
        return;
      }
      releaseResults.forEach((release, releaseIndex) => {
        const row = element("div", "book-release-row");
        const copy = element("span");
        copy.append(
          element("strong", "", release.title || `${selectedBook.title} EPUB`),
          element("small", "", [release.source, release.language || "Language unknown", humanSize(release.sizeBytes), Number.isFinite(release.seeders) ? `${release.seeders} seeders` : ""].filter(Boolean).join(" · ")),
        );
        const add = element("button", "primary-button", "Add to Library");
        add.type = "button";
        add.dataset.booksAction = "queue-release";
        add.dataset.releaseIndex = releaseIndex;
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
        ? "Search Shelfmark and add an EPUB to your library"
        : detail ? "Your text library" : "Your EPUB library from Calibre-Web Automated";
      actions.hidden = searching || detail || route.bookRoute === "book-read";
      if (route.bookRoute !== "book-read") leaveReader();
      await loadStatus().catch(() => { status = null; });
      const id = new URLSearchParams(route.bookQuery || "").get("id");
      const initialHref = new URLSearchParams(route.bookQuery || "").get("href") || "";
      if (route.bookRoute === "book-detail" && id) return renderDetail(id);
      if (route.bookRoute === "books-search") {
        renderSearch();
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
