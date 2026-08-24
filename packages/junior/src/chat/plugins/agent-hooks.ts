import {
  missingToolAnnotationKeys,
  normalizeResourceEventIdentifier,
  pluginResourceEventsSchema,
  promptContextSchema,
  promptMessageSchema,
  resourceEventInputSchema,
} from "@sentry/junior-plugin-api";
import type {
  InvocationContext,
  PluginMcp,
  PluginReadState,
  PluginRoute,
  PluginRouteMethod,
  PluginSandbox,
  PluginOperationalReport,
  PluginOperationalReportContent,
  PluginOperationalTone,
  PluginRouteApp,
  ResourceEvent,
  SlackConversationLink,
  PluginRegistration,
  SlackToolRegistrationHookContext,
  ToolRegistrationHookContext,
  User,
  UserPromptContext,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { createPluginConversationEvents } from "@/chat/plugins/conversation-events";
import { createPluginConversationEventStats } from "@/chat/plugins/conversation-event-stats";
import { logInfo, logWarn } from "@/chat/logging";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginEmbedder, createPluginModel } from "@/chat/plugins/model";
import type { PluginPromptContributionContext } from "@/chat/plugins/prompt";
import { createPluginState } from "@/chat/plugins/state";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import { runNonInteractiveCommand } from "@/chat/sandbox/noninteractive-command";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import { getDashboardConversationLink } from "@/chat/slack/dashboard-link";
import { canRouteResourceEvents } from "@/chat/resource-events/workspace";
import { createResourceEventSubscription } from "@/chat/resource-events/store";
import { RESOURCE_SUBSCRIPTION_DEFAULT_TTL_MS } from "@/chat/resource-events/tool-support";
import { getSlackToolContext } from "@/chat/slack/tool-support/context";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import type {
  SandboxCommandInput,
  SandboxWorkspace,
} from "@/chat/sandbox/workspace";
import { createSlackDirectCredentialSubject } from "@/chat/credentials/subject";
import { resolveChannelCapabilities } from "@/chat/slack/tool-support/channel-capabilities";
import type { Actor } from "@/chat/actor";
import { z } from "zod";
import { workspaceRepoCheckoutPath } from "@/chat/workspaces/checkout-path";
import { listWorkspaceNamesByRepository } from "@/chat/workspaces/store";
import { createCodeChangePublisher } from "@/chat/code/publisher";

/** Signal that a plugin intentionally denied a tool execution. */
export class PluginHookDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginHookDeniedError";
  }
}

export interface ToolHookInput {
  input: Record<string, unknown>;
  name: string;
}

export interface ToolHookResult {
  /** Hook-injected environment values applied only during execution. */
  env: Record<string, string>;
  /** Hook-adjusted semantic tool input, including any schema-defined `env`. */
  input: Record<string, unknown>;
}

export interface PluginRouteRegistration extends PluginRoute {
  pluginName: string;
}

export interface PluginApiRouteRegistration {
  app: PluginRouteApp;
  pluginName: string;
}

export interface AfterMcpToolHookInput {
  arguments: Record<string, unknown>;
  conversationId?: string;
  provider: string;
  structuredContent?: unknown;
  toolName: string;
}

export interface PluginHookRunner {
  afterMcpTool(input: AfterMcpToolHookInput): Promise<void>;
  beforeToolExecute(input: ToolHookInput): Promise<ToolHookResult>;
  prepareSandbox(workspace: SandboxWorkspace): Promise<void>;
  prepareWorkspace(
    workspace: SandboxWorkspace,
    repos: Array<{
      provider: string;
      repo: string;
    }>,
    signal?: AbortSignal,
  ): Promise<void>;
}

let registeredPlugins: PluginRegistration[] = [];
const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PLUGIN_TOOL_NAME_RE = /^[a-z][A-Za-z0-9]*$/;
const OPERATIONAL_REPORT_MAX_METRICS = 8;
const OPERATIONAL_REPORT_MAX_WIDGETS = 12;
const OPERATIONAL_REPORT_MAX_CHART_SERIES = 8;
const OPERATIONAL_REPORT_MAX_CHART_CATEGORIES = 100;
const OPERATIONAL_REPORT_MAX_RECORD_SETS = 8;
const OPERATIONAL_REPORT_MAX_FIELDS = 8;
const OPERATIONAL_REPORT_MAX_RECORDS = 25;
const OPERATIONAL_REPORT_MAX_LABEL_LENGTH = 80;
const OPERATIONAL_REPORT_MAX_VALUE_LENGTH = 160;
const PLUGIN_ROUTE_METHODS = new Set<PluginRouteMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
]);
const PLUGIN_PROMPT_CONTRIBUTION_TOTAL_MAX_CHARS = 16_000;
const PLUGIN_PROMPT_CONTEXT_MAX_BYTES = 8_000;
const PLUGIN_PROMPT_CONTEXT_TOTAL_MAX_BYTES = 16_000;
const systemPromptMessageArraySchema = z.array(promptMessageSchema);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function basePluginContext(plugin: PluginRegistration) {
  const name = plugin.manifest.name;
  return {
    plugin: { name },
    log: createPluginLogger(name),
    db: getDb(),
  };
}

/** Convert manifest names into model-facing tool namespaces. */
function pluginToolNamespace(pluginName: string): string {
  const parts = pluginName.split("-").filter(Boolean);
  const [first = "plugin", ...rest] = parts;
  return `${first}${rest
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("")}`;
}

function systemPromptPluginContext(plugin: PluginRegistration) {
  return {
    ...basePluginContext(plugin),
  };
}

