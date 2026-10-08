/**
 * Admin-only web setup for the Google account that Junior acts as.
 *
 * Routes mount under Junior's authenticated plugin namespace,
 * `/api/plugins/google`. The dashboard session identifies the admin. Google
 * consent must come from the configured account itself.
 */
import type {
  PluginApiRouteRequestContext,
  PluginRouteApp,
} from "@sentry/junior-plugin-api";
import { GOOGLE_ADMIN_EMAILS_ENV, type GoogleConfig } from "./config";
import {
  connectGoogleAccount,
  createGoogleSignInRequest,
  GoogleConnectError,
  googleAuthorizationUrl,
} from "./oauth";
import { getGoogleAccount, googleAccountStatus, type GoogleDb } from "./store";

export const GOOGLE_PLUGIN_ROUTE_PREFIX = "/api/plugins/google";
const SIGN_IN_COOKIE = "junior_google_sign_in";
const SIGN_IN_COOKIE_PATH = `${GOOGLE_PLUGIN_ROUTE_PREFIX}/oauth`;
const SIGN_IN_MAX_AGE_SECONDS = 600;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlPage(
  title: string,
  body: string,
  init: { headers?: Record<string, string>; status?: number } = {},
): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}` +
      `code{background:#f3f3f3;padding:0 .2rem}a.button{display:inline-block;padding:.5rem 1rem;border:1px solid #333;border-radius:.4rem;text-decoration:none;color:inherit}</style>` +
      `</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    {
      status: init.status ?? 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'",
        "Content-Type": "text/html; charset=utf-8",
        // The callback URL carries the authorization code.
        "Referrer-Policy": "no-referrer",
        ...init.headers,
      },
    },
  );
}

/** Public URL of this plugin's OAuth callback. */
export function googleCallbackUrl(request: Request): string {
  const base =
    process.env.JUNIOR_BASE_URL?.trim() || new URL(request.url).origin;
  return new URL(
    `${GOOGLE_PLUGIN_ROUTE_PREFIX}/oauth/callback`,
    base.endsWith("/") ? base : `${base}/`,
  ).toString();
}

function adminEmail(
  config: GoogleConfig,
  context: PluginApiRouteRequestContext | undefined,
): string | undefined {
  const user = context?.auth.user;
  const email = user?.email?.trim().toLowerCase();
  if (!email || user?.emailVerified !== true) {
    return undefined;
  }
  return config.adminEmails.includes(email) ? email : undefined;
}

function forbidden(config: GoogleConfig): Response {
  const reason = config.adminEmails.length
    ? "Your account is not allowed to connect Junior's Google account."
    : `No admins are configured. Set <code>${GOOGLE_ADMIN_EMAILS_ENV}</code>.`;
  return htmlPage("Google setup", `<p>${reason}</p>`, { status: 403 });
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      return rest.join("=");
    }
  }
  return undefined;
}

function signInCookie(value: string, maxAgeSeconds: number): string {
  return `${SIGN_IN_COOKIE}=${value}; Path=${SIGN_IN_COOKIE_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

async function renderSetup(
  config: GoogleConfig,
  db: GoogleDb,
): Promise<Response> {
  const record = await getGoogleAccount(db, config.accountEmail);
  const status = record ? googleAccountStatus(record) : undefined;
  const summary = status
    ? `<p>Connected as <code>${escapeHtml(status.accountEmail)}</code> by ${escapeHtml(status.connectedBy)} at ${escapeHtml(status.connectedAt)}.</p>` +
      `<p>Granted scopes: <code>${escapeHtml(status.scope)}</code></p>`
    : `<p>Not connected. Junior cannot use Google until an admin connects <code>${escapeHtml(config.accountEmail)}</code>.</p>`;
  return htmlPage(
    "Google setup",
    `${summary}<p>Connecting opens Google sign-in. Sign in as <code>${escapeHtml(config.accountEmail)}</code>, not as yourself.</p>` +
      `<p><a class="button" href="${GOOGLE_PLUGIN_ROUTE_PREFIX}/oauth/start">${status ? "Reconnect" : "Connect"} Google account</a></p>`,
  );
}

function startSignIn(config: GoogleConfig, request: Request): Response {
  const signIn = createGoogleSignInRequest();
  const location = googleAuthorizationUrl({
    config,
    redirectUri: googleCallbackUrl(request),
    request: signIn,
  });
  return new Response(null, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
      Location: location,
      "Set-Cookie": signInCookie(
        `${signIn.state}.${signIn.codeVerifier}`,
        SIGN_IN_MAX_AGE_SECONDS,
      ),
    },
  });
}

async function finishSignIn(input: {
  config: GoogleConfig;
  connectedBy: string;
  db: GoogleDb;
  request: Request;
}): Promise<Response> {
  const url = new URL(input.request.url);
  const clearCookie = { "Set-Cookie": signInCookie("", 0) };
  const failed = (message: string, status = 400) =>
    htmlPage(
      "Google setup failed",
      `<p>${escapeHtml(message)}</p><p><a href="${GOOGLE_PLUGIN_ROUTE_PREFIX}/setup">Back to setup</a></p>`,
      { headers: clearCookie, status },
    );

  const [expectedState, codeVerifier] = (
    readCookie(input.request, SIGN_IN_COOKIE) ?? ""
  ).split(".");
  const state = url.searchParams.get("state");
  if (!expectedState || !codeVerifier || state !== expectedState) {
    return failed("This sign-in link expired or did not start here.");
  }
  const providerError = url.searchParams.get("error");
  if (providerError) {
    return failed(`Google sign-in did not finish (${providerError}).`);
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return failed("Google did not return an authorization code.");
  }

  try {
    const connected = await connectGoogleAccount({
      code,
      codeVerifier,
      config: input.config,
      connectedBy: input.connectedBy,
      db: input.db,
      redirectUri: googleCallbackUrl(input.request),
    });
    return htmlPage(
      "Google connected",
      `<p>Junior now acts as <code>${escapeHtml(connected.accountEmail)}</code>.</p><p><a href="${GOOGLE_PLUGIN_ROUTE_PREFIX}/setup">Back to setup</a></p>`,
      { headers: clearCookie },
    );
  } catch (error) {
    if (error instanceof GoogleConnectError) {
      return failed(error.message);
    }
    throw error;
  }
}

/** Create the admin-only Google setup routes. */
export function createGoogleSetupRoutes(input: {
  config: GoogleConfig;
  db: GoogleDb;
}): PluginRouteApp {
  return {
    async fetch(request, context) {
      const { pathname } = new URL(request.url);
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      const admin = adminEmail(input.config, context);
      if (!admin) {
        return forbidden(input.config);
      }
      switch (pathname) {
        case "/setup":
          return await renderSetup(input.config, input.db);
        case "/oauth/start":
          return startSignIn(input.config, request);
        case "/oauth/callback":
          return await finishSignIn({ ...input, connectedBy: admin, request });
        default:
          return new Response("Not found", { status: 404 });
      }
    },
  };
}
