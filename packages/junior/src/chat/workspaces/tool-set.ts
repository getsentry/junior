import type { ToolRegistry } from "@/chat/tool-support/definition";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { workspaceProviderNames } from "@/chat/workspaces/tool-support";
import {
  createCreateWorkspaceTool,
  createWorkspaceToolDefinition,
} from "@/chat/workspaces/tools/create-workspace";
import {
  createDeleteWorkspaceTool,
  deleteWorkspaceToolDefinition,
} from "@/chat/workspaces/tools/delete-workspace";
import {
  createListWorkspacesTool,
  listWorkspacesToolDefinition,
} from "@/chat/workspaces/tools/list-workspaces";
import {
  createSwitchWorkspaceTool,
  switchWorkspaceToolDefinition,
} from "@/chat/workspaces/tools/switch-workspace";
import {
  createUpdateWorkspaceTool,
  updateWorkspaceToolDefinition,
} from "@/chat/workspaces/tools/update-workspace";

/**
 * Static definitions of the Workspace tools. The write tools exist when a
 * plugin can prepare repositories, and their text names those providers.
 */
export function workspaceToolDefinitions() {
  const providers = workspaceProviderNames();
  return {
    ...(providers
      ? {
          createWorkspace: createWorkspaceToolDefinition(providers),
          updateWorkspace: updateWorkspaceToolDefinition(providers),
          deleteWorkspace: deleteWorkspaceToolDefinition,
        }
      : undefined),
    listWorkspaces: listWorkspacesToolDefinition,
    switchWorkspace: switchWorkspaceToolDefinition,
  };
}

/** Build tools for listing, writing, and selecting registered workspaces. */
export function createWorkspaceTools(
  context: ToolRuntimeContext,
): ToolRegistry {
  if (!context.workspaces) return {};
  const providers = workspaceProviderNames();
  return {
    ...(providers
      ? {
          createWorkspace: createCreateWorkspaceTool(providers),
          updateWorkspace: createUpdateWorkspaceTool(providers),
          deleteWorkspace: createDeleteWorkspaceTool(),
        }
      : undefined),
    listWorkspaces: createListWorkspacesTool(context),
    switchWorkspace: createSwitchWorkspaceTool(context),
  };
}
