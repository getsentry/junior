// Core owns host-level route ordering for Junior. ACP mounts before plugin
// routes, and plugin routes mount before the dashboard (see dashboard-routes).
import { Hono, type Context } from "hono";
import {
  getConfigDefaults,
  setConfigDefaults,
} from "@/chat/configuration/defaults";
import {
  botConfig,
  resetRuntimeConfig,
  restoreRuntimeConfig as restoreChatRuntimeConfig,
  setBotModelConfig,
  setCrossActorMidRunMode,
  setProfiles,
  setRuntimeLimits,
  snapshotRuntimeConfig,
  type BotModelConfig,
  type CrossActorMidRunMode,
  type RuntimeLimits,
  setSlackReactionConfig,
} from "@/chat/config";
import type { ModelProfileInput } from "@/chat/model-profile";
import { getConversationEventStore, getDb } from "@/chat/db";
import { logException, logWarn } from "@/chat/logging";
import { executeAgentRun } from "@/chat/agent";
import { normalizeSandboxEgressTracePropagationDomains } from "@/chat/sandbox/egress/tracing";
import {
  getExperimentalFeatures,
  setExperimentalFeatures,
  type ExperimentalFeaturesConfig,
} from "@/chat/experimental";
import { setBriefsConfig } from "@/chat/briefs/registration";
import {
  getSandboxResourceConfig,
  setSandboxResourceConfig,
  type SandboxResourceConfig,
} from "@/chat/sandbox/resources";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import {
  type PluginRouteRegistration,
  type PluginApiRouteRegistration,
  getPluginApiRoutes,
  getPluginRoutes,
  setPlugins,
  validatePlugins,
} from "@/chat/plugins/agent-hooks";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
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
  pluginRuntimeRegistrationsFromPluginSet,
  type JuniorPluginSet,
} from "./plugins";
import { GET as healthGET } from "@/handlers/health";
import { GET as heartbeatGET } from "@/handlers/heartbeat";
import { GET as retentionGET } from "@/handlers/retention";
import { GET as mcpOauthCallbackGET } from "@/handlers/mcp-oauth-callback";
import { GET as oauthCallbackGET } from "@/handlers/oauth-callback";
import { handleSandboxEgressRoute } from "@/handlers/sandbox-egress-route";
import {
  DELETE as sandboxEgressSignalsDELETE,
  GET as sandboxEgressSignalsGET,
} from "@/handlers/sandbox-egress-signals";
import { POST as slackWebhookPOST } from "@/handlers/slack-webhook";
import {
  JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE,
  JUNIOR_WORKSPACE_SNAPSHOT_JOB_CALLBACK_ROUTE,
} from "@/deployment";
import {
  consumeConversationQueueMessage,
  createVercelConversationWorkCallback,
  registerVercelConversationWorkDevConsumer,
} from "@/chat/task-execution/vercel-callback";
import type {
  ConversationQueueMessage,
  ConversationWorkQueue,
} from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import {
  createVercelPluginTaskCallback,
  registerVercelPluginTaskDevConsumer,
  type PluginTaskQueueMessage,
} from "@/chat/plugins/task-queue";
import { processPluginTask } from "@/chat/plugins/task-runner";
import {
  createVercelWorkspaceSnapshotJobCallback,
  registerVercelWorkspaceSnapshotJobDevConsumer,
} from "@/chat/sandbox/snapshot/job-callback";
import {
  createProductionConversationWorkOptions,
  createProductionSlackWebhookServices,
} from "@/chat/app/production";
import type { ConversationWorkCallbackOptions } from "@/chat/app/conversation-work";
import { createAgentRunner } from "@/chat/runtime/agent-runner";
import { createVercelAttachmentStorage } from "@/chat/attachments/vercel";
import { publicArtifactGET } from "@/handlers/artifacts";
import type { WaitUntilFn } from "@/handlers/types";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import { receiveLocalOAuthCredential } from "@/chat/local/credential-sync";
import { getStateAdapter } from "@/chat/state/adapter";
import { createAcpConversations } from "@/api/acp/conversations";
import { createAcpHttpHandler } from "@/api/acp/route";
import {
  ACP_AUTHORIZATION_PATH,
  handleAcpAuthorizationPage,
} from "@/api/acp/authorization-page";
import { JUNIOR_VERSION } from "./version";
import {
  createDashboardRouteRegistrations,
  validateDashboardRouteOwnership,
  type AuthenticatedRoute,
  type CreateDashboardApp,
  type HostRouteRegistration,
  type JuniorDashboardOptions,
} from "./dashboard-routes";

