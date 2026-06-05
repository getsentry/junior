import { vi } from "vitest";
import { withSpan } from "@/chat/logging";
import { resolveRuntimeDependencySnapshot as resolveRuntimeDependencySnapshotImpl } from "@/chat/sandbox/runtime-dependency-snapshots";
import { mockTestClock } from "./vitest";

export const sandboxCreateMock = vi.fn();
export const getPluginRuntimeDependenciesMock = vi.fn();
export const getPluginRuntimePostinstallMock = vi.fn();

const store = new Map<string, string>();
let lockHeld = false;

const stateAdapter = {
  connect: vi.fn(async () => {}),
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  acquireLock: vi.fn(async () => {
    if (lockHeld) {
      return null;
    }
    lockHeld = true;
    return { key: "lock" };
  }),
  releaseLock: vi.fn(async () => {
    lockHeld = false;
  }),
};

function runtimeDependencySnapshotServices() {
  return {
    createSandbox: sandboxCreateMock,
    getPluginRuntimeDependencies: getPluginRuntimeDependenciesMock,
    getPluginRuntimePostinstall: getPluginRuntimePostinstallMock,
    getStateAdapter: () => stateAdapter as never,
    withSpan,
  };
}

export async function resolveRuntimeDependencySnapshot(
  params: Parameters<typeof resolveRuntimeDependencySnapshotImpl>[0],
) {
  return await resolveRuntimeDependencySnapshotImpl(
    params,
    runtimeDependencySnapshotServices(),
  );
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
export function setupRuntimeDependencySnapshotTest() {
  store.clear();
  lockHeld = false;
  sandboxCreateMock.mockReset();
  stateAdapter.connect.mockClear();
  stateAdapter.get.mockClear();
  stateAdapter.set.mockClear();
  stateAdapter.acquireLock.mockClear();
  stateAdapter.releaseLock.mockClear();
  getPluginRuntimeDependenciesMock.mockReset();
  getPluginRuntimePostinstallMock.mockReset();
  getPluginRuntimePostinstallMock.mockReturnValue([]);
  delete process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH;
  delete process.env.SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS;
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TEAM_ID;
  delete process.env.VERCEL_PROJECT_ID;
  mockTestClock("2026-03-01T00:00:00.000Z");
}

/** Restores timer state after runtime dependency snapshot tests. */
export function cleanupRuntimeDependencySnapshotTest() {
  vi.useRealTimers();
}

/** Returns the raw runtime snapshot cache entries held by the memory adapter. */
export function getRuntimeSnapshotCacheEntries() {
  return [...store.entries()];
}

/** Writes a raw runtime snapshot cache entry for lock-wait scenarios. */
export function setRuntimeSnapshotCacheEntry(key: string, value: string) {
  store.set(key, value);
}

/** Marks the fake snapshot build lock as held or available. */
export function setRuntimeSnapshotLockHeld(value: boolean) {
  lockHeld = value;
}
