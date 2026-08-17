import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { getDb } from "@/chat/db";
import { logException } from "@/chat/logging";
import { getTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import {
  isAbortError,
  isSandboxApiTransientError,
} from "@/chat/sandbox/errors";
import {
  prepareWorkspaceRepositories,
  workspaceSnapshotSetupCommand,
} from "@/chat/sandbox/prepare-workspace";
import { getSandboxResources } from "@/chat/sandbox/resources";
import {
  deleteWorkspaceSnapshotBuilders,
  getWorkspaceSnapshotBuilder,
} from "@/chat/sandbox/snapshot/builder-sandbox";
import * as install from "@/chat/sandbox/snapshot/install";
import * as profile from "@/chat/sandbox/snapshot/profile";
import {
  getCachedSnapshot,
  setCachedSnapshot,
  type Snapshot,
} from "@/chat/sandbox/snapshot/resolve";
import {
  invalidateMissingReadySnapshot,
  loadSnapshotsForProfile,
  setWorkspaceSnapshot,
  setWorkspaceSnapshotBuild,
} from "@/chat/sandbox/snapshot/store";
import { WorkspaceSnapshotWaitingError } from "@/chat/sandbox/snapshot/waiting-error";
import {
  createSandboxSession,
  type SandboxSession,
} from "@/chat/sandbox/workspace";
import { sleep } from "@/chat/sleep";
import { getStateAdapter } from "@/chat/state/adapter";
import { fenceLock, withLock } from "@/chat/state/locks";
import { getWorkspace } from "@/chat/workspaces/store";
import type {
  Workspace,
  WorkspaceSnapshotBuild,
} from "@/chat/workspaces/types";

// Workspace snapshot resolution owns the durable build state and the named
// builder Sandbox. Each call advances at most one recorded build phase.
const BUILD_TIMEOUT_MS = 60 * 60 * 1000;
const BUILD_TIMEOUT_ERROR = "Workspace snapshot build timed out after 1 hour";
const BUILD_LOCK_TTL_MS = 2 * 60 * 1000;
const BUILD_LOCK_PREFIX = "junior:workspace_snapshot_start";
const WAIT_POLL_MS = 5_000;
const TRANSIENT_API_RETRY_MS = 2_000;
const BUILD_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_STATUS_POLL_TIMEOUT_MS = 1_000;
/** Leave time for the tool result and durable run checkpoint. */
const WAIT_YIELD_BUFFER_MS = 40_000;

/** Keep a named builder resumable when the caller stops or Vercel is transient. */
function isCancelOrTransient(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    isAbortError(error) ||
    isSandboxApiTransientError(error)
  );
}

function buildLockKey(profileHash: string): string {
  return `${BUILD_LOCK_PREFIX}:${profileHash}`;
}

function builderName(): string {
  return `junior-ws-${randomUUID()}`;
}

function snapshotFromCache(
  cached: Awaited<ReturnType<typeof getCachedSnapshot>>,
  value: profile.Profile,
  staleSnapshotId?: string,
): Snapshot | null {
  if (
    !cached ||
    cached.snapshotId === staleSnapshotId ||
    profile.isStale(value, cached.createdAtMs)
  ) {
    return null;
  }
  return {
    snapshotId: cached.snapshotId,
    profileHash: cached.profileHash,
    dependencyCount: cached.dependencyCount,
    cacheHit: true,
    resolveOutcome: "cache_hit",
    createdAtMs: cached.createdAtMs,
    buildDurationMs: cached.buildDurationMs,
  };
}

async function snapshotFromSql(
  workspaceId: string,
  value: profile.Profile,
  runtime: string,
  staleSnapshotId?: string,
): Promise<Snapshot | null> {
  const { ready } = await loadSnapshotsForProfile(
    getDb(),
    workspaceId,
    value.hash,
  );
  if (!ready || profile.isStale(value, ready.generatedAt.getTime())) {
    return null;
  }
  if (ready.id === staleSnapshotId) {
    await invalidateMissingReadySnapshot({
      workspaceId,
      profileHash: value.hash,
      snapshotId: ready.id,
    });
    return null;
  }
  try {
    await setCachedSnapshot({
      profileHash: ready.profileHash,
      snapshotId: ready.id,
      runtime,
      createdAtMs: ready.generatedAt.getTime(),
      dependencyCount: value.dependencyCount,
      buildDurationMs: ready.buildDurationMs,
    });
  } catch {
    // SQL is authoritative. Redis warming is best effort.
  }
  return {
    snapshotId: ready.id,
    profileHash: ready.profileHash,
    dependencyCount: value.dependencyCount,
    cacheHit: true,
    resolveOutcome: "cache_hit",
    createdAtMs: ready.generatedAt.getTime(),
    buildDurationMs: ready.buildDurationMs,
  };
}

