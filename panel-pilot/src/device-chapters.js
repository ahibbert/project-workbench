const DEVICE_LIBRARY_DB = "panels-device-library";
const DEVICE_LIBRARY_VERSION = 1;
const DEVICE_CHAPTER_STORE = "chapters";
const OPERATION_LEASE_MS = 120_000;
const OPERATION_HEARTBEAT_MS = 20_000;

export const DEVICE_CHAPTER_CACHE = "panels-device-chapters-v1";
export const DEVICE_CHAPTER_PATH_PREFIX = "/__panels_device_chapters/v1/";

let databasePromise = null;
let baseInitializationPromise = null;
let maintenancePromise = null;
let operationChannel = null;
const activeDownloads = new Set();
const activeOperations = new Map();
const ownerId = createOperationId("tab");

function requireBrowserApi(name) {
  const value = globalThis[name];
  if (!value) throw new Error(`${name} is not available in this browser.`);
  return value;
}

function createOperationId(prefix) {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return `${prefix}-${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === "function") {
    const values = cryptoApi.getRandomValues(new Uint32Array(4));
    return `${prefix}-${Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("")}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeServerUrl(serverUrl) {
  const value = String(serverUrl || "").trim();
  if (!value) throw new TypeError("A serverUrl is required.");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("serverUrl must be an absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("serverUrl must use HTTP or HTTPS.");
  }
  parsed.hash = "";
  if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  else parsed.pathname = "";
  return parsed.href.replace(/\/$/, "");
}

function normalizeIdentifier(value, label) {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new TypeError(`${label} is required.`);
  }
  return String(value);
}

export function deviceChapterKey(serverUrl, chapterId) {
  return JSON.stringify([
    normalizeServerUrl(serverUrl),
    normalizeIdentifier(chapterId, "chapterId"),
  ]);
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB request failed.")), { once: true });
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("IndexedDB transaction was aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error || new Error("IndexedDB transaction failed.")), { once: true });
  });
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const indexedDB = requireBrowserApi("indexedDB");
    const request = indexedDB.open(DEVICE_LIBRARY_DB, DEVICE_LIBRARY_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DEVICE_CHAPTER_STORE)) database.createObjectStore(DEVICE_CHAPTER_STORE, { keyPath: "key" });
    });
    request.addEventListener("success", () => {
      const database = request.result;
      database.addEventListener("versionchange", () => {
        database.close();
        databasePromise = null;
      });
      resolve(database);
    }, { once: true });
    request.addEventListener("error", () => {
      databasePromise = null;
      reject(request.error || new Error("Could not open the device chapter library."));
    }, { once: true });
    request.addEventListener("blocked", () => {
      databasePromise = null;
      reject(new Error("The device chapter library is blocked by another open Panel Pilot tab."));
    }, { once: true });
  });
  return databasePromise;
}

async function getAllRecords() {
  const database = await openDatabase();
  const transaction = database.transaction(DEVICE_CHAPTER_STORE, "readonly");
  const result = await requestResult(transaction.objectStore(DEVICE_CHAPTER_STORE).getAll());
  await transactionComplete(transaction);
  return result;
}

async function getRecord(key) {
  const database = await openDatabase();
  const transaction = database.transaction(DEVICE_CHAPTER_STORE, "readonly");
  const result = await requestResult(transaction.objectStore(DEVICE_CHAPTER_STORE).get(key));
  await transactionComplete(transaction);
  return result || null;
}