/** Bind Source, Destination, and Actor for one plugin invocation. */
function pluginInvocationContext(
  context: Pick<
    ToolRuntimeContext,
    "conversationId" | "locationId" | "destination" | "actor" | "source"
  >,
): InvocationContext {
  const common = {
    conversationId: context.conversationId,
    locationId: context.locationId,
  };
  switch (context.source.platform) {
    case "slack": {
      if (context.destination.platform !== "slack") {
        throw new TypeError("Slack plugin context requires Slack destination");
      }
      return {
        ...common,
        actor: context.actor?.platform === "slack" ? context.actor : undefined,
        destination: context.destination,
        source: context.source,
      };
    }
    case "local": {
      if (context.destination.platform !== "local") {
        throw new TypeError("Local plugin context requires local destination");
      }
      return {
        ...common,
        actor: context.actor?.platform === "local" ? context.actor : undefined,
        destination: context.destination,
        source: context.source,
      };
    }
    case "web":
      return {
        ...common,
        actor: context.actor?.platform === "web" ? context.actor : undefined,
        destination: context.destination,
        source: context.source,
      };
  }
}

function invocationPluginContext(
  plugin: PluginRegistration,
  context: Pick<
    ToolRuntimeContext,
    | "conversationId"
    | "locationId"
    | "destination"
    | "actor"
    | "resolveActorIdentity"
    | "source"
    | "userText"
  >,
  turnId?: string,
): UserPromptContext {
  const base = basePluginContext(plugin);
  const common = {
    ...base,
    conversationId: context.conversationId,
    locationId: context.locationId,
    embedder: createPluginEmbedder(plugin.manifest.name),
    ...(context.conversationId && turnId
      ? {
          events: createPluginConversationEvents({
            conversationId: context.conversationId,
            operationId: `user-prompt:${turnId}`,
            plugin,
            turnId,
          }),
        }
      : undefined),
    model: createPluginModel(plugin.manifest.name, plugin.model),
    source: context.source,
    text: context.userText ?? "",
    state: createPluginState(plugin.manifest.name),
    users: {
      resolveActor: context.resolveActorIdentity ?? (async () => undefined),
    },
  };
  return {
    ...common,
    ...pluginInvocationContext(context),
  };
}

function pluginMcpContext(
  plugin: PluginRegistration,
  context: ToolRuntimeContext,
): PluginMcp | undefined {
  const manager = context.mcpToolManager;
  const wrappedTools = new Set(plugin.manifest.mcp?.wrappedTools ?? []);
  if (!manager || wrappedTools.size === 0) {
    return undefined;
  }
  const provider = plugin.manifest.name;
  const prepare: PluginMcp["prepare"] = async () => {
    await manager.activateProvider(provider);
    return manager.getActiveProviders().includes(provider)
      ? "ready"
      : "authorization_pending";
  };
  return {
    prepare,
    async callTool(input) {
      if ((await prepare()) === "authorization_pending") {
        return { status: "authorization_pending" };
      }
      return await manager.callWrappedTool(
        provider,
        input.name,
        input.arguments ?? {},
        input.toolCallId ? { toolCallId: input.toolCallId } : undefined,
      );
    },
  };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPromptContributionContext(args: {
  hookName: "systemPrompt" | "userPrompt";
  index: number;
  message: z.output<typeof promptMessageSchema>;
  pluginName: string;
}): PluginPromptContributionContext {
  return {
    id: `${args.hookName}:${args.index}`,
    pluginName: args.pluginName,
    text: args.message.text,
  };
}

function normalizePromptContext(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > PLUGIN_PROMPT_CONTEXT_MAX_BYTES
  ) {
    throw new TypeError("Plugin prompt context exceeded its serialized budget");
  }
  const parsed = JSON.parse(serialized);
  if (!isRecord(parsed)) {
    throw new TypeError("Plugin prompt context must be a JSON object");
  }
  return parsed;
}

function toUserPromptContributionContext(args: {
  index: number;
  pluginName: string;
  value: unknown;
}): PluginPromptContributionContext | undefined {
  const message = promptMessageSchema.safeParse(args.value);
  if (message.success) {
    return toPromptContributionContext({
      hookName: "userPrompt",
      index: args.index,
      message: message.data,
      pluginName: args.pluginName,
    });
  }
  if (!isRecord(args.value) || typeof args.value.renderPrompt !== "function") {
    return undefined;
  }
  const context = promptContextSchema.safeParse(args.value.context);
  if (!context.success) {
    return undefined;
  }
  const text = promptMessageSchema.safeParse({
    text: args.value.renderPrompt(),
  });
  if (!text.success) {
    return undefined;
  }
  return {
    id: `userPrompt:${args.index}`,
    pluginName: args.pluginName,
    text: text.data.text,
    context: {
      content: normalizePromptContext(context.data.content),
      kind: context.data.kind,
      loadedAtMs: Date.now(),
      pluginName: args.pluginName,
      version: context.data.version,
    },
  };
}

function logInvalidPromptContributions(args: {
  hookName: "systemPrompt" | "userPrompt";
  pluginName: string;
}): void {
  logWarn("plugin.prompt.contribution_result.invalid", {
    "app.plugin.hook": args.hookName,
    "app.plugin.name": args.pluginName,
    "app.plugin.validation_reason": "invalid_shape",
  });
}

