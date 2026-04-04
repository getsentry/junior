import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { logException } from "@/chat/logging";
import { setPluginPackages } from "@/chat/plugins/package-discovery";
import { GET as diagnosticsGET } from "@/handlers/diagnostics";
import { GET as diagnosticsDashboardGET } from "@/handlers/diagnostics-dashboard";
import { GET as healthGET } from "@/handlers/health";
import { GET as mcpOauthCallbackGET } from "@/handlers/mcp-oauth-callback";
import { GET as oauthCallbackGET } from "@/handlers/oauth-callback";
import { POST as webhooksPOST } from "@/handlers/webhooks";
import type { WaitUntilFn } from "@/handlers/types";

export interface JuniorAppOptions {
  pluginPackages?: string[];
  waitUntil?: WaitUntilFn;
}

/** Build a `WaitUntilFn`, preferring Vercel's lifetime extension when available. */
async function defaultWaitUntil(): Promise<WaitUntilFn> {
  try {
    const { waitUntil } = await import("@vercel/functions");
    return (task) => {
      const promise = typeof task === "function" ? task() : task;
      waitUntil(promise);
    };
  } catch {
    // Outside Vercel (e.g. local dev via node-server), fire-and-forget.
    return (task) => {
      const promise = typeof task === "function" ? task() : task;
      promise.catch(console.error);
    };
  }
}

/** Resolve plugin packages from build-time config (env var or JSON file). */
function resolveBuildPluginPackages(): string[] | undefined {
  const envValue = process.env.JUNIOR_PLUGIN_PACKAGES;
  if (envValue) {
    try {
      return JSON.parse(envValue);
    } catch {
      // ignore malformed env
    }
  }
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const configPath = path.join(dir, "__junior_config.json");
      if (existsSync(configPath)) {
        return JSON.parse(readFileSync(configPath, "utf-8")).pluginPackages;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** Create a Hono app with all Junior routes mounted under `/api`. */
export async function createApp(options?: JuniorAppOptions): Promise<Hono> {
  setPluginPackages(options?.pluginPackages ?? resolveBuildPluginPackages());

  const waitUntil = options?.waitUntil ?? (await defaultWaitUntil());

  const app = new Hono().basePath("/api");

  app.onError((err, c) => {
    logException(err, "unhandled_route_error");
    return c.text("Internal Server Error", 500);
  });

  app.get("/health", () => healthGET());

  // Public route — returns plugin/skill names, cwd, and ABOUT.md text.
  // No credentials or PII. Understand what this discloses before deploying.
  app.get("/__junior/discovery", () => diagnosticsGET());
  app.get("/__junior/dashboard", () => diagnosticsDashboardGET());

  // MCP callback must be registered before the generic OAuth callback
  // because Hono matches routes top-down and `:provider` would swallow `mcp/`.
  app.get("/oauth/callback/mcp/:provider", (c) => {
    return mcpOauthCallbackGET(c.req.raw, c.req.param("provider"), waitUntil);
  });

  app.get("/oauth/callback/:provider", (c) => {
    return oauthCallbackGET(c.req.raw, c.req.param("provider"), waitUntil);
  });

  app.post("/webhooks/:platform", (c) => {
    return webhooksPOST(c.req.raw, c.req.param("platform"), waitUntil);
  });

  return app;
}
