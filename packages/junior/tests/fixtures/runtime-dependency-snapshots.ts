import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sandboxCreateMock: vi.fn(),
  getPluginRuntimeDependenciesMock: vi.fn(),
  getPluginRuntimePostinstallMock: vi.fn(),
  withSpanMock: vi.fn(
    async (
      _name: string,
      _op: string,
      _context: unknown,
      callback: () => Promise<unknown>,
    ) => callback(),
  ),
}));

export const sandboxCreateMock = mocks.sandboxCreateMock;
export const getPluginRuntimeDependenciesMock =
  mocks.getPluginRuntimeDependenciesMock;
export const getPluginRuntimePostinstallMock =
  mocks.getPluginRuntimePostinstallMock;
export const withSpanMock = mocks.withSpanMock;

const store = new Map<string, string>();
let lockHeld = false;

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: mocks.sandboxCreateMock,
  },
}));

vi.mock("@/chat/plugins/registry", () => ({
  getPluginRuntimeDependencies: mocks.getPluginRuntimeDependenciesMock,
  getPluginRuntimePostinstall: mocks.getPluginRuntimePostinstallMock,
}));

vi.mock("@/chat/logging", () => ({
  withSpan: mocks.withSpanMock,
}));

vi.mock("@/chat/state/adapter", () => ({
  getStateAdapter: () => ({
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
  }),
}));

import { resolveRuntimeDependencySnapshot as resolveRuntimeDependencySnapshotImpl } from "@/chat/sandbox/runtime-dependency-snapshots";

export const resolveRuntimeDependencySnapshot =
  resolveRuntimeDependencySnapshotImpl;

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
  mocks.sandboxCreateMock.mockReset();
  mocks.withSpanMock.mockReset();
  mocks.withSpanMock.mockImplementation(
    async (
      _name: string,
      _op: string,
      _context: unknown,
      callback: () => Promise<unknown>,
    ) => await callback(),
  );
  mocks.getPluginRuntimeDependenciesMock.mockReset();
  mocks.getPluginRuntimePostinstallMock.mockReset();
  mocks.getPluginRuntimePostinstallMock.mockReturnValue([]);
  delete process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH;
  delete process.env.SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS;
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TEAM_ID;
  delete process.env.VERCEL_PROJECT_ID;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
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
