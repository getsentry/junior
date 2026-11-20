/** Schemas and helpers shared by the Workspace tools. */
import * as z from "zod";
import type { WatchResult } from "@sentry/junior-plugin-api";
import { logWarn } from "@/chat/logging";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { cancelWatch } from "@/chat/events/store";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { incrementStat } from "@/stats";
import { workspaceRepoCheckoutPath } from "./checkout-path";
import { WorkspaceValidationError } from "./store";
import type { Workspace } from "./types";

/** Catalog source of the deferred Workspace write tools. */
export const WORKSPACES_TOOL_SOURCE = {
  id: "workspaces",
  description: "Create, replace, or delete Workspace recipes.",
} as const;

/** Record optional reporting without changing the switchWorkspace outcome. */
export async function tryRecordWorkspaceSwitchStat(workspace: Workspace) {
  if (!process.env["DATABASE_URL"]) return;
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

/** Stop a snapshot watch. A failure is logged and does not change the tool outcome. */
export async function stopWorkspaceSnapshotWatch(input: {
  conversationId: string;
  subscriptionId: string;
}): Promise<void> {
  try {
    await cancelWatch({
      conversationId: input.conversationId,
      id: input.subscriptionId,
    });
  } catch (error) {
    logWarn("workspace.snapshot.watch.stop_failed", {
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
/** Model-facing shape of one Workspace. */
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  setup_script: z.string(),
  vcpus: z.number().nullable(),
  repos: z.array(repoSchema),
});

/** Convert a stored Workspace into its model-facing shape. */
export function view(workspace: Workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    setup_script: workspace.setupScript,
    vcpus: workspace.vcpus,
    repos: workspace.repos.map((repo) => ({
      provider: repo.provider,
      repo: repo.repo,
      checkout_path: workspaceRepoCheckoutPath(repo.repo),
    })),
  };
}

/** Return building status and any already-created snapshot subscription. */
export function buildingWorkspaceResult(input: {
  workspace: z.infer<typeof workspaceSchema>;
  subscription?: Pick<WatchResult, "id" | "events"> | null | undefined;
}) {
  return {
    workspace: input.workspace,
    status: "building" as const,
    ...(input.subscription
      ? {
          subscription: {
            id: input.subscription.id,
            events: [...input.subscription.events],
          },
        }
      : undefined),
  };
}

/** Return the plugins that can prepare a workspace, sorted, or none. */
export function workspaceProviderNames(): [string, ...string[]] | undefined {
  const providers = getPlugins()
    .filter((plugin) => plugin.hooks?.workspacePrepare)
    .map((plugin) => plugin.manifest.name)
    .sort((left, right) => left.localeCompare(right));
  if (providers.length === 0) return undefined;
  return providers as [string, ...string[]];
}

/** Input schemas of the Workspace write tools for the given repository providers. */
export function workspaceWriteSchemas(providers: [string, ...string[]]) {
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
      vcpus: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe(
          "Optional Sandbox vCPUs for this Workspace. Each vCPU adds 2 GB of memory. Omit or use null to use the app default.",
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

export type WorkspaceWriteInput = z.infer<
  ReturnType<typeof workspaceWriteSchemas>["workspaceInputSchema"]
>;

/** Convert write tool input into store input. */
export function writeInput(input: WorkspaceWriteInput) {
  return {
    name: input.name,
    ...(input.setup_script == null
      ? undefined
      : { setupScript: input.setup_script }),
    vcpus: input.vcpus ?? null,
    repos: input.repos.map((repo) => ({
      provider: repo.provider,
      repo: repo.repo,
    })),
  };
}

/** Drop null optional fields from write tool arguments before validation. */
export function prepareWorkspaceWriteArguments(
  args: unknown,
): WorkspaceWriteInput {
  const input = args as WorkspaceWriteInput;
  const prepared = { ...input };
  if (prepared.setup_script == null) {
    delete prepared.setup_script;
  }
  if (prepared.vcpus == null) {
    delete prepared.vcpus;
  }
  return prepared;
}

/** Run a store write and report validation failures as tool input errors. */
export async function workspaceWrite<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkspaceValidationError) {
      throw new ToolInputError(error.message);
    }
    throw error;
  }
}

/** Describe a Workspace write for the approval proposal. */
export function describeWorkspaceWrite(
  action: "Create" | "Replace",
  input: WorkspaceWriteInput,
): string {
  const repositories = `${input.repos.length} ${input.repos.length === 1 ? "repository" : "repositories"}`;
  const setupText = input.setup_script ? "; includes a setup script" : "";
  const vcpuText = input.vcpus ? `; ${input.vcpus} vCPUs` : "";
  return `${action} Workspace ${input.name} (${repositories}${setupText}${vcpuText}).`;
}
