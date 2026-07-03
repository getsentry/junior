import { logInfo, type LogContext } from "@/chat/logging";
import type { SandboxExecutor } from "@/chat/sandbox/sandbox";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";

/** Preserves lazy sandbox boot semantics while exposing a stable workspace port to tools. */
export function createLazySandboxWorkspace(args: {
  executor: SandboxExecutor;
  spanContext: LogContext;
}): SandboxWorkspace {
  let sandboxPromise: Promise<SandboxWorkspace> | undefined;
  let sandboxPromiseId: string | undefined;
  const clearSandboxPromise = (): void => {
    sandboxPromise = undefined;
    sandboxPromiseId = undefined;
  };
  const getSandbox = (reason: {
    trigger: string;
    path?: string;
    cmd?: string;
    cwd?: string;
  }): Promise<SandboxWorkspace> => {
    const currentSandboxId = args.executor.getSandboxId();
    if (
      sandboxPromise &&
      sandboxPromiseId &&
      currentSandboxId !== sandboxPromiseId
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
      sandboxPromise = args.executor
        .createSandbox()
        .then((sandbox) => {
          sandboxPromiseId = sandbox.sandboxId;
          return sandbox;
        })
        .catch((error) => {
          clearSandboxPromise();
          throw error;
        });
    }
    return sandboxPromise;
  };

  return {
    readFileToBuffer: async (input) =>
      (
        await getSandbox({
          trigger: "workspace.readFileToBuffer",
          path: input.path,
        })
      ).readFileToBuffer(input),
    runCommand: async (input) =>
      (
        await getSandbox({
          trigger: "workspace.runCommand",
          cmd: input.cmd,
          cwd: input.cwd,
        })
      ).runCommand(input),
  };
}
