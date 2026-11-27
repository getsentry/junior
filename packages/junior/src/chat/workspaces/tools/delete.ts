import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { deleteWorkspace } from "../store";
import { workspaceWrite, WORKSPACES_TOOL_SOURCE } from "../tool-support";

/** Static definition of `deleteWorkspace`. */
export const deleteWorkspaceToolDefinition = zodToolDefinition({
  exposure: "deferred",
  source: WORKSPACES_TOOL_SOURCE,
  approvalMode: "review",
  describeCall: ({ id }) => ({
    effect: "delete",
    summary: `Delete Workspace ${id}.`,
  }),
  executionMode: "sequential",
  annotations: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Delete one install-wide Workspace recipe. Use the Workspace ID returned by listWorkspaces.",
  inputSchema: z
    .object({
      id: z.string().uuid().describe("Workspace ID from listWorkspaces."),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema.extend({
    deleted: z.literal(true),
  }),
});

/** Build `deleteWorkspace`. */
export function createDeleteWorkspaceTool() {
  return zodTool({
    ...deleteWorkspaceToolDefinition,
    async execute({ id }) {
      const deleted = await workspaceWrite(() => deleteWorkspace(id));
      if (!deleted) {
        throw new ToolInputError(
          `Workspace not found: ${id}. Use listWorkspaces to find its ID.`,
        );
      }
      return { deleted: true as const };
    },
  });
}
