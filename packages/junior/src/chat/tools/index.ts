import { createBashTool } from "@/chat/tools/sandbox/bash";
import { createEditFileTool } from "@/chat/tools/sandbox/edit-file";
import { createFindFilesTool } from "@/chat/tools/sandbox/find-files";
import { createGrepTool } from "@/chat/tools/sandbox/grep";
import { createAttachFileTool } from "@/chat/tools/sandbox/attach-file";
import { createListDirTool } from "@/chat/tools/sandbox/list-dir";
import type { SkillMetadata } from "@/chat/skills";
import { createImageGenerateTool } from "@/chat/tools/web/image-generate";
import { createCallMcpToolTool } from "@/chat/tools/skill/call-mcp-tool";
import { createLoadSkillTool } from "@/chat/tools/skill/load-skill";
import { createSearchMcpToolsTool } from "@/chat/tools/skill/search-mcp-tools";
import { createReadFileTool } from "@/chat/tools/sandbox/read-file";
import { createReportProgressTool } from "@/chat/tools/runtime/report-progress";
import { createSlackChannelListMessagesTool } from "@/chat/tools/slack/channel-list-messages";
import { createSlackChannelPostMessageTool } from "@/chat/tools/slack/channel-post-message";
import { createSlackMessageAddReactionTool } from "@/chat/tools/slack/message-add-reaction";
import {
  createSlackCanvasCreateTool,
  createSlackCanvasEditTool,
  createSlackCanvasReadTool,
  createSlackCanvasWriteTool,
} from "@/chat/tools/slack/canvas-tools";
import {
  createSlackListAddItemsTool,
  createSlackListCreateTool,
  createSlackListGetItemsTool,
  createSlackListUpdateItemTool,
} from "@/chat/tools/slack/list-tools";
import { createSlackThreadReadTool } from "@/chat/tools/slack/thread-read";
import { createSlackUserLookupTool } from "@/chat/tools/slack/user-lookup";
import { createSystemTimeTool } from "@/chat/tools/system-time";
import { createAdvisorTool } from "@/chat/tools/advisor/tool";
import type { ToolDefinition } from "@/chat/tools/definition";
import type {
  ToolHooks,
  ToolRuntimeContext,
  ToolState,
} from "@/chat/tools/types";
import { getAgentPluginTools } from "@/chat/plugins/agent-hooks";
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

export function createTools(
  availableSkills: SkillMetadata[],
  hooks: ToolHooks = {},
  context: ToolRuntimeContext,
) {
  const state = createToolState(hooks, context);
  const tools: Record<string, ToolDefinition<any>> = {
    loadSkill: createLoadSkillTool(availableSkills, {
      onSkillLoaded: hooks.onSkillLoaded,
    }),
    reportProgress: createReportProgressTool(),
    systemTime: createSystemTimeTool(),
    bash: createBashTool(),
    attachFile: createAttachFileTool(context.sandbox, hooks),
    readFile: createReadFileTool(),
    editFile: createEditFileTool(),
    grep: createGrepTool(),
    findFiles: createFindFilesTool(),
    listDir: createListDirTool(),
    writeFile: createWriteFileTool(),
    webSearch: createWebSearchTool(hooks.toolOverrides?.webSearch),
    webFetch: createWebFetchTool(hooks),
    imageGenerate: createImageGenerateTool(
      hooks,
      hooks.toolOverrides?.imageGenerate,
    ),
    slackCanvasRead: createSlackCanvasReadTool(),
    slackCanvasEdit: createSlackCanvasEditTool(state),
    slackCanvasWrite: createSlackCanvasWriteTool(state),
    slackThreadRead: createSlackThreadReadTool(context),
    slackUserLookup: createSlackUserLookupTool(),
    slackListCreate: createSlackListCreateTool(state),
    slackListAddItems: createSlackListAddItemsTool(state),
    slackListGetItems: createSlackListGetItemsTool(state),
    slackListUpdateItem: createSlackListUpdateItemTool(state),
  };

  if (context.advisor) {
    tools.advisor = createAdvisorTool(context.advisor);
  }

  if (context.mcpToolManager) {
    tools.searchMcpTools = createSearchMcpToolsTool(context.mcpToolManager);
    tools.callMcpTool = createCallMcpToolTool(context.mcpToolManager);
  }

  const { channelCapabilities } = context;

  if (channelCapabilities.canCreateCanvas) {
    tools.slackCanvasCreate = createSlackCanvasCreateTool(context, state);
  }

  if (channelCapabilities.canPostToChannel) {
    tools.slackChannelPostMessage = createSlackChannelPostMessageTool(
      context,
      state,
    );
    tools.slackChannelListMessages =
      createSlackChannelListMessagesTool(context);
  }

  if (channelCapabilities.canAddReactions) {
    tools.slackMessageAddReaction = createSlackMessageAddReactionTool(
      context,
      state,
    );
  }

  for (const [name, pluginTool] of Object.entries(
    getAgentPluginTools(context),
  )) {
    if (tools[name]) {
      throw new Error(
        `Trusted plugin tool "${name}" conflicts with a core tool`,
      );
    }
    tools[name] = pluginTool;
  }

  return tools;
}
