const OFFLINE_BOOK_CACHE = "panels-offline-books-v1";
const OFFLINE_BOOK_INDEX = "panel-pilot:offline-books:v1";

function accountKey(accountId = "") {
  return String(accountId || "local").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "local";
}

function readIndex() {
  try {
    const parsed = JSON.parse(localStorage.getItem(OFFLINE_BOOK_INDEX) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeIndex(index) {
  localStorage.setItem(OFFLINE_BOOK_INDEX, JSON.stringify(index));
}

export function offlineEpubUrl(epubUrl, accountId = "") {
  const url = new URL(epubUrl, location.origin);
  if (url.origin !== location.origin || !/^\/api\/books\/\d+\/epub$/.test(url.pathname)) {
    throw new Error("Offline books require a same-origin Panel Pilot EPUB URL.");
  }
  url.searchParams.set("offlineAccount", accountKey(accountId));
  return `${url.pathname}${url.search}`;
}

export function offlineBookRecord(bookId, accountId = "") {
  const account = readIndex()[accountKey(accountId)] || {};
  return account[String(bookId)] || null;
}

export function listOfflineBooks(accountId = "") {
  const account = readIndex()[accountKey(accountId)] || {};
  return Object.values(account)
    .filter((record) => record?.book?.id && record.epubUrl)
    .sort((left, right) => String(right.savedAt || "").localeCompare(String(left.savedAt || "")));
}

export async function offlineBookStatus(book, accountId = "") {
  if (!book?.id || !book.epubUrl || !("caches" in window)) return { available: false, byteSize: 0 };
  const epubUrl = offlineEpubUrl(book.epubUrl, accountId);
  const cache = await caches.open(OFFLINE_BOOK_CACHE);
  const response = await cache.match(epubUrl);
  const record = offlineBookRecord(book.id, accountId);
  return { available: Boolean(response && record), byteSize: Number(record?.byteSize || 0), savedAt: record?.savedAt || "" };
}

export async function saveOfflineBook({ book, preferences, progress, accountId = "" }) {
  if (!book?.id || !book.epubUrl) throw new Error("This book does not have a downloadable EPUB.");
  if (!("caches" in window)) throw new Error("Offline book storage is not supported in this browser.");
  const epubUrl = offlineEpubUrl(book.epubUrl, accountId);
  const response = await fetch(epubUrl, {
    method: "GET",
    credentials: "same-origin",
    cache: "reload",
    headers: { Accept: "application/epub+zip" },
  });
  if (!response.ok) throw new Error(`The EPUB could not be downloaded (${response.status}).`);
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("epub")) throw new Error("The server did not return an EPUB file.");
  const byteSize = Math.max(0, Number(response.headers.get("Content-Length") || 0));
  const cache = await caches.open(OFFLINE_BOOK_CACHE);
  await cache.put(epubUrl, response.clone());
  const index = readIndex();
  const key = accountKey(accountId);
  index[key] ||= {};
  index[key][String(book.id)] = {
    schemaVersion: 1,
    book: { ...book, epubUrl },
    preferences: { ...preferences },
    progress: progress ? { ...progress } : null,
    epubUrl,
    byteSize,
    savedAt: new Date().toISOString(),
  };
  writeIndex(index);
  return { available: true, byteSize, epubUrl, savedAt: index[key][String(book.id)].savedAt };
}

export function updateOfflineBookRecord({ book, preferences, progress, accountId = "" }) {
  const index = readIndex();
  const key = accountKey(accountId);
  const current = index[key]?.[String(book?.id || "")];
  if (!current) return false;
  index[key][String(book.id)] = {
    ...current,
    book: { ...current.book, ...book, epubUrl: current.epubUrl },
    preferences: { ...current.preferences, ...preferences },
    progress: progress ? { ...progress } : current.progress,
  };
  writeIndex(index);
  return true;
}

export async function removeOfflineBook(book, accountId = "") {
  const index = readIndex();
  const key = accountKey(accountId);
  const record = index[key]?.[String(book?.id || "")];
  const epubUrl = record?.epubUrl || (book?.epubUrl ? offlineEpubUrl(book.epubUrl, accountId) : "");
  if (epubUrl && "caches" in window) {
    const cache = await caches.open(OFFLINE_BOOK_CACHE);
    await cache.delete(epubUrl);
  }
  if (index[key]) {
    delete index[key][String(book?.id || "")];
    if (!Object.keys(index[key]).length) delete index[key];
    writeIndex(index);
  }
  return { available: false };
}

export const OFFLINE_BOOK_CACHE_NAME = OFFLINE_BOOK_CACHE;
