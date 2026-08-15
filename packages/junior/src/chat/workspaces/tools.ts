import { z } from "zod";
import { getDb } from "@/chat/db";
import { logWarn } from "@/chat/logging";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { incrementStat } from "@/stats";
import { workspaceRepoCheckoutPath } from "./checkout-path";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspaceByName,
  listWorkspaces,
  updateWorkspace,
  WorkspaceValidationError,
} from "./store";
import type { Workspace } from "./types";

/** Record optional reporting without changing the switchWorkspace outcome. */
async function tryRecordWorkspaceSwitchStat(workspace: Workspace) {
  if (!process.env.DATABASE_URL) return;
  try {
    await incrementStat({
      namespace: "junior",
      metric: "workspace_switch",
      name: workspace.id,
    });
  } catch (error) {
    logWarn("workspace.switch.stat.failed", {
      "app.workspace.id": workspace.id,
      "app.workspace.name": workspace.name,
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  }
}

const repoSchema = z.object({
  provider: z.string(),
  repo: z.string(),
  checkout_path: z.string(),
});
const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  setup_script: z.string(),
  repos: z.array(repoSchema),
});

function view(workspace: Workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    setup_script: workspace.setupScript,
    repos: workspace.repos.map((repo) => ({
      provider: repo.provider,
      repo: repo.repo,
      checkout_path: workspaceRepoCheckoutPath(repo.repo),
    })),
  };
}

function workspaceProviderNames(): [string, ...string[]] | undefined {
  const providers = getPlugins()
    .filter((plugin) => plugin.hooks?.workspacePrepare)
    .map((plugin) => plugin.manifest.name)
    .sort((left, right) => left.localeCompare(right));
  if (providers.length === 0) return undefined;
  return providers as [string, ...string[]];
}

function workspaceWriteSchemas(providers: [string, ...string[]]) {
  const providerNames = providers
    .map((provider) => `\`${provider}\``)
    .join(", ");
  const repoInputSchema = z
    .object({
      provider: z
        .enum(providers)
        .describe(`Repository provider. Supported: ${providerNames}.`),
      repo: z
        .string()
        .trim()
        .min(1)
        .describe("Repository in owner/name format."),
    })
    .strict();
  const workspaceInputSchema = z
    .object({
      name: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Workspace name. Use lowercase letters, digits, underscores, or hyphens.",
        ),
      setup_script: z
        .string()
        .nullable()
        .describe(
          "Optional shell script to run after repository checkout whenever this Workspace starts. Omit or use null for no setup script.",
        )
        .optional(),
      repos: z
        .array(repoInputSchema)
        .max(32)
        .describe("Complete repository list."),
    })
    .strict();
  return { providerNames, workspaceInputSchema };
}

type WorkspaceWriteInput = z.infer<
  ReturnType<typeof workspaceWriteSchemas>["workspaceInputSchema"]
>;

function writeInput(input: WorkspaceWriteInput) {
  return {
    name: input.name,
    ...(input.setup_script == null ? {} : { setupScript: input.setup_script }),
    repos: input.repos.map((repo) => ({
      provider: repo.provider,
      repo: repo.repo,
    })),
  };
}

function prepareWorkspaceWriteArguments(args: unknown): WorkspaceWriteInput {
  const input = args as WorkspaceWriteInput;
  const prepared = { ...input };
  if (prepared.setup_script == null) {
    delete prepared.setup_script;
  }
  return prepared;
}

async function workspaceWrite<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkspaceValidationError) {
      throw new ToolInputError(error.message);
    }
    throw error;
  }
}

function describeWorkspaceWrite(
  action: "Create" | "Replace",
  input: WorkspaceWriteInput,
): string {
  const repositories = `${input.repos.length} ${input.repos.length === 1 ? "repository" : "repositories"}`;
  const setupText = input.setup_script ? "; includes a setup script" : "";
  return `${action} Workspace ${input.name} (${repositories}${setupText}).`;
}

/** Build create/update/delete tools for the currently preparable repository providers. */
function createWorkspaceWriteTools(
  providers: [string, ...string[]],
): ToolRegistry {
  const { providerNames, workspaceInputSchema } =
    workspaceWriteSchemas(providers);
  return {
    createWorkspace: zodTool({
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
      async execute(input) {
        const workspace = await workspaceWrite(() =>
          createWorkspace(writeInput(input)),
        );
        return { workspace: view(workspace) };
      },
    }),
    updateWorkspace: zodTool({
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
      async execute({ id, ...input }) {
        const workspace = await workspaceWrite(() =>
          updateWorkspace(id, writeInput(input)),
        );
        if (!workspace) {
          throw new ToolInputError(`Workspace not found: ${id}`);
        }
        return { workspace: view(workspace) };
      },
    }),
    deleteWorkspace: zodTool({
      approvalMode: "review",
      describeProposal: ({ id }) => `Delete Workspace ${id}.`,
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
      async execute({ id }) {
        const deleted = await workspaceWrite(() => deleteWorkspace(id));
        if (!deleted) {
          throw new ToolInputError(`Workspace not found: ${id}`);
        }
        return { deleted: true as const };
      },
    }),
  };
}

/** Build tools for listing, writing, and selecting registered workspaces. */
export function createWorkspaceTools(
  context: ToolRuntimeContext,
): ToolRegistry {
  if (!context.workspaces) return {};
  const providers = workspaceProviderNames();
  return {
    ...(providers ? createWorkspaceWriteTools(providers) : {}),
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
        await tryRecordWorkspaceSwitchStat(workspace);
        return { workspace: view(workspace) };
      },
    }),
  };
}
