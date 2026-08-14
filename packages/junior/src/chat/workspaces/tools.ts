import { z } from "zod";
import { getDb } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { workspaceRepoCheckoutPath } from "./checkout-path";
import { getWorkspaceByName, listWorkspaces } from "./store";
import type { Workspace } from "./types";

const repoSchema = z.object({
  provider: z.string(),
  repo: z.string(),
  checkout_path: z.string(),
});
const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  repos: z.array(repoSchema),
});

function view(workspace: Workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    repos: workspace.repos.map((repo) => ({
      provider: repo.provider,
      repo: repo.repo,
      checkout_path: workspaceRepoCheckoutPath(repo.repo),
    })),
  };
}

/** Build tools for listing and selecting registered workspaces. */
export function createWorkspaceTools(
  context: ToolRuntimeContext,
): ToolRegistry {
  if (!context.workspaces) return {};
  return {
    listWorkspaces: zodTool({
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
      async execute() {
        return {
          active_workspace_id: context.workspaces!.activeWorkspaceId() ?? null,
          workspaces: (await listWorkspaces(getDb())).map(view),
        };
      },
    }),
    switchWorkspace: zodTool({
      executionMode: "sequential",
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Replace the current sandbox with a named preconfigured repository workspace. Files in the prior sandbox do not carry over.",
      inputSchema: z
        .object({
          name: z.string().trim().min(1).describe("Exact workspace name."),
        })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        workspace: workspaceSchema,
      }),
      async execute({ name }, options) {
        const workspace = await getWorkspaceByName(getDb(), name);
        if (!workspace)
          throw new ToolInputError(`Workspace not found: ${name}`);
        await context.workspaces!.switch(workspace, options.signal);
        return { workspace: view(workspace) };
      },
    }),
  };
}
