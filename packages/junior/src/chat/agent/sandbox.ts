/**
 * Run-scoped sandbox workspace.
 *
 * Exposes a stable workspace port to tools while deferring the actual
 * sandbox boot until a tool first touches the filesystem or runs a command,
 * and rebinding when the executor's sandbox identity changes mid-run.
 */
import { logInfo, type LogContext } from "@/chat/logging";
import {
  createSandboxUnavailableToolError,
  type SandboxExecutor,
} from "@/chat/sandbox/sandbox";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";

type LazySandboxExecutor = Pick<
  SandboxExecutor,
  | "createSandbox"
  | "getSandboxId"
  | "getSandboxEgressId"
  | "invalidateIfUnavailable"
>;

/** Create a lazy-boot workspace port bound to the run's sandbox executor. */
export function createLazySandboxWorkspace(args: {
  executor: LazySandboxExecutor;
  spanContext: LogContext;
}): SandboxWorkspace {
  interface SandboxBinding {
    workspace: SandboxWorkspace;
    sandboxId: string;
    sandboxEgressId: string | undefined;
  }

  let sandboxPromise: Promise<SandboxBinding> | undefined;
  let sandboxBinding: SandboxBinding | undefined;
  const clearSandboxPromise = (expected?: Promise<SandboxBinding>): void => {
    if (expected && sandboxPromise !== expected) {
      return;
    }
    sandboxPromise = undefined;
    sandboxBinding = undefined;
  };
  const getSandbox = (reason: {
    trigger: string;
    path?: string;
    cmd?: string;
    cwd?: string;
  }): Promise<SandboxBinding> => {
    const currentSandboxId = args.executor.getSandboxId();
    const currentSandboxEgressId = args.executor.getSandboxEgressId();
    if (
      sandboxBinding &&
      (currentSandboxId !== sandboxBinding.sandboxId ||
        currentSandboxEgressId !== sandboxBinding.sandboxEgressId)
    ) {
      clearSandboxPromise();
    }

    if (!sandboxPromise) {
      logInfo(
        "sandbox_boot_requested",
        args.spanContext,
        {
          "app.sandbox.boot.trigger": reason.trigger,
          ...(reason.path ? { "file.path": reason.path } : {}),
          ...(reason.cmd ? { "process.executable.name": reason.cmd } : {}),
          ...(reason.cwd ? { "file.directory": reason.cwd } : {}),
        },
        "Lazy sandbox boot requested",
      );
      const nextSandboxPromise = args.executor
        .createSandbox()
        .then((workspace) => {
          const binding = {
            workspace,
            sandboxId: workspace.sandboxId,
            sandboxEgressId: workspace.sandboxEgressId,
          };
          if (sandboxPromise === nextSandboxPromise) {
            sandboxBinding = binding;
          }
          return binding;
        })
        .catch((error) => {
          clearSandboxPromise(nextSandboxPromise);
          throw error;
        });
      sandboxPromise = nextSandboxPromise;
    }
    return sandboxPromise;
  };

  /** Fail the current operation and discard the pinned workspace after lifecycle loss. */
  const runWithSandbox = async <T>(
    reason: {
      trigger: string;
      path?: string;
      cmd?: string;
      cwd?: string;
    },
    operation: (sandbox: SandboxWorkspace) => Promise<T>,
  ): Promise<T> => {
    const activeSandboxPromise = getSandbox(reason);
    let binding: SandboxBinding | undefined;
    try {
      binding = await activeSandboxPromise;
      return await operation(binding.workspace);
    } catch (error) {
      if (
        args.executor.invalidateIfUnavailable(error, binding?.sandboxEgressId)
      ) {
        clearSandboxPromise(activeSandboxPromise);
        throw createSandboxUnavailableToolError(reason.trigger, error);
      }
      throw error;
    }
  };

  return {
    readFileToBuffer: async (input) =>
      await runWithSandbox(
        {
          trigger: "workspace.readFileToBuffer",
          path: input.path,
        },
        async (sandbox) => await sandbox.readFileToBuffer(input),
      ),
    runCommand: async (input) =>
      await runWithSandbox(
        {
          trigger: "workspace.runCommand",
          cmd: input.cmd,
          cwd: input.cwd,
        },
        async (sandbox) => await sandbox.runCommand(input),
      ),
  };
}
