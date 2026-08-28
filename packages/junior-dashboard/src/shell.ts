import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  dashboardAvatarHeaderAsset,
  dashboardClientAsset,
  dashboardInstallIconAsset,
  dashboardTailwindAsset,
} from "./assets";
import { dashboardRainbowProgressClass } from "./dashboardLoader";

const DASHBOARD_CLIENT_VERSION = Date.now().toString(36);
export const DASHBOARD_CLIENT_PATH = "/_junior/dashboard/client.js";
export const DASHBOARD_AVATAR_HEADER_PATH = "/_junior/dashboard/avatar.png";
export const DASHBOARD_INSTALL_ICON_PATH = "/_junior/dashboard/icon-512.png";
export const DASHBOARD_MANIFEST_PATH = "/_junior/dashboard/manifest.webmanifest";
const DASHBOARD_THEME_COLOR = "#000000";
const DASHBOARD_BACKGROUND_COLOR = "#000000";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

/** Load the dashboard browser bundle from the package build output. */
export function readDashboardClient(): string {
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

function readDashboardTailwind(): string {
  return (
    dashboardTailwindAsset ||
    readAssetUrl(new URL("./tailwind.css", import.meta.url)) ||
    readAssetUrl(new URL("../dist/tailwind.css", import.meta.url)) ||
    readWorkspaceAsset("tailwind.css")
  );
}

function readDashboardColorIcon(): ArrayBuffer {
  const embeddedAsset = dashboardInstallIconAsset || dashboardAvatarHeaderAsset;
  if (embeddedAsset) {
    return Uint8Array.from(Buffer.from(embeddedAsset, "base64")).buffer;
  }

  const assetUrl = new URL("./assets/junior-avatar.png", import.meta.url);
  if (!existsSync(assetUrl)) {
    throw new Error("Junior dashboard color icon was not found");
  }
  return Uint8Array.from(readFileSync(assetUrl)).buffer;
}

/** Load the dashboard header avatar image. */
export function readDashboardAvatarHeader(): ArrayBuffer {
  return readDashboardColorIcon();
}

function readDashboardInstallIcon(): ArrayBuffer {
  return readDashboardColorIcon();
}

/** Use the exact registered dashboard base path so installed launches do not 404. */
function dashboardStartUrl(basePath: string): string {
  return basePath;
}

/** List the browser page paths served by the authenticated dashboard shell. */
export function dashboardPagePaths(
  basePath: string,
  options: { componentGallery?: boolean } = {},
): Array<{ nested?: boolean; path: string }> {
  const paths: Array<{ nested?: boolean; path: string }> = [
    { path: basePath },
    {
      path: basePath === "/" ? "/code" : `${basePath}/code`,
    },
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

/** Serve the installable web app manifest for the dashboard shell. */
export function renderManifest(basePath: string, agentName: string): Response {
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

/** Serve the install icon used by the dashboard shell. */
export function renderInstallIcon(): Response {
  return new Response(readDashboardInstallIcon(), {
    headers: {
      "cache-control": "public, max-age=0, must-revalidate",
      "content-type": "image/png",
    },
  });
}

/** Render the authenticated dashboard HTML shell. */
export function renderDashboard(basePath: string, agentName: string): Response {
  const encodedAgentName = JSON.stringify(agentName).replace(/</g, "\\u003c");
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
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
<body class="m-0 bg-dashboard-ink text-dashboard-text-solid [color-scheme:var(--dashboard-color-scheme,dark)]">
  <div id="dashboard-root">
    <main class="grid min-h-screen place-items-center bg-dashboard-ink px-4 py-8 font-sans text-dashboard-text-solid md:px-8" aria-busy="true">
      <section class="grid w-full max-w-lg grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border border-dashboard-border-emphasis bg-dashboard-surface-raised p-4">
        <div class="grid size-9 shrink-0 select-none place-items-center bg-dashboard-ink text-sm font-black leading-none text-dashboard-text-solid">Jr</div>
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
          '<main class="grid min-h-screen place-items-center bg-dashboard-ink p-8 text-dashboard-text-solid">' +
          '<section class="w-full max-w-5xl border border-rose-400/50 bg-dashboard-surface-raised p-5 font-sans">' +
          '<div class="font-mono text-xs uppercase leading-none text-dashboard-text-faint">Dashboard Error</div>' +
          '<h1 class="mt-2 text-3xl font-bold leading-tight tracking-normal">' + escapeHtml(window.__JUNIOR_DASHBOARD_AGENT_NAME__) + ' failed to render</h1>' +
          '<p class="my-4 max-w-3xl text-dashboard-text-subtle">The dashboard hit a client-side exception. The stack trace is shown here so the page does not fail blank.</p>' +
          '<pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words border border-dashboard-border-strong bg-dashboard-ink p-4 font-mono text-sm leading-relaxed text-dashboard-text-solid">' +
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

/** Serve the dashboard favicon. */
export function renderFavicon(): Response {
  return new Response(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#000000"/><text x="16" y="20.5" fill="#ffffff" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11" font-weight="900" text-anchor="middle">Jr</text></svg>`,
    { headers: { "content-type": "image/svg+xml" } },
  );
}

/** Render a browser-readable access denied page for blocked dashboard users. */
export function renderForbiddenPage(agentName: string): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
  <title>${escapeHtml(agentName)} access denied</title>
  <style>
    ${readDashboardTailwind()}
  </style>
</head>
<body class="m-0 bg-dashboard-ink font-sans text-dashboard-text-solid [color-scheme:var(--dashboard-color-scheme,dark)]">
  <main class="grid min-h-screen place-items-center p-8">
    <section class="max-w-lg border-l-4 border-rose-400 pl-4">
      <h1 class="m-0 mb-3 text-3xl font-bold leading-tight">Access denied</h1>
      <p class="m-0 leading-relaxed text-dashboard-text-subtle">Your Google account is authenticated, but it is not allowed to use this ${escapeHtml(agentName)} dashboard.</p>
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
