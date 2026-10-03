import "./books.css";

export const BOOK_LIBRARY_GROUPS = ["reading", "plan_to_read", "paused", "completed", "dropped", "rereading", "considering"];

export function libraryStatus(book) {
  if (BOOK_LIBRARY_GROUPS.includes(book?.libraryStatus)) return book.libraryStatus;
  const progression = Number(book?.progress?.progression);
  if (Number.isFinite(progression) && progression >= 0.995) return "completed";
  return book?.progress?.locator ? "reading" : "plan_to_read";
}

export function progressLabel(book) {
  const progression = Number(book?.progress?.progression);
  if (Number.isFinite(progression)) return `${Math.round(Math.max(0, Math.min(1, progression)) * 100)}% read`;
  return book?.progress?.locator ? "Return to your exact position" : "Ready to read";
}

export function cardSignature(book) {
  return JSON.stringify({
    id: Number(book.id),
    title: book.title || "",
    authors: Array.isArray(book.authors) ? book.authors : [],
    coverUrl: book.coverUrl || "",
    status: libraryStatus(book),
    progress: book.progress || null,
  });
}

export function createLibraryCard(book, { createCoverButton, navigate, statusLabels, onUpdate }) {
  const card = document.createElement("article");
  card.className = "manga-card library-card book-library-card";
  card.dataset.libraryKey = `book:${book.id}`;
  card.dataset.libraryCardSignature = cardSignature(book);
  const authors = Array.isArray(book.authors) && book.authors.length ? book.authors.join(", ") : "Unknown author";
  const cover = createCoverButton({ thumbnailUrl: book.coverUrl }, {
    title: book.title || "Untitled",
    eyebrow: `EPUB · ${authors}`,
    meta: progressLabel(book),
    directCover: true,
  });
  cover.addEventListener("click", () => navigate("book-detail", { id: book.id }));

  const badges = document.createElement("div");
  badges.className = "manga-card-badges";
  const formatBadge = document.createElement("span");
  formatBadge.className = "manga-card-badge format-badge";
  formatBadge.textContent = "Book";
  const statusBadge = document.createElement("span");
  statusBadge.className = "manga-card-badge muted-badge";
  statusBadge.textContent = statusLabels[libraryStatus(book)] || "Library";
  badges.append(formatBadge, statusBadge);

  const actions = document.createElement("div");
  actions.className = "manga-card-actions";
  const read = document.createElement("button");
  read.type = "button";
  read.textContent = book.progress?.locator ? "Continue" : "Read";
  read.addEventListener("click", () => navigate("book-read", { id: book.id }));
  const details = document.createElement("button");
  details.type = "button";
  details.className = "quiet-card-action";
  details.textContent = "Details";
  details.addEventListener("click", () => navigate("book-detail", { id: book.id }));
  const more = document.createElement("details");
  more.className = "manga-card-more";
  const moreLabel = document.createElement("summary");
  moreLabel.textContent = "More";
  moreLabel.setAttribute("aria-label", `More actions for ${book.title || "book"}`);
  const menu = document.createElement("div");
  menu.className = "manga-card-menu";
  const statusSelect = document.createElement("select");
  statusSelect.className = "library-status-select";
  statusSelect.setAttribute("aria-label", `Library group for ${book.title || "book"}`);
  BOOK_LIBRARY_GROUPS.forEach((status) => {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = statusLabels[status];
    statusSelect.append(option);
  });
  statusSelect.value = libraryStatus(book);
  statusSelect.addEventListener("change", async () => {
    const previous = libraryStatus(book);
    statusSelect.disabled = true;
    statusSelect.setCustomValidity("");
    try {
      const payload = await request(`/api/books/${encodeURIComponent(book.id)}/library-status`, {
        method: "POST",
        body: JSON.stringify({ status: statusSelect.value }),
      });
      await Promise.resolve(onUpdate?.(payload.book));
    } catch (error) {
      statusSelect.value = previous;
      statusSelect.setCustomValidity(error.message);
      statusSelect.reportValidity();
    } finally {
      statusSelect.disabled = false;
    }
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-card-action";
  remove.textContent = "Remove from library";
  remove.addEventListener("click", async () => {
    if (!window.confirm(`Remove “${book.title || "this book"}” from Panels?\n\nThe CWA copy will be kept, but reading progress and the local EPUB cache will be removed.`)) return;
    remove.disabled = true;
    try {
      await request(`/api/books/${encodeURIComponent(book.id)}`, { method: "DELETE" });
      await Promise.resolve(onUpdate?.(null));
    } catch (error) {
      remove.disabled = false;
      remove.setCustomValidity(error.message);
      remove.reportValidity();
    }
  });
  menu.append(statusSelect, details, remove);
  more.append(moreLabel, menu);
  actions.append(read, more);
  card.append(cover, badges, actions);
  return card;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Book service request failed (${response.status})`);
  return payload;
}

export function createBookServicesController({ elements, navigate, onLibraryChange }) {
  const { panel, state, note, testShelfmark, testCwa, sync, findBooks } = elements;
  let status = null;

  function render(message = "") {
    if (!panel) return;
    panel.hidden = false;
    const connected = Boolean(status?.shelfmarkConfigured && status?.cwaConfigured && !status?.syncError);
    state.textContent = connected ? "Connected" : "Needs attention";
    state.dataset.state = connected ? "good" : "pending";
    note.textContent = message || [
      status?.shelfmarkConfigured ? "Shelfmark ready" : "Shelfmark needs server configuration",
      status?.cwaConfigured ? "CWA connected" : "CWA needs server configuration",
      Number.isFinite(status?.books) ? `${status.books} book${status.books === 1 ? "" : "s"} indexed` : "",
      status?.syncError ? `Last sync failed: ${status.syncError}` : "",
    ].filter(Boolean).join(" · ");
  }

  async function refresh() {
    try {
      status = await request("/api/books/status");
      render();
    } catch (error) {
      render(error.message);
    }
  }

  async function test(target, button) {
    button.disabled = true;
    render(`Testing ${target === "cwa" ? "CWA" : "Shelfmark"}…`);
    try {
      await request("/api/books/connections/test", { method: "POST", body: JSON.stringify({ target }) });
      await refresh();
      render(`${target === "cwa" ? "CWA" : "Shelfmark"} connection is healthy.`);
    } catch (error) {
      render(error.message);
    } finally {
      button.disabled = false;
    }
  }

  testShelfmark?.addEventListener("click", () => { void test("shelfmark", testShelfmark); });
  testCwa?.addEventListener("click", () => { void test("cwa", testCwa); });
  sync?.addEventListener("click", async () => {
    sync.disabled = true;
    render("Syncing the CWA library…");
    try {
      await request("/api/books/sync", { method: "POST", body: "{}" });
      await Promise.resolve(onLibraryChange?.());
      await refresh();
      render("Book library synced.");
    } catch (error) {
      render(error.message);
    } finally {
      sync.disabled = false;
    }
  });
  findBooks?.addEventListener("click", () => navigate("books-search"));
  void refresh();
  return { refresh };
}

export function renderBookStats({ panel, count, summary }, books = []) {
  if (!panel || !summary || !count) return;
  panel.hidden = false;
  const started = books.filter((book) => book.progress?.locator);
  const completed = books.filter((book) => libraryStatus(book) === "completed");
  const progressValues = started
    .map((book) => Number(book.progress?.progression))
    .filter(Number.isFinite);
  const average = progressValues.length
    ? Math.round(progressValues.reduce((total, value) => total + value, 0) / progressValues.length * 100)
    : 0;
  count.textContent = `${books.length} book${books.length === 1 ? "" : "s"}`;
  summary.replaceChildren();
  for (const [label, value, note] of [
    ["Started", started.length, "Books with a saved exact position"],
    ["Completed", completed.length, "At least 99.5% read"],
    ["Average progress", `${average}%`, started.length ? "Across books you have opened" : "Open a book to begin"],
  ]) {
    const metric = document.createElement("article");
    metric.className = "book-stats-metric";
    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    const valueNode = document.createElement("strong");
    valueNode.textContent = String(value);
    const noteNode = document.createElement("small");
    noteNode.textContent = note;
    metric.append(labelNode, valueNode, noteNode);
    summary.append(metric);
  }
}
