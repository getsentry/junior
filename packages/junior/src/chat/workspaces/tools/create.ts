import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { createWorkspace } from "../store";
import {
  describeWorkspaceWrite,
  prepareWorkspaceWriteArguments,
  workspaceSchema,
  workspaceView,
  workspaceWrite,
  workspaceWriteInput,
  workspaceWriteSchemas,
  WORKSPACES_TOOL_SOURCE,
} from "../tool-support";

/** Static definition of `createWorkspace` for these repository providers. */
export function createWorkspaceToolDefinition(
  providers: [string, ...string[]],
) {
  const { providerNames, workspaceInputSchema } =
    workspaceWriteSchemas(providers);
  return zodToolDefinition({
    exposure: "deferred",
    source: WORKSPACES_TOOL_SOURCE,
    approvalMode: "review",
    describe: (input) => ({
      summary: describeWorkspaceWrite("Create", input),
    }),
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

/** Build `createWorkspace` for these repository providers. */
export function createWorkspaceTool(providers: [string, ...string[]]) {
  return zodTool({
    ...createWorkspaceToolDefinition(providers),
    async execute(input) {
      const workspace = await workspaceWrite(() =>
        createWorkspace(workspaceWriteInput(input)),
      );
      return { workspace: workspaceView(workspace) };
    },
  });
}
