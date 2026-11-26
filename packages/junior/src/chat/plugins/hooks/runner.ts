/** Plugin hooks around tool calls and Sandbox setup. */
import type {
  OwnedObjectAnnotation,
  PluginMcpContent,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { saveObjectAnnotations } from "@/chat/conversations/annotation-results";
import { logInfo, logWarn } from "@/chat/logging";
import {
  runAfterToolExecuteHooks,
  type AfterToolHookInput,
  type ToolHookSandbox,
  type ToolHookTurn,
  type ToolResultNudge,
} from "@/chat/plugins/after-tool-hooks";
import {
  basePluginContext,
  createSandboxCapability,
  withPluginHookSpan,
} from "@/chat/plugins/hook-context";
import { SANDBOX_JUNIOR_ROOT } from "@/chat/sandbox/paths";
import { PluginToolDeniedError } from "@/chat/tool-support/plugin-tool-denied-error";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { readActorIdentity } from "@/chat/plugins/viewer";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { Actor } from "@/chat/actor";
import { workspaceRepoCheckoutPath } from "@/chat/workspaces/checkout-path";
import { getRegistrations } from "./registry";

export interface ToolHookInput {
  input: Record<string, unknown>;
  name: string;
}

export interface ToolHookResult {
  /** Hook-injected environment values applied only during execution. */
  env: Record<string, string>;
  /** Hook-adjusted semantic tool input, including any schema-defined `env`. */
  input: Record<string, unknown>;
}

export interface AfterMcpToolHookInput {
  arguments: Record<string, unknown>;
  content?: PluginMcpContent[];
  conversationId?: string;
  provider: string;
  structuredContent?: unknown;
  toolName: string;
}

export interface PluginHookRunner {
  afterMcpTool(input: AfterMcpToolHookInput): Promise<OwnedObjectAnnotation[]>;
  afterToolExecute(input: AfterToolHookInput): Promise<ToolResultNudge[]>;
  beforeToolExecute(input: ToolHookInput): Promise<ToolHookResult>;
  prepareSandbox(workspace: SandboxWorkspace): Promise<void>;
  prepareWorkspace(
    workspace: SandboxWorkspace,
    repos: Array<{
      provider: string;
      repo: string;
    }>,
    signal?: AbortSignal,
  ): Promise<() => Promise<void>>;
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "string") {
      env[key] = rawValue;
    }
  }
  return env;
}

