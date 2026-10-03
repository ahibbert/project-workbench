import "./more-like-this.css";

let activeDialog = null;

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function titleOf(item) {
  if (item?.title) return String(item.title);
  const titles = Array.isArray(item?.titles) ? item.titles : [];
  return titles.find((entry) => entry?.language === "en" && entry?.is_primary)?.title
    || titles.find((entry) => entry?.language === "en")?.title
    || titles.find((entry) => entry?.is_primary)?.title
    || titles.map((entry) => typeof entry === "string" ? entry : entry?.title).find(Boolean)
    || "Untitled";
}

function coverOf(item) {
  if (item?.coverUrl) return String(item.coverUrl);
  for (const cover of [item?.cover_image, item?.cover]) {
    for (const candidate of [cover?.x250, cover?.x350, cover?.x150, cover?.raw, cover]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      if (candidate && typeof candidate === "object") {
        const nested = candidate.url || candidate.src || candidate.x1 || candidate.x2;
        if (typeof nested === "string" && nested.trim()) return nested.trim();
      }
    }
  }
  return String(item?.cover_url || item?.thumbnail_url || "").trim();
}

function peopleOf(item) {
  const people = item?.authors || item?.creators || [];
  return (Array.isArray(people) ? people : [people])
    .map((person) => typeof person === "string" ? person : person?.name)
    .filter(Boolean)
    .slice(0, 2)
    .join(", ");
}

function reasonOf(item, seedTitle) {
  const reason = item?.reason || {};
  if (reason.type === "next_in_series") return `Next in ${item?.series?.name || "this series"}`;
  const tags = (reason.top_tags || []).map((tag) => tag?.name).filter(Boolean).slice(0, 2);
  if (tags.length) return `Similar themes: ${tags.join(" and ")}`;
  if (reason.matched_author) return "From the same creator";
  return `Because it is like ${seedTitle}`;
}

function emptyMessage(payload) {
  if (payload?.status === "unconfigured") return "Add your LibraryThing key in Settings to enable related titles.";
  if (payload?.status === "no-match") return "This title could not be matched confidently enough yet.";
  if (payload?.status === "unavailable") return "Recommendations are temporarily unavailable. Try again shortly.";
  return "No strong matches were found for this title yet.";
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
  dialog?.remove();
  if (activeDialog === dialog) activeDialog = null;
}

export async function openMoreLikeThis({ seed, onSelect }) {
  closeDialog(activeDialog);
  const dialog = node("dialog", "more-like-dialog");
  activeDialog = dialog;
  dialog.setAttribute("aria-labelledby", "more-like-title");
  const header = node("header", "more-like-header");
  const heading = node("div");
  const eyebrow = node("span", "more-like-eyebrow", "Related recommendations");
  const title = node("h2", "", `More like ${seed.title || "this"}`);
  title.id = "more-like-title";
  heading.append(eyebrow, title);
  const close = node("button", "more-like-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close recommendations");
  close.addEventListener("click", () => closeDialog(dialog));
  header.append(heading, close);
  const status = node("p", "more-like-status", "Finding the closest matches…");
  status.setAttribute("role", "status");
  const grid = node("div", "more-like-grid");
  dialog.append(header, status, grid);
  document.body.append(dialog);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog(dialog);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  dialog.showModal();

  try {
    const response = await fetch("/api/recommendations/similar", {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ ...seed, limit: 12 }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Recommendation request failed (${response.status})`);
    if (activeDialog !== dialog) return;
    const results = Array.isArray(payload.results) ? payload.results : [];
    status.textContent = results.length
      ? `${results.length} match${results.length === 1 ? "" : "es"}, selected from ${payload.provider === "mangabaka" ? "MangaBaka" : "LibraryThing and Open Library"}.`
      : emptyMessage(payload);
    results.forEach((item) => {
      const card = node("article", "more-like-card");
      const cover = coverOf(item);
      if (cover) {
        const image = node("img", "more-like-cover");
        image.src = cover;
        image.alt = "";
        image.loading = "lazy";
        card.append(image);
      } else {
        card.append(node("span", "more-like-cover more-like-cover-fallback", titleOf(item).slice(0, 1).toUpperCase()));
      }
      const copy = node("div", "more-like-copy");
      copy.append(node("strong", "", titleOf(item)));
      const people = peopleOf(item);
      if (people) copy.append(node("small", "", people));
      copy.append(node("small", "more-like-reason", reasonOf(item, payload.seedTitle || seed.title)));
      const action = node("button", "more-like-action", seed.mediaFormat === "book" ? "Find this book" : "Find a source");
      action.type = "button";
      action.addEventListener("click", () => {
        closeDialog(dialog);
        onSelect?.(item);
      });
      card.append(copy, action);
      grid.append(card);
    });
  } catch (error) {
    if (activeDialog !== dialog) return;
    status.textContent = error.message || "Recommendations could not be loaded.";
    status.classList.add("error");
  }
}

