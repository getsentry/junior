import { Hono } from "hono";
import { setConfigDefaults } from "@/chat/configuration/defaults";
import { logException } from "@/chat/logging";
import { setPluginPackages } from "@/chat/plugins/package-discovery";
import { GET as diagnosticsGET } from "@/handlers/diagnostics";
import { GET as dashboardGET } from "@/handlers/diagnostics-dashboard";
import { GET as healthGET } from "@/handlers/health";
import { GET as mcpOauthCallbackGET } from "@/handlers/mcp-oauth-callback";
import { GET as oauthCallbackGET } from "@/handlers/oauth-callback";
import {
  ALL as sandboxEgressProxyALL,
  isSandboxEgressRequest,
} from "@/handlers/sandbox-egress-proxy";
import { POST as turnResumePOST } from "@/handlers/turn-resume";
import { POST as webhooksPOST } from "@/handlers/webhooks";
import type { WaitUntilFn } from "@/handlers/types";

export interface JuniorAppOptions {
  /** Install-wide provider defaults (`provider.key` format). Channel overrides take precedence. */
  configDefaults?: Record<string, unknown>;
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

/** Resolve plugin packages from the virtual module injected by juniorNitro(). */
async function resolveBuildPluginPackages(): Promise<string[] | undefined> {
  try {
    const mod: { pluginPackages?: string[] } = await import("#junior/config");
    return mod.pluginPackages;
  } catch {
    // Virtual module unavailable (not running in Nitro context).
    // Fall back to env var for dev mode and tests.
    const env = process.env.JUNIOR_PLUGIN_PACKAGES;
    if (env) {
      try {
        return JSON.parse(env);
      } catch {}
    }
    return undefined;
  }
}

/** Create a Hono app with all Junior routes. */
export async function createApp(options?: JuniorAppOptions): Promise<Hono> {
  setPluginPackages(
    options?.pluginPackages ?? (await resolveBuildPluginPackages()),
  );
  setConfigDefaults(options?.configDefaults);

  const waitUntil = options?.waitUntil ?? (await defaultWaitUntil());

  const app = new Hono();

  app.onError((err, c) => {
    logException(err, "unhandled_route_error");
    return c.text("Internal Server Error", 500);
  });

  app.use("*", async (c, next) => {
    // Vercel Sandbox proxying preserves the original upstream path, so detect
    // authenticated proxy traffic before ordinary application routes claim it.
    if (isSandboxEgressRequest(c.req.raw)) {
      return await sandboxEgressProxyALL(c.req.raw);
    }
    await next();
  });

  app.get("/", () => dashboardGET());
  app.get("/health", () => healthGET());

  // Public route — returns plugin/skill names, cwd, and DESCRIPTION.md text.
  // No credentials or PII. Understand what this discloses before deploying.
  app.get("/api/info", () => diagnosticsGET());

  // MCP callback must be registered before the generic OAuth callback
  // because Hono matches routes top-down and `:provider` would swallow `mcp/`.
  app.get("/api/oauth/callback/mcp/:provider", (c) => {
    return mcpOauthCallbackGET(c.req.raw, c.req.param("provider"), waitUntil);
  });

  app.get("/api/oauth/callback/:provider", (c) => {
    return oauthCallbackGET(c.req.raw, c.req.param("provider"), waitUntil);
  });

  app.post("/api/internal/turn-resume", (c) => {
    return turnResumePOST(c.req.raw, waitUntil);
  });

  app.post("/api/webhooks/:platform", (c) => {
    return webhooksPOST(c.req.raw, c.req.param("platform"), waitUntil);
  });

  return app;
}
