/**
 * Live data for a dashboard Preview.
 *
 * A Preview shows mock data by default. A viewer can enter a personal token
 * from the live deployment as the Basic auth password. The browser then sends
 * it with every request, and this module forwards `/api/*` reads to the live
 * deployment as a bearer token. The server never stores the token, so a
 * public Preview URL does not give anyone else live data.
 *
 * The live deployment accepts personal tokens only for GET and HEAD, so live
 * data is read-only.
 */
import { jsonResponse } from "@sentry/junior/api";
import { apiErrorSchema } from "@sentry/junior/api/schema";
import { escapeHtml } from "./shell";

// Response headers that describe the upstream transfer, not the body that
// this server sends. `fetch` already decoded the body.
const DROPPED_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "set-cookie",
  "transfer-encoding",
];
const FORWARDED_REQUEST_HEADERS = ["accept", "if-none-match", "range"];

/** Read the live deployment origin. Only a dashboard without auth can use it. */
export function readLivePreviewOrigin(
  authRequired: boolean,
): string | undefined {
  const value = process.env.JUNIOR_DASHBOARD_LIVE_ORIGIN?.trim();
  if (!value) return undefined;
  if (authRequired) {
    throw new Error(
      "JUNIOR_DASHBOARD_LIVE_ORIGIN requires dashboard auth to be off",
    );
  }
  return new URL(value).origin;
}

/** Read the personal token from Basic credentials. The username is ignored. */
export function livePreviewToken(request: Request): string | undefined {
  const encoded = /^Basic ([A-Za-z0-9+/=]+)$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (!encoded) return undefined;
  const credentials = Buffer.from(encoded, "base64").toString("utf8");
  const separator = credentials.indexOf(":");
  const token = separator === -1 ? "" : credentials.slice(separator + 1).trim();
  return token || undefined;
}

/** Forward one dashboard API read to the live deployment. */
export async function proxyLivePreviewRequest(
  request: Request,
  origin: string,
  token: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(
      apiErrorSchema,
      { error: "Live data in a Preview is read-only." },
      { status: 403 },
    );
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
    return jsonResponse(
      apiErrorSchema,
      { error: `${new URL(origin).host} rejected the personal token.` },
      { status: 403 },
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
 * Ask for a personal token, or go back to the base path when the live
 * deployment accepts the token that the browser sent.
 *
 * The browser keeps Basic credentials for the directory of the URL that asked
 * for them. The base path is always one level deep, so the credentials apply
 * to every dashboard path.
 */
export async function startLivePreview(
  request: Request,
  origin: string,
  basePath: string,
): Promise<Response> {
  const token = livePreviewToken(request);
  if (token) {
    const me = await fetch(new URL("/api/me", origin), {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
    });
    if (me.ok) return Response.redirect(new URL(basePath, request.url), 302);
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
  <p><a href="${escapeHtml(basePath)}">Use demo data</a></p>
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
