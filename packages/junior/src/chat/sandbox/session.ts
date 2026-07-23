import { randomUUID } from "node:crypto";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { createBashTool } from "bash-tool";
import {
  logInfo,
  setSpanAttributes,
  withSpan,
  type LogContext,
  type TracePropagationHeaders,
} from "@/chat/logging";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import {
  isAlreadyExistsError,
  isSandboxUnavailableError,
  isSnapshottingError,
  wrapSandboxSetupError,
} from "@/chat/sandbox/errors";
import { buildNonInteractiveShellScript } from "@/chat/sandbox/noninteractive-command";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import { getSandboxResources } from "@/chat/sandbox/resources";
import {
  getRuntimeDependencyProfileHash,
  isSnapshotMissingError,
  resolveRuntimeDependencySnapshot,
  type RuntimeDependencySnapshot,
} from "@/chat/sandbox/runtime-dependency-snapshots";
import { syncSkillsToSandbox } from "@/chat/sandbox/skill-sync";
import {
  createSandboxSession,
  type SandboxCommandResult,
  type SandboxFileSystem,
  type SandboxSession,
} from "@/chat/sandbox/workspace";
import { sleep } from "@/chat/sleep";
import type { SkillMetadata } from "@/chat/skills";

const DEFAULT_MAX_OUTPUT_LENGTH = 30_000;
const DEFAULT_BASH_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const SANDBOX_RUNTIME = "node22";
const SANDBOX_RUNTIME_BIN_DIR = `${SANDBOX_WORKSPACE_ROOT}/.junior/bin`;
const SNAPSHOT_BOOT_RETRY_COUNT = 3;
const SNAPSHOT_BOOT_RETRY_DELAY_MS = 1000;
const SANDBOX_NAME_PREFIX = "junior-";

interface SandboxCredentials {
  token?: string;
  teamId?: string;
  projectId?: string;
}

interface SandboxToolExecutors {
  bash: (input: {
    command: string;
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
  readFile: (input: { path: string }) => Promise<{ content: string }>;
  writeFile: (input: {
    path: string;
    content: string;
  }) => Promise<{ success: boolean }>;
  fs: SandboxFileSystem;
}

function createBashToolSandboxAdapter(sandbox: SandboxSession) {
  return {
    async executeCommand(command: string) {
      const result = await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", command],
      });
      const [stdout, stderr] = await Promise.all([
        result.stdout(),
        result.stderr(),
      ]);
      return {
        stdout,
        stderr,
        exitCode: result.exitCode,
      };
    },
    async readFile(filePath: string) {
      const content = await sandbox.readFileToBuffer({ path: filePath });
      if (content == null) {
        throw new Error(`File not found: ${filePath}`);
      }
      return content.toString("utf8");
    },
    async writeFiles(files: Array<{ path: string; content: string | Buffer }>) {
      await sandbox.writeFiles(
        files.map((file) => ({
          path: file.path,
          content: file.content,
        })),
      );
    },
  };
}

interface SandboxSessionManager {
  configureSkills(skills: SkillMetadata[]): void;
  configureReferenceFiles(files: string[]): void;
  getSandboxId(): string | undefined;
  getSessionId(): string | undefined;
  getDependencyProfileHash(): string | undefined;
  createSandbox(): Promise<SandboxSession>;
  ensureToolExecutors(): Promise<SandboxToolExecutors>;
  refreshNetworkPolicy(traceHeaders?: TracePropagationHeaders): Promise<void>;
  dispose(): Promise<void>;
}

function truncateOutput(
  output: string,
  maxLength: number,
): { value: string; truncated: boolean } {
  if (output.length <= maxLength) {
    return { value: output, truncated: false };
  }
  const truncatedLength = output.length - maxLength;
  return {
    value: `${output.slice(0, maxLength)}\n\n[output truncated: ${truncatedLength} characters removed]`,
    truncated: true,
  };
}