export { defineJuniorPlugins } from "./plugins";
export { JUNIOR_VERSION };
export type {
  JuniorPluginInput,
  JuniorPluginSet,
  JuniorPluginSetOptions,
} from "./plugins";
export type { ModelProfileInput } from "@/chat/model-profile";
export type { JuniorDashboardOptions } from "./dashboard-routes";
export interface JuniorAppOptions extends BotModelConfig {
  /**
   * Generate a durable Brief after each completed Turn. This costs one
   * default-model call per completed Turn. Disabled by default.
   */
  briefs?: { enabled?: boolean };
  /** Authenticated dashboard mounted by core when configured. */
  dashboard?: JuniorDashboardOptions;
  /**
   * Opt into unstable product features. Experimental keys may change or be
   * removed without a stable migration path; leave unset in production unless
   * you are deliberately dogfooding a pre-stable surface.
   */
  experimental?: ExperimentalFeaturesConfig;
  /** Profile used for new conversations. Configure with `profiles`. */
  defaultProfile?: string;
  /**
   * Named profiles available to the router and `handoff` tool. Configure with
   * `defaultProfile`. Each value may be a model id string or an object with
   * `modelId` and optional `description` and `reasoningLevel` settings.
   */
  profiles?: Readonly<Record<string, ModelProfileInput>>;
  /** Turn and conversation limits. Unset limits keep their defaults. */
  limits?: RuntimeLimits;
  /** Slack-specific overrides applied after env parsing. */
  slack?: {
    /** Slack emoji shown while Junior is processing. Defaults to `eyes`. */
    processingReactionEmoji?: string;
    /** Slack emoji shown after a turn completes. Defaults to `white_check_mark`. */
    completedReactionEmoji?: string;
    /**
     * What a mention from another person does while a turn runs: `follow_up`
     * waits for its own turn, `steer` joins the running turn. Defaults to
     * `JUNIOR_CROSS_ACTOR_MID_RUN_MODE` or `follow_up`.
     */
    crossActorMidRunMode?: CrossActorMidRunMode;
  };
  /** Install-wide provider defaults. Unregistered `provider.key` entries warn at startup. */
  configDefaults?: Record<string, unknown>;
  /** Queue consumer wiring for the durable conversation worker. */
  conversationWork?: ConversationWorkCallbackOptions;
  /**
   * Replace the Vercel Queue transport for conversation work, for example
   * with an in-process queue. `consume` runs one message through this app's
   * worker. Every app route and worker sends to the returned queue.
   */
  conversationWorkQueue?: (
    consume: (
      message: ConversationQueueMessage,
      delivery: { messageId: string },
    ) => Promise<void>,
  ) => ConversationWorkQueue;
  /**
   * Replace the Vercel Queue transport for plugin tasks, for example with an
   * in-process queue. `consume` runs one task through this app's task runner.
   * Completed Slack turns send their plugin tasks to the returned queue.
   * Mailbox turns, such as web turns, run their plugin tasks in the worker
   * and do not use this queue.
   */
  pluginTaskQueue?: (
    consume: (message: PluginTaskQueueMessage) => Promise<void>,
  ) => {
    send(
      message: PluginTaskQueueMessage,
      options?: { delaySeconds: number },
    ): Promise<void>;
  };
  /** Direct plugin set override. Usually omitted when `juniorNitro()` uses a plugin module. */
  plugins?: JuniorPluginSet;
  /** Sandbox execution options. */
  sandbox?: SandboxResourceConfig & {
    /**
     * Egress domains allowed to carry Sentry trace propagation headers.
     * Entries may be exact domains or leading wildcard domains such as
     * `*.sentry.io`; wildcard entries match subdomains, not the apex domain.
     */
    egressTracePropagationDomains?: string[];
  };
  waitUntil?: WaitUntilFn;
}

/** Resolve the public deployment URL used by ACP browser authorization. */
function resolveAcpBaseURL(
  dashboard: JuniorDashboardOptions | undefined,
): string | undefined {
  const configured =
    dashboard?.baseURL?.trim() || process.env.JUNIOR_BASE_URL?.trim();
  if (configured) return configured;

  const vercelURL =
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ||
    process.env.VERCEL_URL?.trim();
  if (!vercelURL) return undefined;
  return /^https?:\/\//.test(vercelURL) ? vercelURL : `https://${vercelURL}`;
}

type JuniorVirtualDashboardOptions = JuniorDashboardOptions;

