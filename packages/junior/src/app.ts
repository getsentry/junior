import { Hono, type Context } from "hono";
import {
  getConfigDefaults,
  setConfigDefaults,
} from "@/chat/configuration/defaults";
import { getSlackReactionConfig, setSlackReactionConfig } from "@/chat/config";
import { getDb } from "@/chat/db";
import { logException } from "@/chat/logging";
import { generateAssistantReply } from "@/chat/respond";
import { normalizeSandboxEgressTracePropagationDomains } from "@/chat/sandbox/egress-tracing";
import {
  getPluginCatalogSignature,
  setPluginCatalogConfig,
} from "@/chat/plugins/registry";
import {
  type PluginRouteRegistration,
  getPluginRoutes,
  setPlugins,
  validatePlugins,
} from "@/chat/plugins/agent-hooks";
import type { PluginCatalogConfig } from "@/chat/plugins/types";
import {
  validatePluginEgressCredentialHooks,
  validatePluginRegistrations,
} from "@/chat/plugins/validation";
import type {
  PluginRegistration,
  PluginRouteMethod,
} from "@sentry/junior-plugin-api";
import {
  pluginCatalogConfigFromEnv,
  pluginCatalogConfigFromPluginSet,
  pluginHookRegistrationsFromPluginSet,
  type JuniorPluginSet,
} from "./plugins";
import { GET as healthGET } from "@/handlers/health";
import { POST as agentDispatchPOST } from "@/handlers/agent-dispatch";
import { GET as heartbeatGET } from "@/handlers/heartbeat";
import { GET as mcpOauthCallbackGET } from "@/handlers/mcp-oauth-callback";
import { GET as oauthCallbackGET } from "@/handlers/oauth-callback";
import { handleSandboxEgressRoute } from "@/handlers/sandbox-egress-route";
import { POST as slackWebhookPOST } from "@/handlers/slack-webhook";
import {
  createVercelConversationWorkCallback,
  registerVercelConversationWorkDevConsumer,
  type VercelConversationWorkCallbackOptions,
} from "@/chat/task-execution/vercel-callback";
import {
  createProductionConversationWorkOptions,
  createProductionSlackWebhookServices,
} from "@/chat/app/production";
import { withSandboxTracePropagation } from "@/chat/app/services";
import type { WaitUntilFn } from "@/handlers/types";

export { defineJuniorPlugins } from "./plugins";
export type {
  JuniorPluginInput,
  JuniorPluginSet,
  JuniorPluginSetOptions,
} from "./plugins";

export interface JuniorAppOptions {
  /** Slack-specific overrides applied after env parsing. */
  slack?: {
    /** Slack emoji shown while Junior is processing. Defaults to `eyes`. */
    processingReactionEmoji?: string;
    /** Slack emoji shown after a turn completes. Defaults to `white_check_mark`. */
    completedReactionEmoji?: string;
  };
  /** Install-wide provider defaults (`provider.key` format). Channel overrides take precedence. */
  configDefaults?: Record<string, unknown>;
  /** Queue consumer wiring for the durable conversation worker. */
  conversationWork?: VercelConversationWorkCallbackOptions;
  /** Direct plugin set override. Usually omitted when `juniorNitro()` uses a plugin module. */
  plugins?: JuniorPluginSet;
  /** Sandbox execution options. */
  sandbox?: {
    /**
     * Egress domains allowed to carry Sentry trace propagation headers.
     * Entries may be exact domains or leading wildcard domains such as
     * `*.sentry.io`; wildcard entries match subdomains, not the apex domain.
     */
    egressTracePropagationDomains?: string[];
  };
  waitUntil?: WaitUntilFn;
}

