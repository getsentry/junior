import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { createWorkspace } from "@/chat/workspaces/store";
import {
  WORKSPACES_TOOL_SOURCE,
  workspaceSchema,
  view,
  workspaceWriteSchemas,
  writeInput,
  prepareWorkspaceWriteArguments,
  workspaceWrite,
  describeWorkspaceWrite,
} from "@/chat/workspaces/tool-support";

/**
 * Static definition of `createWorkspace`. Its text names the repository
 * providers that can prepare a Workspace.
 */
export function createWorkspaceToolDefinition(
  providers: [string, ...string[]],
) {
  const { providerNames, workspaceInputSchema } =
    workspaceWriteSchemas(providers);
  return zodToolDefinition({
    exposure: "deferred",
    source: WORKSPACES_TOOL_SOURCE,
    approvalMode: "review",
    describeProposal: (input) => describeWorkspaceWrite("Create", input),
    executionMode: "sequential",
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description: `Create an install-wide Workspace recipe. Repository providers: ${providerNames}. The Workspace becomes available to future conversations.`,
    inputSchema: workspaceInputSchema,
    prepareArguments: prepareWorkspaceWriteArguments,
    outputSchema: juniorToolOutputSchema.extend({
      workspace: workspaceSchema,
    }),
  });
}

/** Build `createWorkspace` for the repository providers that can prepare a Workspace. */
export function createCreateWorkspaceTool(providers: [string, ...string[]]) {
  return zodTool({
    ...createWorkspaceToolDefinition(providers),
    async execute(input) {
      const workspace = await workspaceWrite(() =>
        createWorkspace(writeInput(input)),
      );
      return { workspace: view(workspace) };
    },
  });
}
