import type {
  AfterToolExecuteHookContext,
  PluginRegistration,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { logException, logWarn } from "@/chat/logging";
import {
  basePluginContext,
  createSandboxCapability,
  withPluginHookSpan,
} from "@/chat/plugins/hook-context";
import { createPluginDecider, createPluginModel } from "@/chat/plugins/model";
import { createPluginModelCostRecorder } from "@/chat/plugins/model-cost";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { PluginToolDeniedError } from "@/chat/tools/execution/plugin-tool-denied-error";
import { isToolInputError } from "@/chat/tools/execution/tool-input-error";
import { workspaceRepoCheckoutPath } from "@/chat/workspaces/checkout-path";
import { getWorkspace } from "@/chat/workspaces/store";
import { escapeXml } from "@/chat/xml";

/** The Run's sandbox, read when an `afterToolExecute` hook runs. */
export interface ToolHookSandbox {
  workspace: SandboxWorkspace;
  /** Active Workspace id, or undefined for an ad hoc sandbox. */
  workspaceId(): string | undefined;
}

/** The Turn whose tool calls run `afterToolExecute` hooks. */
export interface ToolHookTurn {
  conversationId: string;
  turnId: string;
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

/** Render a nudge as the marked text the agent reads. */
export function renderToolResultNudge(nudge: ToolResultNudge): string {
  return `<plugin-note plugin="${nudge.pluginName}">${escapeXml(nudge.message)}</plugin-note>`;
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
 * throws `PluginToolDeniedError` and skips later hooks. An abort stops the
 * checks and keeps the tool result.
 */
export async function runAfterToolExecuteHooks(args: {
  plugins: PluginRegistration[];
  sandbox: ToolHookSandbox;
  tool: AfterToolHookInput;
  turn: ToolHookTurn;
}): Promise<ToolResultNudge[]> {
  const hooked = args.plugins.filter(
    (plugin) => plugin.hooks?.afterToolExecute,
  );
  if (hooked.length === 0) return [];

  const { signal } = args.tool;
  const sandbox = createSandboxCapability(args.sandbox.workspace, signal);
  let workspace: AfterToolExecuteHookContext["workspace"];
  try {
    workspace = await activeWorkspace(args.sandbox);
  } catch (error) {
    // The tool already ran. Skip the checks rather than turn its result into
    // a failure that the agent retries.
    logException(error, "agent.plugin.after_tool_execute.failed", {
      "gen_ai.tool.name": args.tool.name,
    });
    return [];
  }
  const nudges: ToolResultNudge[] = [];
  for (const plugin of hooked) {
    // The tool already ran. After an abort, keep its result and skip the
    // remaining checks, so a resumed agent does not retry finished work.
    if (signal?.aborted) break;
    const pluginName = plugin.manifest.name;
    const onCost = createPluginModelCostRecorder({
      ...args.turn,
      pluginName,
      source: "afterToolExecute",
      toolName: args.tool.name,
    });
    let denial: string | undefined;
    try {
      await withPluginHookSpan(
        pluginName,
        "afterToolExecute",
        async () =>
          await plugin.hooks!.afterToolExecute!({
            ...basePluginContext(plugin),
            decider: createPluginDecider(pluginName, { onCost, signal }),
            decision: {
              deny(reason) {
                denial = reason;
              },
              nudge(message) {
                nudges.push({ message, pluginName });
              },
            },
            model: createPluginModel(pluginName, plugin.model, {
              onCost,
              signal,
            }),
            sandbox,
            ...(signal ? { signal } : undefined),
            tool: { input: args.tool.input, name: args.tool.name },
            ...(workspace ? { workspace } : undefined),
          }),
      );
    } catch (error) {
      if (signal?.aborted) break;
      // The tool already ran. A broken check must not turn its result into a
      // failure that the agent retries.
      const attributes = {
        "app.plugin.name": pluginName,
        "gen_ai.tool.name": args.tool.name,
      };
      // Expected input failures, such as an unavailable sandbox, are not
      // Sentry exceptions.
      if (isToolInputError(error)) {
        logWarn("agent.plugin.after_tool_execute.failed", {
          ...attributes,
          "error.type": "tool_input_error",
        });
      } else {
        logException(
          error,
          "agent.plugin.after_tool_execute.failed",
          attributes,
        );
      }
      continue;
    }
    if (denial !== undefined) {
      throw new PluginToolDeniedError(denial, { ran: true });
    }
  }
  return nudges;
}
