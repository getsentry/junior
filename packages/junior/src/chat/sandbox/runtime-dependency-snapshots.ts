import { createHash } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { getPluginRuntimeDependencies } from "@/chat/plugins/registry";
import type { PluginRuntimeDependency } from "@/chat/plugins/types";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import { getStateAdapter } from "@/chat/state";

const SNAPSHOT_CACHE_PREFIX = "junior:sandbox_snapshot_profile";
const SNAPSHOT_LOCK_PREFIX = "junior:sandbox_snapshot_lock";
const SNAPSHOT_PROFILE_VERSION = 1;
const SNAPSHOT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SNAPSHOT_BUILD_LOCK_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_WAIT_FOR_LOCK_MS = SNAPSHOT_BUILD_LOCK_TTL_MS + 30 * 1000;
const DEFAULT_FLOATING_DEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedSnapshotEntry {
  profileHash: string;
  snapshotId: string;
  runtime: string;
  createdAtMs: number;
  dependencyCount: number;
}

interface DependencyProfile {
  profileHash: string;
  dependencyCount: number;
  hasFloatingVersions: boolean;
  dependencies: PluginRuntimeDependency[];
}

export interface RuntimeDependencySnapshot {
  snapshotId?: string;
  profileHash?: string;
  dependencyCount: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function profileCacheKey(profileHash: string): string {
  return `${SNAPSHOT_CACHE_PREFIX}:${profileHash}`;
}

function profileLockKey(profileHash: string): string {
  return `${SNAPSHOT_LOCK_PREFIX}:${profileHash}`;
}

function isExactNpmVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][a-z0-9.]+)?$/i.test(version.trim());
}

function hasFloatingSelector(dep: PluginRuntimeDependency): boolean {
  return dep.type === "npm" && !isExactNpmVersion(dep.version);
}

function parseFloatingDepMaxAgeMs(): number {
  const raw = process.env.SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS;
  if (!raw?.trim()) {
    return DEFAULT_FLOATING_DEP_MAX_AGE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_FLOATING_DEP_MAX_AGE_MS;
  }
  return parsed;
}

function buildDependencyProfile(runtime: string): DependencyProfile | null {
  const dependencies = getPluginRuntimeDependencies();
  if (dependencies.length === 0) {
    return null;
  }
  const rebuildEpoch = process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH?.trim() ?? "";
  const hasFloatingVersions = dependencies.some((dep) => hasFloatingSelector(dep));

  const hashInput = JSON.stringify({
    version: SNAPSHOT_PROFILE_VERSION,
    runtime,
    rebuildEpoch,
    dependencies
  });

  const profileHash = createHash("sha256").update(hashInput).digest("hex");
  return {
    profileHash,
    dependencyCount: dependencies.length,
    hasFloatingVersions,
    dependencies
  };
}

function shouldRebuildCachedSnapshot(profile: DependencyProfile, cached: CachedSnapshotEntry): boolean {
  if (!profile.hasFloatingVersions) {
    return false;
  }
  const maxAgeMs = parseFloatingDepMaxAgeMs();
  if (maxAgeMs === 0) {
    return true;
  }
  return Date.now() - cached.createdAtMs > maxAgeMs;
}

async function getCachedSnapshot(profileHash: string): Promise<CachedSnapshotEntry | null> {
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
  await state.set(profileCacheKey(entry.profileHash), JSON.stringify(entry), SNAPSHOT_CACHE_TTL_MS);
}

async function runOrThrow(sandbox: Sandbox, params: {
  cmd: string;
  args?: string[];
  sudo?: boolean;
}, label: string): Promise<void> {
  const result = await sandbox.runCommand(params);
  if (result.exitCode === 0) {
    return;
  }

  const stderr = (await result.stderr()).trim();
  const stdout = (await result.stdout()).trim();
  const detail = stderr || stdout || "command failed";
  throw new Error(`${label} failed: ${detail}`);
}

async function installRuntimeDependencies(sandbox: Sandbox, deps: PluginRuntimeDependency[]): Promise<void> {
  const npmPackages: string[] = [];

  for (const dep of deps) {
    if (dep.type === "system") {
      await runOrThrow(
        sandbox,
        {
          cmd: "dnf",
          args: ["install", "-y", dep.package],
          sudo: true
        },
        `dnf install ${dep.package}`
      );
      continue;
    }
    npmPackages.push(`${dep.package}@${dep.version}`);
  }

  if (npmPackages.length > 0) {
    await runOrThrow(
      sandbox,
      {
        cmd: "npm",
        args: [
          "install",
          "--global",
          "--prefix",
          `${SANDBOX_WORKSPACE_ROOT}/.junior`,
          ...npmPackages
        ]
      },
      "npm install"
    );
  }
}