interface JuniorVirtualConfig {
  pluginSet?: JuniorPluginSet;
  plugins?: PluginCatalogConfig;
  pluginHookRegistrations: string[];
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

/** Resolve build-time configuration from the virtual module injected by juniorNitro(). */
async function resolveVirtualConfig(): Promise<
  JuniorVirtualConfig | undefined
> {
  try {
    const mod: {
      pluginSet?: JuniorPluginSet;
      plugins?: PluginCatalogConfig;
      pluginHookRegistrations?: string[];
    } = await import("#junior/config");
    return {
      pluginSet: mod.pluginSet,
      plugins: mod.plugins,
      pluginHookRegistrations: mod.pluginHookRegistrations ?? [],
    };
  } catch (error) {
    if (!isMissingVirtualConfig(error)) {
      throw error;
    }
    return undefined;
  }
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

function hasConfiguredPluginCatalog(
  config: PluginCatalogConfig | undefined,
): boolean {
  if (!config) {
    return false;
  }

  return Boolean(
    config.inlineManifests?.length ||
    config.packages?.length ||
    Object.keys(config.manifests ?? {}).length,
  );
}

function pluginPackageNames(config: PluginCatalogConfig | undefined): string[] {
  return config?.packages ?? [];
}

function validateBuildIncludesPluginPackages(
  pluginConfig: PluginCatalogConfig | undefined,
  virtualConfig: JuniorVirtualConfig | undefined,
): void {
  if (!virtualConfig?.plugins) {
    return;
  }
  const bundled = new Set(pluginPackageNames(virtualConfig.plugins));
  const missing = pluginPackageNames(pluginConfig).filter(
    (packageName) => !bundled.has(packageName),
  );
  if (missing.length === 0) {
    return;
  }
  throw new Error(
    `createApp() registered plugin package(s) not bundled by juniorNitro(): ${missing.join(", ")}. Point juniorNitro({ plugins: "./plugins" }) at the runtime plugin module or pass the same defineJuniorPlugins(...) set to juniorNitro({ plugins }) and createApp({ plugins }).`,
  );
}

function validateBuildIncludesPluginHookRegistrations(
  hookRegistrations: PluginRegistration[],
  virtualConfig: JuniorVirtualConfig | undefined,
): void {
  const bundledHookRegistrations = virtualConfig?.pluginHookRegistrations ?? [];
  if (bundledHookRegistrations.length === 0) {
    return;
  }

  const registered = new Set(
    hookRegistrations.map((plugin) => plugin.manifest.name),
  );
  const missing = bundledHookRegistrations.filter(
    (pluginName) => !registered.has(pluginName),
  );
  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `createApp() is missing plugin registration(s) with runtime hooks bundled by juniorNitro(): ${missing.join(", ")}. Pass a runtime-safe plugin module to juniorNitro({ plugins: "./plugins" }) or pass the same defineJuniorPlugins(...) set to createApp({ plugins }).`,
  );
}

/** Mount plugin HTTP handlers before core routes claim those paths. */
function mountPluginRoutes(app: Hono, routes: PluginRouteRegistration[]): void {
  for (const route of routes) {
    const handler = (c: Context) => route.handler(c.req.raw);
    const methods = Array.isArray(route.method)
      ? route.method
      : [route.method ?? "ALL"];
    const explicitMethods = methods.filter(
      (method): method is Exclude<PluginRouteMethod, "ALL"> => method !== "ALL",
    );

    if (methods.includes("ALL")) {
      app.all(route.path, handler);
    } else if (explicitMethods.length > 0) {
      app.on(explicitMethods, route.path, handler);
    }
  }
}

/** Create a Hono app with all Junior routes. */
export async function createApp(options?: JuniorAppOptions): Promise<Hono> {
  const virtualConfig = await resolveVirtualConfig();
  const configuredPlugins = options?.plugins ?? virtualConfig?.pluginSet;
  const plugins = pluginHookRegistrationsFromPluginSet(configuredPlugins);
  const pluginConfig = configuredPlugins
    ? pluginCatalogConfigFromPluginSet(configuredPlugins)
    : (virtualConfig?.plugins ?? pluginCatalogConfigFromEnv());
  if (configuredPlugins) {
    validateBuildIncludesPluginPackages(pluginConfig, virtualConfig);
  }
  validateBuildIncludesPluginHookRegistrations(plugins, virtualConfig);
  validatePlugins(plugins);
  getDb();
  const shouldValidatePluginCatalog =
    hasConfiguredPluginCatalog(pluginConfig) ||
    Boolean(configuredPlugins?.registrations.length) ||
    Boolean(Object.keys(options?.configDefaults ?? {}).length);
  const previousPluginCatalogConfig = setPluginCatalogConfig(pluginConfig);
  const previousPlugins = setPlugins(plugins);
  const previousConfigDefaults = getConfigDefaults();
  const previousSlackReactionConfig = getSlackReactionConfig();
  let pluginRoutes: PluginRouteRegistration[] = [];
  let sandboxEgressTracePropagationDomains: string[] = [];
  try {
    sandboxEgressTracePropagationDomains =
      normalizeSandboxEgressTracePropagationDomains(
        options?.sandbox?.egressTracePropagationDomains,
      );
    setConfigDefaults(options?.configDefaults);
    if (options?.slack) {
      setSlackReactionConfig(options.slack);
    }
    if (shouldValidatePluginCatalog) {
      getPluginCatalogSignature();
      validatePluginRegistrations(configuredPlugins?.registrations ?? []);
      validatePluginEgressCredentialHooks(
        configuredPlugins?.registrations ?? [],
      );
    }
    pluginRoutes = getPluginRoutes();
  } catch (error) {
    setPluginCatalogConfig(previousPluginCatalogConfig);
    setPlugins(previousPlugins);
    setConfigDefaults(previousConfigDefaults);
    setSlackReactionConfig(previousSlackReactionConfig);
    throw error;
  }

  const waitUntil = options?.waitUntil ?? (await defaultWaitUntil());
  const runtimeServiceOverrides = {
    sandbox: {
      tracePropagation: { domains: sandboxEgressTracePropagationDomains },
    },
  };
  const slackWebhookServices = createProductionSlackWebhookServices({
    services: runtimeServiceOverrides,
  });
  const generateReplyWithTracePropagation = withSandboxTracePropagation(
    generateAssistantReply,
    runtimeServiceOverrides.sandbox.tracePropagation,
  );

  const app = new Hono();

  app.onError((err, c) => {
    logException(err, "unhandled_route_error");
    return c.text("Internal Server Error", 500);
  });

  app.use("*", async (c, next) => {
    return await handleSandboxEgressRoute(
      c.req.raw,
      sandboxEgressTracePropagationDomains,
      next,
    );
  });

  mountPluginRoutes(app, pluginRoutes);

  app.get("/", () => healthGET());
  app.get("/health", () => healthGET());

  // MCP callback must be registered before the generic OAuth callback
  // because Hono matches routes top-down and `:provider` would swallow `mcp/`.
  app.get("/api/oauth/callback/mcp/:provider", (c) => {
    return mcpOauthCallbackGET(c.req.raw, c.req.param("provider"), waitUntil, {
      generateReply: generateReplyWithTracePropagation,
    });
  });

  app.get("/api/oauth/callback/:provider", (c) => {
    return oauthCallbackGET(c.req.raw, c.req.param("provider"), waitUntil, {
      generateReply: generateReplyWithTracePropagation,
    });
  });

  app.post("/api/internal/agent-dispatch", (c) => {
    return agentDispatchPOST(c.req.raw, waitUntil, {
      tracePropagation: { domains: sandboxEgressTracePropagationDomains },
    });
  });

  let agentContinuePOST:
    | ReturnType<typeof createVercelConversationWorkCallback>
    | undefined;
  let conversationWorkOptions:
    | VercelConversationWorkCallbackOptions
    | undefined;
  const getConversationWorkOptions = () => {
    conversationWorkOptions ??=
      options?.conversationWork ??
      createProductionConversationWorkOptions({
        services: runtimeServiceOverrides,
      });
    return conversationWorkOptions;
  };
  if (process.env.NODE_ENV === "development") {
    registerVercelConversationWorkDevConsumer(getConversationWorkOptions());
  }
  app.post("/api/internal/agent/continue", (c) => {
    agentContinuePOST ??= createVercelConversationWorkCallback(
      getConversationWorkOptions(),
    );
    return agentContinuePOST(c.req.raw);
  });

  app.get("/api/internal/heartbeat", (c) => {
    return heartbeatGET(c.req.raw, waitUntil);
  });

  app.post("/api/webhooks/slack", (c) => {
    return slackWebhookPOST(c.req.raw, waitUntil, slackWebhookServices);
  });

  app.post("/api/webhooks/:platform", (c) => {
    return new Response(`Unknown platform: ${c.req.param("platform")}`, {
      status: 404,
    });
  });

  return app;
}
