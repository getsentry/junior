/** The context that plugin hooks get for one invocation. */
import type {
  InvocationContext,
  PluginMcp,
  PluginRegistration,
  UserPromptContext,
} from "@sentry/junior-plugin-api";
import { createPluginConversationEvents } from "@/chat/plugins/conversation-events";
import type { SetSpanAttributes } from "@/chat/logging";
import { createPluginModelCostRecorder } from "@/chat/plugins/model-cost";
import { basePluginContext } from "@/chat/plugins/hook-context";
import {
  createPluginEmbedder,
  createPluginModel,
  createPluginReranker,
} from "@/chat/plugins/model";
import { createPluginState } from "@/chat/plugins/state";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { loadPluginPromptHistory } from "@/chat/plugins/prompt-history";

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
  switch (context.source.kind) {
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
    case "event":
    case "scheduled_automation":
    case "event_automation":
    case "plugin_dispatch":
    case "parent_message":
      return {
        ...common,
        actor: context.actor,
        destination: context.destination,
        source: context.source,
      };
  }
}

/**
 * Let a plugin add numeric diagnostics to its hook span. Plugins own the
 * meaning of these attributes, so they stay in the plugin's `app.<name>.`
 * namespace and cannot overwrite host attributes or carry text.
 */
function pluginSpanAttributeSetter(
  pluginName: string,
  setSpanAttributes: SetSpanAttributes,
): UserPromptContext["setSpanAttributes"] {
  const prefix = `app.${pluginName}.`;
  return (attributes) => {
    const allowed = Object.fromEntries(
      Object.entries(attributes).filter(
        ([key, value]) =>
          key.length > prefix.length &&
          key.startsWith(prefix) &&
          typeof value === "number" &&
          Number.isFinite(value),
      ),
    );
    if (Object.keys(allowed).length > 0) {
      setSpanAttributes(allowed);
    }
  };
}

export function invocationPluginContext(
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
  setSpanAttributes: SetSpanAttributes,
  turnId?: string,
): UserPromptContext {
  const base = basePluginContext(plugin);
  const conversationId = context.conversationId;
  const onCost = context.conversationId
    ? createPluginModelCostRecorder({
        conversationId: context.conversationId,
        pluginName: plugin.manifest.name,
        source: "userPrompt",
        ...(turnId ? { turnId } : undefined),
      })
    : undefined;
  const common = {
    ...base,
    conversationId: context.conversationId,
    locationId: context.locationId,
    embedder: createPluginEmbedder(plugin.manifest.name, { onCost }),
    ...(conversationId
      ? {
          loadHistory: async () =>
            await loadPluginPromptHistory({
              conversationId,
              pluginName: plugin.manifest.name,
            }),
        }
      : undefined),
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
    model: createPluginModel(plugin.manifest.name, plugin.model, { onCost }),
    reranker: createPluginReranker(plugin.manifest.name, { onCost }),
    setSpanAttributes: pluginSpanAttributeSetter(
      plugin.manifest.name,
      setSpanAttributes,
    ),
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

export function pluginMcpContext(
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

export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
