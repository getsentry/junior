import { createHash } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { withSpan } from "@/chat/logging";
import {
  getPluginRuntimeDependencies,
  getPluginRuntimePostinstall,
} from "@/chat/plugins/registry";
import { runNonInteractiveCommand } from "@/chat/sandbox/noninteractive-command";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import type {
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
} from "@/chat/plugins/types";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import { getStateAdapter } from "@/chat/state/adapter";

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
  postinstall: PluginRuntimePostinstallCommand[];
}

export type SnapshotResolveOutcome =
  | "no_profile"
  | "cache_hit"
  | "cache_hit_after_lock_wait"
  | "rebuilt"
  | "forced_rebuild";

export type SnapshotRebuildReason =
  | "cache_miss"
  | "floating_stale"
  | "force_rebuild"
  | "snapshot_missing";

export interface RuntimeDependencySnapshot {
  snapshotId?: string;
  profileHash?: string;
  dependencyCount: number;
  cacheHit: boolean;
  resolveOutcome: SnapshotResolveOutcome;
  rebuildReason?: SnapshotRebuildReason;
}

export type RuntimeDependencySnapshotProgressPhase =
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
  const postinstall = getPluginRuntimePostinstall();
  if (dependencies.length === 0 && postinstall.length === 0) {
    return null;
  }
  const rebuildEpoch = process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH?.trim() ?? "";
  // Runtime postinstall commands may install mutable "latest" artifacts.
  // Treat those profiles as stale-able just like floating dependency selectors.
  const hasFloatingVersions =
    dependencies.some((dep) => hasFloatingSelector(dep)) ||
    postinstall.length > 0;

  const hashInput = JSON.stringify({
    version: SNAPSHOT_PROFILE_VERSION,
    runtime,
    rebuildEpoch,
    dependencies,
    postinstall,
  });

  const profileHash = createHash("sha256").update(hashInput).digest("hex");
  return {
    profileHash,
    dependencyCount: dependencies.length,
    hasFloatingVersions,
    dependencies,
    postinstall,
  };
}

export function getRuntimeDependencyProfileHash(
  runtime: string,
): string | undefined {
  return buildDependencyProfile(runtime)?.profileHash;
}

function shouldRebuildCachedSnapshot(
  profile: DependencyProfile,
  cached: CachedSnapshotEntry,
): boolean {
  if (!profile.hasFloatingVersions) {
    return false;
  }
  const maxAgeMs = parseFloatingDepMaxAgeMs();
  if (maxAgeMs === 0) {
    return true;
  }
  return Date.now() - cached.createdAtMs > maxAgeMs;
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

async function withSnapshotSpan<T>(
  name: string,
  op: string,
  attributes: Record<string, unknown>,
  callback: () => Promise<T>,
): Promise<T> {
  return await withSpan(name, op, {}, callback, attributes);
}

async function runOrThrow(
  sandbox: Sandbox,
  params: {
    cmd: string;
    args?: string[];
    sudo?: boolean;
  },
  label: string,
): Promise<void> {
  const result = await runNonInteractiveCommand(sandbox, params);
  if (result.exitCode === 0) {
    return;
  }

  const stderr = (await result.stderr()).trim();
  const stdout = (await result.stdout()).trim();
  const detail = stderr || stdout || "command failed";
  throw new Error(`${label} failed: ${detail}`);
}

async function tryRun(
  sandbox: Sandbox,
  params: {
    cmd: string;
    args?: string[];
    sudo?: boolean;
  },
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const result = await runNonInteractiveCommand(sandbox, params);
  if (result.exitCode === 0) {
    return { ok: true };
  }

  const stderr = (await result.stderr()).trim();
  const stdout = (await result.stdout()).trim();
  return { ok: false, detail: stderr || stdout || "command failed" };
}

async function installGhCliViaDnf(sandbox: Sandbox): Promise<void> {
  const direct = await tryRun(sandbox, {
    cmd: "dnf",
    args: ["install", "-y", "gh"],
    sudo: true,
  });
  if (direct.ok) {
    return;
  }

  const dnf5Repo = await tryRun(sandbox, {
    cmd: "dnf",
    args: [
      "config-manager",
      "addrepo",
      "--from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo",
    ],
    sudo: true,
  });
  if (!dnf5Repo.ok) {
    await runOrThrow(
      sandbox,
      {
        cmd: "dnf",
        args: ["install", "-y", "dnf-command(config-manager)"],
        sudo: true,
      },
      "dnf install dnf-command(config-manager)",
    );
    await runOrThrow(
      sandbox,
      {
        cmd: "dnf",
        args: [
          "config-manager",
          "--add-repo",
          "https://cli.github.com/packages/rpm/gh-cli.repo",
        ],
        sudo: true,
      },
      "dnf config-manager --add-repo gh-cli.repo",
    );
  }

  await runOrThrow(
    sandbox,
    {
      cmd: "dnf",
      args: ["install", "-y", "gh", "--repo", "gh-cli"],
      sudo: true,
    },
    "dnf install gh --repo gh-cli",
  );
}

function runtimeDependencyFilePath(url: string, sha256: string): string {
  let urlBasename = "package.rpm";
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    const candidate = segments[segments.length - 1];
    if (candidate) {
      urlBasename = candidate;
    }
  } catch {
    // URL shape is validated during manifest parsing; keep a safe fallback.
  }

  const sanitizedBasename = urlBasename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `/tmp/junior-runtime-${sha256.slice(0, 12)}-${sanitizedBasename}`;
}