/** Validate plugin identity before it can affect process-wide hooks. */
export function validatePlugins(plugins: PluginRegistration[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const name = plugin.manifest.name;
    if (!PLUGIN_NAME_RE.test(name)) {
      throw new Error(
        `Plugin name "${name}" must be a lowercase plugin identifier`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate plugin name "${name}"`);
    }
    if (
      plugin.resourceEvents !== undefined &&
      !pluginResourceEventsSchema.safeParse(plugin.resourceEvents).success
    ) {
      throw new Error(`Plugin "${name}" resourceEvents is invalid`);
    }
    for (const [taskName, task] of Object.entries(plugin.tasks ?? {})) {
      if (!PLUGIN_TOOL_NAME_RE.test(taskName)) {
        throw new Error(
          `Plugin task "${taskName}" from plugin "${name}" must be a camelCase identifier`,
        );
      }
      if (typeof task.run !== "function") {
        throw new Error(
          `Plugin task "${taskName}" from plugin "${name}" must define a run function`,
        );
      }
    }
    seen.add(name);
  }
}

/** Replace runtime hook plugins and return the previous list for rollback. */
export function setPlugins(
  nextPlugins: PluginRegistration[],
): PluginRegistration[] {
  validatePlugins(nextPlugins);
  const previous = registeredPlugins;
  registeredPlugins = [...nextPlugins].sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  );
  return previous;
}

/** Return the current runtime hook plugins without exposing mutable state. */
export function getPlugins(): PluginRegistration[] {
  return [...registeredPlugins];
}

/** Apply plugin Markdown rewrites before destination delivery formatting. */
export function applyPluginFormatMarkdown(text: string): string {
  let transformed = text;
  for (const plugin of getPlugins()) {
    const hook = plugin.hooks?.formatMarkdown;
    if (!hook) {
      continue;
    }
    try {
      const next = hook({ text: transformed });
      if (typeof next === "string") {
        transformed = next;
      }
    } catch (error) {
      // Fail open: reply delivery must not depend on optional provider formatting.
      logWarn("plugin.format_markdown.hook.failed", {
        "app.plugin.name": plugin.manifest.name,
        "exception.message": safeErrorMessage(error),
      });
    }
  }
  return transformed;
}

/** Collect stable plugin prompt contributions for the static system prompt. */
export async function getPluginSystemPromptContributions(
  source: ToolRuntimeContext["source"],
): Promise<PluginPromptContributionContext[]> {
  const contributions: PluginPromptContributionContext[] = [];
  let totalChars = 0;
  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.systemPrompt;
    if (!hook) {
      continue;
    }
    try {
      const pluginContributions = await hook({
        ...systemPromptPluginContext(plugin),
        // Plugin system prompts only distinguish Slack vs non-Slack surfaces.
        platform: source.platform === "slack" ? "slack" : "local",
      });
      const result =
        systemPromptMessageArraySchema.safeParse(pluginContributions);
      if (!result.success) {
        logInvalidPromptContributions({
          hookName: "systemPrompt",
          pluginName,
        });
        continue;
      }
      const acceptedContributions = result.data.map((message, index) =>
        toPromptContributionContext({
          hookName: "systemPrompt",
          index,
          message,
          pluginName,
        }),
      );
      const pluginContributionChars = acceptedContributions.reduce(
        (sum, contribution) => sum + contribution.text.length,
        0,
      );
      if (
        totalChars + pluginContributionChars >
        PLUGIN_PROMPT_CONTRIBUTION_TOTAL_MAX_CHARS
      ) {
        logWarn("plugin.system_prompt.contribution_budget_exceeded", {
          "app.plugin.name": pluginName,
        });
        continue;
      }
      totalChars += pluginContributionChars;
      contributions.push(...acceptedContributions);
    } catch (error) {
      logWarn("plugin.system_prompt.hook.failed", {
        "app.plugin.name": pluginName,
        "exception.message": safeErrorMessage(error),
      });
    }
  }
  return contributions;
}

/** Collect request-scoped plugin prompt contributions. */
export async function getPluginUserPromptContributions(args: {
  context: Pick<
    ToolRuntimeContext,
    | "conversationId"
    | "locationId"
    | "destination"
    | "actor"
    | "resolveActorIdentity"
    | "source"
    | "userText"
  >;
  turnId?: string;
}): Promise<PluginPromptContributionContext[]> {
  const contributions: PluginPromptContributionContext[] = [];
  let totalChars = 0;
  let totalContextBytes = 0;
  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.userPrompt;
    if (!hook) {
      continue;
    }
    try {
      const rawResult = await hook({
        ...invocationPluginContext(plugin, args.context, args.turnId),
      });
      if (rawResult === undefined) {
        continue;
      }
      if (!Array.isArray(rawResult)) {
        logInvalidPromptContributions({
          hookName: "userPrompt",
          pluginName,
        });
        continue;
      }

      const acceptedContributions = rawResult.map((value, index) =>
        toUserPromptContributionContext({ index, pluginName, value }),
      );
      if (acceptedContributions.some((contribution) => !contribution)) {
        logInvalidPromptContributions({
          hookName: "userPrompt",
          pluginName,
        });
        continue;
      }
      const validContributions = acceptedContributions.filter(
        (contribution): contribution is PluginPromptContributionContext =>
          contribution !== undefined,
      );
      const pluginContributionChars = validContributions.reduce(
        (sum, contribution) => sum + contribution.text.length,
        0,
      );
      const pluginContextBytes = validContributions.reduce(
        (sum, contribution) =>
          sum +
          (contribution.context
            ? Buffer.byteLength(
                JSON.stringify(contribution.context.content),
                "utf8",
              )
            : 0),
        0,
      );
      if (
        totalChars + pluginContributionChars >
          PLUGIN_PROMPT_CONTRIBUTION_TOTAL_MAX_CHARS ||
        totalContextBytes + pluginContextBytes >
          PLUGIN_PROMPT_CONTEXT_TOTAL_MAX_BYTES
      ) {
        logWarn("plugin.user_prompt.contribution_budget_exceeded", {
          "app.plugin.name": pluginName,
        });
        continue;
      }
      totalChars += pluginContributionChars;
      totalContextBytes += pluginContextBytes;
      contributions.push(...validContributions);
    } catch (error) {
      logWarn("plugin.user_prompt.hook.failed", {
        "app.plugin.name": pluginName,
        "exception.message": safeErrorMessage(error),
      });
    }
  }
  return contributions;
}

/** Collect turn-scoped tools exposed by plugins. */
export function getPluginTools(
  context: ToolRuntimeContext,
  sandbox: PluginSandbox = createSandboxCapability(context.workspace),
): Record<string, AnyToolDefinition> {
  const tools: Record<string, AnyToolDefinition> = {};
  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.tools;
    if (!hook) {
      continue;
    }
    const slackToolContext = getSlackToolContext(context);
    const credentialSubject = slackToolContext
      ? createSlackDirectCredentialSubject({
          channelId: slackToolContext.sourceChannelId,
          teamId: slackToolContext.teamId,
          userId: slackToolContext.actor?.userId,
        })
      : undefined;
    const dashboardConversationUrl = context.conversationId
      ? getDashboardConversationLink(context.conversationId)
      : undefined;
    const slackContext: SlackToolRegistrationHookContext | undefined =
      slackToolContext
        ? {
            channelCapabilities: resolveChannelCapabilities(
              slackToolContext.sourceChannelId,
            ),
            ...(dashboardConversationUrl
              ? { conversationLink: { url: dashboardConversationUrl } }
              : undefined),
            ...(credentialSubject ? { credentialSubject } : undefined),
          }
        : undefined;
    const annotations = context.conversationId
      ? createPluginAnnotations({
          conversationId: context.conversationId,
          db: getDb(),
          plugin: pluginName,
        })
      : undefined;
    const mcp = pluginMcpContext(plugin, context);
    const canSubscribe =
      context.source.platform === "slack" &&
      context.destination.platform === "slack" &&
      Boolean(context.conversationId) &&
      canRouteResourceEvents() &&
      Boolean(plugin.resourceEvents) &&
      plugin.resourceEvents?.isEnabled?.() !== false;
    const resourceEvents: ToolRegistrationHookContext["resourceEvents"] = {
      canSubscribe,
      async subscribe(input) {
        if (!canSubscribe || context.destination.platform !== "slack") {
          throw new Error(
            "Resource subscriptions are not available in this conversation.",
          );
        }
        const registration = plugin.resourceEvents;
        const resourceType = registration?.resourceTypes.find(
          (candidate) => candidate.type === input.resource.type,
        );
        if (
          input.resource.namespace !== pluginName ||
          !resourceType ||
          input.events.length === 0 ||
          input.events.some(
            (eventType) => !resourceType.supportedEvents.includes(eventType),
          )
        ) {
          throw new Error(
            "Resource subscription contains an event or resource that the plugin does not support.",
          );
        }
        const subscription = await createResourceEventSubscription({
          conversationId: context.conversationId!,
          destination: context.destination,
          events: input.events,
          expiresAtMs: Date.now() + RESOURCE_SUBSCRIPTION_DEFAULT_TTL_MS,
          intent: input.intent,
          label: input.resource.label,
          namespace: pluginName,
          identifier: normalizeResourceEventIdentifier(
            registration,
            input.resource.identifier,
          ),
          resourceType: input.resource.type,
        });
        return {
          events: subscription.events,
          id: subscription.id,
        };
      },
    };
    const resolveActor =
      context.resolveActorIdentity ?? (async () => undefined);
    const common = {
      ...basePluginContext(plugin),
      ...(annotations ? { annotations } : undefined),
      conversationId: context.conversationId,
      locationId: context.locationId,
      userText: context.userText,
      embedder: createPluginEmbedder(pluginName),
      egress: context.egress,
      ...(mcp ? { mcp } : undefined),
      model: createPluginModel(pluginName, plugin.model),
      resourceEvents,
      sandbox,
      state: createPluginState(pluginName),
      users: { resolveActor },
      workspaces: {
        async findByRepository(input: { provider: string; repo: string }) {
          return await listWorkspaceNamesByRepository(getDb(), input);
        },
      },
    };
    let pluginContext: ToolRegistrationHookContext;
    switch (context.source.platform) {
      case "slack":
        if (context.destination.platform !== "slack") {
          throw new TypeError(
            "Slack plugin context requires Slack destination",
          );
        }
        pluginContext = {
          ...common,
          actor:
            context.actor?.platform === "slack" ? context.actor : undefined,
          destination: context.destination,
          slack: slackContext!,
          source: context.source,
        };
        break;
      case "local":
        if (context.destination.platform !== "local") {
          throw new TypeError(
            "Local plugin context requires local destination",
          );
        }
        pluginContext = {
          ...common,
          actor:
            context.actor?.platform === "local" ? context.actor : undefined,
          destination: context.destination,
          source: context.source,
        };
        break;
      case "web":
        pluginContext = {
          ...common,
          actor: context.actor?.platform === "web" ? context.actor : undefined,
          destination: context.destination,
          source: context.source,
        };
        break;
    }
    const pluginTools = hook(pluginContext);
    const namespace = pluginToolNamespace(pluginName);
    for (const [localName, tool] of Object.entries(pluginTools)) {
      if (!PLUGIN_TOOL_NAME_RE.test(localName)) {
        throw new Error(
          `Plugin tool "${localName}" from plugin "${pluginName}" must be a camelCase identifier`,
        );
      }
      const name = `${namespace}_${localName}`;
      if (tools[name]) {
        throw new Error(
          `Duplicate plugin tool "${name}" from plugin "${pluginName}"`,
        );
      }
      const definition = tool as AnyToolDefinition;
      const missingAnnotationKeys = missingToolAnnotationKeys(
        definition.annotations,
      );
      if (missingAnnotationKeys.length > 0) {
        logWarn("plugin.tool_annotations.missing", {
          "app.plugin.name": pluginName,
          "gen_ai.tool.name": localName,
          "app.tool.missing_annotations": missingAnnotationKeys.join(","),
        });
      }
      definition.approvalMode ??= "auto";
      definition.identity = {
        id: `${pluginName}.${localName}`,
        name: localName,
        plugin: pluginName,
      };
      definition.source = {
        id: pluginName,
        description: plugin.manifest.description,
      };
      definition.exposure = "deferred";
      tools[name] = definition;
    }
  }
  return tools;
}

/** Normalize route methods so JS plugins cannot register invalid verbs. */
function routeMethods(
  route: PluginRoute,
  pluginName: string,
): PluginRouteMethod[] {
  const methods = Array.isArray(route.method)
    ? route.method
    : [route.method ?? "ALL"];
  if (methods.length === 0) {
    throw new Error(
      `Plugin route "${route.path}" from plugin "${pluginName}" must declare at least one method`,
    );
  }

  for (const method of methods) {
    if (!PLUGIN_ROUTE_METHODS.has(method)) {
      throw new Error(
        `Plugin route "${route.path}" from plugin "${pluginName}" has invalid method "${String(method)}"`,
      );
    }
  }
  if (methods.includes("ALL") && methods.length > 1) {
    throw new Error(
      `Plugin route "${route.path}" from plugin "${pluginName}" must not combine ALL with explicit methods`,
    );
  }
  return methods;
}

function requirePublishedResourceEvent(
  plugin: PluginRegistration,
  eventType: string,
): void {
  const registration = plugin.resourceEvents;
  if (!registration || registration.isEnabled?.() === false) {
    throw new Error(
      `Plugin "${plugin.manifest.name}" cannot publish resource events without an active registration`,
    );
  }
  if (
    !registration.resourceTypes.some((resourceType) =>
      resourceType.supportedEvents.includes(eventType),
    )
  ) {
    throw new Error(
      `Plugin "${plugin.manifest.name}" did not register resource event "${eventType}"`,
    );
  }
}

/** Collect route handlers exposed by plugins for app-level mounting. */
export function getPluginRoutes(options: {
  resourceEvents: { publish(event: ResourceEvent): Promise<void> };
}): PluginRouteRegistration[] {
  const routes: PluginRouteRegistration[] = [];
  const seen = new Set<string>();
  const methodsByPath = new Map<string, Set<PluginRouteMethod>>();

  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.routes;
    if (!hook) {
      continue;
    }
    const pluginRoutes = hook({
      ...basePluginContext(plugin),
      annotations: {
        forConversation: (conversationId) =>
          createPluginAnnotations({
            conversationId,
            db: getDb(),
            plugin: pluginName,
          }),
      },
      codeChanges: createCodeChangePublisher(pluginName),
      resourceEvents: {
        async publish(event) {
          const parsed = resourceEventInputSchema.parse(event);
          requirePublishedResourceEvent(plugin, parsed.eventType);
          await options.resourceEvents.publish({
            ...parsed,
            identifier: normalizeResourceEventIdentifier(
              plugin.resourceEvents,
              parsed.identifier,
            ),
            namespace: pluginName,
          });
        },
      },
    });
    if (!Array.isArray(pluginRoutes)) {
      throw new Error(
        `Plugin routes hook from plugin "${pluginName}" must return an array`,
      );
    }
    for (const route of pluginRoutes) {
      if (!isRecord(route)) {
        throw new Error(
          `Plugin route from plugin "${pluginName}" must be an object`,
        );
      }
      if (typeof route.path !== "string" || !route.path.startsWith("/")) {
        throw new Error(
          `Plugin route "${route.path}" from plugin "${pluginName}" must start with /`,
        );
      }
      if (typeof route.handler !== "function") {
        throw new Error(
          `Plugin route "${route.path}" from plugin "${pluginName}" must provide a handler`,
        );
      }
      const methods = routeMethods(route, pluginName);
      const pathMethods = methodsByPath.get(route.path) ?? new Set();
      if (
        pathMethods.has("ALL") ||
        (methods.includes("ALL") && pathMethods.size > 0)
      ) {
        throw new Error(
          `Plugin route "${route.path}" conflicts with an ALL route for the same path`,
        );
      }
      for (const method of methods) {
        const key = `${method}:${route.path}`;
        if (seen.has(key)) {
          throw new Error(`Duplicate plugin route "${method} ${route.path}"`);
        }
        seen.add(key);
        pathMethods.add(method);
      }
      methodsByPath.set(route.path, pathMethods);
      routes.push({
        ...route,
        pluginName,
      });
    }
  }

  return routes;
}

/** Collect authenticated product API route apps exposed by plugins. */
export function getPluginApiRoutes(): PluginApiRouteRegistration[] {
  const routes: PluginApiRouteRegistration[] = [];

  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.apiRoutes;
    if (!hook) {
      continue;
    }
    const app = hook({
      ...basePluginContext(plugin),
      eventStats: createPluginConversationEventStats(plugin),
      users: { resolve: resolveViewerUser },
    });
    if (app === undefined) {
      continue;
    }
    if (!isRecord(app) || typeof app.fetch !== "function") {
      throw new Error(
        `Plugin apiRoutes hook from plugin "${pluginName}" must return a fetch-compatible app`,
      );
    }
    routes.push({ app, pluginName });
  }

  return routes;
}

/** Return only absolute HTTP(S) URLs that Slack can render as footer links. */
function trustedSlackConversationUrl(
  pluginName: string,
  link: SlackConversationLink | undefined,
): string | undefined {
  const url = typeof link?.url === "string" ? link.url.trim() : "";
  if (!url) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(
      `Plugin "${pluginName}" slackConversationLink must return an absolute http(s) URL`,
      { cause: error },
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Plugin "${pluginName}" slackConversationLink must return an absolute http(s) URL`,
    );
  }
  return parsed.toString();
}

/** Resolve the first plugin conversation URL for finalized Slack footers. */
export function getPluginSlackConversationLink(
  conversationId: string,
): SlackConversationLink | undefined {
  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.slackConversationLink;
    if (!hook) {
      continue;
    }
    const link = hook({
      ...basePluginContext(plugin),
      conversationId,
    });
    const url = trustedSlackConversationUrl(pluginName, link);
    if (url) {
      return { url };
    }
  }
  return undefined;
}

