import { Hono, type Context, type Next } from "hono";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { JuniorReporting } from "@sentry/junior/reporting";
import { createJuniorReporting } from "@sentry/junior/reporting";
import { initSentry } from "@sentry/junior/instrumentation";
import {
  createDashboardAuth,
  resolveGoogleHostedDomainHint,
  type DashboardAuth,
  type DashboardSession,
} from "./auth";

const DEFAULT_BASE_PATH = "/";
const DEFAULT_AUTH_PATH = "/api/auth";
const DASHBOARD_CLIENT_VERSION = Date.now().toString(36);

export interface JuniorDashboardOptions {
  basePath?: string;
  authPath?: string;
  authRequired?: boolean;
  allowedGoogleDomains?: string[];
  allowedEmails?: string[];
  sessionMaxAgeSeconds?: number;
  trustedOrigins?: string[];
  auth?: DashboardAuth;
  reporting?: JuniorReporting;
}

type Variables = {
  dashboardSession: DashboardSession;
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

function normalizeValues(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

function isJsonRoute(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function dashboardLoginUrl(request: Request): string {
  const url = new URL(request.url);
  url.pathname = "/api/dashboard/login";
  url.search = "";
  return url.toString();
}

function callbackUrl(request: Request, basePath: string): string {
  const url = new URL(request.url);
  url.pathname = basePath;
  url.search = "";
  return url.toString();
}

function isAuthorized(
  session: DashboardSession,
  allowedDomains: string[],
  allowedEmails: string[],
): boolean {
  const email = session.user.email?.toLowerCase();
  const domain = session.user.hostedDomain?.toLowerCase();

  if (email && allowedEmails.includes(email)) {
    return true;
  }

  return Boolean(
    session.user.emailVerified && domain && allowedDomains.includes(domain),
  );
}

function unauthorized(request: Request): Response {
  if (isJsonRoute(new URL(request.url).pathname)) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  return Response.redirect(dashboardLoginUrl(request), 302);
}

function forbidden(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}

function dashboardSessionBypass(): DashboardSession {
  return {
    user: {
      email: "local-dashboard@localhost",
      emailVerified: true,
      hostedDomain: "localhost",
    },
  };
}

function readDashboardAsset(fileName: string): string {
  const localDistUrl = new URL(`./${fileName}`, import.meta.url);
  if (existsSync(localDistUrl)) {
    return readFileSync(localDistUrl, "utf8");
  }

  const sourceDistUrl = new URL(`../dist/${fileName}`, import.meta.url);
  if (existsSync(sourceDistUrl)) {
    return readFileSync(sourceDistUrl, "utf8");
  }

  const workspacePackagePath = path.join(
    process.cwd(),
    "node_modules",
    "@sentry",
    "junior-dashboard",
    "dist",
    fileName,
  );
  if (existsSync(workspacePackagePath)) {
    return readFileSync(workspacePackagePath, "utf8");
  }

  return "";
}

function readDashboardClient(): string {
  const client = readDashboardAsset("client.js");
  if (!client) {
    throw new Error("Junior dashboard client bundle was not found");
  }
  return client;
}

function dashboardTimeZone(): string {
  return process.env.JUNIOR_TIMEZONE || "America/Los_Angeles";
}

function readDashboardTailwind(): string {
  return readDashboardAsset("tailwind.css");
}

function dashboardPagePaths(basePath: string): string[] {
  return [
    basePath,
    basePath === "/" ? "/conversations" : `${basePath}/conversations`,
    basePath === "/" ? "/sessions" : `${basePath}/sessions`,
  ];
}

function renderDashboard(basePath: string): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Junior</title>
  <style>
    ${readDashboardTailwind()}
  </style>
</head>
<body class="m-0 bg-neutral-950 text-slate-100 [color-scheme:dark]">
  <div id="dashboard-root"></div>
  <script>
    window.__JUNIOR_DASHBOARD_BASE_PATH__ = ${JSON.stringify(basePath)};
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
          '<main class="grid min-h-screen place-items-center bg-neutral-950 p-8 text-slate-100">' +
          '<section class="w-full max-w-5xl border border-rose-500/60 bg-neutral-950 p-5 font-sans shadow-2xl shadow-rose-950/30">' +
          '<div class="font-mono text-xs uppercase leading-none text-slate-400">Dashboard Error</div>' +
          '<h1 class="mt-2 text-3xl font-bold leading-tight tracking-normal">Junior failed to render</h1>' +
          '<p class="my-4 max-w-3xl text-slate-400">The dashboard hit a client-side exception. The stack trace is shown here so the page does not fail blank.</p>' +
          '<pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words border border-slate-700 bg-black/70 p-4 font-mono text-sm leading-relaxed text-slate-100">' +
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
  <script type="module" src="/api/dashboard/client.js?v=${DASHBOARD_CLIENT_VERSION}"></script>
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

/** Create the authenticated dashboard Hono app mounted by Nitro. */
export function createDashboardApp(
  options: JuniorDashboardOptions,
): Hono<{ Variables: Variables }> {
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

  const authRequired = options.authRequired !== false;

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
        authPath,
        trustedOrigins: options.trustedOrigins ?? [],
        googleHostedDomain: resolveGoogleHostedDomainHint(allowedDomains),
        sessionMaxAgeSeconds: options.sessionMaxAgeSeconds,
      }))
    : undefined;
  const reporting = options.reporting ?? createJuniorReporting();
  const app = new Hono<{ Variables: Variables }>();

  if (auth) {
    app.on(["GET", "POST"], `${authPath}/*`, (c) => auth.handler(c.req.raw));
  }

  app.get("/favicon.ico", () => renderFavicon());

  app.get("/api/dashboard/login", async (c) => {
    if (!auth) {
      return Response.redirect(callbackUrl(c.req.raw, basePath), 302);
    }
    return auth.signInWithGoogle(c.req.raw, callbackUrl(c.req.raw, basePath));
  });

  const requireDashboardSession = async (
    c: Context<{ Variables: Variables }>,
    next: Next,
  ) => {
    if (!authRequired) {
      c.set("dashboardSession", dashboardSessionBypass());
      await next();
      return;
    }

    if (!auth) {
      return unauthorized(c.req.raw);
    }
    const session = await auth.getSession(c.req.raw);
    if (!session) {
      return unauthorized(c.req.raw);
    }
    if (!isAuthorized(session, allowedDomains, allowedEmails)) {
      return forbidden();
    }
    c.set("dashboardSession", session);
    await next();
  };

  if (basePath === "/") {
    // When mounted at root, a wildcard is required to cover all sub-routes
    // (e.g. /conversations, /sessions). `app.use("/", ...)` only matches
    // the exact root path in Hono and leaves those routes unprotected.
    app.use("/*", requireDashboardSession);
  } else {
    app.use(basePath, requireDashboardSession);
    app.use(`${basePath}/*`, requireDashboardSession);
  }
  app.use("/api/dashboard/*", requireDashboardSession);

  for (const path of dashboardPagePaths(basePath)) {
    app.get(path, () => renderDashboard(basePath));
    if (path !== "/") {
      app.get(`${path}/*`, () => renderDashboard(basePath));
    }
  }
  app.get("/api/dashboard/health", async () => {
    return Response.json(await reporting.getHealth());
  });
  app.get("/api/dashboard/runtime", async () => {
    return Response.json(await reporting.getRuntimeInfo());
  });
  app.get("/api/dashboard/plugins", async () => {
    return Response.json(await reporting.getPlugins());
  });
  app.get("/api/dashboard/skills", async () => {
    return Response.json(await reporting.getSkills());
  });
  app.get("/api/dashboard/sessions", async () => {
    return Response.json(await reporting.getSessions());
  });
  app.get("/api/dashboard/conversations/:conversationId", async (c) => {
    return Response.json(
      await reporting.getConversation(
        decodeURIComponent(c.req.param("conversationId")),
      ),
    );
  });
  app.get("/api/dashboard/config", () => {
    return Response.json({
      allowedEmailCount: allowedEmails.length,
      allowedGoogleDomainCount: allowedDomains.length,
      authRequired,
      basePath,
      sentryConversationLinks: hasSentryConversationLinks(),
      timeZone: dashboardTimeZone(),
    });
  });
  app.get("/api/dashboard/me", (c) => {
    return Response.json(c.get("dashboardSession"));
  });
  app.get("/api/dashboard/info", async () => {
    return Response.json(await reporting.getRuntimeInfo());
  });
  app.get("/api/dashboard/client.js", () => {
    return new Response(readDashboardClient(), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/javascript; charset=utf-8",
      },
    });
  });

  return app;
}
