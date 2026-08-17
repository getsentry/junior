import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { logException } from "@/chat/logging";
import type { JuniorDatabase } from "@/db/db";
import { juniorSnapshots, juniorWorkspaces } from "@/db/schema";
import type {
  WorkspaceSnapshot,
  WorkspaceSnapshotBuild,
} from "@/chat/workspaces/types";

type SnapshotRow = typeof juniorSnapshots.$inferSelect;

export type WorkspaceSnapshotRows = {
  ready: SnapshotRow | undefined;
  build: SnapshotRow | undefined;
};

function emptySnapshotRows(): WorkspaceSnapshotRows {
  return { ready: undefined, build: undefined };
}

function collectSnapshotRows(rows: SnapshotRow[]): WorkspaceSnapshotRows {
  const result = emptySnapshotRows();
  for (const row of rows) {
    if (!result.ready && row.status === "ready") {
      result.ready = row;
    }
    if (!result.build && row.status !== "ready") {
      result.build = row;
    }
    if (result.ready && result.build) break;
  }
  return result;
}

/** Map a ready SQL row to the dashboard/runtime snapshot view. */
export function snapshotFromRow(
  row: SnapshotRow | undefined,
): WorkspaceSnapshot | null {
  if (
    !row ||
    row.status !== "ready" ||
    !row.snapshotId ||
    !row.generatedAt ||
    row.buildDurationMs == null
  ) {
    return null;
  }
  // Legacy ready rows may omit runtime or dependency facts.
  return {
    id: row.snapshotId,
    generatedAt: row.generatedAt,
    buildDurationMs: row.buildDurationMs,
    profileHash: row.profileHash,
    runtime: row.runtime ?? "node22",
    dependencyCount: row.dependencyCount ?? 0,
  };
}

/** Map an in-flight or failed SQL row to the snapshot build view. */
export function snapshotBuildFromRow(
  row: SnapshotRow | undefined,
): WorkspaceSnapshotBuild | null {
  if (!row || !row.buildStartedAt) return null;
  return {
    status: row.status,
    phase: row.buildPhase ?? "created",
    profileHash: row.profileHash,
    startedAt: row.buildStartedAt,
    sandboxName: row.buildSandboxName,
    commandId: row.buildCommandId,
    error: row.buildError,
  };
}

/** Load the latest ready artifact and non-ready build per Workspace. */
export async function loadLatestSnapshotsByWorkspace(
  db: JuniorDatabase,
  workspaceIds: string[],
): Promise<Map<string, WorkspaceSnapshotRows>> {
  const byWorkspace = new Map<string, WorkspaceSnapshotRows>();
  if (workspaceIds.length === 0) return byWorkspace;
  const rows = await db
    .select()
    .from(juniorSnapshots)
    .where(inArray(juniorSnapshots.workspaceId, workspaceIds))
    .orderBy(desc(juniorSnapshots.updatedAt), desc(juniorSnapshots.createdAt));
  const grouped = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.workspaceId);
    if (list) list.push(row);
    else grouped.set(row.workspaceId, [row]);
  }
  for (const workspaceId of workspaceIds) {
    byWorkspace.set(
      workspaceId,
      collectSnapshotRows(grouped.get(workspaceId) ?? []),
    );
  }
  return byWorkspace;
}

/** Load the latest ready artifact and non-ready build for one Workspace. */
export async function loadLatestSnapshots(
  db: JuniorDatabase,
  workspaceId: string,
): Promise<WorkspaceSnapshotRows> {
  const rows = await db
    .select()
    .from(juniorSnapshots)
    .where(eq(juniorSnapshots.workspaceId, workspaceId))
    .orderBy(desc(juniorSnapshots.updatedAt), desc(juniorSnapshots.createdAt));
  return collectSnapshotRows(rows);
}

/** Load ready and in-flight rows for one Workspace profile hash. */
export async function loadSnapshotsForProfile(
  db: JuniorDatabase,
  workspaceId: string,
  profileHash: string,
): Promise<WorkspaceSnapshotRows> {
  const rows = await db
    .select()
    .from(juniorSnapshots)
    .where(
      and(
        eq(juniorSnapshots.workspaceId, workspaceId),
        eq(juniorSnapshots.profileHash, profileHash),
      ),
    )
    .orderBy(desc(juniorSnapshots.updatedAt), desc(juniorSnapshots.createdAt));
  return collectSnapshotRows(rows);
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
          runtime: snapshot.runtime,
          dependencyCount: snapshot.dependencyCount,
          buildDurationMs: snapshot.buildDurationMs,
          generatedAt: snapshot.generatedAt,
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
          runtime: snapshot.runtime,
          dependencyCount: snapshot.dependencyCount,
          buildDurationMs: snapshot.buildDurationMs,
          generatedAt: snapshot.generatedAt,
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
      runtime: snapshot.runtime,
      dependencyCount: snapshot.dependencyCount,
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
      runtime: null,
      dependencyCount: null,
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
    runtime?: string;
    dependencyCount?: number;
  },
): Promise<void> {
  if (
    !snapshot.snapshotId ||
    !snapshot.profileHash ||
    snapshot.createdAtMs == null ||
    snapshot.buildDurationMs == null ||
    !snapshot.runtime ||
    snapshot.dependencyCount == null
  ) {
    return;
  }
  try {
    await setWorkspaceSnapshot(workspaceId, {
      id: snapshot.snapshotId,
      generatedAt: new Date(snapshot.createdAtMs),
      buildDurationMs: snapshot.buildDurationMs,
      profileHash: snapshot.profileHash,
      runtime: snapshot.runtime,
      dependencyCount: snapshot.dependencyCount,
    });
  } catch (error) {
    // Dashboard enrichment must not fail a prepared Workspace Sandbox.
    logException(error, "sandbox.workspace_snapshot.persist.failed", {
      "app.workspace.id": workspaceId,
    });
  }
}
