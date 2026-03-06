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

function isExactAptVersion(version: string): boolean {
  return /^\d+(?:\.\d+){2,}(?:[-+~][a-z0-9.:+-]+)?$/i.test(version.trim());
}

function hasFloatingSelector(dep: PluginRuntimeDependency): boolean {
  if (dep.type === "npm") {
    return !isExactNpmVersion(dep.version);
  }
  return !isExactAptVersion(dep.version);
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

function normalizeInstalledVersion(raw: string): string {
  const trimmed = raw.trim();
  const withoutEpoch = trimmed.includes(":") ? trimmed.slice(trimmed.lastIndexOf(":") + 1) : trimmed;
  return withoutEpoch.split("-")[0] ?? withoutEpoch;
}

function parseNumericVersionParts(version: string): number[] | null {
  if (!/^\d+(?:\.\d+)*$/.test(version)) {
    return null;
  }
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

function compareVersionParts(left: number[], right: number[]): number {
  const maxLen = Math.max(left.length, right.length);
  for (let index = 0; index < maxLen; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart < rightPart) {
      return -1;
    }
    if (leftPart > rightPart) {
      return 1;
    }
  }
  return 0;
}

function matchesCaretSelector(installed: string, selector: string): boolean {
  const installedParts = parseNumericVersionParts(installed);
  const selectorParts = parseNumericVersionParts(selector);
  if (!installedParts || !selectorParts) {
    return false;
  }

  const pivotIndex = selectorParts.findIndex((part) => part !== 0);
  const boundedIndex = pivotIndex >= 0 ? pivotIndex : selectorParts.length - 1;
  const upperBound = [...selectorParts];
  upperBound[boundedIndex] = (upperBound[boundedIndex] ?? 0) + 1;
  for (let index = boundedIndex + 1; index < upperBound.length; index += 1) {
    upperBound[index] = 0;
  }

  return compareVersionParts(installedParts, selectorParts) >= 0 && compareVersionParts(installedParts, upperBound) < 0;
}

function versionSelectorMatches(installed: string, selector: string): boolean {
  const normalizedInstalled = normalizeInstalledVersion(installed);
  const normalizedSelector = selector.trim();

  if (normalizedSelector.startsWith("^")) {
    return matchesCaretSelector(normalizedInstalled, normalizedSelector.slice(1));
  }

  if (/^\d+$/.test(normalizedSelector)) {
    return normalizedInstalled === normalizedSelector || normalizedInstalled.startsWith(`${normalizedSelector}.`);
  }

  if (/^\d+\.\d+$/.test(normalizedSelector)) {
    return normalizedInstalled === normalizedSelector || normalizedInstalled.startsWith(`${normalizedSelector}.`);
  }

  return normalizedInstalled === normalizedSelector;
}

async function verifyAptDependencyVersion(
  sandbox: Sandbox,
  dep: Extract<PluginRuntimeDependency, { type: "apt" }>
): Promise<void> {
  const response = await sandbox.runCommand({
    cmd: "dpkg-query",
    args: ["-W", "-f=${Version}", dep.package]
  });
  if (response.exitCode !== 0) {
    const stderr = (await response.stderr()).trim();
    throw new Error(`verify ${dep.package} version failed: ${stderr || "dpkg-query failed"}`);
  }

  const installedVersion = (await response.stdout()).trim();
  if (!versionSelectorMatches(installedVersion, dep.version)) {
    throw new Error(
      `verify ${dep.package} version failed: expected selector ${dep.version}, got ${installedVersion}`
    );
  }
}

async function installRuntimeDependencies(sandbox: Sandbox, deps: PluginRuntimeDependency[]): Promise<void> {
  const aptDeps = deps.filter((dep): dep is Extract<PluginRuntimeDependency, { type: "apt" }> => dep.type === "apt");
  const npmDeps = deps.filter((dep): dep is Extract<PluginRuntimeDependency, { type: "npm" }> => dep.type === "npm");

  if (aptDeps.length > 0) {
    await runOrThrow(
      sandbox,
      {
        cmd: "apt-get",
        args: ["update"],
        sudo: true
      },
      "apt-get update"
    );

    for (const dep of aptDeps) {
      await runOrThrow(
        sandbox,
        {
          cmd: "apt-get",
          args: ["install", "-y", dep.package],
          sudo: true
        },
        `apt-get install ${dep.package}`
      );

      await verifyAptDependencyVersion(sandbox, dep);
    }
  }

  if (npmDeps.length > 0) {
    await runOrThrow(
      sandbox,
      {
        cmd: "npm",
        args: [
          "install",
          "--global",
          "--prefix",
          `${SANDBOX_WORKSPACE_ROOT}/.junior`,
          ...npmDeps.map((dep) => `${dep.package}@${dep.version}`)
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
      return false;
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
