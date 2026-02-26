import { createBashTool } from "@/chat/tools/bash";
import type { SkillMetadata } from "@/chat/skills";
import { createImageGenerateTool } from "@/chat/tools/image-generate";
import { createLoadSkillTool } from "@/chat/tools/load-skill";
import { createReadFileTool } from "@/chat/tools/read-file";
import { createSlackCanvasCreateTool } from "@/chat/tools/slack-canvas-create";
import { createSlackCanvasUpdateTool } from "@/chat/tools/slack-canvas-update";
import { createSlackListAddItemsTool } from "@/chat/tools/slack-list-add-items";
import { createSlackListCreateTool } from "@/chat/tools/slack-list-create";
import { createSlackListGetItemsTool } from "@/chat/tools/slack-list-get-items";
import { createSlackListUpdateItemTool } from "@/chat/tools/slack-list-update-item";
import { createSystemTimeTool } from "@/chat/tools/system-time";
import type { ToolHooks, ToolRuntimeContext, ToolState } from "@/chat/tools/types";
import { createWebFetchTool } from "@/chat/tools/web-fetch";
import { createWebSearchTool } from "@/chat/tools/web-search";
import { createWriteFileTool } from "@/chat/tools/write-file";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";

function createToolState(
  hooks: ToolHooks,
  context: ToolRuntimeContext
): ToolState {
  const operationResultCache = new Map<string, unknown>();
  const artifactState: ThreadArtifactsState = {
    ...(context.artifactState ?? {}),
    listColumnMap: {
      ...(context.artifactState?.listColumnMap ?? {})
    }
  };

  const patchArtifactState = (patch: Partial<ThreadArtifactsState>) => {
    Object.assign(artifactState, patch);
    if (patch.listColumnMap) {
      artifactState.listColumnMap = {
        ...(artifactState.listColumnMap ?? {}),
        ...patch.listColumnMap
      };
    }
    hooks.onArtifactStatePatch?.(patch);
  };

  return {
    artifactState,
    patchArtifactState,
    getCurrentCanvasId: () => artifactState.lastCanvasId,
    getCurrentListId: () => artifactState.lastListId,
    getOperationResult: <T>(operationKey: string): T | undefined => operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey: string, result: unknown) => {
      operationResultCache.set(operationKey, result);
    }
  };
}

export type { ToolHooks, ToolRuntimeContext };

function wrapToolExecution<T>(
  toolName: string,
  toolDef: T,
  hooks: ToolHooks
): T {
  const maybeExecutable = toolDef as T & {
    execute?: (...args: any[]) => Promise<unknown> | unknown;
  };

  if (!maybeExecutable.execute) {
    return toolDef;
  }

  const originalExecute = maybeExecutable.execute.bind(toolDef);
  maybeExecutable.execute = async (...args: any[]) => {
    const input = args[0];
    await hooks.onToolCallStart?.(toolName, input);
    try {
      return await originalExecute(...args);
    } finally {
      await hooks.onToolCallEnd?.(toolName, input);
    }
  };

  return toolDef;
}

export function createTools(
  availableSkills: SkillMetadata[],
  hooks: ToolHooks = {},
  context: ToolRuntimeContext
) {
  const state = createToolState(hooks, context);
  return {
    loadSkill: wrapToolExecution(
      "loadSkill",
      createLoadSkillTool(context.sandbox, availableSkills, {
        onSkillLoaded: hooks.onSkillLoaded
      }),
      hooks
    ),
    systemTime: wrapToolExecution("systemTime", createSystemTimeTool(), hooks),
    bash: wrapToolExecution("bash", createBashTool(), hooks),
    readFile: wrapToolExecution("readFile", createReadFileTool(), hooks),
    writeFile: wrapToolExecution("writeFile", createWriteFileTool(), hooks),
    webSearch: wrapToolExecution("webSearch", createWebSearchTool(), hooks),
    webFetch: wrapToolExecution("webFetch", createWebFetchTool(hooks), hooks),
    imageGenerate: wrapToolExecution("imageGenerate", createImageGenerateTool(hooks), hooks),
    slackCanvasCreate: wrapToolExecution(
      "slackCanvasCreate",
      createSlackCanvasCreateTool(context, state),
      hooks
    ),
    slackCanvasUpdate: wrapToolExecution("slackCanvasUpdate", createSlackCanvasUpdateTool(state), hooks),
    slackListCreate: wrapToolExecution("slackListCreate", createSlackListCreateTool(state), hooks),
    slackListAddItems: wrapToolExecution("slackListAddItems", createSlackListAddItemsTool(state), hooks),
    slackListGetItems: wrapToolExecution("slackListGetItems", createSlackListGetItemsTool(state), hooks),
    slackListUpdateItem: wrapToolExecution(
      "slackListUpdateItem",
      createSlackListUpdateItemTool(state),
      hooks
    )
  };
}
