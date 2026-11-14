import fs from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";

// Chat config reads the env when it loads, so load the CLI env first, as
// `junior snapshot create` does. Vercel builds leave NODE_ENV unset. CI runs
// Redis at REDIS_URL. Locally, compose.yaml runs it on port 6382.
const { appRoot, originalEnv } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const originalEnv = { ...process.env };
  delete process.env.NODE_ENV;
  delete process.env.JUNIOR_STATE_ADAPTER;
  process.env.VERCEL = "1";
  process.env.VERCEL_ENV = "production";
  process.env.REDIS_URL =
    process.env.REDIS_URL?.trim() || "redis://localhost:6382";
  process.env.JUNIOR_STATE_KEY_PREFIX = `junior_test_${crypto.randomUUID()}`;

  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "junior-build-"));
  fs.writeFileSync(path.join(appRoot, "package.json"), "{}\n");
  const { loadCliEnvFiles } = await import("@/cli/env");
  loadCliEnvFiles(appRoot);
  return { appRoot, originalEnv };
});

import * as profile from "@/chat/sandbox/snapshot/profile";
import { setCachedSnapshot } from "@/chat/sandbox/snapshot/resolve";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { runSnapshotCreate } from "@/cli/snapshot-create";

afterAll(async () => {
  await disconnectStateAdapter();
  fs.rmSync(appRoot, { force: true, recursive: true });
  process.env = originalEnv;
});

describe("junior snapshot create in a Vercel build", () => {
  it("reuses the snapshot that the deployed runtime stored", async () => {
    const current = profile.create(SANDBOX_RUNTIME)!;
    // The deployed runtime built this snapshot earlier. Disconnect to drop
    // its state adapter, so the build reads through a new one.
    await setCachedSnapshot({
      profileHash: current.hash,
      snapshotId: "snap_runtime",
      runtime: SANDBOX_RUNTIME,
      createdAtMs: Date.now(),
      dependencyCount: current.dependencies.length,
      buildDurationMs: 1,
    });
    await disconnectStateAdapter();

    const logs: string[] = [];
    await runSnapshotCreate((line) => logs.push(line));

    const summary = logs.at(-1);
    expect(summary).toContain("cache_hit=true");
    expect(summary).toContain("snapshot_id=snap_runtime");
  });
});
