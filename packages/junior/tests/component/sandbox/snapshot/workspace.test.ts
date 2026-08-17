import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sandboxGetMock } = vi.hoisted(() => ({
  sandboxGetMock: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: vi.fn(),
    get: sandboxGetMock,
  },
}));

import { closeDb, getDb } from "@/chat/db";
import * as profile from "@/chat/sandbox/snapshot/profile";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import {
  loadSnapshotsForProfile,
  setWorkspaceSnapshotBuild,
} from "@/chat/sandbox/snapshot/store";
import { resolveWorkspaceSnapshot } from "@/chat/sandbox/snapshot/workspace";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createWorkspace } from "@/chat/workspaces/store";

describe("Workspace snapshot completion", () => {
  beforeEach(() => {
    sandboxGetMock.mockReset();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    await closeDb();
  });

  it("keeps the ready snapshot when builder deletion fails", async () => {
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
        sandboxName: "builder-cleanup-fails",
        commandId: "setup-command",
        error: null,
      },
      { insertIfMissing: true },
    );

    const builder = {
      delete: vi.fn(async () => {
        throw new Error("Vercel cleanup failed");
      }),
      getCommand: vi.fn(async () => ({ exitCode: 0 })),
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
    expect(builder.delete).toHaveBeenCalledTimes(1);
  });
});
