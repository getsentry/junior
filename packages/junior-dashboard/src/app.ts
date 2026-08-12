import { Hono, type Context, type Next } from "hono";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  authenticatePersonalToken,
  createJuniorApi,
  jsonResponse,
  resolveViewerUser,
  updateViewerDisplayName,
  type JuniorApiVariables,
} from "@sentry/junior/api";
import { apiErrorSchema } from "@sentry/junior/api/schema";
import { initSentry } from "@sentry/junior/instrumentation";
import type {
  PluginApiRouteRequestContext,
  PluginRouteApp,
} from "@sentry/junior-plugin-api";
import { pluginApiRouteRequestContextSchema } from "@sentry/junior-plugin-api";
import {
  dashboardConfigSchema,
  dashboardIdentitySchema,
  dashboardProfileUpdateSchema,
} from "./api/schema";
import {
  dashboardAvatarHeaderAsset,
  dashboardClientAsset,
  dashboardInstallIconAsset,
  dashboardTailwindAsset,
} from "./assets";
import {
  createDashboardAuth,
  resolveGoogleHostedDomainHint,
  sanitizeDashboardSession,
  type DashboardAuth,
  type DashboardSession,
} from "./auth";
import { dashboardRainbowProgressClass } from "./dashboardLoader";
import { createMockReportingApi } from "./mock-reporting/routes";
import { resolveDashboardBaseURL } from "./url";

const DEFAULT_BASE_PATH = "/";
const DEFAULT_AUTH_PATH = "/api/auth";
const DASHBOARD_CLIENT_VERSION = Date.now().toString(36);
const DASHBOARD_CLIENT_PATH = "/_junior/dashboard/client.js";
const DASHBOARD_AVATAR_HEADER_PATH = "/_junior/dashboard/avatar.png";
const DASHBOARD_INSTALL_ICON_PATH = "/_junior/dashboard/icon-512.png";
const DASHBOARD_MANIFEST_PATH = "/_junior/dashboard/manifest.webmanifest";
const DASHBOARD_THEME_COLOR = "#000000";
const DASHBOARD_BACKGROUND_COLOR = "#000000";
const LOGIN_NEXT_PARAM = "next";
const LOCAL_VIEWER_EMAIL = "dev@example.com";
/** Process-local display names for mock reporting only. */
const mockDisplayNamesByEmail = new Map<string, string>();

export interface JuniorDashboardOptions {
  agentName?: string;
  basePath?: string;
  baseURL?: string;
  authPath?: string;
  authRequired?: boolean;
  allowedGoogleDomains?: string[];
  allowedEmails?: string[];
  sessionMaxAgeSeconds?: number;
  trustedOrigins?: string[];
  auth?: DashboardAuth;
  componentGallery?: boolean;
  mockConversations?: boolean;
}

interface DashboardRuntimeOptions extends JuniorDashboardOptions {
  pluginRoutes?: DashboardPluginRoute[];
}

interface DashboardPluginRoute {
  app: PluginRouteApp;
  pluginName: string;
}

type Variables = JuniorApiVariables & {
  authSession: DashboardSession;
};

function hasSentryConversationLinks(): boolean {
  return Boolean(
    process.env.SENTRY_DSN?.trim() && process.env.SENTRY_ORG_SLUG?.trim(),
  );
}

