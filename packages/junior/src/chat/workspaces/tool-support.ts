/** Shared schemas, views, and write handling of the Workspace tools. */
import * as z from "zod";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { workspaceRepoCheckoutPath } from "./checkout-path";
import { WorkspaceValidationError } from "./store";
import type { Workspace } from "./types";

/** Catalog source of the deferred Workspace write tools. */
export const WORKSPACES_TOOL_SOURCE = {
  id: "workspaces",
  description: "Create, replace, or delete Workspace recipes.",
} as const;

const repoSchema = z.object({
  provider: z.string(),
  repo: z.string(),
  checkout_path: z.string(),
});
/** Model-visible fields of one Workspace. */
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  setup_script: z.string(),
  vcpus: z.number().nullable(),
  repos: z.array(repoSchema),
});

/** Return the model-visible fields of one Workspace. */
export function workspaceView(workspace: Workspace) {
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

/** Return the plugins that can prepare a workspace, sorted, or none. */
export function workspaceProviderNames(): [string, ...string[]] | undefined {
  const providers = getPlugins()
    .filter((plugin) => plugin.hooks?.workspacePrepare)
    .map((plugin) => plugin.manifest.name)
    .sort((left, right) => left.localeCompare(right));
  if (providers.length === 0) return undefined;
  return providers as [string, ...string[]];
}

/** Build the input schema of the Workspace write tools for these providers. */
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

/** Input of a Workspace create or replace. */
export type WorkspaceWriteInput = z.infer<
  ReturnType<typeof workspaceWriteSchemas>["workspaceInputSchema"]
>;

/** Map write tool input to store input. */
export function workspaceWriteInput(input: WorkspaceWriteInput) {
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

/** Drop null optional fields before the input schema runs. */
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

/** Run a store write, and report validation failures to the model. */
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

/** Describe a Workspace create or replace for action review. */
export function describeWorkspaceWrite(
  action: "Create" | "Replace",
  input: WorkspaceWriteInput,
): string {
  const repositories = `${input.repos.length} ${input.repos.length === 1 ? "repository" : "repositories"}`;
  const setupText = input.setup_script ? "; includes a setup script" : "";
  const vcpuText = input.vcpus ? `; ${input.vcpus} vCPUs` : "";
  return `${action} Workspace ${input.name} (${repositories}${setupText}${vcpuText}).`;
}
