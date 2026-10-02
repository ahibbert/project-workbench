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
      const { book } = await request(`/api/books/${encodeURIComponent(id)}`);
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
      const read = element("button", "primary-button", "Read book");
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

  function renderSearchPlaceholder() {
    const content = root.querySelector("#books-content");
    const back = element("button", "text-button books-back", "‹ Books");
    back.type = "button";
    back.dataset.booksAction = "back";
    const panel = element("section", "panel books-search-placeholder");
    panel.append(element("h2", "", "Find a book"), element("p", "", "Shelfmark search and EPUB release selection arrive in the next phase."));
    content.replaceChildren(back, panel);
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
      shell();
      await loadStatus().catch((error) => {
        root.querySelector("#books-connection-copy").textContent = error.message;
      });
      const id = new URLSearchParams(route.bookQuery || "").get("id");
      if (route.bookRoute === "book-detail" && id) return renderDetail(id);
      if (route.bookRoute === "books-search") return renderSearchPlaceholder();
      if (route.bookRoute === "book-read") return renderDetail(id);
      return renderLibrary();
    },
  };
}