function normalizePath(path: string, fallback: string): string {
  const value = path.trim() || fallback;
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return stripTrailingSlashes(withSlash);
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeValues(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

/** Read dashboard list env vars as comma-separated strings or JSON arrays. */
function readEnvList(name: string): string[] | undefined {
  const value = process.env[name];
  if (!value?.trim()) {
    return undefined;
  }

  if (value.trim().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${name} must be a JSON string array`, {
        cause: error,
      });
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== "string")
    ) {
      throw new Error(`${name} must be a JSON string array`);
    }
    return parsed;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Read dashboard boolean env vars; only explicit true/false values apply. */
function readEnvFlag(name: string): boolean | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }
  return value === "true" ? true : value === "false" ? false : undefined;
}

function resolveDashboardOptions(
  options: DashboardRuntimeOptions,
): DashboardRuntimeOptions {
  return {
    ...options,
    authRequired:
      options.authRequired ?? readEnvFlag("JUNIOR_DASHBOARD_AUTH_REQUIRED"),
    allowedGoogleDomains:
      options.allowedGoogleDomains ??
      readEnvList("JUNIOR_DASHBOARD_GOOGLE_DOMAINS"),
    allowedEmails:
      options.allowedEmails ?? readEnvList("JUNIOR_DASHBOARD_ALLOWED_EMAILS"),
    trustedOrigins:
      options.trustedOrigins ?? readEnvList("JUNIOR_DASHBOARD_TRUSTED_ORIGINS"),
    componentGallery:
      options.componentGallery ??
      readEnvFlag("JUNIOR_DASHBOARD_COMPONENT_GALLERY"),
    mockConversations:
      options.mockConversations ??
      readEnvFlag("JUNIOR_DASHBOARD_MOCK_CONVERSATIONS"),
  };
}

function isJsonRoute(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function isDashboardPagePath(
  pathname: string,
  basePath: string,
  options: { componentGallery?: boolean } = {},
): boolean {
  for (const { nested, path } of dashboardPagePaths(basePath, options)) {
    if (pathname === path || (nested && pathname.startsWith(`${path}/`))) {
      return true;
    }
  }

  return false;
}

function dashboardReturnPath(
  url: URL,
  basePath: string,
  options: { componentGallery?: boolean } = {},
): string | undefined {
  if (!isDashboardPagePath(url.pathname, basePath, options)) {
    return undefined;
  }

  const path = `${url.pathname}${url.search}`;
  return path === basePath ? undefined : path;
}

function requestedReturnPath(
  url: URL,
  basePath: string,
  options: { componentGallery?: boolean } = {},
): string | undefined {
  const next = url.searchParams.get(LOGIN_NEXT_PARAM);
  if (!next?.startsWith("/") || next.startsWith("//")) {
    return undefined;
  }

  const returnUrl = new URL(next, url.origin);
  if (
    returnUrl.origin !== url.origin ||
    !isDashboardPagePath(returnUrl.pathname, basePath, options)
  ) {
    return undefined;
  }

  return `${returnUrl.pathname}${returnUrl.search}`;
}

function dashboardLoginUrl(
  request: Request,
  basePath: string,
  canonicalBaseURL?: string,
  options: { componentGallery?: boolean } = {},
): string {
  const requestUrl = new URL(request.url);
  const url = canonicalBaseURL
    ? new URL(canonicalBaseURL)
    : new URL(request.url);
  url.pathname = dashboardLoginPath(basePath);
  url.search = "";
  const returnPath = dashboardReturnPath(requestUrl, basePath, options);
  if (returnPath) {
    url.searchParams.set(LOGIN_NEXT_PARAM, returnPath);
  }
  return url.toString();
}

function canonicalLoginUrl(
  request: Request,
  canonicalBaseURL: string | undefined,
): string | undefined {
  if (!canonicalBaseURL) {
    return undefined;
  }

  const requestUrl = new URL(request.url);
  const canonicalUrl = new URL(canonicalBaseURL);
  if (requestUrl.origin === canonicalUrl.origin) {
    return undefined;
  }

  canonicalUrl.pathname = requestUrl.pathname;
  canonicalUrl.search = requestUrl.search;
  return canonicalUrl.toString();
}

function dashboardLoginPath(basePath: string): string {
  return basePath === "/" ? "/auth/login" : `${basePath}/auth/login`;
}

function callbackUrl(
  request: Request,
  basePath: string,
  options: { componentGallery?: boolean } = {},
): string {
  const requestUrl = new URL(request.url);
  const returnPath = requestedReturnPath(requestUrl, basePath, options);
  const url = new URL(request.url);
  if (returnPath) {
    const returnUrl = new URL(returnPath, requestUrl.origin);
    url.pathname = returnUrl.pathname;
    url.search = returnUrl.search;
  } else {
    url.pathname = basePath;
    url.search = "";
  }
  return url.toString();
}

function isAuthorized(
  session: DashboardSession,
  allowedDomains: string[],
  allowedEmails: string[],
): boolean {
  const email = session.user.email.toLowerCase();
  const emailSeparator = email.lastIndexOf("@");
  const emailDomain =
    emailSeparator > 0 ? email.slice(emailSeparator + 1) : undefined;

  if (session.user.emailVerified && email && allowedEmails.includes(email)) {
    return true;
  }

  return Boolean(
    session.user.emailVerified &&
    emailDomain &&
    allowedDomains.includes(emailDomain),
  );
}

function unauthorized(
  request: Request,
  basePath: string,
  canonicalBaseURL?: string,
  options: { componentGallery?: boolean } = {},
): Response {
  if (isJsonRoute(new URL(request.url).pathname)) {
    return jsonResponse(
      apiErrorSchema,
      { error: "unauthenticated" },
      { status: 401 },
    );
  }
  return Response.redirect(
    dashboardLoginUrl(request, basePath, canonicalBaseURL, options),
    302,
  );
}

function forbidden(request: Request, agentName: string): Response {
  if (!isJsonRoute(new URL(request.url).pathname)) {
    return new Response(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(agentName)} access denied</title>
  <style>
    ${readDashboardTailwind()}
  </style>
</head>
<body class="m-0 bg-black font-sans text-white [color-scheme:dark]">
  <main class="grid min-h-screen place-items-center p-8">
    <section class="max-w-lg border-l-4 border-rose-400 pl-4">
      <h1 class="m-0 mb-3 text-3xl font-bold leading-tight">Access denied</h1>
      <p class="m-0 leading-relaxed text-[#b8b8b8]">Your Google account is authenticated, but it is not allowed to use this ${escapeHtml(agentName)} dashboard.</p>
    </section>
  </main>
</body>
</html>`,
      {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        },
        status: 403,
      },
    );
  }
  return jsonResponse(apiErrorSchema, { error: "forbidden" }, { status: 403 });
}

