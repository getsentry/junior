import { resolveChannelCapabilities } from "@/chat/slack/tool-support/channel-capabilities";
import { botConfig } from "@/chat/config";
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
import { createViewImageTool } from "@/chat/tools/sandbox/view-image";
import { createReportProgressTool } from "@/chat/tools/runtime/report-progress";
import { createSpawnAgentTool } from "@/chat/tools/runtime/spawn-agent";
import { createResourceEventTools } from "@/chat/tools/resource-events";
import { getResourceEventCatalog } from "@/chat/resource-events/runtime-catalog";
import { createEventTaskTools } from "@/chat/tools/event-tasks";
import { createScheduledTaskTools } from "@/chat/tools/scheduled-tasks";
import { createSlackChannelJoinTool } from "@/chat/slack/tools/channel-join";
import { createSlackChannelListMessagesTool } from "@/chat/slack/tools/channel-list-messages";
import { createSlackConversationMessageSearchTool } from "@/chat/slack/tools/conversation-message-search";
import { createSlackPublicSearchTool } from "@/chat/slack/tools/public-search";
import { getSlackToolContext } from "@/chat/slack/tool-support/context";
import { createSlackMessageAddReactionTool } from "@/chat/slack/tools/message-add-reaction";
import { createSendFilesTool } from "@/chat/slack/tools/send-files";
import { getSqlExecutor } from "@/chat/db";
import { createSlackCanvasCreateTool } from "@/chat/slack/tools/canvas/create";
import { createSlackCanvasEditTool } from "@/chat/slack/tools/canvas/edit";
import { createSlackCanvasReadTool } from "@/chat/slack/tools/canvas/read";
import { createSlackCanvasWriteTool } from "@/chat/slack/tools/canvas/write";
import { createSlackListAddItemsTool } from "@/chat/slack/tools/list/add-items";
import { createSlackListCreateTool } from "@/chat/slack/tools/list/create";
import { createSlackListGetItemsTool } from "@/chat/slack/tools/list/get-items";
import { createSlackListUpdateItemTool } from "@/chat/slack/tools/list/update-item";
import { createSlackThreadReadTool } from "@/chat/slack/tools/thread-read";
import { createUserLookupTool } from "@/chat/tools/user-lookup";
import { createSystemTimeTool } from "@/chat/tools/system-time";
import { createPublishImageTool } from "@/chat/tools/publish-image";
import { createUnpublishImageTool } from "@/chat/tools/unpublish-image";
import { createLoadAttachmentTool } from "@/chat/tools/load-attachment";
import { createSearchConversationEventsTool } from "@/chat/tools/search-conversation-events";
import { createHandoffTool } from "@/chat/tools/handoff/tool";
import type { ToolRegistry } from "@/chat/tools/definition";
import type {
  ToolHooks,
  ToolRuntimeContext,
  ToolState,
} from "@/chat/tools/types";
import type { PluginSandbox } from "@sentry/junior-plugin-api";
import { getPluginTools } from "@/chat/plugins/agent-hooks";
import { getOAuthAccountProviders } from "@/chat/plugins/credential-hooks";
import { createWebFetchTool } from "@/chat/tools/web/fetch-tool";
import { createWebSearchTool } from "@/chat/tools/web/search";
import { createWriteFileTool } from "@/chat/tools/sandbox/write-file";
import { createWorkspaceTools } from "@/chat/workspaces/tools";

function createToolState(): ToolState {
  const operationResultCache = new Map<string, unknown>();
  return {
    getOperationResult: <T>(operationKey: string): T | undefined =>
      operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey: string, result: unknown) => {
      operationResultCache.set(operationKey, result);
    },
  };
}

export type { ToolHooks, ToolRuntimeContext };

export interface CreateToolsOptions {
  includeLoadSkill?: boolean;
  pluginSandbox?: PluginSandbox;
}

