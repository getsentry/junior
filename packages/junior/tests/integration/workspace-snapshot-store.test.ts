import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/chat/db";
import {
  clearWorkspaceSnapshots,
  invalidateReadySnapshot,
  loadSnapshotsForProfile,
  setWorkspaceSnapshot,
  setWorkspaceSnapshotBuild,
} from "@/chat/sandbox/snapshot/store";
import {
  createWorkspace,
  deleteWorkspace,
  updateWorkspace,
} from "@/chat/workspaces/store";
import type {
  WorkspaceSnapshot,
  WorkspaceSnapshotBuild,
} from "@/chat/workspaces/types";
import { juniorSnapshots } from "@/db/schema";

async function insertReadySnapshot(
  workspaceId: string,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  const now = new Date();
  await getDb().insert(juniorSnapshots).values({
    id: randomUUID(),
    workspaceId,
    profileHash: snapshot.profileHash,
    status: "ready",
    snapshotId: snapshot.id,
    buildDurationMs: snapshot.buildDurationMs,
    generatedAt: snapshot.generatedAt,
    createdAt: now,
    updatedAt: now,
  });
}

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
    await insertReadySnapshot(workspace.id, {
      id: "snapshot-independent",
      generatedAt: new Date(),
      buildDurationMs: 50,
      profileHash: build.profileHash,
    });
    await expect(
      loadSnapshotsForProfile(getDb(), workspace.id, build.profileHash),
    ).resolves.toMatchObject({
      build: { id: build.id, status: "building" },
      ready: { id: "snapshot-independent" },
    });
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
    ).resolves.toEqual({ written: false, replacedBuilderNames: [] });
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
    ).resolves.toEqual({ written: false, replacedBuilderNames: [] });
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
    ).resolves.toEqual({
      written: true,
      replacedBuilderNames: ["failed-builder"],
    });

    const state = await loadSnapshotsForProfile(
      getDb(),
      workspace.id,
      build.profileHash,
    );
    expect(state.build).toBeNull();
    expect(state.ready?.id).toBe("snapshot-one");
    const nextBuild = {
      ...build,
      id: randomUUID(),
      sandboxName: "builder-two",
    };
    await expect(
      setWorkspaceSnapshotBuild(workspace.id, nextBuild, {
        insertIfMissing: true,
      }),
    ).resolves.toBe(true);
    await expect(
      setWorkspaceSnapshot(
        workspace.id,
        {
          id: "snapshot-two",
          generatedAt: new Date(),
          buildDurationMs: 200,
          profileHash: build.profileHash,
        },
        { buildId: nextBuild.id },
      ),
    ).resolves.toEqual({
      written: true,
      replacedBuilderNames: ["builder-one"],
    });
    await expect(
      invalidateReadySnapshot({
        workspaceId: workspace.id,
        profileHash: build.profileHash,
        snapshotId: "snapshot-two",
      }),
    ).resolves.toBe("builder-two");

    const finalBuild = {
      ...build,
      id: randomUUID(),
      sandboxName: "builder-three",
    };
    await expect(
      setWorkspaceSnapshotBuild(workspace.id, finalBuild, {
        insertIfMissing: true,
      }),
    ).resolves.toBe(true);
    await expect(
      setWorkspaceSnapshot(
        workspace.id,
        {
          id: "snapshot-three",
          generatedAt: new Date(),
          buildDurationMs: 300,
          profileHash: build.profileHash,
        },
        { buildId: finalBuild.id },
      ),
    ).resolves.toEqual({ written: true, replacedBuilderNames: [] });
    await expect(
      clearWorkspaceSnapshots(getDb(), workspace.id),
    ).resolves.toEqual(["builder-three"]);
    await expect(
      loadSnapshotsForProfile(getDb(), workspace.id, build.profileHash),
    ).resolves.toEqual({ build: null, ready: null });

    const previousRecipe = {
      setupScript: workspace.setupScript,
      repos: workspace.repos,
    };
    await updateWorkspace(workspace.id, {
      name: workspace.name,
      setupScript: "printf changed",
      repos: [],
    });
    await expect(
      setWorkspaceSnapshotBuild(
        workspace.id,
        { ...finalBuild, id: randomUUID(), sandboxName: "stale-builder" },
        { insertIfMissing: true, expectedRecipe: previousRecipe },
      ),
    ).resolves.toBe(false);

    await expect(deleteWorkspace(workspace.id)).resolves.toBe(true);
    await expect(
      setWorkspaceSnapshotBuild(
        workspace.id,
        { ...finalBuild, id: randomUUID(), sandboxName: "deleted-builder" },
        { insertIfMissing: true },
      ),
    ).resolves.toBe(false);
  });
});