function localAuthBypassSession(email = LOCAL_VIEWER_EMAIL): DashboardSession {
  return {
    user: {
      email,
      emailVerified: true,
    },
  };
}

function personalBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization) return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1];
}

function bearerSession(email: string): DashboardSession {
  return {
    user: {
      email,
      emailVerified: true,
    },
  };
}

function verifiedSessionEmail(session: DashboardSession): string | undefined {
  if (session.user.emailVerified !== true) return undefined;
  const email = session.user.email.trim().toLowerCase();
  return email || undefined;
}

/** Build a local mock viewer without creating a durable Junior user. */
function mockViewerFromSession(session: DashboardSession) {
  const email = verifiedSessionEmail(session);
  if (!email) return undefined;
  const displayName =
    mockDisplayNamesByEmail.get(email) ??
    session.user.name?.trim() ??
    undefined;
  return {
    email,
    id: `mock-user:${email}`,
    identities: [],
    ...(displayName ? { displayName } : {}),
  };
}

function readAssetUrl(url: URL): string {
  if (!existsSync(url)) {
    return "";
  }
  return readFileSync(url, "utf8");
}

function readWorkspaceAsset(fileName: string): string {
  const assetPath = path.join(
    process.cwd(),
    "node_modules",
    "@sentry",
    "junior-dashboard",
    "dist",
    fileName,
  );
  if (!existsSync(assetPath)) {
    return "";
  }
  return readFileSync(assetPath, "utf8");
}

function readDashboardClient(): string {
  const client =
    dashboardClientAsset ||
    readAssetUrl(new URL("./client.js", import.meta.url)) ||
    readAssetUrl(new URL("../dist/client.js", import.meta.url)) ||
    readWorkspaceAsset("client.js");
  if (!client) {
    throw new Error("Junior dashboard client bundle was not found");
  }
  return client;
}

function dashboardTimeZone(): string {
  return process.env.JUNIOR_TIMEZONE || "America/Los_Angeles";
}

function readDashboardTailwind(): string {
  return (
    dashboardTailwindAsset ||
    readAssetUrl(new URL("./tailwind.css", import.meta.url)) ||
    readAssetUrl(new URL("../dist/tailwind.css", import.meta.url)) ||
    readWorkspaceAsset("tailwind.css")
  );
}

