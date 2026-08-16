import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { getDb } from "@/chat/db";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import { isSandboxApiTransientError } from "@/chat/sandbox/errors";
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
  snapshotBuildFromRow,
  snapshotFromRow,
} from "@/chat/sandbox/snapshot/store";
import { WorkspaceSnapshotWaitingError } from "@/chat/sandbox/snapshot/waiting-error";
import {
  createSandboxSession,
  type SandboxSession,
} from "@/chat/sandbox/workspace";
import { getTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { sleep } from "@/chat/sleep";
import { getStateAdapter } from "@/chat/state/adapter";
import { withLock } from "@/chat/state/locks";
import { getWorkspace } from "@/chat/workspaces/store";
import type { Workspace, WorkspaceSnapshotBuild } from "@/chat/workspaces/types";

const BUILD_TIMEOUT_MS = 60 * 60 * 1000;
const BUILD_TIMEOUT_ERROR = "Workspace snapshot build timed out after 1 hour";
const BUILD_LOCK_TTL_MS = 2 * 60 * 1000;
const BUILD_LOCK_PREFIX = "junior:workspace_snapshot_start";
/** Poll interval while waiting for a detached setup command. */
const WAIT_POLL_MS = 5_000;
/** Brief backoff when the Sandbox API returns a transient 5xx. */
const TRANSIENT_API_RETRY_MS = 2_000;
/**
 * Leave headroom before the hard request/turn deadline so the worker can
 * persist the pause and requeue, matching conversation soft yield.
 */
const WAIT_YIELD_BUFFER_MS = 40_000;

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

/** Load ready + build rows for this workspace profile hash. */
async function loadProfileSnapshots(
  workspaceId: string,
  profileHash: string,
): Promise<{
  ready: ReturnType<typeof snapshotFromRow>;
  build: WorkspaceSnapshotBuild | null;
}> {
  const rows = await loadSnapshotsForProfile(getDb(), workspaceId, profileHash);
  return {
    ready: snapshotFromRow(rows.ready),
    build: snapshotBuildFromRow(rows.build),
  };
}

/** Boot from a durable SQL ready row and refresh the Redis hot cache. */
async function snapshotFromSql(
  workspaceId: string,
  value: profile.Profile,
): Promise<Snapshot | null> {
  const { ready } = await loadProfileSnapshots(workspaceId, value.hash);
  if (!ready) return null;
  if (profile.isStale(value, ready.generatedAt.getTime())) return null;
  await setCachedSnapshot({
    profileHash: ready.profileHash,
    snapshotId: ready.id,
    runtime: ready.runtime,
    createdAtMs: ready.generatedAt.getTime(),
    dependencyCount: ready.dependencyCount,
    buildDurationMs: ready.buildDurationMs,
  });
  return {
    snapshotId: ready.id,
    profileHash: ready.profileHash,
    dependencyCount: ready.dependencyCount,
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
  // Resume the named builder session. resume:false leaves no active session for
  // runCommand/getCommand and surfaces as transient Sandbox API 500s.
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
    // Builder may already be finalized after snapshot or timeout.
  }
}

async function markFailed(
  workspace: Workspace,
  build: WorkspaceSnapshotBuild,
  error: string,
): Promise<void> {
  await setWorkspaceSnapshotBuild(workspace.id, {
    ...build,
    status: "failed",
    error,
  });
  await stopBuilder(build.sandboxName);
}

async function requireRemainingBuildTime(
  workspace: Workspace,
  build: WorkspaceSnapshotBuild,
): Promise<number> {
  const remainingMs =
    build.startedAt.getTime() + BUILD_TIMEOUT_MS - Date.now();
  if (remainingMs > 0) return remainingMs;

  await markFailed(workspace, build, BUILD_TIMEOUT_ERROR);
  throw new Error(BUILD_TIMEOUT_ERROR);
}

/** Poll a detached setup command; snapshot and stop the builder when it exits. */
async function finishBuild(
  workspace: Workspace,
  value: profile.Profile,
  runtime: string,
  signal?: AbortSignal,
): Promise<Snapshot | null> {
  const { build: loaded } = await loadProfileSnapshots(
    workspace.id,
    value.hash,
  );
  const build = activeBuild(loaded);
  if (!build?.commandId || !build.sandboxName) return null;

  await requireRemainingBuildTime(workspace, build);
  const sandbox = await getBuilderSandbox(build.sandboxName, signal);
  const command = await sandbox.getCommand(build.commandId, { signal });
  if (command.exitCode == null) {
    return null;
  }
  if (command.exitCode !== 0) {
    const error =
      (await command.stderr({ signal })).trim() || `exit ${command.exitCode}`;
    await markFailed(workspace, build, error);
    throw new Error(
      `Workspace ${workspace.name} snapshot setup failed: ${error}`,
    );
  }

  await requireRemainingBuildTime(workspace, build);
  const snapshot = await sandbox.snapshot({ signal });
  await requireRemainingBuildTime(workspace, build);
  const createdAtMs = Date.now();
  const buildDurationMs = Math.max(0, createdAtMs - build.startedAt.getTime());
  await setCachedSnapshot({
    profileHash: value.hash,
    snapshotId: snapshot.snapshotId,
    runtime,
    createdAtMs,
    dependencyCount: value.dependencyCount,
    buildDurationMs,
  });
  await setWorkspaceSnapshot(workspace.id, {
    id: snapshot.snapshotId,
    generatedAt: new Date(createdAtMs),
    buildDurationMs,
    profileHash: value.hash,
    runtime,
    dependencyCount: value.dependencyCount,
  });
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
}

/** Create the long-lived builder only. Prep runs on later check-ins. */
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
    await setWorkspaceSnapshotBuild(workspace.id, {
      status: "failed",
      phase: "created",
      profileHash: value.hash,
      startedAt,
      sandboxName: name,
      commandId: null,
      error: error instanceof Error ? error.message : String(error),
    });
    await stopBuilder(name);
    throw error;
  }
}

