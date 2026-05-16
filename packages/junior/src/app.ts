import { Hono } from "hono";
import { setConfigDefaults } from "@/chat/configuration/defaults";
import { logException } from "@/chat/logging";
import { createProductionBotResolver } from "@/chat/app/production";
import {
  resolveEnabledChatPlatforms,
  type ChatPlatform,
} from "@/chat/platforms";
import { setPluginPackages } from "@/chat/plugins/package-discovery";
import { GET as diagnosticsGET } from "@/handlers/diagnostics";
import { GET as dashboardGET } from "@/handlers/diagnostics-dashboard";
import { GET as healthGET } from "@/handlers/health";
import { ALL as sandboxEgressProxyALL } from "@/handlers/sandbox-egress-proxy";
import { handlePlatformWebhook } from "@/handlers/webhooks";
import type { WaitUntilFn } from "@/handlers/types";

export interface JuniorAppOptions {
  /** Install-wide provider defaults (`provider.key` format). Channel overrides take precedence. */
  configDefaults?: Record<string, unknown>;
  /** Chat ingress platforms to enable for this app. Defaults to Slack only. */
  enabledPlatforms?: readonly ChatPlatform[];
  pluginPackages?: string[];
  waitUntil?: WaitUntilFn;
}

interface JuniorBuildConfig {
  enabledPlatforms?: string[];
  pluginPackages?: string[];
}

function isMissingVirtualConfig(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND") {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    /#junior\/config|junior\/config/.test(message)
  );
}

function parsePluginPackagesEnv(rawValue: string): string[] {
  const parsed: unknown = JSON.parse(rawValue);
  if (
    !Array.isArray(parsed) ||
    parsed.some((packageName) => typeof packageName !== "string")
  ) {
    throw new Error("JUNIOR_PLUGIN_PACKAGES must be a JSON array of strings");
  }
  return parsed;
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

/** Resolve build-time config injected by juniorNitro(). */
async function resolveBuildConfig(): Promise<JuniorBuildConfig> {
  try {
    const mod: JuniorBuildConfig = await import("#junior/config");
    return mod;
  } catch (error) {
    if (!isMissingVirtualConfig(error)) {
      throw error;
    }
    // Virtual module unavailable (not running in Nitro context).
    // Fall back to env var for dev mode and tests.
    const env = process.env.JUNIOR_PLUGIN_PACKAGES;
    if (env) {
      return { pluginPackages: parsePluginPackagesEnv(env) };
    }
    return {};
  }
}

/** Create a Hono app with all Junior routes. */
export async function createApp(options?: JuniorAppOptions): Promise<Hono> {
  const buildConfig = await resolveBuildConfig();
  const enabledPlatforms = resolveEnabledChatPlatforms(
    options?.enabledPlatforms ?? buildConfig.enabledPlatforms,
    "enabledPlatforms",
  );
  const getBot = createProductionBotResolver({ enabledPlatforms });
  const slackEnabled = enabledPlatforms.includes("slack");

  setPluginPackages(options?.pluginPackages ?? buildConfig.pluginPackages);
  setConfigDefaults(options?.configDefaults);

  const waitUntil = options?.waitUntil ?? (await defaultWaitUntil());

  const app = new Hono();

  app.onError((err, c) => {
    logException(err, "unhandled_route_error");
    return c.text("Internal Server Error", 500);
  });

  app.get("/", () => dashboardGET());
  app.get("/health", () => healthGET());

  // Public route — returns plugin/skill names, cwd, and DESCRIPTION.md text.
  // No credentials or PII. Understand what this discloses before deploying.
  app.get("/api/info", () => diagnosticsGET());

  // MCP callback must be registered before the generic OAuth callback
  // because Hono matches routes top-down and `:provider` would swallow `mcp/`.
  if (slackEnabled) {
    app.get("/api/oauth/callback/mcp/:provider", async (c) => {
      const { GET } = await import("@/handlers/mcp-oauth-callback");
      return GET(c.req.raw, c.req.param("provider"), waitUntil);
    });

    app.get("/api/oauth/callback/:provider", async (c) => {
      const { GET } = await import("@/handlers/oauth-callback");
      return GET(c.req.raw, c.req.param("provider"), waitUntil);
    });

    app.post("/api/internal/turn-resume", async (c) => {
      const { POST } = await import("@/handlers/turn-resume");
      return POST(c.req.raw, waitUntil);
    });
  }

  app.all("/api/internal/sandbox-egress/:egressId", (c) => {
    return sandboxEgressProxyALL(c.req.raw, c.req.param("egressId"));
  });
  app.all("/api/internal/sandbox-egress/:egressId/*", (c) => {
    return sandboxEgressProxyALL(c.req.raw, c.req.param("egressId"));
  });

  app.post("/api/webhooks/:platform", (c) => {
    const platform = c.req.param("platform");
    if (!enabledPlatforms.includes(platform as ChatPlatform)) {
      return c.text(`Unknown platform: ${platform}`, 404);
    }
    return handlePlatformWebhook(c.req.raw, platform, waitUntil, getBot());
  });

  return app;
}
