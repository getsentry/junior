import { resolveChannelCapabilities } from "@/chat/slack/tool-support/channel-capabilities";
import { botConfig } from "@/chat/config";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
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
import { createUpdatePlanTool } from "@/chat/tools/runtime/update-plan";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";
import { createSpawnAgentTool } from "@/chat/tools/runtime/spawn-agent";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import { createFinishAutomationRunTool } from "@/chat/tools/runtime/finish-automation-run";
import { createReportBlockedTool } from "@/chat/tools/runtime/report-blocked";
import { createRequestUserInputTool } from "@/chat/tools/runtime/request-user-input";
import {
  createAddReviewItemTool,
  createSearchReviewItemsTool,
  createUpdateReviewItemTool,
} from "@/chat/tools/review-items";
import { REPORT_BLOCKED_TOOL_NAME } from "@/chat/agent-invocations/blocked-report";
import { FINISH_AUTOMATION_RUN_TOOL_NAME } from "@/chat/automation-result";
import { createEventTools } from "@/chat/tools/events";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { createEventAutomationTools } from "@/chat/tools/event-automations";
import { createScheduledAutomationTools } from "@/chat/tools/scheduled-automations";
import { createSlackChannelJoinTool } from "@/chat/slack/tools/channel-join";
import { createSlackChannelListMessagesTool } from "@/chat/slack/tools/channel-list-messages";
import { createSlackConversationBriefSearchPort } from "@/chat/slack/tools/conversation-brief-search";
import { createSlackConversationMessageSearchTool } from "@/chat/slack/tools/conversation-message-search";
import { createSlackPublicSearchTool } from "@/chat/slack/tools/public-search";
import {
  getSlackToolContext,
  isSlackMessageTurn,
} from "@/chat/slack/tool-support/context";
import { createSlackMessageAddReactionTool } from "@/chat/slack/tools/message-add-reaction";
import { createSlackUserInputShow } from "@/chat/slack/tools/user-input";
import { createSlackSendFilesTool } from "@/chat/slack/tools/send-files";
import { createSendFilesTool } from "@/chat/tools/send-files";
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
import { createOperatorTools } from "@/chat/tools/operator-sql";
import { createUserCustomizationTools } from "@/chat/tools/user-customization";
import { createPublishImageTool } from "@/chat/tools/publish-image";
import { createUnpublishImageTool } from "@/chat/tools/unpublish-image";
import { createLoadAttachmentTool } from "@/chat/tools/load-attachment";
import { createSearchConversationEventsTool } from "@/chat/tools/search-conversation-events";
import { createSearchConversationBriefsTool } from "@/chat/tools/search-conversation-briefs";
import { createHandoffTool } from "@/chat/tools/handoff/tool";
import { disableTools, type ToolRegistry } from "@/chat/tools/definition";
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
  pluginSandbox?: PluginSandbox;
}