function readDashboardAvatarHeader(): ArrayBuffer {
  if (dashboardAvatarHeaderAsset) {
    return Uint8Array.from(Buffer.from(dashboardAvatarHeaderAsset, "base64"))
      .buffer;
  }

  const assetUrl = new URL("./assets/junior-avatar-line.png", import.meta.url);
  if (!existsSync(assetUrl)) {
    throw new Error("Junior dashboard avatar asset was not found");
  }
  return Uint8Array.from(readFileSync(assetUrl)).buffer;
}

function readDashboardInstallIcon(): ArrayBuffer {
  if (dashboardInstallIconAsset) {
    return Uint8Array.from(Buffer.from(dashboardInstallIconAsset, "base64"))
      .buffer;
  }

  const assetUrl = new URL("./assets/junior-avatar.png", import.meta.url);
  if (!existsSync(assetUrl)) {
    throw new Error("Junior dashboard install icon was not found");
  }
  return Uint8Array.from(readFileSync(assetUrl)).buffer;
}

/** Use the exact registered dashboard base path so installed launches do not 404. */
function dashboardStartUrl(basePath: string): string {
  return basePath;
}

function dashboardPagePaths(
  basePath: string,
  options: { componentGallery?: boolean } = {},
): Array<{ nested?: boolean; path: string }> {
  const paths: Array<{ nested?: boolean; path: string }> = [
    { path: basePath },
    {
      nested: true,
      path: basePath === "/" ? "/conversations" : `${basePath}/conversations`,
    },
    {
      nested: true,
      path: basePath === "/" ? "/people" : `${basePath}/people`,
    },
    {
      nested: true,
      path: basePath === "/" ? "/locations" : `${basePath}/locations`,
    },
    {
      nested: true,
      path: basePath === "/" ? "/system" : `${basePath}/system`,
    },
    {
      nested: true,
      path: basePath === "/" ? "/tasks" : `${basePath}/tasks`,
    },
    {
      nested: true,
      path: basePath === "/" ? "/memories" : `${basePath}/memories`,
    },
    {
      nested: true,
      path: basePath === "/" ? "/settings" : `${basePath}/settings`,
    },
    {
      nested: true,
      path: basePath === "/" ? "/plugins" : `${basePath}/plugins`,
    },
  ];
  if (options.componentGallery) {
    paths.push({
      nested: true,
      path: basePath === "/" ? "/dev" : `${basePath}/dev`,
    });
  }
  return paths;
}

function renderManifest(basePath: string, agentName: string): Response {
  const startUrl = dashboardStartUrl(basePath);
  return new Response(
    JSON.stringify({
      background_color: DASHBOARD_BACKGROUND_COLOR,
      description: `${agentName} dashboard`,
      display: "standalone",
      icons: [
        {
          purpose: "any",
          sizes: "512x512",
          src: DASHBOARD_INSTALL_ICON_PATH,
          type: "image/png",
        },
      ],
      name: agentName,
      scope: startUrl,
      short_name: agentName,
      start_url: startUrl,
      theme_color: DASHBOARD_THEME_COLOR,
    }),
    {
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
        "content-type": "application/manifest+json",
      },
    },
  );
}

function renderInstallIcon(): Response {
  return new Response(readDashboardInstallIcon(), {
    headers: {
      "cache-control": "public, max-age=0, must-revalidate",
      "content-type": "image/png",
    },
  });
}

