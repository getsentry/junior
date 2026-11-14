import type { TextReplacement } from "@/chat/tools/sandbox/text-edits";
import fs from "node:fs/promises";
import {
  getTracePropagationHeaders,
  logInfo,
  logWarn,
  setSpanAttributes,
  setSpanStatus,
  withSpan,
  type LogContext,
  type SetSpanAttributes,
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
import {
  SANDBOX_EGRESS_AUTH_REQUIRED_MARKER,
  type SandboxEgressSignalTransport,
} from "@/chat/sandbox/egress/signals";
import { formatSandboxCommandResult } from "@/chat/sandbox/command-result";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import type { CredentialAuditSource } from "@/chat/credentials/audit";
import type { CredentialContext } from "@/chat/credentials/context";
import { throwSandboxOperationError } from "@/chat/sandbox/errors";
import { getSandboxProvider } from "@/chat/sandbox/provider";
import {
  getWorkspaceSnapshotNotReadyError,
  workspaceSnapshotNotReadyUserMessage,
} from "@/chat/sandbox/snapshot/not-ready-error";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import { tryWorkspaceRepoCheckoutPath } from "@/chat/workspaces/checkout-path";
import {
  readRepositoryInstructions,
  type RepositoryInstructions,
} from "@/chat/repository-instructions";
import { createSandboxRuntime } from "@/chat/sandbox/session";
import {
  isHostFileMissingError,
  resolveHostDataPath,
  resolveHostSkillPath,
} from "@/chat/sandbox/skill-sync";
import type { SandboxRef } from "@/chat/sandbox/ref";
import {
  bindSandboxFileSystem,
  type SandboxFileSystem,
  type SandboxSession,
  type SandboxWorkspace,
} from "@/chat/sandbox/workspace";
import type { SkillMetadata } from "@/chat/skills";
import type { Workspace } from "@/chat/workspaces/types";
import { editFile } from "@/chat/tools/sandbox/edit-file";
import {
  isMissingPathError,
  positiveInteger,
  resolveWorkspacePath,
} from "@/chat/tools/sandbox/file-utils";
import {
  missingFileResult,
  sliceFileContent,
} from "@/chat/tools/sandbox/read-file";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";

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
  /** Resolve AGENTS.md instructions for each repository directory in the Workspace. */
  captureRepositoryInstructions(): Promise<RepositoryInstructions | undefined>;
  readonly tools: SandboxTools;
  readonly workspace: SandboxWorkspace;
  sandboxRef(): SandboxRef | undefined;
  switchWorkspace(workspace: Workspace, signal?: AbortSignal): Promise<void>;
  close(): void;
}

export interface SandboxOptions {
  sandboxRef?: SandboxRef | undefined;
  workspace?: Workspace | undefined;
  skills: SkillMetadata[];
  referenceFiles: string[];
  timeoutMs?: number | undefined;
  traceContext?: LogContext | undefined;
  tracePropagation?: SandboxEgressTracePropagationConfig | undefined;
  /** Conversation that sandbox egress records for its credentialed requests. */
  conversationId?: string | undefined;
  credentialEgress?: CredentialContext | undefined;
  /** Run Source that sandbox egress records for its credentialed writes. */
  credentialAuditSource?: CredentialAuditSource | undefined;
  egressSignals?: SandboxEgressSignalTransport | undefined;
  prepare?: ((workspace: SandboxWorkspace) => void | Promise<void>) | undefined;
  prepareWorkspace?:
    | ((
        workspace: SandboxWorkspace,
        recipe: Workspace,
        signal?: AbortSignal,
      ) => Promise<() => Promise<void>>)
    | undefined;
  onSandboxRefChanged?: (sandboxRef: SandboxRef) => void | Promise<void>;
}