/** Return only a build row that has enough durable state to resume. */
function activeBuild(
  build: WorkspaceSnapshotBuild | null,
): WorkspaceSnapshotBuild | null {
  if (!build || build.status !== "building" || !build.sandboxName) return null;
  return build;
}

async function deleteBuilder(
  sandboxName: string | null | undefined,
): Promise<void> {
  if (!sandboxName) return;
  await deleteWorkspaceSnapshotBuilders([sandboxName]);
}

function workspaceDeletedError(workspace: Workspace): Error {
  return new Error(
    `Workspace ${workspace.name} was deleted while its snapshot was building`,
  );
}

function requireBuildWrite(
  written: boolean,
  workspace: Workspace,
): asserts written {
  if (!written) {
    throw new Error(
      `Workspace ${workspace.name} snapshot build lost SQL ownership`,
    );
  }
}

/** Persist a permanent build failure, then delete its named Sandbox. */
async function markFailed(
  workspace: Workspace,
  build: WorkspaceSnapshotBuild,
  error: unknown,
  beforeWrite: () => Promise<void>,
): Promise<void> {
  try {
    await beforeWrite();
    const written = await setWorkspaceSnapshotBuild(workspace.id, {
      ...build,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    requireBuildWrite(written, workspace);
  } catch (persistError) {
    logException(
      persistError,
      "sandbox.workspace_snapshot.failure_persist_failed",
      { "app.workspace.id": workspace.id },
    );
    // A later owner may now be using this builder. Leave it intact unless this
    // worker fenced and changed the build row to failed.
    return;
  }
  try {
    await deleteBuilder(build.sandboxName);
  } catch (cleanupError) {
    logException(
      cleanupError,
      "sandbox.workspace_snapshot.builder.delete_failed",
      { "app.workspace.id": workspace.id },
    );
  }
}

/** Enforce the one-hour budget shared by every execution slice. */
async function requireRemainingBuildTime(
  workspace: Workspace,
  build: WorkspaceSnapshotBuild,
  beforeWrite: () => Promise<void>,
): Promise<number> {
  const remainingMs = build.startedAt.getTime() + BUILD_TIMEOUT_MS - Date.now();
  if (remainingMs > 0) return remainingMs;

  await markFailed(workspace, build, BUILD_TIMEOUT_ERROR, beforeWrite);
  throw new Error(BUILD_TIMEOUT_ERROR);
}

/** Poll setup and capture the ready snapshot when its command has finished. */
async function finishBuild(
  workspace: Workspace,
  value: profile.Profile,
  runtime: string,
  signal: AbortSignal | undefined,
  beforeWrite: () => Promise<void>,
): Promise<Snapshot | null> {
  const { build: loaded } = await loadSnapshotsForProfile(
    getDb(),
    workspace.id,
    value.hash,
  );
  const build = activeBuild(loaded);
  if (!build?.commandId || !build.sandboxName) return null;

  try {
    await requireRemainingBuildTime(workspace, build, beforeWrite);
    const sandbox = await getWorkspaceSnapshotBuilder(
      build.sandboxName,
      signal,
    );
    const command = await sandbox.getCommand(build.commandId, { signal });
    const pollSignal = AbortSignal.timeout(COMMAND_STATUS_POLL_TIMEOUT_MS);
    const waitSignal = signal
      ? AbortSignal.any([signal, pollSignal])
      : pollSignal;
    let finished: Awaited<ReturnType<typeof command.wait>>;
    try {
      finished = await command.wait({ signal: waitSignal });
    } catch (error) {
      if (pollSignal.aborted && !signal?.aborted) return null;
      throw error;
    }
    if (finished.exitCode !== 0) {
      const error =
        (await finished.stderr({ signal })).trim() ||
        `exit ${finished.exitCode}`;
      throw new Error(
        `Workspace ${workspace.name} snapshot setup failed: ${error}`,
      );
    }

    await requireRemainingBuildTime(workspace, build, beforeWrite);
    const snapshot = await sandbox.snapshot({ signal });
    await requireRemainingBuildTime(workspace, build, beforeWrite);
    const createdAtMs = Date.now();
    const buildDurationMs = Math.max(
      0,
      createdAtMs - build.startedAt.getTime(),
    );
    await beforeWrite();
    const written = await setWorkspaceSnapshot(
      workspace.id,
      {
        id: snapshot.snapshotId,
        generatedAt: new Date(createdAtMs),
        buildDurationMs,
        profileHash: value.hash,
      },
      { buildId: build.id },
    );
    requireBuildWrite(written, workspace);
    try {
      await setCachedSnapshot({
        profileHash: value.hash,
        snapshotId: snapshot.snapshotId,
        runtime,
        createdAtMs,
        dependencyCount: value.dependencyCount,
        buildDurationMs,
      });
    } catch {
      // SQL is authoritative. Redis warming is best effort.
    }
    return {
      snapshotId: snapshot.snapshotId,
      profileHash: value.hash,
      dependencyCount: value.dependencyCount,
      cacheHit: false,
      resolveOutcome: "rebuilt",
      rebuildReason: "cache_miss",
      createdAtMs,
      buildDurationMs,
    };
  } catch (error) {
    if (error instanceof Error && error.message === BUILD_TIMEOUT_ERROR) {
      throw error;
    }
    if (isCancelOrTransient(error, signal)) throw error;
    await markFailed(workspace, build, error, beforeWrite);
    throw error;
  }
}

/** Create and checkpoint the named persistent builder Sandbox. */
async function startBuild(params: {
  workspace: Workspace;
  value: profile.Profile;
  runtime: string;
  signal?: AbortSignal;
  beforeWrite: () => Promise<void>;
}): Promise<void> {
  const { workspace, value, signal } = params;
  const credentials = getVercelSandboxCredentials();
  const resources = getSandboxResources();
  const name = builderName();
  const buildId = randomUUID();
  const startedAt = new Date();
  try {
    await Sandbox.create({
      name,
      persistent: true,
      timeout: BUILD_TIMEOUT_MS,
      runtime: params.runtime,
      signal,
      ...(credentials ?? {}),
      ...(resources ? { resources } : {}),
    });
    await params.beforeWrite();
    const written = await setWorkspaceSnapshotBuild(
      workspace.id,
      {
        id: buildId,
        status: "building",
        phase: "created",
        profileHash: value.hash,
        startedAt,
        sandboxName: name,
        commandId: null,
        error: null,
      },
      { insertIfMissing: true },
    );
    requireBuildWrite(written, workspace);
  } catch (error) {
    try {
      if (!isCancelOrTransient(error, signal)) {
        try {
          await params.beforeWrite();
          await setWorkspaceSnapshotBuild(
            workspace.id,
            {
              id: buildId,
              status: "failed",
              phase: "created",
              profileHash: value.hash,
              startedAt,
              sandboxName: name,
              commandId: null,
              error: error instanceof Error ? error.message : String(error),
            },
            { insertIfMissing: true },
          );
        } catch {
          // The failed row is diagnostic. Builder cleanup still owns safety.
        }
      }
    } finally {
      // Create can provision the named VM before its request rejects.
      try {
        await deleteBuilder(name);
      } catch (cleanupError) {
        logException(
          cleanupError,
          "sandbox.workspace_snapshot.builder.delete_failed",
          { "app.workspace.id": workspace.id },
        );
      }
    }
    throw error;
  }
}

/** Advance one restart-safe preparation phase in the named builder. */
async function continueBuild(params: {
  workspace: Workspace;
  value: profile.Profile;
  signal?: AbortSignal;
  applyNetworkPolicy(sandbox: SandboxSession): Promise<unknown>;
  prepareRepositories?(
    sandbox: SandboxSession,
    workspace: Workspace,
    signal?: AbortSignal,
  ): Promise<void>;
  removeCredentialRoute: boolean;
  beforeWrite: () => Promise<void>;
}): Promise<void> {
  const { build: loaded } = await loadSnapshotsForProfile(
    getDb(),
    params.workspace.id,
    params.value.hash,
  );
  const build = activeBuild(loaded);
  if (!build?.sandboxName || build.commandId) return;

  const remainingMs = await requireRemainingBuildTime(
    params.workspace,
    build,
    params.beforeWrite,
  );
  const commandTimeoutMs = Math.min(remainingMs, BUILD_COMMAND_TIMEOUT_MS);
  const phaseTimeoutSignal = AbortSignal.timeout(commandTimeoutMs);
  const phaseSignal = params.signal
    ? AbortSignal.any([params.signal, phaseTimeoutSignal])
    : phaseTimeoutSignal;
  const sandbox = await getWorkspaceSnapshotBuilder(
    build.sandboxName,
    phaseSignal,
  );
  const session = createSandboxSession(sandbox);
  try {
    if (build.phase === "created") {
      await install.dependencies(
        session,
        params.value.dependencies,
        phaseSignal,
        commandTimeoutMs,
      );
      await install.postinstall(
        session,
        params.value.postinstall,
        phaseSignal,
        commandTimeoutMs,
      );
      await requireRemainingBuildTime(
        params.workspace,
        build,
        params.beforeWrite,
      );
      await params.beforeWrite();
      const written = await setWorkspaceSnapshotBuild(params.workspace.id, {
        ...build,
        phase: "dependencies_installed",
      });
      requireBuildWrite(written, params.workspace);
      return;
    }

    if (build.phase === "dependencies_installed") {
      await prepareWorkspaceRepositories({
        sandbox: session,
        workspace: params.workspace,
        signal: phaseSignal,
        applyNetworkPolicy: params.applyNetworkPolicy,
        prepareRepositories: params.prepareRepositories,
        removeCredentialRoute: params.removeCredentialRoute,
      });
      await requireRemainingBuildTime(
        params.workspace,
        build,
        params.beforeWrite,
      );
      await params.beforeWrite();
      const written = await setWorkspaceSnapshotBuild(params.workspace.id, {
        ...build,
        phase: "repositories_prepared",
      });
      requireBuildWrite(written, params.workspace);
      return;
    }

    await params.beforeWrite();
    const command = await sandbox.runCommand({
      ...workspaceSnapshotSetupCommand(params.workspace, build.id),
      detached: true,
      timeoutMs: remainingMs,
      signal: phaseSignal,
    });
    await params.beforeWrite();
    const written = await setWorkspaceSnapshotBuild(params.workspace.id, {
      ...build,
      commandId: command.cmdId,
      error: null,
    });
    requireBuildWrite(written, params.workspace);
  } catch (error) {
    if (phaseTimeoutSignal.aborted && !params.signal?.aborted) {
      throw new WorkspaceSnapshotWaitingError(params.workspace.name);
    }
    if (error instanceof Error && error.message === BUILD_TIMEOUT_ERROR) {
      throw error;
    }
    if (isCancelOrTransient(error, params.signal)) throw error;
    await markFailed(params.workspace, build, error, params.beforeWrite);
    throw error;
  }
}

/** Reuse a ready snapshot or advance one durable build phase under its lock. */
async function advanceWorkspaceSnapshot(params: {
  workspace: Workspace;
  runtime: string;
  staleSnapshotId?: string;
  signal?: AbortSignal;
  applyNetworkPolicy(sandbox: SandboxSession): Promise<unknown>;
  prepareRepositories?(
    sandbox: SandboxSession,
    workspace: Workspace,
    signal?: AbortSignal,
  ): Promise<void>;
  removeCredentialRoute: boolean;
}): Promise<Snapshot | null> {
  const value = profile.create(params.runtime, params.workspace);
  if (!value) {
    throw new Error(
      `Workspace ${params.workspace.name} has no snapshot profile`,
    );
  }
  const cached = snapshotFromCache(
    await getCachedSnapshot(value.hash),
    value,
    params.staleSnapshotId,
  );
  if (cached) return cached;

  const sqlCached = await snapshotFromSql(
    params.workspace.id,
    value,
    params.runtime,
    params.staleSnapshotId,
  );
  if (sqlCached) return sqlCached;

  const state = getStateAdapter();
  await state.connect();
  const locked = await withLock(
    state,
    buildLockKey(value.hash),
    async (lock) => {
      const workspace = await getWorkspace(getDb(), params.workspace.id);
      if (!workspace) throw workspaceDeletedError(params.workspace);
      const lockedValue = profile.create(params.runtime, workspace) ?? value;
      if (lockedValue.hash !== value.hash) return null;
      const beforeWrite = async () => {
        await fenceLock(state, lock, BUILD_LOCK_TTL_MS);
      };

      const cachedInsideLock = snapshotFromCache(
        await getCachedSnapshot(lockedValue.hash),
        lockedValue,
        params.staleSnapshotId,
      );
      if (cachedInsideLock) return cachedInsideLock;

      const sqlInsideLock = await snapshotFromSql(
        workspace.id,
        lockedValue,
        params.runtime,
        params.staleSnapshotId,
      );
      if (sqlInsideLock) return sqlInsideLock;

      const finished = await finishBuild(
        workspace,
        lockedValue,
        params.runtime,
        params.signal,
        beforeWrite,
      );
      if (finished) return finished;

      const { build: loaded } = await loadSnapshotsForProfile(
        getDb(),
        workspace.id,
        lockedValue.hash,
      );
      const build = activeBuild(loaded);
      if (build && !build.commandId) {
        await continueBuild({
          ...params,
          workspace,
          value: lockedValue,
          beforeWrite,
        });
      } else if (!build) {
        if (loaded?.sandboxName) {
          try {
            await deleteBuilder(loaded.sandboxName);
          } catch (cleanupError) {
            logException(
              cleanupError,
              "sandbox.workspace_snapshot.builder.delete_failed",
              { "app.workspace.id": workspace.id },
            );
          }
        }
        await startBuild({
          workspace,
          value: lockedValue,
          runtime: params.runtime,
          signal: params.signal,
          beforeWrite,
        });
      }
      return null;
    },
    { ttlMs: BUILD_LOCK_TTL_MS, keepAlive: true },
  );

  return locked.acquired ? (locked.value ?? null) : null;
}

/** Reserve enough host time to persist the waiting tool-result boundary. */
function shouldYieldWait(params: {
  shouldYield?: () => boolean;
  turnDeadlineAtMs?: number;
}): boolean {
  if (params.shouldYield) return params.shouldYield();

  const requestDeadline = getTurnRequestDeadline()?.deadlineAtMs;
  const deadlineAtMs =
    params.turnDeadlineAtMs === undefined
      ? requestDeadline
      : requestDeadline === undefined
        ? params.turnDeadlineAtMs
        : Math.min(params.turnDeadlineAtMs, requestDeadline);
  return (
    deadlineAtMs !== undefined &&
    Date.now() >= deadlineAtMs - WAIT_YIELD_BUFFER_MS
  );
}

/**
 * Resolve a Workspace snapshot through resumable execution slices.
 * Cold builds have one shared one-hour budget across every execution slice.
 */
export async function resolveWorkspaceSnapshot(params: {
  workspace: Workspace;
  runtime: string;
  staleSnapshotId?: string;
  signal?: AbortSignal;
  shouldYield?: () => boolean;
  turnDeadlineAtMs?: number;
  applyNetworkPolicy(sandbox: SandboxSession): Promise<unknown>;
  prepareRepositories?(
    sandbox: SandboxSession,
    workspace: Workspace,
    signal?: AbortSignal,
  ): Promise<void>;
  removeCredentialRoute: boolean;
}): Promise<Snapshot> {
  for (;;) {
    params.signal?.throwIfAborted();
    const workspace = await getWorkspace(getDb(), params.workspace.id);
    if (!workspace) throw workspaceDeletedError(params.workspace);
    const slice = { ...params, workspace };
    if (shouldYieldWait(slice)) {
      throw new WorkspaceSnapshotWaitingError(workspace.name);
    }

    let snapshot: Snapshot | null;
    try {
      snapshot = await advanceWorkspaceSnapshot(slice);
    } catch (error) {
      if (!isSandboxApiTransientError(error)) throw error;
      if (shouldYieldWait(slice)) {
        throw new WorkspaceSnapshotWaitingError(workspace.name);
      }
      await sleep(TRANSIENT_API_RETRY_MS, params.signal);
      continue;
    }
    if (shouldYieldWait(slice)) {
      throw new WorkspaceSnapshotWaitingError(workspace.name);
    }
    if (snapshot) return snapshot;
    await sleep(WAIT_POLL_MS, params.signal);
  }
}
