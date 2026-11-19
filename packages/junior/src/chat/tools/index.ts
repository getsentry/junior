import { resolveChannelCapabilities } from "@/chat/slack/tool-support/channel-capabilities";
import { isEventEmbeddingsEnabled } from "@/chat/briefs/registration";
import { createConversationEmbedder } from "@/chat/conversations/embedding";
import { botConfig } from "@/chat/config";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { createStartConversationTool } from "@/chat/tools/start-conversation";
import { readLeadUser } from "@/chat/lead/conversation";
import { createBashTool } from "@/chat/tools/sandbox/bash";
import { createCreatePreviewTool } from "@/chat/tools/sandbox/create-preview";
import { recordPreviewOrigin } from "@/personal-tokens/preview-origins";
import { runBestEffort } from "@/chat/logging";
import { createEditFileTool } from "@/chat/tools/sandbox/edit-file";
import { readSandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import type { SkillMetadata } from "@/chat/skills";
import { createImageGenerateTool } from "@/chat/tools/web/image-generate";
import { createTranscribeAudioTool } from "@/chat/tools/transcribe-audio";
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
import { createArchiveAgentTool } from "@/chat/tools/runtime/archive-agent";
import { createReplyTool } from "@/chat/tools/runtime/reply";
import { createNoReplyTool } from "@/chat/tools/runtime/no-reply";
import { createReportBlockedTool } from "@/chat/tools/runtime/report-blocked";
import {
  createAddReviewItemTool,
  createSearchReviewItemsTool,
  createUpdateReviewItemTool,
} from "@/chat/tools/review-items";
import { REPORT_BLOCKED_TOOL_NAME } from "@/chat/agent-invocations/blocked-report";
import { NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { REPLY_TOOL_NAME } from "@/chat/turn-answer";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { createSlackChannelJoinTool } from "@/chat/slack/tools/channel-join";
import { createSlackChannelListMessagesTool } from "@/chat/slack/tools/channel-list-messages";
import { createSlackConversationSearchChannelPort } from "@/chat/slack/tools/conversation-search";
import { createSearchConversationsTool } from "@/chat/tools/search-conversations";
import { createSlackConversationMessageSearchTool } from "@/chat/slack/tools/conversation-message-search";
import { createSlackPublicSearchTool } from "@/chat/slack/tools/public-search";
import {
  getSlackToolContext,
  type SlackToolContext,
} from "@/chat/slack/tool-support/context";
import { readSlackAttachmentSource } from "@/chat/slack/attachments";
import { createSlackMessageAddReactionTool } from "@/chat/slack/tools/message-add-reaction";
import { createSlackReviewItemToolServices } from "@/chat/slack/review-item-tools";
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
import {
  createUserLookupTool,
  userLookupIdentityProviders,
} from "@/chat/tools/user-lookup";
import { createSystemTimeTool } from "@/chat/tools/system-time";
import { createSubmitFeedbackTool } from "@/chat/tools/submit-feedback";
import { createRunOperatorSqlTool } from "@/chat/tools/operator-sql";
import { createUpdateUserCustomizationTool } from "@/chat/tools/user-customization";
import { createSetConversationSubscriptionTool } from "@/chat/tools/conversation-subscription";
import type { TurnBehavior } from "@/chat/conversations/kind-behavior";
import type { AnyToolDefinition, ToolRegistry } from "@/chat/tools/definition";
import {
  coreToolSlots,
  enabledMode,
  type RunBuiltToolSlot,
  type StaticToolName,
} from "@/chat/tools/registry";
import {
  automationToolContext,
  automationToolsDisabledReason,
  type AutomationToolContext,
} from "@/chat/automations/tool-access";
import { createAutomationTool } from "@/chat/automations/tools/create";
import { createDeleteAutomationTool } from "@/chat/automations/tools/delete";
import { createRunAutomationNowTool } from "@/chat/automations/tools/run-now";
import { createSearchAutomationsTool } from "@/chat/automations/tools/search";
import { createUpdateAutomationTool } from "@/chat/automations/tools/update";
import type { EventCatalog } from "@/chat/events/catalog";
import { createListWatchesTool } from "@/chat/tools/list-watches";
import { createSearchEventTypesTool } from "@/chat/tools/search-event-types";
import { createStopWatchingResourcesTool } from "@/chat/tools/stop-watches";
import { createWatchTimerTool } from "@/chat/tools/watch-timer";
import { createWatchEventsTool } from "@/chat/tools/watch-events";
import { createPublishImageTool } from "@/chat/tools/publish-image";
import { createUnpublishImageTool } from "@/chat/tools/unpublish-image";
import { createLoadAttachmentTool } from "@/chat/tools/load-attachment";
import { createReadConversationEventTool } from "@/chat/tools/read-conversation-event";
import { createSearchConversationEventsTool } from "@/chat/tools/search-conversation-events";
import type {
  ToolHooks,
  ToolRuntimeContext,
  ToolState,
} from "@/chat/tools/types";
import type { PluginSandbox } from "@sentry/junior-plugin-api";
import { getPluginTools } from "@/chat/plugins/agent-hooks";
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
  /**
   * Every discovered skill, for the skill an Automation runs. Unlike the
   * skills that `loadSkill` gets, it includes skills with
   * `disable-model-invocation`.
   */
  automationSkills?: readonly SkillMetadata[];
  pluginSandbox?: PluginSandbox;
}

type ModelCost = { conversationId: string; turnId?: string };

/** What a binder reads to bind one tool to a run. */
interface ToolRun {
  availableSkills: SkillMetadata[];
  hooks: ToolHooks;
  context: ToolRuntimeContext;
  /** The tools that the Turn lists. `context.turnTools` says which it can use. */
  listedTools: TurnBehavior["tools"];
  options: CreateToolsOptions;
  state: ToolState;
  slack: SlackToolContext | undefined;
  catalog: EventCatalog;
  modelCost: ModelCost;
  canSendFilesToActiveConversation: boolean;
  automation: AutomationToolContext;
  automationDisabledReason: string | undefined;
  workspaceTools: () => ToolRegistry;
  reviewItemServices: () => ReturnType<
    typeof createSlackReviewItemToolServices
  >;
}

type ToolBinder = (run: ToolRun) => AnyToolDefinition | undefined;

function withDisabledReason(
  tool: AnyToolDefinition,
  reason: string | undefined,
): AnyToolDefinition {
  return reason ? { ...tool, disabledReason: reason } : tool;
}

// The registry gives Slack tools only to a Turn on the Slack platform, which
// `createTools` sets only when the run has a Slack tool context.
function slackOf(run: ToolRun): SlackToolContext {
  if (!run.slack) throw new Error("Slack tool bound without a Slack context");
  return run.slack;
}

function isPublic(run: ToolRun): boolean {
  return run.context.conversationPrivacy === "public";
}

// One binder for each static tool in the registry. The registry decides
// whether a Turn lists the tool, from the platform, the listed Turn tools and
// deployment config; a binder never repeats those gates. A binder reads only
// the run: it can return `undefined` when the run lacks a capability that the
// tool needs, or set `disabledReason` when the run cannot use the tool now.
// `TURN_TOOL_LIMITS` disables the listed tools that the Turn's own tools do
// not allow.
// The `satisfies` clause fails typecheck for a definition without a binder,
// or a binder without a definition.
const STATIC_TOOL_BINDERS = {
  updatePlan: (run) =>
    createUpdatePlanTool(
      run.context,
      run.reviewItemServices().findMentionedUserId,
    ),
  reportProgress: () => createReportProgressTool(),
  systemTime: () => createSystemTimeTool(),
  submitFeedback: (run) => createSubmitFeedbackTool(run.context),
  bash: () => createBashTool(),
  readFile: () => createReadFileTool(),
  editFile: () => createEditFileTool(),
  writeFile: () => createWriteFileTool(),
  webSearch: (run) =>
    createWebSearchTool(
      botConfig.webSearchModelId,
      run.modelCost,
      run.hooks.toolOverrides?.webSearch,
    ),
  webFetch: (run) =>
    createWebFetchTool(run.hooks, {
      canSendFilesToActiveConversation: run.canSendFilesToActiveConversation,
    }),
  watchTimer: (run) => createWatchTimerTool(run.context),
  searchEventTypes: (run) => createSearchEventTypesTool(run.catalog),
  watchEvents: (run) => createWatchEventsTool(run.context, run.catalog),
  listWatches: (run) => createListWatchesTool(run.context),
  stopWatchingResources: (run) => createStopWatchingResourcesTool(run.context),
  searchAutomations: (run) =>
    withDisabledReason(
      createSearchAutomationsTool(run.automation, run.catalog),
      run.automationDisabledReason,
    ),
  deleteAutomation: (run) =>
    withDisabledReason(
      createDeleteAutomationTool(run.automation, run.catalog),
      run.automationDisabledReason,
    ),
  runAutomationNow: (run) =>
    withDisabledReason(
      createRunAutomationNowTool(run.automation, run.catalog),
      run.automationDisabledReason,
    ),
  createWorkspace: (run) => run.workspaceTools()["createWorkspace"],
  updateWorkspace: (run) => run.workspaceTools()["updateWorkspace"],
  deleteWorkspace: (run) => run.workspaceTools()["deleteWorkspace"],
  listWorkspaces: (run) => run.workspaceTools()["listWorkspaces"],
  switchWorkspace: (run) => run.workspaceTools()["switchWorkspace"],
  runOperatorSql: (run) =>
    isPublic(run) ? undefined : createRunOperatorSqlTool(),
  updateUserCustomization: (run) =>
    createUpdateUserCustomizationTool(run.context),
  setConversationSubscription: (run) =>
    createSetConversationSubscriptionTool(run.context),
  searchConversationEvents: (run) =>
    createSearchConversationEventsTool(
      run.context,
      isEventEmbeddingsEnabled()
        ? {
            embedder: createConversationEmbedder({
              cost: {
                conversationId: run.context.conversationId,
                ...(run.context.turnId
                  ? { turnId: run.context.turnId }
                  : undefined),
              },
              operation: "conversation_search_embedding",
            }),
          }
        : undefined,
    ),
  readConversationEvent: (run) => createReadConversationEventTool(run.context),
  searchConversations: (run) =>
    createSearchConversationsTool({
      ...(run.slack
        ? {
            channels: createSlackConversationSearchChannelPort(
              run.slack.teamId,
            ),
          }
        : undefined),
      conversationId: run.context.conversationId,
      embedder: createConversationEmbedder({
        cost: {
          conversationId: run.context.conversationId,
          ...(run.context.turnId ? { turnId: run.context.turnId } : undefined),
        },
        operation: "conversation_search_embedding",
      }),
      // A Lead Turn that no person started searches for the Lead's person.
      resolveUserId: async () =>
        (await run.context.resolveActorIdentity?.())?.user?.id ??
        (await readLeadUser(run.context.conversationId))?.id,
    }),
  spawnAgent: (run) =>
    run.context.spawnAgent
      ? createSpawnAgentTool(run.context.spawnAgent, run.modelCost)
      : undefined,
  stopAgent: (run) =>
    run.context.spawnAgent
      ? createStopAgentTool(run.context.conversationId)
      : undefined,
  archiveAgent: (run) =>
    run.context.spawnAgent
      ? createArchiveAgentTool(run.context.conversationId)
      : undefined,
  // A child agent that is too deep to start child agents can still find its
  // parent and siblings.
  listAgents: (run) =>
    run.context.spawnAgent || run.context.messageAgent
      ? createListAgentsTool({
          conversationId: run.context.conversationId,
          parentConversationId: run.context.parentConversationId,
        })
      : undefined,
  messageAgent: (run) =>
    run.context.messageAgent
      ? createMessageAgentTool(run.context.messageAgent)
      : undefined,
  [REPLY_TOOL_NAME]: (run) =>
    createReplyTool(enabledMode(run.listedTools.reply)),
  [REPORT_BLOCKED_TOOL_NAME]: (run) =>
    createReportBlockedTool(enabledMode(run.listedTools.reportBlocked)),
  [NO_REPLY_TOOL_NAME]: () => createNoReplyTool(),
  slackCanvasRead: () => createSlackCanvasReadTool(),
  slackCanvasEdit: (run) => createSlackCanvasEditTool(run.state),
  slackCanvasWrite: (run) => createSlackCanvasWriteTool(run.state),
  slackThreadRead: (run) =>
    createSlackThreadReadTool(slackOf(run), {
      conversationId: run.context.conversationId,
      db: getSqlExecutor(),
    }),
  slackChannelJoin: (run) => createSlackChannelJoinTool(slackOf(run)),
  searchConversationMessages: (run) =>
    isPublic(run)
      ? createSlackConversationMessageSearchTool(
          slackOf(run).teamId,
          run.context.conversationId,
        )
      : undefined,
  slackPublicSearch: (run) =>
    withDisabledReason(
      createSlackPublicSearchTool(run.context.slackActionToken),
      run.context.slackActionToken
        ? undefined
        : "Slack gives a search token only for a new message or mention.",
    ),
  userLookup: (run) =>
    createUserLookupTool(slackOf(run).teamId, userLookupIdentityProviders()),
  slackListCreate: (run) => createSlackListCreateTool(run.state),
  slackListAddItems: (run) => createSlackListAddItemsTool(run.state),
  slackListGetItems: () => createSlackListGetItemsTool(),
  slackListUpdateItem: (run) => createSlackListUpdateItemTool(run.state),
  // Channel history is available in any Slack context, including DMs, so the
  // model can read the active destination or another accessible public channel.
  slackChannelListMessages: (run) =>
    createSlackChannelListMessagesTool(slackOf(run)),
  // Review items link to root Conversations, where a person can see them.
  // `addReviewItem` is how the agent asks a person anything, so it is loaded
  // in every root Turn. A child agent asks its parent instead.
  addReviewItem: (run) =>
    createAddReviewItemTool(run.context, run.reviewItemServices()),
  searchReviewItems: (run) =>
    createSearchReviewItemsTool(run.context, run.reviewItemServices()),
  updateReviewItem: (run) =>
    createUpdateReviewItemTool(run.context, run.reviewItemServices()),
  startConversation: (run) => createStartConversationTool(run.context),
} satisfies Record<StaticToolName, ToolBinder>;

type TurnTools = TurnBehavior["tools"];

// A person's Turn in a Thread lists the agent tools of the Thread, but it
// cannot use them: their results would report to the parent as the wrong
// Actor.
const AGENT_TOOL_LIMIT = (turnTools: TurnTools) =>
  turnTools.agents === "none"
    ? "A person's Turn in a Thread cannot use agent tools."
    : undefined;

const INBOX_LIMIT = (turnTools: TurnTools) =>
  turnTools.inbox
    ? undefined
    : `A child agent cannot use the Inbox. Use ${REPORT_BLOCKED_TOOL_NAME} to tell the parent agent what needs a person.`;

// The listed tools that the Turn's own tools can disallow, with the reason
// that the model sees. A Thread lists the tools of both senders, so one
// sender's Turn gets the other sender's tools disabled here.
const TURN_TOOL_LIMITS: Partial<
  Record<StaticToolName, (turnTools: TurnTools) => string | undefined>
> = {
  spawnAgent: AGENT_TOOL_LIMIT,
  stopAgent: AGENT_TOOL_LIMIT,
  archiveAgent: AGENT_TOOL_LIMIT,
  listAgents: AGENT_TOOL_LIMIT,
  messageAgent: AGENT_TOOL_LIMIT,
  // The system prompt says why for each sender: a person's Turn ends with a
  // final response, and an Automation with no outcomes posts nothing.
  [REPLY_TOOL_NAME]: (turnTools) =>
    turnTools.reply === "none"
      ? `This Turn cannot send a \`${REPLY_TOOL_NAME}\`.`
      : undefined,
  [REPORT_BLOCKED_TOOL_NAME]: (turnTools) =>
    turnTools.reportBlocked === "none"
      ? "This Turn cannot send a blocked report."
      : undefined,
  updateUserCustomization: (turnTools) =>
    turnTools.userCustomization
      ? undefined
      : "Only a person's Turn can change user customization.",
  setConversationSubscription: (turnTools) =>
    turnTools.subscriptions
      ? undefined
      : "Only a person's Turn can change subscriptions.",
  addReviewItem: INBOX_LIMIT,
  searchReviewItems: INBOX_LIMIT,
  updateReviewItem: INBOX_LIMIT,
};

function attachmentStore(run: ToolRun) {
  const storage = run.context.attachmentStorage;
  return storage
    ? {
        conversationId: run.context.conversationId,
        db: getSqlExecutor(),
        storage,
      }
    : undefined;
}

// Each run builds these tools, because their definitions or presence depend
// on the run: skills, attachment storage, previews, image input and output,
// MCP, and the capabilities of the Slack channel.
const RUN_BUILT_TOOL_BUILDERS = {
  loadSkill: (run) =>
    createLoadSkillTool(run.availableSkills, {
      onSkillLoaded: run.hooks.onSkillLoaded,
    }),
  createAutomation: (run) =>
    withDisabledReason(
      createAutomationTool(
        run.automation,
        run.catalog,
        run.options.automationSkills ?? [],
      ),
      run.automationDisabledReason,
    ),
  updateAutomation: (run) =>
    withDisabledReason(
      createUpdateAutomationTool(
        run.automation,
        run.catalog,
        run.options.automationSkills ?? [],
      ),
      run.automationDisabledReason,
    ),
  createPreview: (run) => {
    const { context } = run;
    const createPreview = context.workspace.createPreview?.bind(
      context.workspace,
    );
    if (!createPreview) return undefined;
    return createCreatePreviewTool(async (port) => {
      const url = await createPreview(port);
      // Lets the requester send this Preview a personal token for live data.
      // The Preview works without the record: Connect then refuses it, and
      // the viewer pastes a token instead.
      await runBestEffort(async () => {
        const owner = (await context.resolveActorIdentity?.())?.user;
        if (owner) await recordPreviewOrigin({ ownerEmail: owner.email, url });
      }, "sandbox.preview_origin.record.failed");
      return url;
    });
  },
  viewImage: (run) =>
    run.context.supportsImageInput
      ? createViewImageTool(
          run.context.workspace,
          run.context.supportsImageInput,
          run.hooks.toolOverrides?.viewImage,
        )
      : undefined,
  imageGenerate: (run) =>
    run.hooks.writeGeneratedFiles
      ? createImageGenerateTool(
          { writeGeneratedFiles: run.hooks.writeGeneratedFiles },
          {
            modelId: botConfig.imageGenerationModelId,
            canSendFilesToActiveConversation:
              run.canSendFilesToActiveConversation,
            modelCost: run.modelCost,
            sandbox: run.context.workspace,
          },
          run.hooks.toolOverrides?.imageGenerate,
        )
      : undefined,
  localSendFiles: (run) => {
    const attachments = attachmentStore(run);
    if (run.slack || !attachments) return undefined;
    return createSendFilesTool(
      run.state,
      (input) => readSandboxFileUpload(run.context.workspace, input),
      { attachments },
    );
  },
  loadAttachment: (run) => {
    const attachments = attachmentStore(run);
    return attachments
      ? createLoadAttachmentTool({
          ...attachments,
          ...(run.slack
            ? { readAttachmentSource: readSlackAttachmentSource }
            : undefined),
          workspace: run.context.workspace,
        })
      : undefined;
  },
  publishImage: (run) => {
    const attachments = attachmentStore(run);
    return attachments
      ? createPublishImageTool({
          ...attachments,
          workspace: run.context.workspace,
        })
      : undefined;
  },
  unpublishImage: (run) =>
    run.context.attachmentStorage
      ? createUnpublishImageTool({
          conversationId: run.context.conversationId,
          db: getSqlExecutor(),
        })
      : undefined,
  transcribeAudio: (run) => {
    const storage = run.context.attachmentStorage;
    const createDownloadUrl = storage?.createDownloadUrl?.bind(storage);
    return storage && createDownloadUrl
      ? createTranscribeAudioTool({
          conversationId: run.context.conversationId,
          db: getSqlExecutor(),
          modelCost: run.modelCost,
          modelId: botConfig.transcriptionModelId,
          ...(run.slack
            ? { readAttachmentSource: readSlackAttachmentSource }
            : undefined),
          storage: { ...storage, createDownloadUrl },
          workspace: run.context.workspace,
        })
      : undefined;
  },
  searchMcpTools: (run) =>
    run.context.mcpToolManager
      ? createSearchMcpToolsTool(run.context.mcpToolManager)
      : undefined,
  callMcpTool: (run) =>
    run.context.mcpToolManager
      ? createCallMcpToolTool(run.context.mcpToolManager)
      : undefined,
  slackCanvasCreate: (run) => {
    if (!run.slack?.destinationChannelId) return undefined;
    return resolveChannelCapabilities(run.slack.destinationChannelId)
      .canCreateCanvas
      ? createSlackCanvasCreateTool(run.slack, run.state)
      : undefined;
  },
  sendFiles: (run) => {
    if (!run.slack) return undefined;
    if (!resolveChannelCapabilities(run.slack.locationChannelId).canSendFiles)
      return undefined;
    return createSlackSendFilesTool(
      run.slack,
      run.state,
      (input) => readSandboxFileUpload(run.context.workspace, input),
      run.context.conversationId,
      attachmentStore(run),
    );
  },
  addReaction: (run) => {
    if (!run.slack) return undefined;
    if (
      !resolveChannelCapabilities(run.slack.locationChannelId).canAddReactions
    )
      return undefined;
    return withDisabledReason(
      createSlackMessageAddReactionTool(run.slack, run.state),
      run.slack.messageTs
        ? undefined
        : "It needs a Slack message in this Turn to react to.",
    );
  },
} satisfies Record<RunBuiltToolSlot, ToolBinder>;

function once<T>(build: () => T): () => T {
  let value: { current: T } | undefined;
  return () => (value ??= { current: build() }).current;
}

/**
 * Build the model-facing tool registry from runtime-owned context and capabilities.
 *
 * The static tool registry decides which tools the Turn has and their order;
 * this binds each one to the run. Choose tools from the Conversation, not
 * from one Turn, so the cached tool list stays the same. Use
 * `disabledReason` when a Turn cannot use a tool.
 */
export function createTools(
  availableSkills: SkillMetadata[],
  hooks: ToolHooks = {},
  context: ToolRuntimeContext,
  options: CreateToolsOptions = {},
) {
  const slack = getSlackToolContext(context);
  const listedTools = context.listedTools ?? context.turnTools;
  const run: ToolRun = {
    availableSkills,
    hooks,
    context,
    listedTools,
    options,
    state: createToolState(),
    slack,
    catalog: getEventCatalog(),
    modelCost: {
      conversationId: context.conversationId,
      ...(context.turnId ? { turnId: context.turnId } : undefined),
    },
    canSendFilesToActiveConversation: Boolean(
      slack
        ? resolveChannelCapabilities(slack.locationChannelId).canSendFiles
        : context.attachmentStorage,
    ),
    automation: automationToolContext(context),
    automationDisabledReason: automationToolsDisabledReason(context),
    workspaceTools: once(() => createWorkspaceTools(context)),
    reviewItemServices: once(() =>
      createSlackReviewItemToolServices(
        () => context.conversationWorkQueue ?? getVercelConversationWorkQueue(),
      ),
    ),
  };

  const tools: ToolRegistry = {};
  for (const slot of coreToolSlots({
    platform: slack ? "slack" : "local",
    listedTools,
  })) {
    const tool =
      slot.kind === "static"
        ? STATIC_TOOL_BINDERS[slot.name](run)
        : RUN_BUILT_TOOL_BUILDERS[slot.slot](run);
    if (!tool) continue;
    tools[slot.name] =
      slot.kind === "static"
        ? withDisabledReason(
            tool,
            TURN_TOOL_LIMITS[slot.name]?.(context.turnTools),
          )
        : tool;
  }

  // A Turn with an `only` list gets no plugin tools.
  const pluginTools = listedTools.only
    ? {}
    : getPluginTools(context, options.pluginSandbox);
  for (const [name, pluginTool] of Object.entries(pluginTools)) {
    if (tools[name]) {
      throw new Error(`Plugin tool "${name}" conflicts with a core tool`);
    }
    tools[name] = pluginTool;
  }

  return tools;
}
