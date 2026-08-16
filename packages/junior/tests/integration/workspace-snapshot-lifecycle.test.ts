import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sandboxCreate, sandboxGet, builder } = vi.hoisted(() => {
  const commandResult = {
    exitCode: 0,
    stdout: async () => "",
    stderr: async () => "",
  };
  const session = {
    sessionId: "builder-session",
    extendTimeout: vi.fn(async () => undefined),
    mkDir: vi.fn(async () => undefined),
    readFileToBuffer: vi.fn(async () => null),
    runCommand: vi.fn(async () => commandResult),
    snapshot: vi.fn(async () => ({ snapshotId: "snapshot-from-session" })),
    stop: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    writeFiles: vi.fn(async () => undefined),
  };
  const builder = {
    name: "workspace-builder",
    currentSession: () => session,
    extendTimeout: vi.fn(async () => undefined),
    getCommand: vi.fn(async () => ({
      exitCode: 0,
      stderr: async () => "",
    })),
    runCommand: vi.fn(async () => ({ cmdId: "setup-command" })),
    snapshot: vi.fn(async () => ({ snapshotId: "workspace-snapshot" })),
    stop: vi.fn(async () => undefined),
  };
  return {
    builder,
    sandboxCreate: vi.fn(async () => builder),
    sandboxGet: vi.fn(async () => builder),
  };
});

vi.mock("@vercel/sandbox", () => ({
  FileSystem: class {},
  Sandbox: {
    create: sandboxCreate,
    get: sandboxGet,
  },
}));

const ORIGINAL_ENV = { ...process.env };
let disconnectStateAdapter: (() => Promise<void>) | undefined;

describe("Workspace snapshot lifecycle", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await disconnectStateAdapter?.();
    disconnectStateAdapter = undefined;
    process.env = { ...ORIGINAL_ENV };
  });

  it("continues SQL phases across check-ins and stores the ready snapshot", async () => {
    const [{ getDb }, state, schema, store, snapshotModule, waitingModule] =
      await Promise.all([
        import("@/chat/db"),
        import("@/chat/state/adapter"),
        import("@/db/schema"),
        import("@/chat/workspaces/store"),
        import("@/chat/sandbox/snapshot/workspace"),
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
    await db.insert(schema.juniorWorkspaceRepos).values({
      workspaceId,
      provider: "github",
      repo: "getsentry/junior",
    });

    const workspace = await store.getWorkspace(db, workspaceId);
    expect(workspace).not.toBeNull();
    const prepareRepositories = vi.fn(async () => undefined);
    const resolve = () =>
      snapshotModule.resolveWorkspaceSnapshot({
        workspace: workspace!,
        runtime: "node22",
        applyNetworkPolicy: async () => undefined,
        prepareRepositories,
        removeCredentialRoute: false,
        shouldYield: () => true,
      });

    for (const phase of [
      "created",
      "dependencies_installed",
      "repositories_prepared",
      "repositories_prepared",
    ]) {
      await expect(resolve()).rejects.toBeInstanceOf(
        waitingModule.WorkspaceSnapshotWaitingError,
      );
      const current = await store.getWorkspace(db, workspaceId);
      expect(current?.snapshotBuild?.phase).toBe(phase);
    }

    await expect(resolve()).resolves.toMatchObject({
      snapshotId: "workspace-snapshot",
      resolveOutcome: "rebuilt",
    });

    const ready = await store.getWorkspace(db, workspaceId);
    expect(ready?.snapshot).toMatchObject({
      id: "workspace-snapshot",
      runtime: "node22",
    });
    expect(ready?.snapshotBuild).toBeNull();
    expect(prepareRepositories).toHaveBeenCalledTimes(1);
    expect(builder.runCommand).toHaveBeenCalledTimes(1);
    expect(builder.snapshot).toHaveBeenCalledTimes(1);
    expect(builder.stop).toHaveBeenCalledTimes(1);
  });

  it("reuses a retained ready snapshot when setup script reverts to a prior profile", async () => {
    const [{ getDb }, state, schema, store, snapshotModule, profileModule] =
      await Promise.all([
        import("@/chat/db"),
        import("@/chat/state/adapter"),
        import("@/db/schema"),
        import("@/chat/workspaces/store"),
        import("@/chat/sandbox/snapshot/workspace"),
        import("@/chat/sandbox/snapshot/profile"),
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
    await db.insert(schema.juniorWorkspaceRepos).values({
      workspaceId,
      provider: "github",
      repo: "getsentry/junior",
    });

    const recipeA = (await store.getWorkspace(db, workspaceId))!;
    const profileA = profileModule.create("node22", recipeA);
    expect(profileA?.hash).toBeTruthy();

    await store.updateWorkspace(workspaceId, {
      name: "snapshot-profile-reuse",
      setupScript: "echo beta",
      repos: [{ provider: "github", repo: "getsentry/junior" }],
    });
    const recipeB = (await store.getWorkspace(db, workspaceId))!;
    const profileB = profileModule.create("node22", recipeB);
    expect(profileB?.hash).toBeTruthy();
    expect(profileB!.hash).not.toBe(profileA!.hash);

    // Keep both ready rows. Newest is B so latest-any-ready would wrongly pick B
    // after reverting setup back to A.
    await db.insert(schema.juniorSnapshots).values([
      {
        id: "snap-row-a",
        workspaceId,
        profileHash: profileA!.hash,
        status: "ready",
        snapshotId: "vercel-snap-a",
        runtime: "node22",
        dependencyCount: 0,
        buildDurationMs: 1_000,
        generatedAt: new Date("2026-08-16T17:00:00.000Z"),
        createdAt: new Date("2026-08-16T17:00:00.000Z"),
        updatedAt: new Date("2026-08-16T17:00:00.000Z"),
      },
      {
        id: "snap-row-b",
        workspaceId,
        profileHash: profileB!.hash,
        status: "ready",
        snapshotId: "vercel-snap-b",
        runtime: "node22",
        dependencyCount: 0,
        buildDurationMs: 2_000,
        generatedAt: new Date("2026-08-16T18:00:00.000Z"),
        createdAt: new Date("2026-08-16T18:00:00.000Z"),
        updatedAt: new Date("2026-08-16T18:00:00.000Z"),
      },
    ]);

    async function resolveForSetup(setupScript: string) {
      await store.updateWorkspace(workspaceId, {
        name: "snapshot-profile-reuse",
        setupScript,
        repos: [{ provider: "github", repo: "getsentry/junior" }],
      });
      const current = (await store.getWorkspace(db, workspaceId))!;
      return snapshotModule.resolveWorkspaceSnapshot({
        workspace: current,
        runtime: "node22",
        applyNetworkPolicy: async () => undefined,
        prepareRepositories: async () => undefined,
        removeCredentialRoute: false,
      });
    }

    await expect(resolveForSetup("echo beta")).resolves.toMatchObject({
      snapshotId: "vercel-snap-b",
      cacheHit: true,
    });
    const createsAfterB = sandboxCreate.mock.calls.length;

    await expect(resolveForSetup("echo alpha")).resolves.toMatchObject({
      snapshotId: "vercel-snap-a",
      cacheHit: true,
      resolveOutcome: "cache_hit",
    });
    expect(sandboxCreate.mock.calls.length).toBe(createsAfterB);
  });
});
