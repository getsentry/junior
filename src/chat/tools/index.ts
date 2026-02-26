import { createBashTool } from "@/chat/tools/bash";
import type { SkillMetadata } from "@/chat/skills";
import { createFinalAnswerTool } from "@/chat/tools/final-answer";
import { createImageGenerateTool } from "@/chat/tools/image-generate";
import { createLoadSkillTool } from "@/chat/tools/load-skill";
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
    await hooks.onToolCallStart?.(toolName);
    try {
      return await originalExecute(...args);
    } finally {
      await hooks.onToolCallEnd?.(toolName);
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
    final_answer: createFinalAnswerTool(),
    load_skill: wrapToolExecution(
      "load_skill",
      createLoadSkillTool(context.sandbox, availableSkills),
      hooks
    ),
    system_time: wrapToolExecution("system_time", createSystemTimeTool(), hooks),
    bash: wrapToolExecution("bash", createBashTool(), hooks),
    web_search: wrapToolExecution("web_search", createWebSearchTool(), hooks),
    web_fetch: wrapToolExecution("web_fetch", createWebFetchTool(hooks), hooks),
    image_generate: wrapToolExecution("image_generate", createImageGenerateTool(hooks), hooks),
    slack_canvas_create: wrapToolExecution(
      "slack_canvas_create",
      createSlackCanvasCreateTool(context, state),
      hooks
    ),
    slack_canvas_update: wrapToolExecution("slack_canvas_update", createSlackCanvasUpdateTool(state), hooks),
    slack_list_create: wrapToolExecution("slack_list_create", createSlackListCreateTool(state), hooks),
    slack_list_add_items: wrapToolExecution("slack_list_add_items", createSlackListAddItemsTool(state), hooks),
    slack_list_get_items: wrapToolExecution("slack_list_get_items", createSlackListGetItemsTool(state), hooks),
    slack_list_update_item: wrapToolExecution(
      "slack_list_update_item",
      createSlackListUpdateItemTool(state),
      hooks
    )
  };
}
