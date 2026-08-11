import { randomUUID } from "node:crypto";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import {
  logInfo,
  setSpanAttributes,
  withSpan,
  type LogContext,
  type TracePropagationHeaders,
} from "@/chat/logging";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import { ensureDockerDaemon } from "@/chat/sandbox/docker";
import {
  isAlreadyExistsError,
  isSandboxMissingError,
  isSandboxUnavailableError,
  isSnapshottingError,
  wrapSandboxSetupError,
} from "@/chat/sandbox/errors";
import { buildNonInteractiveShellScript } from "@/chat/sandbox/noninteractive-command";
import { getSandboxResources } from "@/chat/sandbox/resources";
import { hash as profileHash } from "@/chat/sandbox/snapshot/profile";
import {
  isMissingError,
  resolve as resolveSnapshot,
  type Snapshot,
} from "@/chat/sandbox/snapshot/resolve";
import { syncSkillsToSandbox } from "@/chat/sandbox/skill-sync";
import {
  createSandboxSession,
  type SandboxCommandResult,
  type SandboxFileSystem,
  type SandboxSession,
} from "@/chat/sandbox/workspace";
import { sleep } from "@/chat/sleep";
import type { SkillMetadata } from "@/chat/skills";
import type { SandboxRef } from "@/chat/sandbox/ref";
import type { Workspace } from "@/chat/workspaces/types";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";

const DEFAULT_MAX_OUTPUT_LENGTH = 30_000;
const DEFAULT_BASH_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const SANDBOX_RUNTIME = "node22";
const SANDBOX_RUNTIME_BIN_DIR = `${SANDBOX_WORKSPACE_ROOT}/.junior/bin`;
const SNAPSHOT_BOOT_RETRY_COUNT = 3;
const SNAPSHOT_BOOT_RETRY_DELAY_MS = 1000;
const SANDBOX_NAME_PREFIX = "junior-";
const MAX_KEEPALIVE_INTERVAL_MS = 30_000;
const MIN_KEEPALIVE_INTERVAL_MS = 1_000;

interface SandboxCredentials {
  token?: string;
  teamId?: string;
  projectId?: string;
}

interface SandboxAcquisition {
  controller: AbortController;
  promise: Promise<SandboxSession>;
  settled: boolean;
  waiters: number;
}

function sandboxFetchOptions(
  signal?: AbortSignal,
): { fetch: typeof globalThis.fetch } | Record<string, never> {
  if (!signal) {
    return {};
  }

  return {
    fetch: (input, init) => {
      const requestSignal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return globalThis.fetch(input, {
        ...init,
        signal: requestSignal
          ? AbortSignal.any([requestSignal, signal])
          : signal,
      });
    },
  };
}

