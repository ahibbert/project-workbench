let installed = false;
let redirectStarted = false;

export class SessionExpiredError extends Error {
  constructor() {
    super("Your Panels session expired. Sign in again to continue; your reading position is safe.");
    this.name = "SessionExpiredError";
  }
}

export function redirectForExpiredSession() {
  if (redirectStarted || location.pathname === "/login") return;
  redirectStarted = true;
  window.dispatchEvent(new CustomEvent("panelpilot:session-expired"));
  const next = `${location.pathname}${location.search}${location.hash}`;
  location.assign(`/login?reason=expired&next=${encodeURIComponent(next)}`);
}

export function installAuthenticationBoundary() {
  if (installed) return;
  installed = true;
  const browserFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await browserFetch(input, init);
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : String(input), location.href);
    } catch {
      return response;
    }
    if (response.status === 401 && url.origin === location.origin && url.pathname.startsWith("/api/")) {
      redirectForExpiredSession();
      throw new SessionExpiredError();
    }
    return response;
  };
}