async function installRuntimeDependencies(
  sandbox: Sandbox,
  deps: PluginRuntimeDependency[],
): Promise<void> {
  const systemDeps = deps.filter(
    (dep): dep is Extract<PluginRuntimeDependency, { type: "system" }> =>
      dep.type === "system",
  );
  const npmPackages = deps
    .filter(
      (dep): dep is Extract<PluginRuntimeDependency, { type: "npm" }> =>
        dep.type === "npm",
    )
    .map((dep) => `${dep.package}@${dep.version}`);

  if (systemDeps.length > 0) {
    await withSnapshotSpan(
      "sandbox.snapshot.install_system",
      "sandbox.snapshot.install.system",
      {
        "app.sandbox.snapshot.install.system_count": systemDeps.length,
      },
      async () => {
        for (const dep of systemDeps) {
          if ("url" in dep) {
            const rpmPath = runtimeDependencyFilePath(dep.url, dep.sha256);
            await runOrThrow(
              sandbox,
              {
                cmd: "curl",
                args: ["-fsSL", dep.url, "-o", rpmPath],
              },
              `curl download ${dep.url}`,
            );

            const checksumResult = await runNonInteractiveCommand(sandbox, {
              cmd: "sha256sum",
              args: [rpmPath],
            });
            const checksumStdout = (await checksumResult.stdout()).trim();
            const checksumStderr = (await checksumResult.stderr()).trim();
            if (checksumResult.exitCode !== 0) {
              throw new Error(
                `sha256sum failed: ${checksumStderr || checksumStdout || "command failed"}`,
              );
            }
            const actualChecksum = checksumStdout
              .split(/\s+/)[0]
              ?.toLowerCase();
            if (!actualChecksum) {
              throw new Error("sha256sum produced empty output");
            }
            if (actualChecksum !== dep.sha256) {
              throw new Error(
                `checksum mismatch for ${dep.url}: expected ${dep.sha256}, got ${actualChecksum}`,
              );
            }

            await runOrThrow(
              sandbox,
              {
                cmd: "dnf",
                args: ["install", "-y", rpmPath],
                sudo: true,
              },
              `dnf install ${dep.url}`,
            );
            continue;
          }

          if (dep.package === "gh") {
            await installGhCliViaDnf(sandbox);
            continue;
          }
          await runOrThrow(
            sandbox,
            {
              cmd: "dnf",
              args: ["install", "-y", dep.package],
              sudo: true,
            },
            `dnf install ${dep.package}`,
          );
        }
      },
    );
  }

  if (npmPackages.length > 0) {
    await withSnapshotSpan(
      "sandbox.snapshot.install_npm",
      "sandbox.snapshot.install.npm",
      {
        "app.sandbox.snapshot.install.npm_count": npmPackages.length,
      },
      async () => {
        await runOrThrow(
          sandbox,
          {
            cmd: "npm",
            args: [
              "install",
              "--global",
              "--prefix",
              `${SANDBOX_WORKSPACE_ROOT}/.junior`,
              ...npmPackages,
            ],
          },
          "npm install",
        );
      },
    );
  }
}

