import fs from "node:fs/promises";
import {
  logInfo,
  setSpanAttributes,
  setSpanStatus,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import type { AssistantStatusSpec } from "@/chat/runtime/assistant-status";
import { throwSandboxOperationError } from "@/chat/sandbox/errors";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import { createSandboxSessionManager } from "@/chat/sandbox/session";
import {
  isHostFileMissingError,
  resolveHostSkillPath,
} from "@/chat/sandbox/skill-sync";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { SkillMetadata } from "@/chat/skills";

// Spec: specs/security-policy.md (sandbox isolation, network policy, credential lifecycle)
// Spec: specs/logging/tracing-spec.md (required sandbox span semantics)
interface SandboxExecutionInput {
  toolName: string;
  input: unknown;
}

export interface SandboxExecutionEnvelope<T = unknown> {
  result: T;
}

export interface BashCustomCommandResult {
  ok: boolean;
  command: string;
  cwd: string;
  exit_code: number;
  signal: null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

export interface SandboxExecutor {
  configureSkills(skills: SkillMetadata[]): void;
  getSandboxId(): string | undefined;
  getDependencyProfileHash(): string | undefined;
  canExecute(toolName: string): boolean;
  createSandbox(): Promise<SandboxWorkspace>;
  execute<T>(
    params: SandboxExecutionInput,
  ): Promise<SandboxExecutionEnvelope<T>>;
  dispose(): Promise<void>;
}

const SANDBOX_TOOL_NAMES = new Set(["bash", "readFile", "writeFile"]);

function parseHeaderTransforms(
  raw: unknown,
): Array<{ domain: string; headers: Record<string, string> }> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  return raw
    .filter((value): value is Record<string, unknown> =>
      Boolean(value && typeof value === "object"),
    )
    .map((transform) => ({
      domain: String(transform.domain ?? "").trim(),
      headers:
        transform.headers &&
        typeof transform.headers === "object" &&
        !Array.isArray(transform.headers)
          ? Object.fromEntries(
              Object.entries(transform.headers as Record<string, unknown>)
                .filter(([, value]) => typeof value === "string")
                .map(([key, value]) => [key, value as string]),
            )
          : {},
    }))
    .filter(
      (transform) =>
        transform.domain.length > 0 &&
        Object.keys(transform.headers).length > 0,
    );
}

function parseEnv(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => typeof value === "string")
      .map(([key, value]) => [key, value as string]),
  );
}

