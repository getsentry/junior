import type {
  PluginRegistration,
  PluginSandbox,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { withSpan, type SetSpanAttributes } from "@/chat/logging";
import { createPluginCache } from "@/chat/plugins/cache";
import { createPluginLogger } from "@/chat/plugins/logging";
import { runNonInteractiveCommand } from "@/chat/sandbox/noninteractive-command";
import {
  SANDBOX_JUNIOR_ROOT,
  SANDBOX_WORKSPACE_ROOT,
} from "@/chat/sandbox/paths";
import type {
  SandboxCommandInput,
  SandboxWorkspace,
} from "@/chat/sandbox/workspace";

/** Build the context fields that every plugin hook receives. */
export function basePluginContext(plugin: PluginRegistration) {
  const name = plugin.manifest.name;
  return {
    plugin: { name },
    cache: createPluginCache(name),
    log: createPluginLogger(name),
    db: getDb(),
  };
}

/** Time one plugin hook call so slow plugins show up in turn traces. */
export async function withPluginHookSpan<T>(
  pluginName: string,
  hookName:
    | "afterToolExecute"
    | "beforeToolExecute"
    | "sandboxPrepare"
    | "userPrompt",
  callback: (setSpanAttributes: SetSpanAttributes) => Promise<T>,
): Promise<T> {
  return await withSpan(
    `plugin.hook ${hookName}`,
    "plugin.hook",
    {},
    callback,
    {
      "app.plugin.name": pluginName,
      "app.plugin.hook": hookName,
    },
  );
}

function preparationSignal(
  inputSignal?: AbortSignal,
  ownerSignal?: AbortSignal,
): AbortSignal | undefined {
  if (!inputSignal) return ownerSignal;
  if (!ownerSignal) return inputSignal;
  return AbortSignal.any([inputSignal, ownerSignal]);
}

/** Expose a sandbox to plugin hooks; `ownerSignal` cancels its commands. */
export function createSandboxCapability(
  workspace: SandboxWorkspace,
  ownerSignal?: AbortSignal,
): PluginSandbox {
  return {
    root: SANDBOX_WORKSPACE_ROOT,
    juniorRoot: SANDBOX_JUNIOR_ROOT,
    async readFile(filePath) {
      return (await workspace.readFileToBuffer({ path: filePath })) ?? null;
    },
    async run(input: SandboxCommandInput) {
      const signal = preparationSignal(input.signal, ownerSignal);
      const result = await runNonInteractiveCommand(workspace, {
        ...input,
        ...(signal ? { signal } : undefined),
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    async writeFile(input) {
      await workspace.writeFiles([
        {
          path: input.path,
          content: input.content,
          ...(input.mode !== undefined ? { mode: input.mode } : undefined),
        },
      ]);
    },
  };
}
