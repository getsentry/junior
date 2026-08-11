import { createHash } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { z } from "zod";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import { getSandboxResources } from "@/chat/sandbox/resources";
import * as install from "@/chat/sandbox/snapshot/install";
import * as profile from "@/chat/sandbox/snapshot/profile";
import { trace } from "@/chat/sandbox/snapshot/span";
import { createSandboxSession, type SandboxSession } from "@/chat/sandbox/workspace";
import { sleep } from "@/chat/sleep";
import type { Workspace } from "@/chat/workspaces/types";
import { getStateAdapter } from "@/chat/state/adapter";

// Snapshot resolution owns cache and lock coordination. Profile selection and
// sandbox installation stay in their neighboring modules.
const SNAPSHOT_CACHE_PREFIX = "junior:sandbox_snapshot_profile";
const SNAPSHOT_LOCK_PREFIX = "junior:sandbox_snapshot_lock";
const SNAPSHOT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SNAPSHOT_BUILD_LOCK_BUFFER_MS = 30 * 1000;
const SNAPSHOT_WAIT_FOR_LOCK_BUFFER_MS = 30 * 1000;

const cachedSnapshotSchema = z
  .object({
    profileHash: z.string(),
    snapshotId: z.string(),
    runtime: z.string(),
    createdAtMs: z.number(),
    dependencyCount: z.number(),
  })
  .strict();

type CachedSnapshot = z.output<typeof cachedSnapshotSchema>;

export type ResolveOutcome =
  | "no_profile"
  | "cache_hit"
  | "cache_hit_after_lock_wait"
  | "rebuilt"
  | "forced_rebuild";

export type RebuildReason =
  | "cache_miss"
  | "floating_stale"
  | "force_rebuild"
  | "snapshot_missing";

/** Result of resolving the reusable snapshot for one dependency profile. */
export interface Snapshot {
  snapshotId?: string;
  profileHash?: string;
  dependencyCount: number;
  cacheHit: boolean;
  resolveOutcome: ResolveOutcome;
  rebuildReason?: RebuildReason;
}

export type ProgressPhase =
  | "resolve_start"
  | "cache_hit"
  | "waiting_for_lock"
  | "building_snapshot"
  | "build_complete";

type LockResult = {
  snapshotId: string;
  source: "cache_hit" | "cache_hit_after_lock_wait" | "built";
};

type ResolveParams = {
  runtime: string;
  timeoutMs: number;
  forceRebuild?: boolean;
  staleSnapshotId?: string;
  onProgress?: (phase: ProgressPhase) => void | Promise<void>;
  signal?: AbortSignal;
  workspace?: Workspace;
  prepareWorkspace?: (sandbox: SandboxSession) => Promise<void>;
};

function profileCacheKey(profileHash: string): string {
  return `${SNAPSHOT_CACHE_PREFIX}:${profileHash}`;
}

function profileLockKey(cacheIdentity: string): string {
  return `${SNAPSHOT_LOCK_PREFIX}:${cacheIdentity}`;
}

function workspaceCacheIdentity(
  profileHash: string,
  baseSnapshotId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ profileHash, baseSnapshotId }))
    .digest("hex");
}