interface JuniorVirtualConfig {
  functionMaxDurationSeconds?: number;
  createDashboardApp?: CreateDashboardApp;
  dashboard?: JuniorVirtualDashboardOptions;
  pluginSet?: JuniorPluginSet;
  plugins?: PluginCatalogConfig;
  pluginRuntimeRegistrations: string[];
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
      createDashboardApp?: CreateDashboardApp;
      functionMaxDurationSeconds?: number;
      dashboard?: JuniorVirtualDashboardOptions;
      pluginSet?: JuniorPluginSet;
      plugins?: PluginCatalogConfig;
      pluginRuntimeRegistrations?: string[];
    } = await import("#junior/config");
    return {
      createDashboardApp: mod.createDashboardApp,
      functionMaxDurationSeconds: mod.functionMaxDurationSeconds,
      dashboard: mod.dashboard,
      pluginSet: mod.pluginSet,
      plugins: mod.plugins,
      pluginRuntimeRegistrations: mod.pluginRuntimeRegistrations ?? [],
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

function warnUnregisteredConfigDefaults(
  defaults: Record<string, unknown> | undefined,
): void {
  for (const key of Object.keys(defaults ?? {})) {
    if (!pluginCatalogRuntime.isConfigKey(key)) {
      logWarn("config.default.unregistered", { "app.config.key": key });
    }
  }
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

function validateBuildIncludesPluginRuntimeRegistrations(
  runtimeRegistrations: PluginRegistration[],
  virtualConfig: JuniorVirtualConfig | undefined,
): void {
  const bundledRuntimeRegistrations =
    virtualConfig?.pluginRuntimeRegistrations ?? [];
  if (bundledRuntimeRegistrations.length === 0) {
    return;
  }

  const registered = new Set(
    runtimeRegistrations.map((plugin) => plugin.manifest.name),
  );
  const missing = bundledRuntimeRegistrations.filter(
    (pluginName) => !registered.has(pluginName),
  );
  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `createApp() is missing plugin registration(s) with runtime code bundled by juniorNitro(): ${missing.join(", ")}. Pass a runtime-safe plugin module to juniorNitro({ plugins: "./plugins" }) or pass the same defineJuniorPlugins(...) set to createApp({ plugins }).`,
  );
}

/** Mount HTTP handlers before core routes claim those paths. */
function mountRoutes(app: Hono, routes: HostRouteRegistration[]): void {
  for (const route of routes) {
    const handler = (c: Context) => route.handler(c.req.raw);
    const methods =
      typeof route.method === "string"
        ? [route.method]
        : (route.method ?? ["ALL"]);
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
  const dashboard = options?.dashboard ?? virtualConfig?.dashboard;
  const configuredPlugins = options?.plugins ?? virtualConfig?.pluginSet;
  const plugins = pluginRuntimeRegistrationsFromPluginSet(configuredPlugins);
  const pluginConfig = configuredPlugins
    ? pluginCatalogConfigFromPluginSet(configuredPlugins)
    : (virtualConfig?.plugins ?? pluginCatalogConfigFromEnv());
  if (configuredPlugins) {
    validateBuildIncludesPluginPackages(pluginConfig, virtualConfig);
  }
  validateBuildIncludesPluginRuntimeRegistrations(plugins, virtualConfig);
  validatePlugins(plugins);
  getDb();
  const shouldValidatePluginCatalog =
    hasConfiguredPluginCatalog(pluginConfig) ||
    Boolean(configuredPlugins?.registrations.length) ||
    Boolean(Object.keys(options?.configDefaults ?? {}).length);
  const previousRuntimeConfig = snapshotRuntimeConfig();
  const previousPluginCatalogConfig =
    pluginCatalogRuntime.setConfig(pluginConfig);
  const previousPlugins = setPlugins(plugins);
  const previousConfigDefaults = getConfigDefaults();
  const previousSandboxResources = getSandboxResourceConfig();
  const previousExperimentalFeatures = getExperimentalFeatures();
  const previousBriefsConfig = setBriefsConfig(options?.briefs);
  const previousDashboardLinkOptions =
    setDashboardConversationLinkOptions(dashboard);
  const restoreRuntimeConfig = (): void => {
    pluginCatalogRuntime.setConfig(previousPluginCatalogConfig);
    setPlugins(previousPlugins);
    setConfigDefaults(previousConfigDefaults);
    restoreChatRuntimeConfig(previousRuntimeConfig);
    setSandboxResourceConfig(previousSandboxResources);
    setExperimentalFeatures(previousExperimentalFeatures);
    setBriefsConfig(previousBriefsConfig);
    setDashboardConversationLinkOptions(previousDashboardLinkOptions);
  };
  let pluginRoutes: PluginRouteRegistration[] = [];
  let pluginApiRoutes: PluginApiRouteRegistration[] = [];
  const events = createEventAppPublisher({
    conversationWork: () => ({
      ...getConversationWorkOptions(),
      queue: conversationWorkQueue,
    }),
  });
  let sandboxEgressTracePropagationDomains: string[] = [];
  try {
    sandboxEgressTracePropagationDomains =
      normalizeSandboxEgressTracePropagationDomains(
        options?.sandbox?.egressTracePropagationDomains,
      );
    setSandboxResourceConfig(options?.sandbox);
    setExperimentalFeatures(options?.experimental);
    setConfigDefaults(options?.configDefaults);
    warnUnregisteredConfigDefaults(options?.configDefaults);
    // Start from the defaults so this app cannot inherit an earlier app's
    // models, profiles, limits, or Slack settings.
    resetRuntimeConfig(virtualConfig?.functionMaxDurationSeconds);
    if (options?.profiles || options?.defaultProfile) {
      setProfiles(options.profiles, options.defaultProfile);
    }
    setBotModelConfig(options ?? {});
    setRuntimeLimits(options?.limits);
    setSlackReactionConfig(options?.slack ?? {});
    if (options?.slack?.crossActorMidRunMode) {
      setCrossActorMidRunMode(options.slack.crossActorMidRunMode);
    }
    if (shouldValidatePluginCatalog) {
      pluginCatalogRuntime.getSignature();
      validatePluginRegistrations(configuredPlugins?.registrations ?? []);
      validatePluginEgressCredentialHooks(
        configuredPlugins?.registrations ?? [],
      );
    }
    pluginRoutes = getPluginRoutes({ events });
    if (dashboard && !dashboard.disabled) {
      pluginApiRoutes = getPluginApiRoutes();
    }
  } catch (error) {
    restoreRuntimeConfig();
    throw error;
  }

  const waitUntil = options?.waitUntil ?? (await defaultWaitUntil());
  const tracePropagation = { domains: sandboxEgressTracePropagationDomains };
  const conversationWorkQueue: ConversationWorkQueue =
    options?.conversationWork?.queue ??
    options?.conversationWorkQueue?.((message, delivery) =>
      consumeConversationQueueMessage(message, {
        ...getConversationWorkOptions(),
        messageId: delivery.messageId,
      }),
    ) ??
    getVercelConversationWorkQueue();
  const pluginTaskQueue:
    | ReturnType<NonNullable<JuniorAppOptions["pluginTaskQueue"]>>
    | undefined = options?.pluginTaskQueue?.((message) =>
    processPluginTask(message, {
      send: (next, delivery) => {
        if (!pluginTaskQueue) {
          throw new Error("Plugin task queue is unavailable");
        }
        return pluginTaskQueue.send(next, delivery);
      },
    }),
  );
  const attachmentStorage = createVercelAttachmentStorage();
  const agentRunner = createAgentRunner(executeAgentRun, {
    attachmentStorage,
    bindSpawnAgent: (request) =>
      bindSpawnAgent(request, { queue: conversationWorkQueue }),
    tracePropagation,
  });
  const runtimeServiceOverrides = {
    agentRunner,
    sandbox: { tracePropagation },
    visionContext: { attachmentStorage },
  };
  let conversationWorkOptions: ConversationWorkCallbackOptions | undefined;
  const getConversationWorkOptions = (): ConversationWorkCallbackOptions => {
    conversationWorkOptions ??=
      options?.conversationWork ??
      createProductionConversationWorkOptions({
        agentRunner,
        queue: conversationWorkQueue,
        ...(pluginTaskQueue
          ? { sendPluginTask: (message) => pluginTaskQueue.send(message) }
          : undefined),
        services: runtimeServiceOverrides,
        waitUntil: (task) => waitUntil(task),
      });
    return conversationWorkOptions;
  };
  let acpRuntime:
    | {
        handleRequest(request: Request): Promise<Response>;
        state: ReturnType<typeof getStateAdapter>;
      }
    | undefined;
  /** Create ACP state and Conversation bindings only after the first ACP request. */
  const getAcpRuntime = () => {
    if (acpRuntime) return acpRuntime;
    const work = getConversationWorkOptions();
    const state = work.state ?? getStateAdapter();
    acpRuntime = {
      handleRequest: createAcpHttpHandler({
        ...(dashboard && !dashboard.disabled
          ? { browserAuth: { baseURL: resolveAcpBaseURL(dashboard) } }
          : undefined),
        conversations: createAcpConversations({
          conversationStore: work.conversationStore,
          eventStore: getConversationEventStore(),
          queue: conversationWorkQueue,
          state,
        }),
        onError: (error, event, attributes) =>
          void logException(error, event, { ...attributes, platform: "acp" }),
        state,
        version: JUNIOR_VERSION,
      }),
      state,
    };
    return acpRuntime;
  };
  const authenticatedRoutes: AuthenticatedRoute[] =
    dashboard && !dashboard.disabled
      ? [
          {
            handler: (request, user) =>
              handleAcpAuthorizationPage({
                agentName: botConfig.userName,
                request,
                state: getAcpRuntime().state,
                user,
              }),
            method: ["GET", "POST"],
            path: ACP_AUTHORIZATION_PATH,
          },
        ]
      : [];
  try {
    validateDashboardRouteOwnership({
      authenticatedRoutes,
      dashboard,
      routes: pluginRoutes,
    });
  } catch (error) {
    restoreRuntimeConfig();
    throw error;
  }
  const slackWebhookServices = createProductionSlackWebhookServices({
    queue: conversationWorkQueue,
    services: runtimeServiceOverrides,
  });

  const app = new Hono();

  app.onError((err, c) => {
    logException(err, "route.unhandled.exception");
    return c.text("Internal Server Error", 500);
  });

  app.use("*", async (c, next) => {
    return await handleSandboxEgressRoute(
      c.req.raw,
      sandboxEgressTracePropagationDomains,
      next,
    );
  });

  app.on(["GET", "POST", "DELETE"], "/api/acp", (c) =>
    getAcpRuntime().handleRequest(c.req.raw),
  );
  mountRoutes(app, pluginRoutes);
  mountRoutes(
    app,
    await createDashboardRouteRegistrations({
      authenticatedRoutes,
      conversationWorkQueue,
      dashboard,
      createDashboardApp: virtualConfig?.createDashboardApp,
      pluginRoutes: pluginApiRoutes,
    }),
  );

  app.get("/", () => healthGET());
  app.get("/health", () => healthGET());
  app.get("/public/artifacts/:filename", (c) =>
    publicArtifactGET({
      filename: c.req.param("filename"),
      storage: attachmentStorage,
    }),
  );

  // MCP callback must be registered before the generic OAuth callback
  // because Hono matches routes top-down and `:provider` would swallow `mcp/`.
  app.get("/api/oauth/callback/mcp/:provider", (c) => {
    return mcpOauthCallbackGET(c.req.raw, c.req.param("provider"), waitUntil, {
      conversationWorkQueue,
    });
  });

  app.get("/api/oauth/callback/:provider", (c) => {
    return oauthCallbackGET(c.req.raw, c.req.param("provider"), waitUntil, {
      conversationWorkQueue,
    });
  });

  app.get("/api/internal/sandbox-egress/signals", (c) => {
    return sandboxEgressSignalsGET(c.req.raw);
  });

  app.delete("/api/internal/sandbox-egress/signals", (c) => {
    return sandboxEgressSignalsDELETE(c.req.raw);
  });

  app.post("/api/internal/local-oauth-credentials", (c) => {
    return receiveLocalOAuthCredential(c.req.raw);
  });

  let agentContinuePOST:
    | ReturnType<typeof createVercelConversationWorkCallback>
    | undefined;
  let pluginTaskPOST:
    | ReturnType<typeof createVercelPluginTaskCallback>
    | undefined;
  if (process.env.NODE_ENV === "development") {
    registerVercelConversationWorkDevConsumer(getConversationWorkOptions());
    registerVercelPluginTaskDevConsumer();
    registerVercelWorkspaceSnapshotJobDevConsumer();
  }
  app.post("/api/internal/agent/continue", (c) => {
    agentContinuePOST ??= createVercelConversationWorkCallback(
      getConversationWorkOptions(),
    );
    return agentContinuePOST(c.req.raw);
  });
  app.post(JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE, (c) => {
    pluginTaskPOST ??= createVercelPluginTaskCallback();
    return pluginTaskPOST(c.req.raw);
  });
  let workspaceSnapshotJobPOST:
    | ReturnType<typeof createVercelWorkspaceSnapshotJobCallback>
    | undefined;
  app.post(JUNIOR_WORKSPACE_SNAPSHOT_JOB_CALLBACK_ROUTE, (c) => {
    workspaceSnapshotJobPOST ??= createVercelWorkspaceSnapshotJobCallback();
    return workspaceSnapshotJobPOST(c.req.raw);
  });

  app.get("/api/internal/heartbeat", (c) => {
    return heartbeatGET(c.req.raw, waitUntil, { conversationWorkQueue });
  });

  app.get("/api/internal/retention", (c) => {
    return retentionGET(c.req.raw);
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
