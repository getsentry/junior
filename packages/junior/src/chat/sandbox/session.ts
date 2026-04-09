import { Sandbox } from "@vercel/sandbox";
import { createBashTool } from "bash-tool";
import {
  logWarn,
  setSpanAttributes,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import {
  makeAssistantStatus,
  type AssistantStatusSpec,
} from "@/chat/runtime/assistant-status";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import {
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
  type RuntimeDependencySnapshotProgressPhase,
} from "@/chat/sandbox/runtime-dependency-snapshots";
import { syncSkillsToSandbox } from "@/chat/sandbox/skill-sync";
import type { SandboxCommandResult } from "@/chat/sandbox/workspace";
import type { SkillMetadata } from "@/chat/skills";

const DEFAULT_MAX_OUTPUT_LENGTH = 30_000;
const SANDBOX_RUNTIME = "node22";
const SANDBOX_RUNTIME_BIN_DIR = `${SANDBOX_WORKSPACE_ROOT}/.junior/bin`;
const SNAPSHOT_BOOT_RETRY_COUNT = 3;
const SNAPSHOT_BOOT_RETRY_DELAY_MS = 1000;

interface SandboxCredentials {
  token?: string;
  teamId?: string;
  projectId?: string;
}

interface NetworkPolicyAllowEntry {
  transform?: Array<{ headers: Record<string, string> }>;
}

interface SandboxToolExecutors {
  bash: (input: {
    command: string;
    headerTransforms?: Array<{
      domain: string;
      headers: Record<string, string>;
    }>;
    env?: Record<string, string>;
  }) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }>;
  readFile: (input: { path: string }) => Promise<{ content: string }>;
  writeFile: (input: {
    path: string;
    content: string;
  }) => Promise<{ success: boolean }>;
}

interface SandboxSessionManager {
  configureSkills(skills: SkillMetadata[]): void;
  getSandboxId(): string | undefined;
  getDependencyProfileHash(): string | undefined;
  createSandbox(): Promise<Sandbox>;
  ensureToolExecutors(): Promise<SandboxToolExecutors>;
  dispose(): Promise<void>;
}

interface StatusEmitter {
  emit(status: AssistantStatusSpec): Promise<void>;
  reportSnapshotPhase(
    phase: RuntimeDependencySnapshotProgressPhase,
  ): Promise<void>;
}

const SNAPSHOT_PHASE_STATUS: Partial<
  Record<
    RuntimeDependencySnapshotProgressPhase,
    { kind: AssistantStatusSpec["kind"]; context: string }
  >
> = {
  resolve_start: { kind: "loading", context: "sandbox snapshot cache" },
  waiting_for_lock: { kind: "loading", context: "sandbox snapshot build" },
  building_snapshot: { kind: "creating", context: "sandbox snapshot" },
  cache_hit: { kind: "loading", context: "sandbox snapshot" },
};

function mergeNetworkPolicyWithHeaderTransforms(
  networkPolicy: unknown,
  headerTransforms: Array<{ domain: string; headers: Record<string, string> }>,
): { allow: Record<string, NetworkPolicyAllowEntry[]> } & Record<
  string,
  unknown