interface SandboxToolCallContext {
  readonly signal?: AbortSignal | undefined;
  fileSystem(): Promise<SandboxFileSystem>;
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

/** Tool result when the Workspace sandbox is still preparing. */
function createWorkspaceSnapshotNotReadyToolResult(cause: unknown) {
  const notReady = getWorkspaceSnapshotNotReadyError(cause);
  if (!notReady) {
    throw new Error("expected WorkspaceSnapshotNotReadyError");
  }
  return makeStructuredToolOutput({
    status: "building" as const,
    workspace: notReady.workspaceName,
    message: workspaceSnapshotNotReadyUserMessage(notReady),
  });
}

const VERCEL_FIREWALL_CHALLENGE_MARKER = "Vercel Security Checkpoint";

const SANDBOX_TOOL_NAMES = new Set([
  "bash",
  "readFile",
  "editFile",
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
      conversationId: options.conversationId,
      credentials: credentialEgress,
      egressId,
      source: options.credentialAuditSource,
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
      ...(authRequired ? { authRequired } : undefined),
      ...(permissionDenied ? { permissionDenied } : undefined),
    };
  };
  // Egress auth and permission signals belong to the egress session, not to
  // one command, and the proxy cannot tell which command made a request. So
  // the bash commands of one Run run one at a time, also when a Code Mode
  // script starts them together. Each command then reads only its own signals.
  let bashTail: Promise<void> = Promise.resolve();
  let bashTurns = 0;
  /**
   * Wait for the earlier bash commands of this Run. `waited` is true when an
   * earlier command held the turn, so the Sandbox may have changed since.
   */
  const takeBashTurn = async () => {
    const waited = bashTurns > 0;
    bashTurns += 1;
    const earlier = bashTail;
    let done!: () => void;
    const turn = new Promise<void>((resolve) => {
      done = resolve;
    });
    bashTail = earlier.then(() => turn);
    await earlier;
    return {
      waited,
      release() {
        bashTurns -= 1;
        done();
      },
    };
  };
  let activeWorkspace = options.workspace;
  const runtime = createSandboxRuntime({
    sandboxRef: options.sandboxRef,
    workspace: options.workspace,
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
                : undefined),
              traceConfig: tracePropagation,
              traceHeaders,
            })
        : undefined,
    onSandboxPrepare: options.prepare,
    onWorkspacePrepare: options.prepareWorkspace,
    onSandboxRefChanged: options.onSandboxRefChanged,
  });
  const createToolCallContext = (
    signal?: AbortSignal,
  ): SandboxToolCallContext => {
    let fileSystemPromise: Promise<SandboxFileSystem> | undefined;

    return {
      signal,
      fileSystem() {
        signal?.throwIfAborted();
        return (fileSystemPromise ??= runtime.tools(signal).then(({ fs }) => {
          signal?.throwIfAborted();
          return bindSandboxFileSystem(fs, signal);
        }));
      },
    };
  };

  const withSandboxSpan = <T>(
    name: string,
    op: string,
    attributes: Record<string, unknown>,
    callback: (setSpanAttributes: SetSpanAttributes) => Promise<T>,
  ): Promise<T> => withSpan(name, op, traceContext, callback, attributes);

  // Network-policy header transforms need the current tool span's trace headers.
  const withSandboxToolSpan = <T>(
    name: string,
    op: string,
    attributes: Record<string, unknown>,
    callback: (setSpanAttributes: SetSpanAttributes) => Promise<T>,
  ): Promise<T> =>
    withSandboxSpan(name, op, attributes, async (setSpanAttributes) => {
      await runtime.refreshNetworkPolicy(getTracePropagationHeaders());
      return await callback(setSpanAttributes);
    });

  const logSandboxBootRequest = (
    trigger: string,
    details: Record<string, string | number> = {},
  ): void => {
    if (runtime.sandboxRef()) {
      return;
    }

    logInfo("sandbox.boot.requested", {
      "app.sandbox.boot.trigger": trigger,
      ...details,
    });
  };

  const executeBashTool = async <T>(
    rawInput: Record<string, unknown>,
    command: string,
    context: SandboxToolCallContext,
  ): Promise<T> => {
    const env = parseEnv(rawInput["env"]);
    const cwd =
      typeof rawInput["cwd"] === "string"
        ? resolveWorkspacePath(rawInput["cwd"])
        : SANDBOX_WORKSPACE_ROOT;
    const timeoutMs = positiveInteger(rawInput["timeoutMs"]);
    logSandboxBootRequest("tool.bash", {
      "app.sandbox.command_length": command.length,
    });
    // Resolve before the turn so concurrent calls share one acquisition.
    let tools = await runtime.tools(context.signal);
    const waitStartedAtMs = Date.now();
    const bashTurn = await takeBashTurn();
    const waitMs = Date.now() - waitStartedAtMs;
    try {
      context.signal?.throwIfAborted();
      // A switch or reacquire can replace the Sandbox while this command
      // waits. Run it on the current one and use that session's signals.
      if (bashTurn.waited) {
        tools = await runtime.tools(context.signal);
      }
      const { bash: executeBash, sessionId: activeSessionId } = tools;
      await clearEgressSignals(activeSessionId);
      const result = await withSandboxToolSpan(
        "bash",
        "process.exec",
        {
          "process.executable.name": "bash",
          "app.sandbox.bash.wait_ms": waitMs,
        },
        async () => {
          const response = await executeBash({
            command,
            cwd,
            ...(env ? { env } : undefined),
            ...(timeoutMs ? { timeoutMs } : undefined),
            ...(context.signal ? { signal: context.signal } : undefined),
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
          // Vercel's platform firewall can challenge the hop that forwards
          // credentialed traffic to the egress route. That request never
          // reaches Junior, so the checkpoint page is the only signal.
          if (
            `${response.stdout ?? ""}${response.stderr ?? ""}`.includes(
              VERCEL_FIREWALL_CHALLENGE_MARKER,
            )
          ) {
            logWarn("sandbox.egress.challenged", {
              "app.sandbox.egress_id": activeSessionId,
            });
          }
          setSpanStatus(response.exitCode === 0 ? "ok" : "error");
          return response;
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
      // The egress proxy answers a missing credential with this marker and
      // also records a signal. Output with the marker but no signal means
      // the signal went to another command or was lost.
      if (
        !authRequired &&
        `${result.stdout ?? ""}${result.stderr ?? ""}`.includes(
          `${SANDBOX_EGRESS_AUTH_REQUIRED_MARKER} provider=`,
        )
      ) {
        logWarn("sandbox.egress.auth_signal.missing", {
          "app.sandbox.egress_id": activeSessionId,
        });
      }

      return formatSandboxCommandResult({
        ok: result.exitCode === 0,
        command,
        cwd,
        exit_code: result.exitCode,
        signal: null,
        timed_out: Boolean(result.timedOut),
        aborted: Boolean(result.aborted),
        stdout: result.stdout,
        stderr: result.stderr,
        stdout_truncated: result.stdoutTruncated,
        stderr_truncated: result.stderrTruncated,
        ...(authRequired ? { auth_required: authRequired } : undefined),
        ...(permissionDenied
          ? { permission_denied: permissionDenied }
          : undefined),
      }) as T;
    } finally {
      bashTurn.release();
    }
  };

  const executeReadFileTool = async <T>(
    rawInput: Record<string, unknown>,
    context: SandboxToolCallContext,
  ): Promise<T> => {
    const filePath = String(rawInput["path"] ?? "").trim();
    if (!filePath) {
      throw new ToolInputError("path is required");
    }
    const offset = positiveInteger(rawInput["offset"]);
    const limit = positiveInteger(rawInput["limit"]);

    if (!runtime.sandboxRef()) {
      const hostPath =
        resolveHostSkillPath(options.skills, filePath) ??
        resolveHostDataPath(options.referenceFiles, filePath);
      if (hostPath) {
        try {
          const content = await fs.readFile(hostPath, {
            encoding: "utf8",
            ...(context.signal ? { signal: context.signal } : undefined),
          });
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
    const fileSystem = await context.fileSystem();
    const result = await withSandboxToolSpan(
      "sandbox.readFile",
      "sandbox.fs.read",
      {
        "app.sandbox.path.length": filePath.length,
      },
      async () => {
        let response: { content: string };
        try {
          response = {
            content: await fileSystem.readFile(resolveWorkspacePath(filePath), {
              encoding: "utf8",
            }),
          };
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
    context: SandboxToolCallContext,
  ): Promise<T> => {
    const filePath = String(rawInput["path"] ?? "").trim();
    if (!filePath) {
      throw new ToolInputError("path is required");
    }

    const workspacePath = resolveWorkspacePath(filePath);
    const content = String(rawInput["content"] ?? "");
    logSandboxBootRequest("tool.writeFile", {
      "file.path": filePath,
    });
    const fileSystem = await context.fileSystem();
    await withSandboxToolSpan(
      "sandbox.writeFile",
      "sandbox.fs.write",
      {
        "app.sandbox.path.length": filePath.length,
        "app.sandbox.write.bytes": Buffer.byteLength(content, "utf8"),
      },
      async () => {
        try {
          await fileSystem.writeFile(workspacePath, content, {
            encoding: "utf8",
          });
        } catch (error) {
          if (context.signal?.aborted) {
            throw error;
          }
          throwSandboxOperationError("sandbox writeFile", error);
        }
        setSpanStatus("ok");
      },
    );

    return makeStructuredToolOutput({
      target: filePath,
      path: filePath,
      bytes_written: Buffer.byteLength(content, "utf8"),
    }) as T;
  };

  const executeEditFileTool = async <T>(
    rawInput: Record<string, unknown>,
    context: SandboxToolCallContext,
  ): Promise<T> => {
    const filePath = String(rawInput["path"] ?? "").trim();
    if (!filePath) {
      throw new ToolInputError("path is required");
    }
    if (!Array.isArray(rawInput["edits"])) {
      throw new ToolInputError("edits is required");
    }

    logSandboxBootRequest("tool.editFile", {
      "file.path": filePath,
    });
    const fileSystem = await context.fileSystem();
    const result = await withSandboxToolSpan(
      "sandbox.editFile",
      "sandbox.fs.edit",
      {
        "app.sandbox.path.length": filePath.length,
        "app.sandbox.edit.count": rawInput["edits"].length,
      },
      async () => {
        const response = await editFile({
          fs: fileSystem,
          path: filePath,
          edits: rawInput["edits"] as TextReplacement[],
        });
        setSpanStatus("ok");
        return response;
      },
    );

    return result as T;
  };

  const execute = async <T>(params: SandboxToolCall): Promise<T> => {
    const rawInput = (params.input ?? {}) as Record<string, unknown>;
    const context = createToolCallContext(params.signal);
    const bashCommand =
      params.toolName === "bash"
        ? String(rawInput["command"] ?? "").trim()
        : undefined;

    if (params.toolName === "bash") {
      if (!bashCommand) {
        throw new ToolInputError("command is required");
      }
    }

    try {
      if (bashCommand !== undefined) {
        return await executeBashTool(rawInput, bashCommand, context);
      }

      if (params.toolName === "readFile") {
        return await executeReadFileTool(rawInput, context);
      }

      if (params.toolName === "editFile") {
        return await executeEditFileTool(rawInput, context);
      }

      if (params.toolName === "writeFile") {
        return await executeWriteFileTool(rawInput, context);
      }
    } catch (error) {
      params.signal?.throwIfAborted();
      if (getWorkspaceSnapshotNotReadyError(error)) {
        return createWorkspaceSnapshotNotReadyToolResult(error) as T;
      }
      if (getSandboxProvider().errors.isUnavailable(error)) {
        // Do not replay an operation that may already have produced side effects.
        throw createSandboxUnavailableToolError(params.toolName, error);
      }
      if (getSandboxProvider().errors.isCommandStreamInterrupted(error)) {
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
      const notReady = getWorkspaceSnapshotNotReadyError(error);
      if (notReady) {
        throw new ToolInputError(
          workspaceSnapshotNotReadyUserMessage(notReady),
          {
            cause: notReady,
          },
        );
      }
      if (getSandboxProvider().errors.isUnavailable(error)) {
        throw createSandboxUnavailableToolError(operation, error);
      }
      throw error;
    }
  };
  const workspace: SandboxWorkspace = {
    createPreview: async (port) =>
      await runWorkspaceOperation(
        "workspace.createPreview",
        async (sandbox) => {
          if (!sandbox.createPreview) {
            throw new ToolInputError(
              "This sandbox provider cannot create previews.",
            );
          }
          return await sandbox.createPreview(port);
        },
      ),
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
    async captureRepositoryInstructions() {
      if (!runtime.sandboxRef()) {
        return undefined;
      }
      const { runCommand } = await runtime.tools();
      const workspaceDirectories =
        activeWorkspace?.repos
          .map((repo) => tryWorkspaceRepoCheckoutPath(repo.repo))
          .filter((checkoutPath): checkoutPath is string =>
            Boolean(checkoutPath),
          )
          .map((checkoutPath) => `${SANDBOX_WORKSPACE_ROOT}/${checkoutPath}`) ??
        [];
      return await withSandboxSpan(
        "sandbox.repository_instructions.read",
        "sandbox.repository_instructions.read",
        {},
        async (setSpanAttributes) => {
          const { directories, instructions } =
            await readRepositoryInstructions({
              ...(workspaceDirectories.length > 0
                ? { directories: workspaceDirectories }
                : undefined),
              runCommand,
            });
          setSpanAttributes({
            "app.repository_instructions.repo_count": directories.length,
            "app.repository_instructions.found": Boolean(instructions),
          });
          return instructions;
        },
      );
    },
    workspace,
    async switchWorkspace(recipe, signal) {
      await runtime.switchWorkspace(recipe, signal);
      activeWorkspace = recipe;
    },
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
