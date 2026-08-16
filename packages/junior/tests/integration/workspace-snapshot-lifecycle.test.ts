import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  vercelSandboxFixture,
  vercelSandboxModule,
} from "../fixtures/vercel-sandbox";

vi.mock("@vercel/sandbox", () => vercelSandboxModule);

const ORIGINAL_ENV = { ...process.env };
let disconnectStateAdapter: (() => Promise<void>) | undefined;

describe("Workspace snapshot lifecycle", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vercelSandboxFixture.reset();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await disconnectStateAdapter?.();
    disconnectStateAdapter = undefined;
    process.env = { ...ORIGINAL_ENV };
  });

  it("continues a cold build across check-ins and boots its ready snapshot", async () => {
    const [
      { getDb },
      state,
      schema,
      store,
      { createSandboxRuntime },
      waiting,
    ] = await Promise.all([
      import("@/chat/db"),
      import("@/chat/state/adapter"),
      import("@/db/schema"),
      import("@/chat/workspaces/store"),
      import("@/chat/sandbox/session"),
      import("@/chat/sandbox/snapshot/waiting-error"),
    ]);
    disconnectStateAdapter = state.disconnectStateAdapter;

    const now = new Date("2026-08-16T18:00:00.000Z");
    const workspaceId = "33333333-3333-4333-8333-333333333333";
    const db = getDb();
    await db.insert(schema.juniorWorkspaces).values({
      id: workspaceId,
      name: "snapshot-lifecycle",
      setupScript: "echo ready",
      createdAt: now,
      updatedAt: now,
    });

    const workspace = (await store.getWorkspace(db, workspaceId))!;
    const runtime = createSandboxRuntime({
      workspace,
      skills: [],
      referenceFiles: [],
      shouldYield: () => true,
    });

    for (const phase of [
      "created",
      "dependencies_installed",
      "repositories_prepared",
      "repositories_prepared",
    ]) {
      await expect(runtime.acquire()).rejects.toSatisfy(
        waiting.isWorkspaceSnapshotWaitingError,
      );
      const current = await store.getWorkspace(db, workspaceId);
      expect(current?.snapshotBuild?.phase).toBe(phase);
    }

    const session = await runtime.acquire();
    const ready = await store.getWorkspace(db, workspaceId);

    expect(session.sandboxId).toMatch(/^runtime-sandbox-/);
    expect(runtime.sandboxRef()).toMatchObject({
      profileHash: ready?.snapshot?.profileHash,
      workspaceId,
    });
    expect(ready?.snapshot).toMatchObject({
      id: "workspace-snapshot-1",
      runtime: "node22",
    });
    expect(ready?.snapshotBuild).toBeNull();
    expect(vercelSandboxFixture.snapshotBoots()).toEqual([
      "workspace-snapshot-1",
    ]);

    const [builder] = vercelSandboxFixture.persistentSandboxes();
    expect(vercelSandboxFixture.persistentSandboxes()).toHaveLength(1);
    expect(builder?.snapshot).toHaveBeenCalledTimes(1);
    expect(builder?.stop).toHaveBeenCalledTimes(1);
    runtime.close();
  });

  it("reuses a retained ready snapshot when setup script reverts", async () => {
    const [
      { getDb },
      state,
      schema,
      store,
      profile,
      { createSandboxRuntime },
    ] = await Promise.all([
      import("@/chat/db"),
      import("@/chat/state/adapter"),
      import("@/db/schema"),
      import("@/chat/workspaces/store"),
      import("@/chat/sandbox/snapshot/profile"),
      import("@/chat/sandbox/session"),
    ]);
    disconnectStateAdapter = state.disconnectStateAdapter;

    const now = new Date("2026-08-16T18:00:00.000Z");
    const workspaceId = "44444444-4444-4444-8444-444444444444";
    const db = getDb();
    await db.insert(schema.juniorWorkspaces).values({
      id: workspaceId,
      name: "snapshot-profile-reuse",
      setupScript: "echo alpha",
      createdAt: now,
      updatedAt: now,
    });

    const recipeA = (await store.getWorkspace(db, workspaceId))!;
    const profileA = profile.create("node22", recipeA)!;
    await store.updateWorkspace(workspaceId, {
      name: recipeA.name,
      setupScript: "echo beta",
      repos: [],
    });
    const recipeB = (await store.getWorkspace(db, workspaceId))!;
    const profileB = profile.create("node22", recipeB)!;
    expect(profileB.hash).not.toBe(profileA.hash);

    // B is newer. Resolve must still select A after the recipe reverts.
    await db.insert(schema.juniorSnapshots).values([
      {
        id: "snapshot-row-a",
        workspaceId,
        profileHash: profileA.hash,
        status: "ready",
        snapshotId: "vercel-snapshot-a",
        // Deployed legacy rows may omit these details.
        runtime: null,
        dependencyCount: null,
        buildDurationMs: 1_000,
        generatedAt: new Date("2026-08-16T17:00:00.000Z"),
        createdAt: new Date("2026-08-16T17:00:00.000Z"),
        updatedAt: new Date("2026-08-16T17:00:00.000Z"),
      },
      {
        id: "snapshot-row-b",
        workspaceId,
        profileHash: profileB.hash,
        status: "ready",
        snapshotId: "vercel-snapshot-b",
        runtime: "node22",
        dependencyCount: 0,
        buildDurationMs: 2_000,
        generatedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const runtime = createSandboxRuntime({
      workspace: recipeB,
      skills: [],
      referenceFiles: [],
    });
    await runtime.acquire();

    await store.updateWorkspace(workspaceId, {
      name: recipeA.name,
      setupScript: recipeA.setupScript,
      repos: [],
    });
    const reverted = (await store.getWorkspace(db, workspaceId))!;
    await runtime.switchWorkspace(reverted);

    expect(vercelSandboxFixture.snapshotBoots()).toEqual([
      "vercel-snapshot-b",
      "vercel-snapshot-a",
    ]);
    expect(runtime.sandboxRef()).toMatchObject({
      profileHash: profileA.hash,
      workspaceId,
    });
    expect(vercelSandboxFixture.snapshotCount).toBe(0);
    runtime.close();
  });
});
