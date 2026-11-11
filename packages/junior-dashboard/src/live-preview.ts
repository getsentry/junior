/**
 * Live data for a dashboard Preview.
 *
 * This is a separate entry point. Only a Preview app wraps itself with it, so
 * a production app does not load it or run its checks.
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
import { LIVE_PREVIEW_PARAM, type DashboardPreview } from "./api/schema";

/** An app that serves requests, such as the Hono app from `createApp()`. */
export interface FetchApp<Rest extends unknown[]> {
  fetch(request: Request, ...rest: Rest): Response | Promise<Response>;
}

const AUTH_PATH = "/api/auth";
// Response headers that describe the upstream transfer, not the body that
// this server sends. `fetch` already decoded the body.
const DROPPED_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "set-cookie",
  "transfer-encoding",
];
const FORWARDED_REQUEST_HEADERS = ["accept", "if-none-match", "range"];

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
  const upstream = await fetch(
    new URL(`${url.pathname}${url.search}`, origin),
    {
      headers,
      method: request.method,
      redirect: "manual",
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
  return new Response(upstream.body, {
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
 * for them. The client asks on a path one level deep, so the credentials
 * apply to every path.
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
      redirect: "manual",
    });
    if (me.ok) return Response.redirect(new URL(url.pathname, url), 302);
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
  <p><a href="${escapeHtml(url.pathname)}">Use demo data</a></p>
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

/** Tell the page shell which data it shows, so the client shows the banner. */
async function withPreviewScript(
  response: Response,
  preview: DashboardPreview,
): Promise<Response> {
  const json = JSON.stringify(preview).replace(/</g, "\\u003c");
  const html = (await response.text()).replace(
    "</head>",
    `<script>window.__JUNIOR_DASHBOARD_PREVIEW__ = ${json};</script></head>`,
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
 * Wrap a Junior app so its dashboard can also show data from `liveOrigin`.
 * Use it only in a Preview app with dashboard auth off.
 */
export function withLivePreview<Rest extends unknown[]>(
  app: FetchApp<Rest>,
  liveOrigin: string,
): FetchApp<Rest> {
  const origin = new URL(liveOrigin).origin;
  return {
    async fetch(request, ...rest) {
      const url = new URL(request.url);
      if (
        url.searchParams.has(LIVE_PREVIEW_PARAM) &&
        url.pathname.lastIndexOf("/") === 0
      ) {
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
        ? withPreviewScript(response, {
            live: Boolean(token),
            liveOrigin: origin,
          })
        : response;
    },
  };
}