/** Create one sandbox-backed tool executor facade for the current turn. */
export function createSandboxExecutor(options?: {
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  timeoutMs?: number;
  traceContext?: LogContext;
  onStatus?: (status: AssistantStatusSpec) => void | Promise<void>;
  runBashCustomCommand?: (
    command: string,
  ) => Promise<{ handled: boolean; result?: BashCustomCommandResult }>;
}): SandboxExecutor {
  let availableSkills: SkillMetadata[] = [];
  const traceContext = options?.traceContext ?? {};
  const sessionManager = createSandboxSessionManager({
    sandboxId: options?.sandboxId,
    sandboxDependencyProfileHash: options?.sandboxDependencyProfileHash,
    timeoutMs: options?.timeoutMs,
    traceContext,
    onStatus: options?.onStatus,
  });

  const withSandboxSpan = <T>(
    name: string,
    op: string,
    attributes: Record<string, unknown>,
    callback: () => Promise<T>,
  ): Promise<T> => withSpan(name, op, traceContext, callback, attributes);

  const logSandboxBootRequest = (
    trigger: string,
    details: Record<string, string | number> = {},
  ): void => {
    if (sessionManager.getSandboxId()) {
      return;
    }

    logInfo(
      "sandbox_boot_requested",
      traceContext,
      {
        "app.sandbox.boot.trigger": trigger,
        ...details,
      },
      "Sandbox boot requested",
    );
  };

  const executeBashTool = async <T>(
    rawInput: Record<string, unknown>,
    command: string,
  ): Promise<SandboxExecutionEnvelope<T>> => {
    const headerTransforms = parseHeaderTransforms(rawInput.headerTransforms);
    const env = parseEnv(rawInput.env);
    logSandboxBootRequest("tool.bash", {
      "app.sandbox.command_length": command.length,
    });
    const executeBash = (await sessionManager.ensureToolExecutors()).bash;
    const result = await withSandboxSpan(
      "bash",
      "process.exec",
      {
        "process.executable.name": "bash",
      },
      async () => {
        try {
          const response = await executeBash({
            command,
            ...(headerTransforms ? { headerTransforms } : {}),
            ...(env ? { env } : {}),
          });
          setSpanAttributes({
            "process.exit.code": response.exitCode,
            "app.sandbox.stdout_bytes": Buffer.byteLength(
              response.stdout ?? "",
              "utf8",
            ),
            "app.sandbox.stderr_bytes": Buffer.byteLength(
              response.stderr ?? "",
              "utf8",
            ),
            ...(response.exitCode !== 0
              ? { "error.type": "nonzero_exit" }
              : {}),
          });
          setSpanStatus(response.exitCode === 0 ? "ok" : "error");
          return response;
        } catch (error) {
          setSpanAttributes({
            "error.type":
              error instanceof Error ? error.name : "sandbox_execute_error",
          });
          setSpanStatus("error");
          throw error;
        }
      },
    );

    return {
      result: {
        ok: result.exitCode === 0,
        command,
        cwd: SANDBOX_WORKSPACE_ROOT,
        exit_code: result.exitCode,
        signal: null,
        timed_out: false,
        stdout: result.stdout,
        stderr: result.stderr,
        stdout_truncated: result.stdoutTruncated,
        stderr_truncated: result.stderrTruncated,
      } as T,
    };
  };

  const executeReadFileTool = async <T>(
    rawInput: Record<string, unknown>,
  ): Promise<SandboxExecutionEnvelope<T>> => {
    const filePath = String(rawInput.path ?? "").trim();
    if (!filePath) {
      throw new Error("path is required");
    }

    if (!sessionManager.getSandboxId()) {
      const hostSkillPath = resolveHostSkillPath(availableSkills, filePath);
      if (hostSkillPath) {
        try {
          const content = await fs.readFile(hostSkillPath, "utf8");
          setSpanAttributes({
            "app.sandbox.path.length": filePath.length,
            "app.sandbox.read.bytes": Buffer.byteLength(content, "utf8"),
            "app.sandbox.read.chars": content.length,
            "app.skill.virtual_read": true,
          });
          setSpanStatus("ok");
          return {
            result: {
              content,
              path: filePath,
              success: true,
            } as T,
          };
        } catch (error) {
          if (!isHostFileMissingError(error)) {
            throw error;
          }
        }
      }
    }

    logSandboxBootRequest("tool.readFile", {
      "file.path": filePath,
    });
    const executeReadFile = (await sessionManager.ensureToolExecutors())
      .readFile;
    const result = await withSandboxSpan(
      "sandbox.readFile",
      "sandbox.fs.read",
      {
        "app.sandbox.path.length": filePath.length,
      },
      async () => {
        const response = await executeReadFile({ path: filePath });
        const content = String(response.content ?? "");
        setSpanAttributes({
          "app.sandbox.read.bytes": Buffer.byteLength(content, "utf8"),
          "app.sandbox.read.chars": content.length,
        });
        setSpanStatus("ok");
        return {
          content,
          path: filePath,
          success: true,
        };
      },
    );

    return { result: result as T };
  };

  const executeWriteFileTool = async <T>(
    rawInput: Record<string, unknown>,
  ): Promise<SandboxExecutionEnvelope<T>> => {
    const filePath = String(rawInput.path ?? "").trim();
    if (!filePath) {
      throw new Error("path is required");
    }

    const content = String(rawInput.content ?? "");
    logSandboxBootRequest("tool.writeFile", {
      "file.path": filePath,
    });
    const executeWriteFile = (await sessionManager.ensureToolExecutors())
      .writeFile;
    await withSandboxSpan(
      "sandbox.writeFile",
      "sandbox.fs.write",
      {
        "app.sandbox.path.length": filePath.length,
        "app.sandbox.write.bytes": Buffer.byteLength(content, "utf8"),
      },
      async () => {
        try {
          await executeWriteFile({ path: filePath, content });
        } catch (error) {
          throwSandboxOperationError("sandbox writeFile", error);
        }
        setSpanStatus("ok");
      },
    );

    return {
      result: {
        ok: true,
        path: filePath,
        bytes_written: Buffer.byteLength(content, "utf8"),
      } as T,
    };
  };

  const execute = async <T>(
    params: SandboxExecutionInput,
  ): Promise<SandboxExecutionEnvelope<T>> => {
    const rawInput = (params.input ?? {}) as Record<string, unknown>;
    const bashCommand =
      params.toolName === "bash"
        ? String(rawInput.command ?? "").trim()
        : undefined;

    if (params.toolName === "bash") {
      if (!bashCommand) {
        throw new Error("command is required");
      }
      if (options?.runBashCustomCommand) {
        const custom = await options.runBashCustomCommand(bashCommand);
        if (custom.handled) {
          return { result: custom.result as T };
        }
      }
      return await executeBashTool(rawInput, bashCommand);
    }

    if (params.toolName === "readFile") {
      return await executeReadFileTool(rawInput);
    }

    if (params.toolName === "writeFile") {
      return await executeWriteFileTool(rawInput);
    }

    throw new Error(`unsupported sandbox tool: ${params.toolName}`);
  };

  return {
    configureSkills(skills: SkillMetadata[]) {
      availableSkills = [...skills];
      sessionManager.configureSkills(skills);
    },
    getSandboxId() {
      return sessionManager.getSandboxId();
    },
    getDependencyProfileHash() {
      return sessionManager.getDependencyProfileHash();
    },
    canExecute(toolName: string) {
      return SANDBOX_TOOL_NAMES.has(toolName);
    },
    async createSandbox() {
      return await sessionManager.createSandbox();
    },
    execute,
    async dispose() {
      await sessionManager.dispose();
    },
  };
}
