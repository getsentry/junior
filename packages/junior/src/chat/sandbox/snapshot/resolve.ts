import { Sandbox } from "@vercel/sandbox";
import { z } from "zod";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import { getSandboxResources } from "@/chat/sandbox/resources";
import * as install from "@/chat/sandbox/snapshot/install";
import * as profile from "@/chat/sandbox/snapshot/profile";
import { trace } from "@/chat/sandbox/snapshot/span";
import {
  createSandboxSession,
  type SandboxSession,
} from "@/chat/sandbox/workspace";
import type { Workspace } from "@/chat/workspaces/types";
import { sleep } from "@/chat/sleep";
import { getStateAdapter } from "@/chat/state/adapter";

// Snapshot resolution owns cache and lock coordination. Profile selection and
// sandbox installation stay in their neighboring modules.
// v2 adds required buildDurationMs. Old v1 keys age out via TTL.
const SNAPSHOT_CACHE_PREFIX = "junior:sandbox_snapshot_profile:v2";
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
    buildDurationMs: z.number().int().nonnegative(),
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

function profileCacheKey(profileHash: string): string {
  return `${SNAPSHOT_CACHE_PREFIX}:${profileHash}`;
}

function profileLockKey(profileHash: string): string {
  return `${SNAPSHOT_LOCK_PREFIX}:${profileHash}`;
}

/** Read one cached snapshot pointer; only a missing key is a cache miss. */
export async function getCachedSnapshot(
  profileHash: string,
): Promise<CachedSnapshot | null> {
  const state = getStateAdapter();
  await state.connect();
  const raw = await state.get(profileCacheKey(profileHash));
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
async function setCachedSnapshot(entry: CachedSnapshot): Promise<void> {
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
  signal?: AbortSignal,
  prepare?: (sandbox: SandboxSession) => Promise<void>,
): Promise<{ snapshotId: string; buildDurationMs: number }> {
  return await trace(
    "sandbox.snapshot.build",
    "sandbox.snapshot.build",
    {
      "app.sandbox.runtime": runtime,
      "app.sandbox.snapshot.dependency_count": value.dependencyCount,
    },
    async () => {
      const startedAtMs = Date.now();
      const sandboxCredentials = getVercelSandboxCredentials();
      const resources = getSandboxResources();
      const sandbox = createSandboxSession(
        await Sandbox.create({
          timeout: timeoutMs,
          runtime,
          signal,
          ...(sandboxCredentials ?? {}),
          ...(resources ? { resources } : {}),
        }),
      );

      try {
        await install.dependencies(sandbox, value.dependencies, signal);
        await install.postinstall(sandbox, value.postinstall, signal);
        await prepare?.(sandbox);
        const snapshotId = await trace(
          "sandbox.snapshot.capture",
          "sandbox.snapshot.capture",
          {
            "app.sandbox.snapshot.dependency_count": value.dependencyCount,
          },
          async () => {
            const snapshot = await sandbox.snapshot({ signal });
            return snapshot.snapshotId;
          },
        );
        return {
          snapshotId,
          buildDurationMs: Math.max(0, Date.now() - startedAtMs),
        };
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

/** Run one profile build under a timeout-buffered lock or reuse its result. */
async function withBuildLock(
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
  const lockKey = profileLockKey(profileHash);
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
        const cached = await getCachedSnapshot(profileHash);
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
      const cached = await getCachedSnapshot(profileHash);
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

/** Resolve or build the reusable snapshot for the current dependency profile. */
export async function resolve(params: {
  runtime: string;
  timeoutMs: number;
  forceRebuild?: boolean;
  staleSnapshotId?: string;
  onProgress?: (phase: ProgressPhase) => void | Promise<void>;
  signal?: AbortSignal;
  workspace?: Workspace;
  prepareWorkspace?: (sandbox: SandboxSession) => Promise<void>;
}): Promise<Snapshot> {
  return await trace(
    "sandbox.snapshot.resolve",
    "sandbox.snapshot.resolve",
    {
      "app.sandbox.runtime": params.runtime,
      "app.sandbox.snapshot.force_rebuild": Boolean(params.forceRebuild),
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
        currentProfile.hash,
        params.timeoutMs,
        async () => {
          const latest = await getCachedSnapshot(currentProfile.hash);
          if (latest?.snapshotId && canUseCachedSnapshot(latest)) {
            await params.onProgress?.("cache_hit");
            return {
              snapshotId: latest.snapshotId,
              source: "cache_hit",
            };
          }

          await params.onProgress?.("building_snapshot");
          const built = await build(
            currentProfile,
            params.runtime,
            params.timeoutMs,
            params.signal,
            params.prepareWorkspace,
          );
          await setCachedSnapshot({
            profileHash: currentProfile.hash,
            snapshotId: built.snapshotId,
            runtime: params.runtime,
            createdAtMs: Date.now(),
            dependencyCount: currentProfile.dependencyCount,
            buildDurationMs: built.buildDurationMs,
          });
          await params.onProgress?.("build_complete");
          return { snapshotId: built.snapshotId, source: "built" };
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
