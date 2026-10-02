import "./books.css";

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

export function createBooksApp({ root, navigate }) {
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
    heading.append(element("h1", "", "Books"), element("p", "view-subtitle", "Your EPUB library from Calibre-Web Automated"));
    const actions = element("div", "books-header-actions");
    const search = element("button", "header-action", "Search");
    search.type = "button";
    search.dataset.booksAction = "search";
    const sync = element("button", "header-action", "Sync");
    sync.type = "button";
    sync.dataset.booksAction = "sync";
    actions.append(search, sync);
    header.append(heading, actions);
    const connection = element("div", "books-connection");
    connection.id = "books-connection";
    const connectionCopy = element("span", "", "Checking book services…");
    connectionCopy.id = "books-connection-copy";
    const connectionActions = element("span", "books-connection-actions");
    for (const [target, label] of [["cwa", "Test CWA"], ["shelfmark", "Test Shelfmark"]]) {
      const button = element("button", "mini-button", label);
      button.type = "button";
      button.dataset.booksAction = `test-${target}`;
      connectionActions.append(button);
    }
    connection.append(connectionCopy, connectionActions);
    const content = element("main", "books-content");
    content.id = "books-content";
    root.append(header, connection, content);
    root.addEventListener("click", (event) => {
      const action = event.target.closest("[data-books-action]")?.dataset.booksAction;
      if (action === "sync") void syncLibrary(event.target.closest("button"));
      if (action === "test-cwa") void testConnection("cwa", event.target.closest("button"));
      if (action === "test-shelfmark") void testConnection("shelfmark", event.target.closest("button"));
      if (action === "select-book") void loadReleases(Number(event.target.closest("button").dataset.resultIndex));
      if (action === "queue-release") void queueRelease(Number(event.target.closest("button").dataset.releaseIndex), event.target.closest("button"));
      if (action === "search") navigate("books-search");
      const card = event.target.closest("[data-book-id]");
      if (card) navigate("book-detail", { id: card.dataset.bookId });
      if (action === "back") navigate("books");
    });
    initialized = true;
  }

  function connectionText() {
    const parts = [
      status?.cwaConfigured ? "CWA connected" : "CWA needs configuration",
      status?.shelfmarkConfigured ? "Shelfmark ready" : "Shelfmark needs configuration",
    ];
    if (status?.syncError) parts.push(`Last sync failed: ${status.syncError}`);
    return parts.join(" · ");
  }

  async function loadStatus() {
    status = await request("/api/books/status");
    const node = root.querySelector("#books-connection");
    root.querySelector("#books-connection-copy").textContent = connectionText();
    node.dataset.state = status.syncError ? "bad" : status.cwaConfigured ? "good" : "pending";
  }

  async function testConnection(target, button) {
    button.disabled = true;
    const copy = root.querySelector("#books-connection-copy");
    copy.textContent = `Testing ${target === "cwa" ? "CWA" : "Shelfmark"}…`;
    try {
      await request("/api/books/connections/test", {
        method: "POST",
        body: JSON.stringify({ target }),
      });
      copy.textContent = `${target === "cwa" ? "CWA" : "Shelfmark"} connection is healthy.`;
      root.querySelector("#books-connection").dataset.state = "good";
    } catch (error) {
      copy.textContent = error.message;
      root.querySelector("#books-connection").dataset.state = "bad";
    } finally {
      button.disabled = false;
    }
  }

  function renderEmpty(content) {
    const empty = element("section", "app-empty-state books-empty");
    empty.append(
      element("strong", "", "No EPUBs in your book library yet"),
      element("span", "", status?.cwaConfigured
        ? "Sync CWA, or search Shelfmark for your first book."
        : "Configure CWA and Shelfmark on the server, then test the connections here."),
    );
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
      const back = element("button", "text-button books-back", "‹ Books");
      back.type = "button";
      back.dataset.booksAction = "back";
      const detail = element("article", "book-detail");
      if (book.coverUrl) {
        const image = element("img", "book-detail-cover");
        image.src = book.coverUrl;
        image.alt = `Cover of ${book.title}`;
        detail.append(image);
      }
      const copy = element("div", "book-detail-copy");
      copy.append(element("p", "book-kicker", "EPUB"), element("h2", "", book.title));
      if (book.subtitle) copy.append(element("p", "book-subtitle", book.subtitle));
      copy.append(element("p", "book-authors", bookByline(book)));
      if (book.description) copy.append(element("p", "book-description", book.description));
      const read = element("button", "primary-button", progress?.locator ? "Continue reading" : "Read book");
      read.type = "button";
      read.disabled = !book.hasEpub;
      read.addEventListener("click", () => navigate("book-read", { id: book.id }));
      copy.append(read);
      detail.append(copy);
      content.replaceChildren(back, detail);
    } catch (error) {
      content.replaceChildren(element("p", "books-error", error.message));
    }
  }

  async function renderReader(id) {
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
      readerController = await module.createEpubReader({
        root: content,
        book,
        progress,
        preferences,
        onExit: () => navigate("book-detail", { id: book.id }),
      });
    } catch (error) {
      if (generation !== readerGeneration) return;
      const back = element("button", "text-button books-back", "‹ Book details");
      back.type = "button";
      back.addEventListener("click", () => navigate("book-detail", { id }));
      content.replaceChildren(back, element("p", "books-error", error.message));
    }
  }

  function leaveReader() {
    readerGeneration += 1;
    readerController?.destroy?.();
    readerController = null;
    document.body.classList.remove("book-reader-active");
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

  async function renderDownloads(container) {
    try {
      const { downloads } = await request("/api/books/downloads");
      container.replaceChildren();
      if (!downloads?.length) return;
      const section = element("section", "books-downloads");
      section.append(element("h2", "", "Acquisition status"));
      for (const download of downloads) {
        const row = element("div", "books-download-row");
        row.dataset.state = download.status;
        const copy = element("span");
        copy.append(element("strong", "", download.title), element("small", "", download.error || downloadLabel(download)));
        row.append(copy);
        if (download.status === "ready" && download.bookId) {
          const read = element("button", "mini-button", "Open");
          read.type = "button";
          read.addEventListener("click", () => navigate("book-detail", { id: download.bookId }));
          row.append(read);
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
    const back = element("button", "text-button books-back", "‹ Books");
    back.type = "button";
    back.dataset.booksAction = "back";
    const panel = element("section", "panel books-search-panel");
    panel.append(element("h2", "", "Find a book"), element("p", "books-search-help", "Search Shelfmark metadata, then choose an EPUB release for CWA to import."));
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
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      results.replaceChildren(element("p", "books-loading", "Searching Shelfmark…"));
      try {
        const payload = await request(`/api/books/search?query=${encodeURIComponent(input.value.trim())}`);
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
    content.replaceChildren(back, panel, downloadHost);
    void renderDownloads(downloadHost);
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
    } catch (error) {
      const node = root.querySelector("#books-connection");
      root.querySelector("#books-connection-copy").textContent = error.message;
      node.dataset.state = "bad";
    } finally {
      if (button) button.disabled = false;
    }
  }

  return {
    async show(route) {
      window.clearTimeout(downloadPoll);
      shell();
      if (route.bookRoute !== "book-read") leaveReader();
      await loadStatus().catch((error) => {
        root.querySelector("#books-connection-copy").textContent = error.message;
      });
      const id = new URLSearchParams(route.bookQuery || "").get("id");
      if (route.bookRoute === "book-detail" && id) return renderDetail(id);
      if (route.bookRoute === "books-search") {
        renderSearch();
        scheduleDownloadPoll();
        return;
      }
      if (route.bookRoute === "book-read" && id) return renderReader(id);
      return renderLibrary();
    },
    hide() {
      window.clearTimeout(downloadPoll);
      leaveReader();
    },
  };
}
