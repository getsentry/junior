import type { SkillMetadata } from "@/chat/skills";
import { createImageGenerateTool } from "@/chat/tools/image-generate";
import { createLoadSkillTool } from "@/chat/tools/load-skill";
import { createSlackCanvasCreateTool } from "@/chat/tools/slack-canvas-create";
import { createSlackCanvasUpdateTool } from "@/chat/tools/slack-canvas-update";
import { createSlackListAddItemsTool } from "@/chat/tools/slack-list-add-items";
import { createSlackListCreateTool } from "@/chat/tools/slack-list-create";
import { createSlackListGetItemsTool } from "@/chat/tools/slack-list-get-items";
import { createSlackListUpdateItemTool } from "@/chat/tools/slack-list-update-item";
import type { ToolHooks, ToolRuntimeContext, ToolState } from "@/chat/tools/types";
import { createWebFetchTool } from "@/chat/tools/web-fetch";
import { createWebSearchTool } from "@/chat/tools/web-search";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";

function createToolState(
  hooks: ToolHooks,
  context: ToolRuntimeContext
): ToolState {
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
    getCurrentListId: () => artifactState.lastListId
  };
}

export type { ToolHooks, ToolRuntimeContext };

export function createTools(
  availableSkills: SkillMetadata[],
  hooks: ToolHooks = {},
  context: ToolRuntimeContext = {}
) {
  const state = createToolState(hooks, context);

  return {
    load_skill: createLoadSkillTool(availableSkills),
    web_search: createWebSearchTool(),
    web_fetch: createWebFetchTool(hooks),
    image_generate: createImageGenerateTool(hooks),
    slack_canvas_create: createSlackCanvasCreateTool(context, state),
    slack_canvas_update: createSlackCanvasUpdateTool(state),
    slack_list_create: createSlackListCreateTool(state),
    slack_list_add_items: createSlackListAddItemsTool(state),
    slack_list_get_items: createSlackListGetItemsTool(state),
    slack_list_update_item: createSlackListUpdateItemTool(state)
  };
}
