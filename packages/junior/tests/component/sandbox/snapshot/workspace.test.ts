import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sandboxCreateMock, sandboxGetMock } = vi.hoisted(() => ({
  sandboxCreateMock: vi.fn(),
  sandboxGetMock: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: sandboxCreateMock,
    get: sandboxGetMock,
  },
}));

import { closeDb, getDb } from "@/chat/db";
import * as profile from "@/chat/sandbox/snapshot/profile";
import { getCachedSnapshot } from "@/chat/sandbox/snapshot/resolve";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import {
  loadSnapshotsForProfile,
  setWorkspaceSnapshotBuild,
} from "@/chat/sandbox/snapshot/store";
import { isWorkspaceSnapshotWaitingError } from "@/chat/sandbox/snapshot/waiting-error";
import { resolveWorkspaceSnapshot } from "@/chat/sandbox/snapshot/workspace";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createWorkspace } from "@/chat/workspaces/store";
import { juniorSnapshots } from "@/db/schema";

describe("Workspace snapshot completion", () => {
  beforeEach(() => {
    sandboxCreateMock.mockReset();
    sandboxGetMock.mockReset();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    await closeDb();
  });

  it("stores a completed snapshot only in SQL and keeps its owner", async () => {
    const workspace = await createWorkspace({
      name: `snapshot-cleanup-${randomUUID()}`,
      setupScript: "printf ready",
      repos: [],
    });
    const value = profile.create(SANDBOX_RUNTIME, workspace);
    if (!value) throw new Error("Workspace snapshot profile is missing");

    const buildId = randomUUID();
    await setWorkspaceSnapshotBuild(
      workspace.id,
      {
        id: buildId,
        status: "building",
        phase: "repositories_prepared",
        profileHash: value.hash,
        startedAt: new Date(),
        sandboxName: "snapshot-owner",
        commandId: "setup-command",
        error: null,
      },
      { insertIfMissing: true },
    );

    const builder = {
      delete: vi.fn(),
      getCommand: vi.fn(async () => ({
        wait: vi.fn(async () => ({ exitCode: 0 })),
      })),
      snapshot: vi.fn(async () => ({ snapshotId: "snapshot-ready" })),
    };
    sandboxGetMock.mockResolvedValue(builder);

    await expect(
      resolveWorkspaceSnapshot({
        workspace,
        runtime: SANDBOX_RUNTIME,
        shouldYield: () => false,
        applyNetworkPolicy: async () => {},
        removeCredentialRoute: false,
      }),
    ).resolves.toMatchObject({ snapshotId: "snapshot-ready" });

    await expect(
      loadSnapshotsForProfile(getDb(), workspace.id, value.hash),
    ).resolves.toMatchObject({
      build: null,
      ready: { id: "snapshot-ready" },
    });
    await expect(getCachedSnapshot(value.hash)).resolves.toBeNull();
    await expect(
      getDb()
        .select({ sandboxName: juniorSnapshots.buildSandboxName })
        .from(juniorSnapshots)
        .where(eq(juniorSnapshots.id, buildId)),
    ).resolves.toEqual([{ sandboxName: "snapshot-owner" }]);
    expect(builder.delete).not.toHaveBeenCalled();
  });

  it("starts a rebuild when failed-builder deletion fails", async () => {
    const workspace = await createWorkspace({
      name: `snapshot-rebuild-${randomUUID()}`,
      setupScript: "printf ready",
      repos: [],
    });
    const value = profile.create(SANDBOX_RUNTIME, workspace);
    if (!value) throw new Error("Workspace snapshot profile is missing");

    await setWorkspaceSnapshotBuild(
      workspace.id,
      {
        id: randomUUID(),
        status: "failed",
        phase: "created",
        profileHash: value.hash,
        startedAt: new Date(),
        sandboxName: "failed-builder-cleanup-fails",
        commandId: null,
        error: "install failed",
      },
      { insertIfMissing: true },
    );
    sandboxGetMock.mockRejectedValue(new Error("Vercel cleanup failed"));
    sandboxCreateMock.mockResolvedValue({});
    let yieldChecks = 0;

    await expect(
      resolveWorkspaceSnapshot({
        workspace,
        runtime: SANDBOX_RUNTIME,
        shouldYield: () => {
          yieldChecks += 1;
          return yieldChecks > 1;
        },
        applyNetworkPolicy: async () => {},
        removeCredentialRoute: false,
      }),
    ).rejects.toSatisfy(isWorkspaceSnapshotWaitingError);

    await expect(
      loadSnapshotsForProfile(getDb(), workspace.id, value.hash),
    ).resolves.toMatchObject({
      build: { status: "building" },
      ready: null,
    });
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });

  it("marks a build failed when its named builder is missing", async () => {
    const workspace = await createWorkspace({
      name: `snapshot-missing-builder-${randomUUID()}`,
      setupScript: "printf ready",
      repos: [],
    });
    const value = profile.create(SANDBOX_RUNTIME, workspace);
    if (!value) throw new Error("Workspace snapshot profile is missing");

    await setWorkspaceSnapshotBuild(
      workspace.id,
      {
        id: randomUUID(),
        status: "building",
        phase: "created",
        profileHash: value.hash,
        startedAt: new Date(),
        sandboxName: "missing-builder",
        commandId: null,
        error: null,
      },
      { insertIfMissing: true },
    );
    sandboxGetMock.mockRejectedValue(new Error("status code 404"));

    await expect(
      resolveWorkspaceSnapshot({
        workspace,
        runtime: SANDBOX_RUNTIME,
        shouldYield: () => false,
        applyNetworkPolicy: async () => {},
        removeCredentialRoute: false,
      }),
    ).rejects.toThrow("status code 404");

    await expect(
      loadSnapshotsForProfile(getDb(), workspace.id, value.hash),
    ).resolves.toMatchObject({
      build: { status: "failed", error: "status code 404" },
      ready: null,
    });
  });
});