function pluginReadState(state: { get: PluginReadState["get"] }) {
  return {
    get: state.get,
  } satisfies PluginReadState;
}

function operationalReportText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

function operationalReportTone(
  tone: PluginOperationalTone | undefined,
): PluginOperationalTone | undefined {
  return tone === "danger" ||
    tone === "good" ||
    tone === "neutral" ||
    tone === "warning"
    ? tone
    : undefined;
}

function sanitizeOperationalReport(args: {
  pluginName: string;
  report: PluginOperationalReportContent;
}): PluginOperationalReport {
  const metrics = args.report.metrics
    ?.slice(0, OPERATIONAL_REPORT_MAX_METRICS)
    .map((metric) => {
      const label = operationalReportText(
        metric.label,
        OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
      );
      const value = operationalReportText(
        metric.value,
        OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
      );
      if (!label || !value) {
        return undefined;
      }
      const sanitizedMetric: NonNullable<
        PluginOperationalReport["metrics"]
      >[number] = { label, value };
      const tone = operationalReportTone(metric.tone);
      if (tone) {
        sanitizedMetric.tone = tone;
      }
      return sanitizedMetric;
    })
    .filter((metric): metric is NonNullable<typeof metric> => Boolean(metric));
  const recordSets = args.report.recordSets
    ?.slice(0, OPERATIONAL_REPORT_MAX_RECORD_SETS)
    .map((recordSet, recordSetIndex) => {
      const title = operationalReportText(
        recordSet.title,
        OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
      );
      if (!title) {
        return undefined;
      }
      const fields = recordSet.fields
        ?.slice(0, OPERATIONAL_REPORT_MAX_FIELDS)
        .map((field) => {
          const key = operationalReportText(
            field.key,
            OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
          );
          const label = operationalReportText(
            field.label,
            OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
          );
          return key && label ? { key, label } : undefined;
        })
        .filter((field): field is NonNullable<typeof field> => Boolean(field));
      const records = recordSet.records
        ?.slice(0, OPERATIONAL_REPORT_MAX_RECORDS)
        .map((record, recordIndex) => {
          const id =
            operationalReportText(
              record.id,
              OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
            ) ?? `${recordSetIndex}:${recordIndex}`;
          const values = Object.fromEntries(
            (fields ?? []).map((field) => [
              field.key,
              operationalReportText(
                record.values[field.key],
                OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
              ) ?? "",
            ]),
          );
          const sanitizedRecord: NonNullable<
            NonNullable<
              PluginOperationalReport["recordSets"]
            >[number]["records"]
          >[number] = {
            id,
            values,
          };
          const tone = operationalReportTone(record.tone);
          if (tone) {
            sanitizedRecord.tone = tone;
          }
          return sanitizedRecord;
        });
      const sanitizedRecordSet: NonNullable<
        PluginOperationalReport["recordSets"]
      >[number] = { title };
      if (fields?.length) {
        sanitizedRecordSet.fields = fields;
      }
      const emptyText = operationalReportText(
        recordSet.emptyText,
        OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
      );
      if (emptyText) {
        sanitizedRecordSet.emptyText = emptyText;
      }
      if (records?.length) {
        sanitizedRecordSet.records = records;
      }
      return sanitizedRecordSet;
    })
    .filter((recordSet): recordSet is NonNullable<typeof recordSet> =>
      Boolean(recordSet),
    );
  const widgets = args.report.widgets
    ?.slice(0, OPERATIONAL_REPORT_MAX_WIDGETS)
    .map((widget, widgetIndex) => {
      const id =
        operationalReportText(widget.id, OPERATIONAL_REPORT_MAX_LABEL_LENGTH) ??
        String(widgetIndex);
      const title = operationalReportText(
        widget.title,
        OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
      );
      if (!title) {
        return undefined;
      }
      const seriesEntries = widget.series
        .slice(0, OPERATIONAL_REPORT_MAX_CHART_SERIES)
        .map((item) => {
          const key = operationalReportText(
            item.key,
            OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
          );
          const label = operationalReportText(
            item.label,
            OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
          );
          if (!key || !label) {
            return undefined;
          }
          const sanitizedSeries: NonNullable<
            PluginOperationalReport["widgets"]
          >[number]["series"][number] = { key, label };
          if (item.format === "usd") {
            sanitizedSeries.format = "usd";
          }
          const tone = operationalReportTone(item.tone);
          if (tone) {
            sanitizedSeries.tone = tone;
          }
          return { sanitizedSeries, sourceKey: item.key };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      if (!seriesEntries.length) {
        return undefined;
      }
      const series = seriesEntries.map((item) => item.sanitizedSeries);
      const categories = widget.categories
        .slice(-OPERATIONAL_REPORT_MAX_CHART_CATEGORIES)
        .map((category, categoryIndex) => ({
          id:
            operationalReportText(
              category.id,
              OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
            ) ?? `${widgetIndex}:${categoryIndex}`,
          label:
            operationalReportText(
              category.label,
              OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
            ) ?? String(categoryIndex + 1),
          values: Object.fromEntries(
            seriesEntries.map(({ sanitizedSeries, sourceKey }) => [
              sanitizedSeries.key,
              Number.isFinite(category.values[sourceKey])
                ? category.values[sourceKey]
                : 0,
            ]),
          ),
        }));
      const sanitizedWidget: NonNullable<
        PluginOperationalReport["widgets"]
      >[number] = {
        categories,
        id,
        series,
        title,
        type: "bar_chart",
      };
      const description = operationalReportText(
        widget.description,
        OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
      );
      if (description) {
        sanitizedWidget.description = description;
      }
      const emptyText = operationalReportText(
        widget.emptyText,
        OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
      );
      if (emptyText) {
        sanitizedWidget.emptyText = emptyText;
      }
      const timeRangeDays = widget.timeRangeDays?.filter(
        (days): days is 7 | 30 | 90 => days === 7 || days === 30 || days === 90,
      );
      if (timeRangeDays?.length) {
        sanitizedWidget.timeRangeDays = [...new Set(timeRangeDays)];
      }
      return sanitizedWidget;
    })
    .filter((widget): widget is NonNullable<typeof widget> => Boolean(widget));

  const sanitized: PluginOperationalReport = {
    pluginName: args.pluginName,
  };
  const generatedAt = operationalReportText(
    args.report.generatedAt,
    OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
  );
  if (generatedAt) {
    sanitized.generatedAt = generatedAt;
  }
  if (recordSets?.length) {
    sanitized.recordSets = recordSets;
  }
  if (metrics?.length) {
    sanitized.metrics = metrics;
  }
  if (widgets?.length) {
    sanitized.widgets = widgets;
  }
  const title = operationalReportText(
    args.report.title,
    OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
  );
  if (title) {
    sanitized.title = title;
  }
  return sanitized;
}

function failedOperationalReport(args: {
  nowMs: number;
  pluginName: string;
}): PluginOperationalReport {
  return {
    generatedAt: new Date(args.nowMs).toISOString(),
    pluginName: args.pluginName,
    metrics: [{ label: "report", tone: "danger", value: "failed" }],
    title: args.pluginName,
    recordSets: [
      {
        emptyText: "This plugin report failed to load.",
        title: "Error",
      },
    ],
  };
}

/** Collect read-only operational summaries exposed by plugins. */
export async function getPluginOperationalReports(
  nowMs: number,
): Promise<PluginOperationalReport[]> {
  const reports: PluginOperationalReport[] = [];
  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.operationalReport;
    if (!hook) {
      continue;
    }
    try {
      const state = createPluginState(pluginName);
      const report = await hook({
        ...basePluginContext(plugin),
        eventStats: createPluginConversationEventStats(plugin, () => nowMs),
        nowMs,
        state: pluginReadState(state),
      });
      if (!report) {
        continue;
      }
      reports.push(
        sanitizeOperationalReport({
          pluginName,
          report,
        }),
      );
    } catch (error) {
      const log = createPluginLogger(pluginName);
      log.error("Plugin operational report failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      reports.push(failedOperationalReport({ nowMs, pluginName }));
    }
  }
  return reports;
}

/** Collect person-scoped plugin reports for one profile subject. */
export async function getPluginProfileReports(args: {
  nowMs: number;
  subject: User;
  viewer: User;
}): Promise<PluginOperationalReport[]> {
  const reports: PluginOperationalReport[] = [];
  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.profileReport;
    if (!hook) {
      continue;
    }
    try {
      const state = createPluginState(pluginName);
      const report = await hook({
        ...basePluginContext(plugin),
        nowMs: args.nowMs,
        state: pluginReadState(state),
        subject: args.subject,
        viewer: args.viewer,
      });
      if (!report) {
        continue;
      }
      reports.push(
        sanitizeOperationalReport({
          pluginName,
          report,
        }),
      );
    } catch (error) {
      const log = createPluginLogger(pluginName);
      log.error("Plugin profile report failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Keep profile usable when one plugin fails; skip the failed card.
    }
  }
  return reports;
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "string") {
      env[key] = rawValue;
    }
  }
  return env;
}

