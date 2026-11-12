/**
 * Live data for a dashboard Preview.
 *
 * Only this example app uses this file, and it changes nothing unless
 * `JUNIOR_DASHBOARD_LIVE_ORIGIN` is set. The Junior packages and the
 * production app do not know about it.
 *
 * A Preview shows mock data by default. A viewer can connect it to the live
 * deployment: the API Tokens page there creates a personal token and POSTs it
 * to `/?live`. It does that only for a Preview that Junior made for that
 * viewer. For other Previews, the viewer pastes a token into the same form.
 *
 * The token stays in an HttpOnly cookie in the viewer's browser, and the
 * wrapper forwards `/api/*` reads to the live deployment as a bearer token.
 * The server never stores the token, so a public Preview URL does not give
 * anyone else live data.
 *
 * The live deployment accepts personal tokens only for GET and HEAD, so live
 * data is read-only.
 */
import { CONVERSATION_DETAIL_VERSION_HEADER } from "@sentry/junior/api/schema";
import { JUNIOR_VERSION } from "@sentry/junior/version";
import { exampleDashboardAuthRequired } from "./dashboard.ts";

/** An app that serves requests, such as the Hono app from `createApp()`. */
export interface FetchApp<Rest extends unknown[]> {
  fetch(request: Request, ...rest: Rest): Response | Promise<Response>;
}

const LIVE_PARAM = "live";
const TOKEN_COOKIE = "junior_live_token";
const AUTH_PATH = "/api/auth";
const VERSION_HEADER = "x-junior-version";
// Response headers that describe the upstream transfer, not the body that
// this server sends. `fetch` already decoded the body.
const DROPPED_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "set-cookie",
  "transfer-encoding",
];
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "if-none-match",
  "range",
  CONVERSATION_DETAIL_VERSION_HEADER,
];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function errorResponse(error: string): Response {
  return Response.json({ error }, { status: 403 });
}

/** Read the personal token from the cookie that `/?live` sets. */
function livePreviewToken(request: Request): string | undefined {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = pair.trim().split("=");
    if (name === TOKEN_COOKIE) {
      return decodeURIComponent(value.join("=")).trim() || undefined;
    }
  }
  return undefined;
}

async function liveDeploymentAccepts(
  token: string,
  origin: string,
): Promise<boolean> {
  const me = await fetch(new URL("/api/me", origin), {
    headers: { authorization: `Bearer ${token}` },
  });
  return me.ok;
}

async function proxyRequest(
  request: Request,
  origin: string,
  token: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse("Live data in a Preview is read-only.");
  }
  const url = new URL(request.url);
  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Follow redirects here: the browser would follow them to the live
  // deployment without the token. `fetch` drops the token on a redirect to
  // another origin.
  const upstream = await fetch(
    new URL(`${url.pathname}${url.search}`, origin),
    {
      headers,
      method: request.method,
      signal: request.signal,
    },
  );
  // A 401 makes the client restart local sign-in, which cannot fix a bad
  // token. Report it as 403, so the page shows the error.
  if (upstream.status === 401) {
    return errorResponse(
      `${new URL(origin).host} rejected the personal token.`,
    );
  }
  const responseHeaders = new Headers(upstream.headers);
  for (const name of DROPPED_RESPONSE_HEADERS) responseHeaders.delete(name);
  // The client shows a "dashboard changed" banner when the server version is
  // not its own. The live deployment runs a different version on purpose.
  responseHeaders.set(VERSION_HEADER, JUNIOR_VERSION);
  let body: BodyInit | null = upstream.body;
  if (url.pathname === "/api/config" && upstream.ok) {
    body = JSON.stringify({
      ...(await upstream.json()),
      version: JUNIOR_VERSION,
    });
  }
  return new Response(body, {
    headers: responseHeaders,
    status: upstream.status,
    statusText: upstream.statusText,
  });
}

function livePreviewPage(
  request: Request,
  origin: string,
  error?: { message: string; status: number },
): Response {
  const host = escapeHtml(new URL(origin).host);
  const tokensUrl = new URL("/settings/api-tokens", origin).href;
  const pasteUrl = new URL(tokensUrl);
  pasteUrl.searchParams.set(
    "name",
    `Live preview on ${new URL(request.url).host}`,
  );
  // The server can sit behind a proxy, so the browser names the origin that
  // the live deployment sends the token to.
  const connect = `this.href=${JSON.stringify(`${tokensUrl}?preview=`)}+encodeURIComponent(location.origin)`;
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Live data</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem;">
  <h1>Live data from ${host}</h1>
  ${error ? `<p role="alert">${escapeHtml(error.message)}</p>` : ""}
  <p><a href="${escapeHtml(tokensUrl)}" onclick="${escapeHtml(connect)}">Connect to ${host}</a>. This works when Junior made this Preview for you. Live data is read-only.</p>
  <form method="post" action="/?${LIVE_PARAM}">
    <label>Or paste a <a href="${escapeHtml(pasteUrl.href)}">personal token from ${host}</a>
      <input name="token" required autocomplete="off" style="display:block;width:100%;margin:0.5rem 0;font:inherit" /></label>
    <button type="submit">Use token</button>
  </form>
  <p><a href="/">Use demo data</a></p>
</body>
</html>`,
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
      status: error?.status ?? 200,
    },
  );
}

/**
 * Keep a personal token from the live deployment's API Tokens page or the
 * paste form, when the live deployment accepts it.
 */
async function acceptLivePreviewToken(
  request: Request,
  origin: string,
): Promise<Response> {
  const url = new URL(request.url);
  // Only the live deployment and this page may set the token. Otherwise any
  // site could connect a viewer to someone else's live data. Compare hosts:
  // behind a proxy, `request.url` can have another scheme.
  const sender = request.headers.get("origin");
  const senderHost = sender && URL.canParse(sender) ? new URL(sender).host : "";
  if (sender !== origin && senderHost !== url.host) {
    return livePreviewPage(request, origin, {
      message: "Request blocked. Connect again from this page.",
      status: 403,
    });
  }
  let token = "";
  try {
    const value = (await request.formData()).get("token");
    token = typeof value === "string" ? value.trim() : "";
  } catch {
    // A body that is not a form has no token.
  }
  if (!token || !(await liveDeploymentAccepts(token, origin))) {
    return livePreviewPage(request, origin, {
      message: `${new URL(origin).host} rejected the personal token.`,
      status: 403,
    });
  }
  const secure =
    url.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https";
  return new Response(null, {
    headers: {
      location: "/",
      // Lax, not Strict: the token arrives in a POST from the live
      // deployment, and the redirect that follows must send the cookie.
      "set-cookie": `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
    },
    status: 303,
  });
}

