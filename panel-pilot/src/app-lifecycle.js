const lifecycleProtocol = 2;
const versionEndpoint = "/api/app-version";
const deviceChapterCacheName = "panels-device-chapters-v1";
const legacyShellCachePattern = /^panel-pilot-v\d+$/;
const checkIntervalMs = 60_000;

async function workerLifecycleCapability(worker, timeoutMs = 600) {
  if (!worker || typeof MessageChannel !== "function") return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => resolve(null), timeoutMs);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      resolve(event.data || null);
    };
    try {
      worker.postMessage({ type: "APP_LIFECYCLE_CAPABILITY" }, [channel.port2]);
    } catch {
      window.clearTimeout(timer);
      resolve(null);
    }
  });
}

async function legacyShellCaches() {
  if (!("caches" in window)) return [];
  return (await caches.keys()).filter((name) => (
    name !== deviceChapterCacheName && legacyShellCachePattern.test(name)
  ));
}

function waitForWorkerInstall(registration, onUpdateReady) {
  const worker = registration?.installing;
  if (!worker) return;
  worker.addEventListener("statechange", () => {
    if (registration.waiting || worker.state === "installed" && navigator.serviceWorker.controller) {
      onUpdateReady?.();
    }
  });
}

export function createAppLifecycleMonitor({
  clientBuildId,
  onStatus = () => {},
  onUpdateReady = () => {},
} = {}) {
  let lastCheckAt = 0;
  let checkPromise = null;
  let intervalId = 0;

  async function repairWorker(registration, reason) {
    onStatus(reason === "legacy"
      ? "Refreshing an older Panels app shell without removing downloaded chapters…"
      : "A newer Panels build is available. Preparing the update…");
    registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    waitForWorkerInstall(registration, onUpdateReady);
    await registration.update();
    if (registration.waiting) onUpdateReady();
  }

  async function check({ force = false } = {}) {
    if (checkPromise) return checkPromise;
    if (!force && Date.now() - lastCheckAt < checkIntervalMs) return null;
    lastCheckAt = Date.now();
    checkPromise = (async () => {
      let signal;
      try {
        const response = await fetch(`${versionEndpoint}?client=${encodeURIComponent(clientBuildId || "unknown")}`, {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return null;
        signal = await response.json();
      } catch {
        return null;
      }
      if (!("serviceWorker" in navigator) || location.protocol === "file:") return signal;
      const registration = await navigator.serviceWorker.getRegistration("/");
      const controller = navigator.serviceWorker.controller || registration?.active;
      const capability = await workerLifecycleCapability(controller);
      const oldCaches = await legacyShellCaches();
      const legacy = Boolean(controller) && (
        Number(capability?.protocolVersion || 0) < Number(signal.minimumLifecycleProtocol || lifecycleProtocol)
        || oldCaches.length > 0
      );
      const serverBuildId = String(signal.buildId || "");
      const staleBuild = Boolean(clientBuildId && serverBuildId && serverBuildId !== clientBuildId);
      if (legacy || staleBuild) await repairWorker(registration, legacy ? "legacy" : "stale");
      const currentRegistration = await navigator.serviceWorker.getRegistration("/");
      if (currentRegistration?.waiting) onUpdateReady();
      return { ...signal, legacy, staleBuild, preservedDeviceCache: deviceChapterCacheName };
    })().finally(() => {
      checkPromise = null;
    });
    return checkPromise;
  }

  function handleVisibility() {
    if (document.visibilityState === "visible") void check();
  }

  return {
    check,
    start() {
      document.addEventListener("visibilitychange", handleVisibility);
      window.addEventListener("pageshow", handleVisibility);
      window.clearInterval(intervalId);
      intervalId = window.setInterval(() => { void check({ force: true }); }, checkIntervalMs);
      void check({ force: true });
    },
    stop() {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pageshow", handleVisibility);
      window.clearInterval(intervalId);
      intervalId = 0;
    },
  };
}

export function initializeAppLifecycle(options) {
  const monitor = createAppLifecycleMonitor(options);
  monitor.start();
  return monitor;
}