function updateRecordAtomically(key, updater) {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(DEVICE_CHAPTER_STORE, "readwrite");
    const store = transaction.objectStore(DEVICE_CHAPTER_STORE);
    const request = store.get(key);
    let updaterError = null;
    let result;
    request.addEventListener("success", () => {
      try {
        const mutation = updater(request.result || null) || {};
        result = mutation.result;
        if (mutation.delete) store.delete(key);
        else if (Object.prototype.hasOwnProperty.call(mutation, "record")) store.put(mutation.record);
      } catch (error) {
        updaterError = error;
        transaction.abort();
      }
    }, { once: true });
    request.addEventListener("error", () => {
      updaterError = request.error || new Error("Could not read device chapter metadata.");
    }, { once: true });
    transaction.addEventListener("complete", () => resolve(result), { once: true });
    transaction.addEventListener("abort", () => reject(updaterError || transaction.error || new Error("Device chapter metadata update was aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(updaterError || transaction.error || new Error("Device chapter metadata update failed.")), { once: true });
  }));
}

function cloneMetadata(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function publicMetadata(record) {
  const copy = cloneMetadata(record);
  if (!copy) return copy;
  delete copy.lease;
  delete copy.pendingDownload;
  delete copy.replacementError;
  return copy;
}

function now() {
  return new Date().toISOString();
}

function cachePathFor(key, pageIndex, generation = "") {
  const generationPart = generation ? `${encodeURIComponent(generation)}/` : "";
  return `${DEVICE_CHAPTER_PATH_PREFIX}${encodeURIComponent(key)}/${generationPart}${pageIndex}`;
}

function chapterCachePrefix(key) {
  return `${DEVICE_CHAPTER_PATH_PREFIX}${encodeURIComponent(key)}/`;
}

function operationCachePrefix(key, operationId) {
  return `${chapterCachePrefix(key)}${encodeURIComponent(operationId)}/`;
}

function cacheRequest(cachePath) {
  const pageLocation = globalThis.location;
  if (!pageLocation?.origin || pageLocation.origin === "null") {
    throw new Error("A same-origin page is required to manage device chapters.");
  }
  return new Request(new URL(cachePath, pageLocation.origin).href, {
    method: "GET",
    credentials: "same-origin",
  });
}

function pathFromCacheRequest(request) {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "";
  }
}

function isImageContentType(contentType) {
  return /^image\//i.test(String(contentType || "").trim());
}

async function inspectCachedPage(cache, cachePath) {
  if (typeof cachePath !== "string" || !cachePath.startsWith(DEVICE_CHAPTER_PATH_PREFIX)) return null;
  const response = await cache.match(cacheRequest(cachePath));
  if (!response || !response.ok) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!isImageContentType(contentType)) return null;
  const blob = await response.clone().blob();
  if (!blob.size) return null;
  return { contentType, size: blob.size };
}

function serializableValue(value) {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  return String(value);
}

function descriptorMetadata(descriptor) {
  if (!descriptor || typeof descriptor !== "object") throw new TypeError("A chapter descriptor is required.");
  const serverUrl = normalizeServerUrl(descriptor.serverUrl);
  const chapterIdKey = normalizeIdentifier(descriptor.chapterId, "chapterId");
  const pageUrls = Array.isArray(descriptor.pageUrls) ? descriptor.pageUrls.map((url, index) => {
    const value = String(url || "").trim();
    if (!value) throw new TypeError(`pageUrls[${index}] is empty.`);
    return value;
  }) : [];
  if (!pageUrls.length) throw new TypeError("The chapter descriptor must include at least one page URL.");
  return {
    key: deviceChapterKey(serverUrl, chapterIdKey), serverUrl,
    chapterId: serializableValue(descriptor.chapterId), mangaId: serializableValue(descriptor.mangaId),
    title: String(descriptor.title ?? descriptor.mangaTitle ?? ""), sourceId: serializableValue(descriptor.sourceId),
    sourceLabel: String(descriptor.sourceLabel ?? ""), thumbnailUrl: String(descriptor.thumbnailUrl ?? ""),
    chapterTitle: String(descriptor.chapterTitle ?? ""), chapterNumber: serializableValue(descriptor.chapterNumber ?? descriptor.number),
    chapterOrder: serializableValue(descriptor.chapterOrder ?? descriptor.order), scanlator: String(descriptor.scanlator ?? ""), pageUrls,
  };
}

