/** Plugin tools for one Turn. */
import {
  missingToolAnnotationKeys,
  type PluginSandbox,
  type PluginRegistration,
  type PluginToolDefinition,
  type SlackToolRegistrationHookContext,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { resolveWorkOwner } from "@/chat/conversations/work-owner";
import { getDb } from "@/chat/db";
import { replaceSlackMentions } from "@/chat/identities/slack-mention-text";
import { userLookupIdentityProviders } from "@/chat/identities/lookup-providers";
import { findLinkedHandle } from "@/chat/identities/user-lookup";
import { parseSlackTeamId } from "@/chat/slack/ids";
import { resolveUserTimezone } from "@/chat/identities/timezone";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { annotateToolResult } from "@/chat/conversations/annotation-results";
import { createPluginConversations } from "@/chat/conversations/plugin-search";
import { recordToolReply } from "@/chat/conversations/tool-replies";
import { logWarn } from "@/chat/logging";
import { createPluginModelCostRecorder } from "@/chat/plugins/model-cost";
import {
  basePluginContext,
  createSandboxCapability,
} from "@/chat/plugins/hook-context";
import {
  createPluginDecider,
  createPluginEmbedder,
  createPluginModel,
} from "@/chat/plugins/model";
import { createPluginState } from "@/chat/plugins/state";
import type {
  AnyToolDefinition,
  ToolExecuteOptions,
} from "@/chat/tool-support/definition";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { createPluginWatches } from "@/chat/plugins/watches";
import { getSlackToolContext } from "@/chat/slack/tool-support/context";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { createSlackDirectCredentialSubject } from "@/chat/credentials/subject";
import { resolveChannelCapabilities } from "@/chat/slack/tool-support/channel-capabilities";
import {
  getWorkspace,
  listWorkspaceNamesByRepository,
} from "@/chat/workspaces/store";
import { createPluginCodeChanges } from "@/chat/code/plugin-code-changes";
import { createPluginArtifacts } from "@/chat/plugins/artifacts";
import { pluginMcpContext } from "./context";
import { getRegistrations } from "./registry";

/** Convert manifest names into model-facing tool namespaces. */
function pluginToolNamespace(pluginName: string): string {
  const parts = pluginName.split("-").filter(Boolean);
  const [first = "plugin", ...rest] = parts;
  return `${first}${rest
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("")}`;
}

/**
 * Model-facing definitions of one plugin's tools, by host tool name. They
 * come from the plugin's `tools()` with no Turn.
 */
function pluginToolDefinitions(
  plugin: PluginRegistration,
): Record<string, AnyToolDefinition> {
  const hook = plugin.hooks?.tools;
  if (!hook) return {};
  const pluginName = plugin.manifest.name;
  const namespace = pluginToolNamespace(pluginName);
  const definitions: Record<string, AnyToolDefinition> = {};
  for (const [localName, definition] of Object.entries(hook())) {
    const execute = definition.execute;
    // Naming conventions belong in lint, not on the turn's critical path.
    definitions[`${namespace}_${localName}`] = {
      ...(definition as AnyToolDefinition),
      // Keep prototype methods and their receiver on class-instance tools.
      // `getPluginTools` passes the Turn context as the third argument.
      ...(execute
        ? {
            execute: execute.bind(definition) as AnyToolDefinition["execute"],
          }
        : undefined),
      approvalMode: definition.approvalMode ?? "auto",
      identity: {
        id: `${pluginName}.${localName}`,
        name: localName,
        plugin: pluginName,
      },
      source: { id: pluginName, description: plugin.manifest.description },
      exposure: definition.exposure ?? "deferred",
    };
  }
  return definitions;
}

/** Model-facing definitions of every plugin tool, with no Turn. */
export function getStaticPluginToolDefinitions(): Record<
  string,
  AnyToolDefinition
> {
  const definitions: Record<string, AnyToolDefinition> = {};
  for (const plugin of getRegistrations()) {
    Object.assign(definitions, pluginToolDefinitions(plugin));
  }
  return definitions;
}

/** Collect turn-scoped tools exposed by plugins. */
export function getPluginTools(
  context: ToolRuntimeContext,
  sandbox: PluginSandbox = createSandboxCapability(context.workspace),
): Record<string, AnyToolDefinition> {
  const tools: Record<string, AnyToolDefinition> = {};
  const artifacts = createPluginArtifacts(
    context.attachmentStorage,
    context.conversationId,
  );
  for (const plugin of getRegistrations()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.tools;
    if (!hook) {
      continue;
    }
    const slackToolContext = getSlackToolContext(context);
    const credentialSubject = slackToolContext
      ? createSlackDirectCredentialSubject({
          channelId: slackToolContext.locationChannelId,
          teamId: slackToolContext.teamId,
          userId: slackToolContext.actor?.userId,
        })
      : undefined;
    const dashboardConversationUrl = getDashboardConversationLink(
      context.conversationId,
    );
    const slackContext: SlackToolRegistrationHookContext | undefined =
      slackToolContext
        ? {
            channelCapabilities: resolveChannelCapabilities(
              slackToolContext.locationChannelId,
            ),
            ...(credentialSubject ? { credentialSubject } : undefined),
          }
        : undefined;
    const annotations = createPluginAnnotations({
      conversationId: context.conversationId,
      db: getDb(),
      plugin: pluginName,
    });
    const mcp = pluginMcpContext(plugin, context);
    const events = createPluginWatches(plugin, context.conversationId);
    const resolveActor =
      context.resolveActorIdentity ?? (async () => undefined);
    const onCost = createPluginModelCostRecorder({
      conversationId: context.conversationId,
      pluginName,
      source: "tool",
      ...(context.turnId ? { turnId: context.turnId } : undefined),
    });
    const common = {
      ...basePluginContext(plugin),
      annotations,
      codeChanges: createPluginCodeChanges(pluginName),
      resolveWorkOwner: async () =>
        await resolveWorkOwner({
          actor: context.actor,
          conversationId: context.conversationId,
          resolveActor,
        }),
      ...(artifacts ? { artifacts } : undefined),
      ...(dashboardConversationUrl
        ? { conversationLink: { url: dashboardConversationUrl } }
        : undefined),
      conversationId: context.conversationId,
      conversations: createPluginConversations(
        context.conversationId,
        pluginName,
      ),
      locationId: context.locationId,
      ...(slackContext ? { slack: slackContext } : undefined),
      userText: context.userText,
      decider: createPluginDecider(pluginName, { onCost }),
      embedder: createPluginEmbedder(pluginName, { onCost }),
      egress: context.egress,
      ...(mcp ? { mcp } : undefined),
      model: createPluginModel(pluginName, plugin.model, { onCost }),
      events,
      sandbox,
      state: createPluginState(pluginName),
      users: {
        resolveActor,
        async resolveTimezone() {
          const actor = context.actor;
          const resolved = await resolveActor();
          return await resolveUserTimezone({
            db: getDb(),
            nowMs: Date.now(),
            ...(actor?.platform === "slack"
              ? { slack: { teamId: actor.teamId, userId: actor.userId } }
              : undefined),
            ...(resolved?.user ? { userId: resolved.user.id } : undefined),
          });
        },
        replaceSlackMentions,
        async findLinkedHandle(query: string, provider: string) {
          const teamId =
            slackToolContext?.teamId ??
            (context.actor?.platform === "slack"
              ? parseSlackTeamId(context.actor.teamId)
              : undefined);
          // People are found through a Slack workspace's directory.
          if (!teamId) return { status: "not_found" } as const;
          return await findLinkedHandle({
            egress: context.egress,
            provider,
            providers: userLookupIdentityProviders(),
            query,
            teamId,
          });
        },
      },
      workspaces: {
        async active() {
          const id = context.workspaces?.activeWorkspaceId();
          if (!id) return undefined;
          const workspace = await getWorkspace(getDb(), id);
          return workspace ? { name: workspace.name } : {};
        },
        async findByRepository(input: { provider: string; repo: string }) {
          return await listWorkspaceNamesByRepository(getDb(), input);
        },
      },
    };
    let pluginContext: ToolRegistrationHookContext;
    switch (context.source.kind) {
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
      case "event":
      case "scheduled_automation":
      case "event_automation":
      case "plugin_dispatch":
      case "parent_message":
        pluginContext = {
          ...common,
          actor: context.actor,
          destination: context.destination,
          source: context.source,
        };
        break;
    }
    const definitions = pluginToolDefinitions(plugin);
    const namespace = pluginToolNamespace(pluginName);
    const disabled = plugin.hooks?.disabledTools?.(pluginContext) ?? {};
    for (const localName of Object.keys(disabled)) {
      if (!definitions[`${namespace}_${localName}`]) {
        throw new Error(
          `Plugin "${pluginName}" disabled unknown tool "${localName}"`,
        );
      }
    }
    for (const [name, definition] of Object.entries(definitions)) {
      const localName = definition.identity!.name;
      if (tools[name]) {
        throw new Error(
          `Duplicate plugin tool "${name}" from plugin "${pluginName}"`,
        );
      }
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
      const execute = definition.execute as
        | PluginToolDefinition["execute"]
        | undefined;
      const disabledReason = disabled[localName];
      tools[name] = {
        ...definition,
        ...(disabledReason ? { disabledReason } : undefined),
        ...(execute
          ? {
              execute: async (input: unknown, options: ToolExecuteOptions) =>
                annotateToolResult(
                  context.conversationId,
                  pluginName,
                  await recordToolReply({
                    conversationId: context.conversationId,
                    plugin: pluginName,
                    result: await execute(input, options, pluginContext),
                    toolCallId: options.toolCallId,
                  }),
                  { readOnly: definition.annotations?.readOnlyHint === true },
                ),
            }
          : undefined),
      };
    }
  }
  return tools;
}