> {
  const basePolicy =
    networkPolicy &&
    typeof networkPolicy === "object" &&
    !Array.isArray(networkPolicy)
      ? ({ ...(networkPolicy as Record<string, unknown>) } as Record<
          string,
          unknown
        >)
      : {};

  const existingAllowRaw = basePolicy.allow;
  const existingAllow: Record<string, NetworkPolicyAllowEntry[]> =
    existingAllowRaw &&
    typeof existingAllowRaw === "object" &&
    !Array.isArray(existingAllowRaw)
      ? Object.fromEntries(
          Object.entries(existingAllowRaw as Record<string, unknown>).map(
            ([domain, rules]) => [
              domain,
              Array.isArray(rules)
                ? ([...rules] as NetworkPolicyAllowEntry[])
                : [],
            ],
          ),
        )
      : { "*": [] };

  for (const transform of headerTransforms) {
    const currentRules = existingAllow[transform.domain] ?? [];
    existingAllow[transform.domain] = [
      ...currentRules,
      { transform: [{ headers: transform.headers }] },
    ];
  }

  return {
    ...basePolicy,
    allow: existingAllow,
  };
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

function createStatusEmitter(
  emitStatus:
    | ((status: AssistantStatusSpec) => void | Promise<void>)
    | undefined,
): StatusEmitter {
  let statusCount = 0;
  const sentStatuses = new Set<string>();

  const emit = async (status: AssistantStatusSpec): Promise<void> => {
    const statusKey = `${status.kind}:${status.context ?? ""}`;
    if (!emitStatus || statusCount >= 4 || sentStatuses.has(statusKey)) {
      return;
    }

    sentStatuses.add(statusKey);
    statusCount += 1;
    await emitStatus(status);
  };

  const reportSnapshotPhase = async (
    phase: RuntimeDependencySnapshotProgressPhase,
  ): Promise<void> => {
    const status = SNAPSHOT_PHASE_STATUS[phase];
    if (status) {
      await emit(makeAssistantStatus(status.kind, status.context));
    }
  };

  return { emit, reportSnapshotPhase };
}

function parseKeepAliveMs(): number {
  const parsed = Number.parseInt(
    process.env.VERCEL_SANDBOX_KEEPALIVE_MS ?? "0",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Manage sandbox lifecycle, sync, keepalive, and tool executor caching for one executor instance. */
export function createSandboxSessionManager(options?: {
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  timeoutMs?: number;
  traceContext?: LogContext;
  onStatus?: (status: AssistantStatusSpec) => void | Promise<void>;
}): SandboxSessionManager {
  let sandbox: Sandbox | null = null;
  let sandboxIdHint = options?.sandboxId;
  let availableSkills: SkillMetadata[] = [];
  let toolExecutors: SandboxToolExecutors | undefined;

  const timeoutMs = options?.timeoutMs ?? 1000 * 60 * 30;
  const traceContext = options?.traceContext ?? {};
  const dependencyProfileHash =
    getRuntimeDependencyProfileHash(SANDBOX_RUNTIME);

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
  };

  const rememberSandbox = (nextSandbox: Sandbox): Sandbox => {
    sandbox = nextSandbox;
    sandboxIdHint = nextSandbox.sandboxId;
    toolExecutors = undefined;
    return nextSandbox;
  };

  const failSetup = (error: unknown): never => {
    throw wrapSandboxSetupError(error);
  };

  const syncSkills = async (targetSandbox: Sandbox): Promise<void> => {
    await syncSkillsToSandbox({
      sandbox: targetSandbox,
      skills: availableSkills,
      withSpan: withSandboxSpan,
      runtimeBinDir: SANDBOX_RUNTIME_BIN_DIR,
    });
  };

  const invalidateSandboxInstance = async (
    targetSandbox: Sandbox,
    reason: unknown,
  ): Promise<void> => {
    if (sandbox === targetSandbox) {
      clearSession();
    }
    logWarn(
      "sandbox_network_policy_restore_failed",
      traceContext,
      {
        "error.message":
          reason instanceof Error ? reason.message : String(reason),
      },
      "Sandbox network policy restore failed; discarding sandbox instance",
    );
    try {
      await targetSandbox.stop({ blocking: true });
    } catch {
      // Best effort shutdown; we already dropped executor references.
    }
  };

  const recreateUnavailableSandbox = async (
    source: "memory" | "id_hint",
  ): Promise<Sandbox> => {
    setSpanAttributes({
      "app.sandbox.recovery.attempted": true,
      "app.sandbox.recovery.source": source,
    });
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
    emitStatus?: (status: AssistantStatusSpec) => Promise<void>,
  ): Promise<Sandbox> => {
    for (let attempt = 0; attempt < SNAPSHOT_BOOT_RETRY_COUNT; attempt += 1) {
      try {
        await emitStatus?.(makeAssistantStatus("loading", "sandbox"));
        return await Sandbox.create({
          timeout: timeoutMs,
          source: {
            type: "snapshot",
            snapshotId,
          },
          ...(sandboxCredentials ?? {}),
        });
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
    status: StatusEmitter;
  }): Promise<Sandbox> => {
    const { runtime, snapshot, sandboxCredentials, status } = params;

    if (!snapshot.snapshotId) {
      await status.emit(makeAssistantStatus("loading", "sandbox"));
      return await Sandbox.create({
        timeout: timeoutMs,
        runtime,
        ...(sandboxCredentials ?? {}),
      });
    }

    try {
      return await createSandboxFromSnapshot(
        snapshot.snapshotId,
        sandboxCredentials,
        status.emit,
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
        onProgress: status.reportSnapshotPhase,
      });
      if (!rebuiltSnapshot.snapshotId) {
        throw error;
      }

      return await createSandboxFromSnapshot(
        rebuiltSnapshot.snapshotId,
        sandboxCredentials,
        status.emit,
      );
    }
  };

  const createFreshSandbox = async (): Promise<Sandbox> => {
    const runtime = SANDBOX_RUNTIME;
    const sandboxCredentials = getVercelSandboxCredentials();
    const status = createStatusEmitter(options?.onStatus);

    let createdSandbox: Sandbox;
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
          await status.emit(makeAssistantStatus("loading", "sandbox runtime"));
          const snapshot = await resolveRuntimeDependencySnapshot({
            runtime,
            timeoutMs,
            onProgress: status.reportSnapshotPhase,
          });
          setSnapshotAttributes(snapshot);
          return await createSandboxFromResolvedSnapshot({
            runtime,
            snapshot,
            sandboxCredentials,
            status,
          });
        },
      );
    } catch (error) {
      return failSetup(error);
    }

    try {
      await syncSkills(createdSandbox);
    } catch (error) {
      return failSetup(error);
    }

    return rememberSandbox(createdSandbox);
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
    sandboxIdHint = undefined;
  };

  const tryReuseCachedSandbox = async (): Promise<Sandbox | null> => {
    const cachedSandbox = sandbox;
    if (!cachedSandbox) {
      return null;
    }

    try {
      await withSandboxSpan(
        "sandbox.reuse_cached",
        "sandbox.acquire.cached",
        {
          "app.sandbox.reused": true,
          "app.sandbox.source": "memory",
        },
        async () => {
          await syncSkills(cachedSandbox);
        },
      );
      return cachedSandbox;
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        return await recreateUnavailableSandbox("memory");
      }
      return failSetup(error);
    }
  };

  const tryRestoreHintedSandbox = async (): Promise<Sandbox | null> => {
    if (!sandboxIdHint) {
      return null;
    }

    let hintedSandbox: Sandbox | null = null;
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
          await Sandbox.get({
            sandboxId: sandboxIdHint as string,
            ...(sandboxCredentials ?? {}),
          }),
      );
    } catch {
      return null;
    }

    try {
      await syncSkills(hintedSandbox);
      return rememberSandbox(hintedSandbox);
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        return await recreateUnavailableSandbox("id_hint");
      }
      return failSetup(error);
    }
  };

  const acquireSandbox = async (): Promise<Sandbox> => {
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

  const withTemporaryHeaderTransforms = async <T>(
    sandboxInstance: Sandbox,
    headerTransforms:
      | Array<{ domain: string; headers: Record<string, string> }>
      | undefined,
    callback: () => Promise<T>,
  ): Promise<T> => {
    if (!headerTransforms || headerTransforms.length === 0) {
      return await callback();
    }

    const restoreNetworkPolicy = sandboxInstance.networkPolicy ?? "allow-all";
    const policy = mergeNetworkPolicyWithHeaderTransforms(
      restoreNetworkPolicy,
      headerTransforms,
    );
    await sandboxInstance.updateNetworkPolicy(policy);

    let callbackError: unknown;
    let restoreError: unknown;
    let result: T | undefined;

    try {
      result = await callback();
    } catch (error) {
      callbackError = error;
      throw error;
    } finally {
      try {
        await sandboxInstance.updateNetworkPolicy(restoreNetworkPolicy);
      } catch (error) {
        restoreError = error;
        await invalidateSandboxInstance(sandboxInstance, error);
      }
    }

    if (restoreError && !callbackError) {
      throw restoreError;
    }

    return result as T;
  };

  const extendKeepAlive = async (activeSandbox: Sandbox): Promise<void> => {
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
    sandboxInstance: Sandbox,
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
          sandbox: sandboxInstance,
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
        const script = buildNonInteractiveShellScript(input.command, {
          env: input.env,
          pathPrefix: `${SANDBOX_RUNTIME_BIN_DIR}:$PATH`,
        });
        return await withTemporaryHeaderTransforms(
          sandboxInstance,
          input.headerTransforms,
          async () => {
            const commandResult = await sandboxInstance.runCommand({
              cmd: "bash",
              args: ["-c", script],
              cwd: SANDBOX_WORKSPACE_ROOT,
            });
            return await readCommandOutput(commandResult);
          },
        );
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
    };
  };

  const ensureReadySandbox = async (): Promise<Sandbox> => {
    const activeSandbox = await acquireSandbox();
    await extendKeepAlive(activeSandbox);
    return activeSandbox;
  };

  const loadToolExecutors = async (
    activeSandbox: Sandbox,
  ): Promise<SandboxToolExecutors> => {
    if (toolExecutors) {
      return toolExecutors;
    }

    toolExecutors = await buildToolExecutors(activeSandbox);
    return toolExecutors;
  };

  return {
    configureSkills(skills: SkillMetadata[]) {
      availableSkills = [...skills];
    },
    getSandboxId() {
      return sandbox?.sandboxId ?? sandboxIdHint;
    },
    getDependencyProfileHash() {
      return dependencyProfileHash;
    },
    async createSandbox() {
      return await acquireSandbox();
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
          await activeSandbox.stop({ blocking: true });
        },
      );

      sandbox = null;
      toolExecutors = undefined;
    },
  };
}