function sortRecords(records) { return records.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))); }
function errorDetails(error, code) { return { code, name: String(error?.name || "Error"), message: String(error?.message || error || "Unknown device chapter error.") }; }
function invalidState(message) { const error = new Error(message); error.name = "InvalidStateError"; return error; }
function isAbortError(error, signal) { return signal?.aborted || error?.name === "AbortError"; }
function isQuotaExceededError(error) { return error?.name === "QuotaExceededError" || error?.code === 22 || error?.code === 1014; }

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  try { return new DOMException("The device chapter download was paused.", "AbortError"); }
  catch { const error = new Error("The device chapter download was paused."); error.name = "AbortError"; return error; }
}

function throwIfAborted(signal) { if (signal?.aborted) throw abortError(signal); }

function reportProgress(onProgress, record, pageIndex = null) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress({ status: record.status, completed: Number(record.downloadedPages) || 0, total: Number(record.totalPages) || 0, pageIndex, chapter: publicMetadata(record) });
  } catch { /* UI progress reporting must never stop a device download. */ }
}

function newLease(kind, operationId) {
  const timestamp = Date.now();
  return { ownerId, operationId, kind, heartbeatAt: timestamp, expiresAt: timestamp + OPERATION_LEASE_MS };
}

function leaseIsActive(lease, timestamp = Date.now()) {
  return Boolean(lease && typeof lease.ownerId === "string" && typeof lease.operationId === "string" && Number(lease.expiresAt) > timestamp);
}

function leaseMatches(record, lease) {
  return Boolean(record?.lease && record.lease.ownerId === lease.ownerId && record.lease.operationId === lease.operationId && record.lease.kind === lease.kind);
}

function leaseSnapshotIsCurrent(currentLease, snapshot) {
  if (!snapshot) return !leaseIsActive(currentLease);
  return Boolean(
    currentLease
    && currentLease.ownerId === snapshot.ownerId
    && currentLease.operationId === snapshot.operationId
    && currentLease.kind === snapshot.kind
    && currentLease.heartbeatAt === snapshot.heartbeatAt
    && currentLease.expiresAt === snapshot.expiresAt,
  );
}

function getOperationChannel() {
  if (operationChannel !== null) return operationChannel || null;
  const BroadcastChannelApi = globalThis.BroadcastChannel;
  if (typeof BroadcastChannelApi !== "function") {
    operationChannel = false;
    return null;
  }
  operationChannel = new BroadcastChannelApi("panels-device-library-operations-v1");
  operationChannel.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type !== "PROBE_OPERATION" || message.ownerId !== ownerId) return;
    if (activeOperations.get(message.key) !== message.operationId) return;
    operationChannel.postMessage({
      type: "OPERATION_ALIVE",
      probeId: message.probeId,
      ownerId,
      key: message.key,
      operationId: message.operationId,
    });
  });
  return operationChannel;
}

async function leaseOwnerIsAlive(key, lease) {
  if (!leaseIsActive(lease)) return false;
  if (lease.ownerId === ownerId) return activeOperations.get(key) === lease.operationId;
  const channel = getOperationChannel();
  if (!channel) return true;
  const probeId = createOperationId("probe");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      channel.removeEventListener("message", onMessage);
      resolve(alive);
    };
    const onMessage = (event) => {
      const message = event.data;
      if (message?.type === "OPERATION_ALIVE" && message.probeId === probeId) finish(true);
    };
    const timer = globalThis.setTimeout(() => finish(false), 300);
    channel.addEventListener("message", onMessage);
    channel.postMessage({
      type: "PROBE_OPERATION",
      probeId,
      ownerId: lease.ownerId,
      key,
      operationId: lease.operationId,
    });
  });
}

