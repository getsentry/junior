import { resolveChannelCapabilities } from "@/chat/slack/tools/channel-capabilities";
import { createBashTool } from "@/chat/tools/sandbox/bash";
import { createEditFileTool } from "@/chat/tools/sandbox/edit-file";
import { createFindFilesTool } from "@/chat/tools/sandbox/find-files";
import { createGrepTool } from "@/chat/tools/sandbox/grep";
import { readSandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import { createListDirTool } from "@/chat/tools/sandbox/list-dir";
import type { SkillMetadata } from "@/chat/skills";
import { createImageGenerateTool } from "@/chat/tools/web/image-generate";
import { createCallMcpToolTool } from "@/chat/tools/skill/call-mcp-tool";
import { createLoadSkillTool } from "@/chat/tools/skill/load-skill";
import { createSearchMcpToolsTool } from "@/chat/tools/skill/search-mcp-tools";
import { createReadFileTool } from "@/chat/tools/sandbox/read-file";
import { createReportProgressTool } from "@/chat/tools/runtime/report-progress";
import {
  canUseResourceEventSubscriptionTools,
  createCancelResourceEventSubscriptionTool,
  createListResourceEventSubscriptionsTool,
  createSubscribeToResourceEventsTool,
} from "@/chat/tools/resource-events";
import { createSlackChannelListMessagesTool } from "@/chat/slack/tools/channel-list-messages";
import { createSlackConversationSearchTool } from "@/chat/slack/tools/conversation-search";
import { getSlackToolContext } from "@/chat/slack/tools/context";
import { createSlackMessageAddReactionTool } from "@/chat/slack/tools/message-add-reaction";
import { createSendMessageTool } from "@/chat/slack/tools/send-message";
import { createSlackCanvasCreateTool } from "@/chat/slack/tools/canvas/create";
import { createSlackCanvasEditTool } from "@/chat/slack/tools/canvas/edit";
import { createSlackCanvasReadTool } from "@/chat/slack/tools/canvas/read";
import { createSlackCanvasWriteTool } from "@/chat/slack/tools/canvas/write";
import { createSlackListAddItemsTool } from "@/chat/slack/tools/list/add-items";
import { createSlackListCreateTool } from "@/chat/slack/tools/list/create";
import { createSlackListGetItemsTool } from "@/chat/slack/tools/list/get-items";
import { createSlackListUpdateItemTool } from "@/chat/slack/tools/list/update-item";
import { createSlackThreadReadTool } from "@/chat/slack/tools/thread-read";
import { createSlackUserLookupTool } from "@/chat/slack/tools/user-lookup";
import { createSystemTimeTool } from "@/chat/tools/system-time";
import { createHandoffTool } from "@/chat/tools/handoff/tool";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import type {
  ToolHooks,
  ToolRuntimeContext,
  ToolState,
} from "@/chat/tools/types";
import { getPluginTools } from "@/chat/plugins/agent-hooks";
import { createWebFetchTool } from "@/chat/tools/web/fetch-tool";
import { createWebSearchTool } from "@/chat/tools/web/search";
import { createWriteFileTool } from "@/chat/tools/sandbox/write-file";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";

function createToolState(
  hooks: ToolHooks,
  context: ToolRuntimeContext,
): ToolState {
  const operationResultCache = new Map<string, unknown>();
  const artifactState: ThreadArtifactsState = {
    ...(context.artifactState ?? {}),
    listColumnMap: {
      ...(context.artifactState?.listColumnMap ?? {}),
    },
  };

  const patchArtifactState = async (patch: Partial<ThreadArtifactsState>) => {
    Object.assign(artifactState, patch);
    if (patch.listColumnMap) {
      artifactState.listColumnMap = {
        ...(artifactState.listColumnMap ?? {}),
        ...patch.listColumnMap,
      };
    }
    await hooks.onArtifactStatePatch?.(patch);
  };

  return {
    artifactState,
    patchArtifactState,
    getCurrentListId: () => artifactState.lastListId,
    getOperationResult: <T>(operationKey: string): T | undefined =>
      operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey: string, result: unknown) => {
      operationResultCache.set(operationKey, result);
    },
  };
}

export type { ToolHooks, ToolRuntimeContext };

