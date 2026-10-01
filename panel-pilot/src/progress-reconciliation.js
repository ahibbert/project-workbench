function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeServerUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function chapterProgressOrder(chapter, fallback = 0) {
  const sourceOrder = Number(chapter?.sourceOrder);
  if (Number.isFinite(sourceOrder)) return sourceOrder;
  const chapterNumber = Number(chapter?.chapterNumber);
  if (Number.isFinite(chapterNumber)) return chapterNumber;
  return finiteNumber(fallback);
}

function progressCandidate(chapter, {
  completed = false,
  lastPageRead = 0,
  origin = "server",
} = {}) {
  if (!chapter || !Number.isInteger(Number(chapter.id))) return null;
  return {
    chapter,
    chapterId: Number(chapter.id),
    chapterOrder: chapterProgressOrder(chapter),
    lastPageRead: Math.max(0, finiteNumber(lastPageRead)),
    completed: Boolean(completed),
    origin,
  };
}

export function compareReadingProgress(left, right) {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  if (left.chapterOrder !== right.chapterOrder) return left.chapterOrder - right.chapterOrder;
  if (left.completed !== right.completed) return left.completed ? 1 : -1;
  if (left.lastPageRead !== right.lastPageRead) return left.lastPageRead - right.lastPageRead;

  // Equal coordinates are deliberately server-first. This makes an acknowledged
  // update win ties and lets callers discard the duplicate queued write.
  const trust = { server: 3, outbox: 2, local: 1 };
  return (trust[left.origin] || 0) - (trust[right.origin] || 0);
}

function furthest(candidates) {
  return candidates.filter(Boolean).reduce((best, candidate) => (
    compareReadingProgress(candidate, best) > 0 ? candidate : best
  ), null);
}

function serverFrontier(chapters) {
  const partial = chapters
    .filter((chapter) => !chapter.isRead && finiteNumber(chapter.lastPageRead) > 0)
    .map((chapter) => progressCandidate(chapter, {
      lastPageRead: chapter.lastPageRead,
      origin: "server",
    }));
  const completed = furthest(chapters
    .filter((chapter) => chapter.isRead)
    .map((chapter) => progressCandidate(chapter, {
      completed: true,
      lastPageRead: Math.max(
        finiteNumber(chapter.lastPageRead),
        Math.max(0, finiteNumber(chapter.pageCount, 1) - 1),
      ),
      origin: "server",
    })));

  if (completed) {
    const nextUnread = chapters
      .filter((chapter) => !chapter.isRead && chapterProgressOrder(chapter) > completed.chapterOrder)
      .sort((left, right) => (
        chapterProgressOrder(left) - chapterProgressOrder(right)
        || Number(left.id) - Number(right.id)
      ))[0];
    if (nextUnread) {
      partial.push(progressCandidate(nextUnread, {
        lastPageRead: finiteNumber(nextUnread.lastPageRead),
        origin: "server",
      }));
    } else {
      partial.push(completed);
    }
  }

  return furthest(partial);
}

/**
 * Reconcile one title without relying on clocks (Suwayomi does not expose a
 * progress timestamp). Series position, chapter completion, then page position
 * form the deterministic ordering. The returned outbox never contains an entry
 * already dominated by Suwayomi's current frontier.
 */
export function reconcileReadingProgress({
  chapters = [],
  libraryItem = null,
  outbox = [],
  serverUrl = "",
} = {}) {
  const normalizedChapters = chapters
    .filter((chapter) => Number.isInteger(Number(chapter?.id)))
    .map((chapter) => ({ ...chapter, id: Number(chapter.id) }));
  const chaptersById = new Map(normalizedChapters.map((chapter) => [chapter.id, chapter]));
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const server = serverFrontier(normalizedChapters);

  const localChapter = chaptersById.get(Number(libraryItem?.chapterId));
  const local = localChapter ? progressCandidate(localChapter, {
    lastPageRead: libraryItem?.pageIndex,
    origin: "local",
  }) : null;

  const relevantOutbox = outbox
    .filter((entry) => normalizeServerUrl(entry?.serverUrl) === normalizedServerUrl)
    .map((entry) => {
      const chapter = chaptersById.get(Number(entry?.chapterId));
      return chapter ? progressCandidate(chapter, {
        completed: entry.completed,
        lastPageRead: entry.lastPageRead,
        origin: "outbox",
      }) : null;
    })
    .filter(Boolean);

  const winner = furthest([server, local, ...relevantOutbox]);
  const dominatedChapterIds = new Set(relevantOutbox
    .filter((candidate) => compareReadingProgress(server, candidate) >= 0)
    .map((candidate) => candidate.chapterId));
  const nextOutbox = outbox.filter((entry) => !(
    normalizeServerUrl(entry?.serverUrl) === normalizedServerUrl
    && dominatedChapterIds.has(Number(entry?.chapterId))
  ));

  const localAhead = local && compareReadingProgress(local, server) > 0;
  const queuedAtLeastLocal = relevantOutbox.some((candidate) => compareReadingProgress(candidate, local) >= 0);
  const push = localAhead && !queuedAtLeastLocal ? {
    chapterId: local.chapterId,
    lastPageRead: local.lastPageRead,
    completed: false,
  } : null;

  return {
    winner,
    server,
    outbox: nextOutbox,
    push,
    started: Boolean(
      winner
      || libraryItem?.started
      || normalizedChapters.some((chapter) => chapter.isRead || finiteNumber(chapter.lastPageRead) > 0)
    ),
  };
}