/** Create one runner over runtime hook plugins registered by the app. */
export function createPluginHookRunner(
  input: {
    actor?: Actor | undefined;
    /** Live getter for the run's committed instruction actors; see `multi-actor-runs.md`. */
    actors?: (() => Actor[]) | undefined;
    /** The Run's Turn and sandbox. Without it, `afterToolExecute` hooks do not run. */
    toolRun?: ToolHookTurn & { sandbox: () => ToolHookSandbox };
  } = {},
): PluginHookRunner {
  const loaded = getRegistrations();

  return {
    async afterToolExecute(tool) {
      if (!input.toolRun) return [];
      const { sandbox, ...turn } = input.toolRun;
      return await runAfterToolExecuteHooks({
        plugins: loaded,
        sandbox: sandbox(),
        tool,
        turn,
      });
    },
    async afterMcpTool(tool) {
      const cards: OwnedObjectAnnotation[] = [];
      for (const plugin of loaded) {
        if (plugin.manifest.name !== tool.provider) {
          continue;
        }
        const hook = plugin.hooks?.afterMcpTool;
        if (!hook) {
          continue;
        }
        const annotations = tool.conversationId
          ? createPluginAnnotations({
              conversationId: tool.conversationId,
              db: getDb(),
              plugin: plugin.manifest.name,
            })
          : undefined;
        try {
          // oxlint-disable-next-line no-await-in-loop -- Plugin names are unique, so at most one plugin owns the MCP provider.
          const result = await hook({
            ...basePluginContext(plugin),
            ...(tool.conversationId
              ? { conversationId: tool.conversationId }
              : undefined),
            ...(annotations ? { annotations } : undefined),
            result: {
              content: tool.content,
              structuredContent: tool.structuredContent,
            },
            tool: {
              arguments: tool.arguments,
              name: tool.toolName,
            },
          });
          if (result && tool.conversationId) {
            cards.push(
              // oxlint-disable-next-line no-await-in-loop -- Plugin names are unique, so at most one plugin owns the MCP provider.
              ...(await saveObjectAnnotations(
                tool.conversationId,
                plugin.manifest.name,
                result.objectAnnotations,
              )),
            );
          }
        } catch (error) {
          logWarn("agent.plugin.after_mcp_tool.failed", {
            "app.plugin.name": plugin.manifest.name,
            "gen_ai.tool.name": tool.toolName,
            "exception.message":
              error instanceof Error ? error.message : String(error),
          });
        }
      }
      return cards;
    },
    async prepareWorkspace(sandbox, repos, signal) {
      const preparers = new Set(
        loaded
          .filter((plugin) => plugin.hooks?.workspacePrepare)
          .map((plugin) => plugin.manifest.name),
      );
      const unhandledProviders = [
        ...new Set(
          repos
            .map((repo) => repo.provider)
            .filter((provider) => !preparers.has(provider)),
        ),
      ].sort();
      if (unhandledProviders.length > 0) {
        throw new Error(
          `Workspace repository providers have no preparation hook: ${unhandledProviders.join(", ")}`,
        );
      }

      const selectedRepos = repos.map((repo) => ({
        provider: repo.provider,
        repo: repo.repo,
        path: workspaceRepoCheckoutPath(repo.repo),
      }));
      const paths = new Set<string>();
      for (const entry of selectedRepos) {
        const key = entry.path.toLowerCase();
        if (paths.has(key)) {
          throw new Error(`Workspace checkout path collision: ${entry.path}`);
        }
        paths.add(key);
      }

      const sandboxCapability = createSandboxCapability(sandbox, signal);
      const finalizers: Array<() => Promise<void> | void> = [];
      for (const plugin of loaded) {
        const hook = plugin.hooks?.workspacePrepare;
        if (!hook) continue;
        const selected = selectedRepos
          .filter((repo) => repo.provider === plugin.manifest.name)
          .map((repo) => ({
            path: repo.path,
            repo: repo.repo,
          }));
        if (selected.length === 0) continue;
        // oxlint-disable-next-line no-await-in-loop -- Plugins prepare the same sandbox, so one runs at a time.
        const finalize = await hook({
          ...basePluginContext(plugin),
          repos: selected,
          sandbox: sandboxCapability,
        });
        if (finalize) finalizers.push(finalize);
      }
      return async () => {
        // oxlint-disable-next-line no-await-in-loop -- Finish workspaces in the order that plugins prepared them.
        for (const finalize of finalizers) await finalize();
      };
    },
    async prepareSandbox(sandbox) {
      const sandboxCapability = createSandboxCapability(sandbox);
      for (const plugin of loaded) {
        const pluginName = plugin.manifest.name;
        const hook = plugin.hooks?.sandboxPrepare;
        if (!hook) {
          continue;
        }
        logInfo("agent.plugin.sandbox_preparation.started", {
          "app.plugin.name": pluginName,
        });
        // oxlint-disable-next-line no-await-in-loop -- Plugins prepare the same sandbox, so one runs at a time.
        await withPluginHookSpan(
          pluginName,
          "sandboxPrepare",
          async () =>
            await hook({
              ...basePluginContext(plugin),
              actor: input.actor,
              sandbox: sandboxCapability,
            }),
        );
      }
    },
    async beforeToolExecute(tool) {
      const env: Record<string, string> = {};
      let nextInput = { ...tool.input };
      // Materialize once per tool call so every plugin sees the same
      // committed-so-far set, even though it can still grow before the next call.
      const actors = input.actors?.() ?? (input.actor ? [input.actor] : []);

      for (const plugin of loaded) {
        const pluginName = plugin.manifest.name;
        const hook = plugin.hooks?.beforeToolExecute;
        if (!hook) {
          continue;
        }
        let replacement: Record<string, unknown> | undefined;
        let blocked: PluginToolDeniedError | ToolInputError | undefined;
        // oxlint-disable-next-line no-await-in-loop -- Each hook gets the arguments that the hook before it replaced.
        await withPluginHookSpan(
          pluginName,
          "beforeToolExecute",
          async () =>
            await hook({
              ...basePluginContext(plugin),
              actor: input.actor,
              actors,
              tool: {
                name: tool.name,
                input: nextInput,
              },
              users: {
                resolveActor: async () =>
                  input.actor
                    ? await readActorIdentity(input.actor)
                    : undefined,
              },
              juniorRoot: SANDBOX_JUNIOR_ROOT,
              env: {
                get(key) {
                  return env[key] ?? normalizeEnv(nextInput["env"])[key];
                },
                set(key, value) {
                  env[key] = value;
                },
              },
              decision: {
                deny(reason) {
                  blocked = new PluginToolDeniedError(reason);
                },
                redirect(message) {
                  blocked = new ToolInputError(message);
                },
                replaceInput(input) {
                  replacement = input;
                },
              },
            }),
        );

        if (blocked) {
          throw blocked;
        }
        if (replacement !== undefined) {
          if (
            typeof replacement !== "object" ||
            replacement === null ||
            Array.isArray(replacement)
          ) {
            throw new Error(
              `Plugin "${pluginName}" replaced tool input with a non-object value`,
            );
          }
          nextInput = { ...replacement };
        }
      }

      return {
        input: nextInput,
        env,
      };
    },
  };
}