function parseKeepAliveMs(): number {
  const parsed = Number.parseInt(
    process.env.VERCEL_SANDBOX_KEEPALIVE_MS ?? "0",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getCommandAbortedResult(): {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  aborted: true;
} {
  return {
    stdout: "",
    stderr: "Command aborted because the agent turn was cancelled.",
    exitCode: 130,
    stdoutTruncated: false,
    stderrTruncated: false,
    aborted: true,
  };
}

/** Manage sandbox lifecycle, sync, keepalive, and tool executor caching for one executor instance. */
export function createSandboxSessionManager(options?: {
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  timeoutMs?: number;
  traceContext?: LogContext;
  commandEnv?: () => Promise<Record<string, string>>;
  createNetworkPolicy?: (
    egressId: string,
    traceHeaders?: TracePropagationHeaders,
  ) => NetworkPolicy | undefined;
  onSandboxPrepare?: (sandbox: SandboxSession) => void | Promise<void>;
  onSandboxAcquired?: (sandbox: {
    sandboxId: string;
    sandboxDependencyProfileHash?: string;
  }) => void | Promise<void>;
}): SandboxSessionManager {
  let sandbox: SandboxSession | null = null;
  let sandboxIdHint = options?.sandboxId;
  let sandboxDependencyProfileHashHint = options?.sandboxDependencyProfileHash;
  let availableSkills: SkillMetadata[] = [];
  let availableReferenceFiles: string[] = [];
  let toolExecutors: SandboxToolExecutors | undefined;
  let loadingToolExecutors: Promise<SandboxToolExecutors> | undefined;
  let appliedNetworkPolicyKey: string | undefined;
  let preparedSandboxId: string | undefined;
  let acquiringSandbox: Promise<SandboxSession> | undefined;

  const timeoutMs = options?.timeoutMs ?? 1000 * 60 * 30;
  const traceContext = options?.traceContext ?? {};
  const dependencyProfileHash =
    getRuntimeDependencyProfileHash(SANDBOX_RUNTIME);
  const resolveCommandEnv =
    options?.commandEnv ?? (async () => ({}) as Record<string, string>);

  const withSandboxSpan = <T>(
    name: string,
    op: string,
    attributes: Record<string, unknown>,
    callback: () => Promise<T>,
  ): Promise<T> => withSpan(name, op, traceContext, callback, attributes);

  /** Drop unavailable live state while retaining the persisted hint for lazy reacquisition. */
  const invalidateSession = (sessionId?: string): void => {
    if (sessionId && sandbox && sandbox.sessionId !== sessionId) {
      return;
    }
    sandbox = null;
    toolExecutors = undefined;
    loadingToolExecutors = undefined;
    appliedNetworkPolicyKey = undefined;
    preparedSandboxId = undefined;
  };

  const adaptSandbox = (
    vercelSandbox: Parameters<typeof createSandboxSession>[0],
  ): SandboxSession =>
    createSandboxSession(vercelSandbox, {
      onUnavailable: invalidateSession,
    });

  const createSandboxName = (): string =>
    `${SANDBOX_NAME_PREFIX}${randomUUID()}`;

  const preflightNetworkPolicy = (
    sandboxName: string,
  ): NetworkPolicy | undefined => {
    // Build once before boot so missing proxy config fails before sandbox work.
    // The final route is rebound to the Vercel session id after creation.
    return options?.createNetworkPolicy?.(sandboxName);
  };

  const retainSandboxHint = (nextSandbox: SandboxSession): void => {
    sandboxIdHint = nextSandbox.sandboxId;
    sandboxDependencyProfileHashHint = dependencyProfileHash;
  };

  const rememberSandbox = async (
    nextSandbox: SandboxSession,
  ): Promise<SandboxSession> => {
    sandbox = nextSandbox;
    retainSandboxHint(nextSandbox);
    toolExecutors = undefined;
    loadingToolExecutors = undefined;
    const acquired = {
      sandboxId: nextSandbox.sandboxId,
      ...(dependencyProfileHash
        ? { sandboxDependencyProfileHash: dependencyProfileHash }
        : {}),
    };
    await options?.onSandboxAcquired?.(acquired);
    return nextSandbox;
  };

  const failSetup = (error: unknown): never => {
    throw wrapSandboxSetupError(error);
  };

  const failRestore = (error: unknown): never => {
    throw new Error("sandbox restore failed", { cause: error });
  };

  const syncSkills = async (targetSandbox: SandboxSession): Promise<void> => {
    await syncSkillsToSandbox({
      sandbox: targetSandbox,
      skills: availableSkills,
      referenceFiles: availableReferenceFiles,
      withSpan: withSandboxSpan,
    });
  };

  const prepareSandbox = async (
    targetSandbox: SandboxSession,
  ): Promise<void> => {
    if (preparedSandboxId === targetSandbox.sandboxId) {
      return;
    }
    await syncSkills(targetSandbox);
    await options?.onSandboxPrepare?.(targetSandbox);
    preparedSandboxId = targetSandbox.sandboxId;
  };

  const applyNetworkPolicy = async (
    targetSandbox: SandboxSession,
    traceHeaders?: TracePropagationHeaders,
  ): Promise<void> => {
    const networkPolicy = options?.createNetworkPolicy?.(
      targetSandbox.sessionId,
      traceHeaders,
    );
    if (!networkPolicy) {
      return;
    }
    const networkPolicyKey = JSON.stringify(networkPolicy);
    if (appliedNetworkPolicyKey === networkPolicyKey) {
      return;
    }

    await withSandboxSpan(
      "sandbox.network_policy.update",
      "sandbox.update",
      {
        "app.sandbox.reused": true,
        "app.sandbox.source": "id_hint",
      },
      async () => {
        await targetSandbox.update({ networkPolicy });
      },
    );
    appliedNetworkPolicyKey = networkPolicyKey;
  };

  const ensureSandboxReachable = async (
    targetSandbox: SandboxSession,
    source: "memory" | "id_hint",
  ): Promise<void> => {
    await withSandboxSpan(
      "sandbox.reuse_probe",
      "sandbox.acquire.probe",
      {
        "app.sandbox.reused": true,
        "app.sandbox.source": source,
      },
      async () => {
        try {
          await targetSandbox.mkDir(SANDBOX_WORKSPACE_ROOT);
        } catch (error) {
          if (!isAlreadyExistsError(error)) {
            throw error;
          }
        }
      },
    );
  };

  const createSandboxFromSnapshot = async (
    snapshotId: string,
    sandboxCredentials: SandboxCredentials | undefined,
    initialSandboxName: string,
  ): Promise<SandboxSession> => {
    const resources = getSandboxResources();
    for (let attempt = 0; attempt < SNAPSHOT_BOOT_RETRY_COUNT; attempt += 1) {
      const sandboxName =
        attempt === 0 ? initialSandboxName : createSandboxName();
      const networkPolicy = preflightNetworkPolicy(sandboxName);
      try {
        return adaptSandbox(
          await Sandbox.create({
            timeout: timeoutMs,
            ...(networkPolicy
              ? { name: sandboxName, persistent: false, networkPolicy }
              : {}),
            source: {
              type: "snapshot",
              snapshotId,
            },
            ...(resources ? { resources } : {}),
            ...(sandboxCredentials ?? {}),
          } as Parameters<typeof Sandbox.create>[0]),
        );
      } catch (error) {
        if (
          !isSnapshottingError(error) ||
          attempt === SNAPSHOT_BOOT_RETRY_COUNT - 1
        ) {
          throw error;
        }
        await sleep(SNAPSHOT_BOOT_RETRY_DELAY_MS);
      }
    }

    throw new Error(`Failed to boot sandbox from snapshot ${snapshotId}`);
  };

  const setSnapshotAttributes = (snapshot: RuntimeDependencySnapshot): void => {
    setSpanAttributes({
      "app.sandbox.source": snapshot.snapshotId ? "snapshot" : "created",
      "app.sandbox.snapshot.cache_hit": snapshot.cacheHit,
      "app.sandbox.snapshot.resolve_outcome": snapshot.resolveOutcome,
      ...(snapshot.profileHash
        ? {
            "app.sandbox.snapshot.profile_hash": snapshot.profileHash,
          }
        : {}),
      "app.sandbox.snapshot.dependency_count": snapshot.dependencyCount,
      ...(snapshot.rebuildReason
        ? {
            "app.sandbox.snapshot.rebuild_reason": snapshot.rebuildReason,
          }
        : {}),
    });
  };

  const createSandboxFromResolvedSnapshot = async (params: {
    runtime: string;
    snapshot: RuntimeDependencySnapshot;
    sandboxCredentials: SandboxCredentials | undefined;
    sandboxName: string;
  }): Promise<SandboxSession> => {
    const { runtime, snapshot, sandboxCredentials, sandboxName } = params;

    if (!snapshot.snapshotId) {
      const networkPolicy = preflightNetworkPolicy(sandboxName);
      const resources = getSandboxResources();
      return adaptSandbox(
        await Sandbox.create({
          timeout: timeoutMs,
          runtime,
          ...(networkPolicy
            ? { name: sandboxName, persistent: false, networkPolicy }
            : {}),
          ...(resources ? { resources } : {}),
          ...(sandboxCredentials ?? {}),
        } as Parameters<typeof Sandbox.create>[0]),
      );
    }

    try {
      return await createSandboxFromSnapshot(
        snapshot.snapshotId,
        sandboxCredentials,
        sandboxName,
      );
    } catch (error) {
      if (!isSnapshotMissingError(error)) {
        throw error;
      }

      setSpanAttributes({
        "app.sandbox.snapshot.rebuild_after_missing": true,
      });
      const rebuiltSnapshot = await resolveRuntimeDependencySnapshot({
        runtime,
        timeoutMs,
        forceRebuild: true,
        staleSnapshotId: snapshot.snapshotId,
      });
      if (!rebuiltSnapshot.snapshotId) {
        throw error;
      }

      return await createSandboxFromSnapshot(
        rebuiltSnapshot.snapshotId,
        sandboxCredentials,
        sandboxName,
      );
    }
  };

  const createFreshSandbox = async (): Promise<SandboxSession> => {
    const runtime = SANDBOX_RUNTIME;
    const sandboxCredentials = getVercelSandboxCredentials();
    const sandboxName = createSandboxName();

    let createdSandbox: SandboxSession;
    try {
      createdSandbox = await withSandboxSpan(
        "sandbox.create",
        "sandbox.create",
        {
          "app.sandbox.reused": false,
          "app.sandbox.timeout_ms": timeoutMs,
          "app.sandbox.runtime": runtime,
        },
        async () => {
          const snapshot = await resolveRuntimeDependencySnapshot({
            runtime,
            timeoutMs,
          });
          setSnapshotAttributes(snapshot);
          return await createSandboxFromResolvedSnapshot({
            runtime,
            snapshot,
            sandboxCredentials,
            sandboxName,
          });
        },
      );
    } catch (error) {
      return failSetup(error);
    }

    try {
      await applyNetworkPolicy(createdSandbox);
      await prepareSandbox(createdSandbox);
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        retainSandboxHint(createdSandbox);
      }
      return failSetup(error);
    }

    return await rememberSandbox(createdSandbox);
  };

  const discardHintIfProfileChanged = (): void => {
    if (
      sandbox ||
      !sandboxIdHint ||
      dependencyProfileHash === sandboxDependencyProfileHashHint
    ) {
      return;
    }

    setSpanAttributes({
      "app.sandbox.reused": false,
      "app.sandbox.recreate.reason": "dependency_profile_mismatch",
      ...(sandboxDependencyProfileHashHint
        ? {
            "app.sandbox.previous_profile_hash":
              sandboxDependencyProfileHashHint,
          }
        : {}),
      ...(dependencyProfileHash
        ? { "app.sandbox.current_profile_hash": dependencyProfileHash }
        : {}),
    });
    logInfo(
      "sandbox_hint_discarded_profile_mismatch",
      traceContext,
      {
        ...(sandboxDependencyProfileHashHint
          ? {
              "app.sandbox.previous_profile_hash":
                sandboxDependencyProfileHashHint,
            }
          : {}),
        ...(dependencyProfileHash
          ? { "app.sandbox.current_profile_hash": dependencyProfileHash }
          : {}),
      },
      "Dependency profile changed; discarding sandbox hint and creating fresh session",
    );
    sandboxIdHint = undefined;
    sandboxDependencyProfileHashHint = undefined;
  };

  const tryReuseCachedSandbox = async (): Promise<SandboxSession | null> => {
    const cachedSandbox = sandbox;
    if (!cachedSandbox) {
      return null;
    }

    try {
      await ensureSandboxReachable(cachedSandbox, "memory");
      await applyNetworkPolicy(cachedSandbox);
      await prepareSandbox(cachedSandbox);
      return cachedSandbox;
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        throw error;
      }
      return failSetup(error);
    }
  };

  const tryRestoreHintedSandbox = async (): Promise<SandboxSession | null> => {
    if (!sandboxIdHint) {
      return null;
    }

    let hintedSandbox: SandboxSession | null = null;
    try {
      const sandboxCredentials = getVercelSandboxCredentials();
      hintedSandbox = await withSandboxSpan(
        "sandbox.get",
        "sandbox.get",
        {
          "app.sandbox.reused": true,
          "app.sandbox.source": "id_hint",
        },
        async () =>
          adaptSandbox(
            await Sandbox.get({
              name: sandboxIdHint as string,
              resume: true,
              ...(sandboxCredentials ?? {}),
            } as Parameters<typeof Sandbox.get>[0]),
          ),
      );
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        invalidateSession();
        throw error;
      }
      return failRestore(error);
    }

    try {
      await applyNetworkPolicy(hintedSandbox);
      await prepareSandbox(hintedSandbox);
      return await rememberSandbox(hintedSandbox);
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        throw error;
      }
      return failSetup(error);
    }
  };

  const acquireSandbox = async (): Promise<SandboxSession> => {
    return await withSandboxSpan(
      "sandbox.acquire",
      "sandbox.acquire",
      {
        "app.sandbox.id_hint_present": Boolean(sandboxIdHint),
        "app.sandbox.timeout_ms": timeoutMs,
        "app.sandbox.runtime": SANDBOX_RUNTIME,
        "app.sandbox.skills_count": availableSkills.length,
      },
      async () => {
        discardHintIfProfileChanged();

        const cachedSandbox = await tryReuseCachedSandbox();
        if (cachedSandbox) {
          return cachedSandbox;
        }

        const hintedSandbox = await tryRestoreHintedSandbox();
        if (hintedSandbox) {
          return hintedSandbox;
        }

        return await createFreshSandbox();
      },
    );
  };

  const getOrAcquireSandbox = async (): Promise<SandboxSession> => {
    if (acquiringSandbox) {
      return await acquiringSandbox;
    }

    const nextSandbox = acquireSandbox();
    acquiringSandbox = nextSandbox;
    try {
      return await nextSandbox;
    } finally {
      if (acquiringSandbox === nextSandbox) {
        acquiringSandbox = undefined;
      }
    }
  };

  const getMaxOutputLength = (): number => {
    const maxOutputLength = Number.parseInt(
      process.env.SANDBOX_BASH_MAX_OUTPUT_CHARS ?? "",
      10,
    );
    return Number.isFinite(maxOutputLength) && maxOutputLength > 0
      ? maxOutputLength
      : DEFAULT_MAX_OUTPUT_LENGTH;
  };

  const readCommandOutput = async (
    commandResult: SandboxCommandResult,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }> => {
    const boundedOutputLength = getMaxOutputLength();
    const stdoutRaw = await commandResult.stdout();
    const stderrRaw = await commandResult.stderr();
    const stdout = truncateOutput(stdoutRaw, boundedOutputLength);
    const stderr = truncateOutput(stderrRaw, boundedOutputLength);
    return {
      stdout: stdout.value,
      stderr: stderr.value,
      exitCode: commandResult.exitCode,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  };

  const extendKeepAlive = async (
    activeSandbox: SandboxSession,
  ): Promise<void> => {
    const keepAliveMs = parseKeepAliveMs();
    if (keepAliveMs === 0) {
      return;
    }

    try {
      await withSandboxSpan(
        "sandbox.keepalive.extend",
        "sandbox.keepalive",
        {
          "app.sandbox.keepalive_ms": keepAliveMs,
        },
        async () => {
          await activeSandbox.extendTimeout(keepAliveMs);
        },
      );
    } catch {
      // Best effort keepalive.
    }
  };

  const buildToolExecutors = async (
    sandboxInstance: SandboxSession,
  ): Promise<SandboxToolExecutors> => {
    const toolkit = await withSandboxSpan(
      "sandbox.bash_tool.init",
      "sandbox.tool.init",
      {
        "app.sandbox.tool_name": "bash",
        "app.sandbox.destination": SANDBOX_WORKSPACE_ROOT,
      },
      async () =>
        await createBashTool({
          sandbox: createBashToolSandboxAdapter(sandboxInstance),
          destination: SANDBOX_WORKSPACE_ROOT,
        }),
    );

    const executeReadFile = toolkit.tools.readFile.execute;
    const executeWriteFile = toolkit.tools.writeFile.execute;
    if (!executeReadFile || !executeWriteFile) {
      throw new Error("bash-tool did not return executable tool handlers");
    }

    return {
      bash: async (input) => {
        let timedOut = false;
        let aborted = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        try {
          if (input.signal?.aborted) {
            return getCommandAbortedResult();
          }
          const sandboxCommandEnv = await resolveCommandEnv();
          if (input.signal?.aborted) {
            return getCommandAbortedResult();
          }
          const script = buildNonInteractiveShellScript(input.command, {
            env: { ...sandboxCommandEnv, ...(input.env ?? {}) },
            pathPrefix: `${SANDBOX_RUNTIME_BIN_DIR}:$PATH`,
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
            cwd: SANDBOX_WORKSPACE_ROOT,
            signal: controller.signal,
          });
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
      readFile: async (input) =>
        (await executeReadFile(input, {
          toolCallId: "sandbox-read-file",
          messages: [],
        })) as { content: string },
      writeFile: async (input) =>
        (await executeWriteFile(input, {
          toolCallId: "sandbox-write-file",
          messages: [],
        })) as { success: boolean },
      fs: sandboxInstance.fs as SandboxFileSystem,
    };
  };

  const ensureReadySandbox = async (): Promise<SandboxSession> => {
    const activeSandbox = await getOrAcquireSandbox();
    await extendKeepAlive(activeSandbox);
    return activeSandbox;
  };

  const loadToolExecutors = async (
    activeSandbox: SandboxSession,
  ): Promise<SandboxToolExecutors> => {
    if (toolExecutors) {
      return toolExecutors;
    }
    if (loadingToolExecutors) {
      return await loadingToolExecutors;
    }

    const nextToolExecutors = buildToolExecutors(activeSandbox).then(
      (executors) => {
        toolExecutors = executors;
        return executors;
      },
    );
    loadingToolExecutors = nextToolExecutors;
    try {
      return await nextToolExecutors;
    } finally {
      if (loadingToolExecutors === nextToolExecutors) {
        loadingToolExecutors = undefined;
      }
    }
  };

  return {
    configureSkills(skills: SkillMetadata[]) {
      availableSkills = [...skills];
    },
    configureReferenceFiles(files: string[]) {
      availableReferenceFiles = [...files];
    },
    getSandboxId() {
      return sandbox ? sandbox.sandboxId : sandboxIdHint;
    },
    getSessionId() {
      return sandbox?.sessionId;
    },
    getDependencyProfileHash() {
      return dependencyProfileHash;
    },
    async createSandbox() {
      return await getOrAcquireSandbox();
    },
    async ensureToolExecutors() {
      return await loadToolExecutors(await ensureReadySandbox());
    },
    async refreshNetworkPolicy(traceHeaders) {
      const activeSandbox = sandbox;
      if (!activeSandbox) {
        return;
      }
      await applyNetworkPolicy(activeSandbox, traceHeaders);
    },
    async dispose() {
      const activeSandbox = sandbox;
      if (!activeSandbox) {
        return;
      }

      await withSandboxSpan(
        "sandbox.stop",
        "sandbox.stop",
        {
          "app.sandbox.stop.blocking": true,
        },
        async () => {
          await activeSandbox.stop();
        },
      );

      sandbox = null;
      toolExecutors = undefined;
      loadingToolExecutors = undefined;
    },
  };
}
