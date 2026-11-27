// Core owns host-level route ordering for Junior. ACP and MCP mount before
// plugin routes, and plugin routes mount before the dashboard (see
// dashboard-routes).

import { Hono, type Context } from "hono";
import {
  botConfig,
  getChatConfig,
  installChatConfig,
  type BotModelConfig,
  type RuntimeLimits,
} from "@/chat/config";
import { loadConfig, type ConfigInput } from "@/config";
import { getConversationEventStore, getDb } from "@/chat/db";
import { logException, logWarn } from "@/chat/logging";
import { executeAgentRun } from "@/chat/agent";
import { normalizeSandboxEgressTracePropagationDomains } from "@/chat/sandbox/egress/tracing";
import type { ExperimentalFeaturesConfig } from "@/chat/experimental";
import {
  createAppContext,
  getAppContext,
  installAppContext,
} from "@/app/context";
import { validatePlugins } from "@/chat/plugins/hooks/registry";
import {
  type PluginRouteRegistration,
  type PluginApiRouteRegistration,
  getPluginApiRoutes,
  getPluginRoutes,
} from "@/chat/plugins/hooks/routes";
import type { MemoryOptions } from "@/chat/memory/registration";
import { readObjectLinkTypes } from "@/api/objects/resolve";
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
import { GET as autoArchiveGET } from "@/handlers/auto-archive";
import { GET as mcpOauthCallbackGET } from "@/handlers/mcp-oauth-callback";
import { GET as oauthCallbackGET } from "@/handlers/oauth-callback";
import { handleSandboxEgressRoute } from "@/handlers/sandbox-egress-route";
import {
  DELETE as sandboxEgressSignalsDELETE,
  GET as sandboxEgressSignalsGET,
} from "@/handlers/sandbox-egress-signals";
import { POST as slackWebhookPOST } from "@/handlers/slack-webhook";
import {
  JUNIOR_AUTO_ARCHIVE_ROUTE,
  JUNIOR_CACHE_WARMUP_CALLBACK_ROUTE,
  JUNIOR_CONTEXT_COMPACTION_CALLBACK_ROUTE,
  JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE,
  JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE,
  JUNIOR_TURN_ENDED_CALLBACK_ROUTE,
  JUNIOR_TURN_STEP_CALLBACK_ROUTE,
  JUNIOR_WORKSPACE_SNAPSHOT_JOB_CALLBACK_ROUTE,
} from "@/deployment";
import {
  consumeConversationQueueMessage,
  createVercelConversationWorkCallback,
} from "@/chat/task-execution/vercel-callback";
import type {
  ConversationQueueMessage,
  ConversationWorkQueue,
} from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { bindMessageAgent } from "@/chat/child-agents/message";
import { bindSpawnAgent } from "@/chat/child-agents/spawn";
import {
  createVercelPluginTaskCallback,
  sendVercelPluginTask,
  type PluginTaskQueueMessage,
  type PluginTaskSendOptions,
} from "@/chat/plugins/task-queue";
import {
  processPluginTask,
  type SendPluginTask,
} from "@/chat/plugins/task-runner";
import { createVercelCacheWarmupCallback } from "@/chat/cache-warming/queue";
import { createVercelWorkspaceSnapshotJobCallback } from "@/chat/sandbox/snapshot/job-callback";
import { createVercelBackgroundCompactionCallback } from "@/chat/services/background-compaction-callback";
import { processBackgroundCompaction } from "@/chat/services/background-compaction";
import {
  createGatewayModelClient,
  turnStepConsumer,
} from "@/turn-steps/consumer";
import { turnTools } from "@/turn-steps/tools";
import { deploymentDelivery, turnEndedConsumer } from "@/turn-steps/turn-ended";
import { sweepTurns } from "@/core/turn/sweep";
import { sweepDeliveries } from "@/delivery/sweep";
import { createEngineContext } from "@/turn-steps/engine-context";
import {
  vercelBackgroundCompactionQueue,
  type BackgroundCompactionMessage,
  type BackgroundCompactionQueue,
} from "@/chat/services/background-compaction-queue";
import {
  createProductionConversationWorkOptions,
  createProductionSlackWebhookServices,
  getProductionSlackAdapter,
} from "@/chat/app/production";
import { createInboxItemShow } from "@/chat/notifications/inbox-item-show";
import type { ConversationWorkCallbackOptions } from "@/chat/app/conversation-work";
import { createAgentRunner } from "@/chat/runtime/agent-runner";
import { getAttachmentStorage } from "@/chat/attachments/storage";
import { publicArtifactGET } from "@/handlers/artifacts";
import type { WaitUntilFn } from "@/handlers/types";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import {
  createIdentityDispatcher,
  type IdentityDispatcher,
} from "@/chat/agent-dispatch/identity";
import { receiveLocalOAuthCredential } from "@/chat/local/credential-sync";
import { getStateAdapter } from "@/chat/state/adapter";
import { createAcpConversations } from "@/api/acp/conversations";
import { createAcpHttpHandler } from "@/api/acp/route";
import { handleMcpConsentPage } from "@/api/mcp/oauth/consent-page";
import { MCP_CONSENT_PATH } from "@/api/mcp/oauth/metadata";
import { createMcpHttpHandler, MCP_ROUTE_PATHS } from "@/api/mcp/route";
import {
  ACP_AUTHORIZATION_PATH,
  handleAcpAuthorizationPage,
} from "@/api/acp/authorization-page";
import {
  createSignInAuth,
  resolveSignInAuthConfig,
  type SignInAuth,
  type SignInAuthConfig,
} from "@/chat/sign-in/auth";
import { assertNoLegacyAllowedDomains } from "@/chat/sign-in/allowlist";
import { JUNIOR_VERSION } from "./version";
import {
  createDashboardRouteRegistrations,
  dashboardRequiresSignIn,
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
import { isMissingVirtualModule } from "./virtual-module";
export type { JuniorDashboardOptions } from "./dashboard-routes";
export type { MemoryOptions } from "@/chat/memory/registration";
export interface JuniorAppOptions extends BotModelConfig {
  /**
   * Embed the searchable events of a Conversation after each completed Turn,
   * so `searchConversationEvents` also matches its history by meaning. This
   * costs one embedding call per 32 new events. Disabled by default. Word
   * search works without it.
   */
  eventEmbeddings?: { enabled?: boolean };
  /**
   * Domains that may use Junior. Slack checks the email domain of the
   * author's Slack profile. Dashboard Google sign-in checks the `hd` claim of
   * the Google Workspace account. Defaults to `JUNIOR_ALLOWED_DOMAINS`.
   * Recommended. Dashboard auth requires at least one. Empty lets every
   * Slack workspace member use Junior.
   */
  allowedDomains?: string[];
  /** Authenticated dashboard mounted by core when configured. */
  dashboard?: JuniorDashboardOptions;
  /**
   * Opt into unstable product features. Experimental keys may change or be
   * removed without a stable migration path; leave unset in production unless
   * you are deliberately dogfooding a pre-stable surface.
   */
  experimental?: ExperimentalFeaturesConfig;
  /** Turn and conversation limits. Unset limits keep their defaults. */
  limits?: RuntimeLimits;
  /** Long-term Memory settings. Memory is always on. */
  memory?: MemoryOptions;
  /** Slack-specific overrides applied after env parsing. */
  slack?: {
    /** Slack emoji shown while Junior is processing. Defaults to `eyes`. */
    processingReactionEmoji?: string;
    /** Slack emoji shown after a turn completes. Defaults to `white_check_mark`. */
    completedReactionEmoji?: string;
    /**
     * Slack user IDs of bots that may start a Turn from a mention or DM. Bots
     * have no profile email, so `allowedDomains` blocks them otherwise.
     */
    allowedBotUserIds?: string[];
    /**
     * Join each public channel created after this is on. Existing channels
     * are not joined. The Slack app must subscribe to `channel_created`.
     * Defaults to `false`.
     */
    autoJoinNewChannels?: boolean;
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
    consume: (
      message: PluginTaskQueueMessage,
      delivery?: { deliveryCount: number },
    ) => Promise<void>,
  ) => {
    send(
      message: PluginTaskQueueMessage,
      options?: PluginTaskSendOptions,
    ): Promise<void>;
  };
  /**
   * Replace the Vercel Queue transport for background compaction jobs, for
   * example with an in-process queue. `consume` runs one job.
   */
  backgroundCompactionQueue?: (
    consume: (message: BackgroundCompactionMessage) => Promise<void>,
  ) => BackgroundCompactionQueue;
  /** Direct plugin set override. Usually omitted when `juniorNitro()` uses a plugin module. */
  plugins?: JuniorPluginSet;
  /** Sandbox execution options. */
  sandbox?: {
    /**
     * vCPUs of each sandbox. Each vCPU adds 2 GB of memory. A Workspace vCPU
     * count wins over it, and it wins over `SANDBOX_VCPUS`.
     */
    vcpus?: number | undefined;
    /**
     * Egress domains allowed to carry Sentry trace propagation headers.
     * Entries may be exact domains or leading wildcard domains such as
     * `*.sentry.io`; wildcard entries match subdomains, not the apex domain.
     */
    egressTracePropagationDomains?: string[] | undefined;
  };
  waitUntil?: WaitUntilFn;
}

type JuniorVirtualDashboardOptions = JuniorDashboardOptions;

interface JuniorVirtualConfig {
  botName?: string | undefined;
  functionMaxDurationSeconds?: number | undefined;
  createDashboardApp?: CreateDashboardApp | undefined;
  dashboard?: JuniorVirtualDashboardOptions | undefined;
  pluginSet?: JuniorPluginSet | undefined;
  plugins?: PluginCatalogConfig | undefined;
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
      botName?: string;
      createDashboardApp?: CreateDashboardApp | undefined;
      functionMaxDurationSeconds?: number;
      dashboard?: JuniorVirtualDashboardOptions | undefined;
      pluginSet?: JuniorPluginSet | undefined;
      plugins?: PluginCatalogConfig;
      pluginRuntimeRegistrations?: string[];
    } = await import("#junior/config");
    return {
      botName: mod.botName,
      createDashboardApp: mod.createDashboardApp,
      functionMaxDurationSeconds: mod.functionMaxDurationSeconds,
      dashboard: mod.dashboard,
      pluginSet: mod.pluginSet,
      plugins: mod.plugins,
      pluginRuntimeRegistrations: mod.pluginRuntimeRegistrations ?? [],
    };
  } catch (error) {
    if (!isMissingVirtualModule(error, "#junior/config")) {
      throw error;
    }
    return undefined;
  }
}

