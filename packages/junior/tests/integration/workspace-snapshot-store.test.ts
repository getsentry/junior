import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/chat/db";
import {
  loadSnapshotsForProfile,
  setWorkspaceSnapshot,
  setWorkspaceSnapshotBuild,
} from "@/chat/sandbox/snapshot/store";
import { createWorkspace } from "@/chat/workspaces/store";
import type { WorkspaceSnapshotBuild } from "@/chat/workspaces/types";

describe("Workspace snapshot store", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("keeps one active build and updates only its immutable row", async () => {
    const workspace = await createWorkspace({
      name: `snapshot-store-${randomUUID()}`,
      setupScript: "printf ready",
      repos: [],
    });
    const build: WorkspaceSnapshotBuild = {
      id: randomUUID(),
      status: "building",
      phase: "created",
      profileHash: "profile-one",
      startedAt: new Date(),
      sandboxName: "builder-one",
      commandId: null,
      error: null,
    };

    await expect(
      setWorkspaceSnapshotBuild(workspace.id, build, {
        insertIfMissing: true,
      }),
    ).resolves.toBe(true);
    await expect(
      setWorkspaceSnapshotBuild(
        workspace.id,
        {
          ...build,
          id: randomUUID(),
          sandboxName: "builder-two",
        },
        { insertIfMissing: true },
      ),
    ).resolves.toBe(false);
    const failedBuildId = randomUUID();
    await expect(
      setWorkspaceSnapshotBuild(
        workspace.id,
        {
          ...build,
          id: failedBuildId,
          status: "failed",
          sandboxName: "failed-builder",
          error: "failed",
        },
        { insertIfMissing: true },
      ),
    ).resolves.toBe(true);
    await expect(
      loadSnapshotsForProfile(getDb(), workspace.id, build.profileHash),
    ).resolves.toMatchObject({ build: { id: build.id, status: "building" } });
    await expect(
      setWorkspaceSnapshot(
        workspace.id,
        {
          id: "snapshot-wrong-owner",
          generatedAt: new Date(),
          buildDurationMs: 100,
          profileHash: build.profileHash,
        },
        { buildId: randomUUID() },
      ),
    ).resolves.toBe(false);
    await expect(
      setWorkspaceSnapshot(
        workspace.id,
        {
          id: "snapshot-failed-owner",
          generatedAt: new Date(),
          buildDurationMs: 100,
          profileHash: build.profileHash,
        },
        { buildId: failedBuildId },
      ),
    ).resolves.toBe(false);
    await expect(
      setWorkspaceSnapshot(
        workspace.id,
        {
          id: "snapshot-one",
          generatedAt: new Date(),
          buildDurationMs: 100,
          profileHash: build.profileHash,
        },
        { buildId: build.id },
      ),
    ).resolves.toBe(true);

    const state = await loadSnapshotsForProfile(
      getDb(),
      workspace.id,
      build.profileHash,
    );
    expect(state.build).toBeNull();
    expect(state.ready?.id).toBe("snapshot-one");
  });
});
