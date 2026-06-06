import { vi } from "vitest";
import { setPluginCatalogConfig } from "@/chat/plugins/registry";
import type {
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
} from "@/chat/plugins/types";
import { resolveRuntimeDependencySnapshot as resolveRuntimeDependencySnapshotImpl } from "@/chat/sandbox/runtime-dependency-snapshots";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { mockTestClock, stubTestEnv } from "./vitest";

const SNAPSHOT_CACHE_PREFIX = "junior:sandbox_snapshot_profile";
const SNAPSHOT_LOCK_PREFIX = "junior:sandbox_snapshot_lock";
const SNAPSHOT_BUILD_LOCK_TTL_MS = 10 * 60 * 1000;

export const sandboxCreateMock = vi.fn();

let heldSnapshotLock: Awaited<
  ReturnType<ReturnType<typeof getStateAdapter>["acquireLock"]>
> | null = null;

/** Configure the real plugin registry with one runtime-dependency test plugin. */
export function configureRuntimeDependencyPlugin(args: {
  dependencies?: PluginRuntimeDependency[];
  postinstall?: PluginRuntimePostinstallCommand[];
}): void {
  const dependencies = args.dependencies ?? [];
  const postinstall = args.postinstall ?? [];
  setPluginCatalogConfig({
    inlineManifests:
      dependencies.length > 0 || postinstall.length > 0
        ? [
            {
              manifest: {
                name: "runtime-deps",
                description: "Runtime dependency test plugin",
                capabilities: [],
                configKeys: [],
                ...(dependencies.length > 0
                  ? { runtimeDependencies: dependencies }
                  : {}),
                ...(postinstall.length > 0
                  ? { runtimePostinstall: postinstall }
                  : {}),
              },
            },
          ]
        : [],
  });
}

export async function resolveRuntimeDependencySnapshot(
  params: Parameters<typeof resolveRuntimeDependencySnapshotImpl>[0],
) {
  return await resolveRuntimeDependencySnapshotImpl(params, {
    createSandbox: sandboxCreateMock as never,
  });
}

/** Builds a fake Vercel sandbox for runtime dependency snapshot tests. */
export function makeRuntimeDependencySandbox(
  snapshotId: string,
  runCommandImpl?: (params: {
    cmd: string;
    args?: string[];
    sudo?: boolean;
  }) => Promise<{
    exitCode: number;
    stdout: () => Promise<string>;
    stderr: () => Promise<string>;
  }>,
) {
  return {
    name: `sbx_${snapshotId}`,
    currentSession: vi.fn(() => ({ sessionId: `sbx_${snapshotId}_session` })),
    runCommand: vi.fn(
      runCommandImpl ??
        (async () => ({
          exitCode: 0,
          stdout: async () => "",
          stderr: async () => "",
        })),
    ),
    snapshot: vi.fn(async () => ({ snapshotId })),
    stop: vi.fn(async () => {}),
  };
}

/** Extracts the generated shell script from a sandbox command invocation. */
export function getRuntimeDependencyScript(params: {
  cmd: string;
  args?: string[];
  sudo?: boolean;
}): string {
  return params.args?.[1] ?? "";
}

/** Resets runtime dependency snapshot mocks and environment before each test. */
export async function setupRuntimeDependencySnapshotTest() {
  vi.unstubAllEnvs();
  stubTestEnv({ JUNIOR_STATE_ADAPTER: "memory" });
  await releaseRuntimeSnapshotLock();
  await disconnectStateAdapter();
  sandboxCreateMock.mockReset();
  setPluginCatalogConfig(undefined);
  delete process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH;
  delete process.env.SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS;
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TEAM_ID;
  delete process.env.VERCEL_PROJECT_ID;
  mockTestClock("2026-03-01T00:00:00.000Z");
}

/** Restores timer, registry, and state after runtime dependency snapshot tests. */
export async function cleanupRuntimeDependencySnapshotTest() {
  await releaseRuntimeSnapshotLock();
  setPluginCatalogConfig(undefined);
  await disconnectStateAdapter();
  vi.useRealTimers();
  vi.unstubAllEnvs();
}

function snapshotCacheKey(profileHash: string): string {
  return `${SNAPSHOT_CACHE_PREFIX}:${profileHash}`;
}

function snapshotLockKey(profileHash: string): string {
  return `${SNAPSHOT_LOCK_PREFIX}:${profileHash}`;
}

/** Returns the raw runtime snapshot cache entry for one profile. */
export async function getRuntimeSnapshotCacheEntry(
  profileHash: string,
): Promise<string | undefined> {
  const state = getStateAdapter();
  await state.connect();
  const raw = await state.get(snapshotCacheKey(profileHash));
  return typeof raw === "string" ? raw : undefined;
}

/** Writes a raw runtime snapshot cache entry for lock-wait scenarios. */
export async function setRuntimeSnapshotCacheEntry(
  profileHash: string,
  value: string,
): Promise<void> {
  const state = getStateAdapter();
  await state.connect();
  await state.set(
    snapshotCacheKey(profileHash),
    value,
    30 * 24 * 60 * 60 * 1000,
  );
}

/** Holds the snapshot build lock until `releaseRuntimeSnapshotLock` is called. */
export async function holdRuntimeSnapshotLock(
  profileHash: string,
): Promise<void> {
  const state = getStateAdapter();
  await state.connect();
  heldSnapshotLock = await state.acquireLock(
    snapshotLockKey(profileHash),
    SNAPSHOT_BUILD_LOCK_TTL_MS,
  );
  if (!heldSnapshotLock) {
    throw new Error("Expected to acquire runtime snapshot lock");
  }
}

/** Releases a lock held by `holdRuntimeSnapshotLock`, if present. */
export async function releaseRuntimeSnapshotLock(): Promise<void> {
  if (!heldSnapshotLock) {
    return;
  }
  const state = getStateAdapter();
  await state.connect();
  await state.releaseLock(heldSnapshotLock);
  heldSnapshotLock = null;
}