/**
 * Build the model-facing tool registry from runtime-owned context and capabilities.
 *
 * Choose tools from the Conversation, not from one Turn, so the cached tool
 * list stays the same. Use `disableTools` when a Turn cannot use a tool.
 */
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
    slackContext
      ? slackLocationCapabilities?.canSendFiles
      : context.attachmentStorage,
  );
  const eventCatalog = getEventCatalog();
  const tools: ToolRegistry = {
    loadSkill: createLoadSkillTool(availableSkills, {
      onSkillLoaded: hooks.onSkillLoaded,
    }),
    updatePlan: createUpdatePlanTool(),
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
      sandbox: context.workspace,
    }),
    ...createEventTools(context, eventCatalog),
    ...createEventAutomationTools(context, eventCatalog),
    ...createScheduledAutomationTools(context),
    ...createWorkspaceTools(context),
    ...createOperatorTools(context),
    ...createUserCustomizationTools(context),
  };
  tools.searchConversationEvents = createSearchConversationEventsTool(context);
  if (context.conversationPrivacy === "public") {
    tools.searchConversationBriefs = createSearchConversationBriefsTool(
      slackContext
        ? {
            kind: "public_provider_tenant",
            provider: "slack",
            providerTenantId: slackContext.teamId,
          }
        : { kind: "public" },
      context.conversationId,
      slackContext
        ? createSlackConversationBriefSearchPort(slackContext.teamId)
        : undefined,
    );
  }
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
        sandbox: context.workspace,
      },
      hooks.toolOverrides?.imageGenerate,
    );
  }
  if (context.attachmentStorage) {
    if (!slackContext) {
      tools.sendFiles = createSendFilesTool(
        state,
        (input) => readSandboxFileUpload(context.workspace, input),
        {
          attachments: {
            conversationId: context.conversationId,
            db: getSqlExecutor(),
            storage: context.attachmentStorage,
          },
        },
      );
    }
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
    if (!context.spawnAgentProfiles) {
      throw new Error("spawnAgent is missing its configured model profiles");
    }
    tools.spawnAgent = createSpawnAgentTool(
      context.spawnAgent,
      context.spawnAgentProfiles,
    );
    tools.stopAgent = createStopAgentTool(context.conversationId);
  }

  // A child agent that is too deep to start child agents can still list its
  // parent and siblings.
  if (context.spawnAgent || context.messageAgent) {
    tools.listAgents = createListAgentsTool({
      conversationId: context.conversationId,
      parentConversationId: context.parentConversationId,
    });
  }

  if (context.messageAgent) {
    tools.messageAgent = createMessageAgentTool(context.messageAgent);
  }

  // A child agent reports to its parent, whatever input started this Turn.
  if (context.parentConversationId) {
    tools[REPORT_BLOCKED_TOOL_NAME] = createReportBlockedTool();
  }

  if (context.automation) {
    tools[FINISH_AUTOMATION_RUN_TOOL_NAME] = createFinishAutomationRunTool(
      context.automation,
    );
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
    Object.assign(
      tools,
      disableTools(
        {
          slackPublicSearch: createSlackPublicSearchTool(
            context.slackActionToken,
          ),
        },
        context.slackActionToken
          ? undefined
          : "Slack gives a search token only for a new message or mention.",
      ),
    );
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
      tools.sendFiles = createSlackSendFilesTool(
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

    if (locationCapabilities.canAddReactions) {
      Object.assign(
        tools,
        disableTools(
          {
            addReaction: createSlackMessageAddReactionTool(slackContext, state),
          },
          slackContext.messageTs
            ? undefined
            : "It needs a Slack message in this Turn to react to.",
        ),
      );
    }
  }

  // Register in every Conversation so the cached tool list stays the same. A
  // person must be there to answer: the dashboard renders the question from
  // the transcript in a web Turn, and Slack posts buttons in a Slack message
  // Turn. A click comes back as Slack input in the thread of the question.
  // A child agent never asks: nobody sees its transcript, and an answer would
  // go to the parent's thread. It reports the need to its parent instead.
  const slackQuestionContext =
    slackContext && isSlackMessageTurn(context) ? slackContext : undefined;
  Object.assign(
    tools,
    disableTools(
      {
        requestUserInput: createRequestUserInputTool(
          slackQuestionContext
            ? createSlackUserInputShow(slackQuestionContext, state)
            : undefined,
        ),
      },
      context.parentConversationId
        ? `A child agent cannot ask the person. Use ${REPORT_BLOCKED_TOOL_NAME} to tell the parent agent what you need.`
        : context.source.kind === "web" || slackQuestionContext
          ? undefined
          : "It needs a Turn that a person started in Slack or the web dashboard.",
    ),
  );

  // Review items link to root Conversations, where a person can see them.
  Object.assign(
    tools,
    disableTools(
      {
        addReviewItem: createAddReviewItemTool(context),
        searchReviewItems: createSearchReviewItemsTool(context),
        updateReviewItem: createUpdateReviewItemTool(
          context,
          getVercelConversationWorkQueue,
        ),
      },
      context.parentConversationId
        ? `A child agent cannot use the review desk. Use ${REPORT_BLOCKED_TOOL_NAME} to tell the parent agent what needs a person.`
        : undefined,
    ),
  );

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