interface SandboxToolExecutors {
  sessionId: string;
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

interface SandboxRuntime {
  sandboxRef(): SandboxRef | undefined;
  switchWorkspace(workspace: Workspace, signal?: AbortSignal): Promise<void>;
  acquire(signal?: AbortSignal): Promise<SandboxSession>;
  tools(signal?: AbortSignal): Promise<SandboxToolExecutors>;
  refreshNetworkPolicy(traceHeaders?: TracePropagationHeaders): Promise<void>;
  close(): void;
}

interface ActiveSandbox {
  session: SandboxSession;
  networkPolicyKey?: string;
}

interface SandboxRuntimeOptions {
  sandboxRef?: SandboxRef;
  workspace?: Workspace;
  skills: SkillMetadata[];
  referenceFiles: string[];
  timeoutMs?: number;
  traceContext?: LogContext;
  commandEnv?: () => Promise<Record<string, string>>;
  createNetworkPolicy?: (
    egressId: string,
    traceHeaders?: TracePropagationHeaders,
  ) => NetworkPolicy | undefined;
  onSandboxPrepare?: (sandbox: SandboxSession) => void | Promise<void>;
  onWorkspacePrepare?: (sandbox: SandboxSession, workspace: Workspace) => Promise<void>;
  onSandboxRefChanged?: (sandboxRef: SandboxRef) => void | Promise<void>;
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

/** Own sandbox acquisition, preparation, and session-scoped tool caching. */
export function createSandboxRuntime(
  options: SandboxRuntimeOptions,
): SandboxRuntime {
  let activeSandbox: ActiveSandbox | null = null;
  let sandboxRef = options.sandboxRef;
  let reportedSandboxRef = options.sandboxRef;
  const availableSkills = [...options.skills];
  const availableReferenceFiles = [...options.referenceFiles];
  let acquiringSandbox: SandboxAcquisition | undefined;
  let keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const timeoutMs = options.timeoutMs ?? 1000 * 60 * 30;
  const traceContext = options.traceContext ?? {};
  let activeWorkspace = options.workspace;
  let dependencyProfileHash = profileHash(SANDBOX_RUNTIME, activeWorkspace);
  const resolveCommandEnv =
    options.commandEnv ?? (async () => ({}) as Record<string, string>);

  const withSandboxSpan = <T>(
    name: string,
    op: string,
    attributes: Record<string, unknown>,
    callback: () => Promise<T>,
  ): Promise<T> => withSpan(name, op, traceContext, callback, attributes);

  /** Drop unavailable live state while retaining the persisted hint for lazy reacquisition. */
  const invalidateSession = (sessionId?: string): void => {
    if (
      sessionId &&
      activeSandbox &&
      activeSandbox.session.sessionId !== sessionId
    ) {
      return;
    }
    activeSandbox = null;
    if (keepAliveTimer) {
      clearTimeout(keepAliveTimer);
      keepAliveTimer = undefined;
    }
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
    return options.createNetworkPolicy?.(sandboxName);
  };

  const reportSandboxRef = async (
    nextSandbox: SandboxSession,
  ): Promise<void> => {
    const nextRef: SandboxRef = {
      id: nextSandbox.sandboxId,
      ...(dependencyProfileHash ? { profileHash: dependencyProfileHash } : {}),
      ...(activeWorkspace ? { workspaceId: activeWorkspace.id } : {}),
    };
    sandboxRef = nextRef;
    if (
      reportedSandboxRef?.id === nextRef.id &&
      reportedSandboxRef.profileHash === nextRef.profileHash &&
      reportedSandboxRef.workspaceId === nextRef.workspaceId
    ) {
      return;
    }
    await options.onSandboxRefChanged?.(nextRef);
    reportedSandboxRef = nextRef;
  };

  const rememberSandbox = (
    nextSandbox: SandboxSession,
    networkPolicyKey?: string,
  ): SandboxSession => {
    activeSandbox = { session: nextSandbox, networkPolicyKey };
    return nextSandbox;
  };

  const failSetup = (error: unknown): never => {
    throw wrapSandboxSetupError(error);
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
    await syncSkills(targetSandbox);
    // Snapshots ship Docker clients; the daemon is per-boot and must start here.
    await ensureDockerDaemon(targetSandbox);
    await options.onSandboxPrepare?.(targetSandbox);
  };

  const applyNetworkPolicy = async (
    targetSandbox: SandboxSession,
    traceHeaders?: TracePropagationHeaders,
  ): Promise<string | undefined> => {
    const networkPolicy = options.createNetworkPolicy?.(
      targetSandbox.sessionId,
      traceHeaders,
    );
    if (!networkPolicy) {
      return undefined;
    }
    const networkPolicyKey = JSON.stringify(networkPolicy);
    const active =
      activeSandbox?.session === targetSandbox ? activeSandbox : undefined;
    if (active?.networkPolicyKey === networkPolicyKey) {
      return networkPolicyKey;
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
    if (active) {
      active.networkPolicyKey = networkPolicyKey;
    }
    return networkPolicyKey;
  };

  const probeSession = async (targetSandbox: SandboxSession): Promise<void> => {
    await withSandboxSpan(
      "sandbox.reuse_probe",
      "sandbox.acquire.probe",
      {
        "app.sandbox.reused": true,
        "app.sandbox.source": "memory",
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
    signal?: AbortSignal,
  ): Promise<SandboxSession> => {
    const resources = getSandboxResources();
    for (let attempt = 0; attempt < SNAPSHOT_BOOT_RETRY_COUNT; attempt += 1) {
      signal?.throwIfAborted();
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
            ...sandboxFetchOptions(signal),
          }),
        );
      } catch (error) {
        if (
          !isSnapshottingError(error) ||
          attempt === SNAPSHOT_BOOT_RETRY_COUNT - 1
        ) {
          throw error;
        }
        await sleep(SNAPSHOT_BOOT_RETRY_DELAY_MS, signal);
      }
    }

    throw new Error(`Failed to boot sandbox from snapshot ${snapshotId}`);
  };