/**
 * Advance one prep slice on the builder: deps, then repos, then detach setup.
 * SQL records the last completed slice so later check-ins can resume.
 */
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
  const { build: loaded } = await loadProfileSnapshots(
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
      status: "building",
      commandId: command.cmdId,
      error: null,
    });
  } catch (error) {
    // Timeout handling already marked the build failed and stopped the builder.
    if (error instanceof Error && error.message === BUILD_TIMEOUT_ERROR) {
      throw error;
    }
    // Keep the builder + SQL phase so the next check-in retries this slice.
    if (isSandboxApiTransientError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(params.workspace, build, message);
    throw error;
  }
}

/**
 * Advance one control-plane slice: boot if ready, else start/prep/poll.
 * Returns a Snapshot when ready; null while still building.
 */
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

  const sqlCached = await snapshotFromSql(params.workspace.id, value);
  if (sqlCached) return sqlCached;

  const state = getStateAdapter();
  await state.connect();
  const locked = await withLock(
    state,
    buildLockKey(value.hash),
    async () => {
      const cachedInsideLock = snapshotFromCache(
        await getCachedSnapshot(value.hash),
        value,
      );
      if (cachedInsideLock) return cachedInsideLock;

      const sqlInsideLock = await snapshotFromSql(params.workspace.id, value);
      if (sqlInsideLock) return sqlInsideLock;

      const workspace =
        (await getWorkspace(getDb(), params.workspace.id)) ?? params.workspace;
      const finished = await finishBuild(
        workspace,
        value,
        params.runtime,
        params.signal,
      );
      if (finished) return finished;

      const { build: loaded } = await loadProfileSnapshots(
        workspace.id,
        value.hash,
      );
      const build = activeBuild(loaded);
      if (build && !build.commandId) {
        await continueBuild({ ...params, workspace, value });
      } else if (!build) {
        await startBuild({
          workspace,
          value,
          runtime: params.runtime,
          signal: params.signal,
        });
      }
      return null;
    },
    { ttlMs: BUILD_LOCK_TTL_MS, keepAlive: true },
  );

  if (locked.acquired) return locked.value ?? null;
  // Another worker holds the lock; wait and retry on the next poll.
  return null;
}

function shouldYieldWait(params: {
  shouldYield?: () => boolean;
  turnDeadlineAtMs?: number;
}): boolean {
  if (params.shouldYield?.()) return true;
  const requestDeadline = getTurnRequestDeadline()?.deadlineAtMs;
  const deadlineAtMs =
    params.turnDeadlineAtMs === undefined
      ? requestDeadline
      : requestDeadline === undefined
        ? params.turnDeadlineAtMs
        : Math.min(params.turnDeadlineAtMs, requestDeadline);
  if (deadlineAtMs === undefined) return false;
  return Date.now() >= deadlineAtMs - WAIT_YIELD_BUFFER_MS;
}

/**
 * Resolve a Workspace snapshot, waiting across short control-plane slices.
 *
 * Cold builds have one hour across all slices. This function advances one
 * slice per loop, then sleeps. Near the host/turn soft deadline it throws
 * WorkspaceSnapshotWaitingError so the tool can return timed_out and the host
 * can yield at a toolResult boundary, then continue the same wait.
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

    // Always advance at least one slice before soft-yield so a fresh wake
    // cannot spin on timed_out without starting or polling the builder.
    let snapshot: Snapshot | null;
    try {
      snapshot = await advanceWorkspaceSnapshot(params);
    } catch (error) {
      // Transient Sandbox API errors leave the SQL phase unchanged. Retry in
      // this wait loop (or after soft yield) instead of failing the build.
      if (!isSandboxApiTransientError(error)) {
        throw error;
      }
      if (shouldYieldWait(params)) {
        throw new WorkspaceSnapshotWaitingError(params.workspace.name);
      }
      await sleep(TRANSIENT_API_RETRY_MS, params.signal);
      continue;
    }
    if (snapshot) return snapshot;

    if (shouldYieldWait(params)) {
      throw new WorkspaceSnapshotWaitingError(params.workspace.name);
    }
    await sleep(WAIT_POLL_MS, params.signal);
  }
}