/** Config values that createApp options and the build set over env. */
function appConfigInput(
  options: JuniorAppOptions | undefined,
  virtualConfig: JuniorVirtualConfig | undefined,
): ConfigInput {
  const dashboard = options?.dashboard ?? virtualConfig?.dashboard;
  return {
    bot: {
      modelId: options?.modelId,
      decisionModelId: options?.decisionModelId,
      embeddingModelId: options?.embeddingModelId,
      fastModelId: options?.fastModelId,
      rerankingModelId: options?.rerankingModelId,
      guardianModelId: options?.guardianModelId,
      imageGenerationModelId: options?.imageGenerationModelId,
      transcriptionModelId: options?.transcriptionModelId,
      visionModelId: options?.visionModelId,
      webSearchModelId: options?.webSearchModelId,
      refusalFallbackModelId: options?.refusalFallbackModelId,
      userName: virtualConfig?.botName,
    },
    configDefaults: options?.configDefaults,
    dashboard: dashboard && {
      basePath: dashboard.basePath,
      baseURL: dashboard.baseURL,
      disabled: dashboard.disabled,
    },
    deployment: {
      configuredBaseUrl: dashboard?.baseURL?.trim() || undefined,
    },
    eventEmbeddings: options?.eventEmbeddings,
    experimental: options?.experimental,
    functionMaxDurationSeconds: virtualConfig?.functionMaxDurationSeconds,
    limits: options?.limits,
    memory: {
      disableExtraction: options?.memory?.disableExtraction,
      disableRecall: options?.memory?.disableRecall,
      modelId: options?.memory?.modelId?.trim() || undefined,
    },
    sandbox: { vcpus: options?.sandbox?.vcpus },
    slack: {
      completedReactionEmoji: options?.slack?.completedReactionEmoji,
      processingReactionEmoji: options?.slack?.processingReactionEmoji,
    },
    trust: {
      allowedBotUserIds: options?.slack?.allowedBotUserIds,
      allowedDomains: options?.allowedDomains,
    },
  };
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
    if (!getAppContext().catalog.isConfigKey(key)) {
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
  // The build puts the bot name in the system prompt, so only the build sets it.
  if (options && "botName" in options) {
    throw new Error(
      "createApp({ botName }) was removed; set botName in juniorNitro() instead",
    );
  }
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
  const previousAppContext = installAppContext(
    createAppContext({ plugins, pluginConfig }),
  );
  let restoreChatConfig: (() => void) | undefined;
  const restoreRuntimeConfig = (): void => {
    installAppContext(previousAppContext);
    restoreChatConfig?.();
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
  let signInConfig: SignInAuthConfig | undefined;
  let allowedDomains: string[] = [];
  let dispatchForIdentity: IdentityDispatcher;
  try {
    sandboxEgressTracePropagationDomains =
      normalizeSandboxEgressTracePropagationDomains(
        options?.sandbox?.egressTracePropagationDomains,
      );
    // Resolve the whole config from env and this app's options, so this app
    // cannot inherit an earlier app's models, limits, or Slack settings.
    const previousChatConfig = installChatConfig(
      loadConfig({
        env: process.env,
        options: appConfigInput(options, virtualConfig),
      }),
    );
    restoreChatConfig = () => installChatConfig(previousChatConfig);
    warnUnregisteredConfigDefaults(options?.configDefaults);
    // One domain list for Slack authors and dashboard sign-ins.
    assertNoLegacyAllowedDomains(Object.keys(dashboard ?? {}));
    allowedDomains = getChatConfig().trust.allowedDomains;
    if (allowedDomains.length === 0) {
      logWarn("app.allowed_domains.unset", {
        "app.reason":
          "allowedDomains is empty, so any Slack workspace member can use the bot",
      });
    }
    // One entry point for plugin routes and heartbeats, so both use the
    // same rules for who counts as a person.
    dispatchForIdentity = createIdentityDispatcher({
      conversationWorkQueue: () => conversationWorkQueue,
    });
    if (dashboard && !dashboard.disabled) {
      signInConfig = resolveSignInAuthConfig(
        botConfig.userName,
        allowedDomains,
        dashboard,
      );
    }
    if (shouldValidatePluginCatalog) {
      getAppContext().catalog.getSignature();
      validatePluginRegistrations(configuredPlugins?.registrations ?? []);
      validatePluginEgressCredentialHooks(
        configuredPlugins?.registrations ?? [],
      );
    }
    pluginRoutes = getPluginRoutes({
      dispatchForIdentity,
      events,
      // The queue is chosen below, before any route runs.
      sendPluginTask: (message, options) => sendPluginTask(message, options),
      showInboxItem: createInboxItemShow(getProductionSlackAdapter),
    });
    if (dashboard && !dashboard.disabled) {
      pluginApiRoutes = getPluginApiRoutes();
      // Fail at load when two link types claim the same URLs.
      readObjectLinkTypes(plugins);
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
  const pluginTaskQueue = options?.pluginTaskQueue?.((message, delivery) =>
    processPluginTask(message, {
      deliveryCount: delivery?.deliveryCount,
      events,
      sendPluginTask: (task, sendOptions) => sendPluginTask(task, sendOptions),
      showInboxItem: createInboxItemShow(getProductionSlackAdapter),
    }),
  );
  const sendPluginTask: SendPluginTask = pluginTaskQueue
    ? (message, sendOptions) => pluginTaskQueue.send(message, sendOptions)
    : sendVercelPluginTask;
  const backgroundCompactionQueue =
    options?.backgroundCompactionQueue?.((message) =>
      processBackgroundCompaction(message),
    ) ?? vercelBackgroundCompactionQueue;
  const attachmentStorage = getAttachmentStorage();
  const agentRunner = createAgentRunner(executeAgentRun, {
    attachmentStorage,
    backgroundCompactionQueue,
    bindMessageAgent: (request) =>
      bindMessageAgent(request, { queue: conversationWorkQueue }),
    bindSpawnAgent: (request) =>
      bindSpawnAgent(request, { queue: conversationWorkQueue }),
    conversationWorkQueue,
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
        sendPluginTask,
        services: runtimeServiceOverrides,
        waitUntil,
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
          ? {
              browserAuth: {
                agentName: botConfig.userName,
                baseURL: getChatConfig().deployment.baseUrl,
              },
            }
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
  const mcpEnabled = dashboardRequiresSignIn(dashboard);
  const getMcpState = () =>
    options?.conversationWork?.state ?? getStateAdapter();
  const mcpConsentRoute: AuthenticatedRoute = {
    handler: (request, user) =>
      handleMcpConsentPage({
        agentName: botConfig.userName,
        baseURL: getChatConfig().deployment.baseUrl,
        request,
        state: getMcpState(),
        user,
      }),
    method: ["GET", "POST"],
    path: MCP_CONSENT_PATH,
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
          ...(mcpEnabled ? [mcpConsentRoute] : []),
        ]
      : [];
  try {
    validateDashboardRouteOwnership({
      authenticatedRoutes,
      coreRoutePaths: mcpEnabled ? MCP_ROUTE_PATHS : [],
      dashboard,
      routes: pluginRoutes,
    });
  } catch (error) {
    restoreRuntimeConfig();
    throw error;
  }
  // The Google sign-in session of the dashboard.
  const signInAuth: SignInAuth | undefined = signInConfig
    ? createSignInAuth(signInConfig)
    : undefined;
  const slackWebhookServices = {
    ...createProductionSlackWebhookServices({
      queue: conversationWorkQueue,
      services: runtimeServiceOverrides,
    }),
    autoJoinNewChannels: options?.slack?.autoJoinNewChannels === true,
  };

  const app = new Hono();

  app.onError((err, c) => {
    logException(err, "route.unhandled.exception");
    return c.text("Internal Server Error", 500);
  });

  app.use("*", async function sandboxEgress(c, next) {
    return await handleSandboxEgressRoute(
      c.req.raw,
      sandboxEgressTracePropagationDomains,
      next,
    );
  });

  app.on(["GET", "POST", "DELETE"], "/api/acp", (c) =>
    getAcpRuntime().handleRequest(c.req.raw),
  );
  if (mcpEnabled) {
    let handleMcpRequest: ReturnType<typeof createMcpHttpHandler> | undefined;
    app.on(["GET", "POST", "DELETE"], MCP_ROUTE_PATHS, (c) => {
      handleMcpRequest ??= createMcpHttpHandler({
        allowedDomains,
        baseURL: getChatConfig().deployment.baseUrl,
        attachmentStorage,
        queue: conversationWorkQueue,
        state: getMcpState(),
      });
      return handleMcpRequest(c.req.raw);
    });
  }
  mountRoutes(app, pluginRoutes);
  mountRoutes(
    app,
    await createDashboardRouteRegistrations({
      allowedDomains,
      auth: signInAuth,
      authenticatedRoutes,
      conversationWorkQueue,
      // Keep dashboard redirects on the origin of the sign-in callback.
      dashboard:
        dashboard && signInConfig
          ? { ...dashboard, baseURL: signInConfig.baseURL }
          : dashboard,
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
  // Built after createApp installs the config, so the lease and the queue visibility
  // timeout use this app's functionMaxDurationSeconds.
  const chatConfig = getChatConfig();
  const engineCtx = createEngineContext(chatConfig);
  const turnEnds = turnEndedConsumer(engineCtx, deploymentDelivery);
  app.post(JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE, (c) => {
    agentContinuePOST ??= createVercelConversationWorkCallback(
      getConversationWorkOptions(),
    );
    return agentContinuePOST(c.req.raw);
  });
  app.post(JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE, (c) => {
    pluginTaskPOST ??= createVercelPluginTaskCallback({
      events,
      sendPluginTask,
      showInboxItem: createInboxItemShow(getProductionSlackAdapter),
    });
    return pluginTaskPOST(c.req.raw);
  });
  let workspaceSnapshotJobPOST:
    | ReturnType<typeof createVercelWorkspaceSnapshotJobCallback>
    | undefined;
  app.post(JUNIOR_WORKSPACE_SNAPSHOT_JOB_CALLBACK_ROUTE, (c) => {
    workspaceSnapshotJobPOST ??= createVercelWorkspaceSnapshotJobCallback();
    return workspaceSnapshotJobPOST(c.req.raw);
  });
  let cacheWarmupPOST:
    | ReturnType<typeof createVercelCacheWarmupCallback>
    | undefined;
  app.post(JUNIOR_CACHE_WARMUP_CALLBACK_ROUTE, (c) => {
    cacheWarmupPOST ??= createVercelCacheWarmupCallback();
    return cacheWarmupPOST(c.req.raw);
  });
  let backgroundCompactionPOST:
    | ReturnType<typeof createVercelBackgroundCompactionCallback>
    | undefined;
  app.post(JUNIOR_CONTEXT_COMPACTION_CALLBACK_ROUTE, (c) => {
    backgroundCompactionPOST ??= createVercelBackgroundCompactionCallback();
    return backgroundCompactionPOST(c.req.raw);
  });
  let turnStepPOST:
    | ReturnType<typeof engineCtx.queue.createCallback>
    | undefined;
  // Built on the first step message, like the callbacks above. It builds the
  // Turn prompt layouts, so building it at startup would slow every cold
  // start, and a failure there would stop every route of the app.
  app.post(JUNIOR_TURN_STEP_CALLBACK_ROUTE, async (c) => {
    turnStepPOST ??= engineCtx.queue.createCallback(
      await turnStepConsumer(engineCtx, {
        client: createGatewayModelClient(),
        bot: chatConfig.bot,
        tools: turnTools,
      }),
    );
    return turnStepPOST(c.req.raw);
  });
  let turnEndedPOST:
    | ReturnType<typeof engineCtx.queue.createCallback>
    | undefined;
  app.post(JUNIOR_TURN_ENDED_CALLBACK_ROUTE, (c) => {
    turnEndedPOST ??= engineCtx.queue.createCallback(turnEnds);
    return turnEndedPOST(c.req.raw);
  });

  app.get("/api/internal/heartbeat", (c) => {
    return heartbeatGET(c.req.raw, waitUntil, {
      conversationWorkQueue,
      dispatchForIdentity,
      events,
      sendPluginTask,
      showInboxItem: createInboxItemShow(getProductionSlackAdapter),
      sweepTurns: async () => {
        await sweepTurns(engineCtx);
        await sweepDeliveries(engineCtx);
      },
    });
  });

  app.get("/api/internal/retention", (c) => {
    return retentionGET(c.req.raw);
  });

  app.get(JUNIOR_AUTO_ARCHIVE_ROUTE, (c) => {
    return autoArchiveGET(c.req.raw);
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