/** Read one cached snapshot pointer; only a missing key is a cache miss. */
async function getCachedSnapshot(
  cacheIdentity: string,
  profileHash = cacheIdentity,
): Promise<CachedSnapshot | null> {
  const state = getStateAdapter();
  await state.connect();
  const raw = await state.get(profileCacheKey(cacheIdentity));
  if (typeof raw !== "string") {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid cached sandbox snapshot for ${profileHash}`);
  }
  const parsed = cachedSnapshotSchema.safeParse(value);
  if (!parsed.success || parsed.data.profileHash !== profileHash) {
    throw new Error(`Invalid cached sandbox snapshot for ${profileHash}`);
  }
  return parsed.data;
}

/** Persist one dependency profile's reusable snapshot pointer. */
async function setCachedSnapshot(
  cacheIdentity: string,
  entry: CachedSnapshot,
): Promise<void> {
  const state = getStateAdapter();
  await state.connect();
  await state.set(
    profileCacheKey(cacheIdentity),
    JSON.stringify(entry),
    SNAPSHOT_CACHE_TTL_MS,
  );
}

async function createBuildSandbox(params: {
  runtime: string;
  timeoutMs: number;
  signal?: AbortSignal;
  sourceSnapshotId?: string;
}): Promise<SandboxSession> {
  const sandboxCredentials = getVercelSandboxCredentials();
  const resources = getSandboxResources();
  if (params.sourceSnapshotId) {
    return createSandboxSession(
      await Sandbox.create({
        timeout: params.timeoutMs,
        signal: params.signal,
        source: {
          type: "snapshot",
          snapshotId: params.sourceSnapshotId,
        },
        ...(sandboxCredentials ?? {}),
        ...(resources ? { resources } : {}),
      }),
    );
  }

  return createSandboxSession(
    await Sandbox.create({
      timeout: params.timeoutMs,
      runtime: params.runtime,
      signal: params.signal,
      ...(sandboxCredentials ?? {}),
      ...(resources ? { resources } : {}),
    }),
  );
}

async function captureSnapshot(
  sandbox: SandboxSession,
  dependencyCount: number,
  signal?: AbortSignal,
): Promise<string> {
  return await trace(
    "sandbox.snapshot.capture",
    "sandbox.snapshot.capture",
    {
      "app.sandbox.snapshot.dependency_count": dependencyCount,
    },
    async () => {
      const snapshot = await sandbox.snapshot({ signal });
      return snapshot.snapshotId;
    },
  );
}

async function withBuildSandbox<T>(
  sandbox: SandboxSession,
  callback: (sandbox: SandboxSession) => Promise<T>,
): Promise<T> {
  try {
    return await callback(sandbox);
  } finally {
    try {
      await sandbox.stop();
    } catch {
      // Snapshot creation may already finalize the sandbox; cleanup stays best-effort.
    }
  }
}

/** Install dependencies into a fresh runtime sandbox and capture a snapshot. */
async function buildBase(
  value: profile.Profile,
  runtime: string,
  timeoutMs: number,
  signal?: AbortSignal,
  prepare?: (sandbox: SandboxSession) => Promise<void>,
): Promise<string> {
  return await trace(
    "sandbox.snapshot.build",
    "sandbox.snapshot.build",
    {
      "app.sandbox.runtime": runtime,
      "app.sandbox.snapshot.dependency_count": value.dependencyCount,
      "app.sandbox.snapshot.build_mode": "base",
    },
    async () => {
      const sandbox = await createBuildSandbox({
        runtime,
        timeoutMs,
        signal,
      });
      return await withBuildSandbox(sandbox, async (active) => {
        await install.dependencies(active, value.dependencies, signal);
        await install.postinstall(active, value.postinstall, signal);
        await prepare?.(active);
        return await captureSnapshot(active, value.dependencyCount, signal);
      });
    },
  );
}

class MissingBaseSnapshotError extends Error {
  constructor(
    readonly snapshotId: string,
    cause: unknown,
  ) {
    super(`Base sandbox snapshot not found: ${snapshotId}`, { cause });
    this.name = "MissingBaseSnapshotError";
  }
}

/** Boot from a base snapshot, run workspace prepare, and capture the result. */
async function buildWorkspaceFromBase(params: {
  value: profile.Profile;
  runtime: string;
  timeoutMs: number;
  baseSnapshotId: string;
  signal?: AbortSignal;
  prepare?: (sandbox: SandboxSession) => Promise<void>;
}): Promise<string> {
  return await trace(
    "sandbox.snapshot.build",
    "sandbox.snapshot.build",
    {
      "app.sandbox.runtime": params.runtime,
      "app.sandbox.snapshot.dependency_count": params.value.dependencyCount,
      "app.sandbox.snapshot.build_mode": "workspace_extend",
      "app.sandbox.snapshot.base_hash": params.value.baseHash,
    },
    async () => {
      let sandbox: SandboxSession;
      try {
        sandbox = await createBuildSandbox({
          runtime: params.runtime,
          timeoutMs: params.timeoutMs,
          signal: params.signal,
          sourceSnapshotId: params.baseSnapshotId,
        });
      } catch (error) {
        if (isMissingError(error)) {
          throw new MissingBaseSnapshotError(params.baseSnapshotId, error);
        }
        throw error;
      }
      return await withBuildSandbox(sandbox, async (active) => {
        await params.prepare?.(active);
        return await captureSnapshot(
          active,
          params.value.dependencyCount,
          params.signal,
        );
      });
    },
  );
}

/** Run one profile build under a timeout-buffered lock or reuse its result. */
async function withBuildLock(
  cacheIdentity: string,
  profileHash: string,
  timeoutMs: number,
  callback: () => Promise<{
    snapshotId: string;
    source: "cache_hit" | "built";
  }>,
  canUseCachedSnapshot: (cached: CachedSnapshot) => boolean,
  onWaitingForLock?: () => void | Promise<void>,
  signal?: AbortSignal,
): Promise<LockResult> {
  signal?.throwIfAborted();
  const state = getStateAdapter();
  await state.connect();
  const lockKey = profileLockKey(cacheIdentity);
  const lockTtlMs = timeoutMs + SNAPSHOT_BUILD_LOCK_BUFFER_MS;
  const tryAcquireLock = async () =>
    await state.acquireLock(lockKey, lockTtlMs);

  let lock = await tryAcquireLock();
  if (lock) {
    try {
      return await callback();
    } finally {
      await state.releaseLock(lock);
    }
  }

  return await trace(
    "sandbox.snapshot.lock_wait",
    "sandbox.snapshot.lock_wait",
    {
      "app.sandbox.snapshot.profile_hash": profileHash,
    },
    async () => {
      await onWaitingForLock?.();
      const waitUntil =
        Date.now() + lockTtlMs + SNAPSHOT_WAIT_FOR_LOCK_BUFFER_MS;
      while (Date.now() < waitUntil) {
        signal?.throwIfAborted();
        const cached = await getCachedSnapshot(cacheIdentity, profileHash);
        if (cached?.snapshotId && canUseCachedSnapshot(cached)) {
          return {
            snapshotId: cached.snapshotId,
            source: "cache_hit_after_lock_wait",
          };
        }

        lock = await tryAcquireLock();
        if (lock) {
          try {
            const result = await callback();
            return {
              snapshotId: result.snapshotId,
              source:
                result.source === "built"
                  ? "built"
                  : "cache_hit_after_lock_wait",
            };
          } finally {
            await state.releaseLock(lock);
          }
        }

        await sleep(500, signal);
      }

      signal?.throwIfAborted();
      const cached = await getCachedSnapshot(cacheIdentity, profileHash);
      if (cached?.snapshotId && canUseCachedSnapshot(cached)) {
        return {
          snapshotId: cached.snapshotId,
          source: "cache_hit_after_lock_wait",
        };
      }

      throw new Error("Timed out waiting for snapshot build lock");
    },
  );
}

function toResolveOutcome(
  forceRebuild: boolean,
  source: LockResult["source"],
): ResolveOutcome {
  if (source === "built") {
    return forceRebuild ? "forced_rebuild" : "rebuilt";
  }
  return source;
}

function getRebuildReason(params: {
  forceRebuild?: boolean;
  staleSnapshotId?: string;
  cached?: CachedSnapshot | null;
  shouldRebuildCached: boolean;
}): RebuildReason | undefined {
  if (params.forceRebuild) {
    return params.staleSnapshotId ? "snapshot_missing" : "force_rebuild";
  }
  if (params.cached?.snapshotId && params.shouldRebuildCached) {
    return "floating_stale";
  }
  if (!params.cached?.snapshotId) {
    return "cache_miss";
  }
  return undefined;
}

async function resolveProfile(
  params: ResolveParams,
  currentProfile: profile.Profile,
  options: {
    build?: () => Promise<string>;
    cacheIdentity?: string;
  } = {},
): Promise<Snapshot> {
  const cacheIdentity = options.cacheIdentity ?? currentProfile.hash;
  const cached = await getCachedSnapshot(cacheIdentity, currentProfile.hash);
  const cachedNeedsRebuild = Boolean(
    cached?.snapshotId &&
      profile.isStale(currentProfile, cached.createdAtMs),
  );

  if (!params.forceRebuild && cached?.snapshotId && !cachedNeedsRebuild) {
    await params.onProgress?.("cache_hit");
    return {
      snapshotId: cached.snapshotId,
      profileHash: currentProfile.hash,
      dependencyCount: currentProfile.dependencyCount,
      cacheHit: true,
      resolveOutcome: "cache_hit",
    };
  }

  const rebuildReason = getRebuildReason({
    forceRebuild: params.forceRebuild,
    staleSnapshotId: params.staleSnapshotId,
    cached,
    shouldRebuildCached: cachedNeedsRebuild,
  });

  const canUseCachedSnapshot = (candidate: CachedSnapshot): boolean => {
    if (params.forceRebuild) {
      if (params.staleSnapshotId) {
        return candidate.snapshotId !== params.staleSnapshotId;
      }
      // Force rebuild requests should ignore snapshots that existed before this
      // call but can reuse a fresh snapshot produced by a concurrent builder.
      return candidate.snapshotId !== cached?.snapshotId;
    }
    return !profile.isStale(currentProfile, candidate.createdAtMs);
  };

  const lockResult = await withBuildLock(
    cacheIdentity,
    currentProfile.hash,
    params.timeoutMs,
    async () => {
      const latest = await getCachedSnapshot(
        cacheIdentity,
        currentProfile.hash,
      );
      if (latest?.snapshotId && canUseCachedSnapshot(latest)) {
        await params.onProgress?.("cache_hit");
        return {
          snapshotId: latest.snapshotId,
          source: "cache_hit",
        };
      }

      await params.onProgress?.("building_snapshot");
      const nextSnapshotId = options.build
        ? await options.build()
        : await buildBase(
            currentProfile,
            params.runtime,
            params.timeoutMs,
            params.signal,
            params.prepareWorkspace,
          );
      await setCachedSnapshot(cacheIdentity, {
        profileHash: currentProfile.hash,
        snapshotId: nextSnapshotId,
        runtime: params.runtime,
        createdAtMs: Date.now(),
        dependencyCount: currentProfile.dependencyCount,
      });
      await params.onProgress?.("build_complete");
      return { snapshotId: nextSnapshotId, source: "built" };
    },
    canUseCachedSnapshot,
    async () => {
      await params.onProgress?.("waiting_for_lock");
    },
    params.signal,
  );

  return {
    snapshotId: lockResult.snapshotId,
    profileHash: currentProfile.hash,
    dependencyCount: currentProfile.dependencyCount,
    cacheHit: lockResult.source !== "built",
    resolveOutcome: toResolveOutcome(
      Boolean(params.forceRebuild),
      lockResult.source,
    ),
    ...(rebuildReason ? { rebuildReason } : {}),
  };
}

async function resolveWorkspaceProfile(
  params: ResolveParams,
  currentProfile: profile.Profile,
): Promise<Snapshot> {
  let staleBaseSnapshotId: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const baseSnapshot = await resolve({
      runtime: params.runtime,
      timeoutMs: params.timeoutMs,
      ...(staleBaseSnapshotId
        ? {
            forceRebuild: true,
            staleSnapshotId: staleBaseSnapshotId,
          }
        : {}),
      signal: params.signal,
      onProgress: params.onProgress,
    });
    if (!baseSnapshot.snapshotId) {
      throw new Error("Workspace profile requires a base sandbox snapshot");
    }

    try {
      return await resolveProfile(params, currentProfile, {
        cacheIdentity: workspaceCacheIdentity(
          currentProfile.hash,
          baseSnapshot.snapshotId,
        ),
        build: async () =>
          await buildWorkspaceFromBase({
            value: currentProfile,
            runtime: params.runtime,
            timeoutMs: params.timeoutMs,
            baseSnapshotId: baseSnapshot.snapshotId!,
            signal: params.signal,
            prepare: params.prepareWorkspace,
          }),
      });
    } catch (error) {
      if (attempt > 0 || !(error instanceof MissingBaseSnapshotError)) {
        throw error;
      }
      staleBaseSnapshotId = error.snapshotId;
    }
  }
  throw new Error("Failed to resolve workspace sandbox snapshot");
}

/** Resolve or build the reusable snapshot for the current dependency profile. */
export async function resolve(params: ResolveParams): Promise<Snapshot> {
  return await trace(
    "sandbox.snapshot.resolve",
    "sandbox.snapshot.resolve",
    {
      "app.sandbox.runtime": params.runtime,
      "app.sandbox.snapshot.force_rebuild": Boolean(params.forceRebuild),
      "app.sandbox.snapshot.has_workspace": Boolean(params.workspace),
    },
    async () => {
      params.signal?.throwIfAborted();
      await params.onProgress?.("resolve_start");
      const currentProfile = profile.create(params.runtime, params.workspace);
      if (!currentProfile) {
        return {
          dependencyCount: 0,
          cacheHit: false,
          resolveOutcome: "no_profile",
        };
      }

      return currentProfile.baseHash
        ? await resolveWorkspaceProfile(params, currentProfile)
        : await resolveProfile(params, currentProfile);
    },
  );
}

/** Identify provider errors that mean a referenced snapshot no longer exists. */
export function isMissingError(error: unknown): boolean {
  const searchable =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    searchable.includes("snapshot") &&
    (searchable.includes("not found") ||
      searchable.includes("unknown") ||
      searchable.includes("404"))
  );
}