/** Build the model-facing tool registry from runtime-owned context and capabilities. */
export function createTools(
  availableSkills: SkillMetadata[],
  hooks: ToolHooks = {},
  context: ToolRuntimeContext,
  options: CreateToolsOptions = {},
) {
  const state = createToolState();
  const slackContext = getSlackToolContext(context);
  const slackLocationCapabilities = slackContext
    ? resolveChannelCapabilities(slackContext.locationChannelId)
    : undefined;
  const canSendFilesToActiveConversation = Boolean(
    slackContext && slackLocationCapabilities?.canSendFiles,
  );
  const resourceEventCatalog = getResourceEventCatalog();
  const tools: ToolRegistry = {
    ...(options.includeLoadSkill === false
      ? undefined
      : {
          loadSkill: createLoadSkillTool(availableSkills, {
            onSkillLoaded: hooks.onSkillLoaded,
          }),
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
    webSearch: createWebSearchTool(
      botConfig.webSearchModelId,
      hooks.toolOverrides?.webSearch,
    ),
    webFetch: createWebFetchTool(hooks, {
      canSendFilesToActiveConversation,
    }),
    ...createResourceEventTools(context, resourceEventCatalog),
    ...createEventTaskTools(context, resourceEventCatalog),
    ...createScheduledTaskTools(context),
    ...createWorkspaceTools(context),
  };
  tools.searchConversationEvents = createSearchConversationEventsTool(context);
  if (context.supportsImageInput) {
    tools.viewImage = createViewImageTool(
      context.workspace,
      context.supportsImageInput,
      hooks.toolOverrides?.viewImage,
    );
  }
  if (hooks.writeGeneratedArtifacts) {
    tools.imageGenerate = createImageGenerateTool(
      {
        writeGeneratedArtifacts: hooks.writeGeneratedArtifacts,
      },
      {
        modelId: botConfig.imageGenerationModelId,
        canSendFilesToActiveConversation,
      },
      hooks.toolOverrides?.imageGenerate,
    );
  }
  if (context.attachmentStorage) {
    tools.loadAttachment = createLoadAttachmentTool({
      conversationId: context.conversationId,
      db: getSqlExecutor(),
      storage: context.attachmentStorage,
      workspace: context.workspace,
    });
    tools.publishImage = createPublishImageTool({
      conversationId: context.conversationId,
      db: getSqlExecutor(),
      storage: context.attachmentStorage,
      workspace: context.workspace,
    });
    tools.unpublishImage = createUnpublishImageTool({
      conversationId: context.conversationId,
      db: getSqlExecutor(),
    });
  }

  if (context.handoff) {
    tools.handoff = createHandoffTool(context.handoff);
  }

  if (context.spawnAgent) {
    tools.spawnAgent = createSpawnAgentTool(context.spawnAgent);
  }

  if (context.mcpToolManager) {
    tools.searchMcpTools = createSearchMcpToolsTool(context.mcpToolManager);
    tools.callMcpTool = createCallMcpToolTool(context.mcpToolManager);
  }

  if (slackContext) {
    tools.slackCanvasRead = createSlackCanvasReadTool();
    tools.slackCanvasEdit = createSlackCanvasEditTool(state);
    tools.slackCanvasWrite = createSlackCanvasWriteTool(state);
    tools.slackThreadRead = createSlackThreadReadTool(slackContext, {
      conversationId: context.conversationId,
      db: getSqlExecutor(),
    });
    tools.slackChannelJoin = createSlackChannelJoinTool(slackContext);
    if (context.conversationPrivacy === "public") {
      tools.searchConversationMessages =
        createSlackConversationMessageSearchTool(
          {
            kind: "public_provider_tenant",
            provider: "slack",
            providerTenantId: slackContext.teamId,
          },
          context.conversationId,
        );
    }
    // Always register public search in Slack turns. Without an action token the
    // tool stays visible and returns an honest interactive-turn limit.
    if (context.source.kind === "slack") {
      tools.slackPublicSearch = createSlackPublicSearchTool(
        context.slackActionToken,
      );
    }
    const identityProviders = [
      "slack",
      ...getOAuthAccountProviders().filter((provider) => provider !== "slack"),
    ] as [string, ...string[]];
    tools.userLookup = createUserLookupTool(
      slackContext.teamId,
      identityProviders,
    );
    tools.slackListCreate = createSlackListCreateTool(state);
    tools.slackListAddItems = createSlackListAddItemsTool(state);
    tools.slackListGetItems = createSlackListGetItemsTool();
    tools.slackListUpdateItem = createSlackListUpdateItemTool(state);

    const outputChannelId = slackContext.destinationChannelId;
    const outputCapabilities = outputChannelId
      ? resolveChannelCapabilities(outputChannelId)
      : undefined;
    const locationCapabilities = resolveChannelCapabilities(
      slackContext.locationChannelId,
    );
    if (outputCapabilities?.canCreateCanvas) {
      tools.slackCanvasCreate = createSlackCanvasCreateTool(
        slackContext,
        state,
      );
    }

    if (locationCapabilities.canSendFiles) {
      tools.sendFiles = createSendFilesTool(
        slackContext,
        state,
        (input) => readSandboxFileUpload(context.workspace, input),
        context.attachmentStorage
          ? {
              conversationId: context.conversationId,
              db: getSqlExecutor(),
              storage: context.attachmentStorage,
            }
          : undefined,
      );
    }

    // Channel history is available in any Slack context, including DMs, so the
    // model can read the active destination or another accessible public channel.
    tools.slackChannelListMessages =
      createSlackChannelListMessagesTool(slackContext);

    if (
      context.source.kind === "slack" &&
      locationCapabilities.canAddReactions
    ) {
      tools.addReaction = createSlackMessageAddReactionTool(
        slackContext,
        state,
      );
    }
  }

  for (const [name, pluginTool] of Object.entries(
    getPluginTools(context, options.pluginSandbox),
  )) {
    if (tools[name]) {
      throw new Error(`Plugin tool "${name}" conflicts with a core tool`);
    }
    tools[name] = pluginTool;
  }

  return tools;
}