async function createDependencySnapshot(profile: DependencyProfile, runtime: string, timeoutMs: number): Promise<string> {
  const sandbox = await Sandbox.create({
    timeout: timeoutMs,
    runtime
  });

  try {
    await installRuntimeDependencies(sandbox, profile.dependencies);
    const snapshot = await sandbox.snapshot();
    return snapshot.snapshotId;
  } finally {
    try {
      await sandbox.stop({ blocking: true });
    } catch {
      // Snapshot creation may already finalize the sandbox; cleanup stays best-effort.
    }
  }
}

async function withBuildLock(
  profileHash: string,
  callback: () => Promise<string>,
  canUseCachedSnapshot: (cached: CachedSnapshotEntry) => boolean
): Promise<string> {
  const state = getStateAdapter();
  await state.connect();
  const lockKey = profileLockKey(profileHash);
  const tryAcquireLock = async () => await state.acquireLock(lockKey, SNAPSHOT_BUILD_LOCK_TTL_MS);

  let lock = await tryAcquireLock();
  if (lock) {
    try {
      return await callback();
    } finally {
      await state.releaseLock(lock);
    }
  }

  const waitUntil = Date.now() + SNAPSHOT_WAIT_FOR_LOCK_MS;
  while (Date.now() < waitUntil) {
    const cached = await getCachedSnapshot(profileHash);
    if (cached?.snapshotId && canUseCachedSnapshot(cached)) {
      return cached.snapshotId;
    }

    lock = await tryAcquireLock();
    if (lock) {
      try {
        return await callback();
      } finally {
        await state.releaseLock(lock);
      }
    }

    await sleep(500);
  }

  const cached = await getCachedSnapshot(profileHash);
  if (cached?.snapshotId && canUseCachedSnapshot(cached)) {
    return cached.snapshotId;
  }

  throw new Error("Timed out waiting for snapshot build lock");
}

export async function resolveRuntimeDependencySnapshot(params: {
  runtime: string;
  timeoutMs: number;
  forceRebuild?: boolean;
  staleSnapshotId?: string;
}): Promise<RuntimeDependencySnapshot> {
  const resolveStartedAtMs = Date.now();
  const profile = buildDependencyProfile(params.runtime);
  if (!profile) {
    return { dependencyCount: 0 };
  }

  if (!params.forceRebuild) {
    const cached = await getCachedSnapshot(profile.profileHash);
    if (cached?.snapshotId && !shouldRebuildCachedSnapshot(profile, cached)) {
      return {
        snapshotId: cached.snapshotId,
        profileHash: profile.profileHash,
        dependencyCount: profile.dependencyCount
      };
    }
  }

  const canUseCachedSnapshot = (cached: CachedSnapshotEntry): boolean => {
    if (params.forceRebuild) {
      if (params.staleSnapshotId) {
        return cached.snapshotId !== params.staleSnapshotId;
      }
      // Force rebuild requests should ignore snapshots that existed before this
      // call but can reuse a fresh snapshot produced by a concurrent builder.
      return cached.createdAtMs > resolveStartedAtMs;
    }
    return !shouldRebuildCachedSnapshot(profile, cached);
  };

  const snapshotId = await withBuildLock(profile.profileHash, async () => {
    const cached = await getCachedSnapshot(profile.profileHash);
    if (cached?.snapshotId && canUseCachedSnapshot(cached)) {
      return cached.snapshotId;
    }

    const nextSnapshotId = await createDependencySnapshot(profile, params.runtime, params.timeoutMs);
    await setCachedSnapshot({
      profileHash: profile.profileHash,
      snapshotId: nextSnapshotId,
      runtime: params.runtime,
      createdAtMs: Date.now(),
      dependencyCount: profile.dependencyCount
    });
    return nextSnapshotId;
  }, canUseCachedSnapshot);

  return {
    snapshotId,
    profileHash: profile.profileHash,
    dependencyCount: profile.dependencyCount
  };
}

export function isSnapshotMissingError(error: unknown): boolean {
  const searchable = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return searchable.includes("snapshot") && (searchable.includes("not found") || searchable.includes("unknown") || searchable.includes("404"));
}
