import { Sandbox } from "@vercel/sandbox";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import { getSandboxResources } from "@/chat/sandbox/resources";
import * as install from "@/chat/sandbox/snapshot/install";
import * as profile from "@/chat/sandbox/snapshot/profile";
import { trace } from "@/chat/sandbox/snapshot/span";
import { createSandboxSession } from "@/chat/sandbox/workspace";
import { sleep } from "@/chat/sleep";
import { getStateAdapter } from "@/chat/state/adapter";

// Snapshot resolution owns cache and lock coordination. Profile selection and
// sandbox installation stay in their neighboring modules.
const SNAPSHOT_CACHE_PREFIX = "junior:sandbox_snapshot_profile";
const SNAPSHOT_LOCK_PREFIX = "junior:sandbox_snapshot_lock";
const SNAPSHOT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SNAPSHOT_BUILD_LOCK_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_WAIT_FOR_LOCK_MS = SNAPSHOT_BUILD_LOCK_TTL_MS + 30 * 1000;

interface CachedSnapshotEntry {
  profileHash: string;
  snapshotId: string;
  runtime: string;
  createdAtMs: number;
  dependencyCount: number;
}

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

interface BuildLockResult {
  snapshotId: string;
  source: "wait_cache" | "callback_cache" | "built";
  waitedForLock: boolean;
}

function profileCacheKey(profileHash: string): string {
  return `${SNAPSHOT_CACHE_PREFIX}:${profileHash}`;
}

function profileLockKey(profileHash: string): string {
  return `${SNAPSHOT_LOCK_PREFIX}:${profileHash}`;
}