function assertAvailableLease(record, key) {
  if (!leaseIsActive(record?.lease)) return;
  if (record.lease.ownerId === ownerId && activeOperations.get(key) !== record.lease.operationId) return;
  throw invalidState(record.lease.kind === "remove" ? "This chapter is being removed in another tab." : "This chapter is already downloading in another tab.");
}

function refreshedLease(lease) {
  const timestamp = Date.now();
  return { ...lease, heartbeatAt: timestamp, expiresAt: timestamp + OPERATION_LEASE_MS };
}

function startLeaseHeartbeat(key, lease) {
  const timer = globalThis.setInterval(() => {
    void updateRecordAtomically(key, (record) => {
      if (!leaseMatches(record, lease)) return { result: false };
      return { record: { ...record, lease: refreshedLease(lease) }, result: true };
    }).catch(() => {});
  }, OPERATION_HEARTBEAT_MS);
  return () => globalThis.clearInterval(timer);
}

async function deleteCachePaths(cache, prefix, keepPaths = null) {
  const requests = await cache.keys();
  for (const request of requests) {
    const path = pathFromCacheRequest(request);
    if (!path.startsWith(prefix) || keepPaths?.has(path)) continue;
    await cache.delete(request);
  }
}

async function deleteChapterCache(cache, key) { await deleteCachePaths(cache, chapterCachePrefix(key)); }
async function deleteOperationCache(cache, key, operationId) { await deleteCachePaths(cache, operationCachePrefix(key, operationId)); }

function mergeDownloadRecord(descriptor, existing) {
  const timestamp = now();
  return { ...descriptor, pages: [], status: "downloading", totalPages: descriptor.pageUrls.length, downloadedPages: 0,
    createdAt: existing?.createdAt || timestamp, updatedAt: timestamp, readyAt: null, error: null };
}

async function acquireDownloadLease(metadata, operationId) {
  return updateRecordAtomically(metadata.key, (existing) => {
    assertAvailableLease(existing, metadata.key);
    if (existing?.status === "removing") throw invalidState("This chapter is still being removed. Try again shortly.");
    const lease = newLease("download", operationId);
    const working = mergeDownloadRecord(metadata, existing);
    const preserveReady = existing?.status === "ready";
    const stored = preserveReady ? { ...existing, lease, pendingDownload: working } : { ...working, lease };
    return { record: stored, result: { existing: cloneMetadata(existing), lease, preserveReady, working } };
  });
}

async function persistWorkingRecord(key, lease, working, preserveReady) {
  working.updatedAt = now();
  await updateRecordAtomically(key, (current) => {
    if (!leaseMatches(current, lease)) throw invalidState("The device download is now owned by another tab.");
    const activeLease = refreshedLease(lease);
    return { record: preserveReady ? { ...current, lease: activeLease, pendingDownload: cloneMetadata(working) } : { ...cloneMetadata(working), lease: activeLease } };
  });
}

async function finishDownloadRecord(key, lease, readyRecord) {
  await updateRecordAtomically(key, (current) => {
    if (!leaseMatches(current, lease)) throw invalidState("The device download is now owned by another tab.");
    return { record: { ...cloneMetadata(readyRecord), lease: refreshedLease(lease) } };
  });
}

async function releaseReadyLease(key, lease) {
  return updateRecordAtomically(key, (current) => {
    if (!leaseMatches(current, lease)) return { result: publicMetadata(current) };
    const released = { ...current };
    delete released.lease; delete released.pendingDownload; delete released.replacementError;
    return { record: released, result: publicMetadata(released) };
  });
}

async function preserveReadyAfterFailure(key, lease, error) {
  return updateRecordAtomically(key, (current) => {
    if (!leaseMatches(current, lease)) return { result: publicMetadata(current) };
    const restored = { ...current, replacementError: errorDetails(error, "replacement-failed") };
    delete restored.lease; delete restored.pendingDownload;
    return { record: restored, result: publicMetadata(restored) };
  });
}

