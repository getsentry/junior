import { Hono, type Context } from "hono";
import {
  getConfigDefaults,
  setConfigDefaults,
} from "@/chat/configuration/defaults";
import { getSlackReactionConfig, setSlackReactionConfig } from "@/chat/config";
import { logException } from "@/chat/logging";
import { generateAssistantReply } from "@/chat/respond";
import { normalizeSandboxEgressTracePropagationDomains } from "@/chat/sandbox/egress-tracing";
import {
  getPluginCatalogSignature,
  getPluginProviders,
  setPluginCatalogConfig,
} from "@/chat/plugins/registry";
import {
  type AgentPluginRouteRegistration,
  getAgentPluginRoutes,
  setAgentPlugins,
  validateAgentPlugins,
} from "@/chat/plugins/agent-hooks";
import type { PluginCatalogConfig } from "@/chat/plugins/types";
import type {
  AgentPluginRouteMethod,
  JuniorPluginRegistration,
} from "@sentry/junior-plugin-api";
import {
  pluginCatalogConfigFromPluginSet,
  pluginHookRegistrationsFromPluginSet,
  type JuniorPluginSet,
} from "./plugins";
import { GET as healthGET } from "@/handlers/health";
import { POST as agentDispatchPOST } from "@/handlers/agent-dispatch";
import { GET as heartbeatGET } from "@/handlers/heartbeat";
import { GET as mcpOauthCallbackGET } from "@/handlers/mcp-oauth-callback";
import { GET as oauthCallbackGET } from "@/handlers/oauth-callback";
import {
  ALL as sandboxEgressProxyALL,
  isSandboxEgressRequest,
} from "@/handlers/sandbox-egress-proxy";
import { POST as webhooksPOST } from "@/handlers/webhooks";
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

/** Resolve plugin configuration from the env fallback. */
function resolveEnvPluginCatalogConfig(): PluginCatalogConfig | undefined {
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
  hookRegistrations: JuniorPluginRegistration[],
  virtualConfig: JuniorVirtualConfig | undefined,
): void {
  const bundledHookRegistrations = virtualConfig?.pluginHookRegistrations ?? [];
  if (bundledHookRegistrations.length === 0) {
    return;
  }

  const registered = new Set(hookRegistrations.map((plugin) => plugin.name));
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

function validatePluginRegistrations(
  registrations: JuniorPluginRegistration[],
): void {
  const loadedPlugins = getPluginProviders();
  const loadedNames = new Set(
    loadedPlugins.map((plugin) => plugin.manifest.name),
  );

  for (const registration of registrations) {
    if (!loadedNames.has(registration.name)) {
      throw new Error(
        `Plugin registration "${registration.name}" does not have a matching plugin manifest. Add an inline manifest, packageName, or app-local plugin.yaml with the same name.`,
      );
    }
  }
}

function validatePluginEgressCredentialHooks(
  registrations: JuniorPluginRegistration[],
): void {
  const plugins = new Map(
    registrations.map((registration) => [registration.name, registration]),
  );

  for (const provider of getPluginProviders()) {
    const hooks = plugins.get(provider.manifest.name)?.hooks;
    const hasGrantHook = Boolean(hooks?.grantForEgress);
    const hasIssueHook = Boolean(hooks?.issueCredential);
    const hasGenericCredentials = Boolean(
      provider.manifest.credentials || provider.manifest.apiHeaders,
    );
    const hasDomains = Boolean(provider.manifest.domains?.length);
    const hasHookManagedOAuth = Boolean(
      provider.manifest.oauth && !provider.manifest.credentials,
    );
    if (!hasGrantHook && !hasIssueHook) {
      if (hasDomains && !hasGenericCredentials) {
        throw new Error(
          `Plugin "${provider.manifest.name}" manifest.domains requires egress credential hooks when no generic credentials or apiHeaders are configured.`,
        );
      }
      if (hasHookManagedOAuth) {
        throw new Error(
          `Plugin "${provider.manifest.name}" manifest.oauth without oauth-bearer credentials requires egress credential hooks.`,
        );
      }
      continue;
    }

    if (!hasGrantHook || !hasIssueHook) {
      throw new Error(
        `Plugin "${provider.manifest.name}" egress credential hooks must include both grantForEgress and issueCredential.`,
      );
    }
    if (hasGenericCredentials) {
      throw new Error(
        `Plugin "${provider.manifest.name}" egress credential hooks must use manifest.domains instead of generic credentials or apiHeaders.`,
      );
    }
    if (!hasDomains) {
      throw new Error(
        `Plugin "${provider.manifest.name}" egress credential hooks require manifest.domains to list sandbox egress hosts.`,
      );
    }
  }
}

/** Mount plugin HTTP handlers before core routes claim those paths. */
function mountAgentPluginRoutes(
  app: Hono,
  routes: AgentPluginRouteRegistration[],
): void {
  for (const route of routes) {
    const handler = (c: Context) => route.handler(c.req.raw);
    const methods = Array.isArray(route.method)
      ? route.method
      : [route.method ?? "ALL"];
    const explicitMethods = methods.filter(
      (method): method is Exclude<AgentPluginRouteMethod, "ALL"> =>
        method !== "ALL",
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
  const agentPlugins = pluginHookRegistrationsFromPluginSet(configuredPlugins);
  const pluginConfig = configuredPlugins
    ? pluginCatalogConfigFromPluginSet(configuredPlugins)
    : (virtualConfig?.plugins ?? resolveEnvPluginCatalogConfig());
  if (configuredPlugins) {
    validateBuildIncludesPluginPackages(pluginConfig, virtualConfig);
  }
  validateBuildIncludesPluginHookRegistrations(agentPlugins, virtualConfig);
  validateAgentPlugins(agentPlugins);
  const shouldValidatePluginCatalog =
    hasConfiguredPluginCatalog(pluginConfig) ||
    Boolean(configuredPlugins?.registrations.length) ||
    Boolean(Object.keys(options?.configDefaults ?? {}).length);
  const previousPluginCatalogConfig = setPluginCatalogConfig(pluginConfig);
  const previousAgentPlugins = setAgentPlugins(agentPlugins);
  const previousConfigDefaults = getConfigDefaults();
  const previousSlackReactionConfig = getSlackReactionConfig();
  let agentPluginRoutes: AgentPluginRouteRegistration[] = [];
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
    agentPluginRoutes = getAgentPluginRoutes();
  } catch (error) {
    setPluginCatalogConfig(previousPluginCatalogConfig);
    setAgentPlugins(previousAgentPlugins);
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
    // Vercel Sandbox proxying preserves the original upstream path, so detect
    // authenticated proxy traffic before ordinary application routes claim it.
    if (isSandboxEgressRequest(c.req.raw)) {
      return await sandboxEgressProxyALL(c.req.raw, {
        tracePropagation: { domains: sandboxEgressTracePropagationDomains },
      });
    }
    await next();
  });

  mountAgentPluginRoutes(app, agentPluginRoutes);

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

  app.post("/api/webhooks/:platform", (c) => {
    return webhooksPOST(
      c.req.raw,
      c.req.param("platform"),
      waitUntil,
      slackWebhookServices,
    );
  });

  return app;
}
