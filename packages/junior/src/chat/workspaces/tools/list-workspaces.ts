import * as z from "zod";
import { getDb } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { listWorkspaces } from "@/chat/workspaces/store";
import { workspaceSchema, view } from "@/chat/workspaces/tool-support";

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

/** Build `listWorkspaces` for a Run that can select Workspaces. */
export function createListWorkspacesTool(context: ToolRuntimeContext) {
  return zodTool({
    ...listWorkspacesToolDefinition,
    async execute() {
      return {
        active_workspace_id: context.workspaces!.activeWorkspaceId() ?? null,
        workspaces: (await listWorkspaces(getDb())).map(view),
      };
    },
  });
}
