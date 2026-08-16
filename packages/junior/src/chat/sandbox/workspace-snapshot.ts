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
  createSandboxSession,
  stopSession,
  type SandboxSession,
} from "@/chat/sandbox/workspace";
import { getStateAdapter } from "@/chat/state/adapter";
import { withLock } from "@/chat/state/locks";
import {
  getWorkspace,
  setWorkspaceSnapshot,
  setWorkspaceSnapshotBuild,
} from "@/chat/workspaces/store";
import type { Workspace } from "@/chat/workspaces/types";

const BUILD_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const BUILD_LOCK_TTL_MS = 2 * 60 * 1000;
const BUILD_LOCK_PREFIX = "junior:workspace_snapshot_start";

export class WorkspaceSnapshotBuildingError extends Error {
  constructor(workspace: string) {
    super(`Workspace ${workspace} snapshot is still building. Try switching again later.`);
    this.name = "WorkspaceSnapshotBuildingError";
  }
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

async function finishBuild(
  workspace: Workspace,
  value: profile.Profile,
  runtime: string,
  signal?: AbortSignal,
): Promise<Snapshot | null> {
  const build = workspace.snapshotBuild;
  if (
    build?.status !== "building" ||
    build.profileHash !== value.hash ||
    !build.sandboxName ||
    !build.commandId
  ) {
    return null;
  }

  const credentials = getVercelSandboxCredentials();
  const sandbox = await Sandbox.get({
    name: build.sandboxName,
    resume: false,
    signal,
    ...(credentials ?? {}),
  });
  const command = await sandbox.getCommand(build.commandId, { signal });
  if (command.exitCode == null) {
    return null;
  }
  if (command.exitCode !== 0) {
    const error = (await command.stderr({ signal })).trim() || `exit ${command.exitCode}`;
    await setWorkspaceSnapshotBuild(workspace.id, {
      ...build,
      status: "failed",
      error,
    });
    throw new Error(`Workspace ${workspace.name} snapshot setup failed: ${error}`);
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

async function startBuild(params: {
  workspace: Workspace;
  value: profile.Profile;
  runtime: string;
  signal?: AbortSignal;
  applyNetworkPolicy(sandbox: SandboxSession): Promise<unknown>;
  prepareRepositories?(
    sandbox: SandboxSession,
    workspace: Workspace,
    signal?: AbortSignal,
  ): Promise<void>;
  removeCredentialRoute: boolean;
}): Promise<void> {
  const { workspace, value, signal } = params;
  const credentials = getVercelSandboxCredentials();
  const resources = getSandboxResources();
  const name = builderName();
  const sandbox = await Sandbox.create({
    name,
    persistent: true,
    timeout: BUILD_TIMEOUT_MS,
    runtime: params.runtime,
    signal,
    ...(credentials ?? {}),
    ...(resources ? { resources } : {}),
  });
  const session = createSandboxSession(sandbox);
  const startedAt = new Date();
  try {
    await install.dependencies(session, value.dependencies, signal);
    await install.postinstall(session, value.postinstall, signal);
    await prepareWorkspaceRepositories({
      sandbox: session,
      workspace,
      signal,
      applyNetworkPolicy: params.applyNetworkPolicy,
      prepareRepositories: params.prepareRepositories,
      removeCredentialRoute: params.removeCredentialRoute,
    });
    const command = await sandbox.runCommand({
      ...workspaceSetupCommand(workspace),
      detached: true,
      timeoutMs: BUILD_TIMEOUT_MS,
      signal,
    });
    await setWorkspaceSnapshotBuild(workspace.id, {
      status: "building",
      profileHash: value.hash,
      startedAt,
      sandboxName: name,
      commandId: command.cmdId,
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
    await stopSession(session);
    throw error;
  }
}

/** Start or check one long-running Workspace snapshot build. */
export async function resolveWorkspaceSnapshot(params: {
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
}): Promise<Snapshot> {
  const value = profile.create(params.runtime, params.workspace);
  if (!value) {
    throw new Error(`Workspace ${params.workspace.name} has no snapshot profile`);
  }
  const cached = snapshotFromCache(await getCachedSnapshot(value.hash), value);
  if (cached) return cached;

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
      const finished = await finishBuild(
        workspace,
        value,
        params.runtime,
        params.signal,
      );
      if (finished) return finished;

      if (
        workspace.snapshotBuild?.status !== "building" ||
        workspace.snapshotBuild.profileHash !== value.hash ||
        !workspace.snapshotBuild.sandboxName ||
        !workspace.snapshotBuild.commandId
      ) {
        await startBuild({ ...params, workspace, value });
      }
      return null;
    },
    { ttlMs: BUILD_LOCK_TTL_MS, keepAlive: true },
  );

  if (locked.acquired && locked.value) return locked.value;
  throw new WorkspaceSnapshotBuildingError(params.workspace.name);
}
