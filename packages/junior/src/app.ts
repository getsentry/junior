import { Hono } from "hono";
import {
  getConfigDefaults,
  setConfigDefaults,
} from "@/chat/configuration/defaults";
import { logException } from "@/chat/logging";
import {
  getPluginCatalogSignature,
  setPluginConfig,
} from "@/chat/plugins/registry";
import {
  setAgentPlugins,
  validateAgentPlugins,
} from "@/chat/plugins/agent-hooks";
import type { PluginConfig } from "@/chat/plugins/types";
import type { JuniorPlugin } from "@sentry/junior-plugin-api";
import { GET as diagnosticsGET } from "@/handlers/diagnostics";
import { GET as dashboardGET } from "@/handlers/diagnostics-dashboard";
import { GET as healthGET } from "@/handlers/health";
import { POST as agentDispatchPOST } from "@/handlers/agent-dispatch";
import { GET as heartbeatGET } from "@/handlers/heartbeat";
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
  /**
   * Plugin packages/overrides, or trusted plugin instances loaded by this app.
   *
   * Use `PluginConfig` for declarative package lists and manifest overrides.
   * Use `JuniorPlugin[]` for trusted plugin factories such as `githubPlugin()`;
   * their package config is merged with the catalog bundled by `juniorNitro()`.
   */
  plugins?: PluginConfig | JuniorPlugin[];
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

/** Resolve plugin configuration from the virtual module injected by juniorNitro(). */
async function resolveVirtualPluginConfig(): Promise<PluginConfig | undefined> {
  try {
    const mod: { plugins?: PluginConfig } = await import("#junior/config");
    return mod.plugins;
  } catch (error) {
    if (!isMissingVirtualConfig(error)) {
      throw error;
    }
    return undefined;
  }
}

/** Resolve plugin configuration from the virtual module, falling back to env. */
async function resolveBuildPluginConfig(): Promise<PluginConfig | undefined> {
  const virtualConfig = await resolveVirtualPluginConfig();
  if (virtualConfig) {
    return virtualConfig;
  }

  const packages = readEnvPluginPackages();
  if (packages) {
    return { packages };
  }
  return undefined;
}

function isMissingVirtualConfig(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  return (
    (code === "ERR_PACKAGE_IMPORT_NOT_DEFINED" ||
      code === "ERR_MODULE_NOT_FOUND" ||
      code === "MODULE_NOT_FOUND") &&
    error.message.includes("#junior/config")
  );
}

function readEnvPluginPackages(): string[] | undefined {
  const env = process.env.JUNIOR_PLUGIN_PACKAGES;
  if (!env) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(env);
  } catch (error) {
    throw new Error("JUNIOR_PLUGIN_PACKAGES must be valid JSON", {
      cause: error,
    });
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((value) => typeof value !== "string" || !value.trim())
  ) {
    throw new Error(
      "JUNIOR_PLUGIN_PACKAGES must be a JSON array of package names",
    );
  }

  return parsed;
}

function hasConfiguredPluginCatalog(config: PluginConfig | undefined): boolean {
  if (!config) {
    return false;
  }

  return Boolean(
    config.packages?.length || Object.keys(config.manifests ?? {}).length,
  );
}

function isJuniorPluginArray(
  plugins: JuniorAppOptions["plugins"],
): plugins is JuniorPlugin[] {
  return Array.isArray(plugins);
}

function mergePluginConfig(
  base: PluginConfig | undefined,
  next: PluginConfig | undefined,
): PluginConfig | undefined {
  if (!base) return next;
  if (!next) return base;

  return {
    packages: [
      ...new Set([...(base.packages ?? []), ...(next.packages ?? [])]),
    ],
    manifests:
      base.manifests || next.manifests
        ? {
            ...(base.manifests ?? {}),
            ...(next.manifests ?? {}),
          }
        : undefined,
  };
}

function pluginConfigFromAgentPlugins(
  plugins: JuniorPlugin[],
): PluginConfig | undefined {
  const packages = [
    ...new Set(
      plugins.flatMap((plugin) => plugin.pluginConfig?.packages ?? []),
    ),
  ];
  return packages.length ? { packages } : undefined;
}

/** Create a Hono app with all Junior routes. */
export async function createApp(options?: JuniorAppOptions): Promise<Hono> {
  const configuredPlugins = options?.plugins;
  const agentPlugins = isJuniorPluginArray(configuredPlugins)
    ? configuredPlugins
    : [];
  const pluginConfig = isJuniorPluginArray(configuredPlugins)
    ? mergePluginConfig(
        await resolveVirtualPluginConfig(),
        pluginConfigFromAgentPlugins(configuredPlugins),
      )
    : (configuredPlugins ?? (await resolveBuildPluginConfig()));
  validateAgentPlugins(agentPlugins);
  const shouldValidatePluginCatalog =
    hasConfiguredPluginCatalog(pluginConfig) ||
    Boolean(Object.keys(options?.configDefaults ?? {}).length);
  const previousPluginConfig = setPluginConfig(pluginConfig);
  const previousAgentPlugins = setAgentPlugins(agentPlugins);
  const previousConfigDefaults = getConfigDefaults();
  try {
    setConfigDefaults(options?.configDefaults);
    if (shouldValidatePluginCatalog) {
      getPluginCatalogSignature();
    }
  } catch (error) {
    setPluginConfig(previousPluginConfig);
    setAgentPlugins(previousAgentPlugins);
    setConfigDefaults(previousConfigDefaults);
    throw error;
  }

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

  app.post("/api/internal/agent-dispatch", (c) => {
    return agentDispatchPOST(c.req.raw, waitUntil);
  });

  app.get("/api/internal/heartbeat", (c) => {
    return heartbeatGET(c.req.raw, waitUntil);
  });

  app.post("/api/webhooks/:platform", (c) => {
    return webhooksPOST(c.req.raw, c.req.param("platform"), waitUntil);
  });

  return app;
}
