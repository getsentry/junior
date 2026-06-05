import { Buffer } from "node:buffer";
import type {
  SandboxExecutionEnvelope,
  SandboxExecutorFactory,
} from "@/chat/sandbox/sandbox";
import type { SandboxInstance } from "@/chat/sandbox/workspace";
import type { SkillMetadata } from "@/chat/skills";

export interface ScriptedSandboxExecutorState {
  activeSandboxVersion: number;
  configuredReferenceFiles: string[];
  configuredSkills: SkillMetadata[];
  createSandboxCalls: number;
  executedTools: string[];
}

export interface ScriptedSandboxExecutorOptions {
  canExecute?: (toolName: string) => boolean;
}

/** Create mutable state for a scripted sandbox executor fixture. */
export function createScriptedSandboxExecutorState(): ScriptedSandboxExecutorState {
  return {
    activeSandboxVersion: 1,
    configuredReferenceFiles: [],
    configuredSkills: [],
    createSandboxCalls: 0,
    executedTools: [],
  };
}

function sandboxIdFor(version: number): string {
  return version === 1 ? "sandbox-test" : `sandbox-test-${version}`;
}

function createSandboxInstance(sandboxId: string): SandboxInstance {
  return {
    sandboxId,
    sandboxEgressId: `${sandboxId}-session`,
    fs: {
      readFile: async () => "fixture",
      writeFile: async () => undefined,
      readdir: async () => [],
      stat: async () => ({
        isDirectory: () => false,
      }),
    },
    extendTimeout: async () => undefined,
    mkDir: async () => undefined,
    readFileToBuffer: async () => Buffer.from("report contents", "utf8"),
    runCommand: async () => ({
      exitCode: 0,
      stdout: async () => "text/plain\n",
      stderr: async () => "",
    }),
    snapshot: async () => ({ snapshotId: "snapshot-test" }),
    stop: async () => undefined,
    update: async () => undefined,
    writeFiles: async () => undefined,
  };
}

/** Create a sandbox executor factory with explicit, inspectable runtime state. */
export function createScriptedSandboxExecutorFactory(
  state: ScriptedSandboxExecutorState,
  options: ScriptedSandboxExecutorOptions = {},
): SandboxExecutorFactory {
  return (factoryOptions = {}) => {
    let currentSandboxId: string | undefined;
    let currentDependencyProfileHash: string | undefined;

    const acquireSandbox = async (): Promise<SandboxInstance> => {
      state.createSandboxCalls += 1;
      currentSandboxId = sandboxIdFor(state.activeSandboxVersion);
      currentDependencyProfileHash = "hash-test";
      await factoryOptions.onSandboxAcquired?.({
        sandboxId: currentSandboxId,
        sandboxDependencyProfileHash: currentDependencyProfileHash,
      });
      return createSandboxInstance(currentSandboxId);
    };

    return {
      configureSkills(skills) {
        state.configuredSkills = [...skills];
      },
      configureReferenceFiles(files) {
        state.configuredReferenceFiles = [...files];
      },
      getSandboxId() {
        return currentSandboxId;
      },
      getDependencyProfileHash() {
        return currentDependencyProfileHash;
      },
      canExecute(toolName) {
        return options.canExecute?.(toolName) ?? false;
      },
      async createSandbox() {
        return await acquireSandbox();
      },
      async execute<T>(params: {
        input: unknown;
        signal?: AbortSignal;
        toolName: string;
      }): Promise<SandboxExecutionEnvelope<T>> {
        const { input, toolName } = params;
        if (!options.canExecute?.(toolName)) {
          throw new Error(`sandbox executor cannot execute ${toolName}`);
        }
        state.executedTools.push(toolName);
        await acquireSandbox();
        const rawInput = (input ?? {}) as { command?: unknown };
        return {
          result: {
            ok: true,
            command: String(rawInput.command ?? ""),
            cwd: "/workspace",
            exit_code: 0,
            signal: null,
            timed_out: false,
            stdout: "/workspace\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
          } as T,
        } satisfies SandboxExecutionEnvelope<T>;
      },
      dispose: async () => undefined,
    };
  };
}
