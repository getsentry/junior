import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupRuntimeDependencySnapshotTest,
  getPluginRuntimeDependenciesMock,
  makeRuntimeDependencySandbox,
  resolveRuntimeDependencySnapshot,
  sandboxCreateMock,
  setupRuntimeDependencySnapshotTest,
  withSpanMock,
} from "../../fixtures/runtime-dependency-snapshots";

describe("runtime dependency snapshot instrumentation", () => {
  beforeEach(setupRuntimeDependencySnapshotTest);
  afterEach(cleanupRuntimeDependencySnapshotTest);

  it("emits lifecycle snapshot spans for build and install", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "system", package: "gh" },
      { type: "npm", package: "sentry-cli", version: "2.0.0" },
    ]);
    sandboxCreateMock.mockResolvedValueOnce(
      makeRuntimeDependencySandbox("snap_observability"),
    );

    await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });

    const spanNames = withSpanMock.mock.calls.map((call) => call[0]);
    expect(spanNames).toEqual(
      expect.arrayContaining([
        "sandbox.snapshot.resolve",
        "sandbox.snapshot.build",
        "sandbox.snapshot.install_system",
        "sandbox.snapshot.install_npm",
        "sandbox.snapshot.capture",
      ]),
    );
  });
});