async function persistIncompleteAfterFailure(key, lease, working, error, signal) {
  const paused = isAbortError(error, signal);
  const quotaExceeded = isQuotaExceededError(error);
  const incomplete = { ...cloneMetadata(working), status: paused ? "paused" : "failed", updatedAt: now(), readyAt: null,
    error: errorDetails(error, paused ? "paused" : quotaExceeded ? "quota-exceeded" : "download-failed") };
  return updateRecordAtomically(key, (current) => {
    if (!leaseMatches(current, lease)) return { result: publicMetadata(current) };
    return { record: incomplete, result: publicMetadata(incomplete) };
  });
}

async function reconcileExistingPages(cache, working, previous) {
  const previousPages = Array.isArray(previous?.pages) ? previous.pages : [];
  const previousPageUrls = Array.isArray(previous?.pageUrls) ? previous.pageUrls : [];
  const pages = [];
  for (let index = 0; index < working.pageUrls.length; index += 1) {
    const sourceUrl = working.pageUrls[index];
    const previousSourceUrl = previousPages[index]?.sourceUrl ?? previousPageUrls[index];
    if (previousSourceUrl !== sourceUrl) continue;
    const cachePath = previousPages[index]?.cacheUrl || cachePathFor(working.key, index);
    if (!cachePath.startsWith(chapterCachePrefix(working.key))) continue;
    const cached = await inspectCachedPage(cache, cachePath);
    if (!cached) continue;
    pages[index] = { index, sourceUrl, cacheUrl: cachePath, contentType: cached.contentType, size: cached.size, completedAt: previousPages[index]?.completedAt || now() };
  }
  working.pages = pages;
  working.downloadedPages = pages.filter(Boolean).length;
}

