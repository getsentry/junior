import { randomUUID } from "node:crypto";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { createBashTool } from "bash-tool";
import {
  logInfo,
  logWarn,
  setSpanAttributes,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import {
  isAlreadyExistsError,
  isSandboxCommandStreamInterruptedError,
  isSandboxUnavailableError,
  isSnapshottingError,
  wrapSandboxSetupError,
} from "@/chat/sandbox/errors";
import { buildNonInteractiveShellScript } from "@/chat/sandbox/noninteractive-command";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import {
  getRuntimeDependencyProfileHash,
  isSnapshotMissingError,
  resolveRuntimeDependencySnapshot,
  type RuntimeDependencySnapshot,
} from "@/chat/sandbox/runtime-dependency-snapshots";
import { syncSkillsToSandbox } from "@/chat/sandbox/skill-sync";
import {
  createSandboxInstance,
  type SandboxCommandResult,
  type SandboxFileSystem,
  type SandboxInstance,
} from "@/chat/sandbox/workspace";
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

function createBashToolSandboxAdapter(sandbox: SandboxInstance) {
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
  getSandboxEgressId(): string | undefined;
  getDependencyProfileHash(): string | undefined;
  createSandbox(): Promise<SandboxInstance>;
  ensureToolExecutors(): Promise<SandboxToolExecutors>;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseKeepAliveMs(): number {
  const parsed = Number.parseInt(
    process.env.VERCEL_SANDBOX_KEEPALIVE_MS ?? "0",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getCommandStreamInterruptedResult(): {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
} {
  return {
    stdout: "",
    stderr:
      "Command stream ended before the command finished. The command may still have produced side effects; inspect the workspace or rerun only if it is safe.",
    exitCode: 125,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
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
  createNetworkPolicy?: (egressId: string) => NetworkPolicy | undefined;
  onSandboxPrepare?: (sandbox: SandboxInstance) => void | Promise<void>;
  onSandboxAcquired?: (sandbox: {
    sandboxId: string;
    sandboxDependencyProfileHash?: string;
  }) => void | Promise<void>;
}): SandboxSessionManager {
  let sandbox: SandboxInstance | null = null;
  let sandboxIdHint = options?.sandboxId;
  let availableSkills: SkillMetadata[] = [];
  let availableReferenceFiles: string[] = [];
  let toolExecutors: SandboxToolExecutors | undefined;
  let loadingToolExecutors: Promise<SandboxToolExecutors> | undefined;
  let appliedNetworkPolicyKey: string | undefined;
  let preparedSandboxId: string | undefined;
  let acquiringSandbox: Promise<SandboxInstance> | undefined;

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

  const clearSession = (): void => {
    sandbox = null;
    sandboxIdHint = undefined;
    toolExecutors = undefined;
    loadingToolExecutors = undefined;
    appliedNetworkPolicyKey = undefined;
    preparedSandboxId = undefined;
  };

  const createSandboxName = (): string =>
    `${SANDBOX_NAME_PREFIX}${randomUUID()}`;

  const preflightNetworkPolicy = (
    sandboxName: string,
  ): NetworkPolicy | undefined => {
    // Build once before boot so missing proxy config fails before sandbox work.
    // The final route is rebound to the Vercel session id after creation.
    return options?.createNetworkPolicy?.(sandboxName);
  };

  const rememberSandbox = async (
    nextSandbox: SandboxInstance,
  ): Promise<SandboxInstance> => {
    sandbox = nextSandbox;
    sandboxIdHint = nextSandbox.sandboxId;
    toolExecutors = undefined;
    loadingToolExecutors = undefined;
    const acquired = {
      sandboxId: sandboxIdHint,
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

  const syncSkills = async (targetSandbox: SandboxInstance): Promise<void> => {
    await syncSkillsToSandbox({
      sandbox: targetSandbox,
      skills: availableSkills,
      referenceFiles: availableReferenceFiles,
      withSpan: withSandboxSpan,
    });
  };

  const prepareSandbox = async (
    targetSandbox: SandboxInstance,
  ): Promise<void> => {
    if (preparedSandboxId === targetSandbox.sandboxId) {
      return;
    }
    await syncSkills(targetSandbox);
    await options?.onSandboxPrepare?.(targetSandbox);
    preparedSandboxId = targetSandbox.sandboxId;
  };

  const refreshNetworkPolicy = async (
    targetSandbox: SandboxInstance,
  ): Promise<void> => {
    const networkPolicy = options?.createNetworkPolicy?.(
      targetSandbox.sandboxEgressId,
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
    targetSandbox: SandboxInstance,
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

  const recreateUnavailableSandbox = async (
    source: "memory" | "id_hint",
  ): Promise<SandboxInstance> => {
    setSpanAttributes({
      "app.sandbox.recovery.attempted": true,
      "app.sandbox.recovery.source": source,
    });
    logWarn(
      "sandbox_unavailable_recreating",
      traceContext,
      { "app.sandbox.recovery.source": source },
      "Sandbox unavailable; recreating",
    );
    clearSession();
    const replacement = await createFreshSandbox();
    setSpanAttributes({
      "app.sandbox.recovery.succeeded": true,
    });
    return replacement;
  };

  const createSandboxFromSnapshot = async (
    snapshotId: string,
    sandboxCredentials: SandboxCredentials | undefined,
    initialSandboxName: string,
  ): Promise<SandboxInstance> => {
    for (let attempt = 0; attempt < SNAPSHOT_BOOT_RETRY_COUNT; attempt += 1) {
      const sandboxName =
        attempt === 0 ? initialSandboxName : createSandboxName();
      const networkPolicy = preflightNetworkPolicy(sandboxName);
      try {
        return createSandboxInstance(
          await Sandbox.create({
            timeout: timeoutMs,
            ...(networkPolicy
              ? { name: sandboxName, persistent: false, networkPolicy }
              : {}),
            source: {
              type: "snapshot",
              snapshotId,
            },
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
  }): Promise<SandboxInstance> => {
    const { runtime, snapshot, sandboxCredentials, sandboxName } = params;

    if (!snapshot.snapshotId) {
      const networkPolicy = preflightNetworkPolicy(sandboxName);
      return createSandboxInstance(
        await Sandbox.create({
          timeout: timeoutMs,
          runtime,
          ...(networkPolicy
            ? { name: sandboxName, persistent: false, networkPolicy }
            : {}),
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

  const createFreshSandbox = async (): Promise<SandboxInstance> => {
    const runtime = SANDBOX_RUNTIME;
    const sandboxCredentials = getVercelSandboxCredentials();
    const sandboxName = createSandboxName();

    let createdSandbox: SandboxInstance;
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
      await refreshNetworkPolicy(createdSandbox);
      await prepareSandbox(createdSandbox);
    } catch (error) {
      return failSetup(error);
    }

    return await rememberSandbox(createdSandbox);
  };

  const discardHintIfProfileChanged = (): void => {
    if (
      sandbox ||
      !sandboxIdHint ||
      dependencyProfileHash === options?.sandboxDependencyProfileHash
    ) {
      return;
    }

    setSpanAttributes({
      "app.sandbox.reused": false,
      "app.sandbox.recreate.reason": "dependency_profile_mismatch",
      ...(options?.sandboxDependencyProfileHash
        ? {
            "app.sandbox.previous_profile_hash":
              options.sandboxDependencyProfileHash,
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
        ...(options?.sandboxDependencyProfileHash
          ? {
              "app.sandbox.previous_profile_hash":
                options.sandboxDependencyProfileHash,
            }
          : {}),
        ...(dependencyProfileHash
          ? { "app.sandbox.current_profile_hash": dependencyProfileHash }
          : {}),
      },
      "Dependency profile changed; discarding sandbox hint and creating fresh session",
    );
    sandboxIdHint = undefined;
  };

  const tryReuseCachedSandbox = async (): Promise<SandboxInstance | null> => {
    const cachedSandbox = sandbox;
    if (!cachedSandbox) {
      return null;
    }

    try {
      await ensureSandboxReachable(cachedSandbox, "memory");
      await refreshNetworkPolicy(cachedSandbox);
      await prepareSandbox(cachedSandbox);
      return cachedSandbox;
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        return await recreateUnavailableSandbox("memory");
      }
      return failSetup(error);
    }
  };

  const tryRestoreHintedSandbox = async (): Promise<SandboxInstance | null> => {
    if (!sandboxIdHint) {
      return null;
    }

    let hintedSandbox: SandboxInstance | null = null;
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
          createSandboxInstance(
            await Sandbox.get({
              name: sandboxIdHint as string,
              resume: true,
              ...(sandboxCredentials ?? {}),
            } as Parameters<typeof Sandbox.get>[0]),
          ),
      );
    } catch (error) {
      logWarn(
        "sandbox_restore_hint_failed",
        traceContext,
        {
          "app.sandbox.hint_id": sandboxIdHint,
          "app.sandbox.error":
            error instanceof Error ? error.message : String(error),
        },
        "Failed to restore sandbox from hint; will create fresh session",
      );
      return null;
    }

    try {
      await refreshNetworkPolicy(hintedSandbox);
      await prepareSandbox(hintedSandbox);
      return await rememberSandbox(hintedSandbox);
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        return await recreateUnavailableSandbox("id_hint");
      }
      return failSetup(error);
    }
  };

  const acquireSandbox = async (): Promise<SandboxInstance> => {
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

  const getOrAcquireSandbox = async (): Promise<SandboxInstance> => {
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
    activeSandbox: SandboxInstance,
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
    sandboxInstance: SandboxInstance,
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
          if (isSandboxCommandStreamInterruptedError(error)) {
            return getCommandStreamInterruptedResult();
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

  const ensureReadySandbox = async (): Promise<SandboxInstance> => {
    const activeSandbox = await getOrAcquireSandbox();
    await extendKeepAlive(activeSandbox);
    return activeSandbox;
  };

  const loadToolExecutors = async (
    activeSandbox: SandboxInstance,
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
    getSandboxEgressId() {
      return sandbox?.sandboxEgressId;
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
