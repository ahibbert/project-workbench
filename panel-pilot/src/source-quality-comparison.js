import "./source-quality.css";

import {
  rankSeriesSource,
  representativePageIndices,
  rgbaEdgeClarity,
  sourceCoverageScore,
  summarizeSeriesSamples,
} from "./source-quality.js";

const CANDIDATE_LIMIT = 5;
const SAMPLES_PER_CANDIDATE = 2;
const IMAGE_BYTE_LIMIT = 12 * 1024 * 1024;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function normalizeTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mapWithConcurrency(items, concurrency, task) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, async () => {
    while (queue.length) await task(queue.shift());
  });
  return Promise.all(workers);
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function metric(label, value) {
  const item = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = value === null || value === undefined ? "—" : String(Math.round(Number(value)));
  const small = document.createElement("small");
  small.textContent = label;
  item.append(strong, small);
  return item;
}

function imageCodec(contentType) {
  const codec = String(contentType || "").split(";")[0].split("/")[1]?.toLowerCase() || "unknown";
  return codec === "svg+xml" ? "unknown" : codec;
}

function loadImage(url, signal) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      image.src = "";
      cleanup();
      reject(signal.reason || new DOMException("Source comparison cancelled.", "AbortError"));
    };
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("The sample image could not be decoded."));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    image.src = url;
  });
}

