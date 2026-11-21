import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { updateWorkspace } from "../store";
import {
  describeWorkspaceWrite,
  prepareWorkspaceWriteArguments,
  workspaceSchema,
  workspaceView,
  workspaceWrite,
  workspaceWriteInput,
  workspaceWriteSchemas,
  WORKSPACES_TOOL_SOURCE,
  type WorkspaceWriteInput,
} from "../tool-support";

/** Static definition of `updateWorkspace` for these repository providers. */
export function updateWorkspaceToolDefinition(
  providers: [string, ...string[]],
) {
  const { providerNames, workspaceInputSchema } =
    workspaceWriteSchemas(providers);
  return zodToolDefinition({
    exposure: "deferred",
    source: WORKSPACES_TOOL_SOURCE,
    approvalMode: "review",
    describeProposal: ({ id: _id, ...input }) =>
      describeWorkspaceWrite("Replace", input),
    executionMode: "sequential",
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description: `Replace an install-wide Workspace recipe. Repository providers: ${providerNames}. Use the Workspace ID returned by listWorkspaces.`,
    inputSchema: workspaceInputSchema
      .extend({
        id: z.string().uuid().describe("Workspace ID from listWorkspaces."),
      })
      .strict(),
    prepareArguments(args) {
      const input = args as WorkspaceWriteInput & { id: string };
      return {
        ...prepareWorkspaceWriteArguments(input),
        id: input.id,
      };
    },
    outputSchema: juniorToolOutputSchema.extend({
      workspace: workspaceSchema,
    }),
  });
}

/** Build `updateWorkspace` for these repository providers. */
export function createUpdateWorkspaceTool(providers: [string, ...string[]]) {
  return zodTool({
    ...updateWorkspaceToolDefinition(providers),
    async execute({ id, ...input }) {
      const workspace = await workspaceWrite(() =>
        updateWorkspace(id, workspaceWriteInput(input)),
      );
      if (!workspace) {
        throw new ToolInputError(`Workspace not found: ${id}`);
      }
      return { workspace: workspaceView(workspace) };
    },
  });
}