async function getCachedSnapshot(
  profileHash: string,
): Promise<CachedSnapshotEntry | null> {
  try {
    const state = getStateAdapter();
    await state.connect();
    const raw = await state.get(profileCacheKey(profileHash));
    if (typeof raw !== "string") {
      return null;
    }
    const parsed = JSON.parse(raw) as CachedSnapshotEntry;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.profileHash !== "string" ||
      typeof parsed.snapshotId !== "string" ||
      typeof parsed.runtime !== "string" ||
      typeof parsed.createdAtMs !== "number" ||
      typeof parsed.dependencyCount !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function setCachedSnapshot(entry: CachedSnapshotEntry): Promise<void> {
  const state = getStateAdapter();
  await state.connect();
  await state.set(
    profileCacheKey(entry.profileHash),
    JSON.stringify(entry),
    SNAPSHOT_CACHE_TTL_MS,
  );
}

async function build(
  value: profile.Profile,
  runtime: string,
  timeoutMs: number,
): Promise<string> {
  return await trace(
    "sandbox.snapshot.build",
    "sandbox.snapshot.build",
    {
      "app.sandbox.runtime": runtime,
      "app.sandbox.snapshot.dependency_count": value.dependencyCount,
    },
    async () => {
      const sandboxCredentials = getVercelSandboxCredentials();
      const resources = getSandboxResources();
      const sandbox = createSandboxSession(
        await Sandbox.create({
          timeout: timeoutMs,
          runtime,
          ...(sandboxCredentials ?? {}),
          ...(resources ? { resources } : {}),
        }),
      );

      try {
        await install.dependencies(sandbox, value.dependencies);
        await install.postinstall(sandbox, value.postinstall);
        return await trace(
          "sandbox.snapshot.capture",
          "sandbox.snapshot.capture",
          {
            "app.sandbox.snapshot.dependency_count": value.dependencyCount,
          },
          async () => {
            const snapshot = await sandbox.snapshot();
            return snapshot.snapshotId;
          },
        );
      } finally {
        try {
          await sandbox.stop();
        } catch {
          // Snapshot creation may already finalize the sandbox; cleanup stays best-effort.
        }
      }
    },
  );
}

async function withBuildLock(
  profileHash: string,
  callback: () => Promise<{
    snapshotId: string;
    source: "callback_cache" | "built";
  }>,
  canUseCachedSnapshot: (cached: CachedSnapshotEntry) => boolean,
  hooks?: {
    onWaitingForLock?: () => void | Promise<void>;
  },
): Promise<BuildLockResult> {
  const state = getStateAdapter();
  await state.connect();
  const lockKey = profileLockKey(profileHash);
  const tryAcquireLock = async () =>
    await state.acquireLock(lockKey, SNAPSHOT_BUILD_LOCK_TTL_MS);

  let lock = await tryAcquireLock();
  if (lock) {
    try {
      const result = await callback();
      return {
        snapshotId: result.snapshotId,
        source: result.source,
        waitedForLock: false,
      };
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
      await hooks?.onWaitingForLock?.();
      const waitUntil = Date.now() + SNAPSHOT_WAIT_FOR_LOCK_MS;
      while (Date.now() < waitUntil) {
        const cached = await getCachedSnapshot(profileHash);
        if (cached?.snapshotId && canUseCachedSnapshot(cached)) {
          return {
            snapshotId: cached.snapshotId,
            source: "wait_cache" as const,
            waitedForLock: true,
          };
        }

        lock = await tryAcquireLock();
        if (lock) {
          try {
            const result = await callback();
            return {
              snapshotId: result.snapshotId,
              source: result.source,
              waitedForLock: true,
            };
          } finally {
            await state.releaseLock(lock);
          }
        }

        await sleep(500);
      }

      const cached = await getCachedSnapshot(profileHash);
      if (cached?.snapshotId && canUseCachedSnapshot(cached)) {
        return {
          snapshotId: cached.snapshotId,
          source: "wait_cache" as const,
          waitedForLock: true,
        };
      }

      throw new Error("Timed out waiting for snapshot build lock");
    },
  );
}

function toResolveOutcome(
  forceRebuild: boolean,
  source: BuildLockResult["source"],
  waitedForLock: boolean,
): ResolveOutcome {
  if (source === "built") {
    return forceRebuild ? "forced_rebuild" : "rebuilt";
  }
  if (waitedForLock || source === "wait_cache") {
    return "cache_hit_after_lock_wait";
  }
  return "cache_hit";
}

function getRebuildReason(params: {
  forceRebuild?: boolean;
  staleSnapshotId?: string;
  cached?: CachedSnapshotEntry | null;
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

/** Resolve or build the reusable snapshot for the current dependency profile. */
export async function resolve(params: {
  runtime: string;
  timeoutMs: number;
  forceRebuild?: boolean;
  staleSnapshotId?: string;
  onProgress?: (phase: ProgressPhase) => void | Promise<void>;
}): Promise<Snapshot> {
  return await trace(
    "sandbox.snapshot.resolve",
    "sandbox.snapshot.resolve",
    {
      "app.sandbox.runtime": params.runtime,
      "app.sandbox.snapshot.force_rebuild": Boolean(params.forceRebuild),
    },
    async () => {
      await params.onProgress?.("resolve_start");
      const resolveStartedAtMs = Date.now();
      const currentProfile = profile.create(params.runtime);
      if (!currentProfile) {
        return {
          dependencyCount: 0,
          cacheHit: false,
          resolveOutcome: "no_profile",
        };
      }

      const cached = await getCachedSnapshot(currentProfile.hash);
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

      const canUseCachedSnapshot = (
        candidate: CachedSnapshotEntry,
      ): boolean => {
        if (params.forceRebuild) {
          if (params.staleSnapshotId) {
            return candidate.snapshotId !== params.staleSnapshotId;
          }
          // Force rebuild requests should ignore snapshots that existed before this
          // call but can reuse a fresh snapshot produced by a concurrent builder.
          return candidate.createdAtMs > resolveStartedAtMs;
        }
        return !profile.isStale(currentProfile, candidate.createdAtMs);
      };

      const lockResult = await withBuildLock(
        currentProfile.hash,
        async () => {
          const latest = await getCachedSnapshot(currentProfile.hash);
          if (latest?.snapshotId && canUseCachedSnapshot(latest)) {
            await params.onProgress?.("cache_hit");
            return {
              snapshotId: latest.snapshotId,
              source: "callback_cache" as const,
            };
          }

          await params.onProgress?.("building_snapshot");
          const nextSnapshotId = await build(
            currentProfile,
            params.runtime,
            params.timeoutMs,
          );
          await setCachedSnapshot({
            profileHash: currentProfile.hash,
            snapshotId: nextSnapshotId,
            runtime: params.runtime,
            createdAtMs: Date.now(),
            dependencyCount: currentProfile.dependencyCount,
          });
          await params.onProgress?.("build_complete");
          return { snapshotId: nextSnapshotId, source: "built" as const };
        },
        canUseCachedSnapshot,
        {
          onWaitingForLock: async () => {
            await params.onProgress?.("waiting_for_lock");
          },
        },
      );

      return {
        snapshotId: lockResult.snapshotId,
        profileHash: currentProfile.hash,
        dependencyCount: currentProfile.dependencyCount,
        cacheHit: lockResult.source !== "built",
        resolveOutcome: toResolveOutcome(
          Boolean(params.forceRebuild),
          lockResult.source,
          lockResult.waitedForLock,
        ),
        ...(rebuildReason ? { rebuildReason } : {}),
      };
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