function edgeClarity(image) {
  const maximum = 360;
  const scale = Math.min(1, maximum / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(3, Math.round(image.naturalWidth * scale));
  const height = Math.max(3, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return 0.5;
  context.drawImage(image, 0, 0, width, height);
  return rgbaEdgeClarity(context.getImageData(0, 0, width, height).data, width, height);
}

function createUi() {
  const dialog = document.createElement("dialog");
  dialog.className = "source-quality-dialog";
  dialog.setAttribute("aria-labelledby", "source-quality-title");

  const shell = document.createElement("section");
  shell.className = "source-quality-shell";
  const heading = document.createElement("header");
  heading.className = "source-quality-heading";
  const headingCopy = document.createElement("div");
  const eyebrow = document.createElement("span");
  eyebrow.className = "source-quality-eyebrow";
  eyebrow.textContent = "Source quality check";
  const title = document.createElement("h2");
  title.id = "source-quality-title";
  title.textContent = "Find a sharper edition";
  headingCopy.append(eyebrow, title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "sheet-close";
  close.setAttribute("aria-label", "Close source comparison");
  close.textContent = "×";
  heading.append(headingCopy, close);

  const summary = document.createElement("p");
  summary.className = "source-quality-summary";
  const progress = document.createElement("div");
  progress.className = "source-quality-progress";
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Source comparison progress");
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", "100");
  progress.setAttribute("aria-valuenow", "0");
  const progressBar = document.createElement("span");
  progress.append(progressBar);
  const list = document.createElement("div");
  list.className = "source-quality-list";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "wide-button source-quality-retry";
  retry.textContent = "Compare again";
  retry.hidden = true;

  const preview = document.createElement("div");
  preview.className = "source-quality-preview";
  preview.hidden = true;
  const previewClose = close.cloneNode(true);
  previewClose.setAttribute("aria-label", "Close full-resolution preview");
  const previewImage = document.createElement("img");
  const previewCaption = document.createElement("p");
  preview.append(previewClose, previewImage, previewCaption);
  shell.append(heading, summary, progress, list, retry, preview);
  dialog.append(shell);
  document.body.append(dialog);
  return { dialog, close, summary, progress, progressBar, list, retry, preview, previewClose, previewImage, previewCaption };
}

export function createSourceQualityComparison(adapter) {
  const ui = createUi();
  let comparison = null;
  let request = null;
  let abortController = null;
  let generation = 0;
  let returnFocusTarget = null;

  function setProgress(value, message) {
    const percent = Math.round(clamp(value, 0, 100));
    ui.progress.setAttribute("aria-valuenow", String(percent));
    ui.progressBar.style.setProperty("--source-quality-progress", `${percent}%`);
    if (message) ui.summary.textContent = message;
  }

  function hidePreview() {
    ui.preview.hidden = true;
    ui.previewImage.removeAttribute("src");
    ui.previewCaption.textContent = "";
  }

  function showPreview(candidate, sample) {
    if (!sample?.previewUrl) return;
    ui.previewImage.src = sample.previewUrl;
    ui.previewImage.alt = `${candidate.sourceLabel} source page preview`;
    ui.previewCaption.textContent = `${candidate.sourceLabel} · ${sample.width} × ${sample.height} · ${formatBytes(sample.byteCount)}`;
    ui.preview.hidden = false;
    requestAnimationFrame(() => ui.previewClose.focus({ preventScroll: true }));
  }

  function close() {
    hidePreview();
    abortController?.abort(new DOMException("Source comparison closed.", "AbortError"));
    abortController = null;
    if (ui.dialog.open) ui.dialog.close();
  }

  function openDialog(target) {
    if (target?.isConnected) returnFocusTarget = target;
    if (!ui.dialog.open) ui.dialog.showModal();
    document.body.classList.add("source-quality-open");
    requestAnimationFrame(() => ui.close.focus({ preventScroll: true }));
  }

  function render() {
    if (!comparison) return;
    ui.list.replaceChildren();
    const candidates = [...comparison.candidates].sort((left, right) => (
      Number(right.overall ?? -1) - Number(left.overall ?? -1)
      || Number(right.quality ?? -1) - Number(left.quality ?? -1)
      || Number(right.reliability ?? -1) - Number(left.reliability ?? -1)
    ));
    const current = candidates.find((candidate) => candidate.isCurrent);
    const recommended = candidates.find((candidate) => !candidate.isCurrent && candidate.status === "ready");

    candidates.forEach((candidate, index) => {
      const card = document.createElement("article");
      card.className = "source-quality-card";
      card.dataset.status = candidate.status;
      if (candidate === recommended) card.dataset.recommended = "true";
      const heading = document.createElement("div");
      heading.className = "source-quality-card-heading";
      const copy = document.createElement("div");
      const eyebrow = document.createElement("span");
      eyebrow.textContent = candidate.isCurrent ? "Current source" : candidate === recommended ? "Best alternative" : `Alternative ${index + 1}`;
      const title = document.createElement("strong");
      title.textContent = candidate.sourceLabel;
      const chapter = document.createElement("small");
      chapter.textContent = candidate.matchedChapter
        ? `${candidate.matchedChapter.name || "Matching chapter"} · ${candidate.chapterCount} chapters available`
        : ["searching", "sampling"].includes(candidate.status)
          ? "Checking chapter and image quality…"
          : candidate.error || `${candidate.chapterCount || 0} chapters · no equivalent chapter found`;
      copy.append(eyebrow, title, chapter);
      const score = metric("overall", candidate.overall);
      score.className = "source-quality-score";
      heading.append(copy, score);
      card.append(heading);

      const metrics = document.createElement("div");
      metrics.className = "source-quality-metrics";
      metrics.append(
        metric("image", candidate.quality),
        metric("reliable", candidate.reliability),
        metric("coverage", candidate.coverage),
        metric("speed", candidate.speed),
      );
      card.append(metrics);

      if (candidate.samples?.length) {
        const samples = document.createElement("div");
        samples.className = "source-quality-samples";
        candidate.samples.forEach((sample) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "source-quality-sample";
          button.setAttribute("aria-label", `Open ${candidate.sourceLabel} page at full resolution`);
          const image = document.createElement("img");
          image.src = sample.previewUrl;
          image.alt = "";
          const label = document.createElement("span");
          label.textContent = `${sample.width}×${sample.height} · ${formatBytes(sample.byteCount)}`;
          button.append(image, label);
          button.addEventListener("click", () => showPreview(candidate, sample));
          samples.append(button);
        });
        card.append(samples);
      }

      const note = document.createElement("p");
      note.className = "source-quality-note";
      if (candidate.status === "failed") note.textContent = candidate.error || "This source could not be sampled.";
      else if (candidate.possibleUpscale) note.textContent = "High pixel dimensions but unusually soft detail; this may be an enlarged copy.";
      else if (candidate.status === "ready") {
        const delta = current?.overall !== null && candidate.overall !== null && !candidate.isCurrent
          ? Math.round(candidate.overall - current.overall)
          : null;
        note.textContent = [
          `${candidate.confidence || "early"} confidence`,
          delta === null ? "" : delta > 0 ? `${delta} points above current` : delta < 0 ? `${Math.abs(delta)} points below current` : "similar to current",
        ].filter(Boolean).join(" · ");
      } else note.textContent = "Waiting for representative pages…";
      card.append(note);

      if (!candidate.isCurrent && candidate.chapters?.length) {
        const migrate = document.createElement("button");
        migrate.type = "button";
        migrate.className = "wide-button source-quality-migrate";
        migrate.textContent = candidate.matchedChapter ? "Migrate to this source" : "Migrate and choose chapter";
        migrate.disabled = ["searching", "sampling"].includes(candidate.status);
        migrate.addEventListener("click", async () => {
          migrate.disabled = true;
          const label = migrate.textContent;
          migrate.textContent = "Migrating…";
          try {
            await adapter.migrate(candidate, comparison);
            close();
          } catch (error) {
            adapter.showError?.(`Could not migrate: ${adapter.friendlyError(error)}`, "bad");
          } finally {
            migrate.disabled = false;
            migrate.textContent = label;
          }
        });
        card.append(migrate);
      }
      ui.list.append(card);
    });

    if (!candidates.length) {
      const empty = document.createElement("div");
      empty.className = "app-empty-state compact-empty";
      const title = document.createElement("strong");
      title.textContent = "No matching alternatives yet";
      const note = document.createElement("span");
      note.textContent = "Enable more sources in Suwayomi, then compare again.";
      empty.append(title, note);
      ui.list.append(empty);
    }
  }

  async function fetchSample(url, signal) {
    const startedAt = performance.now();
    const response = await fetch(url, { signal, credentials: "same-origin" });
    if (!response.ok) throw new Error(`Image returned HTTP ${response.status}.`);
    const declaredBytes = Number(response.headers.get("content-length")) || 0;
    if (declaredBytes > IMAGE_BYTE_LIMIT) throw new Error("Image exceeds the comparison size limit.");
    const blob = await response.blob();
    if (!blob.size || blob.size > IMAGE_BYTE_LIMIT) throw new Error("Image exceeds the comparison size limit.");
    const previewUrl = URL.createObjectURL(blob);
    try {
      const image = await loadImage(previewUrl, signal);
      return {
        previewUrl,
        width: image.naturalWidth,
        height: image.naturalHeight,
        byteCount: blob.size,
        codec: imageCodec(blob.type),
        clarity: edgeClarity(image),
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    } catch (error) {
      URL.revokeObjectURL(previewUrl);
      throw error;
    }
  }

  async function findMatches(migration, sources, mediaFormat, signal) {
    const desiredTitle = normalizeTitle(migration.title);
    const matches = [];
    await mapWithConcurrency(
      sources.filter((source) => String(source.id) !== String(migration.fromManga.sourceId)),
      3,
      async (source) => {
        try {
          const mangas = await adapter.searchSource(source, migration.title, signal);
          const manga = mangas.find((item) => normalizeTitle(item.title) === desiredTitle);
          if (manga) matches.push({ manga: { ...manga, sourceId: manga.sourceId || source.id }, source });
        } catch (error) {
          if (error?.name === "AbortError") throw error;
        }
      },
    );
    return matches.sort((left, right) => (
      adapter.sourceEvidence(right.source.id, mediaFormat).reliability
      - adapter.sourceEvidence(left.source.id, mediaFormat).reliability
    ));
  }

  async function sampleCandidate(candidate, signal) {
    const startedAt = performance.now();
    candidate.status = "sampling";
    render();
    try {
      const chapters = candidate.isCurrent && request.currentChapters?.length
        ? [...request.currentChapters]
        : await adapter.fetchChapters(candidate.manga, signal);
      candidate.chapters = chapters;
      candidate.chapterCount = chapters.length;
      candidate.matchedChapter = adapter.matchChapter(request.migration, chapters)
        || (candidate.isCurrent ? chapters.find((chapter) => Number(chapter.id) === Number(request.migration.fromLibraryItem?.chapterId)) : null);
      candidate.coverage = sourceCoverageScore({
        chapterCount: chapters.length,
        referenceChapterCount: comparison.referenceChapterCount || chapters.length,
        matchedChapter: Boolean(candidate.matchedChapter),
      });
      if (!candidate.matchedChapter) {
        candidate.status = "partial";
        candidate.error = "No equivalent chapter was found for a direct visual comparison.";
      } else {
        const pageUrls = await adapter.fetchPages(candidate.matchedChapter, signal);
        const indices = representativePageIndices(pageUrls.length, comparison.preferredPageRatio, SAMPLES_PER_CANDIDATE);
        for (const index of indices) {
          const sample = await fetchSample(pageUrls[index], signal);
          sample.pageIndex = index;
          candidate.samples.push(sample);
        }
        const series = summarizeSeriesSamples(candidate.samples, comparison.mediaFormat);
        candidate.samples = series.samples;
        candidate.quality = series.quality;
        candidate.possibleUpscale = series.possibleUpscale;
        candidate.status = candidate.samples.length ? "ready" : "failed";
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      candidate.status = "failed";
      candidate.error = adapter.friendlyError(error);
    }
    const evidence = adapter.sourceEvidence(candidate.source.id, comparison.mediaFormat);
    candidate.reliability = evidence.reliability;
    candidate.evidenceCount = evidence.evidenceCount;
    candidate.speed = Math.max(0, Math.round(100 * (1 - Math.min(1, (performance.now() - startedAt) / 15000))));
    const ranking = rankSeriesSource({ ...candidate, sampleCount: candidate.samples.length });
    candidate.overall = ranking.overall;
    candidate.confidence = ranking.confidence;
    void adapter.recordObservations?.(candidate.samples.map((sample) => ({
      sourceId: String(candidate.source.id),
      sourceLabel: adapter.sourceLabel(candidate.source),
      operation: "image_fetch",
      outcome: "success",
      latencyMs: sample.latencyMs,
      mediaFormat: comparison.mediaFormat,
      byteCount: sample.byteCount,
      width: sample.width,
      height: sample.height,
      codec: sample.codec,
      clarity: sample.clarity,
      placeholder: false,
    })));
  }

  async function compare(force = false) {
    if (!request) return;
    const key = request.key;
    if (!force && comparison?.key === key && comparison.complete) {
      openDialog(request.returnFocusTarget);
      render();
      return;
    }
    if (comparison) {
      comparison?.candidates.forEach((candidate) => candidate.samples?.forEach((sample) => URL.revokeObjectURL(sample.previewUrl)));
      comparison = null;
    }
    abortController?.abort(new DOMException("Source comparison restarted.", "AbortError"));
    abortController = new AbortController();
    const signal = abortController.signal;
    const activeGeneration = ++generation;
    comparison = {
      key,
      migration: request.migration,
      mediaFormat: request.mediaFormat,
      preferredPageRatio: request.preferredPageRatio,
      referenceChapterCount: request.referenceChapterCount,
      candidates: [],
      complete: false,
    };
    openDialog(request.returnFocusTarget);
    ui.retry.hidden = true;
    setProgress(5, `Searching enabled sources for ${request.migration.title}…`);
    render();
    try {
      const current = {
        isCurrent: true,
        manga: request.currentManga,
        source: request.currentSource,
        sourceLabel: adapter.sourceLabel(request.currentSource),
        status: "searching",
        samples: [],
        overall: null,
      };
      comparison.candidates.push(current);
      render();
      const matchesPromise = findMatches(request.migration, request.sources, request.mediaFormat, signal);
      await sampleCandidate(current, signal);
      if (!comparison.referenceChapterCount) comparison.referenceChapterCount = current.chapterCount;
      if (activeGeneration !== generation) return;
      setProgress(35, "Current source sampled. Checking the strongest matching alternatives…");
      const matches = (await matchesPromise).slice(0, CANDIDATE_LIMIT - 1);
      matches.forEach(({ manga, source }) => comparison.candidates.push({
        isCurrent: false,
        manga,
        source,
        sourceLabel: adapter.sourceLabel(source),
        status: "searching",
        samples: [],
        overall: null,
      }));
      render();
      let completed = 0;
      await mapWithConcurrency(comparison.candidates.filter((candidate) => !candidate.isCurrent), 2, async (candidate) => {
        await sampleCandidate(candidate, signal);
        completed += 1;
        setProgress(35 + Math.round(60 * completed / Math.max(1, matches.length)), `Compared ${completed} of ${matches.length} alternative source${matches.length === 1 ? "" : "s"}…`);
        render();
      });
      comparison.complete = true;
      setProgress(100, matches.length
        ? "Comparison complete. Open samples at full resolution, then migrate only if one looks better."
        : "No exact title matches were found on the other enabled sources.");
      ui.retry.hidden = false;
      render();
    } catch (error) {
      if (error?.name === "AbortError" || activeGeneration !== generation) return;
      setProgress(100, `Comparison stopped: ${adapter.friendlyError(error)}`);
      ui.retry.hidden = false;
    } finally {
      if (activeGeneration === generation) abortController = null;
    }
  }

  ui.close.addEventListener("click", close);
  ui.retry.addEventListener("click", () => void compare(true));
  ui.previewClose.addEventListener("click", hidePreview);
  ui.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  ui.dialog.addEventListener("close", () => {
    hidePreview();
    abortController?.abort(new DOMException("Source comparison closed.", "AbortError"));
    abortController = null;
    document.body.classList.remove("source-quality-open");
    const target = returnFocusTarget;
    returnFocusTarget = null;
    requestAnimationFrame(() => target?.isConnected && target.focus({ preventScroll: true }));
  });

  return {
    close,
    async open(nextRequest) {
      request = nextRequest;
      await compare(Boolean(nextRequest.force));
    },
  };
}
