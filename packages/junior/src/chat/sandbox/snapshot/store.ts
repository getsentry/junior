import { randomUUID } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { logException } from "@/chat/logging";
import type { JuniorDatabase } from "@/db/db";
import { juniorSnapshots, juniorWorkspaces } from "@/db/schema";
import type {
  WorkspaceSnapshot,
  WorkspaceSnapshotBuild,
} from "@/chat/workspaces/types";

type SnapshotRow = typeof juniorSnapshots.$inferSelect;

/** Current ready artifact and build state for one Workspace profile. */
export interface WorkspaceSnapshots {
  ready: WorkspaceSnapshot | null;
  build: WorkspaceSnapshotBuild | null;
}

function snapshotFromRow(row: SnapshotRow): WorkspaceSnapshot {
  if (
    row.status !== "ready" ||
    !row.snapshotId ||
    !row.generatedAt ||
    row.buildDurationMs == null
  ) {
    throw new Error(`Invalid ready Workspace snapshot row: ${row.id}`);
  }
  return {
    id: row.snapshotId,
    generatedAt: row.generatedAt,
    buildDurationMs: row.buildDurationMs,
    profileHash: row.profileHash,
  };
}

function snapshotBuildFromRow(row: SnapshotRow): WorkspaceSnapshotBuild {
  if (row.status === "ready" || !row.buildStartedAt || !row.buildPhase) {
    throw new Error(`Invalid Workspace snapshot build row: ${row.id}`);
  }
  return {
    status: row.status,
    phase: row.buildPhase,
    profileHash: row.profileHash,
    startedAt: row.buildStartedAt,
    sandboxName: row.buildSandboxName,
    commandId: row.buildCommandId,
    error: row.buildError,
  };
}

/** Load bounded ready and build views for one Workspace profile hash. */
export async function loadSnapshotsForProfile(
  db: JuniorDatabase,
  workspaceId: string,
  profileHash: string,
): Promise<WorkspaceSnapshots> {
  const profile = and(
    eq(juniorSnapshots.workspaceId, workspaceId),
    eq(juniorSnapshots.profileHash, profileHash),
  );
  const order = [
    desc(juniorSnapshots.updatedAt),
    desc(juniorSnapshots.createdAt),
    desc(juniorSnapshots.id),
  ] as const;
  const [readyRows, buildRows] = await Promise.all([
    db
      .select()
      .from(juniorSnapshots)
      .where(and(profile, eq(juniorSnapshots.status, "ready")))
      .orderBy(...order)
      .limit(1),
    db
      .select()
      .from(juniorSnapshots)
      .where(and(profile, ne(juniorSnapshots.status, "ready")))
      .orderBy(...order)
      .limit(1),
  ]);
  return {
    ready: readyRows[0] ? snapshotFromRow(readyRows[0]) : null,
    build: buildRows[0] ? snapshotBuildFromRow(buildRows[0]) : null,
  };
}

/** Drop in-flight or failed rows when a recipe changes. Keep ready rows. */
export async function clearNonReadySnapshots(
  db: JuniorDatabase,
  workspaceId: string,
): Promise<string[]> {
  // DELETE … RETURNING ensures a concurrent row cannot disappear without
  // returning its builder reference to the caller.
  const deleted = await db
    .delete(juniorSnapshots)
    .where(
      and(
        eq(juniorSnapshots.workspaceId, workspaceId),
        ne(juniorSnapshots.status, "ready"),
      ),
    )
    .returning({
      sandboxName: juniorSnapshots.buildSandboxName,
    });
  return deleted
    .map((row) => row.sandboxName)
    .filter((name): name is string => Boolean(name));
}

/** Drop one ready row whose provider snapshot no longer exists. */
export async function invalidateMissingReadySnapshot(params: {
  workspaceId: string;
  profileHash: string;
  snapshotId: string;
}): Promise<void> {
  const executor = getSqlExecutor();
  await executor.transaction(async () => {
    const db = executor.db();
    await db
      .delete(juniorSnapshots)
      .where(
        and(
          eq(juniorSnapshots.workspaceId, params.workspaceId),
          eq(juniorSnapshots.profileHash, params.profileHash),
          eq(juniorSnapshots.status, "ready"),
          eq(juniorSnapshots.snapshotId, params.snapshotId),
        ),
      );
  });
}

