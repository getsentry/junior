import * as z from "zod";
import { getDb } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { listWorkspaces } from "../store";
import { workspaceSchema, workspaceView } from "../tool-support";

/** Static definition of `listWorkspaces`. */
export const listWorkspacesToolDefinition = zodToolDefinition({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  description:
    "List named repository workspaces that can replace the current sandbox.",
  inputSchema: z.object({}).strict(),
  outputSchema: juniorToolOutputSchema.extend({
    active_workspace_id: z.string().nullable(),
    workspaces: z.array(workspaceSchema),
  }),
});

/** Build `listWorkspaces` for the Run's Workspace switcher. */
export function createListWorkspacesTool(
  workspaces: NonNullable<ToolRuntimeContext["workspaces"]>,
) {
  return zodTool({
    ...listWorkspacesToolDefinition,
    async execute() {
      return {
        active_workspace_id: workspaces.activeWorkspaceId() ?? null,
        workspaces: (await listWorkspaces(getDb())).map(workspaceView),
      };
    },
  });
}