async function runRuntimePostinstall(
  sandbox: Sandbox,
  commands: PluginRuntimePostinstallCommand[],
): Promise<void> {
  if (commands.length === 0) {
    return;
  }

  await withSnapshotSpan(
    "sandbox.snapshot.runtime_postinstall",
    "sandbox.snapshot.runtime_postinstall",
    {
      "app.sandbox.snapshot.runtime_postinstall.count": commands.length,
    },
    async () => {
      for (const command of commands) {
        const result = await runNonInteractiveCommand(sandbox, {
          cmd: command.cmd,
          args: command.args,
          login: true,
          pathPrefix: `${SANDBOX_WORKSPACE_ROOT}/.junior/bin:$PATH`,
          ...(command.sudo !== undefined ? { sudo: command.sudo } : {}),
        });
        if (result.exitCode === 0) {
          continue;
        }

        const stderr = (await result.stderr()).trim();
        const stdout = (await result.stdout()).trim();
        const detail = stderr || stdout || "command failed";
        throw new Error(`runtime-postinstall ${command.cmd} failed: ${detail}`);
      }
    },
  );
}

async function createDependencySnapshot(
  profile: DependencyProfile,
  runtime: string,
  timeoutMs: number,
): Promise<string> {
  return await withSnapshotSpan(
    "sandbox.snapshot.build",
    "sandbox.snapshot.build",
    {
      "app.sandbox.runtime": runtime,
      "app.sandbox.snapshot.dependency_count": profile.dependencyCount,
    },
    async () => {
      const sandboxCredentials = getVercelSandboxCredentials();
      const sandbox = await Sandbox.create({
        timeout: timeoutMs,
        runtime,
        ...(sandboxCredentials ?? {}),
      });

      try {
        await installRuntimeDependencies(sandbox, profile.dependencies);
        await runRuntimePostinstall(sandbox, profile.postinstall);
        return await withSnapshotSpan(
          "sandbox.snapshot.capture",
          "sandbox.snapshot.capture",
          {
            "app.sandbox.snapshot.dependency_count": profile.dependencyCount,
          },
          async () => {
            const snapshot = await sandbox.snapshot();
            return snapshot.snapshotId;
          },
        );
      } finally {
        try {
          await sandbox.stop({ blocking: true });
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

  return await withSnapshotSpan(
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
): SnapshotResolveOutcome {
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
}): SnapshotRebuildReason | undefined {
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

export async function resolveRuntimeDependencySnapshot(params: {
  runtime: string;
  timeoutMs: number;
  forceRebuild?: boolean;
  staleSnapshotId?: string;
  onProgress?: (
    phase: RuntimeDependencySnapshotProgressPhase,
  ) => void | Promise<void>;
}): Promise<RuntimeDependencySnapshot> {
  return await withSnapshotSpan(
    "sandbox.snapshot.resolve",
    "sandbox.snapshot.resolve",
    {
      "app.sandbox.runtime": params.runtime,
      "app.sandbox.snapshot.force_rebuild": Boolean(params.forceRebuild),
    },
    async () => {
      await params.onProgress?.("resolve_start");
      const resolveStartedAtMs = Date.now();
      const profile = buildDependencyProfile(params.runtime);
      if (!profile) {
        return {
          dependencyCount: 0,
          cacheHit: false,
          resolveOutcome: "no_profile",
        };
      }

      const cached = await getCachedSnapshot(profile.profileHash);
      const cachedNeedsRebuild = Boolean(
        cached?.snapshotId && shouldRebuildCachedSnapshot(profile, cached),
      );

      if (!params.forceRebuild && cached?.snapshotId && !cachedNeedsRebuild) {
        await params.onProgress?.("cache_hit");
        return {
          snapshotId: cached.snapshotId,
          profileHash: profile.profileHash,
          dependencyCount: profile.dependencyCount,
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
        return !shouldRebuildCachedSnapshot(profile, candidate);
      };

      const lockResult = await withBuildLock(
        profile.profileHash,
        async () => {
          const latest = await getCachedSnapshot(profile.profileHash);
          if (latest?.snapshotId && canUseCachedSnapshot(latest)) {
            await params.onProgress?.("cache_hit");
            return {
              snapshotId: latest.snapshotId,
              source: "callback_cache" as const,
            };
          }

          await params.onProgress?.("building_snapshot");
          const nextSnapshotId = await createDependencySnapshot(
            profile,
            params.runtime,
            params.timeoutMs,
          );
          await setCachedSnapshot({
            profileHash: profile.profileHash,
            snapshotId: nextSnapshotId,
            runtime: params.runtime,
            createdAtMs: Date.now(),
            dependencyCount: profile.dependencyCount,
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
        profileHash: profile.profileHash,
        dependencyCount: profile.dependencyCount,
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

export function isSnapshotMissingError(error: unknown): boolean {
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