  const setSnapshotAttributes = (snapshot: Snapshot): void => {
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
    snapshot: Snapshot;
    sandboxCredentials: SandboxCredentials | undefined;
    sandboxName: string;
    signal?: AbortSignal;
  }): Promise<SandboxSession> => {
    const { runtime, snapshot, sandboxCredentials, sandboxName, signal } =
      params;
    signal?.throwIfAborted();

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
          ...sandboxFetchOptions(signal),
        }),
      );
    }

    try {
      return await createSandboxFromSnapshot(
        snapshot.snapshotId,
        sandboxCredentials,
        sandboxName,
        signal,
      );
    } catch (error) {
      if (!isMissingError(error)) {
        throw error;
      }

      setSpanAttributes({
        "app.sandbox.snapshot.rebuild_after_missing": true,
      });
      const rebuiltSnapshot = await resolveSnapshot({
        runtime,
        timeoutMs,
        forceRebuild: true,
        staleSnapshotId: snapshot.snapshotId,
        signal,
        workspace: activeWorkspace,
        prepareWorkspace: activeWorkspace
          ? async (sandbox) => await prepareWorkspaceSnapshot(sandbox, activeWorkspace!)
          : undefined,
      });
      if (!rebuiltSnapshot.snapshotId) {
        throw error;
      }
      signal?.throwIfAborted();

      return await createSandboxFromSnapshot(
        rebuiltSnapshot.snapshotId,
        sandboxCredentials,
        sandboxName,
        signal,
      );
    }
  };

  const prepareWorkspaceSnapshot = async (
    sandbox: SandboxSession,
    workspace: Workspace,
  ): Promise<void> => {
    await options.onWorkspacePrepare?.(sandbox, workspace);
    if (!workspace.setupScript.trim()) return;
    const result = await sandbox.runCommand({
      cmd: "bash",
      args: ["-euo", "pipefail", "-c", workspace.setupScript],
      cwd: SANDBOX_WORKSPACE_ROOT,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Workspace setup failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
  };

  const createFreshSandbox = async (
    signal?: AbortSignal,
  ): Promise<SandboxSession> => {
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
          const snapshot = await resolveSnapshot({
            runtime,
            timeoutMs,
            signal,
            workspace: activeWorkspace,
            prepareWorkspace: activeWorkspace
              ? async (sandbox) => await prepareWorkspaceSnapshot(sandbox, activeWorkspace!)
              : undefined,
          });
          signal?.throwIfAborted();
          setSnapshotAttributes(snapshot);
          return await createSandboxFromResolvedSnapshot({
            runtime,
            snapshot,
            sandboxCredentials,
            sandboxName,
            signal,
          });
        },
      );
    } catch (error) {
      return failSetup(error);
    }

    await reportSandboxRef(createdSandbox);

    let networkPolicyKey: string | undefined;
    try {
      networkPolicyKey = await applyNetworkPolicy(createdSandbox);
      await prepareSandbox(createdSandbox);
    } catch (error) {
      return failSetup(error);
    }

    return rememberSandbox(createdSandbox, networkPolicyKey);
  };

  const discardHintIfProfileChanged = (): void => {
    if (
      activeSandbox ||
      !sandboxRef ||
      dependencyProfileHash === sandboxRef.profileHash
    ) {
      return;
    }

    setSpanAttributes({
      "app.sandbox.reused": false,
      "app.sandbox.recreate.reason": "dependency_profile_mismatch",
      ...(sandboxRef.profileHash
        ? {
            "app.sandbox.previous_profile_hash": sandboxRef.profileHash,
          }
        : {}),
      ...(dependencyProfileHash
        ? { "app.sandbox.current_profile_hash": dependencyProfileHash }
        : {}),
    });
    logInfo("sandbox.hint.discarded", {
      "app.decision.reason": "dependency_profile_mismatch",
      ...(sandboxRef.profileHash
        ? {
            "app.sandbox.previous_profile_hash": sandboxRef.profileHash,
          }
        : {}),
      ...(dependencyProfileHash
        ? { "app.sandbox.current_profile_hash": dependencyProfileHash }
        : {}),
    });
    sandboxRef = undefined;
  };

  const tryReuseCachedSandbox = async (): Promise<SandboxSession | null> => {
    return activeSandbox?.session ?? null;
  };

  const tryRestoreHintedSandbox = async (
    signal?: AbortSignal,
  ): Promise<SandboxSession | null> => {
    const ref = sandboxRef;
    if (!ref) {
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
              name: ref.id,
              resume: true,
              ...(sandboxCredentials ?? {}),
              ...sandboxFetchOptions(signal),
            }),
          ),
      );
    } catch (error) {
      if (isSandboxMissingError(error)) {
        sandboxRef = undefined;
        return null;
      }
      if (isSandboxUnavailableError(error)) {
        invalidateSession();
        throw error;
      }
      throw new Error("sandbox restore failed", { cause: error });
    }

    let networkPolicyKey: string | undefined;
    try {
      await reportSandboxRef(hintedSandbox);
      networkPolicyKey = await applyNetworkPolicy(hintedSandbox);
      await prepareSandbox(hintedSandbox);
      return rememberSandbox(hintedSandbox, networkPolicyKey);
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        throw error;
      }
      return failSetup(error);
    }
  };

  const acquireSandbox = async (
    signal?: AbortSignal,
  ): Promise<SandboxSession> => {
    return await withSandboxSpan(
      "sandbox.acquire",
      "sandbox.acquire",
      {
        "app.sandbox.id_hint_present": Boolean(sandboxRef),
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

        signal?.throwIfAborted();
        const hintedSandbox = await tryRestoreHintedSandbox(signal);
        if (hintedSandbox) {
          return hintedSandbox;
        }

        return await createFreshSandbox(signal);
      },
    );
  };

  const getOrAcquireSandbox = async (
    signal?: AbortSignal,
  ): Promise<SandboxSession> => {
    for (;;) {
      signal?.throwIfAborted();
      let acquisition = acquiringSandbox;
      if (!acquisition) {
        const controller = new AbortController();
        const startedAcquisition: SandboxAcquisition = {
          controller,
          promise: acquireSandbox(signal ? controller.signal : undefined),
          settled: false,
          waiters: 0,
        };
        const markSettled = () => {
          startedAcquisition.settled = true;
          if (acquiringSandbox === startedAcquisition) {
            acquiringSandbox = undefined;
          }
        };
        void startedAcquisition.promise.then(markSettled, markSettled);
        acquiringSandbox = startedAcquisition;
        acquisition = startedAcquisition;
      }

      acquisition.waiters += 1;
      let removeAbortListener: (() => void) | undefined;
      try {
        if (!signal) {
          return await acquisition.promise;
        }
        const aborted = new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () =>
            signal.removeEventListener("abort", onAbort);
        });
        return await Promise.race([acquisition.promise, aborted]);
      } catch (error) {
        signal?.throwIfAborted();
        if (!acquisition.controller.signal.aborted) {
          throw error;
        }
        if (acquiringSandbox === acquisition) {
          acquiringSandbox = undefined;
        }
      } finally {
        removeAbortListener?.();
        acquisition.waiters -= 1;
        if (acquisition.waiters === 0 && !acquisition.settled) {
          acquisition.controller.abort(signal?.reason);
        }
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
    const stdoutRaw = commandResult.stdout;
    const stderrRaw = commandResult.stderr;
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
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        throw error;
      }
      // Non-lifecycle keepalive failures are best effort.
    }
  };

  const startKeepAlive = (session: SandboxSession): void => {
    const keepAliveMs = parseKeepAliveMs();
    if (keepAliveMs === 0 || closed || keepAliveTimer) {
      return;
    }

    const intervalMs = Math.max(
      MIN_KEEPALIVE_INTERVAL_MS,
      Math.min(MAX_KEEPALIVE_INTERVAL_MS, Math.floor(keepAliveMs / 2)),
    );
    const schedule = (): void => {
      keepAliveTimer = setTimeout(async () => {
        keepAliveTimer = undefined;
        if (closed || activeSandbox?.session !== session) {
          return;
        }
        try {
          await extendKeepAlive(session);
        } catch {
          invalidateSession(session.sessionId);
          return;
        }
        if (closed || activeSandbox?.session !== session) {
          return;
        }
        schedule();
      }, intervalMs);
      keepAliveTimer.unref?.();
    };
    schedule();
  };

  const createToolExecutors = (
    sandboxInstance: SandboxSession,
  ): SandboxToolExecutors => {
    return {
      sessionId: sandboxInstance.sessionId,
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
            cwd: input.cwd ?? SANDBOX_WORKSPACE_ROOT,
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
      fs: sandboxInstance.fs as SandboxFileSystem,
      runCommand: async (input) => await sandboxInstance.runCommand(input),
    };
  };

  const ensureReadySandbox = async (
    signal?: AbortSignal,
  ): Promise<SandboxSession> => {
    const activeSandbox = await getOrAcquireSandbox(signal);
    signal?.throwIfAborted();
    await probeSession(activeSandbox);
    signal?.throwIfAborted();
    await extendKeepAlive(activeSandbox);
    startKeepAlive(activeSandbox);
    return activeSandbox;
  };

  return {
    sandboxRef() {
      return sandboxRef ? { ...sandboxRef } : undefined;
    },
    async switchWorkspace(workspace, signal) {
      if (activeWorkspace?.id === workspace.id && activeSandbox) return;
      await activeSandbox?.session.stop();
      activeWorkspace = workspace;
      dependencyProfileHash = profileHash(SANDBOX_RUNTIME, workspace);
      activeSandbox = null;
      sandboxRef = undefined;
      await getOrAcquireSandbox(signal);
    },
    async acquire(signal) {
      return await getOrAcquireSandbox(signal);
    },
    async tools(signal) {
      return createToolExecutors(await ensureReadySandbox(signal));
    },
    async refreshNetworkPolicy(traceHeaders) {
      const active = activeSandbox;
      if (!active) {
        return;
      }
      await applyNetworkPolicy(active.session, traceHeaders);
    },
    close() {
      closed = true;
      if (keepAliveTimer) {
        clearTimeout(keepAliveTimer);
        keepAliveTimer = undefined;
      }
    },
  };
}
