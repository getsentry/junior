import type {
  AfterToolExecuteHookContext,
  PluginRegistration,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { logException } from "@/chat/logging";
import {
  basePluginContext,
  createSandboxCapability,
  withPluginHookSpan,
} from "@/chat/plugins/hook-context";
import { createPluginDecider, createPluginModel } from "@/chat/plugins/model";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { PluginToolDeniedError } from "@/chat/tools/execution/plugin-tool-denied-error";
import { workspaceRepoCheckoutPath } from "@/chat/workspaces/checkout-path";
import { getWorkspace } from "@/chat/workspaces/store";

/** The Run's sandbox, read when an `afterToolExecute` hook runs. */
export interface ToolHookSandbox {
  workspace: SandboxWorkspace;
  /** Active Workspace id, or undefined for an ad hoc sandbox. */
  workspaceId(): string | undefined;
}

/** One finished tool call, as `afterToolExecute` hooks see it. */
export interface AfterToolHookInput {
  input: Record<string, unknown>;
  name: string;
  signal?: AbortSignal;
}

/** Guidance from one plugin to add after the tool result. */
export interface ToolResultNudge {
  message: string;
  pluginName: string;
}

async function activeWorkspace(
  sandbox: ToolHookSandbox,
): Promise<AfterToolExecuteHookContext["workspace"]> {
  const id = sandbox.workspaceId();
  const workspace = id ? await getWorkspace(getDb(), id) : undefined;
  if (!workspace) return undefined;
  return {
    name: workspace.name,
    repos: workspace.repos.map((repo) => ({
      path: workspaceRepoCheckoutPath(repo.repo),
      provider: repo.provider,
      repo: repo.repo,
    })),
  };
}

/**
 * Run each plugin's `afterToolExecute` hook in registration order. A denial
 * throws `PluginToolDeniedError` and skips later hooks.
 */
export async function runAfterToolExecuteHooks(args: {
  plugins: PluginRegistration[];
  sandbox: ToolHookSandbox;
  tool: AfterToolHookInput;
}): Promise<ToolResultNudge[]> {
  const hooked = args.plugins.filter(
    (plugin) => plugin.hooks?.afterToolExecute,
  );
  if (hooked.length === 0) return [];

  const { signal } = args.tool;
  const sandbox = createSandboxCapability(args.sandbox.workspace, signal);
  const workspace = await activeWorkspace(args.sandbox);
  const nudges: ToolResultNudge[] = [];
  for (const plugin of hooked) {
    const pluginName = plugin.manifest.name;
    let denial: string | undefined;
    try {
      await withPluginHookSpan(
        pluginName,
        "afterToolExecute",
        async () =>
          await plugin.hooks!.afterToolExecute!({
            ...basePluginContext(plugin),
            decider: createPluginDecider(pluginName, { signal }),
            decision: {
              deny(reason) {
                denial = reason;
              },
              nudge(message) {
                nudges.push({ message, pluginName });
              },
            },
            model: createPluginModel(pluginName, plugin.model, { signal }),
            sandbox,
            ...(signal ? { signal } : undefined),
            tool: { input: args.tool.input, name: args.tool.name },
            ...(workspace ? { workspace } : undefined),
          }),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      // The tool already ran. A broken check must not turn its result into a
      // failure that the agent retries.
      logException(error, "agent.plugin.after_tool_execute.failed", {
        "app.plugin.name": pluginName,
        "gen_ai.tool.name": args.tool.name,
      });
      continue;
    }
    if (denial !== undefined) {
      throw new PluginToolDeniedError(denial, { ran: true });
    }
  }
  return nudges;
}
