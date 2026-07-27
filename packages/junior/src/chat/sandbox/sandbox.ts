import fs from "node:fs/promises";
import {
  getTracePropagationHeaders,
  logInfo,
  setSpanAttributes,
  setSpanStatus,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import {
  buildSandboxEgressNetworkPolicy,
  resolveSandboxCommandEnvironment,
} from "@/chat/sandbox/egress/policy";
import {
  clearSandboxEgressSignals,
  consumeSandboxEgressAuthRequiredSignal,
  consumeSandboxEgressPermissionDeniedSignal,
  createSandboxEgressCredentialToken,
} from "@/chat/sandbox/egress/session";
import type { SandboxEgressSignalTransport } from "@/chat/sandbox/egress/signals";
import { formatSandboxCommandResult } from "@/chat/sandbox/command-result";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import type { CredentialContext } from "@/chat/credentials/context";
import {
  isSandboxCommandStreamInterruptedError,
  isSandboxUnavailableError,
  throwSandboxOperationError,
} from "@/chat/sandbox/errors";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import { createSandboxRuntime } from "@/chat/sandbox/session";
import {
  isHostFileMissingError,
  resolveHostDataPath,
  resolveHostSkillPath,
} from "@/chat/sandbox/skill-sync";
import type { SandboxRef } from "@/chat/sandbox/ref";
import type {
  SandboxSession,
  SandboxWorkspace,
} from "@/chat/sandbox/workspace";
import type { SkillMetadata } from "@/chat/skills";
import { editFile } from "@/chat/tools/sandbox/edit-file";
import { findFiles } from "@/chat/tools/sandbox/find-files";
import {
  isMissingPathError,
  positiveInteger,
} from "@/chat/tools/sandbox/file-utils";
import { grepFiles } from "@/chat/tools/sandbox/grep";
import { listDir } from "@/chat/tools/sandbox/list-dir";
import {
  missingFileResult,
  sliceFileContent,
} from "@/chat/tools/sandbox/read-file";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { makeStructuredToolResult } from "@/chat/tool-support/structured-result";

// Policies: policies/security.md and policies/observability.md.
export interface SandboxToolCall {
  toolName: string;
  input: unknown;
  signal?: AbortSignal;
}

export interface SandboxTools {
  supports(toolName: string): boolean;
  execute(params: SandboxToolCall): Promise<unknown>;
}

export interface SandboxAccess {
  readonly tools: SandboxTools;
  readonly workspace: SandboxWorkspace;
  sandboxRef(): SandboxRef | undefined;
  close(): void;
}

export interface SandboxOptions {
  sandboxRef?: SandboxRef;
  skills: SkillMetadata[];
  referenceFiles: string[];
  timeoutMs?: number;
  traceContext?: LogContext;
  tracePropagation?: SandboxEgressTracePropagationConfig;
  credentialEgress?: CredentialContext;
  egressSignals?: SandboxEgressSignalTransport;
  prepare?: (workspace: SandboxWorkspace) => void | Promise<void>;
  onSandboxRefChanged?: (sandboxRef: SandboxRef) => void | Promise<void>;
}

/** Create the safe expected tool error for an unavailable sandbox operation. */
function createSandboxUnavailableToolError(
  operation: string,
  cause: unknown,
): ToolInputError {
  return new ToolInputError(
    `The temporary sandbox became unavailable during ${operation}, so the operation did not complete reliably. The next sandbox operation will use a fresh session. It may have produced side effects; retry only if it is safe.`,
    { cause },
  );
}

const SANDBOX_TOOL_NAMES = new Set([
  "bash",
  "readFile",
  "editFile",
  "grep",
  "findFiles",
  "listDir",
  "writeFile",
]);

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

/** Create lazy run-scoped access to a conversation's durable sandbox. */
export function createSandbox(options: SandboxOptions): SandboxAccess {
  const traceContext = options.traceContext ?? {};
  const tracePropagation = options.tracePropagation;
  const hasTracePropagationDomains =
    (tracePropagation?.domains?.length ?? 0) > 0;
  const credentialEgress = options.credentialEgress;
  const sandboxEgressTokenTtlMs = Math.max(
    1,
    options.timeoutMs ?? 1000 * 60 * 30,
  );
  const sandboxEgressCredentialTokens = new Map<
    string,
    { expiresAtMs: number; token: string }
  >();
  const sandboxEgressCredentialTokenFor = (egressId: string): string => {
    const cached = sandboxEgressCredentialTokens.get(egressId);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.token;
    }
    if (!credentialEgress) {
      throw new Error("Sandbox credential egress is not configured");
    }
    const now = Date.now();
    const token = createSandboxEgressCredentialToken({
      credentials: credentialEgress,
      egressId,
      ttlMs: sandboxEgressTokenTtlMs,
    });
    sandboxEgressCredentialTokens.set(egressId, {
      expiresAtMs: now + sandboxEgressTokenTtlMs,
      token,
    });
    return token;
  };
  const clearEgressSignals = async (egressId: string): Promise<void> => {
    if (!options.egressSignals) {
      await clearSandboxEgressSignals(egressId);
      return;
    }
    await options.egressSignals.clear(
      sandboxEgressCredentialTokenFor(egressId),
    );
  };
  const consumeEgressSignals = async (egressId: string) => {
    if (options.egressSignals) {
      return await options.egressSignals.consume(
        sandboxEgressCredentialTokenFor(egressId),
      );
    }
    const [authRequired, permissionDenied] = await Promise.all([
      consumeSandboxEgressAuthRequiredSignal(egressId),
      consumeSandboxEgressPermissionDeniedSignal(egressId),
    ]);
    return {
      ...(authRequired ? { authRequired } : {}),
      ...(permissionDenied ? { permissionDenied } : {}),
    };
  };
  const runtime = createSandboxRuntime({
    sandboxRef: options.sandboxRef,
    skills: options.skills,
    referenceFiles: options.referenceFiles,
    timeoutMs: options.timeoutMs,
    traceContext,
    commandEnv: credentialEgress ? resolveSandboxCommandEnvironment : undefined,
    createNetworkPolicy:
      credentialEgress || hasTracePropagationDomains
        ? (sessionId, traceHeaders) =>
            buildSandboxEgressNetworkPolicy({
              ...(credentialEgress
                ? {
                    credentialToken: sandboxEgressCredentialTokenFor(sessionId),
                  }
                : {}),
              traceConfig: tracePropagation,
              traceHeaders,
            })
        : undefined,
    onSandboxPrepare: options.prepare,
    onSandboxRefChanged: options.onSandboxRefChanged,
  });

  const withSandboxSpan = <T>(
    name: string,
    op: string,
    attributes: Record<string, unknown>,
    callback: () => Promise<T>,
  ): Promise<T> => withSpan(name, op, traceContext, callback, attributes);

  // Network-policy header transforms need the current tool span's trace headers.
  const withSandboxToolSpan = <T>(
    name: string,
    op: string,
    attributes: Record<string, unknown>,
    callback: () => Promise<T>,
  ): Promise<T> =>
    withSandboxSpan(name, op, attributes, async () => {
      await runtime.refreshNetworkPolicy(getTracePropagationHeaders());
      return await callback();
    });

  const logSandboxBootRequest = (
    trigger: string,
    details: Record<string, string | number> = {},
  ): void => {
    if (runtime.sandboxRef()) {
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
    signal?: AbortSignal,
  ): Promise<T> => {
    const env = parseEnv(rawInput.env);
    const timeoutMs = positiveInteger(rawInput.timeoutMs);
    logSandboxBootRequest("tool.bash", {
      "app.sandbox.command_length": command.length,
    });
    const { bash: executeBash, sessionId: activeSessionId } =
      await runtime.tools();
    await clearEgressSignals(activeSessionId);
    const result = await withSandboxToolSpan(
      "bash",
      "process.exec",
      {
        "process.executable.name": "bash",
      },
      async () => {
        try {
          const response = await executeBash({
            command,
            ...(env ? { env } : {}),
            ...(timeoutMs ? { timeoutMs } : {}),
            ...(signal ? { signal } : {}),
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
            ...(response.aborted
              ? { "error.type": "outcome_unknown" }
              : response.exitCode !== 0
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
    // Always consume egress auth/permission signals regardless of exit code.
    // The exit-code guard was incorrect: piped bash commands (e.g. `cmd | head`)
    // mask the underlying CLI's non-zero exit with the pipe tail's exit code (0),
    // preventing the signal from ever being read. The egress signal is a
    // side-channel from the network layer — not a property of shell exit status —
    // and the signal store is cleared before each execution to prevent
    // cross-command leakage.
    const { authRequired, permissionDenied } =
      await consumeEgressSignals(activeSessionId);

    return formatSandboxCommandResult({
      ok: result.exitCode === 0,
      command,
      cwd: SANDBOX_WORKSPACE_ROOT,
      exit_code: result.exitCode,
      signal: null,
      timed_out: Boolean(result.timedOut),
      aborted: Boolean(result.aborted),
      stdout: result.stdout,
      stderr: result.stderr,
      stdout_truncated: result.stdoutTruncated,
      stderr_truncated: result.stderrTruncated,
      ...(authRequired ? { auth_required: authRequired } : {}),
      ...(permissionDenied ? { permission_denied: permissionDenied } : {}),
    }) as T;
  };

  const executeReadFileTool = async <T>(
    rawInput: Record<string, unknown>,
  ): Promise<T> => {
    const filePath = String(rawInput.path ?? "").trim();
    if (!filePath) {
      throw new ToolInputError("path is required");
    }
    const offset = positiveInteger(rawInput.offset);
    const limit = positiveInteger(rawInput.limit);

    if (!runtime.sandboxRef()) {
      const hostPath =
        resolveHostSkillPath(options.skills, filePath) ??
        resolveHostDataPath(options.referenceFiles, filePath);
      if (hostPath) {
        try {
          const content = await fs.readFile(hostPath, "utf8");
          setSpanAttributes({
            "app.sandbox.path.length": filePath.length,
            "app.sandbox.read.bytes": Buffer.byteLength(content, "utf8"),
            "app.sandbox.read.chars": content.length,
            "app.skill.virtual_read": true,
          });
          setSpanStatus("ok");
          return sliceFileContent({
            content,
            path: filePath,
            offset,
            limit,
          }) as T;
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
    const executeReadFile = (await runtime.tools()).readFile;
    const result = await withSandboxToolSpan(
      "sandbox.readFile",
      "sandbox.fs.read",
      {
        "app.sandbox.path.length": filePath.length,
      },
      async () => {
        let response: { content: string };
        try {
          response = await executeReadFile({ path: filePath });
        } catch (error) {
          if (isMissingPathError(error)) {
            setSpanStatus("ok");
            return missingFileResult(filePath);
          }
          throw error;
        }
        const content = String(response.content ?? "");
        setSpanAttributes({
          "app.sandbox.read.bytes": Buffer.byteLength(content, "utf8"),
          "app.sandbox.read.chars": content.length,
        });
        setSpanStatus("ok");
        return {
          ...sliceFileContent({
            content,
            path: filePath,
            offset,
            limit,
          }),
        };
      },
    );

    return result as T;
  };

  const executeWriteFileTool = async <T>(
    rawInput: Record<string, unknown>,
  ): Promise<T> => {
    const filePath = String(rawInput.path ?? "").trim();
    if (!filePath) {
      throw new ToolInputError("path is required");
    }

    const content = String(rawInput.content ?? "");
    logSandboxBootRequest("tool.writeFile", {
      "file.path": filePath,
    });
    const executeWriteFile = (await runtime.tools()).writeFile;
    await withSandboxToolSpan(
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

    return makeStructuredToolResult({
      ok: true,
      status: "success",
      target: filePath,
      data: {
        bytes_written: Buffer.byteLength(content, "utf8"),
        path: filePath,
      },
      path: filePath,
      bytes_written: Buffer.byteLength(content, "utf8"),
    }) as T;
  };

  const executeEditFileTool = async <T>(
    rawInput: Record<string, unknown>,
  ): Promise<T> => {
    const filePath = String(rawInput.path ?? "").trim();
    if (!filePath) {
      throw new ToolInputError("path is required");
    }
    if (!Array.isArray(rawInput.edits)) {
      throw new ToolInputError("edits is required");
    }

    logSandboxBootRequest("tool.editFile", {
      "file.path": filePath,
    });
    const executors = await runtime.tools();
    const result = await withSandboxToolSpan(
      "sandbox.editFile",
      "sandbox.fs.edit",
      {
        "app.sandbox.path.length": filePath.length,
        "app.sandbox.edit.count": rawInput.edits.length,
      },
      async () => {
        const response = await editFile({
          fs: executors.fs,
          path: filePath,
          edits: rawInput.edits as Array<{ oldText: string; newText: string }>,
        });
        setSpanStatus("ok");
        return response;
      },
    );

    return result as T;
  };

  const executeGrepTool = async <T>(
    rawInput: Record<string, unknown>,
  ): Promise<T> => {
    const pattern = String(rawInput.pattern ?? "");
    if (!pattern) {
      throw new ToolInputError("pattern is required");
    }

    logSandboxBootRequest("tool.grep");
    const contextLines = positiveInteger(rawInput.context);
    const limit = positiveInteger(rawInput.limit);
    const executors = await runtime.tools();
    const result = await withSandboxToolSpan(
      "sandbox.grep",
      "sandbox.fs.search",
      {
        "app.sandbox.pattern.length": pattern.length,
      },
      async () => {
        const response = await grepFiles({
          fs: executors.fs,
          pattern,
          ...(typeof rawInput.path === "string" ? { path: rawInput.path } : {}),
          ...(typeof rawInput.glob === "string" ? { glob: rawInput.glob } : {}),
          ...(typeof rawInput.ignoreCase === "boolean"
            ? { ignoreCase: rawInput.ignoreCase }
            : {}),
          ...(typeof rawInput.literal === "boolean"
            ? { literal: rawInput.literal }
            : {}),
          ...(contextLines ? { context: contextLines } : {}),
          ...(limit ? { limit } : {}),
        });
        setSpanStatus("ok");
        return response;
      },
    );

    return result as T;
  };

  const executeFindFilesTool = async <T>(
    rawInput: Record<string, unknown>,
  ): Promise<T> => {
    const pattern = String(rawInput.pattern ?? "");
    if (!pattern) {
      throw new ToolInputError("pattern is required");
    }

    logSandboxBootRequest("tool.findFiles");
    const limit = positiveInteger(rawInput.limit);
    const executors = await runtime.tools();
    const result = await withSandboxToolSpan(
      "sandbox.findFiles",
      "sandbox.fs.find",
      {
        "app.sandbox.pattern.length": pattern.length,
      },
      async () => {
        const response = await findFiles({
          fs: executors.fs,
          pattern,
          ...(typeof rawInput.path === "string" ? { path: rawInput.path } : {}),
          ...(limit ? { limit } : {}),
        });
        setSpanStatus("ok");
        return response;
      },
    );

    return result as T;
  };

  const executeListDirTool = async <T>(
    rawInput: Record<string, unknown>,
  ): Promise<T> => {
    logSandboxBootRequest("tool.listDir");
    const limit = positiveInteger(rawInput.limit);
    const executors = await runtime.tools();
    const result = await withSandboxToolSpan(
      "sandbox.listDir",
      "sandbox.fs.list",
      {},
      async () => {
        const response = await listDir({
          fs: executors.fs,
          ...(typeof rawInput.path === "string" ? { path: rawInput.path } : {}),
          ...(limit ? { limit } : {}),
        });
        setSpanStatus("ok");
        return response;
      },
    );

    return result as T;
  };

  const execute = async <T>(params: SandboxToolCall): Promise<T> => {
    const rawInput = (params.input ?? {}) as Record<string, unknown>;
    const bashCommand =
      params.toolName === "bash"
        ? String(rawInput.command ?? "").trim()
        : undefined;

    if (params.toolName === "bash") {
      if (!bashCommand) {
        throw new ToolInputError("command is required");
      }
    }

    try {
      if (bashCommand !== undefined) {
        return await executeBashTool(rawInput, bashCommand, params.signal);
      }

      if (params.toolName === "readFile") {
        return await executeReadFileTool(rawInput);
      }

      if (params.toolName === "editFile") {
        return await executeEditFileTool(rawInput);
      }

      if (params.toolName === "grep") {
        return await executeGrepTool(rawInput);
      }

      if (params.toolName === "findFiles") {
        return await executeFindFilesTool(rawInput);
      }

      if (params.toolName === "listDir") {
        return await executeListDirTool(rawInput);
      }

      if (params.toolName === "writeFile") {
        return await executeWriteFileTool(rawInput);
      }
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        // Do not replay an operation that may already have produced side effects.
        throw createSandboxUnavailableToolError(params.toolName, error);
      }
      if (isSandboxCommandStreamInterruptedError(error)) {
        throw new ToolInputError(
          `The sandbox command stream was interrupted during ${params.toolName}, so the operation did not complete reliably. It may have produced side effects; inspect the workspace or retry only if it is safe.`,
          { cause: error },
        );
      }
      throw error;
    }

    throw new Error(`unsupported sandbox tool: ${params.toolName}`);
  };

  const runWorkspaceOperation = async <T>(
    operation: string,
    callback: (sandbox: SandboxSession) => Promise<T>,
  ): Promise<T> => {
    try {
      return await callback(await runtime.acquire());
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        throw createSandboxUnavailableToolError(operation, error);
      }
      throw error;
    }
  };
  const workspace: SandboxWorkspace = {
    readFileToBuffer: async (input) =>
      await runWorkspaceOperation(
        "workspace.readFileToBuffer",
        async (sandbox) => await sandbox.readFileToBuffer(input),
      ),
    runCommand: async (input) =>
      await runWorkspaceOperation(
        "workspace.runCommand",
        async (sandbox) => await sandbox.runCommand(input),
      ),
    writeFiles: async (files) =>
      await runWorkspaceOperation("workspace.writeFiles", async (sandbox) => {
        await sandbox.writeFiles(files);
      }),
  };

  return {
    workspace,
    tools: {
      supports(toolName: string) {
        return SANDBOX_TOOL_NAMES.has(toolName);
      },
      execute,
    },
    sandboxRef() {
      return runtime.sandboxRef();
    },
    close() {
      runtime.close();
    },
  };
}