function renderDashboard(basePath: string, agentName: string): Response {
  const encodedAgentName = JSON.stringify(agentName).replace(/</g, "\\u003c");
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="${DASHBOARD_THEME_COLOR}" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="${escapeHtml(agentName)}" />
  <link rel="manifest" href="${DASHBOARD_MANIFEST_PATH}" />
  <link rel="apple-touch-icon" href="${DASHBOARD_INSTALL_ICON_PATH}" />
  <title>${escapeHtml(agentName)}</title>
  <style>
    ${readDashboardTailwind()}
  </style>
</head>
<body class="m-0 bg-black text-white [color-scheme:dark]">
  <div id="dashboard-root">
    <main class="grid min-h-screen place-items-center bg-black px-4 py-8 font-sans text-white md:px-8" aria-busy="true">
      <section class="grid w-full max-w-lg grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border border-white/15 bg-[#0b0b0b] p-4">
        <div class="grid size-9 shrink-0 select-none place-items-center bg-black text-sm font-black leading-none text-white">Jr</div>
        <div class="min-w-0">
          <div class="font-bold">Loading ${escapeHtml(agentName)}</div>
          <div class="${dashboardRainbowProgressClass} mt-3 h-1.5 w-full" role="progressbar" aria-label="Loading ${escapeHtml(agentName)}"></div>
        </div>
      </section>
    </main>
  </div>
  <script>
    window.__JUNIOR_DASHBOARD_BASE_PATH__ = ${JSON.stringify(basePath)};
    window.__JUNIOR_DASHBOARD_AGENT_NAME__ = ${encodedAgentName};
    (function () {
      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      }
      function errorText(error) {
        if (!error) return "Unknown dashboard error";
        if (typeof error === "string") return error;
        if (error.stack) return error.stack;
        if (error.message) return error.message;
        try {
          return JSON.stringify(error, null, 2);
        } catch (_error) {
          return String(error);
        }
      }
      window.__JUNIOR_DASHBOARD_SHOW_ERROR__ = function (error) {
        var root = document.getElementById("dashboard-root");
        if (!root) return;
        root.innerHTML =
          '<main class="grid min-h-screen place-items-center bg-black p-8 text-white">' +
          '<section class="w-full max-w-5xl border border-rose-400/50 bg-[#0b0b0b] p-5 font-sans">' +
          '<div class="font-mono text-xs uppercase leading-none text-[#888]">Dashboard Error</div>' +
          '<h1 class="mt-2 text-3xl font-bold leading-tight tracking-normal">' + escapeHtml(window.__JUNIOR_DASHBOARD_AGENT_NAME__) + ' failed to render</h1>' +
          '<p class="my-4 max-w-3xl text-[#b8b8b8]">The dashboard hit a client-side exception. The stack trace is shown here so the page does not fail blank.</p>' +
          '<pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words border border-white/10 bg-black p-4 font-mono text-sm leading-relaxed text-white">' +
          escapeHtml(errorText(error)) +
          "</pre></section></main>";
      };
      window.addEventListener("error", function (event) {
        window.__JUNIOR_DASHBOARD_SHOW_ERROR__(event.error || event.message);
      });
      window.addEventListener("unhandledrejection", function (event) {
        window.__JUNIOR_DASHBOARD_SHOW_ERROR__(event.reason);
      });
    })();
  </script>
  <script type="module" src="${DASHBOARD_CLIENT_PATH}?v=${DASHBOARD_CLIENT_VERSION}"></script>
</body>
</html>`,
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
}

function renderFavicon(): Response {
  return new Response(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#000000"/><text x="16" y="20.5" fill="#ffffff" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11" font-weight="900" text-anchor="middle">Jr</text></svg>`,
    { headers: { "content-type": "image/svg+xml" } },
  );
}

function pluginRoutePrefix(pluginName: string): string {
  return `/api/plugins/${pluginName}`;
}

/** Strip the core-owned plugin prefix before dispatching to a plugin app. */
function pluginRouteRequest(request: Request, prefix: string): Request {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const nextPath =
    pathname === prefix ? "/" : pathname.slice(prefix.length) || "/";
  url.pathname = nextPath.startsWith("/") ? nextPath : `/${nextPath}`;
  return new Request(url, request);
}

/** Build the sanitized per-request context passed into plugin API route apps. */
function pluginRouteContext(
  pluginName: string,
  session: DashboardSession,
): PluginApiRouteRequestContext {
  const { email, emailVerified, name } = session.user;
  return {
    auth: {
      user: {
        email,
        emailVerified,
        name,
      },
    },
    pluginName,
  } satisfies PluginApiRouteRequestContext;
}

