import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { getDb } from "@/chat/db";
import { getTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import {
  isAbortError,
  isSandboxApiTransientError,
} from "@/chat/sandbox/errors";
import {
  prepareWorkspaceRepositories,
  workspaceSetupCommand,
} from "@/chat/sandbox/prepare-workspace";
import { getSandboxResources } from "@/chat/sandbox/resources";
import * as install from "@/chat/sandbox/snapshot/install";
import * as profile from "@/chat/sandbox/snapshot/profile";
import {
  getCachedSnapshot,
  setCachedSnapshot,
  type Snapshot,
} from "@/chat/sandbox/snapshot/resolve";
import {
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
import { withLock } from "@/chat/state/locks";
import { getWorkspace } from "@/chat/workspaces/store";
import type {
  Workspace,
  WorkspaceSnapshotBuild,
} from "@/chat/workspaces/types";

const BUILD_TIMEOUT_MS = 60 * 60 * 1000;
const BUILD_TIMEOUT_ERROR = "Workspace snapshot build timed out after 1 hour";
const BUILD_LOCK_TTL_MS = 2 * 60 * 1000;
const BUILD_LOCK_PREFIX = "junior:workspace_snapshot_start";
const WAIT_POLL_MS = 5_000;
const TRANSIENT_API_RETRY_MS = 2_000;
/** Leave time for the tool result and durable run checkpoint. */
const WAIT_YIELD_BUFFER_MS = 40_000;

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
): Snapshot | null {
  if (!cached || profile.isStale(value, cached.createdAtMs)) return null;
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
): Promise<Snapshot | null> {
  const { ready } = await loadSnapshotsForProfile(
    getDb(),
    workspaceId,
    value.hash,
  );
  if (!ready || profile.isStale(value, ready.generatedAt.getTime())) {
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

function activeBuild(
  build: WorkspaceSnapshotBuild | null,
): WorkspaceSnapshotBuild | null {
  if (!build || build.status !== "building" || !build.sandboxName) return null;
  return build;
}

async function getBuilderSandbox(
  sandboxName: string,
  signal?: AbortSignal,
): Promise<Sandbox> {
  const credentials = getVercelSandboxCredentials();
  return await Sandbox.get({
    name: sandboxName,
    resume: true,
    signal,
    ...(credentials ?? {}),
  });
}

async function stopBuilder(
  sandboxName: string | null | undefined,
): Promise<void> {
  if (!sandboxName) return;
  try {
    const sandbox = await getBuilderSandbox(sandboxName);
    await sandbox.stop();
  } catch {
    // Snapshotting and provider timeout can finalize the builder first.
  }
}

async function markFailed(
  workspace: Workspace,
  build: WorkspaceSnapshotBuild,
  error: string,
): Promise<void> {
  try {
    await setWorkspaceSnapshotBuild(workspace.id, {
      ...build,
      status: "failed",
      error,
    });
  } finally {
    await stopBuilder(build.sandboxName);
  }
}

async function requireRemainingBuildTime(
  workspace: Workspace,
  build: WorkspaceSnapshotBuild,
): Promise<number> {
  const remainingMs = build.startedAt.getTime() + BUILD_TIMEOUT_MS - Date.now();
  if (remainingMs > 0) return remainingMs;

  await markFailed(workspace, build, BUILD_TIMEOUT_ERROR);
  throw new Error(BUILD_TIMEOUT_ERROR);
}

async function finishBuild(
  workspace: Workspace,
  value: profile.Profile,
  runtime: string,
  signal?: AbortSignal,
): Promise<Snapshot | null> {
  const { build: loaded } = await loadSnapshotsForProfile(
    getDb(),
    workspace.id,
    value.hash,
  );
  const build = activeBuild(loaded);
  if (!build?.commandId || !build.sandboxName) return null;

  try {
    await requireRemainingBuildTime(workspace, build);
    const sandbox = await getBuilderSandbox(build.sandboxName, signal);
    const command = await sandbox.getCommand(build.commandId, { signal });
    if (command.exitCode == null) return null;
    if (command.exitCode !== 0) {
      const error =
        (await command.stderr({ signal })).trim() || `exit ${command.exitCode}`;
      throw new Error(
        `Workspace ${workspace.name} snapshot setup failed: ${error}`,
      );
    }

    await requireRemainingBuildTime(workspace, build);
    const snapshot = await sandbox.snapshot({ signal });
    await requireRemainingBuildTime(workspace, build);
    const createdAtMs = Date.now();
    const buildDurationMs = Math.max(
      0,
      createdAtMs - build.startedAt.getTime(),
    );
    await setWorkspaceSnapshot(workspace.id, {
      id: snapshot.snapshotId,
      generatedAt: new Date(createdAtMs),
      buildDurationMs,
      profileHash: value.hash,
    });
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
    await stopBuilder(build.sandboxName);
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
    await markFailed(
      workspace,
      build,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

async function startBuild(params: {
  workspace: Workspace;
  value: profile.Profile;
  runtime: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { workspace, value, signal } = params;
  const credentials = getVercelSandboxCredentials();
  const resources = getSandboxResources();
  const name = builderName();
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
    await setWorkspaceSnapshotBuild(workspace.id, {
      status: "building",
      phase: "created",
      profileHash: value.hash,
      startedAt,
      sandboxName: name,
      commandId: null,
      error: null,
    });
  } catch (error) {
    try {
      if (!isCancelOrTransient(error, signal)) {
        try {
          await setWorkspaceSnapshotBuild(workspace.id, {
            status: "failed",
            phase: "created",
            profileHash: value.hash,
            startedAt,
            sandboxName: name,
            commandId: null,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // The failed row is diagnostic. Builder cleanup still owns safety.
        }
      }
    } finally {
      // Create can provision the named VM before its request rejects.
      await stopBuilder(name);
    }
    throw error;
  }
}

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
}): Promise<void> {
  const { build: loaded } = await loadSnapshotsForProfile(
    getDb(),
    params.workspace.id,
    params.value.hash,
  );
  const build = activeBuild(loaded);
  if (!build?.sandboxName || build.commandId) return;

  const remainingMs = await requireRemainingBuildTime(params.workspace, build);
  const sandbox = await getBuilderSandbox(build.sandboxName, params.signal);
  const session = createSandboxSession(sandbox);
  try {
    if (build.phase === "created") {
      await install.dependencies(
        session,
        params.value.dependencies,
        params.signal,
      );
      await install.postinstall(
        session,
        params.value.postinstall,
        params.signal,
      );
      await requireRemainingBuildTime(params.workspace, build);
      await setWorkspaceSnapshotBuild(params.workspace.id, {
        ...build,
        phase: "dependencies_installed",
      });
      return;
    }

    if (build.phase === "dependencies_installed") {
      await prepareWorkspaceRepositories({
        sandbox: session,
        workspace: params.workspace,
        signal: params.signal,
        applyNetworkPolicy: params.applyNetworkPolicy,
        prepareRepositories: params.prepareRepositories,
        removeCredentialRoute: params.removeCredentialRoute,
      });
      await requireRemainingBuildTime(params.workspace, build);
      await setWorkspaceSnapshotBuild(params.workspace.id, {
        ...build,
        phase: "repositories_prepared",
      });
      return;
    }

    const command = await sandbox.runCommand({
      ...workspaceSetupCommand(params.workspace),
      detached: true,
      timeoutMs: remainingMs,
      signal: params.signal,
    });
    await setWorkspaceSnapshotBuild(params.workspace.id, {
      ...build,
      commandId: command.cmdId,
      error: null,
    });
  } catch (error) {
    if (error instanceof Error && error.message === BUILD_TIMEOUT_ERROR) {
      throw error;
    }
    if (isCancelOrTransient(error, params.signal)) throw error;
    await markFailed(
      params.workspace,
      build,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

async function advanceWorkspaceSnapshot(params: {
  workspace: Workspace;
  runtime: string;
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
  const cached = snapshotFromCache(await getCachedSnapshot(value.hash), value);
  if (cached) return cached;

  const sqlCached = await snapshotFromSql(
    params.workspace.id,
    value,
    params.runtime,
  );
  if (sqlCached) return sqlCached;

  const state = getStateAdapter();
  await state.connect();
  const locked = await withLock(
    state,
    buildLockKey(value.hash),
    async () => {
      const workspace =
        (await getWorkspace(getDb(), params.workspace.id)) ?? params.workspace;
      const lockedValue = profile.create(params.runtime, workspace) ?? value;
      if (lockedValue.hash !== value.hash) return null;

      const cachedInsideLock = snapshotFromCache(
        await getCachedSnapshot(lockedValue.hash),
        lockedValue,
      );
      if (cachedInsideLock) return cachedInsideLock;

      const sqlInsideLock = await snapshotFromSql(
        workspace.id,
        lockedValue,
        params.runtime,
      );
      if (sqlInsideLock) return sqlInsideLock;

      const finished = await finishBuild(
        workspace,
        lockedValue,
        params.runtime,
        params.signal,
      );
      if (finished) return finished;

      const { build: loaded } = await loadSnapshotsForProfile(
        getDb(),
        workspace.id,
        lockedValue.hash,
      );
      const build = activeBuild(loaded);
      if (build && !build.commandId) {
        await continueBuild({ ...params, workspace, value: lockedValue });
      } else if (!build) {
        await startBuild({
          workspace,
          value: lockedValue,
          runtime: params.runtime,
          signal: params.signal,
        });
      }
      return null;
    },
    { ttlMs: BUILD_LOCK_TTL_MS, keepAlive: true },
  );

  return locked.acquired ? (locked.value ?? null) : null;
}

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
 * Resolve a Workspace snapshot through resumable control-plane slices.
 * Cold builds have one shared one-hour budget across every execution slice.
 */
export async function resolveWorkspaceSnapshot(params: {
  workspace: Workspace;
  runtime: string;
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
    const workspace =
      (await getWorkspace(getDb(), params.workspace.id)) ?? params.workspace;
    const slice = { ...params, workspace };

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
    if (snapshot) return snapshot;
    if (shouldYieldWait(slice)) {
      throw new WorkspaceSnapshotWaitingError(workspace.name);
    }
    await sleep(WAIT_POLL_MS, params.signal);
  }
}