/** Record the full Sandbox snapshot after a successful Workspace prepare. */
export async function setWorkspaceSnapshot(
  workspaceId: string,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  const executor = getSqlExecutor();
  await executor.transaction(async () => {
    const db = executor.db();
    const workspaceRows = await db
      .select({ id: juniorWorkspaces.id })
      .from(juniorWorkspaces)
      .where(eq(juniorWorkspaces.id, workspaceId))
      .limit(1);
    if (!workspaceRows[0]) return;

    const now = new Date();
    const existing = await db
      .select()
      .from(juniorSnapshots)
      .where(
        and(
          eq(juniorSnapshots.workspaceId, workspaceId),
          eq(juniorSnapshots.profileHash, snapshot.profileHash),
        ),
      )
      .orderBy(desc(juniorSnapshots.updatedAt), desc(juniorSnapshots.createdAt))
      .limit(1);
    const current = existing[0];

    // Keep prior ready rows with different snapshot ids for later cleanup.
    if (current && current.status !== "ready") {
      await db
        .update(juniorSnapshots)
        .set({
          status: "ready",
          snapshotId: snapshot.id,
          buildDurationMs: snapshot.buildDurationMs,
          generatedAt: snapshot.generatedAt,
          buildStartedAt: null,
          buildPhase: null,
          buildSandboxName: null,
          buildCommandId: null,
          buildError: null,
          updatedAt: now,
        })
        .where(eq(juniorSnapshots.id, current.id));
      return;
    }

    if (
      current &&
      current.status === "ready" &&
      current.snapshotId === snapshot.id
    ) {
      await db
        .update(juniorSnapshots)
        .set({
          buildDurationMs: snapshot.buildDurationMs,
          generatedAt: snapshot.generatedAt,
          buildStartedAt: null,
          buildPhase: null,
          buildSandboxName: null,
          buildCommandId: null,
          buildError: null,
          updatedAt: now,
        })
        .where(eq(juniorSnapshots.id, current.id));
      return;
    }

    await db.insert(juniorSnapshots).values({
      id: randomUUID(),
      workspaceId,
      profileHash: snapshot.profileHash,
      status: "ready",
      snapshotId: snapshot.id,
      buildDurationMs: snapshot.buildDurationMs,
      generatedAt: snapshot.generatedAt,
      buildStartedAt: null,
      buildSandboxName: null,
      buildCommandId: null,
      buildError: null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Record a Workspace snapshot build that can continue across execution slices. */
export async function setWorkspaceSnapshotBuild(
  workspaceId: string,
  build: WorkspaceSnapshotBuild,
): Promise<void> {
  const executor = getSqlExecutor();
  await executor.transaction(async () => {
    const db = executor.db();
    const workspaceRows = await db
      .select({ id: juniorWorkspaces.id })
      .from(juniorWorkspaces)
      .where(eq(juniorWorkspaces.id, workspaceId))
      .limit(1);
    if (!workspaceRows[0]) return;

    const now = new Date();
    const existing = await db
      .select()
      .from(juniorSnapshots)
      .where(
        and(
          eq(juniorSnapshots.workspaceId, workspaceId),
          eq(juniorSnapshots.profileHash, build.profileHash),
        ),
      )
      .orderBy(desc(juniorSnapshots.updatedAt), desc(juniorSnapshots.createdAt))
      .limit(1);
    const current = existing[0];

    // Never overwrite a ready artifact with build state. Insert a new row so
    // the prior ready snapshot stays available.
    if (current && current.status !== "ready") {
      await db
        .update(juniorSnapshots)
        .set({
          status: build.status,
          buildStartedAt: build.startedAt,
          buildPhase: build.phase,
          buildSandboxName: build.sandboxName,
          buildCommandId: build.commandId,
          buildError: build.error,
          updatedAt: now,
        })
        .where(eq(juniorSnapshots.id, current.id));
      return;
    }

    await db.insert(juniorSnapshots).values({
      id: randomUUID(),
      workspaceId,
      profileHash: build.profileHash,
      status: build.status,
      snapshotId: null,
      buildDurationMs: null,
      generatedAt: null,
      buildStartedAt: build.startedAt,
      buildPhase: build.phase,
      buildSandboxName: build.sandboxName,
      buildCommandId: build.commandId,
      buildError: build.error,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Persist Workspace snapshot facts when resolve returns a concrete entry. */
export async function recordResolvedWorkspaceSnapshot(
  workspaceId: string,
  snapshot: {
    snapshotId?: string;
    profileHash?: string;
    createdAtMs?: number;
    buildDurationMs?: number;
  },
): Promise<void> {
  if (
    !snapshot.snapshotId ||
    !snapshot.profileHash ||
    snapshot.createdAtMs == null ||
    snapshot.buildDurationMs == null
  ) {
    return;
  }
  try {
    await setWorkspaceSnapshot(workspaceId, {
      id: snapshot.snapshotId,
      generatedAt: new Date(snapshot.createdAtMs),
      buildDurationMs: snapshot.buildDurationMs,
      profileHash: snapshot.profileHash,
    });
  } catch (error) {
    // Dashboard enrichment must not fail a prepared Workspace Sandbox.
    logException(error, "sandbox.workspace_snapshot.persist.failed", {
      "app.workspace.id": workspaceId,
    });
  }
}