/** Build the model-facing tool registry from runtime-owned context and capabilities. */
export function createTools(
  availableSkills: SkillMetadata[],
  hooks: ToolHooks = {},
  context: ToolRuntimeContext,
) {
  const state = createToolState(hooks, context);
  const slackContext = getSlackToolContext(context);
  const slackSourceCapabilities = slackContext
    ? resolveChannelCapabilities(slackContext.sourceChannelId)
    : undefined;
  const canSendFilesToActiveConversation = Boolean(
    slackContext && slackSourceCapabilities?.canSendMessage,
  );
  const tools: Record<string, AnyToolDefinition> = {
    loadSkill: createLoadSkillTool(availableSkills, {
      onSkillLoaded: hooks.onSkillLoaded,
    }),
    reportProgress: createReportProgressTool(),
    systemTime: createSystemTimeTool(),
    bash: createBashTool(),
    readFile: createReadFileTool(),
    editFile: createEditFileTool(),
    grep: createGrepTool(),
    findFiles: createFindFilesTool(),
    listDir: createListDirTool(),
    writeFile: createWriteFileTool(),
    webSearch: createWebSearchTool(hooks.toolOverrides?.webSearch),
    webFetch: createWebFetchTool(hooks, {
      canSendFilesToActiveConversation,
    }),
  };
  if (hooks.writeGeneratedArtifacts) {
    tools.imageGenerate = createImageGenerateTool(
      {
        writeGeneratedArtifacts: hooks.writeGeneratedArtifacts,
      },
      {
        canSendFilesToActiveConversation,
      },
      hooks.toolOverrides?.imageGenerate,
    );
  }

  if (context.handoff) {
    tools.handoff = createHandoffTool(context.handoff);
  }

  if (canUseResourceEventSubscriptionTools(context)) {
    tools.subscribeToResourceEvents =
      createSubscribeToResourceEventsTool(context);
    tools.listResourceEventSubscriptions =
      createListResourceEventSubscriptionsTool(context);
    tools.cancelResourceEventSubscription =
      createCancelResourceEventSubscriptionTool(context);
  }

  if (context.mcpToolManager) {
    tools.searchMcpTools = createSearchMcpToolsTool(context.mcpToolManager);
    tools.callMcpTool = createCallMcpToolTool(context.mcpToolManager);
  }

  if (slackContext) {
    tools.slackCanvasRead = createSlackCanvasReadTool();
    tools.slackCanvasEdit = createSlackCanvasEditTool(state);
    tools.slackCanvasWrite = createSlackCanvasWriteTool(state);
    tools.slackThreadRead = createSlackThreadReadTool(slackContext);
    if (context.conversationId && slackContext.source.type === "pub") {
      tools.searchConversationHistory = createSlackConversationSearchTool(
        {
          kind: "public_provider_tenant",
          provider: "slack",
          providerTenantId: slackContext.teamId,
        },
        context.conversationId,
      );
    }
    tools.slackUserLookup = createSlackUserLookupTool();
    tools.slackListCreate = createSlackListCreateTool(state);
    tools.slackListAddItems = createSlackListAddItemsTool(state);
    tools.slackListGetItems = createSlackListGetItemsTool(state);
    tools.slackListUpdateItem = createSlackListUpdateItemTool(state);

    const outputChannelId = slackContext.destinationChannelId;
    const outputCapabilities = outputChannelId
      ? resolveChannelCapabilities(outputChannelId)
      : undefined;
    const rawChannelCapabilities = resolveChannelCapabilities(
      slackContext.sourceChannelId,
    );
    if (outputCapabilities?.canCreateCanvas) {
      tools.slackCanvasCreate = createSlackCanvasCreateTool(
        slackContext,
        state,
      );
    }

    if (rawChannelCapabilities.canSendMessage) {
      tools.sendMessage = createSendMessageTool(slackContext, state, (input) =>
        readSandboxFileUpload(context.sandbox, input),
      );
    }

    if (outputCapabilities?.canPostToChannel) {
      tools.slackChannelListMessages =
        createSlackChannelListMessagesTool(slackContext);
    }

    if (rawChannelCapabilities.canAddReactions) {
      tools.addReaction = createSlackMessageAddReactionTool(
        slackContext,
        state,
      );
    }
  }

  for (const [name, pluginTool] of Object.entries(getPluginTools(context))) {
    if (tools[name]) {
      throw new Error(`Plugin tool "${name}" conflicts with a core tool`);
    }
    tools[name] = pluginTool;
  }

  return tools;
}
