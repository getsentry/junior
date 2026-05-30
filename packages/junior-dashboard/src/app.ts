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

    :root {
      color-scheme: dark;
      --bg: #05070c;
      --rail: #080b13;
      --panel: #0d111d;
      --panel-hot: #111827;
      --line: #263348;
      --line-hot: #40516b;
      --text: #f5f8ff;
      --muted: #95a3b8;
      --dim: #637084;
      --cyan: #22d3ee;
      --green: #36f69a;
      --coral: #ff5c7a;
      --amber: #fbbf24;
      --orange: #fb923c;
      --violet: #a78bfa;
      --blue: #60a5fa;
      --gray: #94a3b8;
      --ink: #05070c;
    }

    * { box-sizing: border-box; }

    body {
      min-height: 100vh;
      margin: 0;
      background:
        radial-gradient(circle at 12% 8%, rgba(34, 211, 238, 0.18), transparent 28rem),
        radial-gradient(circle at 92% 14%, rgba(255, 92, 122, 0.15), transparent 24rem),
        linear-gradient(135deg, rgba(167, 139, 250, 0.06), transparent 34rem),
        var(--bg);
      color: var(--text);
      font: 17px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    button {
      color: inherit;
      font: inherit;
    }

    .deck {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }

    .topbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 1rem;
      align-items: center;
      padding: 1rem clamp(1rem, 3vw, 2rem);
      border-bottom: 1px solid rgba(96, 165, 250, 0.24);
      background: rgba(5, 7, 12, 0.82);
      backdrop-filter: blur(18px);
      position: sticky;
      top: 0;
      z-index: 4;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.8rem;
      min-width: 0;
    }

    .brand-link {
      color: inherit;
      text-decoration: none;
    }

    .mark {
      width: 2.3rem;
      aspect-ratio: 1;
      border: 1px solid rgba(54, 246, 154, 0.7);
      display: grid;
      place-items: center;
      color: var(--green);
      background: linear-gradient(145deg, rgba(54, 246, 154, 0.18), rgba(34, 211, 238, 0.08));
      box-shadow: 0 0 24px rgba(54, 246, 154, 0.2), inset 0 0 16px rgba(34, 211, 238, 0.12);
      font: 800 0.92rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .title {
      min-width: 0;
    }

    .title h1 {
      margin: 0;
      font-size: clamp(1.25rem, 2vw, 1.7rem);
      line-height: 1.05;
      letter-spacing: 0;
    }

    .subtitle {
      margin-top: 0.18rem;
      color: var(--muted);
      font: 0.8rem/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .top-actions {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      min-width: 0;
    }

    .nav {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      min-width: 0;
    }

    .nav-link {
      border: 1px solid rgba(64, 81, 107, 0.7);
      background: rgba(8, 11, 19, 0.72);
      color: var(--muted);
      padding: 0.42rem 0.58rem;
      text-decoration: none;
      font: 0.82rem/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: nowrap;
    }

    .nav-link:hover,
    .nav-link.active {
      border-color: rgba(54, 246, 154, 0.68);
      background: rgba(54, 246, 154, 0.1);
      color: var(--green);
    }

    .icon-button {
      width: 2.2rem;
      height: 2.2rem;
      border: 1px solid rgba(34, 211, 238, 0.38);
      background: rgba(34, 211, 238, 0.08);
      display: grid;
      place-items: center;
      cursor: pointer;
      padding: 0;
      color: var(--cyan);
    }

    .icon-button svg {
      width: 1rem;
      height: 1rem;
    }

    .icon-button:hover,
    .copy:hover {
      border-color: var(--cyan);
      background: rgba(34, 211, 238, 0.16);
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(17rem, 0.9fr) minmax(0, 1.55fr) minmax(17rem, 0.9fr);
      gap: 1rem;
      padding: 1rem clamp(1rem, 3vw, 2rem) 2rem;
    }

    .command-layout {
      grid-template-columns: minmax(17rem, 0.32fr) minmax(0, 1fr);
    }

    .sessions-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(17rem, 0.23fr);
      gap: 1rem;
      padding: 1rem clamp(1rem, 3vw, 2rem) 2rem;
      min-width: 0;
    }

    .conversations-layout {
      display: block;
      padding: 1rem clamp(1rem, 3vw, 2rem) 2rem;
      min-width: 0;
    }

    .conversation-layout {
      display: block;
      padding: 1rem clamp(1rem, 3vw, 2rem) 2rem;
      min-width: 0;
    }

    .loading-layout {
      display: grid;
      place-items: center;
      min-height: calc(100vh - 5rem);
      padding: 1rem clamp(1rem, 3vw, 2rem) 2rem;
    }

    .loading-panel {
      width: min(34rem, 100%);
      border: 1px solid rgba(34, 211, 238, 0.38);
      background:
        linear-gradient(90deg, rgba(34, 211, 238, 0.14), transparent 20rem),
        rgba(8, 11, 19, 0.78);
      padding: 1rem;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 0.85rem;
      align-items: center;
    }

    .loading-mark {
      width: 2.5rem;
      aspect-ratio: 1;
      display: grid;
      place-items: center;
      background: var(--green);
      color: var(--ink);
      font-weight: 900;
      box-shadow: 0 0 24px rgba(54, 246, 154, 0.42);
    }

    .loading-title {
      font-weight: 800;
    }

    .loading-bar {
      height: 0.42rem;
      margin-top: 0.6rem;
      background:
        linear-gradient(90deg, var(--cyan), var(--green), var(--coral), var(--cyan));
      background-size: 220% 100%;
      animation: loading-pan 1.4s linear infinite;
    }

    @keyframes loading-pan {
      from { background-position: 0 0; }
      to { background-position: 220% 0; }
    }

    .rail,
    .stage,
    .sessions-main,
    .sessions-rail,
    .conversation-main {
      min-width: 0;
    }

    .section {
      border: 1px solid rgba(64, 81, 107, 0.78);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent 8rem),
        rgba(13, 17, 29, 0.84);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
      margin-bottom: 1rem;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.8rem;
      padding: 0.8rem 0.9rem 0.65rem;
      border-bottom: 1px solid rgba(64, 81, 107, 0.62);
      background: rgba(8, 11, 19, 0.7);
    }

    .kicker {
      color: var(--muted);
      font: 0.78rem/1.15 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-transform: uppercase;
    }

    .section-title {
      margin-top: 0.18rem;
      font-weight: 780;
      font-size: 1.05rem;
    }

    .live {
      display: inline-flex;
      align-items: center;
      gap: 0.38rem;
      color: var(--green);
      font: 0.82rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .live::before {
      content: "";
      width: 0.55rem;
      aspect-ratio: 1;
      background: var(--green);
      box-shadow: 0 0 18px var(--green);
    }

    .meter {
      padding: 1rem 0.9rem 0.9rem;
    }

    .status-word {
      font-size: clamp(2.4rem, 8vw, 5.25rem);
      line-height: 0.86;
      font-weight: 900;
      color: var(--green);
      text-shadow: 0 0 28px rgba(54, 246, 154, 0.28);
    }

    .status-caption {
      margin-top: 0.6rem;
      color: var(--muted);
      font: 0.84rem/1.42 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1px;
      background: rgba(64, 81, 107, 0.72);
      border-top: 1px solid rgba(64, 81, 107, 0.72);
    }

    .stat {
      min-width: 0;
      background: rgba(8, 11, 19, 0.88);
      padding: 0.78rem 0.8rem;
    }

    .stat-value {
      color: var(--text);
      font-size: 1.65rem;
      line-height: 1;
      font-weight: 850;
    }

    .stat-label {
      margin-top: 0.32rem;
      color: var(--muted);
      font: 0.78rem/1.15 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-transform: uppercase;
    }

    .chart-legend {
      display: flex;
      align-items: center;
      gap: 0.8rem;
      color: var(--muted);
      font: 0.78rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-transform: uppercase;
    }

    .chart-legend span {
      display: inline-flex;
      align-items: center;
      gap: 0.34rem;
    }

    .chart-legend span::before {
      content: "";
      width: 0.52rem;
      aspect-ratio: 1;
      background: currentColor;
    }

    .legend-complete {
      color: var(--gray);
    }

    .legend-complete::before {
      opacity: 0.65;
      border-radius: 999px;
    }

    .legend-hung {
      color: #f59e0b;
    }

    .legend-hung::before {
      border-radius: 999px;
    }

    .legend-error {
      color: #f43f5e;
    }

    .legend-error::before {
      border-radius: 999px;
    }

    .turn-chart {
      min-height: 12rem;
      padding: 0.75rem 0.65rem 0.35rem;
    }

    .turn-chart-dot {
      cursor: pointer;
      outline: none;
      transition:
        filter 120ms ease,
        stroke 120ms ease,
        stroke-width 120ms ease;
    }

    .turn-chart-dot:hover,
    .turn-chart-dot:focus-visible {
      filter: brightness(1.2);
      stroke: var(--green);
      stroke-width: 2;
    }

    .chart-summary {
      color: var(--muted);
      font: 0.8rem/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .chart-tooltip {
      border: 1px solid rgba(64, 81, 107, 0.72);
      background: rgba(5, 7, 12, 0.94);
      color: var(--muted);
      padding: 0.55rem 0.65rem;
      font: 0.78rem/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      box-shadow: 0 1rem 2.5rem rgba(0, 0, 0, 0.35);
    }

    .chart-tooltip-title {
      color: var(--text);
      margin-bottom: 0.35rem;
    }

    .chart-tooltip-primary {
      color: var(--text);
      font-weight: 700;
    }

    .chart-summary {
      border-top: 1px solid rgba(64, 81, 107, 0.5);
      padding: 0.62rem 0.9rem 0.78rem;
    }

    .kv {
      padding: 0.7rem 0.9rem 0.9rem;
      display: grid;
      gap: 0.55rem;
    }

    .kv-row {
      display: grid;
      grid-template-columns: 5rem minmax(0, 1fr) auto;
      gap: 0.55rem;
      align-items: center;
      min-width: 0;
    }

    .kv-label {
      color: var(--dim);
      font: 0.78rem/1.15 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-transform: uppercase;
    }

    .kv-value {
      min-width: 0;
      color: var(--text);
      font: 0.84rem/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
    }

    .copy {
      width: 1.75rem;
      height: 1.75rem;
      border: 1px solid rgba(96, 165, 250, 0.34);
      background: rgba(96, 165, 250, 0.08);
      cursor: pointer;
      color: var(--blue);
      display: grid;
      place-items: center;
      font: 0.82rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .pulse-strip {
      border: 1px solid rgba(64, 81, 107, 0.62);
      background: rgba(8, 11, 19, 0.7);
      padding: 0.9rem;
      margin-bottom: 1rem;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 0.7rem 1rem;
      align-items: stretch;
    }

    .conversation-layout .pulse-strip {
      align-items: stretch;
    }

    .pulse-strip.status-active {
      border-color: rgba(54, 246, 154, 0.62);
    }

    .pulse-strip.status-hung {
      border-color: rgba(251, 191, 36, 0.72);
    }

    .pulse-strip.status-failed {
      border-color: rgba(255, 92, 122, 0.7);
    }

    .pulse-strip.status-idle {
      border-color: rgba(148, 163, 184, 0.5);
    }

    .pulse-sigil {
      width: 2.35rem;
      aspect-ratio: 1;
      background: var(--cyan);
      color: var(--ink);
      display: grid;
      place-items: center;
      font-weight: 900;
      box-shadow: 0 0 24px rgba(34, 211, 238, 0.42);
      align-self: start;
    }

    .pulse-sigil.status-active {
      background: var(--green);
      box-shadow:
        0 0 0 0.28rem rgba(54, 246, 154, 0.12),
        0 0 28px rgba(54, 246, 154, 0.58);
    }

    .pulse-sigil.status-idle {
      background: var(--gray);
      box-shadow:
        0 0 0 0.28rem rgba(148, 163, 184, 0.1),
        0 0 18px rgba(148, 163, 184, 0.24);
      filter: saturate(0.35);
    }

    .pulse-title {
      font-weight: 800;
      font-size: 1.18rem;
      line-height: 1.15;
    }

    .pulse-meta {
      color: var(--muted);
      font: 0.82rem/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
    }

    .conversation-header-copy {
      display: grid;
      align-content: space-between;
      gap: 0.32rem;
      min-width: 0;
    }

    .conversation-stats {
      grid-column: 1 / -1;
      padding-top: 0.7rem;
      border-top: 1px solid rgba(64, 81, 107, 0.42);
    }

    .inline-link {
      color: var(--cyan);
      text-decoration: none;
    }

    .inline-link:hover {
      color: var(--green);
      text-decoration: underline;
      text-underline-offset: 0.18rem;
    }

    .pulse-status-panel {
      display: grid;
      align-content: space-between;
      justify-items: end;
      gap: 0.35rem;
      min-width: 12rem;
    }

    .activity-indicator {
      display: inline-flex;
      align-items: center;
      gap: 0.38rem;
      color: var(--gray);
      font: 0.78rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .activity-indicator.active {
      color: var(--green);
      text-shadow: 0 0 14px rgba(54, 246, 154, 0.42);
    }

    .activity-indicator.hung {
      color: var(--amber);
      text-shadow: 0 0 14px rgba(251, 191, 36, 0.42);
    }

    .activity-indicator.failed {
      color: var(--coral);
      text-shadow: 0 0 14px rgba(255, 92, 122, 0.38);
    }

    .activity-box {
      width: 0.68rem;
      aspect-ratio: 1;
      border: 1px solid currentColor;
      background: transparent;
      box-shadow: none;
      flex: 0 0 auto;
    }

    .activity-indicator.active .activity-box {
      background: var(--green);
      box-shadow: 0 0 16px rgba(54, 246, 154, 0.76);
    }

    .activity-indicator.hung .activity-box {
      background: var(--amber);
      box-shadow: 0 0 16px rgba(251, 191, 36, 0.7);
    }

    .activity-indicator.failed .activity-box {
      background: var(--coral);
      box-shadow: 0 0 16px rgba(255, 92, 122, 0.62);
    }

    .filters {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .filter {
      border: 1px solid rgba(64, 81, 107, 0.76);
      background: rgba(8, 11, 19, 0.76);
      color: var(--muted);
      cursor: pointer;
      padding: 0.34rem 0.52rem;
      font: 0.78rem/1.15 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-transform: uppercase;
    }

    .filter:hover,
    .filter.active {
      border-color: rgba(34, 211, 238, 0.7);
      background: rgba(34, 211, 238, 0.12);
      color: var(--cyan);
    }

    .session-workbench {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(20rem, 0.32fr);
      min-height: calc(100vh - 15rem);
    }

    .conversation-list-shell {
      min-height: calc(100vh - 15rem);
    }

    .sessions {
      display: grid;
      gap: 0.6rem;
      padding: 0.85rem;
    }

    .session-row {
      position: relative;
      display: grid;
      grid-template-columns: 5.4rem minmax(0, 1fr) auto;
      gap: 0.8rem;
      align-items: center;
      min-height: 4.1rem;
      border: 1px solid rgba(64, 81, 107, 0.72);
      background:
        linear-gradient(90deg, rgba(54, 246, 154, 0.1), transparent 11rem),
        rgba(8, 11, 19, 0.82);
      overflow: hidden;
      padding: 0.72rem 0.8rem;
    }

    .session-row.status-active {
      border-color: rgba(54, 246, 154, 0.56);
      background:
        linear-gradient(90deg, rgba(54, 246, 154, 0.14), transparent 11rem),
        rgba(8, 11, 19, 0.84);
    }

    .session-row.status-hung {
      border-color: rgba(251, 191, 36, 0.58);
      background:
        linear-gradient(90deg, rgba(251, 191, 36, 0.13), transparent 11rem),
        rgba(8, 11, 19, 0.84);
    }

    .session-row.status-failed {
      border-color: rgba(255, 92, 122, 0.55);
      background:
        linear-gradient(90deg, rgba(255, 92, 122, 0.13), transparent 11rem),
        rgba(8, 11, 19, 0.84);
    }

    .session-row.status-idle {
      border-color: rgba(148, 163, 184, 0.44);
      background:
        linear-gradient(90deg, rgba(148, 163, 184, 0.1), transparent 11rem),
        rgba(8, 11, 19, 0.78);
      filter: saturate(0.45);
    }

    .session-row-link {
      color: inherit;
      text-decoration: none;
    }

    .session-row-link:hover {
      border-color: rgba(34, 211, 238, 0.72);
      background:
        linear-gradient(90deg, rgba(34, 211, 238, 0.12), transparent 11rem),
        rgba(8, 11, 19, 0.92);
    }

    .session-row::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 0.22rem;
      background: var(--green);
      box-shadow: 0 0 18px var(--green);
    }

    .session-row.status-idle::before {
      background: var(--gray);
      box-shadow: 0 0 16px rgba(148, 163, 184, 0.36);
    }

    .session-row.status-hung::before {
      background: var(--amber);
      box-shadow: 0 0 18px rgba(251, 191, 36, 0.5);
    }

    .session-row.status-failed::before {
      background: var(--coral);
      box-shadow: 0 0 18px rgba(255, 92, 122, 0.48);
    }

    .session-row.empty {
      grid-template-columns: minmax(0, 1fr);
      color: var(--muted);
      background:
        repeating-linear-gradient(135deg, rgba(96, 165, 250, 0.08) 0 1px, transparent 1px 11px),
        rgba(8, 11, 19, 0.72);
    }

    .session-row.empty::before {
      background: var(--amber);
      box-shadow: 0 0 18px rgba(251, 191, 36, 0.5);
    }

    .session-title {
      font-weight: 720;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .conversation-title {
      font-size: 1.04rem;
      line-height: 1.2;
      color: var(--text);
    }

    .conversation-title-link {
      display: block;
      text-decoration: none;
    }

    .conversation-title-link:hover,
    .session-row-link:hover .conversation-title-link,
    .session-record:hover .conversation-title-link,
    .session-record.selected .conversation-title-link {
      color: var(--green);
    }

    .session-meta,
    .session-time {
      color: var(--muted);
      font: 0.82rem/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .conversation-subtext {
      margin-top: 0.18rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .conversation-facts {
      display: flex;
      flex-wrap: wrap;
      gap: 0.32rem;
      min-width: 0;
    }

    .conversation-fact {
      max-width: 100%;
      border: 1px solid rgba(64, 81, 107, 0.66);
      background: rgba(5, 7, 12, 0.5);
      color: var(--muted);
      padding: 0.22rem 0.34rem;
      font: 0.76rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-link {
      color: var(--cyan);
      text-decoration: none;
      border-bottom: 1px solid rgba(34, 211, 238, 0.36);
      font: 0.82rem/1.38 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .session-link:hover {
      border-bottom-color: var(--cyan);
    }

    .inline-sentry-link {
      display: inline;
    }

    .session-table {
      min-width: 0;
      overflow: auto;
    }

    .session-head,
    .session-record {
      min-width: 0;
      display: grid;
      grid-template-columns: 5.6rem minmax(12rem, 1.45fr) minmax(9rem, 1fr) minmax(8rem, 0.8fr) 5rem 4.5rem;
      gap: 0.75rem;
      align-items: center;
    }

    .conversation-head,
    .conversation-record {
      grid-template-columns: minmax(13rem, 1.7fr) minmax(13rem, 1fr);
    }

    .conversation-head > :nth-child(2),
    .conversation-record > :nth-child(2) {
      justify-self: end;
    }

    .session-head {
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 0.64rem 0.78rem;
      color: var(--dim);
      background: rgba(5, 7, 12, 0.96);
      border-bottom: 1px solid rgba(64, 81, 107, 0.62);
      font: 0.76rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-transform: uppercase;
    }

    .session-record {
      width: 100%;
      text-align: left;
      border: 0;
      border-bottom: 1px solid rgba(64, 81, 107, 0.42);
      background: rgba(8, 11, 19, 0.64);
      color: inherit;
      padding: 0.75rem 0.78rem;
      cursor: pointer;
      overflow: hidden;
      text-decoration: none;
    }

    .conversation-record,
    .conversation-stack-row {
      cursor: pointer;
    }

    .session-record.status-active {
      box-shadow: inset 0.2rem 0 0 var(--green);
      background:
        linear-gradient(90deg, rgba(54, 246, 154, 0.1), transparent 18rem),
        rgba(8, 11, 19, 0.68);
    }

    .session-record.status-hung {
      box-shadow: inset 0.2rem 0 0 var(--amber);
      background:
        linear-gradient(90deg, rgba(251, 191, 36, 0.1), transparent 18rem),
        rgba(8, 11, 19, 0.68);
    }

    .session-record.status-failed {
      box-shadow: inset 0.2rem 0 0 var(--coral);
      background:
        linear-gradient(90deg, rgba(255, 92, 122, 0.1), transparent 18rem),
        rgba(8, 11, 19, 0.68);
    }

    .session-record.status-idle {
      box-shadow: inset 0.2rem 0 0 var(--gray);
      background:
        linear-gradient(90deg, rgba(148, 163, 184, 0.08), transparent 18rem),
        rgba(8, 11, 19, 0.62);
      filter: saturate(0.45);
    }

    .session-head > *,
    .session-record > * {
      min-width: 0;
    }

    .session-record:hover,
    .session-record.selected {
      background:
        linear-gradient(90deg, rgba(34, 211, 238, 0.12), transparent 20rem),
        rgba(8, 11, 19, 0.9);
    }

    .session-record.status-active:hover,
    .session-record.status-active.selected {
      background:
        linear-gradient(90deg, rgba(54, 246, 154, 0.16), transparent 20rem),
        rgba(8, 11, 19, 0.92);
    }

    .session-record.status-hung:hover,
    .session-record.status-hung.selected {
      background:
        linear-gradient(90deg, rgba(251, 191, 36, 0.16), transparent 20rem),
        rgba(8, 11, 19, 0.92);
    }

    .session-record.status-failed:hover,
    .session-record.status-failed.selected {
      background:
        linear-gradient(90deg, rgba(255, 92, 122, 0.16), transparent 20rem),
        rgba(8, 11, 19, 0.92);
    }

    .session-record.status-idle:hover,
    .session-record.status-idle.selected {
      background:
        linear-gradient(90deg, rgba(148, 163, 184, 0.12), transparent 20rem),
        rgba(8, 11, 19, 0.88);
    }

    .session-record.selected {
      box-shadow: inset 0.2rem 0 0 var(--cyan);
    }

    .conversation-stack {
      display: grid;
      gap: 0.58rem;
      padding: 0.82rem;
    }

    .conversation-stack-row {
      grid-template-columns: minmax(0, 1fr) minmax(12rem, max-content);
      border: 1px solid rgba(64, 81, 107, 0.48);
    }

    .conversation-row-stats {
      display: grid;
      gap: 0.22rem;
      justify-items: end;
      text-align: right;
      min-width: 0;
    }

    .conversation-location {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-main {
      min-width: 0;
    }

    .transcript-section {
      min-height: calc(100vh - 15rem);
    }

    .transcript,
    .transcript-loading {
      display: grid;
      gap: 0.85rem;
      padding: 0;
    }

    .transcript-skeleton {
      min-height: 7rem;
      border: 1px solid rgba(64, 81, 107, 0.56);
      background:
        linear-gradient(90deg, transparent, rgba(34, 211, 238, 0.12), transparent),
        rgba(8, 11, 19, 0.68);
      background-size: 220% 100%;
      animation: loading-pan 1.6s linear infinite;
    }

    .transcript-skeleton.short {
      min-height: 4.5rem;
    }

    .transcript-empty {
      color: var(--muted);
      padding: 0.9rem;
      font: 0.88rem/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .turn-transcript {
      border: 1px solid rgba(64, 81, 107, 0.68);
      background: rgba(5, 7, 12, 0.42);
    }

    .turn-transcript.status-active {
      border-color: rgba(54, 246, 154, 0.52);
      background:
        linear-gradient(90deg, rgba(54, 246, 154, 0.08), transparent 18rem),
        rgba(5, 7, 12, 0.44);
    }

    .turn-transcript.status-hung {
      border-color: rgba(251, 191, 36, 0.58);
      background:
        linear-gradient(90deg, rgba(251, 191, 36, 0.08), transparent 18rem),
        rgba(5, 7, 12, 0.44);
    }

    .turn-transcript.status-failed {
      border-color: rgba(255, 92, 122, 0.56);
      background:
        linear-gradient(90deg, rgba(255, 92, 122, 0.08), transparent 18rem),
        rgba(5, 7, 12, 0.44);
    }

    .turn-transcript.status-idle {
      border-color: rgba(148, 163, 184, 0.46);
      background:
        linear-gradient(90deg, rgba(148, 163, 184, 0.08), transparent 18rem),
        rgba(5, 7, 12, 0.4);
      filter: saturate(0.42);
    }

    .turn-transcript-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.75rem 0.8rem;
      border-bottom: 1px solid rgba(64, 81, 107, 0.52);
      background: rgba(8, 11, 19, 0.72);
    }

    .turn-events {
      display: grid;
      gap: 0.68rem;
      padding: 0.85rem;
    }

    .transcript-message {
      display: grid;
      gap: 0.65rem;
      padding: 0;
    }

    .turn-events > .transcript-message:not(:first-child) {
      margin-top: 30px;
    }

    .transcript-role {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
      align-items: baseline;
      color: var(--amber);
      font: 0.88rem/1.28 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-transform: uppercase;
    }

    .transcript-role-name {
      color: var(--amber);
      font-weight: 800;
    }

    .transcript-message.assistant .transcript-role-name {
      color: var(--cyan);
    }

    .transcript-message.toolResult .transcript-role-name,
    .transcript-message.tool_result .transcript-role-name {
      color: var(--violet);
    }

    .transcript-meta {
      color: var(--muted);
      text-transform: none;
    }

    .transcript-parts {
      display: grid;
      gap: 0.55rem;
      min-width: 0;
    }

    .transcript-privacy-notice {
      margin: 0 0 0.75rem;
      padding: 0.66rem 0.78rem;
      border: 1px solid rgba(64, 81, 107, 0.5);
      background: rgba(64, 81, 107, 0.08);
      color: var(--muted);
      font: 0.9rem/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .redacted-parts {
      display: grid;
      gap: 0.42rem;
      min-width: 0;
      color: var(--muted);
      font: 0.9rem/1.32 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .redacted-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 0.8rem;
      min-width: 0;
      padding: 0.48rem 0.68rem;
      border: 1px solid rgba(64, 81, 107, 0.42);
      border-radius: 4px;
      background: rgba(64, 81, 107, 0.07);
      transition:
        border-color 120ms ease,
        background-color 120ms ease;
    }

    .redacted-row:hover {
      border-color: rgba(34, 211, 238, 0.42);
      background: rgba(34, 211, 238, 0.06);
    }

    .redacted-row-label,
    .redacted-row-meta {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .redacted-row-label {
      color: var(--text);
    }

    .redacted-row-meta {
      color: var(--dim);
      text-align: right;
    }

    .transcript-text {
      display: grid;
      gap: 0.5rem;
      min-width: 0;
    }

    .markup-tree {
      display: grid;
      gap: 0;
      min-width: 0;
      padding: 0.08rem 0 0.08rem 1.02rem;
      color: var(--muted);
      font: 0.86rem/1.48 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .markup-node,
    .markup-leaf,
    .markup-text,
    .markup-close {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .markup-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 0;
      align-items: baseline;
      cursor: pointer;
      width: 100%;
      max-width: 100%;
      position: relative;
      padding: 0.03rem 0.12rem;
      margin-left: -0.12rem;
      transition:
        background-color 120ms ease,
        color 120ms ease;
    }

    .markup-summary::marker {
      content: "";
    }

    .markup-summary::-webkit-details-marker {
      display: none;
    }

    .markup-summary:hover {
      background: rgba(34, 211, 238, 0.08);
      color: var(--text);
    }

    .markup-node:hover > .markup-summary,
    .markup-node:hover > .markup-close {
      background: rgba(34, 211, 238, 0.08);
    }

    .markup-summary:hover .markup-toggle,
    .markup-summary:hover .markup-tag,
    .markup-node:hover > .markup-summary .markup-toggle,
    .markup-node:hover > .markup-summary .markup-tag,
    .markup-node:hover > .markup-close .markup-tag {
      color: var(--green);
    }

    .markup-toggle {
      position: absolute;
      left: -0.76rem;
      width: 0.56rem;
      color: var(--cyan);
      font-weight: 900;
      text-align: center;
    }

    .markup-toggle::before {
      content: "+";
    }

    .markup-node[open] > .markup-summary .markup-toggle::before {
      content: "-";
    }

    .markup-collapsed-bracket {
      color: var(--dim);
    }

    .markup-node[open] > .markup-summary .markup-collapsed-bracket {
      display: none;
    }

    .markup-node:not([open]) > .markup-summary .markup-open-bracket {
      display: none;
    }

    .markup-leaf,
    .markup-close {
      display: flex;
      flex-wrap: wrap;
      gap: 0;
      align-items: baseline;
      padding: 0.03rem 0.12rem;
      margin-left: -0.12rem;
      transition:
        background-color 120ms ease,
        color 120ms ease;
    }

    .markup-close {
      cursor: pointer;
    }

    .markup-children {
      display: grid;
      gap: 0.02rem;
      margin: 0.08rem 0 0.08rem 0.08rem;
      padding: 0 0 0 0.66rem;
      border-left: 1px solid rgba(64, 81, 107, 0.52);
    }

    .markup-tag {
      color: var(--cyan);
      font-weight: 760;
    }

    .markup-bracket {
      color: var(--dim);
    }

    .markup-attribute {
      color: var(--amber);
      margin-left: 0.32rem;
    }

    .markup-attribute-value {
      color: var(--green);
    }

    .markup-text {
      color: var(--text);
      padding: 0;
      white-space: pre-wrap;
    }

    .tool-part {
      border: 1px solid rgba(167, 139, 250, 0.34);
      background: rgba(167, 139, 250, 0.08);
      transition:
        border-color 120ms ease,
        background-color 120ms ease;
    }

    .tool-part:hover,
    .thinking-part:hover {
      border-color: rgba(34, 211, 238, 0.52);
      background: rgba(34, 211, 238, 0.07);
    }

    .transcript-tool {
      margin: 0;
    }

    .tool-part-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 0.8rem;
      align-items: center;
      padding: 0.45rem 0.55rem;
      color: var(--muted);
      cursor: pointer;
      font: 0.86rem/1.18 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .tool-part-header.raw {
      cursor: default;
    }

    .tool-part-header > span:first-child {
      color: var(--dim);
    }

    .tool-part[open] .tool-part-header {
      border-bottom: 1px solid rgba(64, 81, 107, 0.48);
    }

    .tool-signature {
      min-width: 0;
      display: flex;
      align-items: baseline;
      gap: 0.18rem;
      overflow: hidden;
      white-space: nowrap;
    }

    .tool-signature code {
      min-width: 0;
      color: var(--muted);
      font: inherit;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tool-part-header strong {
      color: var(--text);
      font-weight: 720;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tool-part-header span:last-child {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: right;
    }

    .tool-meta {
      color: var(--dim);
    }

    .tool-io {
      border-top: 1px solid rgba(64, 81, 107, 0.42);
      padding: 0 0.72rem 0.72rem;
    }

    .tool-part[open] .tool-io:first-of-type {
      border-top: 0;
    }

    .tool-io-label {
      padding: 0.62rem 0 0.42rem;
      color: var(--dim);
      font: 0.78rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .thinking-part {
      border: 1px solid rgba(64, 81, 107, 0.56);
      background: rgba(64, 81, 107, 0.08);
      transition:
        border-color 120ms ease,
        background-color 120ms ease;
    }

    .thinking-part-header {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 0.75rem;
      align-items: center;
      padding: 0.45rem 0.55rem;
      color: var(--dim);
      cursor: pointer;
      font: 0.8rem/1.15 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .thinking-part-header:hover,
    .tool-part-header:hover {
      background: rgba(34, 211, 238, 0.08);
    }

    .thinking-part-header span:first-child {
      color: var(--violet);
      text-transform: uppercase;
    }

    .thinking-part-header span:last-child {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .thinking-part[open] .thinking-part-header {
      border-bottom: 1px solid rgba(64, 81, 107, 0.48);
    }

    .thinking-part .highlighted-code {
      padding: 0.72rem;
    }

    .highlighted-code {
      min-width: 0;
      overflow: visible;
    }

    .highlighted-code pre,
    .highlighted-code.pending {
      margin: 0;
      padding: 0;
      overflow: visible;
      background: transparent !important;
      font: 0.86rem/1.42 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .highlighted-code code {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .turn-actor,
    .turn-meta {
      color: var(--muted);
      margin-top: 0.18rem;
      font: 0.84rem/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .turn-actor {
      color: var(--text);
    }

    .error {
      color: var(--coral);
      border-color: rgba(255, 92, 122, 0.5);
      background: rgba(255, 92, 122, 0.08);
    }

    .dashboard-error-page {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 2rem;
    }

    .dashboard-error-panel {
      width: min(58rem, 100%);
      border: 1px solid rgba(255, 92, 122, 0.58);
      background: rgba(5, 7, 12, 0.92);
      box-shadow: 0 0 48px rgba(255, 92, 122, 0.12);
      padding: 1.2rem;
    }

    .dashboard-error-panel h1 {
      margin: 0.2rem 0 0;
      font-size: clamp(1.45rem, 3vw, 2.15rem);
      line-height: 1.08;
      letter-spacing: 0;
    }

    .dashboard-error-panel p {
      color: var(--muted);
      margin: 0.55rem 0 1rem;
      max-width: 48rem;
    }

    .dashboard-error-panel pre {
      margin: 0;
      max-height: 60vh;
      overflow: auto;
      border: 1px solid rgba(64, 81, 107, 0.7);
      background: rgba(5, 7, 12, 0.88);
      color: var(--text);
      padding: 0.9rem;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 0.84rem/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    @media (max-width: 1120px) {
      .layout,
      .conversations-layout,
      .sessions-layout,
      .conversation-layout {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      }

      .stage {
        grid-column: 1 / -1;
        grid-row: 1;
      }

      .sessions-main {
        grid-column: 1 / -1;
      }
    }

    @media (max-width: 760px) {
      .topbar,
      .layout,
      .conversations-layout,
      .sessions-layout,
      .conversation-layout,
      .pulse-strip,
      .session-row,
      .transcript-message {
        grid-template-columns: minmax(0, 1fr);
      }

      .top-actions {
        justify-content: space-between;
        flex-wrap: wrap;
      }

      .identity {
        max-width: calc(100vw - 5rem);
      }

      .pulse-status-panel {
        justify-items: stretch;
        min-width: 0;
      }

      .activity-indicator {
        width: 100%;
      }

      .stats {
        grid-template-columns: minmax(0, 1fr);
      }

      .session-workbench {
        grid-template-columns: minmax(0, 1fr);
      }

      .session-table {
        border-right: 0;
        border-bottom: 1px solid rgba(64, 81, 107, 0.62);
      }

      .kv-row {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  </style>
</head>
<body>
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
          '<main class="deck"><section class="dashboard-error-page">' +
          '<div class="dashboard-error-panel"><div class="kicker">Dashboard Error</div>' +
          "<h1>Junior failed to render</h1>" +
          "<p>The dashboard hit a client-side exception. The stack trace is shown here so the page does not fail blank.</p>" +
          "<pre>" +
          escapeHtml(errorText(error)) +
          "</pre></div></section></main>";
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
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#05070c"/><path d="M8 7h16v18H8z" fill="#36f69a"/><path d="M12 11h5v5h-5zM18 16h3v5h-9v-3h6z" fill="#05070c"/></svg>`,
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
