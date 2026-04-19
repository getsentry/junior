import { createBashTool } from "@/chat/tools/sandbox/bash";
import { createAttachFileTool } from "@/chat/tools/sandbox/attach-file";
import type { SkillMetadata } from "@/chat/skills";
import { createImageGenerateTool } from "@/chat/tools/web/image-generate";
import { createLoadSkillTool } from "@/chat/tools/skill/load-skill";
import { createReadFileTool } from "@/chat/tools/sandbox/read-file";
import { createReportProgressTool } from "@/chat/tools/runtime/report-progress";
import { createSearchToolsTool } from "@/chat/tools/skill/search-tools";
import { createSlackChannelListMessagesTool } from "@/chat/tools/slack/channel-list-messages";
import { createSlackChannelPostMessageTool } from "@/chat/tools/slack/channel-post-message";
import { createSlackMessageAddReactionTool } from "@/chat/tools/slack/message-add-reaction";
import {
  createSlackCanvasCreateTool,
  createSlackCanvasReadTool,
  createSlackCanvasUpdateTool,
} from "@/chat/tools/slack/canvas-tools";
import {
  createSlackListAddItemsTool,
  createSlackListCreateTool,
  createSlackListGetItemsTool,
  createSlackListUpdateItemTool,
} from "@/chat/tools/slack/list-tools";
import { createSystemTimeTool } from "@/chat/tools/system-time";
import type {
  ToolHooks,
  ToolRuntimeContext,
  ToolState,
} from "@/chat/tools/types";
import { createWebFetchTool } from "@/chat/tools/web/fetch-tool";
import { createWebSearchTool } from "@/chat/tools/web/search";
import { createWriteFileTool } from "@/chat/tools/sandbox/write-file";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";

function createToolState(
  hooks: ToolHooks,
  context: ToolRuntimeContext,
): ToolState {
  const operationResultCache = new Map<string, unknown>();
  let turnCreatedCanvasId: string | undefined;
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
    getCurrentCanvasId: () => artifactState.lastCanvasId,
    getTurnCreatedCanvasId: () => turnCreatedCanvasId,
    setTurnCreatedCanvasId: (canvasId: string) => {
      turnCreatedCanvasId = canvasId;
    },
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
  const tools: Record<string, unknown> = {
    loadSkill: createLoadSkillTool(availableSkills, {
      onSkillLoaded: hooks.onSkillLoaded,
    }),
    reportProgress: createReportProgressTool(),
    systemTime: createSystemTimeTool(),
    bash: createBashTool(),
    attachFile: createAttachFileTool(context.sandbox, hooks),
    readFile: createReadFileTool(),
    writeFile: createWriteFileTool(),
    webSearch: createWebSearchTool(),
    webFetch: createWebFetchTool(hooks),
    imageGenerate: createImageGenerateTool(
      hooks,
      hooks.toolOverrides?.imageGenerate,
    ),
    slackCanvasRead: createSlackCanvasReadTool(),
    slackCanvasUpdate: createSlackCanvasUpdateTool(state, context),
    slackListCreate: createSlackListCreateTool(state),
    slackListAddItems: createSlackListAddItemsTool(state),
    slackListGetItems: createSlackListGetItemsTool(state),
    slackListUpdateItem: createSlackListUpdateItemTool(state),
  };

  if (context.mcpToolManager && context.getActiveSkills) {
    tools.searchTools = createSearchToolsTool(
      context.mcpToolManager,
      context.getActiveSkills,
    );
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

  return tools;
}