async function storeFetchedPage(cache, cachePath, sourceUrl, signal) {
  throwIfAborted(signal);
  const response = await requireBrowserApi("fetch")(sourceUrl, { signal });
  if (!response.ok) throw new Error(`Page download failed with HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") || "";
  if (!isImageContentType(contentType)) throw new TypeError(`Page download returned ${contentType || "an unknown content type"}, not an image.`);
  const blob = await response.blob();
  if (!blob.size) throw new Error("Page download returned an empty image.");
  throwIfAborted(signal);
  const headers = new Headers({ "Cache-Control": "private, no-store", "Content-Length": String(blob.size), "Content-Type": contentType, "X-Content-Type-Options": "nosniff" });
  await cache.put(cacheRequest(cachePath), new Response(blob, { status: 200, statusText: "OK", headers }));
  const verified = await inspectCachedPage(cache, cachePath);
  if (!verified) { await cache.delete(cacheRequest(cachePath)); throw new Error("The downloaded page could not be verified in device storage."); }
  return verified;
}

async function verifyCompleteRecord(cache, record) {
  const pages = [];
  for (let index = 0; index < record.pageUrls.length; index += 1) {
    const cachePath = record.pages[index]?.cacheUrl;
    const verified = await inspectCachedPage(cache, cachePath);
    if (!verified) return false;
    pages[index] = { ...(record.pages[index] || {}), index, sourceUrl: record.pageUrls[index], cacheUrl: cachePath,
      contentType: verified.contentType, size: verified.size, completedAt: record.pages[index]?.completedAt || now() };
  }
  record.pages = pages; record.downloadedPages = pages.length;
  return true;
}

async function recoverInterruptedRecord(record, cache) {
  if (await leaseOwnerIsAlive(record.key, record.lease) || record.status === "removing") return;
  if (record.status === "ready" && record.pendingDownload) {
    const operationId = record.lease?.operationId;
    if (operationId) { try { await deleteOperationCache(cache, record.key, operationId); } catch { /* later removal clears staged pages */ } }
    await updateRecordAtomically(record.key, (current) => {
      if (!leaseSnapshotIsCurrent(current?.lease, record.lease)) return { result: false };
      const restored = { ...current, replacementError: { code: "interrupted", name: "InterruptedDownload", message: "The replacement download was interrupted; the previous copy is still ready." } };
      delete restored.lease; delete restored.pendingDownload;
      return { record: restored, result: true };
    });
    return;
  }
  if (record.status === "downloading") {
    await updateRecordAtomically(record.key, (current) => {
      if (!leaseSnapshotIsCurrent(current?.lease, record.lease)) return { result: false };
      const paused = { ...current, status: "paused", updatedAt: now(), error: { code: "interrupted", name: "InterruptedDownload", message: "The previous device download was interrupted and can be resumed." } };
      delete paused.lease; delete paused.pendingDownload;
      return { record: paused, result: true };
    });
    return;
  }
  if (record.lease) {
    await updateRecordAtomically(record.key, (current) => {
      if (!leaseSnapshotIsCurrent(current?.lease, record.lease)) return { result: false };
      const released = { ...current }; delete released.lease;
      return { record: released, result: true };
    });
  }
}

async function finishRemovalWithLease(record, cache, lease) {
  try {
    await deleteChapterCache(cache, record.key);
    const removed = await updateRecordAtomically(record.key, (current) => {
      if (!current) return { result: true };
      if (!leaseMatches(current, lease)) return { result: false };
      return { delete: true, result: true };
    });
    if (!removed) throw invalidState("The chapter removal is now owned by another tab.");
    return true;
  } catch (error) {
    await updateRecordAtomically(record.key, (current) => {
      if (!leaseMatches(current, lease)) return { result: false };
      const retryable = { ...current, status: "removing", updatedAt: now(), error: errorDetails(error, "removal-failed") };
      delete retryable.lease;
      return { record: retryable, result: false };
    }).catch(() => {});
    throw error;
  }
}

async function resumeInterruptedRemoval(record, cache) {
  if (await leaseOwnerIsAlive(record.key, record.lease)) return;
  const operationId = createOperationId("remove-recovery");
  const lease = newLease("remove", operationId);
  activeOperations.set(record.key, operationId);
  let stopHeartbeat = () => {};
  try {
    const acquired = await updateRecordAtomically(record.key, (current) => {
      if (!current || current.status !== "removing" || !leaseSnapshotIsCurrent(current.lease, record.lease)) return { result: null };
      return { record: { ...current, lease, error: null, updatedAt: now() }, result: cloneMetadata(current) };
    });
    if (!acquired) return;
    stopHeartbeat = startLeaseHeartbeat(record.key, lease);
    try { await finishRemovalWithLease(acquired, cache, lease); }
    catch { /* Keep retryable; the next initialization attempts removal again. */ }
  } finally {
    stopHeartbeat();
    if (activeOperations.get(record.key) === operationId) activeOperations.delete(record.key);
  }
}

async function revalidateReadyRecord(record, cache) {
  if (record.status !== "ready" || leaseIsActive(record.lease)) return;
  const totalPages = Number(record.totalPages) || record.pageUrls?.length || 0;
  const recordedPages = Array.isArray(record.pages) ? record.pages : [];
  const survivingPages = [];
  for (let index = 0; index < totalPages; index += 1) {
    const cachePath = recordedPages[index]?.cacheUrl || cachePathFor(record.key, index);
    if (!cachePath.startsWith(chapterCachePrefix(record.key))) continue;
    const verified = await inspectCachedPage(cache, cachePath);
    if (!verified) continue;
    survivingPages[index] = { ...(recordedPages[index] || {}), index, sourceUrl: record.pageUrls?.[index] || recordedPages[index]?.sourceUrl || "",
      cacheUrl: cachePath, contentType: verified.contentType, size: verified.size, completedAt: recordedPages[index]?.completedAt || now() };
  }
  if (totalPages > 0 && survivingPages.filter(Boolean).length === totalPages) return;
  await updateRecordAtomically(record.key, (current) => {
    if (!current || current.status !== "ready" || leaseIsActive(current.lease)) return { result: false };
    if (current.updatedAt !== record.updatedAt || current.readyAt !== record.readyAt) return { result: false };
    const incomplete = { ...current, pages: survivingPages, status: "paused", downloadedPages: survivingPages.filter(Boolean).length,
      updatedAt: now(), readyAt: null, error: { code: "cache-missing", name: "MissingDeviceMedia", message: "One or more saved pages are missing from device storage. Resume the download to repair it." } };
    delete incomplete.lease; delete incomplete.pendingDownload;
    return { record: incomplete, result: true };
  });
}

async function runMaintenance() {
  const cache = await caches.open(DEVICE_CHAPTER_CACHE);
  for (const record of await getAllRecords()) {
    if (record?.status === "removing") await resumeInterruptedRemoval(record, cache);
    else if (record) await recoverInterruptedRecord(record, cache);
  }
  for (const record of await getAllRecords()) {
    if (record?.status === "ready") await revalidateReadyRecord(record, cache);
  }
}

export function initializeDeviceChapters() {
  if (!baseInitializationPromise) {
    baseInitializationPromise = (async () => {
      requireBrowserApi("caches");
      getOperationChannel();
      await openDatabase();
      await caches.open(DEVICE_CHAPTER_CACHE);
      return true;
    })().catch((error) => { baseInitializationPromise = null; throw error; });
  }
  return baseInitializationPromise.then(async () => {
    if (!maintenancePromise) maintenancePromise = runMaintenance().finally(() => { maintenancePromise = null; });
    await maintenancePromise;
    return true;
  });
}

export async function listDeviceChapters() {
  await initializeDeviceChapters();
  return sortRecords((await getAllRecords()).map(publicMetadata));
}

export async function getDeviceChapter(serverUrl, chapterId) {
  await initializeDeviceChapters();
  return publicMetadata(await getRecord(deviceChapterKey(serverUrl, chapterId)));
}

export async function listDeviceChaptersForManga(serverUrl, mangaId) {
  await initializeDeviceChapters();
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const normalizedMangaId = normalizeIdentifier(mangaId, "mangaId");
  const records = (await getAllRecords()).filter((record) => record.serverUrl === normalizedServerUrl && String(record.mangaId) === normalizedMangaId);
  return sortRecords(records.map(publicMetadata));
}

export async function downloadDeviceChapter(descriptor, { signal, onProgress } = {}) {
  await initializeDeviceChapters();
  const metadata = descriptorMetadata(descriptor);
  if (activeDownloads.has(metadata.key)) throw invalidState("This chapter is already downloading in this tab.");
  const operationId = createOperationId("download");
  let lease = null;
  let stopHeartbeat = () => {};
  let working = null;
  let preserveReady = false;
  let committed = false;
  activeDownloads.add(metadata.key);
  activeOperations.set(metadata.key, operationId);
  try {
    throwIfAborted(signal);
    const acquired = await acquireDownloadLease(metadata, operationId);
    ({ lease, preserveReady, working } = acquired);
    stopHeartbeat = startLeaseHeartbeat(metadata.key, lease);
    const cache = await caches.open(DEVICE_CHAPTER_CACHE);
    await reconcileExistingPages(cache, working, acquired.existing);
    await persistWorkingRecord(metadata.key, lease, working, preserveReady);
    reportProgress(onProgress, working);
    for (let index = 0; index < working.pageUrls.length; index += 1) {
      throwIfAborted(signal);
      let cachePath = working.pages[index]?.cacheUrl;
      let verified = await inspectCachedPage(cache, cachePath);
      if (!verified) { cachePath = cachePathFor(working.key, index, operationId); verified = await storeFetchedPage(cache, cachePath, working.pageUrls[index], signal); }
      working.pages[index] = { index, sourceUrl: working.pageUrls[index], cacheUrl: cachePath, contentType: verified.contentType, size: verified.size, completedAt: working.pages[index]?.completedAt || now() };
      working.downloadedPages = working.pages.filter(Boolean).length;
      working.status = "downloading"; working.error = null;
      await persistWorkingRecord(metadata.key, lease, working, preserveReady);
      reportProgress(onProgress, working, index);
    }
    if (!await verifyCompleteRecord(cache, working)) throw new Error("One or more device chapter pages could not be verified.");
    working.status = "ready"; working.downloadedPages = working.totalPages; working.updatedAt = now(); working.readyAt = working.updatedAt; working.error = null;
    await finishDownloadRecord(metadata.key, lease, working);
    committed = true;
    const pageLocation = globalThis.location;
    const keepPaths = new Set(working.pages.map((page) => new URL(page.cacheUrl, pageLocation.origin).pathname));
    try { await deleteCachePaths(cache, chapterCachePrefix(metadata.key), keepPaths); } catch { /* verified package remains usable */ }
    const ready = await releaseReadyLease(metadata.key, lease).catch(() => publicMetadata(working));
    reportProgress(onProgress, ready || working);
    return ready || publicMetadata(working);
  } catch (error) {
    if (working && lease && !committed) {
      try {
        let persisted;
        if (preserveReady) {
          persisted = await preserveReadyAfterFailure(metadata.key, lease, error);
          const cache = await caches.open(DEVICE_CHAPTER_CACHE);
          await deleteOperationCache(cache, metadata.key, operationId).catch(() => {});
        } else persisted = await persistIncompleteAfterFailure(metadata.key, lease, working, error, signal);
        reportProgress(onProgress, preserveReady ? { ...working, status: isAbortError(error, signal) ? "paused" : "failed",
          error: errorDetails(error, isQuotaExceededError(error) ? "quota-exceeded" : "download-failed") } : persisted || working);
      } catch (persistenceError) {
        if (!isQuotaExceededError(error) && isQuotaExceededError(persistenceError)) throw persistenceError;
      }
    }
    throw error;
  } finally {
    stopHeartbeat();
    activeDownloads.delete(metadata.key);
    if (activeOperations.get(metadata.key) === operationId) activeOperations.delete(metadata.key);
  }
}

export async function removeDeviceChapter(serverUrl, chapterId) {
  await initializeDeviceChapters();
  const key = deviceChapterKey(serverUrl, chapterId);
  if (activeDownloads.has(key)) throw invalidState("Pause the chapter download before removing it.");
  const operationId = createOperationId("remove");
  const lease = newLease("remove", operationId);
  activeOperations.set(key, operationId);
  let stopHeartbeat = () => {};
  try {
    const record = await updateRecordAtomically(key, (current) => {
      if (!current) return { result: null };
      assertAvailableLease(current, key);
      const removing = { ...current, status: "removing", updatedAt: now(), error: null, lease };
      delete removing.pendingDownload;
      return { record: removing, result: cloneMetadata(removing) };
    });
    if (!record) return false;
    stopHeartbeat = startLeaseHeartbeat(key, lease);
    await finishRemovalWithLease(record, await caches.open(DEVICE_CHAPTER_CACHE), lease);
    return true;
  } finally {
    stopHeartbeat();
    if (activeOperations.get(key) === operationId) activeOperations.delete(key);
  }
}

export function deviceChapterPageUrls(chapterPackage) {
  if (!chapterPackage || chapterPackage.status !== "ready") return [];
  const totalPages = Number(chapterPackage.totalPages) || 0;
  const pages = Array.isArray(chapterPackage.pages) ? chapterPackage.pages : [];
  if (!totalPages || pages.length < totalPages) return [];
  const urls = [];
  for (let index = 0; index < totalPages; index += 1) {
    const cacheUrl = pages[index]?.cacheUrl;
    if (typeof cacheUrl !== "string" || !cacheUrl.startsWith(DEVICE_CHAPTER_PATH_PREFIX)) return [];
    urls.push(cacheUrl);
  }
  return urls;
}