/** Create the authenticated dashboard Hono app mounted by Nitro. */
export function createDashboardApp(
  rawOptions: DashboardRuntimeOptions,
): Hono<{ Variables: Variables }> {
  const options = resolveDashboardOptions(rawOptions);

  if (process.env.SENTRY_DSN?.trim()) {
    initSentry();
  }

  const basePath = normalizePath(
    options.basePath ?? DEFAULT_BASE_PATH,
    DEFAULT_BASE_PATH,
  );
  const authPath = normalizePath(
    options.authPath ?? DEFAULT_AUTH_PATH,
    DEFAULT_AUTH_PATH,
  );
  const allowedDomains = normalizeValues(options.allowedGoogleDomains);
  const allowedEmails = normalizeValues(options.allowedEmails);
  const agentName = options.agentName?.trim() || "Junior";

  const authRequired = options.authRequired !== false;
  const configuredBaseURL = options.baseURL ?? process.env.JUNIOR_BASE_URL;
  let canonicalBaseURL: string | undefined;
  if (authRequired && (configuredBaseURL || !options.auth)) {
    canonicalBaseURL = resolveDashboardBaseURL({ baseURL: configuredBaseURL });
  }

  if (
    authRequired &&
    allowedDomains.length === 0 &&
    allowedEmails.length === 0
  ) {
    throw new Error(
      "Junior dashboard auth requires allowedGoogleDomains or allowedEmails",
    );
  }

  const auth = authRequired
    ? (options.auth ??
      createDashboardAuth({
        agentName,
        authPath,
        baseURL: options.baseURL,
        trustedOrigins: options.trustedOrigins ?? [],
        googleHostedDomain: resolveGoogleHostedDomainHint(allowedDomains),
        sessionMaxAgeSeconds: options.sessionMaxAgeSeconds,
      }))
    : undefined;
  const app = new Hono<{ Variables: Variables }>();

  app.get(dashboardLoginPath(basePath), async (c) => {
    const canonicalUrl = canonicalLoginUrl(c.req.raw, canonicalBaseURL);
    if (canonicalUrl) {
      return Response.redirect(canonicalUrl, 302);
    }
    const returnUrl = callbackUrl(c.req.raw, basePath, {
      componentGallery: options.componentGallery,
    });
    if (!auth) {
      return Response.redirect(returnUrl, 302);
    }
    const session = await auth.getSession(c.req.raw);
    if (session && isAuthorized(session, allowedDomains, allowedEmails)) {
      return Response.redirect(returnUrl, 302);
    }
    return auth.signInWithGoogle(c.req.raw, returnUrl);
  });

  if (auth) {
    app.on(["GET", "POST"], `${authPath}/*`, (c) => auth.handler(c.req.raw));
  }

  app.get("/favicon.ico", () => renderFavicon());
  app.get(DASHBOARD_MANIFEST_PATH, () => renderManifest(basePath, agentName));
  app.get(DASHBOARD_INSTALL_ICON_PATH, () => renderInstallIcon());

  /**
   * Require dashboard auth for every later route; login, Better Auth callbacks,
   * favicon, install manifest, and install icon are the only registration-order
   * bypasses.
   */
  const requireAuth = async (
    c: Context<{ Variables: Variables }>,
    next: Next,
  ) => {
    const pathname = new URL(c.req.url).pathname;
    if (!authRequired) {
      const session = localAuthBypassSession();
      c.set("authSession", session);
      if (pathname.startsWith("/api/")) {
        const viewer = options.mockConversations
          ? mockViewerFromSession(session)
          : await resolveViewerUser(LOCAL_VIEWER_EMAIL);
        if (!viewer) {
          throw new Error("Local dashboard viewer could not be resolved");
        }
        c.set("viewer", viewer);
      }
      await next();
      return;
    }

    if (!auth) {
      return unauthorized(c.req.raw, basePath, canonicalBaseURL, {
        componentGallery: options.componentGallery,
      });
    }
    const browserSession = await auth.getSession(c.req.raw);
    const token = personalBearerToken(c.req.raw);
    const tokenEmail =
      !browserSession &&
      token &&
      (c.req.method === "GET" || c.req.method === "HEAD") &&
      pathname.startsWith("/api/") &&
      !pathname.startsWith("/api/personal-tokens")
        ? await authenticatePersonalToken(token)
        : undefined;
    const session =
      browserSession ?? (tokenEmail ? bearerSession(tokenEmail) : null);
    if (!session) {
      return unauthorized(c.req.raw, basePath, canonicalBaseURL, {
        componentGallery: options.componentGallery,
      });
    }
    if (!isAuthorized(session, allowedDomains, allowedEmails)) {
      return forbidden(c.req.raw, agentName);
    }
    const sanitizedSession = sanitizeDashboardSession(session);
    c.set("authSession", sanitizedSession);
    // Resolve the canonical user only for authenticated API requests.
    if (pathname.startsWith("/api/")) {
      const email = verifiedSessionEmail(sanitizedSession);
      if (!email) {
        throw new Error(
          "Authenticated dashboard session has no verified email",
        );
      }
      // Mock reporting stays local and does not require durable user rows.
      const viewer = options.mockConversations
        ? mockViewerFromSession(sanitizedSession)
        : await resolveViewerUser(email);
      if (!viewer) {
        throw new Error("Authenticated dashboard user could not be resolved");
      }
      c.set("viewer", viewer);
    }
    await next();
  };

  app.use("*", requireAuth);

  for (const { nested, path } of dashboardPagePaths(basePath, {
    componentGallery: options.componentGallery,
  })) {
    app.get(path, () => renderDashboard(basePath, agentName));
    if (nested) {
      app.get(`${path}/*`, () => renderDashboard(basePath, agentName));
    }
  }
  for (const route of options.pluginRoutes ?? []) {
    const prefix = pluginRoutePrefix(route.pluginName);
    const handler = (c: Context<{ Variables: Variables }>) =>
      route.app.fetch(
        pluginRouteRequest(c.req.raw, prefix),
        pluginApiRouteRequestContextSchema.parse(
          pluginRouteContext(route.pluginName, c.get("authSession")),
        ),
      );
    app.all(prefix, handler);
    app.all(`${prefix}/*`, handler);
  }
  if (options.mockConversations) {
    app.route("/api", createMockReportingApi());
  }
  app.route("/", createJuniorApi());
  app.get("/api/config", () => {
    return jsonResponse(dashboardConfigSchema, {
      allowedEmailCount: allowedEmails.length,
      allowedGoogleDomainCount: allowedDomains.length,
      authRequired,
      authPath,
      basePath,
      componentGallery: options.componentGallery === true,
      sentryConversationLinks: hasSentryConversationLinks(),
      timeZone: dashboardTimeZone(),
    });
  });
  app.get("/api/me", (c) => {
    const session = c.get("authSession");
    const viewer = c.get("viewer");
    return jsonResponse(dashboardIdentitySchema, {
      user: {
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        name: viewer?.displayName ?? session.user.name,
      },
    });
  });
  app.patch("/api/me", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonResponse(
        apiErrorSchema,
        { error: "Invalid request body." },
        { status: 400 },
      );
    }
    const parsed = dashboardProfileUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(
        apiErrorSchema,
        { error: "Invalid request body." },
        { status: 400 },
      );
    }
    const viewer = c.get("viewer");
    if (!viewer) {
      return jsonResponse(
        apiErrorSchema,
        { error: "Authentication required." },
        { status: 401 },
      );
    }
    const session = c.get("authSession");
    // Mock reporting keeps profile edits process-local and out of SQL.
    if (options.mockConversations) {
      mockDisplayNamesByEmail.set(viewer.email, parsed.data.displayName);
      return jsonResponse(dashboardIdentitySchema, {
        user: {
          email: session.user.email,
          emailVerified: session.user.emailVerified,
          name: parsed.data.displayName,
        },
      });
    }
    const updated = await updateViewerDisplayName(
      viewer.id,
      parsed.data.displayName,
    );
    if (!updated) {
      return jsonResponse(
        apiErrorSchema,
        { error: "User not found." },
        { status: 404 },
      );
    }
    return jsonResponse(dashboardIdentitySchema, {
      user: {
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        name: updated.displayName,
      },
    });
  });
  app.get(DASHBOARD_CLIENT_PATH, () => {
    return new Response(readDashboardClient(), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/javascript; charset=utf-8",
      },
    });
  });
  app.get(DASHBOARD_AVATAR_HEADER_PATH, () => {
    return new Response(readDashboardAvatarHeader(), {
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
        "content-type": "image/png",
      },
    });
  });
  app.notFound((c) =>
    isJsonRoute(new URL(c.req.url).pathname)
      ? jsonResponse(
          apiErrorSchema,
          { error: "Resource not found." },
          { status: 404 },
        )
      : c.text("Not Found", 404),
  );

  return app;
}
