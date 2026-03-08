import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveRuntimeDependencySnapshotMock } = vi.hoisted(() => ({
  resolveRuntimeDependencySnapshotMock: vi.fn()
}));

vi.mock("@/chat/sandbox/runtime-dependency-snapshots", () => ({
  resolveRuntimeDependencySnapshot: resolveRuntimeDependencySnapshotMock
}));

import { runSnapshotCreate } from "@/cli/snapshot-warmup";

describe("snapshot create cli", () => {
  beforeEach(() => {
    resolveRuntimeDependencySnapshotMock.mockReset();
  });

  it("uses default runtime and timeout", async () => {
    resolveRuntimeDependencySnapshotMock.mockResolvedValue({
      dependencyCount: 0,
      cacheHit: false,
      resolveOutcome: "no_profile"
    });
    const logs: string[] = [];

    await runSnapshotCreate((line) => logs.push(line));

    expect(resolveRuntimeDependencySnapshotMock).toHaveBeenCalledTimes(1);
    expect(resolveRuntimeDependencySnapshotMock).toHaveBeenCalledWith({
      runtime: "node22",
      timeoutMs: 10 * 60 * 1000,
      onProgress: expect.any(Function)
    });
    await resolveRuntimeDependencySnapshotMock.mock.calls[0][0].onProgress("resolve_start");
    expect(logs).toContain("Resolving sandbox snapshot profile...");
    expect(logs.some((line) => line.includes("resolve_outcome=no_profile"))).toBe(true);
  });

  it("logs cache hit metadata", async () => {
    resolveRuntimeDependencySnapshotMock.mockResolvedValue({
      snapshotId: "snap_123",
      profileHash: "abc",
      dependencyCount: 3,
      cacheHit: true,
      resolveOutcome: "cache_hit"
    });
    const logs: string[] = [];

    await runSnapshotCreate((line) => logs.push(line));

    const summary = logs[logs.length - 1];
    expect(summary).toContain("resolve_outcome=cache_hit");
    expect(summary).toContain("cache_hit=true");
    expect(summary).toContain("dependency_count=3");
    expect(summary).toContain("profile_hash=abc");
    expect(summary).toContain("snapshot_id=snap_123");
  });

  it("rethrows resolver errors", async () => {
    resolveRuntimeDependencySnapshotMock.mockRejectedValue(new Error("OIDC missing"));

    await expect(runSnapshotCreate()).rejects.toThrow("OIDC missing");
  });
});
