import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { getDb } from "@/chat/db";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
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
  setWorkspaceSnapshot,
  setWorkspaceSnapshotBuild,
} from "@/chat/sandbox/snapshot/store";
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

const BUILD_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const BUILD_LOCK_TTL_MS = 2 * 60 * 1000;
const BUILD_LOCK_PREFIX = "junior:workspace_snapshot_start";
/** Poll interval while waiting for a detached setup command. */
const WAIT_POLL_MS = 5_000;
/**
 * Leave headroom before the hard request/turn deadline so the worker can
 * persist the pause and requeue, matching conversation soft yield.
 */
const WAIT_YIELD_BUFFER_MS = 40_000;

/**
 * Soft deadline hit while a Workspace snapshot is still building.
 * Complete the tool with timed_out/building so the agent can yield at a
 * continuable boundary and requeue. Do not throw CooperativeTurnYieldError
 * mid-tool: that parks a non-continuable assistant toolCall and fails.
 */
export class WorkspaceSnapshotWaitingError extends Error {
  readonly code = "workspace_snapshot_waiting";
  readonly workspaceName: string;

  constructor(workspaceName: string) {
    super(
      `Workspace ${workspaceName} snapshot is still building; yielded for requeue`,
    );
    this.name = "WorkspaceSnapshotWaitingError";
    this.workspaceName = workspaceName;
  }
}

export function isWorkspaceSnapshotWaitingError(
  error: unknown,
): error is WorkspaceSnapshotWaitingError {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    if (current instanceof WorkspaceSnapshotWaitingError) return true;
    if (
      current instanceof Error &&
      (current.name === "WorkspaceSnapshotWaitingError" ||
        (current as { code?: string }).code === "workspace_snapshot_waiting")
    ) {
      return true;
    }
    seen.add(current);
    current =
      typeof current === "object"
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
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

/** Boot from a durable SQL ready row and refresh the Redis hot cache. */
async function snapshotFromSql(
  workspace: Workspace,
  value: profile.Profile,
): Promise<Snapshot | null> {
  const ready = workspace.snapshot;
  if (!ready || ready.profileHash !== value.hash) return null;
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
  workspace: Workspace,
  profileHash: string,
): WorkspaceSnapshotBuild | null {
  const build = workspace.snapshotBuild;
  if (!build || build.profileHash !== profileHash) return null;
  if (build.status !== "building" || !build.sandboxName) return null;
  return build;
}

async function getBuilderSandbox(
  sandboxName: string,
  signal?: AbortSignal,
): Promise<Sandbox> {
  const credentials = getVercelSandboxCredentials();
  return await Sandbox.get({
    name: sandboxName,
    resume: false,
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

/** Poll a detached setup command; snapshot and stop the builder when it exits. */
async function finishBuild(
  workspace: Workspace,
  value: profile.Profile,
  runtime: string,
  signal?: AbortSignal,
): Promise<Snapshot | null> {
  const build = activeBuild(workspace, value.hash);
  if (!build?.commandId || !build.sandboxName) return null;

  const sandbox = await getBuilderSandbox(build.sandboxName, signal);
  try {
    await sandbox.extendTimeout(BUILD_TIMEOUT_MS, { signal });
  } catch {
    // Keep polling even if extend is unavailable on this runtime.
  }
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

  const snapshot = await sandbox.snapshot({ signal });
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

/** Create the long-lived builder only. Prep runs on a later check-in. */
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
      profileHash: value.hash,
      startedAt,
      sandboxName: name,
      commandId: null,
      error: null,
    });
  } catch (error) {
    await setWorkspaceSnapshotBuild(workspace.id, {
      status: "failed",
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
 * Run install + clone on the existing builder, then detach setup.
 * One check-in owns this slice so the start path stays create-only.
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
  const build = activeBuild(params.workspace, params.value.hash);
  if (!build?.sandboxName || build.commandId) return;

  const sandbox = await getBuilderSandbox(build.sandboxName, params.signal);
  const session = createSandboxSession(sandbox);
  try {
    try {
      await sandbox.extendTimeout(BUILD_TIMEOUT_MS, { signal: params.signal });
    } catch {
      // Best-effort keepalive for the prep slice.
    }
    await install.dependencies(
      session,
      params.value.dependencies,
      params.signal,
    );
    await install.postinstall(session, params.value.postinstall, params.signal);
    await prepareWorkspaceRepositories({
      sandbox: session,
      workspace: params.workspace,
      signal: params.signal,
      applyNetworkPolicy: params.applyNetworkPolicy,
      prepareRepositories: params.prepareRepositories,
      removeCredentialRoute: params.removeCredentialRoute,
    });
    const command = await sandbox.runCommand({
      ...workspaceSetupCommand(params.workspace),
      detached: true,
      timeoutMs: BUILD_TIMEOUT_MS,
      signal: params.signal,
    });
    await setWorkspaceSnapshotBuild(params.workspace.id, {
      ...build,
      status: "building",
      commandId: command.cmdId,
      error: null,
    });
  } catch (error) {
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

  const latest =
    (await getWorkspace(getDb(), params.workspace.id)) ?? params.workspace;
  const sqlCached = await snapshotFromSql(latest, value);
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

      const workspace =
        (await getWorkspace(getDb(), params.workspace.id)) ?? params.workspace;
      const sqlInsideLock = await snapshotFromSql(workspace, value);
      if (sqlInsideLock) return sqlInsideLock;

      const finished = await finishBuild(
        workspace,
        value,
        params.runtime,
        params.signal,
      );
      if (finished) return finished;

      const build = activeBuild(workspace, value.hash);
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
 * Cold builds live in a 24h builder sandbox. This function only advances one
 * slice per loop, then sleeps. Near the host/turn soft deadline it throws
 * WorkspaceSnapshotWaitingError so the tool can return timed_out/building and
 * the agent can yield at a continuable boundary. The next wake attaches the
 * same SQL job when switchWorkspace runs again.
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
    const snapshot = await advanceWorkspaceSnapshot(params);
    if (snapshot) return snapshot;

    if (shouldYieldWait(params)) {
      throw new WorkspaceSnapshotWaitingError(params.workspace.name);
    }
    await sleep(WAIT_POLL_MS, params.signal);
  }
}
