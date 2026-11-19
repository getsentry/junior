/**
 * Static tool registry: the core tools in provider order, and the model-facing
 * definitions of the core and plugin tools, read with no run context.
 *
 * The registry decides which tools a Turn lists. Its gates read only the
 * platform, the listed Turn tools, and deployment config (experimental
 * features, the event catalog, workspace providers). `createTools` binds each
 * static definition to one run with the binder of the same name.
 *
 * Run-built entries keep their place in the provider order, but each run
 * builds them, because their definitions or presence depend on the run.
 * MCP tools, the `codemode` declarations and the `searchTools` sources are
 * also built by each run, outside `createTools`.
 */
import type { Platform } from "@sentry/junior-plugin-api";
import type { ZodTypeAny } from "zod";
import { REPORT_BLOCKED_TOOL_NAME } from "@/chat/agent-invocations/blocked-report";
import { deleteAutomationToolDefinition } from "@/chat/automations/tools/delete";
import { runAutomationNowToolDefinition } from "@/chat/automations/tools/run-now";
import { searchAutomationsToolDefinition } from "@/chat/automations/tools/search";
import {
  promptModeTurnTools,
  type TurnBehavior,
} from "@/chat/conversations/kind-behavior";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { hasEventCatalogEntries } from "@/chat/events/catalog";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import { NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { getStaticPluginToolDefinitions } from "@/chat/plugins/agent-hooks";
import { slackCanvasEditToolDefinition } from "@/chat/slack/tools/canvas/edit";
import { slackCanvasReadToolDefinition } from "@/chat/slack/tools/canvas/read";
import { slackCanvasWriteToolDefinition } from "@/chat/slack/tools/canvas/write";
import { slackChannelJoinToolDefinition } from "@/chat/slack/tools/channel-join";
import { slackChannelListMessagesToolDefinition } from "@/chat/slack/tools/channel-list-messages";
import { slackConversationSearchChannelFilter } from "@/chat/slack/tools/conversation-search";
import { searchConversationMessagesToolDefinition } from "@/chat/slack/tools/conversation-message-search";
import { slackListAddItemsToolDefinition } from "@/chat/slack/tools/list/add-items";
import { slackListCreateToolDefinition } from "@/chat/slack/tools/list/create";
import { slackListGetItemsToolDefinition } from "@/chat/slack/tools/list/get-items";
import { slackListUpdateItemToolDefinition } from "@/chat/slack/tools/list/update-item";
import { slackPublicSearchToolDefinition } from "@/chat/slack/tools/public-search";
import { slackThreadReadToolDefinition } from "@/chat/slack/tools/thread-read";
import type { PromptMode } from "@/chat/system-prompt-rules";
import {
  type StaticZodToolDefinition,
  zodTool,
} from "@/chat/tool-support/zod-tool";
import { setConversationSubscriptionToolDefinition } from "@/chat/tools/conversation-subscription";
import type { ToolRegistry } from "@/chat/tools/definition";
import { listWatchesToolDefinition } from "@/chat/tools/list-watches";
import { runOperatorSqlToolDefinition } from "@/chat/tools/operator-sql";
import { readConversationEventToolDefinition } from "@/chat/tools/read-conversation-event";
import {
  addReviewItemToolDefinition,
  searchReviewItemsToolDefinition,
  updateReviewItemToolDefinition,
} from "@/chat/tools/review-items";
import { archiveAgentToolDefinition } from "@/chat/tools/runtime/archive-agent";
import { messageAgentToolDefinition } from "@/chat/tools/runtime/message-agent";
import { noReplyToolDefinition } from "@/chat/tools/runtime/no-reply";
import { replyToolDefinition } from "@/chat/tools/runtime/reply";
import { reportBlockedToolDefinition } from "@/chat/tools/runtime/report-blocked";
import { reportProgressToolDefinition } from "@/chat/tools/runtime/report-progress";
import { listAgentsToolDefinition } from "@/chat/tools/runtime/list-agents";
import { spawnAgentToolDefinition } from "@/chat/tools/runtime/spawn-agent";
import { stopAgentToolDefinition } from "@/chat/tools/runtime/stop-agent";
import { updatePlanToolDefinition } from "@/chat/tools/runtime/update-plan";
import { bashToolDefinition } from "@/chat/tools/sandbox/bash";
import { editFileToolDefinition } from "@/chat/tools/sandbox/edit-file";
import { readFileToolDefinition } from "@/chat/tools/sandbox/read-file";
import { writeFileToolDefinition } from "@/chat/tools/sandbox/write-file";
import { searchConversationsToolDefinition } from "@/chat/tools/search-conversations";
import { startConversationToolDefinition } from "@/chat/lead/start-conversation-tool";
import { searchConversationEventsToolDefinition } from "@/chat/tools/search-conversation-events";
import { searchEventTypesToolDefinition } from "@/chat/tools/search-event-types";
import { stopWatchingResourcesToolDefinition } from "@/chat/tools/stop-watches";
import { systemTimeToolDefinition } from "@/chat/tools/system-time";
import { submitFeedbackToolDefinition } from "@/chat/tools/submit-feedback";
import { updateUserCustomizationToolDefinition } from "@/chat/tools/user-customization";
import {
  userLookupIdentityProviders,
  userLookupToolDefinition,
} from "@/chat/tools/user-lookup";
import { watchEventsToolDefinition } from "@/chat/tools/watch-events";
import { watchTimerToolDefinition } from "@/chat/tools/watch-timer";
import { webFetchToolDefinition } from "@/chat/tools/web/fetch-tool";
import { webSearchToolDefinition } from "@/chat/tools/web/search";
import { REPLY_TOOL_NAME } from "@/chat/turn-answer";
import {
  workspaceProviderNames,
  workspaceToolDefinitions,
} from "@/chat/workspaces/tools";

/** The platform and Prompt mode that a definitions snapshot is for. */
export interface ToolDefinitionsKey {
  platform: Platform;
  mode: PromptMode;
}

/** What the registry gates read: the platform and the listed Turn tools. */
export interface ToolRegistryScope {
  platform: Platform;
  listedTools: TurnBehavior["tools"];
}

interface StaticToolEntry {
  /** Whether the Turn has the tool. Omitted means always. */
  when?: (scope: ToolRegistryScope) => boolean;
  definition: (scope: ToolRegistryScope) => StaticZodToolDefinition;
}

interface RunBuiltToolEntry {
  runBuilt: true;
  /** The tool name, when it differs from the slot key. */
  name?: string;
}

const RUN_BUILT = { runBuilt: true } as const;

/** Narrow a Turn tool mode that a registry gate has already checked. */
export function enabledMode<T extends string>(mode: T | "none"): T {
  if (mode === "none") throw new Error("The Turn does not have this tool");
  return mode;
}

function always(definition: StaticZodToolDefinition): StaticToolEntry {
  return { definition: () => definition };
}

const slackOnly = ({ platform }: ToolRegistryScope) => platform === "slack";
const hasEvents = () => hasEventCatalogEntries(getEventCatalog());
const hasAgents = ({ listedTools }: ToolRegistryScope) =>
  listedTools.agents !== "none";
const hasChildAgents = ({ listedTools }: ToolRegistryScope) =>
  listedTools.agents === "children" ||
  listedTools.agents === "children_and_parent";

// Write tools exist when the deployment has a workspace provider.
function workspaceTool(
  name: "createWorkspace" | "updateWorkspace" | "deleteWorkspace",
): StaticToolEntry {
  return {
    when: () => workspaceProviderNames() !== undefined,
    definition: () =>
      (workspaceToolDefinitions() as Record<string, StaticZodToolDefinition>)[
        name
      ]!,
  };
}

// The order of the entries is the order of the tools in the provider
// request, which the provider caches. Moving an entry costs one cache write
// in each Conversation. `sendFiles` has a slot for each platform, so both
// keep the order that they had.
const CORE_TOOLS = {
  loadSkill: RUN_BUILT,
  updatePlan: always(updatePlanToolDefinition),
  reportProgress: always(reportProgressToolDefinition),
  systemTime: always(systemTimeToolDefinition),
  submitFeedback: always(submitFeedbackToolDefinition),
  bash: always(bashToolDefinition),
  readFile: always(readFileToolDefinition),
  editFile: always(editFileToolDefinition),
  writeFile: always(writeFileToolDefinition),
  webSearch: always(webSearchToolDefinition),
  webFetch: always(webFetchToolDefinition),
  watchTimer: always(watchTimerToolDefinition),
  searchEventTypes: {
    when: hasEvents,
    definition: () => searchEventTypesToolDefinition(getEventCatalog()),
  },
  watchEvents: {
    when: hasEvents,
    definition: () => watchEventsToolDefinition(getEventCatalog()),
  },
  listWatches: always(listWatchesToolDefinition),
  stopWatchingResources: always(stopWatchingResourcesToolDefinition),
  createAutomation: RUN_BUILT,
  searchAutomations: always(searchAutomationsToolDefinition),
  updateAutomation: RUN_BUILT,
  deleteAutomation: always(deleteAutomationToolDefinition),
  runAutomationNow: always(runAutomationNowToolDefinition),
  createWorkspace: workspaceTool("createWorkspace"),
  updateWorkspace: workspaceTool("updateWorkspace"),
  deleteWorkspace: workspaceTool("deleteWorkspace"),
  listWorkspaces: {
    definition: () => workspaceToolDefinitions().listWorkspaces,
  },
  switchWorkspace: {
    definition: () => workspaceToolDefinitions().switchWorkspace,
  },
  runOperatorSql: {
    when: () => isExperimentalFeatureEnabled("operator-tools"),
    definition: () => runOperatorSqlToolDefinition,
  },
  updateUserCustomization: {
    when: ({ listedTools }) =>
      isExperimentalFeatureEnabled("user-customization") &&
      listedTools.userCustomization,
    definition: () => updateUserCustomizationToolDefinition,
  },
  setConversationSubscription: {
    when: ({ listedTools }) => listedTools.subscriptions,
    definition: () => setConversationSubscriptionToolDefinition,
  },
  searchConversationEvents: always(searchConversationEventsToolDefinition),
  readConversationEvent: always(readConversationEventToolDefinition),
  searchConversations: {
    definition: ({ platform }) =>
      searchConversationsToolDefinition(
        platform === "slack" ? slackConversationSearchChannelFilter : undefined,
      ),
  },
  createPreview: RUN_BUILT,
  viewImage: RUN_BUILT,
  imageGenerate: RUN_BUILT,
  localSendFiles: { runBuilt: true, name: "sendFiles" },
  loadAttachment: RUN_BUILT,
  publishImage: RUN_BUILT,
  unpublishImage: RUN_BUILT,
  transcribeAudio: RUN_BUILT,
  spawnAgent: {
    when: hasChildAgents,
    definition: () => spawnAgentToolDefinition,
  },
  stopAgent: {
    when: hasChildAgents,
    definition: () => stopAgentToolDefinition,
  },
  archiveAgent: {
    when: hasChildAgents,
    definition: () => archiveAgentToolDefinition,
  },
  listAgents: {
    when: hasChildAgents,
    definition: () => listAgentsToolDefinition,
  },
  messageAgent: {
    when: hasAgents,
    definition: () => messageAgentToolDefinition,
  },
  [REPLY_TOOL_NAME]: {
    when: ({ listedTools }) => listedTools.reply !== "none",
    definition: ({ listedTools }) =>
      replyToolDefinition(enabledMode(listedTools.reply)),
  },
  [REPORT_BLOCKED_TOOL_NAME]: {
    when: ({ listedTools }) => listedTools.reportBlocked !== "none",
    definition: ({ listedTools }) =>
      reportBlockedToolDefinition(enabledMode(listedTools.reportBlocked)),
  },
  [NO_REPLY_TOOL_NAME]: {
    when: ({ listedTools }) => listedTools.noReply,
    definition: () => noReplyToolDefinition,
  },
  searchMcpTools: RUN_BUILT,
  callMcpTool: RUN_BUILT,
  slackCanvasRead: {
    when: slackOnly,
    definition: () => slackCanvasReadToolDefinition,
  },
  slackCanvasEdit: {
    when: slackOnly,
    definition: () => slackCanvasEditToolDefinition,
  },
  slackCanvasWrite: {
    when: slackOnly,
    definition: () => slackCanvasWriteToolDefinition,
  },
  slackThreadRead: {
    when: slackOnly,
    definition: () => slackThreadReadToolDefinition,
  },
  slackChannelJoin: {
    when: slackOnly,
    definition: () => slackChannelJoinToolDefinition,
  },
  searchConversationMessages: {
    when: slackOnly,
    definition: () => searchConversationMessagesToolDefinition,
  },
  slackPublicSearch: {
    when: slackOnly,
    definition: () => slackPublicSearchToolDefinition,
  },
  userLookup: {
    when: slackOnly,
    definition: () => userLookupToolDefinition(userLookupIdentityProviders()),
  },
  slackListCreate: {
    when: slackOnly,
    definition: () => slackListCreateToolDefinition,
  },
  slackListAddItems: {
    when: slackOnly,
    definition: () => slackListAddItemsToolDefinition,
  },
  slackListGetItems: {
    when: slackOnly,
    definition: () => slackListGetItemsToolDefinition,
  },
  slackListUpdateItem: {
    when: slackOnly,
    definition: () => slackListUpdateItemToolDefinition,
  },
  slackCanvasCreate: RUN_BUILT,
  sendFiles: RUN_BUILT,
  slackChannelListMessages: {
    when: slackOnly,
    definition: () => slackChannelListMessagesToolDefinition,
  },
  addReaction: RUN_BUILT,
  addReviewItem: always(addReviewItemToolDefinition),
  searchReviewItems: always(searchReviewItemsToolDefinition),
  updateReviewItem: always(updateReviewItemToolDefinition),
  // Only a Turn whose `only` list names it lists it, such as a Lead's.
  startConversation: {
    when: ({ listedTools }) =>
      listedTools.only?.includes("startConversation") === true,
    definition: () => startConversationToolDefinition,
  },
} satisfies Record<string, StaticToolEntry | RunBuiltToolEntry>;

type CoreToolSlotKey = keyof typeof CORE_TOOLS;

/** Names of the core tools that the registry defines. */
export type StaticToolName = {
  [K in CoreToolSlotKey]: (typeof CORE_TOOLS)[K] extends RunBuiltToolEntry
    ? never
    : K;
}[CoreToolSlotKey];

/** Slots of the core tools that each run builds. */
export type RunBuiltToolSlot = Exclude<CoreToolSlotKey, StaticToolName>;

/** One core tool slot of a Turn, in provider order. */
export type CoreToolSlot =
  | { kind: "static"; name: StaticToolName }
  | { kind: "run_built"; slot: RunBuiltToolSlot; name: string };

function isRunBuilt(
  entry: StaticToolEntry | RunBuiltToolEntry,
): entry is RunBuiltToolEntry {
  return "runBuilt" in entry;
}

/** Names of the core tools that each run builds. They are not in the registry. */
export const RUN_BUILT_TOOL_NAMES: readonly string[] = [
  ...new Set(
    Object.entries(CORE_TOOLS).flatMap(([slot, entry]) =>
      isRunBuilt(entry) ? [entry.name ?? slot] : [],
    ),
  ),
];

// A Turn with an `only` list lists only those core tools, and no run-built
// tool.
function coreToolEntries(scope: ToolRegistryScope) {
  const { only } = scope.listedTools;
  return (
    Object.entries(CORE_TOOLS) as Array<
      [CoreToolSlotKey, StaticToolEntry | RunBuiltToolEntry]
    >
  ).filter(
    ([key, entry]) => !only || (!isRunBuilt(entry) && only.includes(key)),
  );
}

/**
 * Return the core tool slots of a Turn in provider order: each static tool
 * that the registry gates allow, and each run-built slot, which the run
 * fills or leaves empty.
 */
export function coreToolSlots(scope: ToolRegistryScope): CoreToolSlot[] {
  const slots: CoreToolSlot[] = [];
  for (const [key, entry] of coreToolEntries(scope)) {
    if (isRunBuilt(entry)) {
      slots.push({
        kind: "run_built",
        slot: key as RunBuiltToolSlot,
        name: entry.name ?? key,
      });
    } else if (!entry.when || entry.when(scope)) {
      slots.push({ kind: "static", name: key as StaticToolName });
    }
  }
  return slots;
}

function modelFacing(definition: StaticZodToolDefinition) {
  // `zodTool` accepts a definition with or without an output schema; the
  // overloads only split them for the type of `execute`.
  return zodTool(definition as StaticZodToolDefinition<ZodTypeAny, ZodTypeAny>);
}

/**
 * Return the static tool definitions of this deployment for one platform
 * and Prompt mode, with no run context: core and plugin tools, keyed by tool
 * name, in provider order. Run-built tools are not in it.
 */
export function staticToolDefinitions(key: ToolDefinitionsKey): ToolRegistry {
  const scope = {
    platform: key.platform,
    listedTools: promptModeTurnTools(key.mode),
  };
  const core: ToolRegistry = {};
  for (const [name, entry] of coreToolEntries(scope)) {
    if (isRunBuilt(entry) || (entry.when && !entry.when(scope))) continue;
    core[name] = modelFacing(entry.definition(scope));
  }
  return scope.listedTools.only
    ? core
    : { ...core, ...getStaticPluginToolDefinitions() };
}
