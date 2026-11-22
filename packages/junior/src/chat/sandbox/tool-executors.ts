import { buildNonInteractiveShellScript } from "@/chat/sandbox/noninteractive-command";
import {
  SANDBOX_COMMAND_PATH,
  SANDBOX_WORKSPACE_ROOT,
} from "@/chat/sandbox/paths";
import type {
  SandboxCommandResult,
  SandboxFileSystem,
  SandboxSession,
} from "@/chat/sandbox/workspace";

/**
 * Size limit on the stdout and stderr that one command keeps, each. It keeps
 * a runaway command from filling the result and the Conversation history.
 * The tool pipeline cuts what the model sees to a much smaller size. The
 * providers still read all output before this limit applies.
 */
const MAX_CAPTURED_OUTPUT_CHARS = 1_000_000;
const DEFAULT_BASH_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
// When a session stops, the provider ends its commands with SIGTERM (143) or
// SIGKILL (137) and reports a normal exit, with no error.
const SIGNAL_EXIT_CODES = new Set([137, 143]);

/** Tools bound to one session of the active Sandbox. */
export interface SandboxToolExecutors {
  sandboxId: string;
  sessionId: string;
  keepsFilesAcrossSessions: boolean;
  bash: (input: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    aborted?: boolean;
    timedOut?: boolean;
  }>;
  fs: SandboxFileSystem;
  runCommand: SandboxSession["runCommand"];
}

function captureOutput(output: string): { value: string; truncated: boolean } {
  if (output.length <= MAX_CAPTURED_OUTPUT_CHARS) {
    return { value: output, truncated: false };
  }
  return {
    value: `${output.slice(0, MAX_CAPTURED_OUTPUT_CHARS)}\n\n[output over the ${MAX_CAPTURED_OUTPUT_CHARS} char size limit: ${output.length - MAX_CAPTURED_OUTPUT_CHARS} chars not kept]`,
    truncated: true,
  };
}

function getCommandAbortedResult() {
  return {
    stdout: "",
    stderr: "Command aborted because the agent turn was cancelled.",
    exitCode: 130,
    stdoutTruncated: false,
    stderrTruncated: false,
    aborted: true as const,
  };
}

async function readCommandOutput(commandResult: SandboxCommandResult): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}> {
  const stdout = captureOutput(commandResult.stdout);
  const stderr = captureOutput(commandResult.stderr);
  return {
    stdout: stdout.value,
    stderr: stderr.value,
    exitCode: commandResult.exitCode,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

/** Bind bash, file, and command tools to one session of the active Sandbox. */
export function createToolExecutors(
  sandboxInstance: SandboxSession,
  options: {
    commandEnv: () => Promise<Record<string, string>>;
    /** Throw the provider error when the session has stopped. */
    throwIfSessionStopped: (session: SandboxSession) => Promise<void>;
  },
): SandboxToolExecutors {
  return {
    sandboxId: sandboxInstance.sandboxId,
    sessionId: sandboxInstance.sessionId,
    keepsFilesAcrossSessions: sandboxInstance.keepsFilesAcrossSessions,
    bash: async (input) => {
      let timedOut = false;
      let aborted = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        if (input.signal?.aborted) {
          return getCommandAbortedResult();
        }
        const sandboxCommandEnv = await options.commandEnv();
        if (input.signal?.aborted) {
          return getCommandAbortedResult();
        }
        const script = buildNonInteractiveShellScript(input.command, {
          env: { ...sandboxCommandEnv, ...(input.env ?? {}) },
          path: SANDBOX_COMMAND_PATH,
        });
        const controller = new AbortController();
        const timeoutMs =
          input.timeoutMs && input.timeoutMs > 0
            ? input.timeoutMs
            : DEFAULT_BASH_COMMAND_TIMEOUT_MS;
        onAbort = () => {
          aborted = true;
          controller.abort(input.signal?.reason);
        };
        if (input.signal) {
          input.signal.addEventListener("abort", onAbort, { once: true });
          if (input.signal.aborted) {
            onAbort();
          }
        }
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        timeoutId.unref?.();
        const commandResult = await sandboxInstance.runCommand({
          cmd: "bash",
          args: ["-c", script],
          cwd: input.cwd ?? SANDBOX_WORKSPACE_ROOT,
          signal: controller.signal,
        });
        if (SIGNAL_EXIT_CODES.has(commandResult.exitCode)) {
          await options.throwIfSessionStopped(sandboxInstance);
        }
        return await readCommandOutput(commandResult);
      } catch (error) {
        if (timedOut) {
          return {
            stdout: "",
            stderr: `Command timed out after ${
              input.timeoutMs && input.timeoutMs > 0
                ? input.timeoutMs
                : DEFAULT_BASH_COMMAND_TIMEOUT_MS
            }ms`,
            exitCode: 124,
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: true,
          };
        }
        if (aborted || input.signal?.aborted) {
          return getCommandAbortedResult();
        }
        throw error;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (input.signal && onAbort) {
          input.signal.removeEventListener("abort", onAbort);
        }
      }
    },
    fs: sandboxInstance.fs,
    runCommand: async (input) => await sandboxInstance.runCommand(input),
  };
}