/**
 * Ask for a personal token, or go back to the page when the live deployment
 * accepts the token that the browser has.
 */
async function startLivePreview(
  request: Request,
  origin: string,
): Promise<Response> {
  if (request.method === "POST") {
    return await acceptLivePreviewToken(request, origin);
  }
  const token = livePreviewToken(request);
  if (token && (await liveDeploymentAccepts(token, origin))) {
    return Response.redirect(new URL("/", request.url), 302);
  }
  return livePreviewPage(request, origin);
}

/**
 * Add a banner that says which data the page shows. In live mode, also drop
 * the identity and config that the local server put in the page, so the
 * client reads them from the live deployment.
 */
async function withPreviewBanner(
  response: Response,
  origin: string,
  live: boolean,
): Promise<Response> {
  const host = escapeHtml(new URL(origin).host);
  // Same-page link to the live deployment. The path changes without a page
  // load, so the link reads it when clicked.
  const liveLink = `<a href="${escapeHtml(origin)}" onclick="this.href=${escapeHtml(JSON.stringify(origin))}+location.pathname+location.search" style="color:inherit;text-decoration:underline">${host}</a>`;
  const text = live
    ? `You are seeing a preview of ${liveLink}. Read-only.`
    : `Demo data. <a href="/?${LIVE_PARAM}" style="color:inherit;text-decoration:underline">Use live data from ${host}</a>`;
  const banner = `<div role="status" style="position:fixed;z-index:2147483647;left:0.75rem;bottom:calc(0.75rem + env(safe-area-inset-bottom));display:flex;gap:0.5rem;align-items:center;padding:0.375rem 0.75rem;border-radius:9999px;background:#6c5fc7;color:#fff;font:600 12px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgb(0 0 0 / 0.3)"><span>${text}</span><button type="button" aria-label="Hide" onclick="this.parentElement.remove()" style="all:unset;cursor:pointer;font-size:14px;line-height:1">×</button></div>`;
  // Classic scripts run before the deferred client module.
  const script = live
    ? "<script>delete window.__JUNIOR_DASHBOARD_BOOTSTRAP__;</script>"
    : "";
  const html = (await response.text()).replace(
    "</body>",
    `${banner}${script}</body>`,
  );
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(html, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Wrap the app so its dashboard can also show data from `liveOrigin`. Use it
 * only with dashboard auth off.
 */
export function withLivePreview<Rest extends unknown[]>(
  app: FetchApp<Rest>,
  liveOrigin: string,
): FetchApp<Rest> {
  const origin = new URL(liveOrigin).origin;
  return {
    async fetch(request, ...rest) {
      const url = new URL(request.url);
      if (url.pathname === "/" && url.searchParams.has(LIVE_PARAM)) {
        return startLivePreview(request, origin);
      }
      const token = livePreviewToken(request);
      if (
        token &&
        url.pathname.startsWith("/api/") &&
        url.pathname !== AUTH_PATH &&
        !url.pathname.startsWith(`${AUTH_PATH}/`)
      ) {
        return proxyRequest(request, origin, token);
      }
      const response = await app.fetch(request, ...rest);
      return request.method === "GET" &&
        response.headers.get("content-type")?.startsWith("text/html")
        ? withPreviewBanner(response, origin, Boolean(token))
        : response;
    },
  };
}

/**
 * Wrap the app when `JUNIOR_DASHBOARD_LIVE_ORIGIN` is set. Without it, return
 * the app as it is.
 */
export function withExampleLivePreview<Rest extends unknown[]>(
  app: FetchApp<Rest>,
): FetchApp<Rest> {
  const liveOrigin = process.env.JUNIOR_DASHBOARD_LIVE_ORIGIN?.trim();
  if (!liveOrigin) return app;
  if (exampleDashboardAuthRequired()) {
    throw new Error(
      "JUNIOR_DASHBOARD_LIVE_ORIGIN requires dashboard auth to be off",
    );
  }
  return withLivePreview(app, liveOrigin);
}
