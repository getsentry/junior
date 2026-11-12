/**
 * Live data for a dashboard Preview.
 *
 * Only this example app uses this file, and it changes nothing unless
 * `JUNIOR_DASHBOARD_LIVE_ORIGIN` is set. The Junior packages and the
 * production app do not know about it.
 *
 * A Preview shows mock data by default. A viewer can enter a personal token
 * from the live deployment as the Basic auth password. The browser then sends
 * it with every request, and the wrapper forwards `/api/*` reads to the live
 * deployment as a bearer token. The server never stores the token, so a
 * public Preview URL does not give anyone else live data.
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

/** Read the personal token from Basic credentials. The username is ignored. */
function livePreviewToken(request: Request): string | undefined {
  const encoded = /^Basic ([A-Za-z0-9+/=]+)$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (!encoded) return undefined;
  const credentials = Buffer.from(encoded, "base64").toString("utf8");
  const separator = credentials.indexOf(":");
  const token = separator === -1 ? "" : credentials.slice(separator + 1).trim();
  return token || undefined;
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

/**
 * Ask for a personal token, or go back to the page when the live deployment
 * accepts the token that the browser sent.
 *
 * The browser keeps Basic credentials for the directory of the URL that asked
 * for them. The banner asks on `/`, so the credentials apply to every path.
 */
async function startLivePreview(
  request: Request,
  origin: string,
): Promise<Response> {
  const url = new URL(request.url);
  const token = livePreviewToken(request);
  if (token) {
    const me = await fetch(new URL("/api/me", origin), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (me.ok) return Response.redirect(new URL("/", url), 302);
  }
  const host = escapeHtml(new URL(origin).host);
  const tokensUrl = escapeHtml(new URL("/settings/api-tokens", origin).href);
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Live data</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem;">
  <h1>Live data from ${host}</h1>
  <p>Enter any user name and a <a href="${tokensUrl}">personal token from ${host}</a> as the password. Live data is read-only.</p>
  <p><a href="/">Use demo data</a></p>
</body>
</html>`,
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "www-authenticate": `Basic realm="${host} personal token", charset="UTF-8"`,
      },
      status: 401,
    },
  );
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