function preparationSignal(
  inputSignal?: AbortSignal,
  ownerSignal?: AbortSignal,
): AbortSignal | undefined {
  if (!inputSignal) return ownerSignal;
  if (!ownerSignal) return inputSignal;
  return AbortSignal.any([inputSignal, ownerSignal]);
}

function createSandboxCapability(
  workspace: SandboxWorkspace,
  ownerSignal?: AbortSignal,
): PluginSandbox {
  return {
    root: SANDBOX_WORKSPACE_ROOT,
    juniorRoot: `${SANDBOX_WORKSPACE_ROOT}/.junior`,
    async readFile(filePath) {
      return (await workspace.readFileToBuffer({ path: filePath })) ?? null;
    },
    async run(input: SandboxCommandInput) {
      const signal = preparationSignal(input.signal, ownerSignal);
      const result = await runNonInteractiveCommand(workspace, {
        ...input,
        ...(signal ? { signal } : undefined),
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    async writeFile(input) {
      await workspace.writeFiles([
        {
          path: input.path,
          content: input.content,
          ...(input.mode !== undefined ? { mode: input.mode } : undefined),
        },
      ]);
    },
  };
}

/** Create one runner over runtime hook plugins registered by the app. */
export function createPluginHookRunner(
  input: {
    actor?: Actor;
    /** Live getter for the run's committed instruction actors; see `multi-actor-runs.md`. */
    actors?: () => Actor[];
  } = {},
): PluginHookRunner {
  const loaded = getPlugins();

  return {
    async afterMcpTool(tool) {
      for (const plugin of loaded) {
        if (plugin.manifest.name !== tool.provider) {
          continue;
        }
        const hook = plugin.hooks?.afterMcpTool;
        if (!hook) {
          continue;
        }
        const annotations = tool.conversationId
          ? createPluginAnnotations({
              conversationId: tool.conversationId,
              db: getDb(),
              plugin: plugin.manifest.name,
            })
          : undefined;
        try {
          await hook({
            ...basePluginContext(plugin),
            ...(tool.conversationId
              ? { conversationId: tool.conversationId }
              : undefined),
            ...(annotations ? { annotations } : undefined),
            result:
              tool.structuredContent !== undefined
                ? { structuredContent: tool.structuredContent }
                : {},
            tool: {
              arguments: tool.arguments,
              name: tool.toolName,
            },
          });
        } catch (error) {
          logWarn("agent.plugin.after_mcp_tool.failed", {
            "app.plugin.name": plugin.manifest.name,
            "gen_ai.tool.name": tool.toolName,
            "exception.message":
              error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    async prepareWorkspace(sandbox, repos, signal) {
      const preparers = new Set(
        loaded
          .filter((plugin) => plugin.hooks?.workspacePrepare)
          .map((plugin) => plugin.manifest.name),
      );
      const unhandledProviders = [
        ...new Set(
          repos
            .map((repo) => repo.provider)
            .filter((provider) => !preparers.has(provider)),
        ),
      ].sort();
      if (unhandledProviders.length > 0) {
        throw new Error(
          `Workspace repository providers have no preparation hook: ${unhandledProviders.join(", ")}`,
        );
      }

      const selectedRepos = repos.map((repo) => ({
        provider: repo.provider,
        repo: repo.repo,
        path: workspaceRepoCheckoutPath(repo.repo),
      }));
      const paths = new Set<string>();
      for (const entry of selectedRepos) {
        const key = entry.path.toLowerCase();
        if (paths.has(key)) {
          throw new Error(`Workspace checkout path collision: ${entry.path}`);
        }
        paths.add(key);
      }

      const sandboxCapability = createSandboxCapability(sandbox, signal);
      for (const plugin of loaded) {
        const hook = plugin.hooks?.workspacePrepare;
        if (!hook) continue;
        const selected = selectedRepos
          .filter((repo) => repo.provider === plugin.manifest.name)
          .map((repo) => ({
            path: repo.path,
            repo: repo.repo,
          }));
        if (selected.length === 0) continue;
        await hook({
          ...basePluginContext(plugin),
          repos: selected,
          sandbox: sandboxCapability,
        });
      }
    },
    async prepareSandbox(sandbox) {
      const sandboxCapability = createSandboxCapability(sandbox);
      for (const plugin of loaded) {
        const pluginName = plugin.manifest.name;
        const hook = plugin.hooks?.sandboxPrepare;
        if (!hook) {
          continue;
        }
        logInfo("agent.plugin.sandbox_preparation.started", {
          "app.plugin.name": pluginName,
        });
        await hook({
          ...basePluginContext(plugin),
          actor: input.actor,
          sandbox: sandboxCapability,
        });
      }
    },
    async beforeToolExecute(tool) {
      const env: Record<string, string> = {};
      let nextInput = { ...tool.input };
      // Materialize once per tool call so every plugin sees the same
      // committed-so-far set, even though it can still grow before the next call.
      const actors = input.actors?.() ?? (input.actor ? [input.actor] : []);

      for (const plugin of loaded) {
        const pluginName = plugin.manifest.name;
        const hook = plugin.hooks?.beforeToolExecute;
        if (!hook) {
          continue;
        }
        let replacement: Record<string, unknown> | undefined;
        let denied: string | undefined;
        await hook({
          ...basePluginContext(plugin),
          actor: input.actor,
          actors,
          tool: {
            name: tool.name,
            input: nextInput,
          },
          env: {
            get(key) {
              return env[key] ?? normalizeEnv(nextInput.env)[key];
            },
            set(key, value) {
              env[key] = value;
            },
          },
          decision: {
            deny(message) {
              denied = message;
            },
            replaceInput(input) {
              replacement = input;
            },
          },
        });

        if (denied) {
          throw new PluginHookDeniedError(denied);
        }
        if (replacement !== undefined) {
          if (!isRecord(replacement)) {
            throw new Error(
              `Plugin "${pluginName}" replaced tool input with a non-object value`,
            );
          }
          nextInput = { ...replacement };
        }
      }

      return {
        input: nextInput,
        env,
      };
    },
  };
}
